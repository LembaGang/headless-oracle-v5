// B-445: the opt-in paid checkpoint lane, witness-spec/0.6. Only an anonymous
// POST that sends Witness-Spec: 0.6 can pay or be asked to pay; every other
// request keeps 0.5 behaviour (503 when the anonymous pool is used up, 402 only
// for an inactive key). The facilitator is mocked through globalThis.fetch.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, { clearWitnessSchemaCache, clearApiKeyCache, x402ResourceSpecs, x402Base64Decode } from '../src';

const PATH = '/v1/witness/checkpoints';
const SPECS = x402ResourceSpecs();

function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sortedJson(o: Record<string, unknown>): string {
	const s: Record<string, unknown> = {};
	for (const k of Object.keys(o).sort()) s[k] = o[k];
	return JSON.stringify(s);
}
async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// A fresh identity and a validly signed checkpoint, built the way chirindo does.
async function newBody(): Promise<string> {
	const sk = ed.utils.randomSecretKey();
	const x = b64u(await ed.getPublicKeyAsync(sk));
	const kid = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))));
	const unsigned = { v: 'evidence.action/1', type: 'checkpoint', session_id: 'b445', count: 1, last_entry_hash: 'sha256:' + 'c'.repeat(64), ts: '2026-11-02T00:00:01.000Z', kid };
	const sig = await ed.signAsync(new TextEncoder().encode(sortedJson(unsigned)), sk);
	return JSON.stringify({ checkpoint: { ...unsigned, sig: b64u(sig) }, public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x } });
}

type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const testEnv = { ...(env as unknown as Record<string, unknown>), WITNESS_POST_RL: allow, WITNESS_GET_RL: allow, WITNESS_ACCT_RL: allow };

async function call(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init), testEnv as unknown as typeof env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
	return call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

async function setAnonUsage(n: number): Promise<void> {
	await env.WITNESS_DB!.prepare('INSERT INTO witness_usage (day, pool, n) VALUES (?, ?, ?) ON CONFLICT (day, pool) DO UPDATE SET n = excluded.n')
		.bind(new Date().toISOString().slice(0, 10), 'anon', n).run();
}
async function anonUsage(): Promise<number | null> {
	const row = await env.WITNESS_DB!.prepare('SELECT n FROM witness_usage WHERE day = ? AND pool = ?').bind(new Date().toISOString().slice(0, 10), 'anon').first<{ n: number }>();
	return row ? row.n : null;
}
async function rowCount(): Promise<number> {
	return (await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints').first<{ c: number }>())!.c;
}
async function putKey(fill: string, record: Record<string, unknown>): Promise<Record<string, string>> {
	const key = 'ho_live_' + fill.repeat(64);
	await env.ORACLE_API_KEYS.put(await sha256Hex(key), JSON.stringify(record));
	return { Authorization: `Bearer ${key}` };
}

// What each facilitator call was asked to accept, in call order.
let sent: Array<{ step: 'verify' | 'settle'; amount: string; resource: string }> = [];
const originalFetch = globalThis.fetch;
function mockFacilitator(): void {
	sent = [];
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		if (url.includes('cdp.coinbase.com') && (url.includes('/verify') || url.includes('/settle'))) {
			const pr = (JSON.parse(String(init?.body)) as { paymentRequirements: Record<string, unknown> }).paymentRequirements;
			sent.push({ step: url.includes('/verify') ? 'verify' : 'settle', amount: String(pr.maxAmountRequired ?? pr.amount), resource: String(pr.resource ?? '') });
			const out = url.includes('/verify') ? { isValid: true } : { success: true, txHash: '0x' + 'b5'.repeat(32) };
			return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
		}
		if (url.includes('supabase.co')) return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
		return originalFetch(input as RequestInfo, init);
	};
}

const PAYMENT = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xb445' } }));
const V06 = { 'Witness-Spec': '0.6' };

