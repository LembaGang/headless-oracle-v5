// B-437 T4: the minute cron starts the GitHub workflows on time by
// workflow_dispatch. No live network: every outbound call goes through the
// fetch seam, and the cron test runs against the suite's 503 outbound stub.

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { ensureHoRecordSchema, clearHoRecordSchemaCache } from '../src';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Mod = {
	runDispatcher?: (e: unknown, o?: { now?: Date; fetch?: Fetch }) => Promise<{ dispatched: string[]; failed: string[] }>;
	dispatchSlotsDue?: (now: Date) => { name: string; repo: string; workflow: string; slot: string }[];
};
const TOKEN = 'github_pat_test_dispatch_0000';
const withToken = () => ({ ...(env as unknown as Record<string, unknown>), GITHUB_DISPATCH_TOKEN: TOKEN });

async function mod(): Promise<Required<Mod>> {
	const m = await import('../src') as unknown as Mod;
	expect(typeof m.runDispatcher, 'runDispatcher is exported').toBe('function');
	expect(typeof m.dispatchSlotsDue, 'dispatchSlotsDue is exported').toBe('function');
	return m as Required<Mod>;
}
function recorder(status = 204) {
	const calls: { url: string; init: RequestInit }[] = [];
	const f: Fetch = async (url, init) => { calls.push({ url, init: init ?? {} }); return new Response(status === 204 ? null : 'nope', { status }); };
	return { f, calls };
}
async function call(path: string): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, { headers: { Accept: 'application/json' } }), env as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
async function failedSteps(): Promise<string[]> {
	const idx = await (await call('/record')).json() as { failed_steps: { step: string }[] };
	return idx.failed_steps.map((s) => s.step);
}

