import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, {
	clearWitnessSchemaCache, witnessJcs, witnessClientKey, readWitnessBody,
	witnessSql,
} from '../src';

const { dayCount: WITNESS_DAY_COUNT_SQL, page: WITNESS_PAGE_SQL } = witnessSql();

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
const testEnv: Record<string, unknown> = { ...(env as unknown as Record<string, unknown>), WITNESS_POST_RL: allow, WITNESS_GET_RL: allow };

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

beforeEach(async () => {
	vi.useRealTimers();
	clearWitnessSchemaCache();
	// Make sure the table exists, then empty it. The application never
	// deletes; only the test harness does, to start each case clean.
	await call(`${PATH}?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
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
		const now = new Date().toISOString();
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'seed', 'seed', i, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', ? FROM n`,
			now, now,
		);
		expect((await post(bodyFor(await makeCheckpoint(id), jwkFor(id)))).status).toBe(201);
		expect((await post(bodyFor(await makeCheckpoint(id, { count: 2 }), jwkFor(id)))).status).toBe(503);
	});

	it('the daily cap blocks new rows with 503 but still answers a repeat with its stored receipt', async () => {
		const id = await makeIdentity();
		const firstCp = await makeCheckpoint(id, { count: 1 });
		const first = await postCheckpoint(id, firstCp);
		expect(first.status).toBe(201);
		const now = new Date().toISOString();
		// One stored today; seed 1,999 more so today's count reaches the 2,000 cap.
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'seed', 'seed', i, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', ? FROM n`,
			now, now,
		);
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
	it('a POST whose body is held open stores a received_at taken after the body arrived, and the cap still holds', async () => {
		const id = await makeIdentity();
		const bytes = new TextEncoder().encode(bodyFor(await makeCheckpoint(id, { count: 1 }), jwkFor(id)));
		let ctl!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
		ctl.enqueue(bytes.slice(0, 10));
		const held = call(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream });

		// While the body is held, 1,999 rows are stored for the day.
		await new Promise((r) => setTimeout(r, 25));
		const seededAt = new Date().toISOString();
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'seed', 'seed', i, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', ? FROM n`,
			seededAt, seededAt,
		);
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
	it('the daily-cap count reads at most 2 rows and counts only today', async () => {
		const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
		// 100 rows from yesterday first (lower rowids), then 50,000 from today.
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'old', 'old', i, 'h', '{}', 'sha256:x', 'x', '2000-01-01T00:00:00.000Z', 'false', '{}', '' FROM n`,
		);
		await seedRows(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
			 INSERT INTO witness_checkpoints (${SEED_COLUMNS})
			 SELECT 'seed', 'seed', i, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', '' FROM n`,
			dayStart,
		);
		const res = await env.WITNESS_DB!.prepare(WITNESS_DAY_COUNT_SQL).bind(dayStart).all<{ c: number }>();
		expect(res.results[0].c).toBe(50_000);
		expect(res.meta.rows_read).toBeLessThanOrEqual(2);
		// Control: the replaced count(*) reads every row of the day.
		const old = await env.WITNESS_DB!.prepare('SELECT count(*) AS c FROM witness_checkpoints WHERE received_at >= ?').bind(dayStart).all<{ c: number }>();
		expect(old.results[0].c).toBe(50_000);
		expect(old.meta.rows_read).toBeGreaterThanOrEqual(50_000);
		// An empty day counts 0.
		const empty = await env.WITNESS_DB!.prepare(WITNESS_DAY_COUNT_SQL).bind('2999-01-01T00:00:00.000Z').all<{ c: number }>();
		expect(empty.results[0].c).toBe(0);
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
			'bad_request', 'bad_checkpoint_shape', 'bad_checkpoint_field', 'bad_jwk', 'kid_mismatch', 'bad_signature',
		]);
		expect(doc.receipt.fields).toEqual([
			'type', 'witness', 'received_at', 'kid', 'session_id', 'count', 'last_entry_hash',
			'checkpoint_ts', 'checkpoint_sha256', 'fork', 'public_key_id',
		]);
		expect(doc.receipt.signing).toBe('All fields except signature, keys sorted, JSON.stringify with no whitespace, UTF-8, Ed25519, hex. For a flat object whose values are all strings these bytes are identical to RFC 8785 JCS, so a verifier may use either.');
		expect(doc.honest_limits.does_not_detect.length).toBe(5);
		expect(doc.version).toBe('witness-spec/0.4');
		expect(doc.submit.daily_cap).toMatch(/^Best effort: concurrent requests can exceed it slightly\. Once 2,000 \(a launch limit/);
		expect(doc.query.query_sql).toContain('(count, last_entry_hash) > (?, ?)');
		expect(doc.honest_limits.storage_ceiling).toBe('The witness store is a database with a fixed size ceiling and rows are never deleted. If it fills, new checkpoints are refused with 503 until capacity is added; checkpoints already stored stay readable.');
		expect(text).not.toContain('signPayload');
		expect(text).not.toContain('receipt-signing');
		expect(text).not.toContain('.claude');
	});
});
