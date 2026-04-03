// ─── Tests appended by morning sprint: x402 mint + per-tool MCP telemetry ─────
// These are additional test cases imported indirectly via Vitest glob patterns.
// We use a separate file to avoid heredoc quoting issues in the main spec.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

async function fetchW(path: string, options: RequestInit = {}): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(
		`http://example.com${path}`,
		options,
	);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

const TEST_ADDR = '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3';
const VALID_STATUSES = ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'];

function mockMintRpc(recipientAddress: string, amountUnits: string, blockTimestamp: number): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		if (url === 'https://mainnet.base.org') {
			const body = JSON.parse((init?.body as string) ?? '{}') as { method: string };
			if (body.method === 'eth_getTransactionReceipt') {
				return new Response(JSON.stringify({
					result: {
						status: '0x1',
						to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
						blockNumber: '0x1234',
						logs: [{
							address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
							topics: [
								'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
								'0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12',
								'0x000000000000000000000000' + recipientAddress.slice(2).toLowerCase(),
							],
							data: '0x' + BigInt(amountUnits).toString(16).padStart(64, '0'),
						}],
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (body.method === 'eth_getBlockByNumber') {
				return new Response(JSON.stringify({
					result: { timestamp: '0x' + blockTimestamp.toString(16) },
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
		}
		if (url.includes('api.resend.com')) {
			return new Response(JSON.stringify({ id: 'email_mint_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (url.includes('supabase.co')) {
			return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
		}
		return original(input, init);
	};
	return () => { globalThis.fetch = original; };
}

// ─── POST /v5/x402/mint ───────────────────────────────────────────────────────

describe('POST /v5/x402/mint — autonomous key minting', () => {
	it('valid builder tx → key minted in KV, response has api_key + calls_remaining', async () => {
		const txHash  = '0x' + 'aa01bb02cc03dd04ee05ff06aa01bb02aa01bb02cc03dd04ee05ff06aa01bb02';
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '99000000', nowSec - 30);
		try {
			const res = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHash, tier: 'builder' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('api_key');
			expect(typeof body.api_key).toBe('string');
			expect((body.api_key as string).startsWith('ho_live_')).toBe(true);
			expect(body).toHaveProperty('tier', 'builder');
			expect(body).toHaveProperty('calls_remaining', 50000);
			expect(body).toHaveProperty('expires_never', true);

			// Key must be stored in ORACLE_API_KEYS KV
			const encoder = new TextEncoder();
			const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(body.api_key as string));
			const keyHash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
			const stored  = await env.ORACLE_API_KEYS.get(keyHash);
			expect(stored).not.toBeNull();
			const parsed  = JSON.parse(stored!) as Record<string, unknown>;
			expect(parsed).toHaveProperty('plan', 'builder');
			expect(parsed).toHaveProperty('status', 'active');
			expect(parsed).toHaveProperty('source', 'x402_onchain');
		} finally {
			restore();
		}
	});

	it('valid pro tx → key minted with pro tier (299 USDC)', async () => {
		const txHash  = '0x' + '1122334455667788112233445566778811223344556677881122334455667788';
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '299000000', nowSec - 30);
		try {
			const res = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHash, tier: 'pro' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('tier', 'pro');
			expect(body).toHaveProperty('calls_remaining', 200000);
			expect((body.api_key as string).startsWith('ho_live_')).toBe(true);
		} finally {
			restore();
		}
	});

	it('replay tx → 409 conflict', async () => {
		const txHash  = '0x' + 'ababababababababababababababababababababababababababababababababab';
		// pad to 64 chars (need exactly 64 hex chars after 0x)
		const txHashFull = '0x' + 'ab'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '99000000', nowSec - 30);
		try {
			// First mint
			const res1 = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHashFull, tier: 'builder' }),
			});
			expect(res1.status).toBe(200);

			// Second mint with same tx → 409
			const res2 = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHashFull, tier: 'builder' }),
			});
			expect(res2.status).toBe(409);
			const body2 = await res2.json() as Record<string, unknown>;
			expect(body2).toHaveProperty('error', 'CONFLICT');
		} finally {
			restore();
		}
	});

	it('insufficient amount → 402 with required_units', async () => {
		const txHash  = '0x' + 'cd'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '1000', nowSec - 30); // 0.001 USDC << 99 USDC
		try {
			const res = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHash, tier: 'builder' }),
			});
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'PAYMENT_INSUFFICIENT');
			expect(body).toHaveProperty('required_units', '99000000');
		} finally {
			restore();
		}
	});

	it('tx too old (>600s) → 400 PAYMENT_EXPIRED', async () => {
		const txHash  = '0x' + 'ef'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '99000000', nowSec - 700); // 700s old
		try {
			const res = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHash, tier: 'builder' }),
			});
			expect(res.status).toBe(400);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'PAYMENT_EXPIRED');
		} finally {
			restore();
		}
	});

	it('unknown tier → 400 with tiers in body', async () => {
		const res = await fetchW('/v5/x402/mint', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ tx_hash: '0x' + 'fe'.repeat(32), tier: 'enterprise' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'BAD_REQUEST');
		expect(body).toHaveProperty('tiers');
	});

	it('minted key authenticates /v5/status → 200', async () => {
		const txHash  = '0x' + '0a'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockMintRpc(TEST_ADDR, '99000000', nowSec - 30);
		try {
			const mintRes = await fetchW('/v5/x402/mint', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ tx_hash: txHash, tier: 'builder' }),
			});
			expect(mintRes.status).toBe(200);
			const { api_key } = await mintRes.json() as { api_key: string };

			const statusRes = await fetchW('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': api_key },
			});
			expect(statusRes.status).toBe(200);
			const statusBody = await statusRes.json() as Record<string, unknown>;
			expect(VALID_STATUSES).toContain(statusBody.status);
			expect(statusBody).toHaveProperty('signature');
		} finally {
			restore();
		}
	});
});

