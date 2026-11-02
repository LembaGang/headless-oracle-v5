// B-460 guard: every 402 that quotes an x402 price quotes that route's own
// X402_RESOURCE_SPECS amount, in the body and in every price-carrying header.
// A literal written beside the canonical object (the '1000' build402Payload
// carried until B-460) turns this red for the route that serves it.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, { x402ResourceSpecs, x402ResourceRoutes, x402Base64Decode, clearWitnessSchemaCache } from '../src';

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

function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The anonymous witness pool used up for today (the cap is 2,000).
async function witnessPoolUsedUp(): Promise<void> {
	clearWitnessSchemaCache();
	await fetchW(`/v1/witness/checkpoints?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('INSERT INTO witness_usage (day, pool, n) VALUES (?, ?, ?) ON CONFLICT (day, pool) DO UPDATE SET n = excluded.n')
		.bind(new Date().toISOString().slice(0, 10), 'anon', 2000).run();
}

// A validly signed checkpoint from a fresh key, so the request reaches the pool.
async function witnessBody(): Promise<string> {
	const sk = ed.utils.randomSecretKey();
	const x = b64u(await ed.getPublicKeyAsync(sk));
	const kid = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))));
	const cp: Record<string, unknown> = { v: 'evidence.action/1', type: 'checkpoint', session_id: 'guard', count: 1, last_entry_hash: 'sha256:' + 'd'.repeat(64), ts: '2026-11-02T00:00:01.000Z', kid };
	const canon = JSON.stringify(Object.fromEntries(Object.keys(cp).sort().map((k) => [k, cp[k]])));
	const sig = b64u(await ed.signAsync(new TextEncoder().encode(canon), sk));
	return JSON.stringify({ checkpoint: { ...cp, sig }, public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x } });
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
const ROUTES_BY_ID = x402ResourceRoutes();
type Id = keyof typeof SPECS;

// B-445: the cases are built from x402ResourceRoutes(), the source's list of
// the routes that charge each resource id, so a new id or route reaches the
// guard without anyone editing a case list. What stays here is only how to
// bring each route to a 402; a route with none fails the guard by name.
// /v5/credits/purchase has no spec entry of its own; it sells credits sized
// from the amount paid and quotes the per-request (status) price.
const HOW_TO_402: Record<string, Array<{ how: string; path: string; init: () => Promise<RequestInit> }>> = {
	'GET /v5/status': [
		{ how: 'keyless, trial used', path: '/v5/status?mic=XNYS', init: async () => { await exhaustKeylessTrial(); return {}; } },
		{ how: 'free key over limit', path: '/v5/status?mic=XNYS', init: async () => {
			const key = 'ho_free_' + '4'.repeat(64); await freeKeyOverLimit(key); return { headers: { 'X-Oracle-Key': key } };
		} },
	],
	'GET /v5/status/x402': [{ how: 'keyless', path: '/v5/status/x402?mic=XNYS', init: async () => ({}) }],
	'GET /v5/batch': [
		{ how: 'keyless', path: '/v5/batch?mics=XNYS,XLON', init: async () => ({}) },
		{ how: 'free key over limit', path: '/v5/batch?mics=XNYS,XLON', init: async () => {
			const key = 'ho_free_' + '5'.repeat(64); await freeKeyOverLimit(key); return { headers: { 'X-Oracle-Key': key } };
		} },
	],
	'GET /v1/halts': [{ how: 'keyless', path: '/v1/halts', init: async () => ({}) }],
	'GET /v1/safe-to-trade': [{ how: 'keyless', path: '/v1/safe-to-trade?venue=XNYS&max_age=30', init: async () => ({}) }],
	'POST /v5/credits/purchase': [{ how: 'free key, no payment', path: '/v5/credits/purchase', init: async () => {
		const key = 'ho_free_' + '6'.repeat(64); await freeKeyOverLimit(key);
		return { method: 'POST', headers: { 'X-Oracle-Key': key, 'Content-Type': 'application/json' }, body: '{}' };
	} }],
	'POST /v5/sandbox': [{ how: 'payment not decodable', path: '/v5/sandbox', init: async () => ({
		method: 'POST', headers: { 'X-Payment': 'not-a-payment', 'Content-Type': 'application/json' }, body: '{}',
	}) }],
	'POST /v1/witness/checkpoints': [{ how: 'Witness-Spec 0.6, anonymous pool used up', path: '/v1/witness/checkpoints', init: async () => {
		await witnessPoolUsedUp(); return { method: 'POST', headers: { 'Content-Type': 'application/json', 'Witness-Spec': '0.6' }, body: await witnessBody() };
	} }],
};

const ROUTES: Array<{ name: string; route: string; id: Id; path?: string; init?: () => Promise<RequestInit> }> = [];
for (const id of Object.keys(SPECS) as Id[]) {
	for (const route of ROUTES_BY_ID[id] ?? []) {
		const ways = HOW_TO_402[route];
		if (!ways) { ROUTES.push({ name: `${route} (no way to reach its 402 is written here)`, route, id }); continue; }
		for (const w of ways) ROUTES.push({ name: `${route} (${w.how})`, route, id, path: w.path, init: w.init });
	}
}

describe('B-460 guard: each 402 quotes its own route price', () => {
	for (const r of ROUTES) {
		it(`${r.name} quotes ${r.id} (${SPECS[r.id].amountAtomic}) everywhere`, async () => {
			expect(r.path, `add ${r.route} to HOW_TO_402`).toBeDefined();
			const res = await fetchW(r.path!, await r.init!());
			expect(res.status).toBe(402);
			const found = quotedAmounts(await res.json() as Record<string, unknown>, res.headers);
			expect(found.length).toBeGreaterThan(0);
			const want = SPECS[r.id].amountAtomic;
			expect({ route: r.name, found }).toEqual({ route: r.name, found: found.map(([where]) => [where, want]) });
		});
	}

	// (f) The guard reaches every resource id in the specs, checkpoint among
	// them, from the source's route list and not from a case written here.
	it('covers every resource id in X402_RESOURCE_SPECS, checkpoint included', () => {
		expect(Object.keys(ROUTES_BY_ID).sort()).toEqual(Object.keys(SPECS).sort());
		expect([...new Set(ROUTES.map((r) => r.id))].sort()).toEqual(Object.keys(SPECS).sort());
		expect(ROUTES.filter((r) => r.id === ('checkpoint' as Id)).map((r) => r.route)).toEqual(['POST /v1/witness/checkpoints']);
	});
});
