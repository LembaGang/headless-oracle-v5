// B-490 (2): the boundary table. Every exchange is walked through four full
// weeks (listed at WEEKS below). At every boundary minute of its calendar data (the minute before,
// at and after local midnight, the open, the close, an early close and each
// end of a lunch break) and at every half hour, the schedule engine is
// compared with a reading of the exchange's own calendar data, written here from the
// data's stated meaning, not from the engine:
//   - alwaysOpen: OPEN at every instant;
//   - a rest day (weekends), then a year with no holiday list (UNKNOWN), then
//     a holiday: CLOSED;
//   - an early-close day: OPEN in [open, early close);
//   - an overnight venue (Sun 17:00 to Fri 16:00 local, daily break
//     [close, open)): before the close, OPEN when yesterday was a trading
//     day; from the open hour, OPEN when tomorrow is not a rest day;
//   - otherwise OPEN in [open, close) outside the lunch break.
// It found, against ae81d4d: XCOI and XBIN CLOSED at 23:59 (fixed in B-490 (1))
// and XCBT and XNYM OPEN from Friday 17:00 CT to midnight (fixed here).
import { describe, it, expect } from 'vitest';
import { getScheduleStatus, scheduleMics, scheduleConfigFor } from '../src';

const fmts = new Map<string, Intl.DateTimeFormat>();
function local(tz: string, t: Date) {
	let f = fmts.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
		fmts.set(tz, f);
	}
	const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
	return { weekday: p.weekday, year: p.year, date: `${p.year}-${p.month}-${p.day}`, minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10) };
}

const DAY = 24 * 60 * 60 * 1000;
function expected(mic: string, t: Date): 'OPEN' | 'CLOSED' | 'UNKNOWN' {
	const c = scheduleConfigFor(mic)!;
	if (c.alwaysOpen) return 'OPEN';
	const rest = c.weekends ?? ['Sat', 'Sun'];
	const l = local(c.timezone, t);
	if (rest.includes(l.weekday)) return 'CLOSED';
	const hol = c.holidays[l.year];
	if (!hol) return 'UNKNOWN';
	if (hol.includes(l.date)) return 'CLOSED';
	const open = c.openHour * 60 + c.openMinute;
	const close = c.closeHour * 60 + c.closeMinute;
	const half = c.halfDays?.find((h) => h.date === l.date);
	if (half) return l.minutes >= open && l.minutes < half.closeHour * 60 + half.closeMinute ? 'OPEN' : 'CLOSED';
	if (c.overnightSession) {
		if (l.minutes >= close && l.minutes < open) return 'CLOSED';
		if (l.minutes < open) {
			const y = local(c.timezone, new Date(t.getTime() - DAY));
			if (rest.includes(y.weekday)) return 'CLOSED';
			if ((c.holidays[y.year] ?? []).includes(y.date)) return 'CLOSED';
			return 'OPEN';
		}
		const n = local(c.timezone, new Date(t.getTime() + DAY));
		return rest.includes(n.weekday) ? 'CLOSED' : 'OPEN';
	}
	if (l.minutes < open || l.minutes >= close) return 'CLOSED';
	const lb = c.lunchBreak;
	if (lb && l.minutes >= lb.startHour * 60 + lb.startMinute && l.minutes < lb.endHour * 60 + lb.endMinute) return 'CLOSED';
	return 'OPEN';
}

// Easter 2026; the week the US leaves daylight saving (Sun 1 Nov 2026), a week
// after Europe; Thanksgiving 2026 with its early close; the turn of 2027 into
// 2028, where every calendar but the always-open venues' ends.
const WEEKS = ['2026-04-06T00:00:00Z', '2026-10-26T00:00:00Z', '2026-11-23T00:00:00Z', '2027-12-27T00:00:00Z'];

// B-490 rev 4: one test per exchange and week (112 tests), and the local time
// of each minute is read from one formatted reading per UTC hour (an offset
// changes only at the top of an hour in these 28 zones, and every half-hour
// probe compares the arithmetic with a full reading, so a drift would fail
// the test). The same minutes are probed as before; no test runs long.
describe('B-490 (2): every exchange, four full weeks, every boundary minute and every half hour, against its calendar data', () => {
	it('covers all 28 exchanges', () => {
		expect(scheduleMics().length).toBe(28);
	});
	for (const mic of scheduleMics()) {
		for (const w of WEEKS) {
			it(`${mic}, the week of ${w.slice(0, 10)}: the engine agrees with the calendar data at every probed minute`, () => {
				const c = scheduleConfigFor(mic)!;
				const edges = [0, 24 * 60, c.openHour * 60 + c.openMinute, c.closeHour * 60 + c.closeMinute];
				if (c.lunchBreak) edges.push(c.lunchBreak.startHour * 60 + c.lunchBreak.startMinute, c.lunchBreak.endHour * 60 + c.lunchBreak.endMinute);
				for (const h of c.halfDays ?? []) edges.push(h.closeHour * 60 + h.closeMinute);
				const probe = new Set<number>();
				for (const e of edges) for (const d of [-1, 0, 1]) probe.add(((e + d) % 1440 + 1440) % 1440);
				const bad: string[] = [];
				let checked = 0;
				let hourLocal = 0;
				const start = Date.parse(w) - 12 * 60 * 60 * 1000; // from Sunday 12:00 UTC, so every zone's Monday is whole
				for (let m = 0; m < 8 * 24 * 60; m++) {
					const t = new Date(start + m * 60_000);
					if (m % 60 === 0) hourLocal = local(c.timezone, t).minutes;
					const lm = (hourLocal + (m % 60)) % 1440;
					if (m % 30 !== 0 && !probe.has(lm)) continue;
					expect(lm, `${t.toISOString()} local minute`).toBe(local(c.timezone, t).minutes);
					const got = getScheduleStatus(mic, t).status;
					const want = expected(mic, t);
					checked++;
					if (got !== want && bad.length < 5) bad.push(`${t.toISOString()} engine ${got}, data ${want}`);
				}
				expect(checked).toBeGreaterThan(8 * 48);
				expect(bad).toEqual([]);
			});
		}
	}
});
