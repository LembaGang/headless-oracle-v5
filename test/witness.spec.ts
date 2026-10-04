import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, {
	clearWitnessSchemaCache, witnessJcs, witnessClientKey, readWitnessBody,
	witnessSql, ensureWitnessSchema, clearApiKeyCache,
} from '../src';

const { usageUpsert: WITNESS_USAGE_UPSERT_SQL, page: WITNESS_PAGE_SQL } = witnessSql();

// Chirindo witness, wire spec v0.4 (CC_HANDOFF_2026-10-03_hov5-witness-endpoint_rev3,
// amended by CC_HANDOFF_2026-10-03_hov5-witness-amendment_rev1).
// Checkpoints are built here the way chirindo builds them: Ed25519 over the JCS
// bytes of the checkpoint without sig, sig as base64url without padding, kid the
// RFC 7638 thumbprint. The worker's own helpers are deliberately not used to
// build them, so the two can disagree.

const PATH = '/v1/witness/checkpoints';

function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
}
function sortedJson(o: Record<string, unknown>): string {
	const s: Record<string, unknown> = {};
	for (const k of Object.keys(o).sort()) s[k] = o[k];
	return JSON.stringify(s);
}
async function sha256Hex(s: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
async function thumbprint(x: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`));
	return b64u(new Uint8Array(d));
}

interface Identity { sk: Uint8Array; x: string; kid: string }
async function makeIdentity(seed?: Uint8Array): Promise<Identity> {
	const sk = seed ?? ed.utils.randomSecretKey();
	const x = b64u(await ed.getPublicKeyAsync(sk));
	return { sk, x, kid: await thumbprint(x) };
}

function hash(c: string): string {
	return 'sha256:' + c.repeat(64).slice(0, 64);
}

async function makeCheckpoint(id: Identity, opts: { session_id?: string; count?: number; last_entry_hash?: string; ts?: string } = {}) {
	const unsigned = {
		v: 'evidence.action/1',
		type: 'checkpoint',
		session_id: opts.session_id ?? 'test-session',
		count: opts.count ?? 1,
		last_entry_hash: opts.last_entry_hash ?? hash('a'),
		ts: opts.ts ?? '2026-10-03T00:00:01.000Z',
		kid: id.kid,
	};
	const sig = await ed.signAsync(new TextEncoder().encode(sortedJson(unsigned)), id.sk);
	return { ...unsigned, sig: b64u(sig) };
}

function bodyFor(checkpoint: unknown, jwk: unknown) {
	return JSON.stringify({ checkpoint, public_key_jwk: jwk });
}
function jwkFor(id: Identity) {
	return { kty: 'OKP', crv: 'Ed25519', x: id.x };
}

// The rate-limit bindings are stubbed: miniflare keeps the real binding's counts
// in memory across tests, so a test that used it would depend on test order.
// Tests that script a limit pass their own env.
type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const testEnv: Record<string, unknown> = { ...(env as unknown as Record<string, unknown>), WITNESS_POST_RL: allow, WITNESS_GET_RL: allow, WITNESS_ACCT_RL: allow };

async function call(path: string, init: RequestInit = {}, e: Record<string, unknown> = testEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init), e as unknown as typeof env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
function post(body: string, headers: Record<string, string> = {}, e?: Record<string, unknown>): Promise<Response> {
	return call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }, e);
}
async function postCheckpoint(id: Identity, cp: unknown, headers: Record<string, string> = {}) {
	const res = await post(bodyFor(cp, jwkFor(id)), headers);
	return { status: res.status, body: await res.json() as Record<string, string> };
}
async function list(kid: string, session: string, after?: string) {
	const q = new URLSearchParams({ kid, session_id: session });
	if (after !== undefined) q.set('after', after);
	const res = await call(`${PATH}?${q}`);
	return { status: res.status, body: await res.json() as { receipts: Record<string, string>[]; next_after?: string; error?: string } };
}

async function workerPublicKey(keyId: string): Promise<Uint8Array> {
	const keys = await (await call('/v5/keys')).json() as { keys: { key_id: string; public_key: string }[] };
	const entry = keys.keys.find((k) => k.key_id === keyId);
	expect(entry, `no /v5/keys entry for ${keyId}`).toBeTruthy();
	return fromHex(entry!.public_key);
}
async function receiptVerifies(receipt: Record<string, string>): Promise<boolean> {
	const { signature, ...signed } = receipt;
	const pub = await workerPublicKey(receipt.public_key_id);
	return ed.verifyAsync(fromHex(signature), new TextEncoder().encode(sortedJson(signed)), pub);
}

async function seedRows(sql: string, ...binds: unknown[]): Promise<void> {
	await env.WITNESS_DB!.prepare(sql).bind(...binds).run();
}
const SEED_COLUMNS = 'kid, session_id, count, last_entry_hash, checkpoint_jcs, checkpoint_sha256, public_key_x, received_at, fork, receipt_json, created_at';
// Since v0.5 the cap reads witness_usage, so a test reaches the cap by setting
// that day's counter rather than by storing rows.
async function setUsage(pool: string, n: number, day = new Date().toISOString().slice(0, 10)): Promise<void> {
	await seedRows('INSERT INTO witness_usage (day, pool, n) VALUES (?, ?, ?) ON CONFLICT (day, pool) DO UPDATE SET n = excluded.n', day, pool, n);
}
async function usage(pool: string, day = new Date().toISOString().slice(0, 10)): Promise<number | null> {
	const row = await env.WITNESS_DB!.prepare('SELECT n FROM witness_usage WHERE day = ? AND pool = ?').bind(day, pool).first<{ n: number }>();
	return row ? row.n : null;
}

beforeEach(async () => {
	vi.useRealTimers();
	clearWitnessSchemaCache();
	clearApiKeyCache();
	// Make sure the tables exist, then empty them. The application never
	// deletes; only the test harness does, to start each case clean.
	await call(`${PATH}?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
	await env.WITNESS_DB!.prepare('DELETE FROM witness_usage').run();
});
afterEach(() => {
	vi.useRealTimers();
});

