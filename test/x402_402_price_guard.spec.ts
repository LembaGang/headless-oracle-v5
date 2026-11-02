// B-460 guard: every 402 that quotes an x402 price quotes that route's own
// X402_RESOURCE_SPECS amount, in the body and in every price-carrying header.
// A literal written beside the canonical object (the '1000' build402Payload
// carried until B-460) turns this red for the route that serves it.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { x402ResourceSpecs, x402Base64Decode } from '../src';

async function fetchW(path: string, options: RequestInit = {}): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(`http://example.com${path}`, options);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function sha256(text: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function freeKeyOverLimit(key: string): Promise<void> {
	const hash = await sha256(key);
	await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'free', status: 'active', email: 'b460@test.invalid', created_at: new Date().toISOString() }));
	await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:${new Date().toISOString().slice(0, 10)}`, '500');
}

async function exhaustKeylessTrial(): Promise<void> {
	await env.ORACLE_TELEMETRY.put(`trial_usage:${new Date().toISOString().slice(0, 10)}:${await sha256('')}`, '3', { expirationTtl: 3600 });
}

// Every atomic amount a 402 quotes, labelled by where it was found.
function quotedAmounts(body: Record<string, unknown>, headers: Headers): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const fromAccepts = (where: string, accepts: unknown) => {
		if (!Array.isArray(accepts)) return;
		accepts.forEach((a: Record<string, unknown>, i) => {
			if (a.maxAmountRequired !== undefined) out.push([`${where}.accepts[${i}].maxAmountRequired`, String(a.maxAmountRequired)]);
			if (a.amount !== undefined) out.push([`${where}.accepts[${i}].amount`, String(a.amount)]);
		});
	};
	fromAccepts('body', body.accepts);
	const x402 = body.x402 as Record<string, unknown> | undefined;
	if (x402) {
		if (x402.amount !== undefined) out.push(['body.x402.amount', String(x402.amount)]);
		fromAccepts('body.x402', x402.accepts);
	}
	const pr = headers.get('Payment-Required');
	if (pr) fromAccepts('header Payment-Required', (JSON.parse(x402Base64Decode(pr)) as Record<string, unknown>).accepts);
	const prj = headers.get('Payment-Required-Json');
	if (prj) fromAccepts('header Payment-Required-Json', (JSON.parse(prj) as Record<string, unknown>).accepts);
	const xpa = headers.get('X-Payment-Amount');
	if (xpa) {
		const m = /^(\d+)(?:\.(\d{1,6}))? USDC$/.exec(xpa);
		out.push(['header X-Payment-Amount', m ? String(BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'))) : `unparsed:${xpa}`]);
	}
	return out;
}

const SPECS = x402ResourceSpecs();

// Every route that can answer a 402 carrying an x402 price, keyless and with a
// free key over its daily limit. /v5/credits/purchase has no spec entry of its
// own; it sells credits sized from the amount paid and quotes the per-request
// (status) price, which is what it is held to here.
const ROUTES: Array<{ name: string; id: 'status' | 'batch'; path: string; init: () => Promise<RequestInit> }> = [
	{ name: 'GET /v5/status (keyless, trial used)', id: 'status', path: '/v5/status?mic=XNYS', init: async () => { await exhaustKeylessTrial(); return {}; } },
	{ name: 'GET /v5/status (free key over limit)', id: 'status', path: '/v5/status?mic=XNYS', init: async () => {
		const key = 'ho_free_' + '4'.repeat(64); await freeKeyOverLimit(key); return { headers: { 'X-Oracle-Key': key } };
	} },
	{ name: 'GET /v5/status/x402 (keyless)', id: 'status', path: '/v5/status/x402?mic=XNYS', init: async () => ({}) },
	{ name: 'GET /v5/batch (keyless)', id: 'batch', path: '/v5/batch?mics=XNYS,XLON', init: async () => ({}) },
	{ name: 'GET /v5/batch (free key over limit)', id: 'batch', path: '/v5/batch?mics=XNYS,XLON', init: async () => {
		const key = 'ho_free_' + '5'.repeat(64); await freeKeyOverLimit(key); return { headers: { 'X-Oracle-Key': key } };
	} },
	{ name: 'GET /v1/halts (keyless)', id: 'status', path: '/v1/halts', init: async () => ({}) },
	{ name: 'GET /v1/safe-to-trade (keyless)', id: 'status', path: '/v1/safe-to-trade?venue=XNYS&max_age=30', init: async () => ({}) },
	{ name: 'POST /v5/credits/purchase (free key, no payment)', id: 'status', path: '/v5/credits/purchase', init: async () => {
		const key = 'ho_free_' + '6'.repeat(64); await freeKeyOverLimit(key);
		return { method: 'POST', headers: { 'X-Oracle-Key': key, 'Content-Type': 'application/json' }, body: '{}' };
	} },
];

describe('B-460 guard: each 402 quotes its own route price', () => {
	for (const r of ROUTES) {
		it(`${r.name} quotes ${r.id} (${SPECS[r.id].amountAtomic}) everywhere`, async () => {
			const res = await fetchW(r.path, await r.init());
			expect(res.status).toBe(402);
			const found = quotedAmounts(await res.json() as Record<string, unknown>, res.headers);
			expect(found.length).toBeGreaterThan(0);
			const want = SPECS[r.id].amountAtomic;
			expect({ route: r.name, found }).toEqual({ route: r.name, found: found.map(([where]) => [where, want]) });
		});
	}
});
