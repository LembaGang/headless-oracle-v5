// B-445 T3: a signed link from each paid checkpoint to its payment, and alarms
// that need nobody watching. The attestation is checked here with an
// independent implementation of the published rule (the worker's helpers are
// not used to build or verify it), against the key served at /v5/keys.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, { clearWitnessSchemaCache, clearApiKeyCache, ensureHoRecordSchema, clearHoRecordSchemaCache } from '../src';

const PATH = '/v1/witness/checkpoints';
const V06 = { 'Witness-Spec': '0.6' };
const RECEIPT_FIELDS = ['type', 'witness', 'received_at', 'kid', 'session_id', 'count', 'last_entry_hash', 'checkpoint_ts', 'checkpoint_sha256', 'fork', 'public_key_id'];
const ATTESTATION_FIELDS = ['type', 'witness', 'checkpoint_id', 'receipt_sha256', 'resource', 'amount_units', 'asset', 'network', 'transaction', 'settlement', 'issued_at', 'public_key_id'];

function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
function sortedJson(o: Record<string, unknown>): string {
	const s: Record<string, unknown> = {};
	for (const k of Object.keys(o).sort()) s[k] = o[k];
	return JSON.stringify(s);
}
async function sha256Hex(s: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const baseEnv = { ...(env as unknown as Record<string, unknown>), WITNESS_POST_RL: allow, WITNESS_GET_RL: allow, WITNESS_ACCT_RL: allow };

async function call(path: string, init: RequestInit = {}, e: Record<string, unknown> = baseEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init), e as unknown as typeof env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function post(body: string, headers: Record<string, string>, e: Record<string, unknown> = baseEnv): Promise<Response> {
	return call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }, e);
}

async function newCheckpoint(): Promise<{ body: string; kid: string }> {
	const sk = ed.utils.randomSecretKey();
	const x = b64u(await ed.getPublicKeyAsync(sk));
	const kid = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))));
	const unsigned = { v: 'evidence.action/1', type: 'checkpoint', session_id: 'b445t3', count: 1, last_entry_hash: 'sha256:' + 'f'.repeat(64), ts: '2026-11-02T00:00:01.000Z', kid };
	const sig = await ed.signAsync(new TextEncoder().encode(sortedJson(unsigned)), sk);
	return { body: JSON.stringify({ checkpoint: { ...unsigned, sig: b64u(sig) }, public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x } }), kid };
}

// The published rule, written out independently of the worker.
async function checkpointIdOf(receipt: Record<string, string>): Promise<string> {
	return sha256Hex(sortedJson({ kid: receipt.kid, session_id: receipt.session_id, count: receipt.count, last_entry_hash: receipt.last_entry_hash }));
}
let publicKey: Uint8Array;
async function verifySigned(obj: Record<string, string>): Promise<boolean> {
	const { signature, ...signed } = obj;
	try {
		return await ed.verifyAsync(fromHex(signature), new TextEncoder().encode(sortedJson(signed)), publicKey);
	} catch {
		return false;
	}
}
// A verifier that checks type before the signature, as the spec says.
async function verifyAttestation(a: Record<string, string>): Promise<boolean> {
	return a.type === 'witness-payment-attestation/0.1' && await verifySigned(a);
}
async function verifyReceipt(r: Record<string, string>): Promise<boolean> {
	return r.type === 'witness.checkpoint/1' && await verifySigned(r);
}

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

const originalFetch = globalThis.fetch;
const FAC_PAYMENT = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xb445t3' } }));
const SETTLED_TX = '0x' + 'a7'.repeat(32);
function mockFacilitator(): void {
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
		const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (url.includes('cdp.coinbase.com') && url.includes('/verify')) return j({ isValid: true });
		if (url.includes('cdp.coinbase.com') && url.includes('/settle')) return j({ success: true, txHash: SETTLED_TX });
		return originalFetch(input as RequestInfo, init);
	};
}

