// B-490 (4): schema_version v5.1, served on request (query parameter
// schema_version=v5.1, MCP argument schema_version). It signs session_phase and
// closure_reason. The default of every route stays v5.0, byte for byte in shape
// and signing. Ruling numbers are the Lead's of 18 Nov 2026.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { clearOverrideCache, sessionPhases, closureReasons, getScheduleDetail, scheduleMics } from '../src';
import { HeadlessOracle } from '../packages/sdk-typescript/src/index';
import FIELD_SETS_V51 from '../docs/receipt-field-sets-v5.1.json';

const MASTER = { 'X-Oracle-Key': 'test_beta_key_1' }; // a key the test configuration accepts
async function call(path: string, init: RequestInit = {}): Promise<Response> {
	clearOverrideCache();
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`https://headlessoracle.com${path}`, init) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
async function receiptOf(path: string, init: RequestInit = {}): Promise<Record<string, string>> {
	const res = await call(path, init);
	expect(res.status).toBe(200);
	const b = await res.json() as Record<string, unknown>;
	return (b.receipt ?? b.signed_receipt ?? b) as Record<string, string>;
}
async function keysSpec(): Promise<Record<string, unknown>> {
	return ((await (await call('/v5/keys')).json()) as Record<string, unknown>).canonical_payload_spec as Record<string, unknown>;
}
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
// Canonicalised over the PUBLISHED list, not the receipt's own keys.
async function verifiesOver(r: Record<string, unknown>, fields: readonly string[]): Promise<boolean> {
	const sorted: Record<string, unknown> = {};
	for (const k of [...fields].sort()) sorted[k] = r[k];
	const key = await crypto.subtle.importKey('raw', hexBytes(env.ED25519_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
	return crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(r.signature as string), new TextEncoder().encode(JSON.stringify(sorted)));
}
async function putEntry(mic: string, entry: Record<string, string>): Promise<void> {
	await env.ORACLE_OVERRIDES.put(mic, JSON.stringify({ reason: 'B-490 table', expires: '2030-01-01T00:00:00Z', ...entry }));
}

afterEach(async () => {
	vi.useRealTimers();
	for (const m of ['XNYS', 'XNAS', 'XJPX', 'XCBT', 'XCOI', 'XLON']) await env.ORACLE_OVERRIDES.delete(m);
	clearOverrideCache();
});

// One instant for each phase the schedule can be in.
const PHASE_AT: Record<string, [string, string]> = {
	regular:         ['XNYS', '2026-04-07T15:00:00Z'], // Tue 11:00 ET
	pre_open:        ['XNYS', '2026-04-07T12:00:00Z'], // Tue 08:00 ET
	post_close:      ['XNYS', '2026-04-07T21:00:00Z'], // Tue 17:00 ET
	lunch_break:     ['XJPX', '2026-04-07T03:00:00Z'], // Tue 12:00 JST
	maintenance:     ['XCBT', '2026-04-07T21:30:00Z'], // Tue 16:30 CDT
	non_trading_day: ['XNYS', '2026-04-11T15:00:00Z'], // Saturday
	unknown:         ['XNYS', '2028-01-04T15:00:00Z'], // no 2028 calendar
};

type Row = { status: string; source: string; phase: string; reason: string; mic: string; at: string; entry?: Record<string, string> };
const ROWS: Row[] = [
	// The schedule (Tier 1), and the fail-closed Tier 2.
	{ status: 'OPEN',    source: 'SCHEDULE', phase: 'regular',         reason: 'none',                 mic: 'XNYS', at: '2026-04-07T15:00:00Z' },
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'non_trading_day', reason: 'weekend',              mic: 'XNYS', at: '2026-04-11T15:00:00Z' },
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'non_trading_day', reason: 'holiday',              mic: 'XNYS', at: '2026-04-03T15:00:00Z' }, // Good Friday
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'pre_open',        reason: 'outside_hours',        mic: 'XNYS', at: '2026-04-07T12:00:00Z' },
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'post_close',      reason: 'outside_hours',        mic: 'XNYS', at: '2026-04-07T21:00:00Z' },
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'post_close',      reason: 'early_close',          mic: 'XNYS', at: '2026-11-27T19:00:00Z' }, // 14:00 ET, closed at 13:00
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'lunch_break',     reason: 'scheduled_break',      mic: 'XJPX', at: '2026-04-07T03:00:00Z' },
	{ status: 'CLOSED',  source: 'SCHEDULE', phase: 'maintenance',     reason: 'scheduled_break',      mic: 'XCBT', at: '2026-04-07T21:30:00Z' },
	{ status: 'UNKNOWN', source: 'SYSTEM',   phase: 'unknown',         reason: 'calendar_unavailable', mic: 'XNYS', at: '2028-01-04T15:00:00Z' },
	{ status: 'UNKNOWN', source: 'SYSTEM',   phase: 'unknown',         reason: 'determination_error',  mic: 'XNYS', at: '2026-04-07T15:00:00Z', entry: { status: 'OPEN', origin: 'operator' } },
];
// Override entries (Tier 0): every allowed status of an operator's entry, and the
// monitor's HALTED, in every phase the schedule can be in.
for (const [phase, [mic, at]] of Object.entries(PHASE_AT)) {
	for (const status of ['HALTED', 'CLOSED', 'UNKNOWN']) {
		ROWS.push({ status, source: 'OVERRIDE', phase, reason: 'operator_override', mic, at, entry: { status, origin: 'operator' } });
	}
	ROWS.push({ status: 'HALTED', source: 'OVERRIDE', phase, reason: 'feed_reported_not_open', mic, at, entry: { status: 'HALTED', origin: 'monitor', source: 'REALTIME' } });
}

