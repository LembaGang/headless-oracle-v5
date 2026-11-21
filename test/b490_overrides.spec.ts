// B-490 (3): override entries. The halt monitor records itself as the origin of
// what it writes, never overwrites or clears an entry it did not write, and an
// entry may set only HALTED, CLOSED or UNKNOWN (anything else signs the
// fail-closed UNKNOWN). Red against the parent commit where marked.
import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { clearOverrideCache, parseOverrideEntry } from '../src';

const OPEN_TUESDAY = '2026-04-07T15:00:00Z'; // XNYS and XNAS scheduled OPEN (11:00 ET)
const future = () => new Date(Date.parse(OPEN_TUESDAY) + 60 * 60 * 1000).toISOString();

async function demo(mic: string): Promise<Record<string, string>> {
	clearOverrideCache();
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com/v5/demo?mic=${mic}`) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	expect(res.status).toBe(200);
	return res.json() as Promise<Record<string, string>>;
}

// One minute-cron run with the feed answering `nyse` and `nasdaq` as given.
// Rev 4: with no HALT_ARCHIVE binding, so the cron's halt-archive capture (a
// ctx.waitUntil task the monitor does not use) returns at once and no test
// waits on it: no test of this file runs long.
async function monitorRun(feed: string): Promise<void> {
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (u.includes('api.polygon.io')) return new Response(JSON.stringify({ market: feed, exchanges: { nyse: feed, nasdaq: feed } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		return new Response('stubbed: no network in this test', { status: 503 });
	}) as typeof fetch;
	try {
		const ctx = createExecutionContext();
		await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse(OPEN_TUESDAY), cron: '* * * * *' }), { ...env, POLYGON_API_KEY: 'test-only', HALT_ARCHIVE: undefined } as never, ctx);
		await waitOnExecutionContext(ctx);
	} finally {
		globalThis.fetch = orig;
	}
}

beforeEach(() => { vi.setSystemTime(new Date(OPEN_TUESDAY)); });
afterEach(async () => { vi.useRealTimers(); await env.ORACLE_OVERRIDES.delete('XNYS'); await env.ORACLE_OVERRIDES.delete('XNAS'); clearOverrideCache(); });

describe('B-490 (3): the halt monitor and other entries', () => {
	it('a monitor-written entry records origin monitor (red: the parent records none)', async () => {
		await monitorRun('closed');
		const e = JSON.parse((await env.ORACLE_OVERRIDES.get('XNYS'))!) as Record<string, string>;
		expect(e.status).toBe('HALTED');
		expect(e.origin).toBe('monitor');
	});

	it('the monitor does not overwrite a live operator entry (red: the parent overwrites it)', async () => {
		const op = JSON.stringify({ status: 'CLOSED', reason: 'Exchange notice', expires: future(), origin: 'operator' });
		await env.ORACLE_OVERRIDES.put('XNYS', op);
		await monitorRun('closed');
		expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBe(op);
	});

	it('the monitor does not overwrite a live entry with no recorded origin (red: the parent overwrites it)', async () => {
		const legacy = JSON.stringify({ status: 'HALTED', reason: 'Circuit breaker', expires: future() });
		await env.ORACLE_OVERRIDES.put('XNYS', legacy);
		await monitorRun('closed');
		expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBe(legacy);
	});

	it('the monitor replaces an expired operator entry (red: the parent records no origin)', async () => {
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'CLOSED', reason: 'old', expires: '2026-04-07T14:00:00Z', origin: 'operator' }));
		await monitorRun('closed');
		expect((JSON.parse((await env.ORACLE_OVERRIDES.get('XNYS'))!) as Record<string, string>).origin).toBe('monitor');
	});

	// Rev 4: one monitor run per test. The entry the first run would write is
	// taken from that run in a test of its own (the shape is checked above) and
	// given to the second.
	it('when the feed says open again the monitor clears its own entry: the entry the closed feed writes', async () => {
		await monitorRun('closed');
		const e = JSON.parse((await env.ORACLE_OVERRIDES.get('XNYS'))!) as Record<string, string>;
		expect([e.status, e.source, e.origin]).toEqual(['HALTED', 'REALTIME', 'monitor']);
	});
	it('when the feed says open again the monitor clears its own entry: cleared', async () => {
		const own = JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'Real-time halt detected by halt monitor (source: polygon)', expires: future(), origin: 'monitor', detected_at: OPEN_TUESDAY });
		await env.ORACLE_OVERRIDES.put('XNYS', own);
		await monitorRun('open');
		expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBeNull();
	});

	it('when the feed says open the monitor does not clear an operator entry, nor one with no origin (red: the parent clears a REALTIME entry with no origin)', async () => {
		const op = JSON.stringify({ status: 'HALTED', reason: 'Exchange notice', expires: future(), origin: 'operator' });
		const legacy = JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'written before origins', expires: future() });
		await env.ORACLE_OVERRIDES.put('XNYS', op);
		await env.ORACLE_OVERRIDES.put('XNAS', legacy);
		await monitorRun('open');
		expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBe(op);
		expect(await env.ORACLE_OVERRIDES.get('XNAS')).toBe(legacy);
	});
});

describe('B-490 (3): an override entry may set only HALTED, CLOSED or UNKNOWN', () => {
	for (const status of ['HALTED', 'CLOSED', 'UNKNOWN']) {
		it(`an operator entry with status ${status} is signed as ${status} by OVERRIDE`, async () => {
			await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status, reason: 'Exchange notice', expires: future(), origin: 'operator' }));
			const r = await demo('XNYS');
			expect(r.status).toBe(status);
			expect(r.source).toBe('OVERRIDE');
			expect(r.reason).toBe('Exchange notice');
		});
	}
	for (const [label, entry] of [
		['status OPEN', { status: 'OPEN', reason: 'x', origin: 'operator' }],
		['an unknown status', { status: 'MAYBE', reason: 'x', origin: 'operator' }],
		['a monitor entry that is not HALTED', { status: 'CLOSED', reason: 'x', origin: 'monitor' }],
		['an unknown origin', { status: 'HALTED', reason: 'x', origin: 'someone' }],
	] as [string, Record<string, string>][]) {
		it(`an entry with ${label} is not signed as an override: the fail-closed UNKNOWN (red where the parent signs it)`, async () => {
			await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ ...entry, expires: future() }));
			const r = await demo('XNYS');
			expect(r.status).toBe('UNKNOWN');
			expect(r.source).toBe('SYSTEM');
			expect(JSON.parse(r.coverage).unknown_reason).toBe('DETERMINATION_ERROR');
		});
	}
});

// B-490 (3), rev 2: the halt monitor of ae81d4d and before (unchanged since
// 623b155) wrote its entry with no origin. This is that entry, byte for byte
// as its runHaltMonitor serialised it: six keys in this order, status HALTED,
// source REALTIME, its own reason text naming polygon or alpaca, expires and
// auto_clear_at equal and exactly two hours after detected_at, both as
// toISOString() writes them. The new code recognises exactly these bytes as
// the monitor's own (it was the only writer of that shape: no route writes
// ORACLE_OVERRIDES, and the runbook's form has none of those keys).
function legacyMonitorEntry(detectedAt: string, src = 'polygon'): string {
	const expires = new Date(Date.parse(detectedAt) + 2 * 60 * 60 * 1000).toISOString();
	return JSON.stringify({
		status:        'HALTED',
		source:        'REALTIME',
		reason:        `Real-time halt detected by halt monitor (source: ${src})`,
		expires,
		auto_clear_at: expires,
		detected_at:   detectedAt,
	});
}

describe('B-490 (3) rev 2: entries the monitor wrote before origins were recorded', () => {
	it('a legacy monitor entry, the feed now open: the new monitor clears it (red: rev 1 kept it as an operator entry)', async () => {
		await env.ORACLE_OVERRIDES.put('XNYS', legacyMonitorEntry('2026-04-07T14:30:00.000Z'));
		await monitorRun('open');
		expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBeNull();
	});

	it('a legacy monitor entry, the feed still not open: refreshed as the monitor\'s own, and the minute after its old expiry still reads HALTED (red: rev 1 left it to expire and the schedule read OPEN)', async () => {
		const detected = new Date(Date.parse(OPEN_TUESDAY) - (2 * 60 * 60 - 30) * 1000).toISOString(); // expires 30 s after this run
		await env.ORACLE_OVERRIDES.put('XNYS', legacyMonitorEntry(detected, 'alpaca'));
		await monitorRun('closed');
		const e = JSON.parse((await env.ORACLE_OVERRIDES.get('XNYS'))!) as Record<string, string>;
		expect(e.origin).toBe('monitor');
		expect(Date.parse(e.expires)).toBe(Date.parse(OPEN_TUESDAY) + 2 * 60 * 60 * 1000);
		vi.setSystemTime(new Date(Date.parse(OPEN_TUESDAY) + 60 * 1000)); // past the old expiry, before the next run
		const r = await demo('XNYS');
		expect(r.status).toBe('HALTED');
		expect(r.source).toBe('OVERRIDE');
	});

	it('the legacy monitor entry reads as the monitor\'s (origin inferred, not recorded) (red: rev 1 read it as an operator\'s)', () => {
		const e = parseOverrideEntry(legacyMonitorEntry('2026-04-07T14:30:00.000Z'), new Date(OPEN_TUESDAY))!;
		expect(e.origin).toBe('monitor');
		expect(e.origin_recorded).toBe(false);
	});

	// Rev 4: one monitor run per test (the feed open; the feed not open).
	for (const feed of ['open', 'closed']) {
		it(`a legacy operator entry (the runbook form, no origin) is untouched by the monitor, the feed ${feed === 'open' ? 'open' : 'not open'}`, async () => {
			const op = JSON.stringify({ status: 'HALTED', reason: 'Circuit breaker', expires: future() });
			await env.ORACLE_OVERRIDES.put('XNYS', op);
			await monitorRun(feed);
			expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBe(op);
			expect(parseOverrideEntry(op, new Date(OPEN_TUESDAY))!.origin).toBe('operator');
		});
	}

	const det = '2026-04-07T14:30:00.000Z';
	const base = JSON.parse(legacyMonitorEntry(det)) as Record<string, string>;
	const nearMisses: Array<[string, string]> = [
		['another reason text', JSON.stringify({ ...base, reason: 'Real-time halt detected by an operator' })],
		['another feed named in the reason', JSON.stringify({ ...base, reason: 'Real-time halt detected by halt monitor (source: manual)' })],
		['one key more', JSON.stringify({ ...base, note: 'x' })],
		['the keys in another order', JSON.stringify({ source: base.source, status: base.status, reason: base.reason, expires: base.expires, auto_clear_at: base.auto_clear_at, detected_at: base.detected_at })],
		['expires not two hours after detected_at', JSON.stringify({ ...base, expires: '2026-04-07T17:00:00.000Z', auto_clear_at: '2026-04-07T17:00:00.000Z' })],
		['auto_clear_at not equal to expires', JSON.stringify({ ...base, auto_clear_at: '2026-04-07T16:31:00.000Z' })],
		['a time not in toISOString form', JSON.stringify({ ...base, detected_at: '2026-04-07T14:30:00Z' })],
		['status CLOSED', JSON.stringify({ ...base, status: 'CLOSED' })],
		['white space in the bytes', JSON.stringify(base, null, 1)],
	];
	for (const [label, raw] of nearMisses) {
		it(`a near miss (${label}) is not the old monitor's: an operator entry, left alone`, async () => {
			expect(parseOverrideEntry(raw, new Date(OPEN_TUESDAY))!.origin).toBe('operator');
			await env.ORACLE_OVERRIDES.put('XNYS', raw);
			await monitorRun('open');
			expect(await env.ORACLE_OVERRIDES.get('XNYS')).toBe(raw);
		});
	}
});