async function paidCheckpoint(): Promise<{ kid: string; body: Record<string, unknown> & Record<string, string>; att: Record<string, string> }> {
	const cp = await newCheckpoint();
	const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT });
	expect(res.status).toBe(201);
	const body = await res.json() as Record<string, unknown> & Record<string, string>;
	return { kid: cp.kid, body, att: body.payment_attestation as unknown as Record<string, string> };
}
function receiptOf(body: Record<string, unknown>): Record<string, string> {
	const { payment: _p, payment_attestation: _a, ...receipt } = body;
	return receipt as Record<string, string>;
}

beforeEach(async () => {
	clearWitnessSchemaCache();
	clearApiKeyCache();
	await call(`${PATH}?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
	await env.WITNESS_DB!.prepare('DELETE FROM witness_usage').run();
	const keys = await (await call('/v5/keys')).json() as { keys: { key_id: string; public_key: string }[] };
	publicKey = fromHex(keys.keys.find((k) => k.key_id === env.PUBLIC_KEY_ID)!.public_key);
	mockFacilitator();
});
afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers(); });

describe('B-445 T3: the payment attestation', () => {
	it('verifies with the published key and binds the exact receipt bytes and the checkpoint id', async () => {
		const { body, att } = await paidCheckpoint();
		expect(att).toBeTruthy();
		expect(Object.keys(att).sort()).toEqual([...ATTESTATION_FIELDS, 'signature'].sort());
		expect(await verifyAttestation(att)).toBe(true);
		const receipt = receiptOf(body);
		expect(att.receipt_sha256).toBe(`sha256:${await sha256Hex(sortedJson(receipt))}`);
		expect(att.checkpoint_id).toBe(await checkpointIdOf(receipt));
		expect(att).toMatchObject({ resource: 'checkpoint', amount_units: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', network: 'base', transaction: SETTLED_TX, settlement: 'settled', public_key_id: env.PUBLIC_KEY_ID });
		// One example, for the report.
		console.log('B445T3_EXAMPLE_ATTESTATION', JSON.stringify(att));
		console.log('B445T3_EXAMPLE_RECEIPT', JSON.stringify(receipt));
	});

	it('changing any bound field breaks verification', async () => {
		const { att } = await paidCheckpoint();
		for (const f of ATTESTATION_FIELDS) {
			const changed = { ...att, [f]: att[f] + 'x' };
			expect({ field: f, verifies: await verifySigned(changed) }).toEqual({ field: f, verifies: false });
		}
	});

	it('a checkpoint receipt and an attestation never verify as each other', async () => {
		const { body, att } = await paidCheckpoint();
		const receipt = receiptOf(body);
		expect(await verifyReceipt(receipt)).toBe(true);
		expect(await verifyAttestation(receipt)).toBe(false);
		expect(await verifyReceipt(att)).toBe(false);
		// Relabelled, each fails its own signature: the type is in the signed bytes.
		expect(await verifySigned({ ...att, type: 'witness.checkpoint/1' })).toBe(false);
		expect(await verifySigned({ ...receipt, type: 'witness-payment-attestation/0.1' })).toBe(false);
		// Each signature over the other's bytes fails.
		expect(await verifySigned({ ...receipt, signature: att.signature })).toBe(false);
		expect(await verifySigned({ ...att, signature: receipt.signature })).toBe(false);
	});

	it('GET /v1/witness/checkpoints/{id}/payment returns the same attestation; free and keyed checkpoints have none (404)', async () => {
		const { att } = await paidCheckpoint();
		const res = await call(`${PATH}/${att.checkpoint_id}/payment`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ checkpoint_id: att.checkpoint_id, settlement: 'settled', attestation: att });

		const free = await newCheckpoint();
		const fr = await post(free.body, V06);
		expect(fr.status).toBe(201);
		const freeReceipt = await fr.json() as Record<string, string>;
		expect(freeReceipt.payment_attestation).toBeUndefined();
		const fget = await call(`${PATH}/${await checkpointIdOf(freeReceipt)}/payment`);
		expect(fget.status).toBe(404);
		expect(await fget.json()).toMatchObject({ error: 'no_payment' });

		const key = 'ho_live_' + 'f'.repeat(64);
		await env.ORACLE_API_KEYS.put(await sha256Hex(key), JSON.stringify({ plan: 'evidence', status: 'active' }));
		const keyed = await newCheckpoint();
		const kr = await post(keyed.body, { Authorization: `Bearer ${key}`, ...V06, 'X-Payment': FAC_PAYMENT });
		expect(kr.status).toBe(201);
		const keyedReceipt = await kr.json() as Record<string, string>;
		expect(keyedReceipt.payment_attestation).toBeUndefined();
		expect((await call(`${PATH}/${await checkpointIdOf(keyedReceipt)}/payment`)).status).toBe(404);

		expect((await call(`${PATH}/not-an-id/payment`)).status).toBe(400);
	});

	it('the 0.5 receipt bytes are unchanged: a paid receipt has exactly the receipt fields and verifies over them', async () => {
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT });
		expect(res.status).toBe(201);
		const body = await res.json() as Record<string, unknown>;
		const receipt = receiptOf(body);
		expect(Object.keys(receipt).sort()).toEqual([...RECEIPT_FIELDS, 'signature'].sort());
		expect(await verifyReceipt(receipt)).toBe(true);
		// The stored receipt, as GET lists it, is the same bytes with no payment members.
		const list = await (await call(`${PATH}?kid=${receipt.kid}&session_id=${receipt.session_id}`)).json() as { receipts: Record<string, string>[] };
		expect(list.receipts).toEqual([receipt]);
		// A 0.5 repeat (no header) sees the receipt alone, byte for byte.
		const repeat = await post(cp.body, {});
		expect(repeat.status).toBe(200);
		expect(await repeat.text()).toBe(JSON.stringify(receipt));
	});
});

describe('B-445 T3: stuck rows finish themselves', () => {
	it('a row left pending (the row update failed) answers 202, then the scheduled sweep completes it with the attestation already issued', async () => {
		const cp = await newCheckpoint();
		const res = await post(cp.body, { ...V06, 'X-Payment': FAC_PAYMENT }, { ...baseEnv, WITNESS_DB: failingDb(/^\s*UPDATE witness_checkpoints SET payment_json/) });
		expect(res.status).toBe(201);
		const issued = (await res.json() as { payment_attestation: Record<string, string> }).payment_attestation;
		const id = issued.checkpoint_id;
		const before = await env.WITNESS_DB!.prepare('SELECT payment_json FROM witness_checkpoints WHERE kid = ?').bind(cp.kid).first<{ payment_json: string }>();
		expect(JSON.parse(before!.payment_json).settlement).toBe('pending');
		const pendingGet = await call(`${PATH}/${id}/payment`);
		expect(pendingGet.status).toBe(202);
		expect(await pendingGet.json()).toMatchObject({ checkpoint_id: id, settlement: 'pending', attestation: null });

		// The scheduled run: the minute cron at minute 7, ten minutes later.
		const later = new Date(Date.now() + 10 * 60 * 1000);
		later.setUTCMinutes(7, 0, 0);
		if (later.getTime() < Date.now() + 6 * 60 * 1000) later.setUTCHours(later.getUTCHours() + 1);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(later);
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: '* * * * *', scheduledTime: later.getTime(), type: 'scheduled', noRetry: () => {} } as unknown as ScheduledController, env, ctx);
		await waitOnExecutionContext(ctx);
		vi.useRealTimers();

		const after = await env.WITNESS_DB!.prepare('SELECT payment_json FROM witness_checkpoints WHERE kid = ?').bind(cp.kid).first<{ payment_json: string }>();
		const p = JSON.parse(after!.payment_json) as Record<string, unknown>;
		expect(p).toMatchObject({ settlement: 'settled', transaction: SETTLED_TX, completed_by: 'sweep' });
		expect(p.attestation).toEqual(issued);
		const got = await call(`${PATH}/${id}/payment`);
		expect(got.status).toBe(200);
		expect((await got.json() as { attestation: Record<string, string> }).attestation).toEqual(issued);
		expect(await verifyAttestation(issued)).toBe(true);
	});
});

describe('B-445 T3: alarms on the record path', () => {
	async function seedRecord(): Promise<void> {
		clearHoRecordSchemaCache();
		await ensureHoRecordSchema(env as never);
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_record_proofs').run();
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_records').run();
		await env.HALT_ARCHIVE!.prepare('INSERT INTO ho_records (date, sequence, record_json, record_sha256, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind('2026-11-01', 1, '{"late":false}', 'sha256:' + '0'.repeat(64), 'sha256:' + '1'.repeat(64), new Date().toISOString()).run();
	}
	async function recordFailedSteps(): Promise<Array<{ step: string; message: string }>> {
		const idx = await (await call('/record', { headers: { Accept: 'application/json' } })).json() as { failed_steps: Array<{ step: string; message: string }> };
		return idx.failed_steps;
	}
	async function sweep(now?: Date): Promise<unknown> {
		const mod = await import('../src') as unknown as { runWitnessPaymentSweep?: (e: unknown, n?: Date) => Promise<unknown> };
		expect(typeof mod.runWitnessPaymentSweep, 'runWitnessPaymentSweep is exported').toBe('function');
		return mod.runWitnessPaymentSweep!(env, now);
	}

	it('a paid row pending over an hour names the failed step witness_payments; metrics show the count; it clears once resolved', async () => {
		await seedRecord();
		await env.ORACLE_TELEMETRY.delete('witness_payment_health');
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		const payment = { resource: 'checkpoint', amount_units: '1000', settlement: 'pending', checkpoint_id: 'c'.repeat(64), path: 'cdp_facilitator' };
		await env.WITNESS_DB!.prepare(`INSERT INTO witness_checkpoints (kid, session_id, count, last_entry_hash, checkpoint_jcs, checkpoint_sha256, public_key_x, received_at, fork, receipt_json, created_at, payment_json)
			VALUES ('k1', 's', 1, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', ?, ?)`).bind(old, old, JSON.stringify(payment)).run();
		expect(await recordFailedSteps()).toEqual([]);
		await sweep();
		const steps = await recordFailedSteps();
		expect(steps.map((s) => s.step)).toEqual(['witness_payments']);
		expect(steps[0].message).toContain('pending_over_1h=1');
		const m = await (await call('/v5/metrics/public')).json() as { witness_payments: Record<string, unknown> };
		expect(m.witness_payments).toMatchObject({ pending_over_1h: 1, unstored_unconsumed: 0 });

		await env.WITNESS_DB!.prepare(`UPDATE witness_checkpoints SET payment_json = ? WHERE kid = 'k1'`).bind(JSON.stringify({ ...payment, settlement: 'failed' })).run();
		await sweep();
		expect(await recordFailedSteps()).toEqual([]);
	});

	it('an unconsumed witness_unstored_payment record names the failed step; a consumed one does not', async () => {
		await seedRecord();
		const k = `witness_unstored_payment:0x${'9'.repeat(64)}`;
		await env.ORACLE_TELEMETRY.put(k, '{"identity":"x"}', { metadata: { consumed: false } });
		await sweep();
		const steps = await recordFailedSteps();
		expect(steps.map((s) => s.step)).toEqual(['witness_payments']);
		expect(steps[0].message).toContain('unstored_unconsumed=1');
		const m = await (await call('/v5/metrics/public')).json() as { witness_payments: Record<string, unknown> };
		expect(m.witness_payments).toMatchObject({ pending_over_1h: 0, unstored_unconsumed: 1 });
		await env.ORACLE_TELEMETRY.put(k, '{"identity":"x","consumed_at":"now"}', { metadata: { consumed: true } });
		await sweep();
		expect(await recordFailedSteps()).toEqual([]);
		await env.ORACLE_TELEMETRY.delete(k);
	});

	it('/v5/metrics/public says null, not 0, before the sweep has ever run', async () => {
		await env.ORACLE_TELEMETRY.delete('witness_payment_health');
		const m = await (await call('/v5/metrics/public')).json() as { witness_payments?: Record<string, unknown> };
		expect(m.witness_payments).toMatchObject({ pending_over_1h: null, unstored_unconsumed: null, computed_at: null });
	});
});
