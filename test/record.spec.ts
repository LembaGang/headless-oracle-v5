import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import * as ed from '@noble/ed25519';
import worker, {
	runHoRecordJob, hoJcs, witnessJcs, submitHoRecordCheckpoint, mcpCountKeys,
	clearHaltArchiveSchemaCache, clearWitnessSchemaCache, ensureHoRecordSchema, buildHoRecordObject,
	hoRecordGenesisHash, hoRecordEntry,
} from '../src';
import {
	parseDetachedFile, detachedFile, pendingAttestations, serializeTimestamp, submitDigest, bitcoinHeights,
	type OtsNode,
} from '../src/ots';
import { recordProblems } from '../scripts/record-check.mjs';

// H6: HO's daily record, ho-record/v1 (CC_HANDOFF_2026-10-08_hov5-H6 rev 1).
// Every test carries a control that shows the assertion could fail.

const SEED = 'a1'.repeat(32);
type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
const allow: Limiter = { limit: async () => ({ success: true }) };
const testEnv = { ...(env as unknown as Record<string, unknown>), HO_RECORD_WITNESS_KEY: SEED, WITNESS_POST_RL: allow, WITNESS_GET_RL: allow, WITNESS_ACCT_RL: allow } as unknown as typeof env;

function hex(b: Uint8Array): string { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
function fromHex(h: string): Uint8Array { return new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16))); }
async function sha256HexOf(data: Uint8Array | string): Promise<string> {
	const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)));
}
function sortedJson(o: Record<string, unknown>): string {
	const s: Record<string, unknown> = {};
	for (const k of Object.keys(o).sort()) s[k] = o[k];
	return JSON.stringify(s);
}
function b64u(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function call(path: string, init: RequestInit = {}, e: typeof env = testEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init), e, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

// A calendar that answers POST /digest with a one-branch pending timestamp
// (append nonce, sha256, pending attestation) and GET /timestamp/<c> with 404,
// or with a Bitcoin attestation once `confirmed` is set.
const CAL = ['https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org', 'https://finney.calendar.eternitywall.com'];
function pendingAtt(uri: string) {
	const u = new TextEncoder().encode(uri);
	return { tag: fromHex('83dfe30d2ef90c8e'), payload: new Uint8Array([u.length, ...u]) };
}
function fakeCalendars(opts: { failing?: string[]; confirmed?: boolean } = {}) {
	const posted: { url: string; body: Uint8Array }[] = [];
	const gets: string[] = [];
	const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		if (url.endsWith('/registry/index.json')) {
			return new Response(JSON.stringify({ records: [
				{ kind: 'own_work', status_label: 'unverified' }, { kind: 'own_work', status_label: 'unverified' },
				{ kind: 'observation', status_label: 'unverified' }, { kind: 'entry', status_label: 'verified' },
			] }), { status: 200 });
		}
		const cal = CAL.find((c) => url.startsWith(c));
		if (!cal) return new Response('no', { status: 599 });
		if (opts.failing?.includes(cal)) return new Response('down', { status: 503 });
		if (init?.method === 'POST') {
			const body = new Uint8Array(init.body as Uint8Array);
			posted.push({ url, body });
			const nonce = new TextEncoder().encode(cal.slice(8, 24));
			const appended = new Uint8Array([...body, ...nonce]);
			const commitment = new Uint8Array(await crypto.subtle.digest('SHA-256', appended));
			const node: OtsNode = { msg: body, attestations: [], ops: [{ op: { tag: 0xf0, arg: nonce }, child: { msg: appended, attestations: [], ops: [{ op: { tag: 0x08 }, child: { msg: commitment, attestations: [pendingAtt(cal)], ops: [] } }] } }] };
			return new Response(serializeTimestamp(node), { status: 200 });
		}
		gets.push(url);
		if (!opts.confirmed) return new Response('Pending', { status: 404 });
		const commitment = fromHex(url.slice(url.lastIndexOf('/') + 1));
		const tail = new Uint8Array(32).fill(7);
		const appended = new Uint8Array([...commitment, ...tail]);
		const btc = { tag: fromHex('0588960d73d71901'), payload: new Uint8Array([0xa0, 0x8d, 0x06]) }; // height 100000
		const node: OtsNode = { msg: commitment, attestations: [], ops: [{ op: { tag: 0xf0, arg: tail }, child: { msg: appended, attestations: [], ops: [{ op: { tag: 0x08 }, child: { msg: new Uint8Array(await crypto.subtle.digest('SHA-256', appended)), attestations: [btc], ops: [] } }] } }] };
		return new Response(serializeTimestamp(node), { status: 200 });
	};
	return { fetchFn, posted, gets };
}

