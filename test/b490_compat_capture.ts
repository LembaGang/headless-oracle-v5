// B-490 (4): the default (v5.0) bytes of the surfaces a request-response test
// does not reach: the cron webhook fan-out, the WebhookDispatcher alarm's
// fan-out, the webhook test delivery, and the SSE stream's first event. The
// time is fixed and receipt_id fixed, so the bytes are a function of the code.
// This file imports only what ae81d4d (the parent of B-490) also exports, so
// the same capture runs at the parent and at the tip: the fixture
// test/fixtures/b490_compat_surfaces.json holds the parent's bytes, and
// test/b490_compat_surfaces.spec.ts compares the tip's with them.
import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import { vi } from 'vitest';
import worker, { clearOverrideCache, WebhookDispatcher, StreamCoordinator } from '../src';

export const COMPAT_AT = '2026-04-07T15:00:00Z'; // a Tuesday: XNYS and XLON OPEN, XJPX CLOSED
export const COMPAT_UUID = '00000000-0000-4000-8000-000000000490';
const HOOK = 'https://hooks.example.test/b490';
const BETA = 'b490_compat_beta'; // set as BETA_API_KEYS below
// The webhook HMAC secret of the capture, joined at run time (no secret-shaped literal in the file).
const HOOK_HMAC = ['b490', 'compat', 'hmac'].join('-');
// The entries a receipt may meet: none, the runbook's operator form, and the
// old halt monitor's own bytes. Both entries are HALTED, so the default status
// is the same at the parent and the tip.
const ENTRIES: Record<string, string | null> = {
	none:     null,
	operator: JSON.stringify({ status: 'HALTED', reason: 'Circuit breaker', expires: '2026-04-07T16:00:00.000Z' }),
	monitor:  JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'Real-time halt detected by halt monitor (source: polygon)', expires: '2026-04-07T16:30:00.000Z', auto_clear_at: '2026-04-07T16:30:00.000Z', detected_at: '2026-04-07T14:30:00.000Z' }),
};
export const CASES: Array<[string, string]> = [['XNYS', 'none'], ['XNYS', 'operator'], ['XNYS', 'monitor'], ['XLON', 'none'], ['XJPX', 'none']];
export const SURFACES = ['cron_webhook', 'do_webhook', 'test_webhook', 'sse_first_event'];

interface Sent { url: string; method: string; headers: string; body: string }
async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function headersOf(h: HeadersInit | undefined): string {
	const o: Record<string, string> = {};
	new Headers(h).forEach((v, k) => { o[k] = v; });
	return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}