// ─── Cross-check vector (chirindo e329846) ───────────────────────────────────
describe('witness: chirindo cross-check vector', () => {
	const JWK = { kty: 'OKP', crv: 'Ed25519', x: '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw' };
	const CHECKPOINT = {
		v: 'evidence.action/1', type: 'checkpoint', session_id: 'vector-session-0001', count: 2,
		last_entry_hash: 'sha256:617ab9472b1751846eb98d3ebba5c20c521ba21e993d7355c6c4036b44745551',
		ts: '2026-10-03T00:00:01.000Z', kid: '--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck',
		sig: 'hILLf_PxlazH-APONGgvd2_0Bc98tPw51ai2n3MGk_3p0W8OD_fMzgzJJ8ePgFje-MbTzWAqNwv8CmaviIRaAA',
	};
	const EXPECTED_BYTES = '{"count":2,"kid":"--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck","last_entry_hash":"sha256:617ab9472b1751846eb98d3ebba5c20c521ba21e993d7355c6c4036b44745551","session_id":"vector-session-0001","ts":"2026-10-03T00:00:01.000Z","type":"checkpoint","v":"evidence.action/1"}';
	const EXPECTED_THUMBPRINT = '--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck';
	const EXPECTED_CHECKPOINT_SHA256 = 'sha256:684b932358eb8733a11ef4d168c02874b49393face41bd0ed407285aefbfb794';

	it('the worker canonicalises the checkpoint to the expected bytes, and the thumbprint matches', async () => {
		const { sig: _sig, ...unsigned } = CHECKPOINT;
		expect(witnessJcs(unsigned)).toBe(EXPECTED_BYTES);
		expect(await thumbprint(JWK.x)).toBe(EXPECTED_THUMBPRINT);
		// The vector's key is the 0x07 seed, so the JWK is reproducible here.
		expect((await makeIdentity(new Uint8Array(32).fill(7))).x).toBe(JWK.x);
	});

	it('POST returns 201 and the receipt carries the expected checkpoint_sha256', async () => {
		const res = await post(bodyFor(CHECKPOINT, JWK));
		expect(res.status).toBe(201);
		const receipt = await res.json() as Record<string, string>;
		expect(receipt.checkpoint_sha256).toBe(EXPECTED_CHECKPOINT_SHA256);
		expect(receipt.kid).toBe(EXPECTED_THUMBPRINT);
		expect(receipt.count).toBe('2');
		expect(await receiptVerifies(receipt)).toBe(true);
	});

	it('the same checkpoint with a hex sig is rejected', async () => {
		const sigBytes = Uint8Array.from(atob(CHECKPOINT.sig.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
		const res = await post(bodyFor({ ...CHECKPOINT, sig: hex(sigBytes) }, JWK));
		expect(res.status).toBe(400);
		expect((await res.json() as Record<string, string>).error).toBe('bad_checkpoint_field');
	});
});

// ─── Happy path, idempotency, forks ──────────────────────────────────────────
describe('witness: POST /v1/witness/checkpoints', () => {
	it('a valid checkpoint returns 201 with a receipt that verifies against the worker key', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id, { count: 3, last_entry_hash: hash('c') });
		const { status, body } = await postCheckpoint(id, cp);
		expect(status).toBe(201);
		expect(body).toMatchObject({
			type: 'witness.checkpoint/1', witness: 'headlessoracle.com', kid: id.kid, session_id: 'test-session',
			count: '3', last_entry_hash: hash('c'), checkpoint_ts: cp.ts, fork: 'false', public_key_id: env.PUBLIC_KEY_ID,
		});
		expect(Object.keys(body).sort()).toEqual([
			'checkpoint_sha256', 'checkpoint_ts', 'count', 'fork', 'kid', 'last_entry_hash',
			'public_key_id', 'received_at', 'session_id', 'signature', 'type', 'witness',
		]);
		for (const v of Object.values(body)) expect(typeof v).toBe('string');
		expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
		expect(new Date(body.received_at).toISOString()).toBe(body.received_at);
		expect(body.checkpoint_sha256).toBe(`sha256:${await sha256Hex(sortedJson(cp))}`);
		expect(await receiptVerifies(body)).toBe(true);
		// Control: one changed signed field must break the receipt signature.
		expect(await receiptVerifies({ ...body, fork: 'true' })).toBe(false);
	});

	it('the stored row keeps the checkpoint JCS, its digest and the exact receipt', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id);
		const { body } = await postCheckpoint(id, cp);
		const row = await env.WITNESS_DB!.prepare('SELECT * FROM witness_checkpoints').first<Record<string, unknown>>();
		expect(row!.checkpoint_jcs).toBe(sortedJson(cp));
		expect(row!.checkpoint_sha256).toBe(body.checkpoint_sha256);
		expect(row!.public_key_x).toBe(id.x);
		expect(row!.fork).toBe('false');
		expect(JSON.parse(row!.receipt_json as string)).toEqual(body);
	});

	it('an identical repost returns 200 with the same receipt', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id);
		const first = await postCheckpoint(id, cp);
		const second = await postCheckpoint(id, cp);
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
	});

	it('the same identity with a different ts and a fresh sig returns 200 and the ORIGINAL receipt', async () => {
		const id = await makeIdentity();
		const first = await postCheckpoint(id, await makeCheckpoint(id, { ts: '2026-10-03T00:00:01.000Z' }));
		const again = await makeCheckpoint(id, { ts: '2026-10-03T05:00:00.000Z' });
		const second = await postCheckpoint(id, again);
		expect(first.status).toBe(201);
		expect(second.status).toBe(200);
		expect(second.body).toEqual(first.body);
		expect(second.body.checkpoint_ts).toBe('2026-10-03T00:00:01.000Z');
		const { c } = (await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints').first<{ c: number }>())!;
		expect(c).toBe(1);
	});

	it('same count with a different hash is a fork: fork "true", and GET lists both', async () => {
		const id = await makeIdentity();
		const a = await postCheckpoint(id, await makeCheckpoint(id, { count: 5, last_entry_hash: hash('a') }));
		const b = await postCheckpoint(id, await makeCheckpoint(id, { count: 5, last_entry_hash: hash('b') }));
		expect(a.status).toBe(201);
		expect(a.body.fork).toBe('false');
		expect(b.status).toBe(201);
		expect(b.body.fork).toBe('true');
		const { status, body } = await list(id.kid, 'test-session');
		expect(status).toBe(200);
		expect(body.receipts.map((r) => [r.count, r.last_entry_hash, r.fork])).toEqual([
			['5', hash('a'), 'false'],
			['5', hash('b'), 'true'],
		]);
	});

	it('concurrent identical POSTs return one 201 and one 200 with the same receipt', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id);
		const [r1, r2] = await Promise.all([post(bodyFor(cp, jwkFor(id))), post(bodyFor(cp, jwkFor(id)))]);
		expect([r1.status, r2.status].sort()).toEqual([200, 201]);
		expect(await r1.json()).toEqual(await r2.json());
		const { c } = (await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints').first<{ c: number }>())!;
		expect(c).toBe(1);
	});
});

