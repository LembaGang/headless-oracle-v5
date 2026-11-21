// B-490 (1): the around-the-clock venues (XCOI, XBIN) are OPEN at every
// instant. Before the fix they read CLOSED from 23:59:00 to 23:59:59 UTC every
// day (close 23:59 compared with >=), and UNKNOWN on every day of 2028 (no
// holiday list for a venue that has no holidays). Red against ae81d4d.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src';

async function demo(mic: string): Promise<Record<string, string>> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com/v5/demo?mic=${mic}`) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	expect(res.status).toBe(200);
	return res.json() as Promise<Record<string, string>>;
}

afterEach(() => { vi.useRealTimers(); });

const instants = [
	'2026-04-07T23:58:59Z', // the last minute that read OPEN before the fix
	'2026-04-07T23:59:00Z', // read CLOSED before the fix
	'2026-04-07T23:59:59Z', // read CLOSED before the fix
	'2026-04-08T00:00:00Z',
	'2026-04-11T23:59:30Z', // a Saturday
	'2026-12-25T23:59:00Z', // a day other venues keep as a holiday
	'2027-12-31T23:59:59Z', // the last second of the calendar data
	'2028-01-04T12:00:00Z', // read UNKNOWN (NO_HOLIDAY_DATA_FOR_YEAR) before the fix
];

describe('B-490 (1): XCOI and XBIN are OPEN at every instant', () => {
	for (const mic of ['XCOI', 'XBIN']) {
		for (const t of instants) {
			it(`${mic} at ${t} is OPEN by schedule`, async () => {
				vi.setSystemTime(new Date(t));
				const r = await demo(mic);
				expect(r.status).toBe('OPEN');
				expect(r.source).toBe('SCHEDULE');
				expect(JSON.parse(r.coverage).unknown_reason).toBeNull();
			});
		}
	}
});
