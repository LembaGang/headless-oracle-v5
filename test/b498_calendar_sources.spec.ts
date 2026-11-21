// B-498: the exchange calendars, checked against their sources.
//
// data/calendar-sources.json holds, for every venue, its weekend days, session
// hours, lunch break, and for every year it covers every holiday and every
// early close, each with its source (publisher, URL, the date on the page, the
// date read, how it was read, the deciding words, a confidence class). The
// sources come from two checks of 2026-11-21 against the exchanges' own
// calendars, which found errors at 23 of the 26 venues with a holiday list.
//
// The agreement test below fails when MARKET_CONFIGS and that file disagree in
// either direction: a date in the code with no source entry, a source entry
// that is not in the code, or a weekend, hour or lunch break that differs. The
// older calendar tests compare the engine with the same data the engine reads,
// so they could not catch a wrong date; this one ties every date to a source.
//
// The named cases after it are the corrections themselves, as instants: each
// read wrong at 1ce6d80 unless its title says "(unchanged)".
import { describe, it, expect } from 'vitest';
import { getScheduleStatus, scheduleMics, scheduleConfigFor } from '../src';
import sources from '../data/calendar-sources.json';

type Src = { publisher: string | null; url: string | null; page_date: string | null; date_read: string | null; how_read: string; quote: string | null; confidence: string; check_ref: string };
type Venue = {
	weekends: string[];
	session: { open: string; close: string; source: Src };
	lunch_break: { start: string; end: string } | null;
	alwaysOpen?: boolean;
	overnightSession?: boolean;
	years: Record<string, { holidays: { date: string; weekday: string; source: Src; second_source?: Src }[]; early_closes: { date: string; close: string; source: Src }[] }>;
	years_without_list?: Record<string, unknown>;
	weekends_source: Src;
	lunch_break_source: Src;
};
const VENUES = (sources as unknown as { venues: Record<string, Venue> }).venues;

const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (d: string) => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];

// The comparison, as a function, so the test that shows it failing can use it too.
function disagreements(mic: string, c: ReturnType<typeof scheduleConfigFor>, s: Venue | undefined): string[] {
	const bad: string[] = [];
	if (!c) return [`${mic}: in the source file, not in MARKET_CONFIGS`];
	if (!s) return [`${mic}: in MARKET_CONFIGS, no entry in the source file`];
	const weekends = c.weekends ?? ['Sat', 'Sun'];
	if (JSON.stringify(weekends) !== JSON.stringify(s.weekends)) bad.push(`${mic} weekends: code ${JSON.stringify(weekends)}, source ${JSON.stringify(s.weekends)}`);
	if (hm(c.openHour, c.openMinute) !== s.session.open) bad.push(`${mic} open: code ${hm(c.openHour, c.openMinute)}, source ${s.session.open}`);
	if (hm(c.closeHour, c.closeMinute) !== s.session.close) bad.push(`${mic} close: code ${hm(c.closeHour, c.closeMinute)}, source ${s.session.close}`);
	const lb = c.lunchBreak ? { start: hm(c.lunchBreak.startHour, c.lunchBreak.startMinute), end: hm(c.lunchBreak.endHour, c.lunchBreak.endMinute) } : null;
	if (JSON.stringify(lb) !== JSON.stringify(s.lunch_break)) bad.push(`${mic} lunch break: code ${JSON.stringify(lb)}, source ${JSON.stringify(s.lunch_break)}`);
	if (!!c.alwaysOpen !== !!s.alwaysOpen) bad.push(`${mic} alwaysOpen: code ${!!c.alwaysOpen}, source ${!!s.alwaysOpen}`);
	if (!!c.overnightSession !== !!s.overnightSession) bad.push(`${mic} overnightSession: code ${!!c.overnightSession}, source ${!!s.overnightSession}`);
	const codeYears = Object.keys(c.holidays).sort();
	const srcYears = Object.keys(s.years).sort();
	if (JSON.stringify(codeYears) !== JSON.stringify(srcYears)) bad.push(`${mic} years with a holiday list: code ${codeYears}, source ${srcYears}`);
	for (const y of Object.keys(s.years_without_list ?? {})) if (c.holidays[y]) bad.push(`${mic} ${y}: the source file says no list, the code has one`);
	for (const y of new Set([...codeYears, ...srcYears])) {
		const code = new Set(c.holidays[y] ?? []);
		const src = new Set((s.years[y]?.holidays ?? []).map((h) => h.date));
		for (const d of code) if (!src.has(d)) bad.push(`${mic} holiday ${d}: in the code, no source entry`);
		for (const d of src) if (!code.has(d)) bad.push(`${mic} holiday ${d}: source entry, not in the code`);
		if ((c.holidays[y] ?? []).length !== code.size) bad.push(`${mic} ${y}: a holiday is listed twice in the code`);
	}
	const codeHalf = new Set((c.halfDays ?? []).map((h) => `${h.date} ${hm(h.closeHour, h.closeMinute)}`));
	const srcHalf = new Set(Object.values(s.years).flatMap((y) => y.early_closes.map((e) => `${e.date} ${e.close}`)));
	for (const e of codeHalf) if (!srcHalf.has(e)) bad.push(`${mic} early close ${e}: in the code, no source entry`);
	for (const e of srcHalf) if (!codeHalf.has(e)) bad.push(`${mic} early close ${e}: source entry, not in the code`);
	return bad;
}