describe('B-490 (4) rulings 2, 3, 4, 5, 9: every (status, session_phase, closure_reason) the builder can produce, each signed and verified over the published v5.1 list', () => {
	it('the table has 38 rows: 10 from the schedule and the fail-closed path, 21 operator entries, 7 monitor entries', () => {
		expect(ROWS.length).toBe(38);
		expect(new Set(ROWS.map((r) => `${r.status}/${r.phase}/${r.reason}`)).size).toBe(38);
	});
	it('closure_reason is none exactly when the status is OPEN by schedule (ruling 3)', () => {
		for (const r of ROWS) expect(r.reason === 'none').toBe(r.status === 'OPEN' && r.source === 'SCHEDULE');
		for (const r of ROWS) expect(r.status === 'OPEN').toBe(r.reason === 'none');
	});
	it('every value used is in the published value lists, and no value claims an unscheduled halt', () => {
		for (const r of ROWS) { expect(sessionPhases()).toContain(r.phase); expect(closureReasons()).toContain(r.reason); }
		for (const v of [...sessionPhases(), ...closureReasons()]) expect(v).not.toMatch(/halt|circuit|outage/i);
	});
	for (const r of ROWS) {
		it(`${r.status} ${r.phase} ${r.reason} (${r.mic} at ${r.at}${r.entry ? `, entry ${JSON.stringify(r.entry)}` : ''})`, async () => {
			vi.setSystemTime(new Date(r.at));
			if (r.entry) await putEntry(r.mic, r.entry);
			const rec = await receiptOf(`/v5/demo?mic=${r.mic}&schema_version=v5.1`);
			expect([rec.status, rec.source, rec.session_phase, rec.closure_reason, rec.schema_version]).toEqual([r.status, r.source, r.phase, r.reason, 'v5.1']);
			const v51 = (await keysSpec()).versions as Record<string, Record<string, string[]>>;
			const list = r.source === 'OVERRIDE' ? v51['v5.1'].override_fields : v51['v5.1'].receipt_fields;
			expect(Object.keys(rec).filter((k) => k !== 'signature').sort()).toEqual([...list].sort());
			expect(await verifiesOver(rec, list)).toBe(true);
		});
	}
});

