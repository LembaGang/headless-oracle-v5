// B-490 (2): CME (XCBT) and NYMEX (XNYM) trade from Sunday 17:00 to Friday
// 16:00 Central time with a daily break 16:00 to 17:00 (the repository's own
// data and docs, src/index.ts at the XCBT config). Before the fix both read
// OPEN from Friday 17:00 Central to midnight. Red against the parent commit.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src';

async function status(mic: string): Promise<string> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com/v5/demo?mic=${mic}`) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	expect(res.status).toBe(200);
	return ((await res.json()) as Record<string, string>).status;
}

afterEach(() => { vi.useRealTimers(); });

// Friday 10 Apr 2026 and Friday 13 Nov 2026 (CDT, then CST), and the Sunday after.
const cases: [string, string, string][] = [
	['2026-04-10T20:59:00Z', 'OPEN',   'Fri 15:59 CDT, the last minute of the week'],
	['2026-04-10T21:00:00Z', 'CLOSED', 'Fri 16:00 CDT, the close'],
	['2026-04-10T22:00:00Z', 'CLOSED', 'Fri 17:00 CDT: read OPEN before the fix'],
	['2026-04-11T04:59:00Z', 'CLOSED', 'Fri 23:59 CDT: read OPEN before the fix'],
	['2026-04-11T05:00:00Z', 'CLOSED', 'Sat 00:00 CDT'],
	['2026-04-12T21:59:00Z', 'CLOSED', 'Sun 16:59 CDT'],
	['2026-04-12T22:00:00Z', 'OPEN',   'Sun 17:00 CDT, the week opens'],
	['2026-04-13T21:30:00Z', 'CLOSED', 'Mon 16:30 CDT, the daily break'],
	['2026-04-13T22:00:00Z', 'OPEN',   'Mon 17:00 CDT, Tuesday\'s session opens'],
	['2026-11-13T23:00:00Z', 'CLOSED', 'Fri 17:00 CST: read OPEN before the fix'],
	['2026-11-14T05:59:00Z', 'CLOSED', 'Fri 23:59 CST: read OPEN before the fix'],
];

describe('B-490 (2): XCBT and XNYM are closed from Friday 16:00 to Sunday 17:00 Central', () => {
	for (const mic of ['XCBT', 'XNYM']) {
		for (const [t, want, what] of cases) {
			it(`${mic} ${what} (${t}) is ${want}`, async () => {
				vi.setSystemTime(new Date(t));
				expect(await status(mic)).toBe(want);
			});
		}
	}
});