async function servedRecord(date: string): Promise<{ text: string; record: Record<string, unknown> }> {
	const res = await call(`/record/${date}`);
	expect(res.status).toBe(200);
	const text = await res.text();
	return { text, record: JSON.parse(text) };
}
async function hoPublicKey(): Promise<Uint8Array> {
	const keys = await (await call('/v5/keys')).json() as { keys: { key_id: string; public_key: string }[] };
	return fromHex(keys.keys.find((k) => k.key_id === (env as unknown as { PUBLIC_KEY_ID: string }).PUBLIC_KEY_ID)!.public_key);
}
async function signatureVerifies(record: Record<string, unknown>): Promise<boolean> {
	const sp = record.signed_payload as Record<string, string>;
	if (sortedJson(sp) !== record.canonical) return false;
	return ed.verifyAsync(fromHex(record.signature as string), new TextEncoder().encode(record.canonical as string), await hoPublicKey());
}
async function bodyHash(record: Record<string, unknown>): Promise<string> {
	const { signed_payload: _a, canonical: _b, public_key_id: _c, signature: _d, ...body } = record;
	return sha256HexOf(hoJcs(body));
}

const AT = (iso: string) => new Date(iso);

beforeEach(async () => {
	clearHaltArchiveSchemaCache();
	clearWitnessSchemaCache();
	await ensureHoRecordSchema(testEnv);
	for (const t of ['ho_records', 'ho_record_proofs', 'ho_mcp_counts']) await env.HALT_ARCHIVE!.prepare(`DELETE FROM ${t}`).run();
	await call(`/v1/witness/checkpoints?kid=${'A'.repeat(43)}&session_id=x`);
	await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
	await env.WITNESS_DB!.prepare('DELETE FROM witness_usage').run();
});

describe('H6 record: JCS', () => {
	it('hoJcs sorts keys at every depth and agrees with witnessJcs on a flat object', () => {
		expect(hoJcs({ b: [3, { y: null, x: true }], a: 'é', c: { z: 1, a: -2 } })).toBe('{"a":"é","b":[3,{"x":true,"y":null}],"c":{"a":-2,"z":1}}');
		const flat = { v: 'x', count: 3, kid: 'k' };
		expect(hoJcs(flat)).toBe(witnessJcs(flat));
		// Control: different values give different bytes; insertion order does not.
		expect(hoJcs({ a: 1, b: 2 })).toBe(hoJcs({ b: 2, a: 1 }));
		expect(hoJcs({ a: 1, b: 2 })).not.toBe(hoJcs({ a: 1, b: 3 }));
		expect(() => hoJcs({ a: Infinity })).toThrow();
	});
});