describe('B-498: MARKET_CONFIGS agrees with data/calendar-sources.json, in both directions', () => {
	it('the source file and MARKET_CONFIGS name the same 28 venues', () => {
		expect(Object.keys(VENUES).sort()).toEqual(scheduleMics().sort());
		expect(scheduleMics().length).toBe(28);
	});
	for (const mic of scheduleMics()) {
		it(`${mic}: every date, early close, weekend, hour and lunch break in the code has its source entry, and every source entry is in the code`, () => {
			expect(disagreements(mic, scheduleConfigFor(mic), VENUES[mic])).toEqual([]);
		});
	}

	it('the comparison fails when one date is removed from either side (the control works)', () => {
		const c = scheduleConfigFor('XNSE')!;
		const s = VENUES.XNSE;
		const codeLess = { ...c, holidays: { ...c.holidays, '2026': c.holidays['2026'].filter((d) => d !== '2026-11-24') } };
		expect(disagreements('XNSE', codeLess, s)).toEqual(['XNSE holiday 2026-11-24: source entry, not in the code']);
		const srcLess = { ...s, years: { ...s.years, '2026': { ...s.years['2026'], holidays: s.years['2026'].holidays.filter((h) => h.date !== '2026-11-24') } } };
		expect(disagreements('XNSE', c, srcLess)).toEqual(['XNSE holiday 2026-11-24: in the code, no source entry']);
		const cboLess = { ...scheduleConfigFor('XCBO')!, halfDays: scheduleConfigFor('XCBO')!.halfDays!.slice(1) };
		expect(disagreements('XCBO', cboLess, VENUES.XCBO)).toEqual(['XCBO early close 2026-11-27 13:00: source entry, not in the code']);
	});

	it('every entry carries its source: a confidence class and a check reference; a sourced entry has a publisher, a URL or the note that the check did not record one, and the date read', () => {
		const bad: string[] = [];
		const look = (where: string, s: Src) => {
			if (!s || !s.confidence || !s.check_ref) { bad.push(`${where}: no confidence or check reference`); return; }
			if (s.confidence === 'NOT CHECKED') return;
			if (!s.publisher || !s.url || s.date_read !== '2026-11-21' || !s.how_read || s.page_date === null) bad.push(`${where}: incomplete source`);
			if (!s.quote && !s.confidence.includes('NO WORDS QUOTED')) bad.push(`${where}: no deciding words`);
		};
		for (const [mic, v] of Object.entries(VENUES)) {
			look(`${mic} weekends`, v.weekends_source);
			look(`${mic} session`, v.session.source);
			look(`${mic} lunch break`, v.lunch_break_source);
			for (const [y, yd] of Object.entries(v.years)) {
				for (const h of yd.holidays) {
					look(`${mic} ${y} ${h.date}`, h.source);
					if (h.second_source) look(`${mic} ${y} ${h.date} (second source)`, h.second_source);
				}
				for (const e of yd.early_closes) look(`${mic} ${y} early ${e.date}`, e.source);
			}
		}
		expect(bad).toEqual([]);
	});

	it('no holiday is listed on a venue\'s own weekend day (ruling R7), and each stated weekday is right', () => {
		const bad: string[] = [];
		for (const mic of scheduleMics()) {
			const c = scheduleConfigFor(mic)!;
			const rest = c.weekends ?? ['Sat', 'Sun'];
			for (const list of Object.values(c.holidays)) for (const d of list) if (rest.includes(dow(d))) bad.push(`${mic} ${d} is a ${dow(d)}`);
			for (const yd of Object.values(VENUES[mic].years)) for (const h of [...yd.holidays, ...yd.early_closes]) if (h.weekday !== dow(h.date)) bad.push(`${mic} ${h.date} stated ${h.weekday}`);
		}
		expect(bad).toEqual([]);
	});
});