describe('B-490 (4): every schedule path maps to exactly one pair (rulings 4, 5, 6)', () => {
	const PATHS: [string, string, string, string, string][] = [
		['XNYS', '2026-11-27T13:00:00Z', 'CLOSED', 'pre_open',        'outside_hours'],   // early-close day, before the open
		['XNYS', '2026-11-27T16:00:00Z', 'OPEN',   'regular',         'none'],            // early-close day, in session
		['XNYS', '2026-11-27T19:00:00Z', 'CLOSED', 'post_close',      'early_close'],     // early-close day, after the early close
		['XHKG', '2026-04-07T04:30:00Z', 'CLOSED', 'lunch_break',     'scheduled_break'], // 12:30 HKT
		['XSHG', '2026-04-07T04:00:00Z', 'CLOSED', 'lunch_break',     'scheduled_break'], // 12:00 CST
		['XCBT', '2026-04-12T15:00:00Z', 'CLOSED', 'pre_open',        'outside_hours'],   // Sun 10:00 CDT, the tail of Saturday
		['XCBT', '2026-04-10T23:00:00Z', 'CLOSED', 'post_close',      'outside_hours'],   // Fri 18:00 CDT (B-490 (2))
		['XCBT', '2026-04-11T15:00:00Z', 'CLOSED', 'non_trading_day', 'weekend'],         // Saturday
		['XCBT', '2026-04-13T23:00:00Z', 'OPEN',   'regular',         'none'],            // Mon 18:00 CDT, Tuesday's session
		['XSAU', '2026-04-10T09:00:00Z', 'CLOSED', 'non_trading_day', 'weekend'],         // Friday in Riyadh
		['XSAU', '2026-04-12T09:00:00Z', 'OPEN',   'regular',         'none'],            // Sunday 12:00 in Riyadh
		['XCOI', '2026-04-11T23:59:30Z', 'OPEN',   'regular',         'none'],            // ruling 6
		['XBIN', '2028-01-04T12:00:00Z', 'OPEN',   'regular',         'none'],            // ruling 6
	];
	for (const [mic, at, status, phase, reason] of PATHS) {
		it(`${mic} at ${at}: ${status} ${phase} ${reason}`, async () => {
			vi.setSystemTime(new Date(at));
			const rec = await receiptOf(`/v5/demo?mic=${mic}&schema_version=v5.1`);
			expect([rec.status, rec.session_phase, rec.closure_reason]).toEqual([status, phase, reason]);
		});
	}
	it('XCOI and XBIN never read non_trading_day: every hour of a week and of 2028 (ruling 6)', () => {
		for (const mic of ['XCOI', 'XBIN']) {
			for (const start of [Date.parse('2026-04-06T00:00:00Z'), Date.parse('2028-02-28T00:00:00Z')]) {
				for (let h = 0; h < 24 * 7; h++) {
					const d = getScheduleDetail(mic, new Date(start + h * 3_600_000 + 59 * 60_000));
					expect([d.status, d.phase, d.closure]).toEqual(['OPEN', 'regular', 'none']);
				}
			}
		}
	});
	// Rev 4: one test per exchange (the same 28 receipts), so no test runs long.
	it('the fields appear for all 28 exchanges (ruling 7): there are 28', () => {
		expect(scheduleMics().length).toBe(28);
	});
	for (const mic of scheduleMics()) {
		it(`the fields appear for ${mic} (ruling 7)`, async () => {
			vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
			const rec = await receiptOf(`/v5/demo?mic=${mic}&schema_version=v5.1`);
			expect(sessionPhases()).toContain(rec.session_phase);
			expect(closureReasons()).toContain(rec.closure_reason);
		});
	}
	it('an entry with no recorded origin is signed operator_override, never feed_reported_not_open, even when it says source REALTIME (ruling 3)', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'written before origins were recorded', expires: '2030-01-01T00:00:00Z' }));
		const rec = await receiptOf('/v5/demo?mic=XNYS&schema_version=v5.1');
		expect([rec.status, rec.source, rec.session_phase, rec.closure_reason]).toEqual(['HALTED', 'OVERRIDE', 'regular', 'operator_override']);
	});
	it('the entry the old monitor wrote (no origin, its exact bytes) is signed feed_reported_not_open, on demo and in the batch (B-490 (3) rev 2)', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const legacy = JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'Real-time halt detected by halt monitor (source: polygon)', expires: '2026-04-07T16:30:00.000Z', auto_clear_at: '2026-04-07T16:30:00.000Z', detected_at: '2026-04-07T14:30:00.000Z' });
		await env.ORACLE_OVERRIDES.put('XNYS', legacy);
		const rec = await receiptOf('/v5/demo?mic=XNYS&schema_version=v5.1');
		expect([rec.status, rec.source, rec.session_phase, rec.closure_reason]).toEqual(['HALTED', 'OVERRIDE', 'regular', 'feed_reported_not_open']);
		const b = await (await call('/v5/batch?mics=XNYS&schema_version=v5.1', { headers: MASTER })).json() as Record<string, unknown>;
		expect((b.exchanges as Record<string, Record<string, string>>).XNYS.closure_reason).toBe('feed_reported_not_open');
		const v50 = await receiptOf('/v5/demo?mic=XNYS');
		expect([v50.status, v50.source, v50.schema_version]).toEqual(['HALTED', 'OVERRIDE', 'v5.0']);
	});
});