describe('H6 record: shape, signature, immutability', () => {
	it('day 1 is yesterday, sequence 1, previous null, in the handoff member order, signed and verifiable from /v5/keys', async () => {
		const cal = fakeCalendars();
		const run = await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: cal.fetchFn });
		expect(run.built.map((b) => b.date)).toEqual(['2026-09-01']);
		const { text, record } = await servedRecord('2026-09-01');
		expect(Object.keys(record)).toEqual(['schema', 'date', 'generated_at', 'sequence', 'previous_record_sha256', 'inputs', 'counts', 'signed_payload', 'canonical', 'public_key_id', 'signature']);
		expect(record.schema).toBe('ho-record/v1');
		expect(record.sequence).toBe(1);
		expect(record.previous_record_sha256).toBeNull();
		expect(record.public_key_id).toBe((env as unknown as { PUBLIC_KEY_ID: string }).PUBLIC_KEY_ID);
		const sp = record.signed_payload as Record<string, string>;
		expect(sp).toEqual({ schema: 'ho-record/v1', date: '2026-09-01', sequence: '1', previous_record_sha256: '', record_body_sha256: await bodyHash(record), generated_at: record.generated_at });
		expect(Object.values(sp).every((v) => typeof v === 'string')).toBe(true);
		expect(await signatureVerifies(record)).toBe(true);
		const inputs = record.inputs as Record<string, Record<string, unknown>>;
		expect(inputs.registry_index).toMatchObject({ records: 4, by_kind: { own_work: 2, observation: 1, entry: 1 }, unverified: 3 });
		const counts = record.counts as Record<string, unknown>;
		expect(counts.mcp_requests_by_method).toBeNull();
		expect(String(counts.mcp_unavailable_reason)).toContain('2026-10-10');
		expect(counts.x402_settlements).toBe(0);
		// record_sha256 is the hash of the served bytes.
		expect(run.built[0].record_sha256).toBe(await sha256HexOf(text));

		// Controls: a changed count no longer matches the signed body hash, and a
		// changed signed member no longer verifies.
		const tampered = { ...record, counts: { ...counts, x402_settlements: 1 } };
		expect(await bodyHash(tampered)).not.toBe(sp.record_body_sha256);
		const forged = { ...record, signed_payload: { ...sp, sequence: '2' }, canonical: sortedJson({ ...sp, sequence: '2' }) };
		expect(await signatureVerifies(forged)).toBe(false);
	});

	it('the halt digest member hashes exactly the bytes GET /v1/halts/digest/<D> serves', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const { record } = await servedRecord('2026-09-01');
		const member = (record.inputs as Record<string, Record<string, unknown>>).halt_digest;
		const served = new Uint8Array(await (await call('/v1/halts/digest/2026-09-01')).arrayBuffer());
		expect(member.url).toBe('https://headlessoracle.com/v1/halts/digest/2026-09-01');
		expect(member.bytes).toBe(served.length);
		expect(member.sha256).toBe(await sha256HexOf(served));
		// Control: one byte more and the hash differs.
		expect(member.sha256).not.toBe(await sha256HexOf(new Uint8Array([...served, 0x20])));
	});

	it('served bytes equal stored bytes and a second run never rebuilds or overwrites them', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const first = await servedRecord('2026-09-01');
		const stored = await env.HALT_ARCHIVE!.prepare('SELECT record_json, record_sha256 FROM ho_records WHERE date = ?').bind('2026-09-01').first<{ record_json: string; record_sha256: string }>();
		expect(first.text).toBe(stored!.record_json);
		expect(stored!.record_sha256).toBe(await sha256HexOf(first.text));
		const again = await runHoRecordJob(testEnv, { now: AT('2026-09-02T11:00:00Z'), fetch: fakeCalendars().fetchFn });
		expect(again.built).toEqual([]);
		expect(again.not_built_reason).toContain('already recorded');
		expect((await servedRecord('2026-09-01')).text).toBe(first.text);
		// Control: a rebuild of the same day now would produce different bytes,
		// so the equality above would catch an overwrite.
		const rebuilt = await buildHoRecordObject(testEnv, '2026-09-01', null, 1, { value: null, reason: 'x' }, AT('2026-09-02T11:00:00Z'), null);
		expect(JSON.stringify(rebuilt)).not.toBe(first.text);
	});

	it('/record names the newest record and its sha256 matches the served bytes', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const idx = await (await call('/record')).json() as Record<string, any>;
		const { text } = await servedRecord('2026-09-01');
		expect(idx.newest.date).toBe('2026-09-01');
		expect(idx.newest.record_sha256).toBe(await sha256HexOf(text));
		expect(idx.records).toBe(1);
		expect(idx.witness_receipts).toBe(1);
		expect(idx.ots_proofs).toEqual({ pending: 1, complete: 0, failed: 0 });
		expect(idx.witness_key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(idx.failed_steps).toEqual([]);
		// Control: a different byte string hashes differently.
		expect(idx.newest.record_sha256).not.toBe(await sha256HexOf(text + ' '));
	});
});