beforeEach(async () => {
	clearWitnessSchemaCache();
	clearApiKeyCache();
	await call(`${PATH}?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
	await env.WITNESS_DB!.prepare('DELETE FROM witness_usage').run();
	mockFacilitator();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('B-445 (a): a 0.5 request is unchanged', () => {
	it('no header, pool used up: 503 witness_unavailable, even with a payment attached; nothing verified', async () => {
		await setAnonUsage(2000);
		for (const headers of [{}, { 'X-Payment': PAYMENT }]) {
			const res = await post(await newBody(), headers);
			expect(res.status).toBe(503);
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).toBe('witness_unavailable');
			expect(body.accepts).toBeUndefined();
			expect(res.headers.get('X-Payment-Amount')).toBeNull();
		}
		expect(sent).toEqual([]);
	});

	it('no header, inactive key: 402 payment_required as today, with no x402 challenge', async () => {
		const auth = await putKey('7', { plan: 'evidence', status: 'cancelled' });
		const res = await post(await newBody(), auth);
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('payment_required');
		expect(body.accepts).toBeUndefined();
		expect(res.headers.get('Payment-Required')).toBeNull();
	});
});

describe('B-445 (b): a 0.6 request with a valid payment', () => {
	it('is stored, and verify and settle are both asked for the checkpoint amount (1000) on the checkpoint resource, whatever the pool', async () => {
		expect(SPECS.checkpoint?.amountAtomic).toBe('1000');
		await setAnonUsage(2000);
		const res = await post(await newBody(), { ...V06, 'X-Payment': PAYMENT });
		expect(res.status).toBe(201);
		expect(sent).toEqual([
			{ step: 'verify', amount: '1000', resource: SPECS.checkpoint.defaultResourceUrl },
			{ step: 'settle', amount: '1000', resource: SPECS.checkpoint.defaultResourceUrl },
		]);
		expect(res.headers.get('X-Payment-Response')).not.toBeNull();
		expect(await rowCount()).toBe(1);
		// The paid row is not counted in the anonymous pool.
		expect(await anonUsage()).toBe(2000);
	});

	it('a repeat of a stored checkpoint is answered 200 without verifying the payment', async () => {
		const body = await newBody();
		expect((await post(body, V06)).status).toBe(201);
		const res = await post(body, { ...V06, 'X-Payment': PAYMENT });
		expect(res.status).toBe(200);
		expect(sent).toEqual([]);
	});
});

describe('B-445 (c): a 0.6 request with no payment and the pool available', () => {
	it('is served free, counted in the anonymous pool, with no facilitator call', async () => {
		const res = await post(await newBody(), V06);
		expect(res.status).toBe(201);
		expect(sent).toEqual([]);
		expect(await anonUsage()).toBe(1);
		expect(res.headers.get('X-Payment-Response')).toBeNull();
	});
});

describe('B-445 (d): a 0.6 request with no payment and the pool used up', () => {
	it('gets 402 whose body and headers carry 1000 and 0.001 USDC; nothing stored', async () => {
		await setAnonUsage(2000);
		const res = await post(await newBody(), V06);
		expect(res.status).toBe(402);
		const body = await res.json() as { error: string; x402Version: number; accepts: Array<Record<string, unknown>>; upgrade: unknown };
		expect(body.error).toBe('payment_required');
		expect(body.x402Version).toBe(1);
		expect(body.accepts.map((a) => a.maxAmountRequired)).toEqual(['1000']);
		expect(body.accepts[0].resource).toBe(SPECS.checkpoint.defaultResourceUrl);
		expect(body.upgrade).toBeTruthy();
		expect(res.headers.get('X-Payment-Amount')).toBe('0.001 USDC');
		const v2 = JSON.parse(x402Base64Decode(res.headers.get('Payment-Required')!)) as { accepts: Array<{ amount: string }>; resource: { url: string } };
		expect(v2.accepts.map((a) => a.amount)).toEqual(['1000']);
		expect(v2.resource.url).toBe(SPECS.checkpoint.defaultResourceUrl);
		expect(sent).toEqual([]);
		expect(await rowCount()).toBe(0);
	});
});

describe('B-445 (e): a keyed request with the 0.6 header is never asked to pay', () => {
	it('an active Evidence key with the anonymous pool used up and a payment attached: 201, nothing verified', async () => {
		const auth = await putKey('8', { plan: 'evidence', status: 'active' });
		await setAnonUsage(2000);
		const res = await post(await newBody(), { ...auth, ...V06, 'X-Payment': PAYMENT });
		expect(res.status).toBe(201);
		expect(sent).toEqual([]);
		expect(res.headers.get('X-Payment-Response')).toBeNull();
	});

	it('an inactive key with the 0.6 header: the same 402 as under 0.5, with no x402 challenge', async () => {
		const auth = await putKey('9', { plan: 'evidence', status: 'cancelled' });
		const res = await post(await newBody(), { ...auth, ...V06 });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body.accepts).toBeUndefined();
		expect(res.headers.get('Payment-Required')).toBeNull();
		expect(sent).toEqual([]);
	});
});

describe('B-445 (g): /v5/pricing lists the checkpoint price', () => {
	it('x402.resources carries checkpoint at the spec amount, and the witness_x402 tier quotes it', async () => {
		const res = await call('/v5/pricing');
		expect(res.status).toBe(200);
		const p = await res.json() as { tiers: Array<Record<string, unknown>>; x402: { resources?: Array<Record<string, unknown>> } };
		const r = p.x402.resources?.find((x) => x.id === 'checkpoint');
		expect(r).toMatchObject({ amount_units: SPECS.checkpoint.amountAtomic, amount_usdc: '0.001', resource: SPECS.checkpoint.defaultResourceUrl, routes: ['POST /v1/witness/checkpoints'] });
		expect(p.x402.resources!.map((x) => [x.id, x.amount_units])).toEqual(Object.entries(SPECS).map(([id, s]) => [id, s.amountAtomic]));
		expect(p.tiers.find((t) => t.id === 'witness_x402')).toMatchObject({ usdc_amount_units: '1000', price_usdc: '0.001' });
	});
});