const V50 = ['coverage', 'expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic', 'public_key_id', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'];
const V50_OVERRIDE = [...V50, 'reason'].sort();

describe('B-490 (4) ruling 1: the default of every route is v5.0, unchanged in shape and signing', () => {
	const ROUTES: [string, RequestInit][] = [
		['/v5/demo?mic=XNYS', {}],
		['/v5/status?mic=XNYS', { headers: MASTER }],
		['/v1/status/XNYS', {}],
		['/v5/status/realtime?mic=XNYS', { headers: MASTER }],
		['/v5/demo?mic=XNYS&schema_version=v5.0', {}],
	];
	for (const [path, init] of ROUTES) {
		it(`${path}: exactly the twelve v5.0 fields and the signature, schema_version v5.0, verifying over the v5.0 list`, async () => {
			vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
			const res = await call(path, init);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).not.toContain('session_phase');
			expect(text).not.toContain('closure_reason');
			const b = JSON.parse(text) as Record<string, unknown>;
			const rec = (b.receipt ?? b.signed_receipt) as Record<string, string>;
			expect(Object.keys(rec)).toEqual(['receipt_id', 'issued_at', 'expires_at', 'issuer', 'mic', 'status', 'source', 'halt_detection', 'coverage', 'receipt_mode', 'schema_version', 'public_key_id', 'signature']);
			expect(rec.schema_version).toBe('v5.0');
			expect(await verifiesOver(rec, V50)).toBe(true);
		});
	}
	it('an override receipt by default: the v5.0 override fields', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		await putEntry('XNYS', { status: 'HALTED', origin: 'monitor', source: 'REALTIME' });
		const rec = await receiptOf('/v5/demo?mic=XNYS');
		expect(Object.keys(rec).filter((k) => k !== 'signature').sort()).toEqual(V50_OVERRIDE);
		expect(await verifiesOver(rec, V50_OVERRIDE)).toBe(true);
	});
	it('/v5/batch by default: v5.0 envelope, each exchanges entry only status and source', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const b = await (await call('/v5/batch?mics=XNYS,XJPX', { headers: MASTER })).json() as Record<string, unknown>;
		expect(b.schema_version).toBe('v5.0');
		for (const e of Object.values(b.exchanges as Record<string, Record<string, string>>)) expect(Object.keys(e)).toEqual(['status', 'source']);
		expect(JSON.stringify(b)).not.toContain('session_phase');
	});
	it('MCP get_market_status by default: v5.0', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const res = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }) });
		const rpc = await res.json() as { result: { content: { text: string }[] } };
		const rec = JSON.parse(rpc.result.content[0].text) as Record<string, string>;
		expect(rec.schema_version).toBe('v5.0');
		expect(Object.keys(rec).filter((k) => k !== 'signature').sort()).toEqual(V50);
	});
	it('/v5/keys keeps the v5.0 lists where they were, and adds per-version lists', async () => {
		const spec = await keysSpec();
		expect(spec.receipt_fields).toEqual(V50);
		expect(spec.override_fields).toEqual(V50_OVERRIDE);
		expect(spec.default_schema_version).toBe('v5.0');
		const v = spec.versions as Record<string, Record<string, string[]>>;
		expect(v['v5.0'].receipt_fields).toEqual(V50);
		expect(v['v5.1'].receipt_fields).toEqual([...V50, 'closure_reason', 'session_phase'].sort());
		expect(v['v5.1'].override_fields).toEqual([...V50, 'closure_reason', 'reason', 'session_phase'].sort());
	});
});