describe('H6 record: chain and backfill', () => {
	it('each record links to the previous one\'s served bytes; missed days are built in order and marked late', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const run = await runHoRecordJob(testEnv, { now: AT('2026-09-05T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		expect(run.built.map((b) => [b.date, b.sequence, b.late])).toEqual([
			['2026-09-02', 2, true], ['2026-09-03', 3, true], ['2026-09-04', 4, false],
		]);
		let prev = (await servedRecord('2026-09-01')).text;
		for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
			const { text, record } = await servedRecord(d);
			expect(record.previous_record_sha256).toBe(await sha256HexOf(prev));
			expect((record.signed_payload as Record<string, string>).previous_record_sha256).toBe(await sha256HexOf(prev));
			expect(await signatureVerifies(record)).toBe(true);
			// Control: a changed previous record would break the link.
			expect(record.previous_record_sha256).not.toBe(await sha256HexOf(prev.replace('"sequence":', '"sequence": ')));
			prev = text;
		}
		const onTime = (await servedRecord('2026-09-04')).record;
		expect('late' in onTime).toBe(false);
		expect((await servedRecord('2026-09-02')).record.late).toBe(true);
	});

	it('the chain entry hashes follow the recorder rule, from the genesis hash', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		await runHoRecordJob(testEnv, { now: AT('2026-09-03T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const genesis = `sha256:${await sha256HexOf('{"marker":"genesis","session_id":"ho-record","v":"evidence.action/1"}')}`;
		expect(await hoRecordGenesisHash()).toBe(genesis);
		const p1 = await (await call('/record/2026-09-01/proofs')).json() as Record<string, any>;
		const p2 = await (await call('/record/2026-09-02/proofs')).json() as Record<string, any>;
		expect(p1.chain_entry.entry.prev_hash).toBe(genesis);
		expect(p1.chain_entry.entry_hash).toBe(`sha256:${await sha256HexOf(hoJcs(p1.chain_entry.entry))}`);
		expect(p2.chain_entry.entry.prev_hash).toBe(p1.chain_entry.entry_hash);
		expect(p2.chain_entry.entry.record_sha256).toBe(`sha256:${p2.record_sha256}`);
		// Control: a different record hash gives a different entry hash.
		const other = hoRecordEntry(2, '00'.repeat(32), p1.chain_entry.entry_hash);
		expect(`sha256:${await sha256HexOf(hoJcs(other))}`).not.toBe(p2.chain_entry.entry_hash);
	});

	it('a run never builds today or a later day', async () => {
		const run = await runHoRecordJob(testEnv, { now: AT('2026-09-02T00:00:01Z'), fetch: fakeCalendars().fetchFn });
		expect(run.built.map((b) => b.date)).toEqual(['2026-09-01']);
		const { results } = await env.HALT_ARCHIVE!.prepare('SELECT date FROM ho_records WHERE date >= ?').bind('2026-09-02').all();
		expect(results).toEqual([]);
		// Control: the same query sees a row that is there.
		expect((await env.HALT_ARCHIVE!.prepare('SELECT date FROM ho_records WHERE date >= ?').bind('2026-09-01').all()).results).toHaveLength(1);
	});
});

describe('H6 record: witness self-checkpoint', () => {
	it('the record is witnessed through the public path and the receipt is served beside it', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const proofs = await (await call('/record/2026-09-01/proofs')).json() as Record<string, any>;
		expect(proofs.witness.receipt.type).toBe('witness.checkpoint/1');
		expect(proofs.witness.receipt.session_id).toBe('ho-record');
		expect(proofs.witness.receipt.count).toBe('1');
		expect(proofs.witness.receipt.last_entry_hash).toBe(proofs.chain_entry.entry_hash);
		expect(proofs.witness.statement).toContain('not independence');
		const kid = proofs.witness.checkpoint.kid;
		const listed = await (await call(`/v1/witness/checkpoints?kid=${kid}&session_id=ho-record`)).json() as { receipts: unknown[] };
		expect(listed.receipts).toEqual([proofs.witness.receipt]);
		// It counted against the anonymous pool like anyone's checkpoint.
		const used = await env.WITNESS_DB!.prepare("SELECT n FROM witness_usage WHERE pool = 'anon'").first<{ n: number }>();
		expect(used?.n).toBe(1);
		// Control: another kid has no receipts.
		const none = await (await call(`/v1/witness/checkpoints?kid=${'B'.repeat(43)}&session_id=ho-record`)).json() as { receipts: unknown[] };
		expect(none.receipts).toEqual([]);
	});

	it('a malformed self-checkpoint is rejected exactly as an outside POST of it is', async () => {
		const sk = fromHex(SEED);
		const x = b64u(await ed.getPublicKeyAsync(sk));
		const kid = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))));
		const unsigned = { v: 'evidence.action/1', type: 'checkpoint', session_id: 'ho-record', count: 1, last_entry_hash: `sha256:${'0'.repeat(64)}`, ts: '2026-09-02T09:30:00.000Z', kid };
		const good = { ...unsigned, sig: b64u(await ed.signAsync(new TextEncoder().encode(witnessJcs(unsigned)), sk)) };
		const bad = { ...good, count: 2 }; // signature no longer covers the content
		const jwk = { kty: 'OKP', crv: 'Ed25519', x };
		const self = await submitHoRecordCheckpoint(testEnv, bad, jwk, new Date());
		expect(self.status).toBe(400);
		expect(self.body.error).toBe('bad_signature');
		const outside = await call('/v1/witness/checkpoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkpoint: bad, public_key_jwk: jwk }) });
		expect(outside.status).toBe(400);
		expect((await outside.json() as { error: string }).error).toBe('bad_signature');
		const shapeless = await submitHoRecordCheckpoint(testEnv, { ...good, extra: 1 }, jwk, new Date());
		expect(shapeless.body.error).toBe('bad_checkpoint_shape');
		// Control: the well-formed checkpoint is accepted by the same path.
		expect((await submitHoRecordCheckpoint(testEnv, good, jwk, new Date())).status).toBe(201);
	});

	it('without the witness key the record is still built and the failed step is reported', async () => {
		const noKey = { ...(testEnv as unknown as Record<string, unknown>), HO_RECORD_WITNESS_KEY: undefined } as unknown as typeof env;
		await runHoRecordJob(noKey, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const idx = await (await call('/record', {}, noKey)).json() as Record<string, any>;
		expect(idx.newest.date).toBe('2026-09-01');
		expect(idx.failed_steps.map((f: { date: string; step: string }) => [f.date, f.step])).toEqual([['2026-09-01', 'witness']]);
		expect(recordProblems(idx, AT('2026-09-02T10:15:00Z'))).toEqual([expect.stringContaining('failed step for 2026-09-01: witness')]);
		// The next run with the key retries the witness and clears the step.
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T10:30:00Z'), fetch: fakeCalendars().fetchFn });
		const after = await (await call('/record')).json() as Record<string, any>;
		expect(after.failed_steps).toEqual([]);
		expect(after.witness_receipts).toBe(1);
	});
});