// ─── Each error code, in spec order ──────────────────────────────────────────
// Each case also breaks every LATER check, so a check run out of order
// returns the wrong code.
describe('witness: checks run in spec order, failing closed with 400', () => {
	async function errorOf(res: Response): Promise<string> {
		expect(res.status).toBe(400);
		return (await res.json() as Record<string, string>).error;
	}

	it('1 bad_request: a third top-level member', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id);
		expect(await errorOf(await post(JSON.stringify({ checkpoint: { ...cp, extra: 1 }, public_key_jwk: { kty: 'RSA' }, extra: true })))).toBe('bad_request');
	});

	it('1 bad_request: the body is not JSON', async () => {
		expect(await errorOf(await post('{"checkpoint":'))).toBe('bad_request');
	});

	it('1 bad_request: Content-Type not starting with application/json', async () => {
		const id = await makeIdentity();
		const res = await call(PATH, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bodyFor(await makeCheckpoint(id), jwkFor(id)) });
		expect(await errorOf(res)).toBe('bad_request');
	});

	it('1 bad_request: a body over 4096 bytes, even when it is otherwise a valid submission', async () => {
		const id = await makeIdentity();
		const valid = bodyFor(await makeCheckpoint(id), jwkFor(id));
		const padded = valid + ' '.repeat(4097 - new TextEncoder().encode(valid).length);
		expect(new TextEncoder().encode(padded).length).toBe(4097);
		expect(await errorOf(await post(padded))).toBe('bad_request');
		// Control: the same submission at 4096 bytes is accepted.
		const fits = valid + ' '.repeat(4096 - new TextEncoder().encode(valid).length);
		expect((await post(fits)).status).toBe(201);
	});

	it('2 bad_checkpoint_shape: a missing member (and a bad jwk)', async () => {
		const id = await makeIdentity();
		const { ts: _ts, ...noTs } = await makeCheckpoint(id);
		expect(await errorOf(await post(bodyFor(noTs, { kty: 'RSA' })))).toBe('bad_checkpoint_shape');
	});

	it('3 bad_checkpoint_field: count 0 (and a bad jwk)', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id, { count: 0 });
		expect(await errorOf(await post(bodyFor(cp, { kty: 'RSA' })))).toBe('bad_checkpoint_field');
	});

	it('3 bad_checkpoint_field: a legacy ed25519/ kid', async () => {
		const id = await makeIdentity();
		const cp = { ...(await makeCheckpoint(id)), kid: `ed25519/${id.kid}` };
		expect(await errorOf(await post(bodyFor(cp, jwkFor(id))))).toBe('bad_checkpoint_field');
	});

	it('4 bad_jwk: wrong crv (and a mismatched kid)', async () => {
		const id = await makeIdentity();
		const other = await makeIdentity();
		expect(await errorOf(await post(bodyFor(await makeCheckpoint(id), { kty: 'OKP', crv: 'X25519', x: other.x })))).toBe('bad_jwk');
	});

	it('4 bad_jwk: an extra member in public_key_jwk', async () => {
		const id = await makeIdentity();
		expect(await errorOf(await post(bodyFor(await makeCheckpoint(id), { ...jwkFor(id), kid: id.kid })))).toBe('bad_jwk');
	});

	it('4 bad_jwk: an x that does not re-encode to itself', async () => {
		const id = await makeIdentity();
		// The last char of a 43-char key carries 2 unused bits; flipping one
		// decodes to the same 32 bytes but is not the canonical encoding.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
		const last = alphabet.indexOf(id.x[42]);
		const x = id.x.slice(0, 42) + alphabet[last ^ 1];
		expect(await errorOf(await post(bodyFor(await makeCheckpoint(id), { kty: 'OKP', crv: 'Ed25519', x })))).toBe('bad_jwk');
	});

	it('5 kid_mismatch: the jwk is another key (whose own signature would also fail)', async () => {
		const id = await makeIdentity();
		const other = await makeIdentity();
		expect(await errorOf(await post(bodyFor(await makeCheckpoint(id), jwkFor(other))))).toBe('kid_mismatch');
	});

	it('6 bad_signature: a signature over different bytes', async () => {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id, { count: 1 });
		const forged = { ...cp, count: 2 };
		expect(await errorOf(await post(bodyFor(forged, jwkFor(id))))).toBe('bad_signature');
	});

	it('6 bad_signature: a small-order public key with a matching kid', async () => {
		// The identity point (y = 1). zip215 accepts signatures under it; strict
		// RFC 8032 verification must not.
		const smallOrder = new Uint8Array(32);
		smallOrder[0] = 1;
		const x = b64u(smallOrder);
		const kid = await thumbprint(x);
		// R = identity, S = 0 satisfies the cofactored equation for this key.
		const sig = new Uint8Array(64);
		sig[0] = 1;
		const unsigned = { v: 'evidence.action/1', type: 'checkpoint', session_id: 's', count: 1, last_entry_hash: hash('a'), ts: '2026-10-03T00:00:00Z', kid };
		expect(await ed.verifyAsync(sig, new TextEncoder().encode(sortedJson(unsigned)), smallOrder, { zip215: true })).toBe(true);
		const res = await post(bodyFor({ ...unsigned, sig: b64u(sig) }, { kty: 'OKP', crv: 'Ed25519', x }));
		expect(await errorOf(res)).toBe('bad_signature');
	});

	it('a rejected submission stores nothing', async () => {
		const id = await makeIdentity();
		await post(bodyFor({ ...(await makeCheckpoint(id)), count: 9 }, jwkFor(id)));
		const { c } = (await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints').first<{ c: number }>())!;
		expect(c).toBe(0);
	});
});