// [instant (UTC), expected, what it is]
const named: [string, string, string, string][] = [
	// India: a missing holiday added, a false one removed
	['XNSE', '2026-11-24T05:30:00Z', 'CLOSED', 'Tue 24 Nov 2026 11:00 IST, Prakash Gurpurb Sri Guru Nanak Dev'],
	['XBOM', '2026-11-24T05:30:00Z', 'CLOSED', 'Tue 24 Nov 2026 11:00 IST, Prakash Gurpurb Sri Guru Nanak Dev'],
	['XNSE', '2026-11-19T05:30:00Z', 'OPEN', 'Thu 19 Nov 2026 11:00 IST, a trading day the data had as a holiday'],
	['XBOM', '2026-11-19T05:30:00Z', 'OPEN', 'Thu 19 Nov 2026 11:00 IST, a trading day the data had as a holiday'],
	// Cboe: an early close added
	['XCBO', '2026-11-27T18:30:00Z', 'CLOSED', 'Fri 27 Nov 2026 13:30 ET, after the 13:00 early close'],
	['XCBO', '2026-11-27T17:30:00Z', 'OPEN', 'Fri 27 Nov 2026 12:30 ET, before the 13:00 early close (unchanged)'],
	// Dubai: the weekend, the close and a false holiday
	['XDFM', '2026-11-22T07:00:00Z', 'CLOSED', 'Sun 22 Nov 2026 11:00 GST, a Sunday (the DFM weekend is Saturday and Sunday)'],
	['XDFM', '2026-11-27T07:00:00Z', 'OPEN', 'Fri 27 Nov 2026 11:00 GST, a Friday (a trading day)'],
	['XDFM', '2026-11-23T10:30:00Z', 'OPEN', 'Mon 23 Nov 2026 14:30 GST, before the 14:45 end of continuous trading'],
	['XDFM', '2026-11-23T10:50:00Z', 'CLOSED', 'Mon 23 Nov 2026 14:50 GST, after 14:45 (unchanged)'],
	['XDFM', '2026-12-01T07:00:00Z', 'OPEN', 'Tue 1 Dec 2026 11:00 GST, not in the DFM circular (ruling R1)'],
	['XDFM', '2026-12-02T07:00:00Z', 'CLOSED', 'Wed 2 Dec 2026 11:00 GST, UAE National Day (unchanged)'],
	// Singapore: the lunch break and an early close
	['XSES', '2026-11-23T04:30:00Z', 'CLOSED', 'Mon 23 Nov 2026 12:30 SGT, the mid-day break'],
	['XSES', '2026-11-23T03:30:00Z', 'OPEN', 'Mon 23 Nov 2026 11:30 SGT, the morning phase (unchanged)'],
	['XSES', '2026-11-23T05:30:00Z', 'OPEN', 'Mon 23 Nov 2026 13:30 SGT, the afternoon phase (unchanged)'],
	['XSES', '2026-12-24T04:30:00Z', 'CLOSED', 'Thu 24 Dec 2026 12:30 SGT, after the 12:00 early close'],
	// Milan: a false holiday removed
	['XMIL', '2026-12-08T10:00:00Z', 'OPEN', 'Tue 8 Dec 2026 11:00 CET, a Milan trading day the data had as a holiday'],
	// Hong Kong and Sydney: early closes added
	['XHKG', '2026-12-24T05:30:00Z', 'CLOSED', 'Thu 24 Dec 2026 13:30 HKT, no afternoon session on Christmas Eve'],
	['XHKG', '2026-12-24T03:00:00Z', 'OPEN', 'Thu 24 Dec 2026 11:00 HKT, the morning session (unchanged)'],
	['XASX', '2026-12-24T03:30:00Z', 'CLOSED', 'Thu 24 Dec 2026 14:30 AEDT, after normal trading ceases at 14:10'],
	['XASX', '2026-12-24T02:00:00Z', 'OPEN', 'Thu 24 Dec 2026 13:00 AEDT, before 14:10 (unchanged)'],
	// Korea
	['XKRX', '2026-02-16T01:00:00Z', 'CLOSED', 'Mon 16 Feb 2026 10:00 KST, Seollal'],
	['XKRX', '2026-01-29T01:00:00Z', 'OPEN', 'Thu 29 Jan 2026 10:00 KST, a trading day the data had as Lunar New Year'],
	['XKRX', '2026-06-03T01:00:00Z', 'CLOSED', 'Wed 3 Jun 2026 10:00 KST, the local election day'],
	// Japan
	['XJPX', '2026-08-11T01:00:00Z', 'CLOSED', 'Tue 11 Aug 2026 10:00 JST, Mountain Day'],
	['XJPX', '2026-08-10T01:00:00Z', 'OPEN', 'Mon 10 Aug 2026 10:00 JST, a trading day the data had as Mountain Day'],
	// Paris
	['XPAR', '2026-07-14T09:00:00Z', 'OPEN', 'Tue 14 Jul 2026 11:00 CEST, a Euronext Paris trading day'],
	// Other kinds of fix, one case each
	['XIST', '2026-10-28T08:00:00Z', 'OPEN', 'Wed 28 Oct 2026 11:00 TRT, a half day (to 13:00) the data had as a full holiday'],
	['XIST', '2026-10-28T11:00:00Z', 'CLOSED', 'Wed 28 Oct 2026 14:00 TRT, after the 13:00 half-day close (unchanged)'],
	['XSTO', '2026-04-02T12:00:00Z', 'CLOSED', 'Thu 2 Apr 2026 14:00 CEST, after the 13:00 half-day close'],
	['XSAU', '2026-03-29T08:00:00Z', 'OPEN', 'Sun 29 Mar 2026 11:00 AST, a Tadawul trading day the data had as Eid'],
	['XSAU', '2026-03-23T08:00:00Z', 'CLOSED', 'Mon 23 Mar 2026 11:00 AST, the Eid al-Fitr closure (16 to 24 Mar)'],
	['XSWX', '2026-01-02T10:00:00Z', 'CLOSED', 'Fri 2 Jan 2026 11:00 CET, a SIX market holiday'],
	['XCBO', '2026-06-19T15:00:00Z', 'CLOSED', 'Fri 19 Jun 2026 11:00 ET, Juneteenth'],
	['XNZE', '2026-07-09T23:00:00Z', 'CLOSED', 'Fri 10 Jul 2026 11:00 NZST, Matariki'],
	['XSHG', '2026-10-08T02:00:00Z', 'OPEN', 'Thu 8 Oct 2026 10:00 CST, trading resumed after National Day'],
	// Ruling R5: a year with no published calendar has no list, so UNKNOWN on its trading days
	['XNSE', '2027-01-13T05:30:00Z', 'UNKNOWN', 'Wed 13 Jan 2027 11:00 IST, no 2027 calendar published (R5)'],
	['XNSE', '2027-01-16T05:30:00Z', 'CLOSED', 'Sat 16 Jan 2027 11:00 IST, its weekend (R5, unchanged)'],
	['XBOM', '2027-01-13T05:30:00Z', 'UNKNOWN', 'Wed 13 Jan 2027 11:00 IST (R5)'],
	['XBOM', '2027-01-16T05:30:00Z', 'CLOSED', 'Sat 16 Jan 2027, its weekend (R5, unchanged)'],
	['XSAU', '2027-01-10T08:00:00Z', 'UNKNOWN', 'Sun 10 Jan 2027 11:00 AST, a Tadawul weekday (R5)'],
	['XSAU', '2027-01-15T08:00:00Z', 'CLOSED', 'Fri 15 Jan 2027, its weekend (R5, unchanged)'],
	['XDFM', '2027-01-11T07:00:00Z', 'UNKNOWN', 'Mon 11 Jan 2027 11:00 GST (R5)'],
	['XDFM', '2027-01-10T07:00:00Z', 'CLOSED', 'Sun 10 Jan 2027, its weekend (R5)'],
	['XIST', '2027-01-13T09:00:00Z', 'UNKNOWN', 'Wed 13 Jan 2027 12:00 TRT (R5)'],
	['XIST', '2027-01-16T09:00:00Z', 'CLOSED', 'Sat 16 Jan 2027, its weekend (R5, unchanged)'],
	['XBSP', '2027-01-13T15:00:00Z', 'UNKNOWN', 'Wed 13 Jan 2027 12:00 BRT (R5)'],
	['XBSP', '2027-01-16T15:00:00Z', 'CLOSED', 'Sat 16 Jan 2027, its weekend (R5, unchanged)'],
];