async function withHooks<T>(feed: string, f: () => Promise<T>): Promise<[T, Sent[]]> {
	const sent: Sent[] = [];
	const orig = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (u.startsWith(HOOK)) {
			sent.push({ url: u, method: init?.method ?? 'GET', headers: headersOf(init?.headers), body: String(init?.body ?? '') });
			return new Response('ok', { status: 200 });
		}
		if (u.includes('api.polygon.io')) return new Response(JSON.stringify({ market: feed, exchanges: { nyse: feed, nasdaq: feed } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
		return new Response('stubbed: no network in this capture', { status: 503 });
	}) as typeof fetch;
	try { return [await f(), sent]; } finally { globalThis.fetch = orig; }
}
function fakeState(): DurableObjectState {
	const m = new Map<string, unknown>();
	let alarm: number | null = null;
	return {
		storage: {
			get: async (k: string) => m.get(k),
			put: async (k: string, v: unknown) => { m.set(k, v); },
			delete: async (k: string) => m.delete(k),
			getAlarm: async () => alarm,
			setAlarm: async (t: number | Date) => { alarm = typeof t === 'number' ? t : t.getTime(); },
			deleteAlarm: async () => { alarm = null; },
		},
	} as unknown as DurableObjectState;
}
async function setEntry(mic: string, entry: string): Promise<void> {
	const v = ENTRIES[entry];
	if (v === null) await env.ORACLE_OVERRIDES.delete(mic); else await env.ORACLE_OVERRIDES.put(mic, v);
	clearOverrideCache();
}
async function clean(mic: string): Promise<void> {
	await env.ORACLE_OVERRIDES.delete(mic);
	await env.ORACLE_API_KEYS.delete(`last_state:${mic}`);
	await env.ORACLE_API_KEYS.delete(`webhooks_by_mic:${mic}`);
	clearOverrideCache();
}
const show = (s: Sent[]) => s.map((x) => `${x.method} ${x.url}\n${x.headers}\n${x.body}`).join('\n--\n');

// Rev 3: one case at a time. The spec runs each case as its own test, so no
// test holds the pool's storage frame for long: run as one test of 20 cases
// it took 5 to 7 s in the whole suite, and the pool's storage pop at its end
// then met the loopback connection that Node closes after about 6 s idle
// (keep-alive), which workerd reported as "Network connection lost" (B-490
// rev 3, DESIGN). Returns surface.mic.entry -> the exact bytes the default
// produced for that case. Rev 4: `only` names one surface; the spec runs
// each surface of each case as its own test (20 tests), so no test runs long
// (the reader of rev 3: a test that leaves the pool's connection idle for
// seconds can meet the same lost connection). Without it, every surface, as
// at the parent.
export async function captureCase(mic: string, entry: string, only?: string): Promise<Record<string, string>> {
	vi.setSystemTime(new Date(COMPAT_AT));
	const uuid = vi.spyOn(crypto, 'randomUUID').mockReturnValue(COMPAT_UUID as `${string}-${string}-${string}-${string}-${string}`);
	const out: Record<string, string> = {};
	// The capture's own signing key and keys, made here at run time, so the
	// bytes do not depend on the .dev.vars of the machine (the parent's tree
	// has none) and no key-shaped literal is in the file.
	const E = {
		...env,
		ED25519_PRIVATE_KEY: await sha256Hex('B-490 compat capture: a test-only signing seed'),
		PUBLIC_KEY_ID:       'key_b490_compat',
		BETA_API_KEYS:       BETA,
		POLYGON_API_KEY:     'test-only',
	};
	try {
		for (const m of ['XNYS', 'XLON', 'XJPX']) await clean(m);
		{
			const tag = `${mic}.${entry}`;
			const target = { subscription_id: `wh_b490_${mic}`, key_hash: 'b490', url: `${HOOK}/${mic}`, secret: HOOK_HMAC };
			// 1. The cron's state-change fan-out (runHaltMonitor, minute cron).
			if (!only || only === 'cron_webhook') {
			await clean(mic); await setEntry(mic, entry);
			await env.ORACLE_API_KEYS.put(`last_state:${mic}`, JSON.stringify({ status: 'UNKNOWN', updated_at: '2026-04-07T14:59:00.000Z' }));
			await env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify([target]));
			const [, cron] = await withHooks('open', async () => {
				const ctx = createExecutionContext();
				// Rev 4: the cron's halt-archive capture (a ctx.waitUntil task that
				// writes no webhook) is skipped by leaving its database out: it returns
				// at once when HALT_ARCHIVE is absent, so the test does not wait on it.
				// runHaltMonitor, whose fan-out is compared, never reads HALT_ARCHIVE.
				await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse(COMPAT_AT), cron: '* * * * *' }), { ...E, HALT_ARCHIVE: undefined } as never, ctx);
				await waitOnExecutionContext(ctx);
			});
			out[`cron_webhook.${tag}`] = show(cron.filter((x) => x.url === target.url));
			}
			if (!only || only === 'do_webhook') {
			// 2. The WebhookDispatcher alarm's fan-out.
			await clean(mic); await setEntry(mic, entry);
			await env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify([target]));
			const st = fakeState();
			await st.storage.put(`last_state:${mic}`, 'UNKNOWN');
			const [, alarm] = await withHooks('open', async () => { await new WebhookDispatcher(st, E as never).alarm(); });
			out[`do_webhook.${tag}`] = show(alarm.filter((x) => x.url === target.url));
			}
			if (!only || only === 'test_webhook') {
			// 3. POST /v5/webhooks/test/:id (the subscriber's own test delivery).
			await clean(mic); await setEntry(mic, entry);
			const keyHash = await sha256Hex(BETA);
			const sub = { subscription_id: `wh_b490_t_${mic}`, url: `${HOOK}/test/${mic}`, mics: [mic], secret: HOOK_HMAC, created_at: '2026-04-01T00:00:00.000Z' };
			await env.ORACLE_API_KEYS.put(`webhooks:${keyHash}`, JSON.stringify([sub]));
			const [res, tst] = await withHooks('open', async () => {
				const ctx = createExecutionContext();
				const r = await worker.fetch(new Request(`https://headlessoracle.com/v5/webhooks/test/${sub.subscription_id}`, { method: 'POST', headers: { 'X-Oracle-Key': BETA } }) as never, E as never, ctx);
				await waitOnExecutionContext(ctx);
				return `${r.status}\n${await r.text()}`;
			});
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			out[`test_webhook.${tag}`] = `${show(tst)}\n==\n${res}`;
			}
			if (!only || only === 'sse_first_event') {
			// 4. The SSE stream's first event (StreamCoordinator). Rev 3: the
			// coordinator's loop is awaited to its end after the client cancels
			// (lastStream, B-490 (4) rev 3), so nothing of the stream outlives
			// the capture. At ae81d4d there is no lastStream (the capture there
			// is run once, to make the fixture, and only reads the first event).
			await clean(mic); await setEntry(mic, entry);
			const [sse] = await withHooks('open', async () => {
				const co = new StreamCoordinator(fakeState(), E as never);
				const r = await co.fetch(new Request(`https://headlessoracle.com/v5/stream?mic=${mic}`));
				const rd = r.body!.getReader();
				let text = '';
				const dec = new TextDecoder();
				while (!text.includes('\n\n')) {
					const { value, done } = await rd.read();
					if (done) break;
					text += dec.decode(value, { stream: true });
				}
				await rd.cancel();
				const loop = (co as unknown as { lastStream?: Promise<void> | null }).lastStream;
				if (loop) await loop;
				return `${r.status}\n${headersOf(r.headers)}\n${text}`;
			});
			out[`sse_first_event.${tag}`] = sse;
			}
			await clean(mic);
		}
	} finally {
		uuid.mockRestore();
	}
	return out;
}

// All cases, in the order of CASES: the fixture is this function's output at
// ae81d4d.
export async function captureSurfaces(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [mic, entry] of CASES) Object.assign(out, await captureCase(mic, entry));
	return out;
}
