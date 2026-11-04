// B-438 T2: the watchdog turns /record red when the M-1 snapshot job stops
// reaching our witness or ho-radar skips a day, with nobody watching. No live
// network: every outbound call goes through the fetch seam.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { clearWitnessSchemaCache, ensureWitnessSchema, ensureHoRecordSchema, clearHoRecordSchemaCache } from '../src';

const M1_KID = 'JgXFlLtC88UAIK811_ptXkq5Lb_k6E1rCe0Auahg7G4';
const NOW = new Date('2026-11-03T10:07:00Z');
const RADAR_URL = 'https://raw.githubusercontent.com/LembaGang/ho-radar/main/data/2026-11-02/summary.json';
// B-470 T5: the newest successful run of the mail poller, read with the dispatch token's Actions permission.
const POLLER_URL = 'https://api.github.com/repos/LembaGang/ho-mailwatch/actions/workflows/poll.yml/runs?status=success&per_page=1';
const TOKEN = 'github_pat_test_watchdog_0000';

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

// The watchdog runs with the dispatch token set, as it does live.
const envWithToken = (): Record<string, unknown> => ({ ...(env as unknown as Record<string, unknown>), GITHUB_DISPATCH_TOKEN: TOKEN });

async function watchdog(opts: { now?: Date; fetch?: Fetch } = {}, e: unknown = envWithToken()): Promise<Record<string, unknown>> {
	const mod = await import('../src') as unknown as Mod;
	expect(typeof mod.runWatchdog, 'runWatchdog is exported').toBe('function');
	return mod.runWatchdog!(e, { now: NOW, ...opts });
}

// GitHub's answer for the newest successful poll run, finished `ageHours` before NOW.
function pollerRuns(ageHours: number): Response {
	const at = new Date(NOW.getTime() - ageHours * 3_600_000).toISOString().replace('.000Z', 'Z');
	return new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', created_at: at, updated_at: at }] }), { status: 200 });
}

