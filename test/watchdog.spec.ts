// B-438 T2: the watchdog turns /record red when the M-1 snapshot job stops
// reaching our witness or ho-radar skips a day, with nobody watching. No live
// network: every outbound call goes through the fetch seam.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { clearWitnessSchemaCache, ensureWitnessSchema, ensureHoRecordSchema, clearHoRecordSchemaCache } from '../src';

const M1_KID = 'JgXFlLtC88UAIK811_ptXkq5Lb_k6E1rCe0Auahg7G4';
const NOW = new Date('2026-11-03T10:07:00Z');
const RADAR_URL = 'https://raw.githubusercontent.com/LembaGang/ho-radar/main/data/2026-11-02/summary.json';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Mod = {
	runWatchdog?: (e: unknown, o?: { now?: Date; fetch?: Fetch }) => Promise<Record<string, unknown>>;
	watchdogRadarDate?: (now: Date) => string;
};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init), env as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

async function watchdog(opts: { now?: Date; fetch?: Fetch } = {}, e: unknown = env): Promise<Record<string, unknown>> {
	const mod = await import('../src') as unknown as Mod;
	expect(typeof mod.runWatchdog, 'runWatchdog is exported').toBe('function');
	return mod.runWatchdog!(e, { now: NOW, ...opts });
}

// A stub for the outside world: the radar answers `radarStatus`, Resend answers 200.
function stub(radarStatus: number | 'throw', calls: string[] = []): Fetch {
	return async (input) => {
		calls.push(input);
		if (input.includes('ho-radar')) {
			if (radarStatus === 'throw') throw new Error('network down');
			return new Response(radarStatus === 200 ? '{}' : 'Not Found', { status: radarStatus });
		}
		return new Response('{"id":"x"}', { status: 200 });
	};
}

async function seedCheckpoint(kid: string, ageHours: number): Promise<void> {
	const at = new Date(NOW.getTime() - ageHours * 3_600_000).toISOString();
	await env.WITNESS_DB!.prepare(`INSERT INTO witness_checkpoints (kid, session_id, count, last_entry_hash, checkpoint_jcs, checkpoint_sha256, public_key_x, received_at, fork, receipt_json, created_at)
		VALUES (?, ?, 1, 'h', '{}', 'sha256:x', 'x', ?, 'false', '{}', ?)`).bind(kid, `ho-m1-${ageHours}`, at, at).run();
}

async function failedSteps(): Promise<Array<{ step: string; message: string }>> {
	const idx = await (await call('/record', { headers: { Accept: 'application/json' } })).json() as { failed_steps: Array<{ step: string; message: string }> };
	return idx.failed_steps;
}