// ─── GET ─────────────────────────────────────────────────────────────────────
describe('witness: GET /v1/witness/checkpoints', () => {
	it('orders receipts by (count, last_entry_hash) and returns an unknown pair as empty', async () => {
		const id = await makeIdentity();
		for (const [count, h] of [[3, 'b'], [1, 'c'], [3, 'a'], [2, 'f']] as const) {
			expect((await postCheckpoint(id, await makeCheckpoint(id, { count, last_entry_hash: hash(h) }))).status).toBe(201);
		}
		const { status, body } = await list(id.kid, 'test-session');
		expect(status).toBe(200);
		expect(body.receipts.map((r) => `${r.count}:${r.last_entry_hash.slice(7, 8)}`)).toEqual(['1:c', '2:f', '3:a', '3:b']);
		expect(body.next_after).toBeUndefined();
		const after = await list(id.kid, 'test-session', `2:${hash('f')}`);
		expect(after.body.receipts.map((r) => r.count)).toEqual(['3', '3']);
		const unknown = await list(id.kid, 'another-session');
		expect(unknown.status).toBe(200);
		expect(unknown.body.receipts).toEqual([]);
	});

	it('a 501-row session whose two rows at one count straddle the page boundary returns both across two pages', async () => {
		const kid = 'K'.repeat(43);
		const now = new Date().toISOString();
		// 499 rows at counts 1..499, then two rows at count 500: rows 500 and 501.
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT ?, 'paged', i, ?, '{}', 'sha256:x', 'x', ?, 'false',
			        json_object('count', CAST(i AS TEXT), 'last_entry_hash', ?), ? FROM n`,
			kid, hash('0'), now, hash('0'), now,
		);
		for (const h of ['a', 'b']) {
			await seedRows(
				`INSERT INTO witness_checkpoints (${SEED_COLUMNS}) VALUES (?, 'paged', 500, ?, '{}', 'sha256:x', 'x', ?, 'false', ?, ?)`,
				kid, hash(h), now, JSON.stringify({ count: '500', last_entry_hash: hash(h) }), now,
			);
		}
		const page1 = await list(kid, 'paged');
		expect(page1.status).toBe(200);
		expect(page1.body.receipts.length).toBe(500);
		expect(page1.body.receipts[499]).toEqual({ count: '500', last_entry_hash: hash('a') });
		expect(page1.body.next_after).toBe(`500:${hash('a')}`);
		const page2 = await list(kid, 'paged', page1.body.next_after);
		expect(page2.body.receipts).toEqual([{ count: '500', last_entry_hash: hash('b') }]);
		expect(page2.body.next_after).toBeUndefined();
	});

	it('a missing parameter is 400 bad_request', async () => {
		for (const q of [`kid=${'A'.repeat(43)}`, 'session_id=s', '']) {
			const res = await call(`${PATH}?${q}`);
			expect(res.status, q).toBe(400);
			expect((await res.json() as Record<string, string>).error).toBe('bad_request');
		}
	});

	it('a malformed after, a bad kid or an over-long session_id is 400 bad_request', async () => {
		const kid = 'A'.repeat(43);
		for (const q of [
			`kid=${kid}&session_id=s&after=1`,
			`kid=${kid}&session_id=s&after=1:sha256:abc`,
			`kid=${kid}&session_id=s&after=-1:${hash('a')}`,
			`kid=${kid}&session_id=s&after=99999999999999999999:${hash('a')}`,
			`kid=short&session_id=s`,
			`kid=${kid}&session_id=${'s'.repeat(129)}`,
		]) {
			const res = await call(`${PATH}?${q}`);
			expect(res.status, q).toBe(400);
			expect((await res.json() as Record<string, string>).error).toBe('bad_request');
		}
		// Control: a well-formed after is accepted.
		expect((await call(`${PATH}?kid=${kid}&session_id=s&after=0:${hash('a')}`)).status).toBe(200);
	});

	it('is public with CORS *', async () => {
		const res = await call(`${PATH}?kid=${'A'.repeat(43)}&session_id=s`);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});

// ─── Store unavailable and the daily cap ─────────────────────────────────────
describe('witness: fail closed when the store is unavailable', () => {
	it('POST and GET with WITNESS_DB unbound return 503 witness_unavailable', async () => {
		const id = await makeIdentity();
		const unbound = { ...testEnv, WITNESS_DB: undefined };
		const p = await post(bodyFor(await makeCheckpoint(id), jwkFor(id)), {}, unbound);
		expect(p.status).toBe(503);
		expect(await p.json()).toEqual({ error: 'witness_unavailable' });
		const g = await call(`${PATH}?kid=${id.kid}&session_id=test-session`, {}, unbound);
		expect(g.status).toBe(503);
		expect(await g.json()).toEqual({ error: 'witness_unavailable' });
	});

	it('the witness does not use HALT_ARCHIVE: unbinding it changes nothing', async () => {
		const id = await makeIdentity();
		const noHalt = { ...testEnv, HALT_ARCHIVE: undefined };
		const p = await post(bodyFor(await makeCheckpoint(id), jwkFor(id)), {}, noHalt);
		expect(p.status).toBe(201);
		const g = await call(`${PATH}?kid=${id.kid}&session_id=test-session`, {}, noHalt);
		expect(g.status).toBe(200);
		expect(((await g.json()) as { receipts: unknown[] }).receipts.length).toBe(1);
	});

	it('one row below the cap a new checkpoint is still stored', async () => {
		const id = await makeIdentity();
		// CHANGED (H1b B4): the cap reads witness_usage; 1,999 counted today.
		await setUsage('anon', 1999);
		expect((await post(bodyFor(await makeCheckpoint(id), jwkFor(id)))).status).toBe(201);
		expect((await post(bodyFor(await makeCheckpoint(id, { count: 2 }), jwkFor(id)))).status).toBe(503);
	});

	it('the daily cap blocks new rows with 503 but still answers a repeat with its stored receipt', async () => {
		const id = await makeIdentity();
		const firstCp = await makeCheckpoint(id, { count: 1 });
		const first = await postCheckpoint(id, firstCp);
		expect(first.status).toBe(201);
		// One stored today (counted). CHANGED (H1b B4): the counter is set to
		// the 2,000 cap instead of seeding 1,999 rows.
		expect(await usage('anon')).toBe(1);
		await setUsage('anon', 2000);
		const blocked = await post(bodyFor(await makeCheckpoint(id, { count: 2 }), jwkFor(id)));
		expect(blocked.status).toBe(503);
		expect(await blocked.json()).toEqual({ error: 'witness_unavailable' });
		const repeat = await postCheckpoint(id, firstCp);
		expect(repeat.status).toBe(200);
		expect(repeat.body).toEqual(first.body);
	});

	// W3 HIGH: received_at and the cap's day were taken at request start. A client
	// that held its body open stored an old received_at under the newest rowid,
	// and the max(rowid) day count then saw about one row, resetting the cap.
	// CHANGED (H1b B4): the count is witness_usage, so 1,999 is set on the
	// counter while the body is held, not seeded as rows.
	it('a POST whose body is held open stores a received_at taken after the body arrived, and the cap still holds', async () => {
		const id = await makeIdentity();
		const bytes = new TextEncoder().encode(bodyFor(await makeCheckpoint(id, { count: 1 }), jwkFor(id)));
		let ctl!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
		ctl.enqueue(bytes.slice(0, 10));
		const held = call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream });

		// While the body is held, 1,999 rows are counted for the day.
		await new Promise((r) => setTimeout(r, 25));
		const seededAt = new Date().toISOString();
		await setUsage('anon', 1999);
		await new Promise((r) => setTimeout(r, 5));
		ctl.enqueue(bytes.slice(10));
		ctl.close();

		const res = await held;
		expect(res.status).toBe(201);
		const receipt = await res.json() as Record<string, string>;
		expect(receipt.received_at >= seededAt, `received_at ${receipt.received_at} is earlier than the seeded rows (${seededAt})`).toBe(true);
		const row = await env.WITNESS_DB!.prepare('SELECT received_at FROM witness_checkpoints WHERE kid = ?').bind(id.kid).first<{ received_at: string }>();
		expect(row?.received_at).toBe(receipt.received_at);
		expect(await receiptVerifies(receipt)).toBe(true);

		// 2,000 rows today: the next new checkpoint is refused.
		const next = await post(bodyFor(await makeCheckpoint(id, { count: 2 }), jwkFor(id)));
		expect(next.status).toBe(503);
		expect(await next.json()).toEqual({ error: 'witness_unavailable' });
	});
});

// ─── D1 cost: rows_read is bounded (ratification HIGH-1, HIGH-2) ─────────────
// A per-request COUNT or an unbounded cursor scan on an append-only table is a
// cost and availability bug on D1. Each test runs the exact query the worker
// uses (exported from src) and, as a control, the query it replaced, so the
// measurement is shown able to see a full scan.
describe('witness: D1 rows_read stays bounded at 50,000 rows', () => {
	// CHANGED (H1b B4): replaces the max(rowid) day-count test, whose query is
	// gone. The counter is a primary-key upsert: its cost does not grow with n.
	// n = 1 is the insert path (a new day or pool) and n >= 2 the update path, so
	// the cost is compared between n = 2 and n = 10,000 and reported for all three.
	it('the usage upsert reads at most 3 rows, the same at n = 2 and n = 10,000', async () => {
		const day = new Date().toISOString().slice(0, 10);
		// 50,000 stored rows change nothing: the upsert never reads the checkpoint table.
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'seed', 'seed', i, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', '' FROM n`,
			`${day}T00:00:00.000Z`,
		);
		const first = await env.WITNESS_DB!.prepare(WITNESS_USAGE_UPSERT_SQL).bind(day, 'anon').all<{ n: number }>();
		expect(first.results[0].n).toBe(1);
		const second = await env.WITNESS_DB!.prepare(WITNESS_USAGE_UPSERT_SQL).bind(day, 'anon').all<{ n: number }>();
		expect(second.results[0].n).toBe(2);
		await setUsage('anon', 9999, day);
		const big = await env.WITNESS_DB!.prepare(WITNESS_USAGE_UPSERT_SQL).bind(day, 'anon').all<{ n: number }>();
		expect(big.results[0].n).toBe(10_000);
		console.log(`WITNESS_USAGE_UPSERT_COST n=1 rows_read=${first.meta.rows_read} rows_written=${first.meta.rows_written}; n=2 rows_read=${second.meta.rows_read} rows_written=${second.meta.rows_written}; n=10000 rows_read=${big.meta.rows_read} rows_written=${big.meta.rows_written}`);
		for (const m of [first.meta, second.meta, big.meta]) expect(m.rows_read).toBeLessThanOrEqual(3);
		expect(big.meta.rows_read).toBe(second.meta.rows_read);
		expect(big.meta.rows_written).toBe(second.meta.rows_written);
		// Control: counting the day's rows reads every one of them.
		const old = await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints WHERE received_at >= ?').bind(`${day}T00:00:00.000Z`).all<{ c: number }>();
		expect(old.meta.rows_read).toBeGreaterThanOrEqual(50_000);
		// Another day is a separate counter.
		const other = await env.WITNESS_DB!.prepare(WITNESS_USAGE_UPSERT_SQL).bind('2999-01-01', 'anon').all<{ n: number }>();
		expect(other.results[0].n).toBe(1);
	});

	it('a deep after reads no more than the rows returned plus 2', async () => {
		const kid = 'D'.repeat(43);
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT ?, 'deep', i, ?, '{}', 'sha256:x', 'x', '2026-10-03T00:00:00.000Z', 'false',
			        json_object('count', CAST(i AS TEXT)), '' FROM n`,
			kid, hash('0'),
		);
		const res = await env.WITNESS_DB!.prepare(WITNESS_PAGE_SQL).bind(kid, 'deep', 49_990, hash('0'), 501).all<{ count: number }>();
		expect(res.results.map((r) => r.count)).toEqual([49_991, 49_992, 49_993, 49_994, 49_995, 49_996, 49_997, 49_998, 49_999, 50_000]);
		expect(res.meta.rows_read).toBeLessThanOrEqual(res.results.length + 2);
		// Control: the v0.3 OR form scans the session up to the cursor.
		const old = await env.WITNESS_DB!.prepare(
			`SELECT count FROM witness_checkpoints WHERE kid = ? AND session_id = ? AND (count > ? OR (count = ? AND last_entry_hash > ?))
			 ORDER BY count, last_entry_hash LIMIT 501`,
		).bind(kid, 'deep', 49_990, 49_990, hash('0')).all();
		expect(old.results.length).toBe(10);
		expect(old.meta.rows_read).toBeGreaterThan(1_000);
		// The endpoint returns the same ten, with no next_after.
		const page = await list(kid, 'deep', `49990:${hash('0')}`);
		expect(page.body.receipts.map((r) => r.count)).toEqual(['49991', '49992', '49993', '49994', '49995', '49996', '49997', '49998', '49999', '50000']);
		expect(page.body.next_after).toBeUndefined();
	});
});

// ─── Body size: never buffer an oversize body (ratification LOW-2) ───────────
describe('witness: oversize bodies are refused without being buffered', () => {
	// A stream that never ends: 1,000 bytes per pull, counting pulls and cancels.
	function endless() {
		const seen = { pulls: 0, cancelled: false };
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) { seen.pulls++; controller.enqueue(new Uint8Array(1000).fill(0x20)); },
			cancel() { seen.cancelled = true; },
		});
		return { stream, seen };
	}

	it('readWitnessBody stops and cancels as soon as 4097 bytes have arrived', async () => {
		const { stream, seen } = endless();
		const req = new Request('http://example.com/', { method: 'POST', body: stream });
		expect(await readWitnessBody(req)).toBeNull();
		expect(seen.cancelled).toBe(true);
		// 5 pulls deliver 5,000 bytes; one or two more may be queued ahead.
		expect(seen.pulls).toBeLessThanOrEqual(7);
	});

	it('readWitnessBody returns a body of exactly 4096 bytes whole', async () => {
		const bytes = new Uint8Array(4096).fill(0x41);
		const got = await readWitnessBody(new Request('http://example.com/', { method: 'POST', body: bytes }));
		expect(got?.length).toBe(4096);
	});

	it('POST with an endless body is 400 bad_request, not a hang', async () => {
		const { stream, seen } = endless();
		const res = await call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream });
		expect(res.status).toBe(400);
		expect((await res.json() as Record<string, string>).error).toBe('bad_request');
		expect(seen.cancelled).toBe(true);
	});

	it('POST declaring Content-Length over 4096 is 400 bad_request before the body is read', async () => {
		const { stream, seen } = endless();
		const res = await call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '5000' }, body: stream });
		expect(res.status).toBe(400);
		expect((await res.json() as Record<string, string>).error).toBe('bad_request');
		expect(seen.cancelled).toBe(false);
		expect(seen.pulls).toBeLessThanOrEqual(1);
	});
});

// ─── Rate limit ──────────────────────────────────────────────────────────────
// Workers Rate Limiting bindings, stubbed: each stub counts per key and records
// every key it was asked about, so the 61st call is scripted, not timed.
describe('witness: rate limit keyed on CF-Connecting-IP', () => {
	function counting(limit = 60) {
		const keys: string[] = [];
		const counts = new Map<string, number>();
		const limiter: Limiter = {
			limit: async ({ key }) => {
				keys.push(key);
				const n = (counts.get(key) ?? 0) + 1;
				counts.set(key, n);
				return { success: n <= limit };
			},
		};
		return { limiter, keys };
	}
	const getPath = (kid = 'A'.repeat(43)) => `${PATH}?kid=${kid}&session_id=s`;

	it('the 61st POST from one address is 429 RATE_LIMITED with Retry-After: 60; another address is unaffected', async () => {
		const { limiter } = counting();
		const e = { ...testEnv, WITNESS_POST_RL: limiter };
		for (let i = 0; i < 60; i++) {
			const res = await post('{}', { 'CF-Connecting-IP': '198.51.100.7' }, e);
			expect(res.status, `request #${i + 1}`).toBe(400);
		}
		const over = await post('{}', { 'CF-Connecting-IP': '198.51.100.7' }, e);
		expect(over.status).toBe(429);
		const body = await over.json() as Record<string, unknown>;
		expect(body.error).toBe('RATE_LIMITED');
		expect(body.retry_after_seconds).toBe(60);
		expect(body.message).toContain('per minute per client address');
		expect(over.headers.get('Retry-After')).toBe('60');
		expect(over.headers.get('X-RateLimit-Limit')).toBe('60');
		expect(over.headers.get('X-RateLimit-Remaining')).toBeNull();
		expect(over.headers.get('X-RateLimit-Reset')).toBeNull();
		// Control: another address is unaffected.
		expect((await post('{}', { 'CF-Connecting-IP': '198.51.100.8' }, e)).status).toBe(400);
	});

	it('the 61st GET of checkpoints is 429, counting 400s too; POST and GET are separate limiters', async () => {
		const get = counting();
		const postRl = counting();
		const e = { ...testEnv, WITNESS_GET_RL: get.limiter, WITNESS_POST_RL: postRl.limiter };
		const h = { headers: { 'CF-Connecting-IP': '198.51.100.20' } };
		for (let i = 0; i < 30; i++) expect((await call(getPath(), h, e)).status).toBe(200);
		for (let i = 0; i < 30; i++) expect((await call(`${PATH}?kid=bad`, h, e)).status).toBe(400);
		const over = await call(getPath(), h, e);
		expect(over.status).toBe(429);
		expect((await over.json() as Record<string, unknown>).error).toBe('RATE_LIMITED');
		expect(over.headers.get('Retry-After')).toBe('60');
		// Even a malformed GET is refused once over the limit: the limiter runs first.
		expect((await call(`${PATH}?kid=bad`, h, e)).status).toBe(429);
		// The POST limiter was never asked, and a POST still goes through.
		expect(postRl.keys).toEqual([]);
		expect((await post('{}', { 'CF-Connecting-IP': '198.51.100.20' }, e)).status).toBe(400);
		// /v1/witness/spec is unmetered.
		expect((await call('/v1/witness/spec', h, e)).status).toBe(200);
		expect(get.keys.length).toBe(62);
	});

	it('witness responses carry X-RateLimit-Limit: 60 and no Remaining or Reset', async () => {
		for (const res of [await call(getPath()), await post('{}'), await call('/v1/witness/spec')]) {
			expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
			expect(res.headers.get('X-RateLimit-Remaining')).toBeNull();
			expect(res.headers.get('X-RateLimit-Reset')).toBeNull();
		}
	});

	it('the key comes from CF-Connecting-IP only: X-Original-IP does not change it', async () => {
		const { limiter, keys } = counting();
		const e = { ...testEnv, WITNESS_POST_RL: limiter };
		await post('{}', { 'CF-Connecting-IP': '198.51.100.9', 'X-Original-IP': '10.0.0.1' }, e);
		await post('{}', { 'CF-Connecting-IP': '198.51.100.9', 'X-Original-IP': '10.0.0.2' }, e);
		expect(keys).toEqual(['198.51.100.9', '198.51.100.9']);
	});

	it('an IPv6 address is keyed by its /64; requests without CF-Connecting-IP share "none"', async () => {
		const post6 = counting();
		const get6 = counting();
		const e = { ...testEnv, WITNESS_POST_RL: post6.limiter, WITNESS_GET_RL: get6.limiter };
		await post('{}', { 'CF-Connecting-IP': '2001:db8:1:2::1' }, e);
		await post('{}', { 'CF-Connecting-IP': '2001:0db8:0001:0002:ffff:0:0:9' }, e);
		await post('{}', { 'CF-Connecting-IP': '2001:db8:1:3::1' }, e);
		await post('{}', { 'X-Original-IP': '10.9.9.9' }, e);
		await call(getPath(), { headers: { 'CF-Connecting-IP': '2001:db8:1:2::abcd' } }, e);
		expect(post6.keys).toEqual(['2001:db8:1:2::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64', 'none']);
		expect(get6.keys).toEqual(['2001:db8:1:2::/64']);
	});

	it('fails open: with the bindings absent, or a limiter that throws, requests succeed and the failure is logged', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const id = await makeIdentity();
			const absent = { ...testEnv, WITNESS_POST_RL: undefined, WITNESS_GET_RL: undefined };
			expect((await post(bodyFor(await makeCheckpoint(id), jwkFor(id)), {}, absent)).status).toBe(201);
			expect((await call(`${PATH}?kid=${id.kid}&session_id=test-session`, {}, absent)).status).toBe(200);
			const broken: Limiter = { limit: async () => { throw new Error('boom'); } };
			const throwing = { ...testEnv, WITNESS_POST_RL: broken, WITNESS_GET_RL: broken };
			expect((await post(bodyFor(await makeCheckpoint(id, { count: 2 }), jwkFor(id)), {}, throwing)).status).toBe(201);
			expect((await call(`${PATH}?kid=${id.kid}&session_id=test-session`, {}, throwing)).status).toBe(200);
			const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('WITNESS_RATE_LIMITER_FAILED fail_open=true'));
			expect(lines.length).toBe(4);
		} finally {
			errors.mockRestore();
		}
	});

	it('witnessClientKey: IPv4 as is, IPv6 by /64, IPv4-mapped as IPv4', () => {
		expect(witnessClientKey('203.0.113.5')).toBe('203.0.113.5');
		expect(witnessClientKey('2001:DB8:0:0:1::1')).toBe('2001:db8:0:0::/64');
		expect(witnessClientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
		expect(witnessClientKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
		expect(witnessClientKey(null)).toBe('none');
	});
});