describe('H6 record: OpenTimestamps', () => {
	// `ots stamp` output from the stock opentimestamps-client 0.7.2 (WSL Ubuntu,
	// 2026-10-09) for a file whose sha256 is f44870c7…df9d: four calendars.
	const STOCK_OTS = '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e892940108f44870c740b6a01735f242a61dd2d69be284c81a1a5242106d73af58b117df9df010b351458495e712f8dd0aac7266d0335508fff00876a7e0a717aa91a608f010fa12136de810d6519ab7a312753f091508f02093d813ffbadd20acc318225018749a960b0d45503344800192f5c55b0b8eb2c308f02096e985b0c8b49006c0a50c6fe1359d182b30687a9425f2e5eb330d04ad5f89d008f02050e04b87d7b699e0f3a79a02ed0dc803520a353451c9db037f1a36dca3ed817508f1046ac8b3e8f008a73888132e13eb1c0083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267fff010b70a066927ce297fc69a7f04508bc41808f1200f5726e03834fc93d5dbf8afbe747bd9d384e806771170a079abf0ef7ebf88bd08f120000edd277f100efbeb47c2c682aebbcd22de37a39a6848b0f1ee47101a20b16208f1046ac8b3e7f0084207c61e0037b9310083dfe30d2ef90c8e232268747470733a2f2f6274632e63616c656e6461722e636174616c6c6178792e636f6dfff008d0e63a70691a273808f010cc7e4042a793e370c578ae17e9afdf9408f020c64702ed6f69cc3d314bff6b1584386327194c39fb59f207b63a0dc42310492008f0201a425a527d6a57b0f9b71ceffa9cb04c536c095d8e5cc305d9403f713fbc9b0b08f0205b3444d94a96897926489910ebf4f7be4d40da9e7d6b14036b6aaaff54978f6808f1046ac8b3e8f00803b2b342dfbd90440083dfe30d2ef90c8e2c2b68747470733a2f2f626f622e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267f010d29bd43331b7bad372c08bf08978026f08f12066807fd9b2a8b9bc9747ab548388e0447f1c4cd8023c1418dd8867b61d83803c08f1046ac8b3e7f0087a830d50e15382cf0083dfe30d2ef90c8e292868747470733a2f2f66696e6e65792e63616c656e6461722e657465726e69747977616c6c2e636f6d';

	it('the codec reads a stock-client proof and writes it back byte for byte', () => {
		const bytes = fromHex(STOCK_OTS);
		const { digest, node } = parseDetachedFile(bytes);
		expect(hex(digest)).toBe('f44870c740b6a01735f242a61dd2d69be284c81a1a5242106d73af58b117df9d');
		expect(pendingAttestations(node).map((p) => p.uri).sort()).toEqual([
			'https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org',
			'https://btc.calendar.catallaxy.com', 'https://finney.calendar.eternitywall.com',
		]);
		expect(hex(detachedFile(digest, node))).toBe(STOCK_OTS);
		// Control: a flipped digest byte is refused, and a truncated file does not parse.
		expect(() => detachedFile(new Uint8Array(32), node)).toThrow();
		expect(() => parseDetachedFile(bytes.slice(0, bytes.length - 1))).toThrow();
	});

	it('each calendar is sent exactly the 32 bytes of record_sha256', async () => {
		const cal = fakeCalendars();
		const run = await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: cal.fetchFn });
		expect(cal.posted.map((p) => p.url).sort()).toEqual(CAL.map((c) => `${c}/digest`).sort());
		for (const p of cal.posted) {
			expect(p.body.length).toBe(32);
			expect(hex(p.body)).toBe(run.built[0].record_sha256);
		}
		const served = new Uint8Array(await (await call('/record/2026-09-01.ots')).arrayBuffer());
		const { digest, node } = parseDetachedFile(served);
		expect(hex(digest)).toBe(run.built[0].record_sha256);
		expect(pendingAttestations(node).map((p) => p.uri).sort()).toEqual([...CAL].sort());
		// Control: a 31-byte digest is refused before any request is made.
		await expect(submitDigest(new Uint8Array(31), CAL, cal.fetchFn)).rejects.toThrow();
	});

	it('one calendar down still yields a proof; all down is a failed ots_submit step', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars({ failing: [CAL[2]] }).fetchFn });
		const p = await (await call('/record/2026-09-01/proofs')).json() as Record<string, any>;
		expect(p.ots.status).toBe('pending');
		expect(p.ots.calendars.filter((c: { submitted: boolean }) => c.submitted)).toHaveLength(2);
		expect(p.failed_steps).toEqual([]);
		await runHoRecordJob(testEnv, { now: AT('2026-09-03T09:30:00Z'), fetch: fakeCalendars({ failing: CAL }).fetchFn });
		const q = await (await call('/record/2026-09-02/proofs')).json() as Record<string, any>;
		expect(q.ots.status).toBe('failed');
		expect(q.failed_steps.map((f: { step: string }) => f.step)).toEqual(['ots_submit']);
		expect((await call('/record/2026-09-02.ots')).status).toBe(404);
	});

	it('an upgrade replaces the pending proof and keeps the pending bytes in history', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const pendingBytes = new Uint8Array(await (await call('/record/2026-09-01.ots')).arrayBuffer());
		// Too soon: nothing is asked.
		const early = fakeCalendars({ confirmed: true });
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T10:00:00Z'), fetch: early.fetchFn });
		expect(early.gets).toEqual([]);
		// Not yet committed: still pending, still the same bytes (control).
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T12:00:00Z'), fetch: fakeCalendars().fetchFn });
		expect(new Uint8Array(await (await call('/record/2026-09-01.ots')).arrayBuffer())).toEqual(pendingBytes);
		const done = fakeCalendars({ confirmed: true });
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T13:00:00Z'), fetch: done.fetchFn });
		expect(done.gets.length).toBeGreaterThan(0);
		const upgraded = new Uint8Array(await (await call('/record/2026-09-01.ots')).arrayBuffer());
		expect(upgraded).not.toEqual(pendingBytes);
		expect(bitcoinHeights(parseDetachedFile(upgraded).node)).toEqual([100000]);
		const p = await (await call('/record/2026-09-01/proofs')).json() as Record<string, any>;
		expect(p.ots.status).toBe('complete');
		expect(p.ots.history.map((h: { event: string }) => h.event)).toEqual(['submitted', 'upgraded']);
		expect(p.ots.history[0].bytes_base64).toBe(btoa(String.fromCharCode(...pendingBytes)));
		const idx = await (await call('/record')).json() as Record<string, any>;
		expect(idx.ots_proofs).toEqual({ pending: 0, complete: 1, failed: 0 });
	});

	it('external fetches stay within the budget', async () => {
		const run = await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		expect(run.external_subrequests).toBe(4); // registry + three calendars
		expect(run.external_budget).toBe(37);
		await runHoRecordJob(testEnv, { now: AT('2026-09-10T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const big = await runHoRecordJob(testEnv, { now: AT('2026-09-20T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		expect(big.built).toHaveLength(5);
		expect(big.days_left_for_next_run).toBeGreaterThan(0);
		expect(big.external_subrequests).toBeLessThanOrEqual(37);
	});
});

describe('H6 record: MCP counters', () => {
	it('a POST /mcp is counted by method, tool and client-name hash, never by arguments or address', async () => {
		const SECRET = 'arg-secret-7f3a9c';
		const IP = '203.0.113.77';
		const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP };
		await call('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'probe-client', version: '1.0' } } }) });
		await call('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_exchanges', arguments: { note: SECRET } } }) });
		await call('/mcp', { method: 'POST', headers, body: JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_exchanges', arguments: { note: SECRET } } }]) });
		const { results } = await env.HALT_ARCHIVE!.prepare('SELECT day, method, tool, client, n FROM ho_mcp_counts ORDER BY method, tool').all<Record<string, string | number>>();
		const day = new Date().toISOString().slice(0, 10);
		expect(results).toEqual([
			{ day, method: 'initialize', tool: '', client: await sha256HexOf('probe-client'), n: 1 },
			{ day, method: 'tools/call', tool: 'list_exchanges', client: '', n: 2 },
			{ day, method: 'tools/list', tool: '', client: '', n: 1 },
		]);
		const dump = JSON.stringify(results);
		for (const leaked of [SECRET, IP, 'probe-client']) expect(dump).not.toContain(leaked);
		// Control: the leak scan finds a value that is there.
		expect(JSON.stringify([...results, { note: SECRET }])).toContain(SECRET);
		expect(mcpCountKeys({ method: 'tools/call', params: { name: 'get_market_status', arguments: { a: SECRET } } })).toEqual([{ method: 'tools/call', tool: 'get_market_status', clientName: '' }]);
	});

	it('the record reads the day\'s counters from the first counted day on', async () => {
		const day = '2026-10-10';
		const ins = 'INSERT INTO ho_mcp_counts (day, method, tool, client, n) VALUES (?, ?, ?, ?, ?)';
		await env.HALT_ARCHIVE!.batch([
			env.HALT_ARCHIVE!.prepare(ins).bind(day, 'initialize', '', 'c1', 3),
			env.HALT_ARCHIVE!.prepare(ins).bind(day, 'initialize', '', 'c2', 1),
			env.HALT_ARCHIVE!.prepare(ins).bind(day, 'tools/call', 'get_market_status', '', 5),
			env.HALT_ARCHIVE!.prepare(ins).bind(day, 'tools/call', 'list_exchanges', 'c1', 2),
			env.HALT_ARCHIVE!.prepare(ins).bind('2026-10-11', 'tools/list', '', '', 9),
		]);
		const record = await buildHoRecordObject(testEnv, day, null, 1, { value: null, reason: 'x' }, AT('2026-10-11T09:30:00Z'), null);
		const counts = record.counts as Record<string, unknown>;
		expect(counts.mcp_requests_by_method).toEqual({ initialize: 4, 'tools/call': 7 });
		expect(counts.mcp_tools_call_by_tool).toEqual({ get_market_status: 5, list_exchanges: 2 });
		expect(counts.mcp_distinct_clients).toBe(2);
		expect('mcp_unavailable_reason' in counts).toBe(false);
		// Control: the day before the first counted day carries null and a reason.
		const before = await buildHoRecordObject(testEnv, '2026-10-09', null, 1, { value: null, reason: 'x' }, AT('2026-10-10T09:30:00Z'), null);
		expect((before.counts as Record<string, unknown>).mcp_requests_by_method).toBeNull();
	});
});

