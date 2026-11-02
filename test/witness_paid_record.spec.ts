// B-445 T2: no settled payment without a record, and paid checkpoints are
// marked. The facilitator path is verified, stored, then settled; the on-chain
// path arrives settled, so a failed write records the transaction and a retry
// of the same checkpoint is accepted without a second charge. Writes are made
// to fail by wrapping WITNESS_DB; the facilitator and Base RPC are mocked.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, { clearWitnessSchemaCache, clearApiKeyCache } from '../src';

const PATH = '/v1/witness/checkpoints';
const V06 = { 'Witness-Spec': '0.6' };

function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function sortedJson(o: Record<string, unknown>): string {
	const s: Record<string, unknown> = {};
	for (const k of Object.keys(o).sort()) s[k] = o[k];
	return JSON.stringify(s);
}
async function sha256Hex(s: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

interface Cp { body: string; kid: string; identity: string }
async function newCheckpoint(): Promise<Cp> {
	const sk = ed.utils.randomSecretKey();
	const x = b64u(await ed.getPublicKeyAsync(sk));
	const kid = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))));
	const unsigned = { v: 'evidence.action/1', type: 'checkpoint', session_id: 'b445t2', count: 1, last_entry_hash: 'sha256:' + 'e'.repeat(64), ts: '2026-11-02T00:00:01.000Z', kid };
	const sig = await ed.signAsync(new TextEncoder().encode(sortedJson(unsigned)), sk);
	return {
		body: JSON.stringify({ checkpoint: { ...unsigned, sig: b64u(sig) }, public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x } }),
		kid,
		identity: `${kid}|b445t2|1|${unsigned.last_entry_hash}`,
	};
}

type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const baseEnv = { ...(env as unknown as Record<string, unknown>), WITNESS_POST_RL: allow, WITNESS_GET_RL: allow, WITNESS_ACCT_RL: allow };

// WITNESS_DB with every statement whose SQL matches `fail` throwing on run().
function failingDb(fail: RegExp): unknown {
	const real = env.WITNESS_DB!;
	return {
		prepare(sql: string) {
			if (!fail.test(sql)) return real.prepare(sql);
			const stmt = { bind: () => stmt, run: async () => { throw new Error('injected D1 failure'); }, first: async () => { throw new Error('injected D1 failure'); }, all: async () => { throw new Error('injected D1 failure'); } };
			return stmt;
		},
		batch: real.batch.bind(real),
		exec: real.exec.bind(real),
	};
}

async function post(body: string, headers: Record<string, string>, e: Record<string, unknown> = baseEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }), e as unknown as typeof env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
async function row(kid: string): Promise<{ payment_json: string | null } | null> {
	return env.WITNESS_DB!.prepare('SELECT payment_json FROM witness_checkpoints WHERE kid = ?').bind(kid).first<{ payment_json: string | null }>();
}
async function putKey(fill: string): Promise<Record<string, string>> {
	const key = 'ho_live_' + fill.repeat(64);
	await env.ORACLE_API_KEYS.put(await sha256Hex(key), JSON.stringify({ plan: 'evidence', status: 'active' }));
	return { Authorization: `Bearer ${key}` };
}

// The facilitator and Base RPC, scripted per test.
const calls: string[] = [];
let settleOk = true;
const originalFetch = globalThis.fetch;
const FAC_PAYMENT = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xb445t2' } }));
const SETTLED_TX = '0x' + 'c6'.repeat(32);
function mockNetwork(): void {
	calls.length = 0;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (url.includes('cdp.coinbase.com') && url.includes('/verify')) { calls.push('verify'); return j({ isValid: true }); }
		if (url.includes('cdp.coinbase.com') && url.includes('/settle')) {
			calls.push('settle');
			return j(settleOk ? { success: true, txHash: SETTLED_TX } : { success: false, errorReason: 'insufficient_funds' });
		}
		if (url === 'https://mainnet.base.org') {
			const method = (JSON.parse(String(init?.body)) as { method: string }).method;
			calls.push(method);
			if (method === 'eth_getTransactionReceipt') {
				return j({ result: { status: '0x1', blockNumber: '0x1234', logs: [{
					address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
					topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + 'ab'.repeat(20), '0x' + '0'.repeat(24) + String(env.ORACLE_PAYMENT_ADDRESS).slice(2).toLowerCase()],
					data: '0x' + (1000).toString(16).padStart(64, '0'),
				}] } });
			}
			if (method === 'eth_getBlockByNumber') return j({ result: { timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16) } });
		}
		return originalFetch(input as RequestInfo, init);
	};
}
let txSeq = 0;
function onchainPayment(): { header: string; tx: string } {
	const tx = '0x' + (++txSeq).toString(16).padStart(4, '0') + 'd7'.repeat(30);
	return { header: JSON.stringify({ txHash: tx, network: 'base', amount: '1000', paymentAddress: env.ORACLE_PAYMENT_ADDRESS, memo: 'b445t2' }), tx };
}