describe('B-490 (4): asking for a version', () => {
	for (const [path, init] of [['/v5/demo?mic=XNYS', {}], ['/v5/status?mic=XNYS', { headers: MASTER }], ['/v1/status/XNYS', {}], ['/v5/batch?mics=XNYS', { headers: MASTER }], ['/v5/status/realtime?mic=XNYS', { headers: MASTER }], ['/v5/status/x402?mic=XNYS', {}]] as [string, RequestInit][]) {
		for (const bad of ['v5.2', '5.1', '', 'V5.1']) {
			it(`${path} with schema_version=${JSON.stringify(bad)}: 400 UNSUPPORTED_SCHEMA_VERSION before any other work`, async () => {
				const res = await call(`${path}&schema_version=${encodeURIComponent(bad)}`.replace('XNYS&', 'XNYS&').replace(/^(\/v1\/status\/XNYS)&/, '$1?'), init);
				expect(res.status).toBe(400);
				const b = await res.json() as Record<string, unknown>;
				expect(b.error).toBe('UNSUPPORTED_SCHEMA_VERSION');
				expect(b.supported).toEqual(['v5.0', 'v5.1']);
			});
		}
	}
	it('MCP get_market_status with schema_version v5.1 signs both fields; an unknown version is an error result', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const rpcCall = async (args: Record<string, string>) => {
			const res = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_status', arguments: args } }) });
			return (await res.json() as { result: { isError?: boolean; content: { text: string }[] } }).result;
		};
		const ok = JSON.parse((await rpcCall({ mic: 'XNYS', schema_version: 'v5.1' })).content[0].text) as Record<string, string>;
		expect([ok.schema_version, ok.session_phase, ok.closure_reason]).toEqual(['v5.1', 'regular', 'none']);
		const bad = await rpcCall({ mic: 'XNYS', schema_version: 'v9' });
		expect(bad.isError).toBe(true);
		expect(JSON.parse(bad.content[0].text).error).toBe('UNSUPPORTED_SCHEMA_VERSION');
	});
});

describe('B-490 (4) ruling 8: the v5.1 batch', () => {
	it('each exchanges entry signs status, source, session_phase, closure_reason in that order; the envelope, as served (issuer included), verifies over the published batch list', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const b = await (await call('/v5/batch?mics=XNYS,XJPX&schema_version=v5.1', { headers: MASTER })).json() as Record<string, unknown>;
		expect(b.schema_version).toBe('v5.1');
		const ex = b.exchanges as Record<string, Record<string, string>>;
		expect(Object.keys(ex.XNYS)).toEqual(['status', 'source', 'session_phase', 'closure_reason']);
		expect(ex.XNYS).toEqual({ status: 'OPEN', source: 'SCHEDULE', session_phase: 'regular', closure_reason: 'none' });
		expect(ex.XJPX).toEqual({ status: 'CLOSED', source: 'SCHEDULE', session_phase: 'pre_open', closure_reason: 'outside_hours' }); // 00:00 JST on Wednesday
		const v = (await keysSpec()).versions as Record<string, Record<string, string[]>>;
		const env5 = { ...b, exchanges: JSON.stringify(b.exchanges), all_open: String(b.all_open) } as Record<string, unknown>;
		expect(await verifiesOver(env5, v['v5.1'].batch_fields)).toBe(true);
	});
	it('a batch entry HALTED by an override signs source OVERRIDE and the entry\'s reason, never SCHEDULE', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		await putEntry('XNYS', { status: 'HALTED', origin: 'monitor', source: 'REALTIME' });
		const b = await (await call('/v5/batch?mics=XNYS&schema_version=v5.1', { headers: MASTER })).json() as Record<string, unknown>;
		expect((b.exchanges as Record<string, Record<string, string>>).XNYS).toEqual({ status: 'HALTED', source: 'OVERRIDE', session_phase: 'regular', closure_reason: 'feed_reported_not_open' });
	});
});

