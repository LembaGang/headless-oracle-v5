// LIVE PRODUCTION SMOKE TESTS — safe to run,
// hits real endpoints, no destructive operations.
//
// Run: npm run test:smoke
// These tests verify core functionality against the live production
// endpoint at https://headlessoracle.com. They perform only GET/POST
// reads — no writes, no payments, no side effects beyond the free
// trial counter increment on test 10.
//
// If test 10 returns 402, it means the IP's daily trial is exhausted.
// Both 200 and 402 are acceptable outcomes for that test.

import { describe, it, expect } from 'vitest';

const BASE = 'https://headlessoracle.com';

describe('Production Smoke Tests', () => {
	it('GET /v5/demo?mic=XNYS → 200, has signature and status', async () => {
		const res = await fetch(`${BASE}/v5/demo?mic=XNYS`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		// Receipt may be wrapped in { receipt, discovery_url } or flat
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt).toHaveProperty('signature');
		expect(receipt).toHaveProperty('status');
		expect(['OPEN', 'CLOSED', 'UNKNOWN', 'HALTED']).toContain(receipt.status);
	});

	it('GET /v5/demo?mic=INVALID → 400, has error field', async () => {
		const res = await fetch(`${BASE}/v5/demo?mic=INVALID`);
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error');
	});

	it('GET /v5/briefing → 200, has market fields', async () => {
		const res = await fetch(`${BASE}/v5/briefing`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('markets_open_now');
		expect(body).toHaveProperty('markets_closed_now');
	});

	it('GET /v5/exchanges → 200, array with 28 items', async () => {
		const res = await fetch(`${BASE}/v5/exchanges`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const exchanges = body.exchanges as unknown[];
		expect(Array.isArray(exchanges)).toBe(true);
		expect(exchanges.length).toBe(28);
	});

	it('GET /v5/health → 200, has status ok', async () => {
		const res = await fetch(`${BASE}/v5/health`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		// Health receipt is nested or flat
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.status).toBe('OK');
	});

	it('GET /AGENTS.md → 200, markdown with headless-oracle-mcp', async () => {
		const res = await fetch(`${BASE}/AGENTS.md`);
		expect(res.status).toBe(200);
		const contentType = res.headers.get('content-type') ?? '';
		expect(contentType).toContain('text/markdown');
		const text = await res.text();
		expect(text).toContain('headless-oracle-mcp');
	});

	it('GET /llms.txt → 200, starts with # Headless Oracle', async () => {
		const res = await fetch(`${BASE}/llms.txt`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text.trimStart().startsWith('# Headless Oracle')).toBe(true);
	});

	it('GET /llms-full.txt → 200, contains XNYS and Ed25519', async () => {
		const res = await fetch(`${BASE}/llms-full.txt`);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('XNYS');
		expect(text).toContain('Ed25519');
	});

	it('GET /openapi.json → 200, valid JSON with paths object', async () => {
		const res = await fetch(`${BASE}/openapi.json`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('paths');
		expect(typeof body.paths).toBe('object');
		expect(body).toHaveProperty('openapi');
	});

	it('GET /v5/status?mic=XNYS (no auth) → 200 or 402', async () => {
		// Free trial: 3 receipts/day per IP. May be 200 (trial available)
		// or 402 (trial exhausted). Both are correct behavior.
		const res = await fetch(`${BASE}/v5/status?mic=XNYS`);
		expect([200, 402]).toContain(res.status);
		const body = await res.json() as Record<string, unknown>;
		if (res.status === 200) {
			const receipt = (body.receipt ?? body) as Record<string, unknown>;
			expect(receipt).toHaveProperty('signature');
			expect(receipt).toHaveProperty('status');
		} else {
			// 402 should have error and x402 payment info
			expect(body).toHaveProperty('error');
		}
	});

	it('POST /mcp with initialize → 200, has serverInfo', async () => {
		const res = await fetch(`${BASE}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'smoke-test', version: '1.0.0' },
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('result');
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('serverInfo');
	});
});