beforeEach(async () => {
	clearWitnessSchemaCache();
	clearApiKeyCache();
	settleOk = true;
	const ctx = createExecutionContext();
	await worker.fetch(new Request(`http://example.com${PATH}?kid=${'A'.repeat(43)}&session_id=x`), baseEnv as unknown as typeof env, ctx);
	await waitOnExecutionContext(ctx);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
	await env.WITNESS_DB!.prepare('DELETE FROM witness_usage').run();
	mockNetwork();
});
afterEach(() => { globalThis.fetch = originalFetch; });

const INSERT = /^\s*INSERT OR IGNORE INTO witness_checkpoints/;

describe('B-445 T2: a failed write leaves no settled payment unrecorded', () => {
	it('facilitator path: the write fails after /verify, so /settle is never called (503, nothing settled)', async () => {
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT }, { ...baseEnv, WITNESS_DB: failingDb(INSERT) });
		expect(res.status).toBe(503);
		expect(calls).toEqual(['verify']);
		expect(await row(cp.kid)).toBeNull();
	});

	it('on-chain path: the write fails after the payment is verified, so the transaction is recorded; a retry of the same checkpoint is accepted with no second charge', async () => {
		const cp = await newCheckpoint();
		const pay = onchainPayment();
		const res = await post(cp.body, { ...V06, 'X-Payment': pay.header }, { ...baseEnv, WITNESS_DB: failingDb(INSERT) });
		expect(res.status).toBe(503);
		expect(calls).toEqual(['eth_getTransactionReceipt', 'eth_getBlockByNumber']);
		const rec = JSON.parse((await env.ORACLE_TELEMETRY.get(`witness_unstored_payment:${pay.tx}`))!) as { identity: string; reason: string; payment: Record<string, unknown> };
		expect(rec).toMatchObject({ identity: cp.identity, reason: 'write_failed', payment: { transaction: pay.tx, path: 'direct_onchain', settlement: 'settled', amount_units: '1000' } });

		calls.length = 0;
		const retry = await post(cp.body, { ...V06, 'X-Payment': pay.header });
		expect(retry.status).toBe(201);
		expect(calls).toEqual([]);
		const body = await retry.json() as { payment: Record<string, unknown> };
		expect(body.payment).toMatchObject({ transaction: pay.tx, settlement: 'settled', retried_from_unstored: 'true' });
		expect(JSON.parse((await row(cp.kid))!.payment_json!)).toMatchObject({ transaction: pay.tx, settlement: 'settled' });
	});

	it('on-chain path: the recorded transaction is refused for a different checkpoint', async () => {
		const first = await newCheckpoint();
		const pay = onchainPayment();
		expect((await post(first.body, { ...V06, 'X-Payment': pay.header }, { ...baseEnv, WITNESS_DB: failingDb(INSERT) })).status).toBe(503);
		const other = await newCheckpoint();
		calls.length = 0;
		const res = await post(other.body, { ...V06, 'X-Payment': pay.header });
		expect(res.status).toBe(402);
		expect(await res.json()).toMatchObject({ error: 'payment_required', x402_error: 'TRANSACTION_ALREADY_USED' });
		expect(calls).toEqual([]);
		expect(await row(other.kid)).toBeNull();
	});
});