// ─── /v1/witness/spec ────────────────────────────────────────────────────────
describe('witness: GET /v1/witness/spec', () => {
	it('serves the checks in order, the receipt fields, the signing rule and the honest limits', async () => {
		const res = await call('/v1/witness/spec');
		expect(res.status).toBe(200);
		const text = await res.text();
		const doc = JSON.parse(text);
		expect(doc.submit.checks.map((c: { error: string }) => c.error)).toEqual([
			'bad_request', 'invalid_key', 'bad_checkpoint_shape', 'bad_checkpoint_field', 'bad_jwk', 'kid_mismatch', 'bad_signature',
		]);
		expect(doc.receipt.fields).toEqual([
			'type', 'witness', 'received_at', 'kid', 'session_id', 'count', 'last_entry_hash',
			'checkpoint_ts', 'checkpoint_sha256', 'fork', 'public_key_id',
		]);
		expect(doc.receipt.signing).toBe('All fields except signature, keys sorted, JSON.stringify with no whitespace, UTF-8, Ed25519, hex. For a flat object whose values are all strings these bytes are identical to RFC 8785 JCS, so a verifier may use either.');
		expect(doc.honest_limits.does_not_detect.length).toBe(5);
		expect(doc.version).toBe('witness-spec/0.5');
		expect(doc.submit.daily_cap).toMatch(/^Best effort: concurrent requests can exceed it slightly\. Once 2,000 \(a launch limit/);
		expect(doc.query.query_sql).toContain('(count, last_entry_hash) > (?, ?)');
		expect(doc.honest_limits.storage_ceiling).toBe('The witness store is a database with a fixed size ceiling and rows are never deleted. If it fills, new checkpoints are refused with 503 until capacity is added; checkpoints already stored stay readable.');
		expect(text).not.toContain('signPayload');
		expect(text).not.toContain('receipt-signing');
		expect(text).not.toContain('.claude');
	});
});

// ─── Witness accounts (H1b Part B, spec v0.5) ────────────────────────────────
// An Evidence plan key sent as Authorization: Bearer counts against its own
// daily quota. Key records are put straight into ORACLE_API_KEYS; Supabase is
// stubbed per test, so "unknown" and "store down" are both scripted.
describe('witness: accounts (Authorization: Bearer <Evidence plan key>)', () => {
	type Supa = 'none' | 'error';
	function stubSupabase(mode: Supa) {
		const seen = { calls: 0 };
		const prev = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.includes('supabase.co')) {
				seen.calls++;
				const headers = { 'Content-Type': 'application/json' };
				if (mode === 'error') return new Response(JSON.stringify({ code: 'PGRST002', message: 'schema cache' }), { status: 503, headers });
				return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers });
			}
			return prev(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		return { seen, restore: () => { globalThis.fetch = prev; } };
	}

	async function putKey(fill: string, record: Record<string, unknown>) {
		const key = 'ho_live_' + fill.repeat(64);
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify(record));
		return { key, keyHash, accountId: keyHash.slice(0, 32), auth: { Authorization: `Bearer ${key}` } };
	}
	async function newBody(opts: { count?: number } = {}) {
		const id = await makeIdentity();
		const cp = await makeCheckpoint(id, { count: opts.count ?? 1 });
		return { id, cp, body: bodyFor(cp, jwkFor(id)) };
	}
	async function rowCount(): Promise<number> {
		return (await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints').first<{ c: number }>())!.c;
	}

	it('evidence_starter key: 201, the row carries account_id, the account pool is counted and the anonymous pool is not', async () => {
		const k = await putKey('1', { plan: 'evidence_starter', status: 'active' });
		const { body } = await newBody();
		const res = await post(body, k.auth);
		expect(res.status).toBe(201);
		expect(res.headers.get('X-RateLimit-Limit')).toBe('600');
		const receipt = await res.json() as Record<string, string>;
		// account_id is never returned.
		expect(JSON.stringify(receipt)).not.toContain(k.accountId);
		const row = await env.WITNESS_DB!.prepare('SELECT account_id, received_at FROM witness_checkpoints').first<{ account_id: string; received_at: string }>();
		expect(row!.account_id).toBe(k.accountId);
		expect(row!.received_at).toBe(receipt.received_at);
		expect(await usage(k.accountId)).toBe(1);
		expect(await usage('anon')).toBeNull();
		// Control: an anonymous POST stores NULL and counts in anon.
		const anon = await newBody();
		expect((await post(anon.body)).status).toBe(201);
		const anonRow = await env.WITNESS_DB!.prepare('SELECT account_id FROM witness_checkpoints WHERE kid = ?').bind(anon.id.kid).first<{ account_id: string | null }>();
		expect(anonRow!.account_id).toBeNull();
		expect(await usage('anon')).toBe(1);
	});

	it('the anonymous cap reached: an anonymous POST is 503, an account POST is still stored', async () => {
		const k = await putKey('2', { plan: 'evidence', status: 'active' });
		await setUsage('anon', 2000);
		const anon = await post((await newBody()).body);
		expect(anon.status).toBe(503);
		expect(await anon.json()).toMatchObject({ error: 'witness_unavailable' });
		expect((await post((await newBody()).body, k.auth)).status).toBe(201);
		expect(await usage('anon')).toBe(2001);
	});

	it('the account quota reached: 429 quota_exceeded with Retry-After to 00:00 UTC; nothing stored; the next refusal does not touch D1', async () => {
		const k = await putKey('3', { plan: 'evidence_starter', status: 'active' });
		await setUsage(k.accountId, 1000);
		const before = await rowCount();
		const res = await post((await newBody()).body, k.auth);
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: 'quota_exceeded' });
		const retryAfter = Number(res.headers.get('Retry-After'));
		expect(retryAfter).toBeGreaterThanOrEqual(1);
		expect(retryAfter).toBeLessThanOrEqual(86_400);
		const now = new Date();
		const toMidnight = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000;
		expect(Math.abs(retryAfter - toMidnight)).toBeLessThanOrEqual(5);
		expect(await rowCount()).toBe(before);
		expect(await usage(k.accountId)).toBe(1001);
		// The isolate remembers this pool is over: refused again, counter untouched.
		const again = await post((await newBody()).body, k.auth);
		expect(again.status).toBe(429);
		expect(await usage(k.accountId)).toBe(1001);
		// One below the quota for the other plan still stores (control).
		const e = await putKey('4', { plan: 'evidence', status: 'active' });
		await setUsage(e.accountId, 2999);
		expect((await post((await newBody()).body, e.auth)).status).toBe(201);
		expect((await post((await newBody()).body, e.auth)).status).toBe(429);
	});

	it('a repeat POST of a stored checkpoint is free: 200, not counted, even over quota', async () => {
		const k = await putKey('5', { plan: 'evidence_starter', status: 'active' });
		const { body } = await newBody();
		expect((await post(body, k.auth)).status).toBe(201);
		expect((await post(body, k.auth)).status).toBe(200);
		expect(await usage(k.accountId)).toBe(1);
		await setUsage(k.accountId, 5000);
		expect((await post(body, k.auth)).status).toBe(200);
		expect(await usage(k.accountId)).toBe(5000);
	});

	it('receipts from both pools carry the same field set and verify with the worker key', async () => {
		const k = await putKey('6', { plan: 'evidence', status: 'active' });
		const acct = await (await post((await newBody()).body, k.auth)).json() as Record<string, string>;
		const anon = await (await post((await newBody()).body)).json() as Record<string, string>;
		expect(Object.keys(acct).sort()).toEqual(Object.keys(anon).sort());
		expect(await receiptVerifies(acct)).toBe(true);
		expect(await receiptVerifies(anon)).toBe(true);
	});

	it('a malformed header is 401 invalid_key with no KV or Supabase read, and never falls back to the anonymous pool', async () => {
		const reads = { kv: 0 };
		const realKv = env.ORACLE_API_KEYS;
		const countingKv = {
			get:             (...a: unknown[]) => { reads.kv++; return (realKv.get as (...x: unknown[]) => unknown).apply(realKv, a); },
			getWithMetadata: (...a: unknown[]) => { reads.kv++; return (realKv.getWithMetadata as (...x: unknown[]) => unknown).apply(realKv, a); },
			put:             realKv.put.bind(realKv),
			list:            realKv.list.bind(realKv),
			delete:          realKv.delete.bind(realKv),
		} as unknown as KVNamespace;
		const e = { ...testEnv, ORACLE_API_KEYS: countingKv };
		const { seen, restore } = stubSupabase('none');
		try {
			for (const header of [
				`Bearer ho_live_${'A'.repeat(64)}`,       // upper-case hex
				`Bearer ho_live_${'a'.repeat(63)}`,       // one short
				`bearer ho_live_${'a'.repeat(64)}`,       // scheme case
				`Basic ${'a'.repeat(20)}`,
				'',
			]) {
				const res = await post((await newBody()).body, { Authorization: header }, e);
				expect(res.status, header).toBe(401);
				expect(await res.json()).toMatchObject({ error: 'invalid_key' });
			}
			expect(reads.kv).toBe(0);
			expect(seen.calls).toBe(0);
			expect(await rowCount()).toBe(0);
		} finally {
			restore();
		}
	});

	it('a credits key (ho_crd_) is 401 by its pattern and its balance is not decremented', async () => {
		const key = 'ho_crd_' + '7'.repeat(64);
		const keyHash = await sha256Hex(key);
		const kv = env.ORACLE_API_KEYS;
		await kv.put(keyHash, JSON.stringify({ tier: 'credits', status: 'active', balance: 5 }));
		const res = await post((await newBody()).body, { Authorization: `Bearer ${key}` });
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({ error: 'invalid_key' });
		expect(JSON.parse((await kv.get(keyHash))!)).toMatchObject({ balance: 5 });
	});

	it('an unknown well-formed key (KV miss, Supabase no row) is 401 invalid_key', async () => {
		const { seen, restore } = stubSupabase('none');
		try {
			const res = await post((await newBody()).body, { Authorization: `Bearer ho_live_${'8'.repeat(64)}` });
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error: 'invalid_key' });
			expect(seen.calls).toBe(1);
		} finally {
			restore();
		}
	});

	it('a well-formed key with KV miss and Supabase erroring is 503 witness_unavailable, not 401', async () => {
		const { restore } = stubSupabase('error');
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await post((await newBody()).body, { Authorization: `Bearer ho_live_${'9'.repeat(64)}` });
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: 'witness_unavailable' });
			expect(await rowCount()).toBe(0);
		} finally {
			errors.mockRestore();
			restore();
		}
	});

	it('a cancelled Evidence key is 402 payment_required; a builder key is 403 witness_plan_required', async () => {
		const cancelled = await putKey('a', { plan: 'evidence', status: 'inactive' });
		const r402 = await post((await newBody()).body, cancelled.auth);
		expect(r402.status).toBe(402);
		expect(await r402.json()).toMatchObject({ error: 'payment_required' });
		const builder = await putKey('b', { plan: 'builder', status: 'active' });
		const r403 = await post((await newBody()).body, builder.auth);
		expect(r403.status).toBe(403);
		expect(await r403.json()).toMatchObject({
			error: 'witness_plan_required',
			message: 'Witness accounts come with the Evidence plans: https://headlessoracle.com/pricing',
		});
		expect(await rowCount()).toBe(0);
	});

	it('the key check runs after check 1 and before the signature check', async () => {
		const builder = await putKey('c', { plan: 'builder', status: 'active' });
		// A body that fails check 1 is 400 before the key is looked at.
		expect((await post('{"checkpoint":', builder.auth)).status).toBe(400);
		// A forged signature with a bad key is answered by the key check.
		const id = await makeIdentity();
		const forged = { ...(await makeCheckpoint(id, { count: 1 })), count: 2 };
		expect((await post(bodyFor(forged, jwkFor(id)), builder.auth)).status).toBe(403);
		// And with a good key, by the signature check.
		const good = await putKey('d', { plan: 'evidence', status: 'active' });
		const res = await post(bodyFor(forged, jwkFor(id)), good.auth);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: 'bad_signature' });
	});

	it('WITNESS_ACCT_RL: the ip-keyed limit refuses before the body is read; WITNESS_POST_RL is not asked', async () => {
		const acct: string[] = [];
		const postKeys: string[] = [];
		const e = {
			...testEnv,
			WITNESS_ACCT_RL: { limit: async ({ key }: { key: string }) => { acct.push(key); return { success: false }; } },
			WITNESS_POST_RL: { limit: async ({ key }: { key: string }) => { postKeys.push(key); return { success: true }; } },
		};
		// An endless body: refused unread, it is never cancelled and at most the
		// one chunk a stream pulls on construction is queued.
		const endless = () => {
			const seen = { pulls: 0, cancelled: false };
			const stream = new ReadableStream<Uint8Array>({
				pull(c) { seen.pulls++; c.enqueue(new Uint8Array(1000).fill(0x20)); },
				cancel() { seen.cancelled = true; },
			});
			return { stream, seen };
		};
		const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.30', Authorization: 'Bearer anything' };
		const { stream, seen: seenBody } = endless();
		const res = await call(PATH, { method: 'POST', headers, body: stream }, e);
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: 'RATE_LIMITED' });
		expect(res.headers.get('X-RateLimit-Limit')).toBe('600');
		expect(res.headers.get('Retry-After')).toBe('60');
		expect(acct).toEqual(['ip:198.51.100.30']);
		expect(postKeys).toEqual([]);
		expect(seenBody.cancelled).toBe(false);
		expect(seenBody.pulls).toBeLessThanOrEqual(1);
		// Control: with the limiter allowing, the same body is read until it is
		// too large, then cancelled.
		const control = endless();
		const res2 = await call(PATH, { method: 'POST', headers, body: control.stream }, { ...e, WITNESS_ACCT_RL: allow });
		expect(res2.status).toBe(400);
		expect(control.seen.cancelled).toBe(true);
	});

	it('WITNESS_ACCT_RL: the account-keyed limit applies after auth, keyed acct:<account_id>', async () => {
		const k = await putKey('e', { plan: 'evidence', status: 'active' });
		const keys: string[] = [];
		const e = { ...testEnv, WITNESS_ACCT_RL: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: key.startsWith('ip:') }; } } };
		const res = await post((await newBody()).body, { ...k.auth, 'CF-Connecting-IP': '198.51.100.31' }, e);
		expect(res.status).toBe(429);
		expect(await res.json()).toMatchObject({ error: 'RATE_LIMITED' });
		expect(keys).toEqual(['ip:198.51.100.31', `acct:${k.accountId}`]);
		expect(await rowCount()).toBe(0);
		// An unknown key never reaches the account limiter.
		keys.length = 0;
		const { restore } = stubSupabase('none');
		try {
			expect((await post((await newBody()).body, { Authorization: `Bearer ho_live_${'f'.repeat(64)}` }, e)).status).toBe(401);
			expect(keys.filter((x) => x.startsWith('acct:'))).toEqual([]);
		} finally {
			restore();
		}
	});

	it('WITNESS_ACCT_RL absent: fails open, the POST is stored, and the failure is logged', async () => {
		const k = await putKey('0', { plan: 'evidence_starter', status: 'active' });
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await post((await newBody()).body, k.auth, { ...testEnv, WITNESS_ACCT_RL: undefined });
			expect(res.status).toBe(201);
			const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('WITNESS_RATE_LIMITER_FAILED fail_open=true limiter=WITNESS_ACCT_RL'));
			expect(lines.length).toBe(2);
		} finally {
			errors.mockRestore();
		}
	});
});