describe('B-437 T4: the GitHub dispatcher', () => {
	beforeEach(async () => {
		const list = await env.ORACLE_TELEMETRY.list({ prefix: 'dispatch' });
		for (const k of list.keys) await env.ORACLE_TELEMETRY.delete(k.name);
		await env.ORACLE_TELEMETRY.delete('dispatcher_health');
		clearHoRecordSchemaCache();
		await ensureHoRecordSchema(env as never);
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_record_proofs').run();
		await env.HALT_ARCHIVE!.prepare('DELETE FROM ho_records').run();
		await env.HALT_ARCHIVE!.prepare('INSERT INTO ho_records (date, sequence, record_json, record_sha256, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.bind('2026-11-02', 1, '{"late":false}', 'sha256:' + '0'.repeat(64), 'sha256:' + '1'.repeat(64), new Date().toISOString()).run();
	});

	it('the M-1 snapshot is due at :23 of even hours only; the mail poller at :17 and :47 of every hour', async () => {
		const { dispatchSlotsDue } = await mod();
		const names = (iso: string) => dispatchSlotsDue(new Date(iso)).map((s) => `${s.name}@${s.slot}`);
		expect(names('2026-11-03T14:23:00Z')).toEqual(['m1@2026-11-03T14:23']);
		expect(names('2026-11-03T15:23:00Z')).toEqual([]);
		expect(names('2026-11-03T15:17:30Z')).toEqual(['mailwatch@2026-11-03T15:17']);
		expect(names('2026-11-03T15:47:00Z')).toEqual(['mailwatch@2026-11-03T15:47']);
		expect(names('2026-11-03T15:25:00Z')).toEqual([]);
		expect(names('2026-11-03T14:25:00Z'), 'two minutes late still finds the slot').toEqual(['m1@2026-11-03T14:23']);
		expect(names('2026-11-03T14:26:00Z')).toEqual([]);
	});

	it('dispatches with POST …/actions/workflows/<file>/dispatches, ref main, the token as Bearer, and a User-Agent', async () => {
		const { runDispatcher } = await mod();
		const { f, calls } = recorder();
		const r = await runDispatcher(withToken(), { now: new Date('2026-11-03T14:23:05Z'), fetch: f });
		expect(r).toEqual({ dispatched: ['m1@2026-11-03T14:23'], failed: [] });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://api.github.com/repos/LembaGang/m1-xagent-card/actions/workflows/snapshot.yml/dispatches');
		expect(calls[0]!.init.method).toBe('POST');
		const h = calls[0]!.init.headers as Record<string, string>;
		expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(h['User-Agent']).toBe('headless-oracle-dispatcher');
		expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: 'main' });
	});

	it('one dispatch per slot: the same minute twice, and the late minutes after it, send nothing more', async () => {
		const { runDispatcher } = await mod();
		const { f, calls } = recorder();
		for (const t of ['2026-11-03T15:17:01Z', '2026-11-03T15:17:40Z', '2026-11-03T15:18:00Z', '2026-11-03T15:19:00Z']) await runDispatcher(withToken(), { now: new Date(t), fetch: f });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toContain('/LembaGang/ho-mailwatch/actions/workflows/poll.yml/dispatches');
	});

	it('a failed dispatch is retried on the next minute within the slot window; a success ends the retries', async () => {
		const { runDispatcher } = await mod();
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const seen: string[] = [];
		const answers = [500, 204];
		const f: Fetch = async (url) => { seen.push(url); return new Response(null, { status: answers.shift() ?? 204 }); };
		for (const t of ['2026-11-03T15:17:00Z', '2026-11-03T15:18:00Z', '2026-11-03T15:19:00Z']) await runDispatcher(withToken(), { now: new Date(t), fetch: f });
		expect(seen, 'failed at :17, retried and succeeded at :18, nothing at :19').toHaveLength(2);
		const always500: Fetch = async (url) => { seen.push(url); return new Response('x', { status: 500 }); };
		seen.length = 0;
		for (const t of ['2026-11-03T15:47:00Z', '2026-11-03T15:48:00Z', '2026-11-03T15:49:00Z', '2026-11-03T15:50:00Z']) await runDispatcher(withToken(), { now: new Date(t), fetch: always500 });
		err.mockRestore();
		expect(seen, 'three tries in the window (:47, :48, :49), none after it').toHaveLength(3);
	});

	it('a cron minute missed at the slot is caught up within two minutes', async () => {
		const { runDispatcher } = await mod();
		const { f, calls } = recorder();
		await runDispatcher(withToken(), { now: new Date('2026-11-03T15:49:00Z'), fetch: f });
		expect(calls).toHaveLength(1);
	});

	it('without the token it dispatches nothing and logs that once a day', async () => {
		const { runDispatcher } = await mod();
		const { f, calls } = recorder();
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await runDispatcher(env, { now: new Date('2026-11-03T14:23:00Z'), fetch: f });
		await runDispatcher(env, { now: new Date('2026-11-03T15:17:00Z'), fetch: f });
		const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('DISPATCHER_NO_TOKEN'));
		log.mockRestore();
		expect(calls).toHaveLength(0);
		expect(lines).toHaveLength(1);
		const m = await (await call('/v5/metrics/public')).json() as { dispatcher: Record<string, unknown> };
		expect(m.dispatcher).toMatchObject({ token_configured: false, last_ok_at: null, failures_24h: 0 });
	});

	it('a failed dispatch is counted, keeps last_ok_at, and does not name a step before two hours', async () => {
		const { runDispatcher } = await mod();
		await runDispatcher(withToken(), { now: new Date('2026-11-03T14:23:00Z'), fetch: recorder(204).f });
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		const r = await runDispatcher(withToken(), { now: new Date('2026-11-03T15:17:00Z'), fetch: recorder(401).f });
		err.mockRestore();
		expect(r.failed).toEqual(['mailwatch@2026-11-03T15:17']);
		const h = JSON.parse((await env.ORACLE_TELEMETRY.get('dispatcher_health'))!) as Record<string, unknown>;
		expect(h).toMatchObject({ last_ok_at: '2026-11-03T14:23:00.000Z', failing_since: '2026-11-03T15:17:00.000Z' });
		expect(String(h.last_error)).toContain('HTTP 401');
		expect(String(h.last_error)).not.toContain(TOKEN);
		expect(await failedSteps()).toEqual([]);
	});

	it('dispatches failing for two hours name the failed step dispatcher on /record; a success clears it', async () => {
		const { runDispatcher } = await mod();
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const t of ['2026-11-03T14:17:00Z', '2026-11-03T14:47:00Z', '2026-11-03T15:17:00Z', '2026-11-03T15:47:00Z']) await runDispatcher(withToken(), { now: new Date(t), fetch: recorder(500).f });
		expect(await failedSteps(), 'only 1h30 of failure so far').toEqual([]);
		await runDispatcher(withToken(), { now: new Date('2026-11-03T16:17:00Z'), fetch: recorder(500).f });
		err.mockRestore();
		expect(await failedSteps()).toEqual(['dispatcher']);
		const m = await (await call('/v5/metrics/public')).json() as { dispatcher: Record<string, unknown> };
		expect(m.dispatcher).toMatchObject({ token_configured: false, failing_since: '2026-11-03T14:17:00.000Z' });
		await runDispatcher(withToken(), { now: new Date('2026-11-03T16:23:00Z'), fetch: recorder(204).f });
		expect(await failedSteps()).toEqual([]);
	});

	it('the minute cron runs the dispatcher (no token in the test env: nothing sent, logged once)', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const t = new Date('2026-11-03T14:23:00Z');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(t);
		const ctx = createExecutionContext();
		await worker.scheduled({ cron: '* * * * *', scheduledTime: t.getTime(), type: 'scheduled', noRetry: () => {} } as unknown as ScheduledController, env as never, ctx);
		await waitOnExecutionContext(ctx);
		vi.useRealTimers();
		const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('DISPATCHER_NO_TOKEN'));
		log.mockRestore();
		expect(lines).toHaveLength(1);
		expect(await env.ORACLE_TELEMETRY.get('dispatcher_no_token_logged:2026-11-03')).toBe('1');
	});
});