// A stub for the outside world: the radar answers `radarStatus`, GitHub answers `poller`
// (a fresh run by default), Resend answers 200. `inits` records each GitHub request's init.
function stub(radarStatus: number | 'throw', calls: string[] = [], poller: () => Response | Promise<Response> = () => pollerRuns(0.25), inits: RequestInit[] = []): Fetch {
	return async (input, init) => {
		calls.push(input);
		if (input.includes('ho-radar')) {
			if (radarStatus === 'throw') throw new Error('network down');
			return new Response(radarStatus === 200 ? '{}' : 'Not Found', { status: radarStatus });
		}
		if (input.startsWith('https://api.github.com/')) {
			inits.push(init ?? {});
			return poller();
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
		expect(calls).toEqual([RADAR_URL, POLLER_URL]);
		const m = await (await call('/v5/metrics/public')).json() as { watchdog: Record<string, unknown> };
		expect(m.watchdog).toMatchObject({
			mailpoller_last_success_age_hours: 0.25,
			mailpoller_last_success_at: '2026-11-03T09:52:00Z',
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
		expect(calls.filter((u) => u.includes('ho-radar')), 'a summary seen once is not fetched again').toEqual([RADAR_URL]);
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
		// The suite has no network (the radar answers 503), no M-1 checkpoint and no dispatch
		// token, so the poller's age is unknown: all three steps are named.
		const steps = await failedSteps();
		expect(steps.map((s) => s.step).sort()).toEqual(['watchdog_m1', 'watchdog_mailpoller', 'watchdog_radar']);
		// The radar request must reach the network (the suite's 503 stub): a request the
		// runtime itself refuses would name the step for the wrong reason, on every run.
		expect(steps.find((s) => s.step === 'watchdog_radar')!.message).toContain(`GET ${RADAR_URL}: HTTP 503`);
	});

	it('B-470 T5: a poller whose newest successful run is over 3 hours old names watchdog_mailpoller; a fresh one clears it', async () => {
		await seedCheckpoint(M1_KID, 1);
		const inits: RequestInit[] = [];
		const h = await watchdog({ fetch: stub(200, [], () => pollerRuns(3.5), inits) });
		expect(h.mailpoller_last_success_age_hours).toBe(3.5);
		const steps = await failedSteps();
		expect(steps.map((s) => s.step)).toEqual(['watchdog_mailpoller']);
		expect(steps[0].message).toContain('3.5h ago; limit 3h');
		// The request carries the token and the headers GitHub's API requires.
		const headers = new Headers(inits[0].headers);
		expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
		expect(headers.get('User-Agent')).toBeTruthy();
		expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
		await watchdog({ fetch: stub(200, [], () => pollerRuns(0.5)) });
		expect(await failedSteps()).toEqual([]);
	});

	it('B-470 T5: exactly 3 hours is still fresh; just over is not', async () => {
		await seedCheckpoint(M1_KID, 1);
		await watchdog({ fetch: stub(200, [], () => pollerRuns(3)) });
		expect(await failedSteps()).toEqual([]);
		await watchdog({ fetch: stub(200, [], () => pollerRuns(3.02)) });
		expect((await failedSteps()).map((s) => s.step)).toEqual(['watchdog_mailpoller']);
	});

	it('B-470 T5: unknown is stale: no token, a 403, a throw, no successful run, or an unreadable time each name watchdog_mailpoller', async () => {
		await seedCheckpoint(M1_KID, 1);
		const cases: Array<{ why: string; e?: unknown; poller: () => Response | Promise<Response>; contains: string }> = [
			{ why: 'no token', e: env, poller: () => pollerRuns(0.1), contains: 'GITHUB_DISPATCH_TOKEN is not set' },
			{ why: '403', poller: () => new Response('{"message":"Resource not accessible by personal access token"}', { status: 403 }), contains: 'HTTP 403' },
			{ why: 'throw', poller: () => { throw new Error('github unreachable'); }, contains: 'github unreachable' },
			{ why: 'no run', poller: () => new Response('{"total_count":0,"workflow_runs":[]}', { status: 200 }), contains: 'no successful run' },
			{ why: 'bad time', poller: () => new Response('{"total_count":1,"workflow_runs":[{"updated_at":"soon"}]}', { status: 200 }), contains: 'no successful run' },
		];
		for (const c of cases) {
			await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_record_proofs').run();
			const calls: string[] = [];
			const h = await watchdog({ fetch: stub(200, calls, c.poller) }, c.e ?? envWithToken());
			expect(h.mailpoller_last_success_age_hours, c.why).toBeNull();
			const steps = await failedSteps();
			expect(steps.map((s) => s.step), c.why).toEqual(['watchdog_mailpoller']);
			expect(steps[0].message, c.why).toContain(c.contains);
			if (c.why === 'no token') expect(calls.some((u) => u.startsWith('https://api.github.com/')), 'no token, no GitHub call').toBe(false);
		}
	});

	it('B-470 T5: the metrics rule names the 3-hour limit and what the check does not show', async () => {
		const m = await (await call('/v5/metrics/public')).json() as { watchdog: Record<string, unknown> };
		expect(m.watchdog.mailpoller_last_success_age_hours).toBeNull();
		expect(m.watchdog.mailpoller_last_success_at).toBeNull();
		const rule = String(m.watchdog.rule);
		expect(rule).toContain('LembaGang/ho-mailwatch poll.yml');
		expect(rule).toContain('over 3 hours');
		expect(rule).toContain('watchdog_mailpoller');
		expect(rule).toContain('not that state was saved or mail relayed');
	});

	it('mails the founder once when a step turns failed, not on the next run while it stays failed', async () => {
		const e = { ...envWithToken(), RESEND_API_KEY: 're_test_watchdog_0000' };
		await seedCheckpoint(M1_KID, 6);
		const sent: RequestInit[] = [];
		const capture: Fetch = async (input, init) => {
			if (input.includes('ho-radar')) return new Response('{}', { status: 200 });
			if (input.startsWith('https://api.github.com/')) return pollerRuns(0.25);
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