describe('H6 record: admin trigger', () => {
	const MASTER = (env as unknown as { MASTER_API_KEY: string }).MASTER_API_KEY;
	const run = (key?: string) => call('/v5/admin/record/run', { method: 'POST', headers: key === undefined ? {} : { 'X-Oracle-Key': key } });

	it('401 without detail on a missing or wrong key', async () => {
		for (const key of [undefined, '', 'wrong', `${MASTER}x`]) {
			const res = await run(key);
			expect(res.status).toBe(401);
			expect(await res.text()).toBe('{"error":"UNAUTHORIZED"}');
		}
		const { results } = await env.HALT_ARCHIVE!.prepare('SELECT date FROM ho_records').all();
		expect(results).toEqual([]);
	});

	it('the master key builds yesterday only; a second call builds nothing and says so', async () => {
		expect(MASTER).toBeTruthy();
		const first = await run(MASTER);
		expect(first.status).toBe(200);
		const a = await first.json() as Record<string, any>;
		const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
		const yesterday = y.toISOString().slice(0, 10);
		expect(a.result).toBe('built');
		expect(a.built.map((b: { date: string }) => b.date)).toEqual([yesterday]);
		// The unit suite has no network: the registry and the calendars are down,
		// and the record says so instead of being skipped.
		const { record } = await servedRecord(yesterday);
		expect((record.inputs as Record<string, unknown>).registry_index).toBeNull();
		expect(String((record.inputs as Record<string, unknown>).registry_index_unavailable_reason)).toContain('503');
		const second = await (await run(MASTER)).json() as Record<string, any>;
		expect(second.result).toBe('nothing_built');
		expect(second.built).toEqual([]);
		expect(second.message).toContain('already recorded');
		const { results } = await env.HALT_ARCHIVE!.prepare('SELECT date FROM ho_records WHERE date > ?').bind(yesterday).all();
		expect(results).toEqual([]);
	});

	it('GET is not a trigger', async () => {
		expect((await call('/v5/admin/record/run', { headers: { 'X-Oracle-Key': MASTER } })).status).toBe(405);
	});
});