// ─── MCP Per-Tool Telemetry ───────────────────────────────────────────────────

describe('MCP per-tool telemetry', () => {
	const mcpCall = (toolName: string, args: Record<string, unknown> = {}) =>
		fetchW('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: args } }),
		});

	it('get_market_status call increments mcp_tool:get_market_status counter', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await mcpCall('get_market_status', { mic: 'XNYS' });
		const raw = await env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_status:${today}`);
		expect(raw).not.toBeNull();
		expect(parseInt(raw!, 10)).toBeGreaterThan(0);
	});

	it('verify_receipt call increments mcp_tool:verify_receipt counter', async () => {
		const today = new Date().toISOString().slice(0, 10);
		// Malformed receipt — tool records the call before returning error
		await mcpCall('verify_receipt', { receipt: { signature: '0000', mic: 'XNYS' } });
		const raw = await env.ORACLE_TELEMETRY.get(`mcp_tool:verify_receipt:${today}`);
		expect(raw).not.toBeNull();
		expect(parseInt(raw!, 10)).toBeGreaterThan(0);
	});

	it('get_market_schedule call increments mcp_tool:get_market_schedule counter', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await mcpCall('get_market_schedule', { mic: 'XNYS' });
		const raw = await env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_schedule:${today}`);
		expect(raw).not.toBeNull();
		expect(parseInt(raw!, 10)).toBeGreaterThan(0);
	});

	it('list_exchanges call increments mcp_tool:list_exchanges counter', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await mcpCall('list_exchanges');
		const raw = await env.ORACLE_TELEMETRY.get(`mcp_tool:list_exchanges:${today}`);
		expect(raw).not.toBeNull();
		expect(parseInt(raw!, 10)).toBeGreaterThan(0);
	});

	it('/v5/traction includes mcp_tools_today field with correct shape', async () => {
		const res = await fetchW('/v5/traction');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('mcp_tools_today');
		const tools = body.mcp_tools_today as Record<string, number>;
		expect(typeof tools.get_market_status).toBe('number');
		expect(typeof tools.get_market_schedule).toBe('number');
		expect(typeof tools.list_exchanges).toBe('number');
		expect(typeof tools.verify_receipt).toBe('number');
	});

	it('/v5/handoff includes MCP tool breakdown section', async () => {
		const res = await fetchW('/v5/handoff', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('MCP Tool Calls Today');
		expect(text).toContain('get_market_status:');
		expect(text).toContain('verify_receipt:');
	});
});