describe('B-445 T2: a settlement failure after the write still returns the receipt', () => {
	it('201 with the receipt; the row and the response record settlement "failed"', async () => {
		settleOk = false;
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT });
		expect(res.status).toBe(201);
		expect(calls).toEqual(['verify', 'settle']);
		const body = await res.json() as Record<string, unknown> & { payment: Record<string, unknown> };
		expect(body.type).toBe('witness.checkpoint/1');
		expect(body.payment).toMatchObject({ settlement: 'failed', path: 'cdp_facilitator' });
		expect(String(body.payment.settlement_error)).toContain('insufficient_funds');
		expect(res.headers.get('X-Payment-Response')).toBeNull();
		expect(JSON.parse((await row(cp.kid))!.payment_json!)).toMatchObject({ settlement: 'failed' });
	});

	it('a settled payment whose payment update then fails is still in the x402 ledger', async () => {
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT }, { ...baseEnv, WITNESS_DB: failingDb(/^\s*UPDATE witness_checkpoints SET payment_json/) });
		expect(res.status).toBe(201);
		expect(calls).toEqual(['verify', 'settle']);
		expect(JSON.parse((await row(cp.kid))!.payment_json!)).toMatchObject({ settlement: 'pending' });
		const ledger = await env.ORACLE_TELEMETRY.list({ prefix: 'x402_payment:' });
		expect(ledger.keys.some((k) => k.name.endsWith(`:${SETTLED_TX}`))).toBe(true);
	});
});

describe('B-445 T2: paid checkpoints are marked; free and keyed ones are not', () => {
	it('the paid row and the 201 carry the payment, unsigned, beside a receipt that verifies without it', async () => {
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT });
		expect(res.status).toBe(201);
		const body = await res.json() as Record<string, string> & { payment: Record<string, unknown> };
		// B-445 T3 added checkpoint_id to the record, and the stored row also holds
		// the signed attestation (served as payment_attestation, not in payment).
		const want = { resource: 'checkpoint', amount_units: '1000', amount_usdc: '0.001', network: 'base', transaction: SETTLED_TX, path: 'cdp_facilitator', settlement: 'settled', checkpoint_id: expect.stringMatching(/^[0-9a-f]{64}$/) };
		expect(body.payment).toEqual(want);
		const { attestation, ...stored } = JSON.parse((await row(cp.kid))!.payment_json!) as Record<string, unknown>;
		expect(stored).toEqual(want);
		expect(attestation).toEqual((body as Record<string, unknown>).payment_attestation);
		// The signed bytes are the receipt fields only.
		const { payment: _p, payment_attestation: _a, signature, ...signed } = body as Record<string, string>;
		const keys = await (await worker.fetch(new Request('http://example.com/v5/keys'), env, createExecutionContext())).json() as { keys: { key_id: string; public_key: string }[] };
		const pub = keys.keys.find((k) => k.key_id === signed.public_key_id)!.public_key;
		const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
		expect(await ed.verifyAsync(fromHex(signature), new TextEncoder().encode(sortedJson(signed)), fromHex(pub))).toBe(true);
		// A repeat by a 0.6 client carries it; a repeat without the header does not.
		const again = await (await post(cp.body, V06)).json() as Record<string, unknown>;
		expect(again.payment).toEqual(want);
		const plain = await (await post(cp.body, {})).json() as Record<string, unknown>;
		expect(plain.payment).toBeUndefined();
	});

	it('a free 0.6 checkpoint and a keyed checkpoint carry no payment, in the row or the response', async () => {
		const free = await newCheckpoint();
		const r1 = await post(free.body, V06);
		expect(r1.status).toBe(201);
		expect((await r1.json() as Record<string, unknown>).payment).toBeUndefined();
		expect(await row(free.kid)).toEqual({ payment_json: null });
		const keyed = await newCheckpoint();
		const r2 = await post(keyed.body, { ...(await putKey('e')), ...V06, 'X-Payment': FAC_PAYMENT });
		expect(r2.status).toBe(201);
		expect((await r2.json() as Record<string, unknown>).payment).toBeUndefined();
		expect(await row(keyed.kid)).toEqual({ payment_json: null });
		expect(calls).toEqual([]);
	});
});