describe('H6 record: the cron and the health check', () => {
	it('the 0 9 * * * branch builds yesterday\'s record after the halt digest', async () => {
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: '0 9 * * *', scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
		const idx = await (await call('/record')).json() as Record<string, any>;
		expect(idx.newest.date).toBe(y.toISOString().slice(0, 10));
		expect(idx.records).toBe(1);
	});

	it('recordProblems passes a fresh record and fails a stale, missing or failed one', () => {
		const now = AT('2026-10-09T10:15:00Z');
		const good = { newest: { date: '2026-10-08' }, failed_steps: [] };
		expect(recordProblems(good, now)).toEqual([]);
		expect(recordProblems({ ...good, newest: { date: '2026-10-07' } }, now)).toEqual(['newest record is 2026-10-07, expected 2026-10-08']);
		expect(recordProblems({ ...good, newest: null }, now)).toEqual(['newest record is none, expected 2026-10-08']);
		expect(recordProblems({ ...good, failed_steps: [{ date: '2026-10-08', step: 'ots_submit', message: 'm' }] }, now)).toHaveLength(1);
		// An older day's failure does not fail today's check; before 10:00 nothing is required.
		expect(recordProblems({ ...good, failed_steps: [{ date: '2026-10-01', step: 'ots_upgrade', message: 'm' }] }, now)).toEqual([]);
		expect(recordProblems({ newest: null, failed_steps: [] }, AT('2026-10-09T09:59:00Z'))).toEqual([]);
	});
});