describe('B-490 (4): the published documents describe what is signed', () => {
	it('docs/receipt-field-sets-v5.1.json equals the /v5/keys v5.1 lists and the value lists', async () => {
		const v = (await keysSpec()).versions as Record<string, Record<string, string[]>>;
		const rows = FIELD_SETS_V51.field_sets as { id: string; signed_fields: string[]; override_signed_fields?: string[]; exchange_members?: string[] }[];
		const m1 = rows.find((r) => r.id === 'M1')!; const b1 = rows.find((r) => r.id === 'B1')!;
		expect(m1.signed_fields).toEqual(v['v5.1'].receipt_fields);
		expect(m1.override_signed_fields).toEqual(v['v5.1'].override_fields);
		expect(b1.signed_fields).toEqual(v['v5.1'].batch_fields);
		expect(b1.exchange_members).toEqual(v['v5.1'].batch_exchange_members);
		expect(FIELD_SETS_V51.session_phase_values).toEqual(sessionPhases());
		expect(FIELD_SETS_V51.closure_reason_values).toEqual(closureReasons());
	});
	it('the OpenAPI SignedReceipt describes both fields with exactly the published values, and the routes take schema_version', async () => {
		const spec = await (await call('/openapi.json')).json() as { components: { schemas: { SignedReceipt: { properties: Record<string, { enum?: string[] }> } } }; paths: Record<string, { get?: { parameters?: { name: string }[] } }> };
		const p = spec.components.schemas.SignedReceipt.properties;
		expect(p.session_phase.enum).toEqual(sessionPhases());
		expect(p.closure_reason.enum).toEqual(closureReasons());
		for (const route of ['/v5/demo', '/v5/status', '/v5/batch', '/v5/status/realtime']) {
			expect(spec.paths[route].get!.parameters!.map((x) => x.name)).toContain('schema_version');
		}
	});
	it('llms-full.txt names both fields, every value, and how to ask for v5.1', async () => {
		const t = await (await call('/llms-full.txt')).text();
		expect(t).toContain('schema_version=v5.1');
		for (const v of [...sessionPhases(), ...closureReasons()]) expect(t).toContain(`\`${v}\``);
	});
});

describe('B-490 (4) ruling 1: verifiers', () => {
	// The repository's TypeScript SDK canonicalises every field but signature.
	for (const version of ['v5.0', 'v5.1']) {
		for (const [mic, at] of [['XNYS', '2026-04-07T15:00:00Z'], ['XCOI', '2026-04-07T23:59:30Z'], ['XCBT', '2026-04-10T23:00:00Z'], ['XJPX', '2026-04-07T03:00:00Z']]) {
			it(`the TypeScript SDK verifies a ${version} receipt for ${mic}, and it equals the published ${version} list`, async () => {
				vi.setSystemTime(new Date(at));
				const rec = await receiptOf(`/v5/demo?mic=${mic}${version === 'v5.1' ? '&schema_version=v5.1' : ''}`);
				// For the kit's acceptance step, which verifies the same receipt with the
				// Python SDK: one line per receipt (public values only).
				console.log(`B490_RECEIPT ${JSON.stringify({ version, mic, public_key: env.ED25519_PUBLIC_KEY, receipt: rec })}`);
				const sdk = new HeadlessOracle({ publicKey: env.ED25519_PUBLIC_KEY, baseUrl: 'http://sdk.invalid' });
				expect(await sdk.verifyOffline(rec as never)).toEqual({ valid: true, expired: false, reason: 'SIGNATURE_VALID' });
				const v = (await keysSpec()).versions as Record<string, Record<string, string[]>>;
				expect(Object.keys(rec).filter((k) => k !== 'signature').sort()).toEqual(v[version].receipt_fields);
			});
		}
	}
	it('a verifier that reads the old /v5/keys shape (top-level receipt_fields) verifies every v5.0 receipt, and fails closed on a v5.1 one, as documented', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const old = (await keysSpec()).receipt_fields as string[];
		expect(await verifiesOver(await receiptOf('/v5/demo?mic=XNYS'), old)).toBe(true);
		expect(await verifiesOver(await receiptOf('/v5/demo?mic=XNYS&schema_version=v5.1'), old)).toBe(false);
	});
});
