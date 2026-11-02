// B-460: every priced route must verify and settle a payment against its own
// price in X402_RESOURCE_SPECS, never against the status price by default.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import worker, { x402ResourceSpecs } from '../src';

async function fetchW(path: string, options: RequestInit = {}): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(`http://example.com${path}`, options);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function freeKeyOverLimit(key: string): Promise<void> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
	const hash = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'free', status: 'active', email: 'b460@test.invalid', created_at: new Date().toISOString() }));
	await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:${new Date().toISOString().slice(0, 10)}`, '500');
}

// The amount each facilitator call was asked to accept, in call order.
let sent: Array<{ step: 'verify' | 'settle'; amount: string }> = [];
const originalFetch = globalThis.fetch;

function mockFacilitator(): void {
	sent = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		if (url.includes('cdp.coinbase.com') && (url.includes('/verify') || url.includes('/settle'))) {
			const body = JSON.parse(String(init?.body)) as { paymentRequirements: Record<string, unknown> };
			const pr = body.paymentRequirements;
			sent.push({ step: url.includes('/verify') ? 'verify' : 'settle', amount: String(pr.maxAmountRequired ?? pr.amount) });
			const out = url.includes('/verify') ? { isValid: true } : { success: true, txHash: '0x' + 'b4'.repeat(32) };
			return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (url.includes('supabase.co')) return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
		return originalFetch(input as RequestInfo, init);
	};
}

afterEach(() => { globalThis.fetch = originalFetch; });

const PAYMENT = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xb460' } }));
const SPECS = x402ResourceSpecs();

// Each route that accepts an x402 payment, with the resource id whose price it serves.
const ROUTES: Array<{ name: string; id: 'status' | 'batch'; path: string; init: () => Promise<RequestInit> }> = [
	{ name: 'GET /v5/status (keyless)', id: 'status', path: '/v5/status?mic=XNYS', init: async () => ({ headers: { 'X-Payment': PAYMENT } }) },
	{ name: 'GET /v5/status (free key over limit)', id: 'status', path: '/v5/status?mic=XNYS', init: async () => {
		const key = 'ho_free_' + '1'.repeat(64); await freeKeyOverLimit(key);
		return { headers: { 'X-Oracle-Key': key, 'X-Payment': PAYMENT } };
	} },
	{ name: 'GET /v5/status/x402', id: 'status', path: '/v5/status/x402?mic=XNYS', init: async () => ({ headers: { 'X-Payment': PAYMENT } }) },
	{ name: 'GET /v5/batch (free key over limit)', id: 'batch', path: '/v5/batch?mics=XNYS,XLON', init: async () => {
		const key = 'ho_free_' + '2'.repeat(64); await freeKeyOverLimit(key);
		return { headers: { 'X-Oracle-Key': key, 'X-Payment': PAYMENT } };
	} },
	{ name: 'POST /v5/sandbox', id: 'status', path: '/v5/sandbox', init: async () => ({ method: 'POST', headers: { 'X-Payment': PAYMENT, 'Content-Type': 'application/json' }, body: '{}' }) },
	{ name: 'GET /v1/halts', id: 'status', path: '/v1/halts', init: async () => ({ headers: { 'X-Payment': PAYMENT } }) },
	{ name: 'GET /v1/safe-to-trade', id: 'status', path: '/v1/safe-to-trade?venue=XNYS&max_age=30', init: async () => ({ headers: { 'X-Payment': PAYMENT } }) },
];

describe('B-460: each priced route verifies against its own price', () => {
	for (const r of ROUTES) {
		it(`${r.name} sends ${r.id}'s amount to verify and settle`, async () => {
			const init = await r.init();
			mockFacilitator();
			const res = await fetchW(r.path, init);
			const want = SPECS[r.id].amountAtomic;
			expect({ route: r.name, sent }).toEqual({ route: r.name, sent: [{ step: 'verify', amount: want }, { step: 'settle', amount: want }] });
			expect(res.status).toBeLessThan(400);
		});
	}

	// Evidence for the ruling, not a pass/fail on its own: what a free key over
	// its limit is told to pay on /v5/batch before it sends a payment.
	it('records what the keyed /v5/batch 402 advertises', async () => {
		const key = 'ho_free_' + '3'.repeat(64); await freeKeyOverLimit(key);
		const res = await fetchW('/v5/batch?mics=XNYS,XLON', { headers: { 'X-Oracle-Key': key } });
		const body = await res.json() as Record<string, unknown>;
		console.log('B460_BATCH_KEYED_402', res.status, JSON.stringify({ x402: body.x402, x_payment_amount: res.headers.get('X-Payment-Amount') }));
		expect(res.status).toBe(402);
	});
});