describe('H6 record: served surfaces', () => {
	it('/record.md explains, lists the check and the limits, and makes no forbidden claim', async () => {
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		const res = await call('/record.md');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
		const md = await res.text();
		for (const s of ['signed', 'hash-chained', 'witnessed by Chirindo Witness, which is HO itself', 'timestamped with OpenTimestamps; a proof becomes a Bitcoin attestation once the calendars confirm it', 'ots verify', '/v5/keys', 'session_id=ho-record']) expect(md).toContain(s);
		const all = md + await (await call('/record')).text() + await (await call('/llms.txt')).text();
		for (const bad of [/tamper-?proof/i, /immutable on the blockchain/i]) expect(all).not.toMatch(bad);
		// Control: the forbidden-phrase scan does fire on a phrase that is there.
		expect(all + ' tamper-proof').toMatch(/tamper-?proof/i);
	});

	it('llms.txt, the api catalog, openapi and the sitemap list /record', async () => {
		const llms = await (await call('/llms.txt')).text();
		expect(llms).toContain('## HO\'s own daily record');
		expect(llms).toContain('witnessed by Chirindo Witness, which is HO itself');
		expect(llms).toContain('timestamped with OpenTimestamps; a timestamp becomes a Bitcoin attestation once the calendars confirm it');
		const catalog = await (await call('/.well-known/api-catalog')).json() as { linkset: { anchor: string }[] };
		expect(catalog.linkset.map((l) => l.anchor)).toContain('https://headlessoracle.com/record');
		const spec = await (await call('/openapi.json')).json() as { paths: Record<string, Record<string, { operationId?: string }>> };
		expect(spec.paths['/record'].get.operationId).toBe('getRecordIndex');
		expect(spec.paths['/record/{date}'].get.operationId).toBe('getRecordByDate');
		expect(spec.paths['/record/{date}/proofs'].get.operationId).toBe('getRecordProofsByDate');
		expect(spec.paths['/record/{date}.ots'].get.operationId).toBe('getRecordOtsByDate');
		expect(spec.paths['/record.md'].get.operationId).toBe('getRecordMarkdown');
		expect(spec.paths['/v5/admin/record/run'].post.operationId).toBe('postAdminRecordRun');
		expect(await (await call('/sitemap.xml')).text()).toContain('<loc>https://headlessoracle.com/record.md</loc>');
	});

	it('unknown dates are 404, malformed paths fall through, and only GET is served', async () => {
		expect((await call('/record/2026-01-01')).status).toBe(404);
		expect((await call('/record/2026-01-01/proofs')).status).toBe(404);
		expect((await call('/record/2026-01-01.ots')).status).toBe(404);
		expect((await call('/record/not-a-date')).status).toBe(404);
		expect((await call('/record', { method: 'POST' })).status).toBe(405);
		// Control: a real date is served.
		await runHoRecordJob(testEnv, { now: AT('2026-09-02T09:30:00Z'), fetch: fakeCalendars().fetchFn });
		expect((await call('/record/2026-09-01')).status).toBe(200);
	});
});