describe('B-498: the corrections, as instants (each read wrong at 1ce6d80 unless marked unchanged)', () => {
	for (const [mic, t, want, what] of named) {
		it(`${mic} ${what}: ${want}`, () => {
			expect(getScheduleStatus(mic, new Date(t)).status).toBe(want);
		});
	}
});

describe('B-498: XNYS, XNAS and XLON are unchanged (both checks found them right)', () => {
	const US26 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'];
	const US27 = ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'];
	const USHALF = [{ date: '2026-11-27', closeHour: 13, closeMinute: 0 }, { date: '2026-12-24', closeHour: 13, closeMinute: 0 }, { date: '2027-11-26', closeHour: 13, closeMinute: 0 }];
	const was: Record<string, unknown> = {
		XNYS: { holidays: { '2026': US26, '2027': US27 }, halfDays: USHALF, hours: [9, 30, 16, 0], weekends: undefined, lunchBreak: undefined },
		XNAS: { holidays: { '2026': US26, '2027': US27 }, halfDays: USHALF, hours: [9, 30, 16, 0], weekends: undefined, lunchBreak: undefined },
		XLON: {
			holidays: {
				'2026': ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'],
				'2027': ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28'],
			},
			halfDays: [{ date: '2026-12-24', closeHour: 12, closeMinute: 30 }, { date: '2026-12-31', closeHour: 12, closeMinute: 30 }, { date: '2027-12-24', closeHour: 12, closeMinute: 30 }, { date: '2027-12-31', closeHour: 12, closeMinute: 30 }],
			hours: [8, 0, 16, 30], weekends: undefined, lunchBreak: undefined,
		},
	};
	for (const mic of ['XNYS', 'XNAS', 'XLON']) {
		it(`${mic}: holidays, early closes, hours, weekend and lunch break equal what they were at 1ce6d80 (unchanged)`, () => {
			const c = scheduleConfigFor(mic)!;
			expect({ holidays: c.holidays, halfDays: c.halfDays, hours: [c.openHour, c.openMinute, c.closeHour, c.closeMinute], weekends: c.weekends, lunchBreak: c.lunchBreak }).toEqual(was[mic]);
		});
	}
});