// ─── Schema migration to v0.5 (H1b B5) ───────────────────────────────────────
describe('witness: ensureWitnessSchema migrates a v0.4 table', () => {
	const V04_TABLE = `CREATE TABLE witness_checkpoints (
		kid TEXT NOT NULL, session_id TEXT NOT NULL, count INTEGER NOT NULL, last_entry_hash TEXT NOT NULL,
		checkpoint_jcs TEXT NOT NULL, checkpoint_sha256 TEXT NOT NULL, public_key_x TEXT NOT NULL,
		received_at TEXT NOT NULL, fork TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL)`;

	async function columns(): Promise<string[]> {
		const { results } = await env.WITNESS_DB!.prepare('PRAGMA table_info(witness_checkpoints)').all<{ name: string }>();
		return results.map((r) => r.name);
	}
	async function tables(): Promise<string[]> {
		const { results } = await env.WITNESS_DB!.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name`).all<{ name: string }>();
		return results.map((r) => r.name);
	}

	it('adds account_id, its index and witness_usage, keeps existing rows, and a second run is a no-op', async () => {
		await env.WITNESS_DB!.prepare('DROP TABLE IF EXISTS witness_usage').run();
		await env.WITNESS_DB!.prepare('DROP TABLE IF EXISTS witness_checkpoints').run();
		await env.WITNESS_DB!.prepare(V04_TABLE).run();
		await seedRows(`INSERT INTO witness_checkpoints (${SEED_COLUMNS}) VALUES ('k', 's', 1, 'h', '{}', 'sha256:x', 'x', '2026-10-03T00:00:00.000Z', 'false', '{}', '')`);
		expect(await columns()).not.toContain('account_id');
		clearWitnessSchemaCache();
		await ensureWitnessSchema(env as never);
		expect(await columns()).toContain('account_id');
		const after = await tables();
		expect(after).toEqual(expect.arrayContaining(['witness_usage', 'idx_witness_account', 'idx_witness_identity']));
		const row = await env.WITNESS_DB!.prepare('SELECT kid, account_id FROM witness_checkpoints').first<{ kid: string; account_id: null }>();
		expect(row).toEqual({ kid: 'k', account_id: null });
		clearWitnessSchemaCache();
		await ensureWitnessSchema(env as never);
		expect(await tables()).toEqual(after);
		expect((await columns()).filter((c) => c === 'account_id').length).toBe(1);
	});

	it('a "duplicate column name" error from a concurrent isolate is treated as success', async () => {
		const real = env.WITNESS_DB!;
		let alters = 0;
		// PRAGMA reports no account_id (another isolate has not committed yet as
		// far as this one saw); the ALTER then finds it present.
		const racing = {
			prepare(sql: string) {
				if (sql.startsWith('PRAGMA table_info')) {
					return { all: async () => ({ results: [{ name: 'kid' }] }) };
				}
				if (sql.startsWith('ALTER TABLE')) {
					return { run: async () => { alters++; throw new Error('D1_ERROR: duplicate column name: account_id: SQLITE_ERROR'); } };
				}
				return real.prepare(sql);
			},
		};
		clearWitnessSchemaCache();
		await expect(ensureWitnessSchema({ ...(env as object), WITNESS_DB: racing } as never)).resolves.toBeUndefined();
		expect(alters).toBe(1);
		// Control: any other ALTER error still fails.
		const broken = {
			prepare(sql: string) {
				if (sql.startsWith('PRAGMA table_info')) return { all: async () => ({ results: [{ name: 'kid' }] }) };
				if (sql.startsWith('ALTER TABLE')) return { run: async () => { throw new Error('D1_ERROR: disk I/O error'); } };
				return real.prepare(sql);
			},
		};
		clearWitnessSchemaCache();
		await expect(ensureWitnessSchema({ ...(env as object), WITNESS_DB: broken } as never)).rejects.toThrow('disk I/O error');
		clearWitnessSchemaCache();
	});
});