describe('B-438 T2: the watchdog', () => {
	beforeEach(async () => {
		clearWitnessSchemaCache();
		await ensureWitnessSchema(env as never);
		await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
		clearHoRecordSchemaCache();
		await ensureHoRecordSchema(env as never);
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_record_proofs').run();
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_records').run();
		await env.HALT_ARCHIVE!.prepare('INSERT INTO ho_records (date, sequence, record_json, record_sha256, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind('2026-11-02', 1, '{"late":false}', 'sha256:' + '0'.repeat(64), 'sha256:' + '1'.repeat(64), NOW.toISOString()).run();
		for (const k of ['watchdog_health', 'watchdog_radar_seen:2026-11-02', 'watchdog_radar_seen:2026-11-01']) await env.ORACLE_TELEMETRY.delete(k);
	});

	it('a fresh M-1 checkpoint and a published radar summary name no failed step, and metrics show both', async () => {
		await seedCheckpoint(M1_KID, 1);
		const calls: string[] = [];
		await watchdog({ fetch: stub(200, calls) });
		expect(await failedSteps()).toEqual([]);
		expect(calls).toEqual([RADAR_URL]);
		const m = await (await call('/v5/metrics/public')).json() as { watchdog: Record<string, unknown> };
		expect(m.watchdog).toMatchObject({
			m1_newest_checkpoint_age_hours: 1,
			m1_newest_checkpoint_at: '2026-11-03T09:07:00.000Z',
			radar_date: '2026-11-02',
			radar_yesterday_summary: true,
			computed_at: NOW.toISOString(),
		});
		expect(String(m.watchdog.rule)).toContain(M1_KID);
	});

	it('an M-1 checkpoint older than 5 hours names watchdog_m1; a fresh one clears it', async () => {
		await seedCheckpoint(M1_KID, 6);
		await watchdog({ fetch: stub(200) });
		const steps = await failedSteps();
		expect(steps.map((s) => s.step)).toEqual(['watchdog_m1']);
		expect(steps[0].message).toContain('6h ago; limit 5h');
		await seedCheckpoint(M1_KID, 0.5);
		await watchdog({ fetch: stub(200) });
		expect(await failedSteps()).toEqual([]);
	});

	it('exactly 5 hours is still fresh; just over is not', async () => {
		await seedCheckpoint(M1_KID, 5);
		await watchdog({ fetch: stub(200) });
		expect(await failedSteps()).toEqual([]);
		await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
		await seedCheckpoint(M1_KID, 5.02);
		await watchdog({ fetch: stub(200) });
		expect((await failedSteps()).map((s) => s.step)).toEqual(['watchdog_m1']);
	});

	it('no checkpoint at all for the M-1 kid names watchdog_m1, even when another kid is fresh', async () => {
		await seedCheckpoint('pxKjFbY1MyoRwG3ikOUfi0WJ0qKg83_GYUnaiDlR2Ik', 0.1);
		const h = await watchdog({ fetch: stub(200) });
		expect(h.m1_newest_checkpoint_age_hours).toBeNull();
		const steps = await failedSteps();
		expect(steps.map((s) => s.step)).toEqual(['watchdog_m1']);
		expect(steps[0].message).toContain(`no witness checkpoint for kid ${M1_KID}`);
	});

	it('a missing radar summary names watchdog_radar; a 200 does not, and is not fetched again that day', async () => {
		await seedCheckpoint(M1_KID, 1);
		await watchdog({ fetch: stub(404) });
		const steps = await failedSteps();
		expect(steps.map((s) => s.step)).toEqual(['watchdog_radar']);
		expect(steps[0].message).toContain(`GET ${RADAR_URL}: HTTP 404`);
		const m = await (await call('/v5/metrics/public')).json() as { watchdog: Record<string, unknown> };
		expect(m.watchdog.radar_yesterday_summary).toBe(false);

		const calls: string[] = [];
		await watchdog({ fetch: stub(200, calls) });
		expect(await failedSteps()).toEqual([]);
		await watchdog({ fetch: stub(404, calls) });
		expect(calls, 'a summary seen once is not fetched again').toEqual([RADAR_URL]);
		expect(await failedSteps()).toEqual([]);
	});

	it('a radar fetch that throws names watchdog_radar (unknown is stale)', async () => {
		await seedCheckpoint(M1_KID, 1);
		await watchdog({ fetch: stub('throw') });
		const steps = await failedSteps();
		expect(steps.map((s) => s.step)).toEqual(['watchdog_radar']);
		expect(steps[0].message).toContain('network down');
	});

	it('the radar date is yesterday from 06:00Z and the day before until then', async () => {
		const mod = await import('../src') as unknown as Mod;
		expect(mod.watchdogRadarDate!(new Date('2026-11-03T05:59:59Z'))).toBe('2026-11-01');
		expect(mod.watchdogRadarDate!(new Date('2026-11-03T06:00:00Z'))).toBe('2026-11-02');
		expect(mod.watchdogRadarDate!(new Date('2026-11-03T23:59:59Z'))).toBe('2026-11-02');
	});

	it('/v5/metrics/public says null, not a value, before the watchdog has ever run', async () => {
		const m = await (await call('/v5/metrics/public')).json() as { watchdog?: Record<string, unknown> };
		expect(m.watchdog).toMatchObject({ m1_newest_checkpoint_age_hours: null, radar_yesterday_summary: null, computed_at: null });
	});

	it('the minute cron at minute 7 runs the watchdog; at another minute it does not', async () => {
		const at = async (minute: number): Promise<void> => {
			const t = new Date('2026-11-03T10:00:00Z');
			t.setUTCMinutes(minute);
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(t);
			const ctx = createExecutionContext();
			await worker.scheduled({ cron: '* * * * *', scheduledTime: t.getTime(), type: 'scheduled', noRetry: () => {} } as unknown as ScheduledController, env as never, ctx);
			await waitOnExecutionContext(ctx);
			vi.useRealTimers();
		};
		await at(8);
		expect(await env.ORACLE_TELEMETRY.get('watchdog_health'), 'not run at minute 8').toBeNull();
		await at(7);
		const h = JSON.parse((await env.ORACLE_TELEMETRY.get('watchdog_health'))!) as Record<string, unknown>;
		expect(h.computed_at).toBe('2026-11-03T10:07:00.000Z');
		// The suite has no network (the radar answers 503) and no M-1 checkpoint: both steps are named.
		const steps = await failedSteps();
		expect(steps.map((s) => s.step).sort()).toEqual(['watchdog_m1', 'watchdog_radar']);
		// The radar request must reach the network (the suite's 503 stub): a request the
		// runtime itself refuses would name the step for the wrong reason, on every run.
		expect(steps.find((s) => s.step === 'watchdog_radar')!.message).toContain(`GET ${RADAR_URL}: HTTP 503`);
	});

	it('mails the founder once when a step turns failed, not on the next run while it stays failed', async () => {
		const e = { ...(env as unknown as Record<string, unknown>), RESEND_API_KEY: 're_test_watchdog_0000' };
		await seedCheckpoint(M1_KID, 6);
		const sent: RequestInit[] = [];
		const capture: Fetch = async (input, init) => {
			if (input.includes('ho-radar')) return new Response('{}', { status: 200 });
			if (input === 'https://api.resend.com/emails') sent.push(init ?? {});
			return new Response('{"id":"x"}', { status: 200 });
		};
		await watchdog({ fetch: capture }, e);
		expect(sent).toHaveLength(1);
		const body = JSON.parse(String(sent[0].body)) as { subject: string; to: string[]; text: string };
		expect(body.subject).toBe('Headless Oracle watchdog: watchdog_m1 failed');
		expect(body.to).toEqual(['mike@headlessoracle.com']);
		expect(body.text).toContain('6h ago');

		await watchdog({ fetch: capture }, e);
		expect(sent, 'no second mail while the step stays failed').toHaveLength(1);

		await seedCheckpoint(M1_KID, 0.5);
		await watchdog({ fetch: capture }, e);
		expect(await failedSteps()).toEqual([]);
		await env.WITNESS_DB!.prepare('DELETE FROM witness_checkpoints').run();
		await seedCheckpoint(M1_KID, 7);
		await watchdog({ fetch: capture }, e);
		expect(sent, 'a step that clears and fails again mails again').toHaveLength(2);
	});
});
