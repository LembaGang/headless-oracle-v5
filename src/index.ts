import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { createClient } from '@supabase/supabase-js';

ed.hashes.sha512 = sha512;

// ─── Environment ─────────────────────────────────────────────────────────────

export interface Env {
	ED25519_PRIVATE_KEY: string;
	ED25519_PUBLIC_KEY: string;
	MASTER_API_KEY: string;
	BETA_API_KEYS: string;
	PUBLIC_KEY_ID: string;
	PUBLIC_KEY_VALID_FROM?: string;
	PUBLIC_KEY_VALID_UNTIL?: string; // ISO 8601 — set when a key rotation is scheduled
	ORACLE_OVERRIDES:  KVNamespace;  // Cloudflare KV — manual circuit-breaker overrides (MIC codes only)
	ORACLE_API_KEYS:   KVNamespace;  // Cloudflare KV — paid key cache: sha256(key) → { plan, status, ... }, persistent
	ORACLE_TELEMETRY:  KVNamespace;  // Cloudflare KV — MCP client telemetry: mcp_clients:{date}:{ip_hash}
	// Billing secrets — set via `wrangler secret put`
	PADDLE_API_KEY?:            string;
	PADDLE_WEBHOOK_SECRET?:     string;
	PADDLE_PRICE_ID?:           string; // legacy — kept for backward compat; use tier-specific vars instead
	PADDLE_PRICE_ID_BUILDER?:   string; // pri_* for builder plan ($99/mo)
	PADDLE_PRICE_ID_PRO?:       string; // pri_* for pro plan ($299/mo)
	PADDLE_PRICE_ID_PROTOCOL?:  string; // pri_* for protocol plan ($500+/mo)
	SUPABASE_URL?:               string;
	SUPABASE_SERVICE_ROLE_KEY?:  string;
	RESEND_API_KEY?:             string;
}

// ─── Hex Helpers ─────────────────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const hash  = await crypto.subtle.digest('SHA-256', bytes);
	return toHex(new Uint8Array(hash));
}

// ─── Market Configuration ────────────────────────────────────────────────────
//
// All times are LOCAL to the exchange timezone.
// DST is handled automatically via Intl.DateTimeFormat with named IANA timezones.
// No hardcoded UTC offsets anywhere in this file.
//
// holidays is year-keyed: { '2026': ['YYYY-MM-DD', ...], '2027': [...] }
// If the current year has no entry, getScheduleStatus returns UNKNOWN (fail-closed).
// MAINTENANCE: Add next year's holidays before Dec 31 of each year.

interface HalfDay {
	date: string; // YYYY-MM-DD in local exchange timezone
	closeHour: number;
	closeMinute: number;
}

interface LunchBreak {
	startHour: number;
	startMinute: number;
	endHour: number;
	endMinute: number;
}

interface MarketConfig {
	name: string;
	timezone: string;
	openHour: number;
	openMinute: number;
	closeHour: number;
	closeMinute: number;
	holidays: Record<string, string[]>; // { 'YYYY': ['YYYY-MM-DD', ...] }
	halfDays?: HalfDay[];
	lunchBreak?: LunchBreak;
}

// Schedule edge cases per year are computed from live config by edgeCaseCount(year) below.
// The ~1,300/year figure in llms.txt and SKILL.md is derived from that function, not hardcoded.
const MARKET_CONFIGS: Record<string, MarketConfig> = {

	// ── United States ──────────────────────────────────────────────────────────
	XNYS: {
		name: 'New York Stock Exchange',
		timezone: 'America/New_York',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-19', // MLK Day
				'2026-02-16', // Presidents' Day
				'2026-04-03', // Good Friday
				'2026-05-25', // Memorial Day
				'2026-06-19', // Juneteenth
				'2026-07-03', // Independence Day (observed)
				'2026-09-07', // Labor Day
				'2026-11-26', // Thanksgiving
				'2026-12-25', // Christmas
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-18', // MLK Day (3rd Mon of Jan)
				'2027-02-15', // Presidents' Day (3rd Mon of Feb)
				'2027-03-26', // Good Friday (Easter = Mar 28)
				'2027-05-31', // Memorial Day (last Mon of May)
				'2027-06-18', // Juneteenth observed (Jun 19 = Sat → preceding Fri)
				'2027-07-05', // Independence Day observed (Jul 4 = Sun → following Mon)
				'2027-09-06', // Labor Day (1st Mon of Sep)
				'2027-11-25', // Thanksgiving (4th Thu of Nov)
				'2027-12-24', // Christmas observed (Dec 25 = Sat → preceding Fri)
			],
		},
		halfDays: [
			{ date: '2026-11-27', closeHour: 13, closeMinute: 0 }, // Black Friday 2026
			{ date: '2026-12-24', closeHour: 13, closeMinute: 0 }, // Christmas Eve 2026
			{ date: '2027-11-26', closeHour: 13, closeMinute: 0 }, // Black Friday 2027
			// No Christmas Eve half-day in 2027: Dec 24 is a full holiday (Christmas observed)
		],
	},

	XNAS: {
		name: 'NASDAQ',
		timezone: 'America/New_York',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01',
				'2026-01-19',
				'2026-02-16',
				'2026-04-03',
				'2026-05-25',
				'2026-06-19',
				'2026-07-03',
				'2026-09-07',
				'2026-11-26',
				'2026-12-25',
			],
			'2027': [
				'2027-01-01',
				'2027-01-18',
				'2027-02-15',
				'2027-03-26',
				'2027-05-31',
				'2027-06-18',
				'2027-07-05',
				'2027-09-06',
				'2027-11-25',
				'2027-12-24',
			],
		},
		halfDays: [
			{ date: '2026-11-27', closeHour: 13, closeMinute: 0 },
			{ date: '2026-12-24', closeHour: 13, closeMinute: 0 },
			{ date: '2027-11-26', closeHour: 13, closeMinute: 0 },
		],
	},

	// ── United Kingdom ─────────────────────────────────────────────────────────
	// DST: UK clocks spring forward 29 March 2026 (GMT→BST, UTC+0→UTC+1).
	// Intl with 'Europe/London' handles this automatically — no manual offset needed.
	XLON: {
		name: 'London Stock Exchange',
		timezone: 'Europe/London',
		openHour: 8, openMinute: 0,
		closeHour: 16, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-05-04', // Early May Bank Holiday
				'2026-05-25', // Spring Bank Holiday
				'2026-08-31', // Summer Bank Holiday
				'2026-12-25', // Christmas Day
				'2026-12-28', // Boxing Day (observed; Dec 26 falls on Saturday)
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-05-03', // Early May Bank Holiday (1st Mon of May)
				'2027-05-31', // Spring Bank Holiday (last Mon of May)
				'2027-08-30', // Summer Bank Holiday (last Mon of Aug)
				'2027-12-27', // Christmas Day observed (Dec 25 = Sat → Mon Dec 27)
				'2027-12-28', // Boxing Day observed (Dec 26 = Sun → Tue Dec 28)
			],
		},
		halfDays: [
			{ date: '2026-12-24', closeHour: 12, closeMinute: 30 }, // Christmas Eve 2026
			{ date: '2026-12-31', closeHour: 12, closeMinute: 30 }, // New Year's Eve 2026
			{ date: '2027-12-24', closeHour: 12, closeMinute: 30 }, // Christmas Eve 2027
			{ date: '2027-12-31', closeHour: 12, closeMinute: 30 }, // New Year's Eve 2027
		],
	},

	// ── Japan ──────────────────────────────────────────────────────────────────
	// Japan does not observe DST. JST = UTC+9 year-round.
	// JPX has a lunch break 11:30–12:30 local time.
	XJPX: {
		name: 'Japan Exchange Group (Tokyo)',
		timezone: 'Asia/Tokyo',
		openHour: 9, openMinute: 0,
		closeHour: 15, closeMinute: 30,
		lunchBreak: { startHour: 11, startMinute: 30, endHour: 12, endMinute: 30 },
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-12', // Coming of Age Day
				'2026-02-11', // National Foundation Day
				'2026-02-23', // Emperor's Birthday
				'2026-03-20', // Vernal Equinox Day
				'2026-04-29', // Showa Day
				'2026-05-03', // Constitution Day
				'2026-05-04', // Greenery Day
				'2026-05-05', // Children's Day
				'2026-05-06', // Substitute holiday
				'2026-07-20', // Marine Day
				'2026-08-10', // Mountain Day
				'2026-09-21', // Respect for the Aged Day
				'2026-09-22', // Autumnal Equinox Day
				'2026-10-12', // Sports Day
				'2026-11-03', // Culture Day
				'2026-11-23', // Labour Thanksgiving Day
				'2026-12-31', // New Year's Eve (closed)
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-11', // Coming of Age Day (2nd Mon of Jan)
				'2027-02-11', // National Foundation Day
				'2027-02-23', // Emperor's Birthday
				'2027-03-20', // Vernal Equinox Day (Sat — included for completeness)
				'2027-04-29', // Showa Day
				'2027-05-03', // Constitution Day
				'2027-05-04', // Greenery Day
				'2027-05-05', // Children's Day
				'2027-07-19', // Marine Day (3rd Mon of Jul)
				'2027-08-11', // Mountain Day
				'2027-09-20', // Respect for the Aged Day (3rd Mon of Sep)
				'2027-09-23', // Autumnal Equinox Day (approx — verify annually via Cabinet Office)
				'2027-10-11', // Sports Day (2nd Mon of Oct)
				'2027-11-03', // Culture Day
				'2027-11-23', // Labour Thanksgiving Day
				'2027-12-31', // New Year's Eve (closed)
			],
		},
	},

	// ── Euronext Paris ────────────────────────────────────────────────────────
	// DST: EU clocks spring forward 29 March 2026 (CET→CEST, UTC+1→UTC+2).
	XPAR: {
		name: 'Euronext Paris',
		timezone: 'Europe/Paris',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-05-01', // Labour Day
				'2026-05-14', // Ascension Day
				'2026-05-25', // Whit Monday
				'2026-07-14', // Bastille Day
				'2026-08-15', // Assumption of Mary
				'2026-11-01', // All Saints' Day
				'2026-11-11', // Armistice Day
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-05-01', // Labour Day (Sat — weekend, included for completeness)
				'2027-05-06', // Ascension Day (39 days after Easter Mar 28)
				'2027-05-17', // Whit Monday (Pentecost + 1)
				'2027-07-14', // Bastille Day
				'2027-08-15', // Assumption of Mary (Sun — weekend, included)
				'2027-11-01', // All Saints' Day
				'2027-11-11', // Armistice Day
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Boxing Day (Sun — weekend)
				'2027-12-27', // Christmas observed (Mon — Dec 25+26 both fall on weekends)
			],
		},
		halfDays: [
			{ date: '2026-12-24', closeHour: 14, closeMinute: 5 }, // Christmas Eve 2026
			{ date: '2026-12-31', closeHour: 14, closeMinute: 5 }, // New Year's Eve 2026
			{ date: '2027-12-24', closeHour: 14, closeMinute: 5 }, // Christmas Eve 2027
			{ date: '2027-12-31', closeHour: 14, closeMinute: 5 }, // New Year's Eve 2027
		],
	},

	// ── Hong Kong ─────────────────────────────────────────────────────────────
	// No DST. HKT = UTC+8 year-round.
	// HKEX has a lunch break 12:00–13:00 local time.
	XHKG: {
		name: 'Hong Kong Exchanges and Clearing',
		timezone: 'Asia/Hong_Kong',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 0,
		lunchBreak: { startHour: 12, startMinute: 0, endHour: 13, endMinute: 0 },
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-02-17', // Chinese New Year Day 1
				'2026-02-18', // Chinese New Year Day 2
				'2026-04-03', // Good Friday
				'2026-04-04', // Ching Ming Festival
				'2026-04-06', // Easter Monday
				'2026-05-01', // Labour Day
				'2026-05-15', // Buddha's Birthday
				'2026-06-10', // Dragon Boat Festival
				'2026-07-01', // HKSAR Establishment Day
				'2026-10-01', // National Day
				'2026-10-29', // Chung Yeung Festival
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-02-06', // Chinese New Year Day 1 (approx — verify via lunar calendar)
				'2027-02-07', // Chinese New Year Day 2 (approx — verify via lunar calendar)
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-04-05', // Ching Ming Festival (approx — 15th day after Spring Equinox)
				'2027-05-01', // Labour Day (Sat — weekend, included)
				'2027-05-23', // Buddha's Birthday (approx — 4th month, 8th day lunar)
				'2027-06-20', // Dragon Boat Festival (approx — 5th month, 5th day lunar)
				'2027-07-01', // HKSAR Establishment Day
				'2027-10-01', // National Day
				'2027-10-18', // Chung Yeung Festival (approx — 9th month, 9th day lunar)
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-27', // Christmas observed (Mon)
			],
		},
		halfDays: [
			{ date: '2026-02-16', closeHour: 12, closeMinute: 0 }, // CNY Eve 2026 (morning only)
			{ date: '2027-02-05', closeHour: 12, closeMinute: 0 }, // CNY Eve 2027 (approx — morning only)
		],
	},

	// ── Singapore ─────────────────────────────────────────────────────────────
	// No DST. SGT = UTC+8 year-round.
	XSES: {
		name: 'Singapore Exchange',
		timezone: 'Asia/Singapore',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-02-17', // Chinese New Year Day 1
				'2026-02-18', // Chinese New Year Day 2
				'2026-04-03', // Good Friday
				'2026-05-01', // Labour Day
				'2026-06-02', // Hari Raya Haji
				'2026-08-09', // National Day
				'2026-11-14', // Deepavali
				'2026-12-25', // Christmas Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-02-06', // Chinese New Year Day 1 (approx — lunar calendar)
				'2027-02-07', // Chinese New Year Day 2 (approx — lunar calendar)
				'2027-03-26', // Good Friday
				'2027-05-01', // Labour Day (Sat — weekend, included)
				'2027-05-22', // Hari Raya Haji (approx — Islamic calendar, ~11 days before 2026)
				'2027-08-09', // National Day
				'2027-11-06', // Deepavali (approx — Hindu calendar)
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-27', // Christmas observed (Mon)
			],
		},
	},
};

// ─── Edge Case Counter ────────────────────────────────────────────────────────
// Computes schedule edge cases directly from MARKET_CONFIGS for a given calendar year.
// Exported for testing — not part of the public HTTP surface.

function utcOffsetMinutes(timezone: string, at: Date): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false,
	}).formatToParts(at);
	const get = (t: Intl.DateTimeFormatPartTypes) =>
		parseInt(parts.find((p) => p.type === t)!.value, 10);
	const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return (localMs - at.getTime()) / 60_000;
}

export function edgeCaseCount(year: number): {
	holidays: number;
	halfDays: number;
	dstTransitions: number;
	lunchBreakSessions: number;
	weekendDays: number;
	total: number;
} {
	const yearStr = String(year);

	// Count every day of the year to get weekday/weekend totals
	let weekdaysInYear = 0;
	let weekendDaysInYear = 0;
	const cursor = new Date(Date.UTC(year, 0, 1));
	while (cursor.getUTCFullYear() === year) {
		const dow = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
		if (dow === 0 || dow === 6) weekendDaysInYear++;
		else weekdaysInYear++;
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}

	// Mid-winter and mid-summer samples for DST detection
	const janSample = new Date(Date.UTC(year, 0, 15));
	const julSample = new Date(Date.UTC(year, 6, 15));

	let holidays = 0;
	let halfDays = 0;
	let dstTransitions = 0;
	let lunchBreakSessions = 0;

	for (const config of Object.values(MARKET_CONFIGS)) {
		const yearHols = config.holidays[yearStr] ?? [];

		holidays += yearHols.length;

		if (config.halfDays) {
			halfDays += config.halfDays.filter((h) => h.date.startsWith(yearStr)).length;
		}

		// Compare UTC offset in January vs July — a difference means DST is observed
		if (utcOffsetMinutes(config.timezone, janSample) !== utcOffsetMinutes(config.timezone, julSample)) {
			dstTransitions += 2; // spring forward + fall back
		}

		if (config.lunchBreak) {
			// Trading days = weekdays minus holidays that actually fall on a weekday
			const weekdayHolidayCount = yearHols.filter((dateStr) => {
				const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
				return dow !== 0 && dow !== 6;
			}).length;
			lunchBreakSessions += weekdaysInYear - weekdayHolidayCount;
		}
	}

	const weekendDays = weekendDaysInYear * Object.keys(MARKET_CONFIGS).length;
	const total = holidays + halfDays + dstTransitions + lunchBreakSessions + weekendDays;
	return { holidays, halfDays, dstTransitions, lunchBreakSessions, weekendDays, total };
}

// ─── Local Time Helper ────────────────────────────────────────────────────────

interface LocalTimeParts {
	weekday: string;
	year: string;
	month: string;
	day: string;
	hour: number;
	minute: number;
	dateStr: string; // YYYY-MM-DD
}

function getLocalTimeParts(timezone: string, now: Date): LocalTimeParts {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit',
		weekday: 'short', hour12: false,
	}).formatToParts(now);

	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)!.value;

	const year   = get('year');
	const month  = get('month');
	const day    = get('day');

	return {
		weekday: get('weekday'),
		year, month, day,
		hour:    parseInt(get('hour'), 10),
		minute:  parseInt(get('minute'), 10),
		dateStr: `${year}-${month}-${day}`,
	};
}

// ─── Market Status Logic ──────────────────────────────────────────────────────

type StatusValue = 'OPEN' | 'CLOSED' | 'HALTED' | 'UNKNOWN';
type SourceValue = 'SCHEDULE' | 'OVERRIDE' | 'SYSTEM';

interface MarketStatusResult {
	status: StatusValue;
	source: SourceValue;
}

function isInSession(
	timeMinutes: number,
	openMinutes: number,
	closeMinutes: number,
	lunchBreak?: LunchBreak,
): boolean {
	if (timeMinutes < openMinutes || timeMinutes >= closeMinutes) return false;
	if (lunchBreak) {
		const lunchStart = lunchBreak.startHour * 60 + lunchBreak.startMinute;
		const lunchEnd   = lunchBreak.endHour   * 60 + lunchBreak.endMinute;
		if (timeMinutes >= lunchStart && timeMinutes < lunchEnd) return false;
	}
	return true;
}

function getScheduleStatus(mic: string, now: Date): MarketStatusResult {
	const config = MARKET_CONFIGS[mic];
	if (!config) return { status: 'UNKNOWN', source: 'SCHEDULE' };

	const { weekday, year, dateStr, hour, minute } = getLocalTimeParts(config.timezone, now);

	// Weekend
	if (weekday === 'Sat' || weekday === 'Sun') {
		return { status: 'CLOSED', source: 'SCHEDULE' };
	}

	// Fail-closed guard: if this year has no holiday data, returning OPEN would be wrong.
	// An agent cannot safely distinguish "no holidays" from "we forgot to update the list".
	const yearHolidays = config.holidays[year];
	if (!yearHolidays) {
		return { status: 'UNKNOWN', source: 'SYSTEM' };
	}

	// Full holiday
	if (yearHolidays.includes(dateStr)) {
		return { status: 'CLOSED', source: 'SCHEDULE' };
	}

	const timeMinutes = hour * 60 + minute;
	const openMinutes = config.openHour * 60 + config.openMinute;

	// Half-day early close check
	if (config.halfDays) {
		const halfDay = config.halfDays.find((h) => h.date === dateStr);
		if (halfDay) {
			const halfCloseMinutes = halfDay.closeHour * 60 + halfDay.closeMinute;
			const open = timeMinutes >= openMinutes && timeMinutes < halfCloseMinutes;
			return { status: open ? 'OPEN' : 'CLOSED', source: 'SCHEDULE' };
		}
	}

	// Normal session (with optional lunch break)
	const closeMinutes = config.closeHour * 60 + config.closeMinute;
	const open = isInSession(timeMinutes, openMinutes, closeMinutes, config.lunchBreak);
	return { status: open ? 'OPEN' : 'CLOSED', source: 'SCHEDULE' };
}

// ─── Next Session Calculator ──────────────────────────────────────────────────

interface NextSession {
	next_open:  string; // ISO 8601 UTC
	next_close: string; // ISO 8601 UTC
}

/**
 * Convert a local datetime string (no timezone suffix) + a named IANA timezone
 * into a UTC Date. Uses Intl to determine the correct offset for that date,
 * fully handling DST without any hardcoded offsets.
 */
function localToUTC(localDateTimeStr: string, timezone: string): Date {
	// Treat the local string as UTC naively to get a starting point
	const naiveUTC = new Date(localDateTimeStr + 'Z');

	// Ask Intl what the local clock shows for this UTC instant
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false,
	}).formatToParts(naiveUTC);

	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parseInt(parts.find((p) => p.type === type)!.value, 10);

	// Compute what UTC time would produce that local time
	const localAsUTC = Date.UTC(
		get('year'), get('month') - 1, get('day'),
		get('hour'), get('minute'), get('second'),
	);

	// The true UTC = naiveUTC adjusted by the difference
	return new Date(naiveUTC.getTime() + (naiveUTC.getTime() - localAsUTC));
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function getNextSession(mic: string, now: Date): NextSession | null {
	const config = MARKET_CONFIGS[mic];
	if (!config) return null;

	// Walk forward up to 14 calendar days
	const candidate = new Date(now);
	candidate.setUTCHours(0, 0, 0, 0);

	for (let i = 0; i < 14; i++) {
		const { weekday, dateStr, year, month, day } = getLocalTimeParts(config.timezone, candidate);

		// Fail-closed: if this year has no holiday coverage, stop rather than risk
		// returning a session date that falls on an unchecked holiday.
		const yearHolidays = config.holidays[year];
		if (!yearHolidays) return null;

		if (weekday !== 'Sat' && weekday !== 'Sun' && !yearHolidays.includes(dateStr)) {
			// Determine effective open/close for this day
			let closeH = config.closeHour;
			let closeM = config.closeMinute;

			if (config.halfDays) {
				const halfDay = config.halfDays.find((h) => h.date === dateStr);
				if (halfDay) {
					closeH = halfDay.closeHour;
					closeM = halfDay.closeMinute;
				}
			}

			const openUTC  = localToUTC(
				`${year}-${month}-${day}T${pad2(config.openHour)}:${pad2(config.openMinute)}:00`,
				config.timezone,
			);
			const closeUTC = localToUTC(
				`${year}-${month}-${day}T${pad2(closeH)}:${pad2(closeM)}:00`,
				config.timezone,
			);

			// Session is entirely in the past — move to next day
			if (closeUTC <= now) {
				candidate.setUTCDate(candidate.getUTCDate() + 1);
				continue;
			}

			// Session hasn't started yet — this is the next open
			if (openUTC > now) {
				return { next_open: openUTC.toISOString(), next_close: closeUTC.toISOString() };
			}

			// We are currently inside this session
			if (config.lunchBreak) {
				const lunchOpenUTC  = localToUTC(
					`${year}-${month}-${day}T${pad2(config.lunchBreak.startHour)}:${pad2(config.lunchBreak.startMinute)}:00`,
					config.timezone,
				);
				const lunchCloseUTC = localToUTC(
					`${year}-${month}-${day}T${pad2(config.lunchBreak.endHour)}:${pad2(config.lunchBreak.endMinute)}:00`,
					config.timezone,
				);
				if (now >= lunchOpenUTC && now < lunchCloseUTC) {
					// In lunch break — afternoon session is next open
					return { next_open: lunchCloseUTC.toISOString(), next_close: closeUTC.toISOString() };
				}
			}

			// Currently in session — next_open is right now, next_close is end of today's session
			return { next_open: now.toISOString(), next_close: closeUTC.toISOString() };
		}

		candidate.setUTCDate(candidate.getUTCDate() + 1);
	}

	return null; // no suitable session found within 14 days (or holiday coverage ran out)
}

// ─── Signing ─────────────────────────────────────────────────────────────────

async function signPayload(payload: Record<string, string>, privKeyHex: string): Promise<string> {
	// Canonical form: keys sorted alphabetically, serialised with no whitespace.
	// Deterministic regardless of JS object insertion order.
	// See /v5/keys → canonical_payload_spec for the published specification.
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(payload).sort()) {
		sorted[key] = payload[key];
	}
	const canonical = JSON.stringify(sorted);
	const msgBytes  = new TextEncoder().encode(canonical);
	const privKey   = fromHex(privKeyHex);
	const sig       = await ed.sign(msgBytes, privKey);
	return toHex(sig);
}

// ─── API Key Validation ───────────────────────────────────────────────────────
// Hot path order:
//   1. MASTER_API_KEY — allow immediately, no lookup
//   2. BETA_API_KEYS  — allow immediately, no lookup
//   3. KV cache hit   — { plan, status }; active→allow, suspended/cancelled→402
//   4. KV miss        — lookup Supabase, warm KV, then check status
//   5. Not found      — 403

type AuthResult = { allowed: true } | { allowed: false; status: 402 | 403; error: string; message: string };

async function checkApiKey(key: string, env: Env): Promise<AuthResult> {
	// Step 1: master key — fastest possible path
	if (key === env.MASTER_API_KEY) return { allowed: true };

	// Step 2: beta keys — no lookup
	if (env.BETA_API_KEYS) {
		const betaKeys = env.BETA_API_KEYS.split(',').map((k) => k.trim());
		if (betaKeys.includes(key)) return { allowed: true };
	}

	// Steps 3–5: paid key — hash once, use for KV and Supabase
	const keyHash = await sha256Hex(key);

	// Step 3: KV cache
	if (env.ORACLE_API_KEYS) {
		const cached = await env.ORACLE_API_KEYS.get(keyHash);
		if (cached) {
			const { status } = JSON.parse(cached) as { plan: string; status: string };
			if (status === 'active') return { allowed: true };
			// suspended or cancelled → 402 so agents know to fix payment, not rotate key
			return { allowed: false, status: 402, error: 'PAYMENT_REQUIRED', message: 'Subscription suspended or cancelled — renew at headlessoracle.com' };
		}
	}

	// Step 4: KV miss → Supabase lookup
	if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
		const { data } = await supabase
			.from('api_keys')
			.select('plan, status')
			.eq('key_hash', keyHash)
			.single();

		if (data) {
			// Warm the KV cache for subsequent requests
			if (env.ORACLE_API_KEYS) {
				await env.ORACLE_API_KEYS.put(
					keyHash,
					JSON.stringify({ plan: data.plan, status: data.status }),
					{ expirationTtl: 300 },
				);
			}
			if (data.status === 'active') return { allowed: true };
			return { allowed: false, status: 402, error: 'PAYMENT_REQUIRED', message: 'Subscription suspended or cancelled — renew at headlessoracle.com' };
		}
	}

	// Step 5: not found anywhere
	return { allowed: false, status: 403, error: 'INVALID_API_KEY', message: 'Invalid API key' };
}

// ─── Paddle Webhook Signature Verification ────────────────────────────────────
// Paddle signs webhooks with HMAC-SHA256 using the webhook secret.
// Header format: "ts=<timestamp>;h1=<hex_signature>"
// Signed payload: "<timestamp>:<raw_body>"
// Reject events older than 5 minutes to prevent replay attacks.

async function verifyPaddleSignature(
	rawBody: string,
	sigHeader: string,
	secret: string,
): Promise<boolean> {
	const parts: Record<string, string> = {};
	for (const part of sigHeader.split(';')) {
		const eqIdx = part.indexOf('=');
		if (eqIdx !== -1) parts[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
	}
	const timestamp = parts['ts'];
	const h1        = parts['h1'];
	if (!timestamp || !h1) return false;

	// Replay attack protection: reject signatures older than 5 minutes
	const ageSec = Date.now() / 1000 - parseInt(timestamp, 10);
	if (ageSec > 300) return false;

	const signedContent = `${timestamp}:${rawBody}`;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig      = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
	const expected = toHex(new Uint8Array(sig));
	return expected === h1;
}

// ─── Supported Exchange Directory ─────────────────────────────────────────────

const SUPPORTED_EXCHANGES = Object.entries(MARKET_CONFIGS).map(([mic, cfg]) => ({
	mic,
	name:     cfg.name,
	timezone: cfg.timezone,
}));

// ─── MICs Registry ────────────────────────────────────────────────────────────
// Served at GET /mics.json for agent discovery.
//
// DESIGN: mic, name, timezone are derived from MARKET_CONFIGS (single source of
// truth). MICS_SUPPLEMENT holds only the fields that MARKET_CONFIGS does not
// carry: country (ISO 3166-1 alpha-2), currency (ISO 4217), sameAs.
// One change to MARKET_CONFIGS propagates automatically — no manual sync needed.

const MICS_SUPPLEMENT: Record<string, { country: string; currency: string; sameAs: string }> = {
	XNYS: { country: 'US', currency: 'USD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XNAS: { country: 'US', currency: 'USD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XLON: { country: 'GB', currency: 'GBP', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XJPX: { country: 'JP', currency: 'JPY', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XPAR: { country: 'FR', currency: 'EUR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XHKG: { country: 'HK', currency: 'HKD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSES: { country: 'SG', currency: 'SGD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
};

// Derived: mic, name, timezone from MARKET_CONFIGS; supplementary fields from MICS_SUPPLEMENT.
// Order follows MARKET_CONFIGS insertion order — canonical across all endpoints.
const MICS_REGISTRY = Object.entries(MARKET_CONFIGS).map(([mic, cfg]) => ({
	mic,
	name:     cfg.name,
	country:  MICS_SUPPLEMENT[mic].country,
	timezone: cfg.timezone,
	currency: MICS_SUPPLEMENT[mic].currency,
	sameAs:   MICS_SUPPLEMENT[mic].sameAs,
}));

// ─── Receipt TTL ─────────────────────────────────────────────────────────────
// Signed receipts expire this many seconds after issued_at.
// Consumers MUST NOT act on a receipt whose expires_at has passed.
const RECEIPT_TTL_SECONDS = 60;

// ─── Static discovery files ───────────────────────────────────────────────────
// Served as plain text. robots.txt signals to AI crawlers which paths are open.
// llms.txt (llmstxt.org convention) provides a machine-readable summary for LLMs.

const ROBOTS_TXT = `User-agent: *
Allow: /llms.txt
Allow: /SKILL.md
Allow: /openapi.json
Allow: /.well-known/
Allow: /v5/demo
Allow: /v5/schedule
Allow: /v5/exchanges
Allow: /v5/keys
Allow: /v5/health
Allow: /mics.json
Disallow:
`;

const LLMS_TXT = `# Headless Oracle

> Market status API built for AI agents. Cryptographically signed attestations of whether global stock exchanges are OPEN, CLOSED, HALTED, or UNKNOWN — purpose-built for autonomous trading agents, DeFi bots, and AI-driven execution systems in the tokenized RWA economy.

This is a defensive execution layer — not a price feed. It is a compliance-grade safety primitive that prevents automated systems from executing trades during market closures, circuit breaker halts, holiday closures, and unscheduled outages. Every API response is a Liability Receipt: cryptographically signed, timestamped, independently verifiable proof that your agent checked before it executed.

## Supported Exchanges (7)

XNYS — New York Stock Exchange
XNAS — NASDAQ
XLON — London Stock Exchange
XJPX — Japan Exchange Group (Tokyo) — has lunch break
XPAR — Euronext Paris
XHKG — Hong Kong Stock Exchange — has lunch break
XSES — Singapore Exchange

All exchanges use ISO 10383 Market Identifier Codes (MIC).

## Critical Safety Protocol for Autonomous Agents

- [Fail-Closed Mandate](https://headlessoracle.com/terms.html#fail-closed): MANDATORY — If the API returns status UNKNOWN, times out after 4 seconds, or returns any 5xx error, treat ALL markets as CLOSED and halt execution immediately. This is a binding contractual obligation under the Terms of Service. Ignoring an UNKNOWN signal constitutes breach of terms and shifts 100% of liability to the agent operator. Design your agent fail-closed or do not integrate.

- [Ed25519 Signature Verification](https://headlessoracle.com/docs.html#verification): Every API response includes an Ed25519 signature generated over the raw JSON-stringified payload (excluding the signature field). Agents MUST verify against the published public key BEFORE acting on any status data. Unverified payloads have zero attestation weight and no legal standing.

- Receipt Expiry: Every signed receipt includes an \`expires_at\` timestamp. Do not act on a receipt past its \`expires_at\`. Fetch a fresh status instead.

- [Binding Terms of Service](https://headlessoracle.com/terms.html): Any API request — authenticated or unauthenticated, human or autonomous — constitutes acceptance of these terms.

## API Endpoints

### GET /v5/status — Real-Time Market Status (Signed)

Primary endpoint. Returns cryptographically signed market status for a single exchange.

- Required parameter: \`mic\` (ISO 10383 MIC code)
- Required header: \`X-Oracle-Key\` (your API key)
- Response fields: \`receipt_id\` (UUID), \`issued_at\` (ISO 8601), \`expires_at\` (ISO 8601), \`mic\` (string), \`status\` (enum: OPEN | CLOSED | HALTED | UNKNOWN), \`source\` (enum: SCHEDULE | OVERRIDE | SYSTEM), \`receipt_mode\` (enum: demo | live), \`schema_version\` (string), \`public_key_id\` (string), \`signature\` (hex-encoded Ed25519)
- [Full API docs](https://headlessoracle.com/docs.html)

### GET /v5/schedule — Market Schedule Lookup (Unsigned)

Returns next open/close times for a given exchange. Use for planning execution windows and scheduling tasks around market hours. Includes lunch break windows for XJPX and XHKG.

- NOT cryptographically signed — schedule-based only, does not reflect real-time halts
- For verified real-time status, use /v5/status instead

### GET /v5/exchanges — Exchange Discovery

Returns all 7 supported exchanges with MIC codes, full names, and IANA timezone identifiers. Use to discover available markets or resolve exchange names to MIC codes.

### GET /mics.json — Exchange Registry (ISO Metadata)

All 7 supported exchanges with MIC codes, names, timezones, currencies, and ISO 20022 registry links. No auth required.

- Fields per entry: \`mic\` (ISO 10383), \`name\`, \`country\` (ISO 3166-1 alpha-2), \`timezone\` (IANA), \`currency\` (ISO 4217), \`sameAs\` (ISO 20022 MIC registry URL)
- Response is a JSON array, not an object wrapper — parse with \`JSON.parse(body)\` directly
- Cache-Control: public, max-age=86400 — safe to cache for 24 hours
- Use to build MIC-selection UI, validate MIC codes, or resolve exchange metadata without calling the live API

### GET /v5/demo — Try It Live

Interactive demo endpoint. No API key required. Test the API and see a live signed response.

- [Try the demo](https://headlessoracle.com/v5/demo)

### GET /v5/batch — Batch Status Check (Signed)

Returns signed status receipts for multiple exchanges in one authenticated request.

- Required header: \`X-Oracle-Key\` (your API key)
- Required parameter: \`mics\` (comma-separated MIC codes, e.g. \`XNYS,XNAS,XLON\`)
- All MICs validated up front — invalid MIC returns 400 for the entire request
- Each receipt is independently signed and verifiable in isolation
- Tier 3 signing failure fails the whole batch (never partial results from a broken signing key)

### GET /v5/keys — Public Key Registry

Returns the current Ed25519 public key and the canonical payload specification for independent verification.

- No authentication required
- Response: key_id, algorithm, format, public_key (hex), valid_from, valid_until (null if no rotation scheduled)
- Also returns \`canonical_payload_spec\` documenting the exact field list and sort order for all receipt types
- Matching well-known endpoint: GET /.well-known/oracle-keys.json (RFC 8615 standard discovery URI)

### GET /v5/health — Liveness Probe (Signed)

Returns a signed receipt confirming Oracle signing infrastructure is alive.

- No authentication required
- Response fields: receipt_id, issued_at, expires_at, status ("OK"), source ("SYSTEM"), public_key_id, signature
- Use to distinguish Oracle-is-down from market-is-UNKNOWN
- 200 + valid signature = Oracle alive; 500 CRITICAL_FAILURE = signing system offline

### GET /v5/account — Account Info

Returns plan and status for the authenticated API key.

- Required header: \`X-Oracle-Key\` (your API key)
- Response: plan ("pro" or "internal"), status ("active", "suspended", "cancelled"), key_prefix
- Returns 402 PAYMENT_REQUIRED if subscription is suspended or cancelled

### POST /v5/checkout — Start a Subscription

Creates a Paddle checkout session and returns a redirect URL.

- No authentication required
- No request body required
- Response: \`{ "url": "https://..." }\` — redirect to this URL to complete payment
- After successful payment, your API key is delivered by email (shown once)
- Keys are prefixed \`ok_live_\` for easy identification in logs and config

### POST /v5/keys/request — Free Tier Key

Provision a free tier API key by email — no payment required.

- No authentication required
- Request body: \`{ "email": "you@example.com" }\`
- Response: \`200 OK\` — key delivered to email (shown once, prefixed \`ho_free_\`)
- Free tier is rate-limited; upgrade at headlessoracle.com/pricing
- Agent frameworks that receive a 401 with \`X-Oracle-Key-Request\` header can hit this endpoint to self-provision

## MCP Integration

Headless Oracle is available as an MCP (Model Context Protocol) server for direct integration with Claude, GPT, and other AI agent frameworks.

MCP tools available:
- \`get_market_status\` — real-time signed status check
- \`get_market_schedule\` — next open/close times with lunch breaks
- \`list_exchanges\` — discover supported markets and MIC codes

Setup: Add the Headless Oracle MCP server to your agent's tool configuration. See [MCP setup instructions](https://headlessoracle.com/docs.html#mcp).

## Trust and Verification

- [Ed25519 Public Key](https://headlessoracle.com/ed25519-public-key.txt): Current signing public key for independent verification.
  Active Key ID: key_2026_v1

- [Public Key Registry (JSON)](https://headlessoracle.com/.well-known/oracle-keys.json): Machine-readable key endpoint.

- [Receipt Verifier](https://headlessoracle.com/verify.html): Client-side browser tool for verifying any Liability Receipt. Paste JSON, verify Ed25519 signature instantly. Zero server-side processing.

- [Status Page](https://headlessoracle.com/v5/health): Real-time infrastructure health (signed liveness probe).

## Use Cases

- RWA Trading Bot Integration: Prevents execution outside traditional market hours for tokenized Treasury and equity products that reference TradFi prices. Blocks settlement failures, NAV miscalculations, and redemption errors.

- DeFi Synthetic Equity Safety Gate: Gate minting, redemption, liquidation, and rebalancing behind cryptographically attested market status checks for synthetic equity and perpetual futures protocols.

- Autonomous Agent Risk Stack: Market status is Gate Zero — the first check before price oracle query, gas estimation, position sizing, and execution routing.

## Code Examples

### Python — Ed25519 Signature Verification (PyNaCl)

\`\`\`python
import json, requests
from nacl.signing import VerifyKey

PUBLIC_KEY_HEX = "03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178"

def verify_receipt(receipt: dict) -> bool:
    sig = receipt.pop("signature")
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    try:
        VerifyKey(bytes.fromhex(PUBLIC_KEY_HEX)).verify(
            canonical.encode(), bytes.fromhex(sig)
        )
        return True
    except Exception:
        return False

receipt = requests.get("https://headlessoracle.com/v5/demo").json()
assert verify_receipt(dict(receipt))
\`\`\`

### JavaScript — Ed25519 Verification (Web Crypto API)

\`\`\`javascript
async function verifyReceipt(receipt) {
  const { signature, ...payload } = receipt;
  const sorted = {};
  for (const key of Object.keys(payload).sort()) sorted[key] = payload[key];
  const canonical = JSON.stringify(sorted);
  const keyBytes  = hexToBytes("03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178");
  const sigBytes  = hexToBytes(signature);
  const msgBytes  = new TextEncoder().encode(canonical);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "Ed25519" }, false, ["verify"]
  );
  return crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, sigBytes, msgBytes);
}
function hexToBytes(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
}
\`\`\`

### Python — Fail-Closed Bot Integration Pattern

\`\`\`python
import requests, json
from nacl.signing import VerifyKey

ORACLE_KEY = "03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178"
API_KEY    = "your_api_key"

def is_market_confirmed_open(mic: str = "XNYS") -> bool:
    """
    Returns True ONLY if Oracle confirms OPEN and Ed25519 signature is valid.
    Returns False on any failure — timeout, UNKNOWN, invalid sig, exception.
    Fail-closed by design.
    """
    try:
        receipt = requests.get(
            f"https://headlessoracle.com/v5/status",
            params={"mic": mic},
            headers={"X-Oracle-Key": API_KEY},
            timeout=4,
        ).json()
        sig = receipt.pop("signature")
        canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
        VerifyKey(bytes.fromhex(ORACLE_KEY)).verify(
            canonical.encode(), bytes.fromhex(sig)
        )
        return receipt.get("status") == "OPEN"
    except Exception:
        return False  # Fail-closed

# In your execution loop:
if position_needs_action and is_market_confirmed_open("XNYS"):
    execute_trade()
else:
    log("Execution deferred: market not confirmed OPEN")
\`\`\`

### Python — Programmatic Key Fetching

\`\`\`python
def get_oracle_public_key(fallback: str) -> str:
    """Always fall back to the hardcoded key if the fetch fails."""
    try:
        resp = requests.get("https://headlessoracle.com/v5/keys", timeout=4)
        return resp.json()["keys"][0]["public_key"]
    except Exception:
        return fallback
\`\`\`

## Known Schedule Risk Events (DST 2026)

Any bot using hardcoded UTC offsets will compute incorrect open/close times after these dates. Headless Oracle handles all transitions automatically — no action required on your end.

| Date             | Event                                              | Affected Markets |
|------------------|----------------------------------------------------|------------------|
| March 8, 2026    | US clocks spring forward (EST → EDT, UTC-5 → UTC-4) | XNYS, XNAS     |
| March 29, 2026   | UK/EU clocks spring forward (GMT/CET → BST/CEST)  | XLON, XPAR       |
| October 25, 2026 | UK/EU clocks fall back (BST/CEST → GMT/CET)       | XLON, XPAR       |
| November 1, 2026 | US clocks fall back (EDT → EST, UTC-4 → UTC-5)    | XNYS, XNAS       |

## Edge Cases This API Handles

Most timezone libraries return correct UTC offsets. They do not know when markets are actually closed. Headless Oracle handles the following edge cases automatically — no configuration required:

- **DST transitions (3-week phantom window)**: US and UK/EU clocks shift on different dates, creating a 3-week window each spring and autumn where hardcoded UTC offsets produce wrong open/close times. Headless Oracle uses IANA timezone names exclusively — all transitions are handled automatically via \`Intl.DateTimeFormat\`.

- **Exchange-specific holidays (67 across 7 venues)**: Each exchange observes a distinct calendar. Japanese national holidays differ from NYSE closures. Hong Kong observes Lunar New Year. Singapore observes Deepavali. All 67 holidays are encoded, year-keyed, and fail-closed if a year's data is missing.

- **Early close days**: Several exchanges close early on certain days (Christmas Eve, day before US Thanksgiving, day before US Independence Day). These are not timezone issues — they require explicit schedule awareness that timezone libraries do not carry.

- **Lunch breaks (XJPX, XHKG)**: Tokyo halts trading 11:30–12:30 JST; Hong Kong halts 12:00–13:00 HKT. A system that assumes continuous trading during market hours will act during a closed window on ~490 trading days per year.

- **Circuit breaker halts**: Exchange-wide trading halts triggered by volatility events are unscheduled and cannot be computed from a calendar. Headless Oracle exposes these via KV overrides — a signed HALTED receipt with a human-readable reason, propagated without redeployment.

- **Weekend boundary calculations**: The Tokyo Monday open occurs Sunday evening UTC. The London Friday close occurs Friday afternoon UTC. Systems without timezone-aware schedule logic compute these transitions incorrectly, especially across the international date line.

- **UNKNOWN status handling**: When Headless Oracle cannot determine market state (signing failure, missing calendar data for the current year), it returns UNKNOWN rather than defaulting to OPEN. Consumers are contractually required to treat UNKNOWN as CLOSED. This fail-closed contract is enforced at the protocol level — not just documented.

Across all 7 exchanges, approximately **1,300 schedule edge cases per year** fall into one of the above categories. A hardcoded timezone offset handles zero of them.

## Receipt Portability

Signed receipts are self-contained and verifiable by any party that holds the public key. This enables a multi-agent trust pattern where receipt verification is decoupled from receipt issuance.

Every receipt contains an \`issuer\` field identifying the oracle (value: \`"headlessoracle.com"\`). Agents encountering an unfamiliar receipt can resolve the issuer domain to discover the oracle's public key endpoint at \`{issuer}/v5/keys\` — no prior knowledge of Headless Oracle required.

**Pattern: Agent A fetches, Agent B verifies**

1. Agent A calls \`GET /v5/demo\` (or \`/v5/status\` with an API key) and receives a signed receipt.
2. Agent A passes the receipt JSON to Agent B as part of its output or context.
3. Agent B independently verifies the receipt using the public key at \`/.well-known/oracle-keys.json\` — without making a new API call.
4. Agent B checks \`expires_at\` to ensure the receipt has not gone stale (60-second TTL).
5. Agent B checks \`receipt_mode\`: \`'demo'\` receipts are unauthenticated (suitable for testing); \`'live'\` receipts require an API key (suitable for production decisions).

**Verification steps (any language)**:

\`\`\`
1. Fetch public key: GET /.well-known/oracle-keys.json → keys[0].public_key (hex)
2. Build canonical payload: collect all receipt fields except signature, sort keys alphabetically, JSON.stringify with no whitespace
3. Verify Ed25519 signature: ed25519.verify(hex_decode(receipt.signature), utf8_encode(canonical), hex_decode(public_key))
4. Check expiry: new Date(receipt.expires_at) > Date.now()
5. Check receipt_mode: assert 'live' for production decisions
6. Trust status: treat UNKNOWN or HALTED as CLOSED — never execute on ambiguous state
\`\`\`

**Why this matters at agent scale**: An orchestrator agent can check market state once and distribute the signed receipt to 10 sub-agents. Each sub-agent independently verifies without rate-limit pressure on the Oracle API. The cryptographic proof travels with the data.

**Convenience**: Use the \`@headlessoracle/verify\` npm package for a 3-line verification wrapper (zero production dependencies, Web Crypto API, ESM + CJS):

\`\`\`js
import { verify } from '@headlessoracle/verify';
const result = await verify(receipt);
if (!result.valid) throw new Error(result.reason); // EXPIRED | INVALID_SIGNATURE | ...
\`\`\`
## Legal

- [Terms of Service](https://headlessoracle.com/terms.html): Headless Oracle operates under the Lowe v. SEC (1985) publisher exclusion. Provides probabilistic market context, not deterministic trading signals. No fiduciary, advisory, or broker-dealer relationship is formed. Total liability capped at fees paid in the 12 months preceding any claim.

- [Privacy Policy](https://headlessoracle.com/privacy.html): Minimal data collection. Collected: API key identifier, request timestamp, MIC code. NOT collected: portfolio data, positions, balances, wallet addresses.

## Agent Discovery

- [Skill File](https://headlessoracle.com/SKILL.md): Step-by-step integration guide optimised for AI agents. Covers MCP setup, HTTP patterns, code examples, safety rules, and common mistakes.
- [Agent Metadata](https://headlessoracle.com/.well-known/agent.json): Structured JSON describing capabilities, MCP tools, and discovery endpoints.
- [OpenAPI Spec](https://headlessoracle.com/openapi.json): Machine-readable API contract (OpenAPI 3.1).
- [MCP Endpoint](https://headlessoracle.com/mcp): Protocol version 2024-11-05. Tools: get_market_status, get_market_schedule, list_exchanges.

## Robots

AI crawlers are welcome. This file is at /llms.txt. The robots.txt permits crawling of /llms.txt, /SKILL.md, and all public documentation.
`;

// SKILL.md — step-by-step integration guide optimised for AI agents.
// Intentionally concise and action-first: agents parse this to decide how to integrate.
const SKILL_MD = `# Headless Oracle — Agent Integration Guide

## What This Is

Headless Oracle returns cryptographically signed receipts that tell you whether a stock exchange is **OPEN**, **CLOSED**, **HALTED**, or **UNKNOWN**. Every receipt includes an Ed25519 signature you can verify offline.

**Primary consumer**: autonomous agents making execution decisions that depend on market state.

---

## When to Use Headless Oracle vs a Timezone Library

| A timezone library is sufficient | You need Headless Oracle |
|----------------------------------|--------------------------|
| Displaying local time to a user | Gating trade execution on market state |
| Computing UTC offsets | Detecting exchange holiday closures (67 across 7 venues) |
| Formatting timestamps | Handling unscheduled circuit breaker halts |
| Scheduling calendar events | Detecting early close days |
| Building a world clock | Lunch break windows (XJPX 11:30–12:30 JST, XHKG 12:00–13:00 HKT) |
| Converting between timezones | DST correctness across 7 separate exchange calendars |
| Checking if an office is open | Cryptographic proof that you checked before executing |
| | Fail-closed UNKNOWN when state cannot be determined |

**Rule of thumb**: If your code makes financial execution decisions based on time, a timezone library is necessary but not sufficient. You need attestable market state, not computable clock time. Across all 7 exchanges, approximately 1,300 schedule edge cases per year require explicit handling beyond UTC offset arithmetic.

---

## Safety Rules (Read First)

1. **UNKNOWN means CLOSED.** If the receipt status is UNKNOWN, halt all execution. Do not proceed.
2. **Check expires_at.** Receipts expire 60 seconds after issuance. Reject expired receipts.
3. **Verify the signature.** Use \`@headlessoracle/verify\` (npm) or implement Ed25519 verification via Web Crypto. Never trust an unverified receipt.
4. **HALTED overrides OPEN.** If a KV override is active, the receipt will say HALTED with a reason. Treat HALTED as CLOSED.

---

## Option A: MCP (Recommended for Claude/Cursor/MCP-compatible agents)

MCP (Model Context Protocol) lets Claude, Cursor, and any MCP-compatible agent call Headless Oracle as a native tool — no API key required for demo, no HTTP code to write.

### Claude Desktop setup

Open \`~/Library/Application Support/Claude/claude_desktop_config.json\` (macOS) or \`%APPDATA%\Claude\claude_desktop_config.json\` (Windows). Add:

\`\`\`json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"]
    }
  }
}
\`\`\`

Restart Claude Desktop. You will see "headless-oracle" in the tool list. Ask Claude: *"Is the NYSE open right now?"*

### Cursor setup

Open Cursor → Settings → MCP Servers → Add Server. Enter:
- Name: \`headless-oracle\`
- Command: \`npx\`
- Args: \`-y mcp-remote https://headlessoracle.com/mcp\`

### Custom agent (any MCP client)

\`\`\`
POST https://headlessoracle.com/mcp
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
\`\`\`

Then call tools/call with \`get_market_status\`, \`get_market_schedule\`, or \`list_exchanges\`.

### Available tools

| Tool | Description | Required params |
|------|-------------|-----------------|
| \`get_market_status\` | Signed receipt (OPEN/CLOSED/HALTED/UNKNOWN) | \`mic\` (e.g. "XNYS") |
| \`get_market_schedule\` | Next open/close times in UTC | \`mic\` |
| \`list_exchanges\` | All 7 supported exchanges with names and timezones | none |

The MCP tools use the same 4-tier fail-closed logic as the REST API. UNKNOWN always means CLOSED.

---

## Option B: HTTP REST

**Check if NYSE is open (no auth required for demo):**
\`\`\`
GET https://headlessoracle.com/v5/demo?mic=XNYS
\`\`\`

**Authenticated status check:**
\`\`\`
GET https://headlessoracle.com/v5/status?mic=XNYS
X-Oracle-Key: your_api_key
\`\`\`

**Batch — multiple exchanges in one request:**
\`\`\`
GET https://headlessoracle.com/v5/batch?mics=XNYS,XNAS,XLON
X-Oracle-Key: your_api_key
\`\`\`

**Response shape (signed receipt):**
\`\`\`json
{
  "receipt_id": "uuid",
  "issued_at":  "2026-02-26T09:00:00Z",
  "expires_at": "2026-02-26T09:01:00Z",
  "mic":        "XNYS",
  "status":     "OPEN",
  "source":     "SCHEDULE",
  "schema_version": "v5.0",
  "public_key_id":  "03dc2799...",
  "signature":      "hex..."
}
\`\`\`

---

## Option C: Verify a Receipt

Install the SDK:
\`\`\`
npm install @headlessoracle/verify
\`\`\`

\`\`\`typescript
import { verify } from '@headlessoracle/verify';

const result = await verify(receipt);
if (!result.ok) {
  // result.reason: MISSING_FIELDS | EXPIRED | UNKNOWN_KEY | INVALID_SIGNATURE | KEY_FETCH_FAILED | INVALID_KEY_FORMAT
  haltExecution();
}
if (receipt.status !== 'OPEN') {
  haltExecution();
}
\`\`\`

---

## Supported Exchanges (MIC codes)

| MIC   | Exchange                   | Timezone             |
|-------|----------------------------|----------------------|
| XNYS  | NYSE                       | America/New_York     |
| XNAS  | NASDAQ                     | America/New_York     |
| XLON  | London Stock Exchange      | Europe/London        |
| XJPX  | Japan Exchange Group       | Asia/Tokyo           |
| XPAR  | Euronext Paris             | Europe/Paris         |
| XHKG  | Hong Kong Exchanges        | Asia/Hong_Kong       |
| XSES  | Singapore Exchange         | Asia/Singapore       |

---

## Common Mistakes

- **Caching OPEN receipts across open/close boundaries.** Receipts expire in 60s. Re-fetch before each execution decision.
- **Ignoring UNKNOWN.** UNKNOWN means the oracle cannot determine state. Treat as CLOSED — always.
- **Using a workers.dev URL.** The canonical base URL is \`https://headlessoracle.com\`. The workers.dev URL is not stable.
- **Skipping signature verification.** The signature is the trust anchor. Without it you are trusting the network, not the oracle.

---

## Sharing Receipts Between Agents

Receipts are portable bearer attestations. If your agent receives a receipt from another agent or system, you can verify it independently without calling the API:

1. Fetch the public key: \`GET /.well-known/oracle-keys.json\` → \`keys[0].public_key\` (hex). Cache for 5 minutes.
2. Reconstruct the canonical payload: collect all receipt fields except \`signature\`, sort keys alphabetically, \`JSON.stringify\` with no whitespace.
3. Verify the Ed25519 signature: \`ed25519.verify(hex_decode(receipt.signature), utf8_encode(canonical), hex_decode(public_key))\`
4. Check expiry: \`new Date(receipt.expires_at) > Date.now()\`
5. Check \`receipt_mode\`: assert \`'live'\` for production decisions. \`'demo'\` receipts are unauthenticated.
6. If all pass, trust the receipt as if you fetched it yourself.

This eliminates redundant API calls when multiple agents in a pipeline need market status. An orchestrator can check once and distribute the signed receipt to sub-agents — each verifies locally, no rate-limit pressure on the oracle.

Use \`@headlessoracle/verify\` (npm, zero deps) for a 3-line wrapper:

\`\`\`js
import { verify } from '@headlessoracle/verify';
const result = await verify(receipt);
if (!result.valid) throw new Error(result.reason); // EXPIRED | INVALID_SIGNATURE | ...
\`\`\`

---

## Getting an API Key

- **Free tier**: \`POST /v5/keys/request\` with \`{ "email": "you@example.com" }\` — key delivered by email, no payment required. Keys are prefixed \`ho_free_\`.
- **Paid plans**: \`POST /v5/checkout\` — Paddle checkout, key delivered by email after payment. Plans: Builder ($99/mo), Pro ($299/mo), Protocol ($500/mo).
- Agent frameworks that receive a 401 with \`X-Oracle-Key-Request: https://headlessoracle.com/v5/keys/request\` can use that URL to self-provision a free key without human intervention.

---

## Discovery Endpoints

- \`GET /v5/keys\` — public key + canonical payload spec for independent verification
- \`GET /.well-known/oracle-keys.json\` — RFC 8615 key discovery
- \`GET /.well-known/agent.json\` — structured agent metadata (capabilities, tools, endpoints)
- \`GET /openapi.json\` — OpenAPI 3.1 machine-readable spec
- \`GET /v5/health\` — signed liveness probe (verify oracle is up before a batch)
- \`GET /v5/schedule?mic=XNYS\` — next open/close times, lunch breaks, public holidays
- \`POST /v5/keys/request\` — free tier key self-provisioning (no payment required)
`;

// FNV-1a 32-bit hash — deterministic, synchronous, no crypto API needed.
// Only used for cache-invalidation ETags; not a security primitive.
function fnv1a32(str: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

// Computed once at module load. SKILL_MD_LAST_MOD and DEPLOY_DATE update automatically
// on every deploy — no manual bump needed. ETag is derived from content, not date.
const SKILL_MD_ETAG     = `"${fnv1a32(SKILL_MD)}"`;
const SKILL_MD_LAST_MOD = new Date().toUTCString();         // RFC 7231 HTTP-date format
const DEPLOY_DATE       = new Date().toISOString().slice(0, 10); // YYYY-MM-DD for spec_version

// Canonical issuer identifier — included in every signed payload so receipts are self-describing.
// Agents encountering an unfamiliar receipt can resolve {issuer}/v5/keys to find the public key.
const ORACLE_ISSUER = 'headlessoracle.com';

// agent.json — structured agent metadata for programmatic discovery.
// Follows the emerging agent.json convention (no formal spec yet — designed to be stable).
// Intentionally minimal: capabilities, tools, endpoints, and trust anchors only.
const AGENT_JSON = {
	schema_version: '1.0',
	spec_version:   DEPLOY_DATE,
	name:           'Headless Oracle',
	description:    'Cryptographically signed market-state attestations for AI agents. Ed25519-signed receipts for 7 global exchanges. Fail-closed: UNKNOWN always means CLOSED.',
	url:            'https://headlessoracle.com',
	capabilities: [
		'market_status',
		'market_schedule',
		'exchange_directory',
		'batch_query',
		'signed_receipts',
		'portable_receipts',
		'mcp_tools',
	],
	mcp: {
		endpoint:         'https://headlessoracle.com/mcp',
		protocol_version: '2024-11-05',
		tools: [
			{
				name:        'get_market_status',
				description: 'Signed receipt: OPEN, CLOSED, HALTED, or UNKNOWN for one exchange.',
				parameters:  { mic: 'string (required) — ISO 10383 MIC code, e.g. XNYS' },
			},
			{
				name:        'get_market_schedule',
				description: 'Next open/close times for one exchange, in UTC.',
				parameters:  { mic: 'string (required) — ISO 10383 MIC code' },
			},
			{
				name:        'list_exchanges',
				description: 'All supported exchanges with names and timezones.',
				parameters:  {},
			},
		],
	},
	rest_api: {
		base_url:     'https://headlessoracle.com',
		openapi_spec: 'https://headlessoracle.com/openapi.json',
		endpoints: [
			{ path: '/v5/demo',               method: 'GET',  auth: false, description: 'Public signed receipt' },
			{ path: '/v5/status',             method: 'GET',  auth: true,  description: 'Authenticated signed receipt' },
			{ path: '/v5/batch',              method: 'GET',  auth: true,  description: 'Batch signed receipts for multiple MICs' },
			{ path: '/v5/schedule',           method: 'GET',  auth: false, description: 'Next open/close times' },
			{ path: '/v5/exchanges',          method: 'GET',  auth: false, description: 'All supported exchanges' },
			{ path: '/v5/keys',               method: 'GET',  auth: false, description: 'Public key registry + canonical payload spec' },
			{ path: '/v5/health',             method: 'GET',  auth: false, description: 'Signed liveness probe' },
			{ path: '/.well-known/oracle-keys.json', method: 'GET', auth: false, description: 'RFC 8615 key discovery' },
		],
		auth: {
			header:  'X-Oracle-Key',
			missing: 401,
			invalid: 403,
			payment_required: 402,
		},
	},
	trust: {
		algorithm:     'Ed25519',
		key_id_prefix: '03dc2799',
		key_registry:  'https://headlessoracle.com/v5/keys',
		well_known:    'https://headlessoracle.com/.well-known/oracle-keys.json',
		verify_sdk:    'npm:@headlessoracle/verify',
	},
	safety: {
		fail_closed:     true,
		unknown_means:   'CLOSED — halt all execution',
		receipt_ttl_sec: 60,
	},
};

// ─── MCP (Model Context Protocol) ────────────────────────────────────────────
// Implements JSON-RPC 2.0 / MCP Streamable HTTP (protocol version 2024-11-05).
// Three tools wrap existing Oracle logic — no new npm dependencies.

const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_SERVER_NAME      = 'headless-oracle';
const MCP_SERVER_VERSION   = '5.0.0';

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?:     string | number | null;
	method:  string;
	params?: unknown;
}

// Shape of daily MCP client aggregates stored in ORACLE_OVERRIDES KV.
// Key pattern: mcp_clients:{YYYY-MM-DD}:{sha256(client-ip)}
// Expires after 8 days. Raw IPs are never stored.
interface McpClientRecord {
	first_seen:    string; // ISO 8601
	last_seen:     string; // ISO 8601
	request_count: number;
	user_agent:    string;
	asn_org:       string;
	country:       string;
	city:          string;
}

const MCP_TOOLS = [
	{
		name: 'get_market_status',
		description:
			'Check whether a stock exchange is currently open or closed. ' +
			'Call this before executing trades, scheduling market-hours workflows, or routing orders. ' +
			'Returns a cryptographically signed receipt with status OPEN, CLOSED, HALTED, or UNKNOWN. ' +
			'MANDATORY: treat UNKNOWN or HALTED as CLOSED and halt execution. ' +
			'Do not act on a receipt past its expires_at timestamp. ' +
			'Supported exchanges: NYSE (XNYS), NASDAQ (XNAS), London (XLON), Tokyo (XJPX), ' +
			'Paris (XPAR), Hong Kong (XHKG), Singapore (XSES).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'Exchange identifier (MIC code). Common values: XNYS=NYSE, XNAS=NASDAQ, ' +
						'XLON=London, XJPX=Tokyo, XPAR=Paris, XHKG=Hong Kong, XSES=Singapore. ' +
						'Use list_exchanges to see all options. Defaults to XNYS.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'],
				},
			},
		},
	},
	{
		name: 'get_market_schedule',
		description:
			'Get the next open and close times for a stock exchange. ' +
			'Use when planning trade execution windows, scheduling market-dependent tasks, ' +
			'or checking upcoming session times. ' +
			'Returns UTC timestamps for next open/close and current schedule-based status. ' +
			'Includes lunch break windows for Tokyo (XJPX) and Hong Kong (XHKG) where applicable. ' +
			'NOT cryptographically signed — does not reflect real-time halts or circuit breakers. ' +
			'For verified real-time status, use get_market_status instead. ' +
			'Supported: NYSE (XNYS), NASDAQ (XNAS), London (XLON), Tokyo (XJPX), Paris (XPAR), Hong Kong (XHKG), Singapore (XSES).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'Exchange identifier (MIC code). Common values: XNYS=NYSE, XNAS=NASDAQ, ' +
						'XLON=London, XJPX=Tokyo, XPAR=Paris, XHKG=Hong Kong, XSES=Singapore. ' +
						'Defaults to XNYS.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'],
				},
			},
		},
	},
	{
		name: 'list_exchanges',
		description:
			'List all stock exchanges supported by Headless Oracle. ' +
			'Use to discover which markets are available, find the correct identifier (MIC code) ' +
			'for an exchange by name, or look up the timezone of a market. ' +
			'Returns MIC codes, full exchange names, and IANA timezone identifiers for all 7 supported markets.',
		inputSchema: { type: 'object', properties: {} },
	},
];

// ─── OpenAPI 3.1 Specification ────────────────────────────────────────────────

const OPENAPI_SPEC = {
	openapi: '3.1.0',
	info: {
		title:       'Headless Oracle',
		version:     '5.0.0',
		description: 'Cryptographically signed market-state receipts for AI agents and automated trading systems. ' +
			'All signed receipts use Ed25519. Consumers MUST treat UNKNOWN status as CLOSED and halt execution. ' +
			'Receipts expire at expires_at — do not act on stale receipts.',
		contact: { url: 'https://headlessoracle.com' },
	},
	servers: [{ url: 'https://headlessoracle.com' }],
	components: {
		securitySchemes: {
			ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-Oracle-Key' },
		},
		schemas: {
			Status: {
				type: 'string',
				enum: ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'],
				description: 'UNKNOWN MUST be treated as CLOSED. Halt all execution.',
			},
			Source: {
				type: 'string',
				enum: ['SCHEDULE', 'OVERRIDE', 'SYSTEM'],
			},
			SignedReceipt: {
				type: 'object',
				required: ['receipt_id', 'issued_at', 'expires_at', 'issuer', 'mic', 'status', 'source', 'receipt_mode', 'schema_version', 'public_key_id', 'signature'],
				properties: {
					receipt_id:    { type: 'string', format: 'uuid' },
					issued_at:     { type: 'string', format: 'date-time' },
					expires_at:    { type: 'string', format: 'date-time', description: 'Do not act on this receipt after this time.' },
					issuer:        { type: 'string', example: 'headlessoracle.com', description: 'Domain of the oracle that issued this receipt. Resolve {issuer}/v5/keys to retrieve the public key.' },
					mic:           { type: 'string', example: 'XNYS' },
					status:        { '$ref': '#/components/schemas/Status' },
					source:        { '$ref': '#/components/schemas/Source' },
					reason:        { type: 'string', description: 'Present when source is OVERRIDE.' },
					receipt_mode:  { type: 'string', enum: ['demo', 'live'], description: "'demo' for unauthenticated /v5/demo; 'live' for /v5/status, /v5/batch, and MCP tool receipts." },
					schema_version: { type: 'string', example: 'v5.0', description: 'Receipt schema version. Consumers should verify this matches the version they were built against.' },
					public_key_id: { type: 'string', example: 'key_2026_v1' },
					signature:     { type: 'string', description: 'Ed25519 signature of canonical payload as 128-char hex string.' },
				},
			},
			Error: {
				type: 'object',
				required: ['error'],
				properties: {
					error:     { type: 'string' },
					message:   { type: 'string' },
					status:    { type: 'string', description: 'Present on CRITICAL_FAILURE — always UNKNOWN.' },
					supported: { type: 'array', items: { type: 'string' }, description: 'Present on UNKNOWN_MIC errors.' },
				},
			},
		},
	},
	paths: {
		'/v5/demo': {
			get: {
				summary:     'Public signed receipt',
				description: 'Returns a signed market-state receipt. No authentication required. Suitable for integration testing and public dashboards. For production use, prefer /v5/status.',
				parameters:  [{ name: 'mic', in: 'query', schema: { type: 'string', default: 'XNYS' }, description: 'Market Identifier Code (MIC). See /v5/exchanges for supported values.' }],
				responses: {
					'200': { description: 'Signed receipt', content: { 'application/json': { schema: { '$ref': '#/components/schemas/SignedReceipt' } } } },
					'400': { description: 'Unknown MIC', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/status': {
			get: {
				summary:     'Authenticated signed receipt',
				description: 'Returns a signed market-state receipt. Requires X-Oracle-Key header. Primary production endpoint.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [{ name: 'mic', in: 'query', schema: { type: 'string', default: 'XNYS' }, description: 'Market Identifier Code (MIC).' }],
				responses: {
					'200': { description: 'Signed receipt', content: { 'application/json': { schema: { '$ref': '#/components/schemas/SignedReceipt' } } } },
					'400': { description: 'Unknown MIC', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'401': { description: 'Missing API key' },
					'403': { description: 'Invalid API key' },
				},
			},
		},
		'/v5/schedule': {
			get: {
				summary:     'Next open/close times',
				description: 'Schedule-based next session open and close times in UTC. Not signed. Does not reflect real-time halts or KV overrides. For authoritative status use /v5/demo or /v5/status.',
				parameters:  [{ name: 'mic', in: 'query', schema: { type: 'string', default: 'XNYS' } }],
				responses: {
					'200': {
						description: 'Schedule data',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										mic:            { type: 'string' },
										name:           { type: 'string' },
										timezone:       { type: 'string', description: 'IANA timezone name.' },
										queried_at:     { type: 'string', format: 'date-time' },
										current_status: { '$ref': '#/components/schemas/Status' },
										next_open:      { type: 'string', format: 'date-time', nullable: true },
										next_close:     { type: 'string', format: 'date-time', nullable: true },
										lunch_break:    { nullable: true, description: 'Null if no lunch break. start/end are local exchange time (HH:MM). See timezone field.', type: 'object', properties: { start: { type: 'string', example: '11:30' }, end: { type: 'string', example: '12:30' } } },
										note:           { type: 'string' },
									},
								},
							},
						},
					},
					'400': { description: 'Unknown MIC' },
				},
			},
		},
		'/v5/exchanges': {
			get: {
				summary:     'Directory of supported exchanges',
				description: 'Returns all exchanges for which Oracle provides signed receipts.',
				responses: {
					'200': {
						description: 'Exchange list',
						content: {
							'application/json': {
								schema: {
									type: 'object',
									properties: {
										exchanges: {
											type: 'array',
											items: {
												type: 'object',
												properties: {
													mic:      { type: 'string' },
													name:     { type: 'string' },
													timezone: { type: 'string' },
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/v5/keys': {
			get: {
				summary:     'Public key registry',
				description: 'Returns active signing public keys and the canonical payload specification required for independent receipt verification. Each key includes valid_from and valid_until (null if no scheduled rotation) for lifecycle tracking.',
				responses: {
					'200': { description: 'Key registry with canonical signing spec', content: { 'application/json': { schema: { type: 'object' } } } },
				},
			},
		},
		'/v5/health': {
			get: {
				summary:     'Signed liveness probe',
				description: 'Returns a signed receipt confirming the Oracle signing infrastructure is alive. ' +
					'Use this to distinguish Oracle-is-down from market-is-UNKNOWN. ' +
					'A 200 with valid signature means signing works. A 500 means signing is offline.',
				responses: {
					'200': {
						description: 'Signed health receipt',
						content: { 'application/json': { schema: { type: 'object', required: ['receipt_id', 'issued_at', 'expires_at', 'status', 'source', 'public_key_id', 'signature', 'exchange_count', 'supported_mics'], properties: { receipt_id: { type: 'string', format: 'uuid' }, issued_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['OK'] }, source: { type: 'string', enum: ['SYSTEM'] }, public_key_id: { type: 'string' }, signature: { type: 'string' }, exchange_count: { type: 'integer', example: 7, description: 'Number of exchanges currently configured (unsigned).' }, supported_mics: { type: 'array', items: { type: 'string' }, example: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'], description: 'List of supported MIC codes (unsigned).' } } } } },
					},
					'500': { description: 'Signing system offline — CRITICAL_FAILURE', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/openapi.json': {
			get: {
				summary:   'OpenAPI 3.1 specification',
				responses: { '200': { description: 'This document' } },
			},
		},
		'/mics.json': {
			get: {
				summary:     'Exchange registry — full ISO metadata',
				description: 'Static JSON array of all 7 supported exchanges. Each entry carries: ' +
					'mic (ISO 10383), name, country (ISO 3166-1 alpha-2), timezone (IANA), ' +
					'currency (ISO 4217), and sameAs (ISO 20022 MIC registry URL). ' +
					'No authentication required. Response is a top-level array, not an object wrapper. ' +
					'Cache-Control: public, max-age=86400.',
				responses: {
					'200': {
						description: 'Array of exchange metadata objects',
						content: {
							'application/json': {
								schema: {
									type: 'array',
									items: {
										type: 'object',
										required: ['mic', 'name', 'country', 'timezone', 'currency', 'sameAs'],
										properties: {
											mic:      { type: 'string', example: 'XNYS', description: 'ISO 10383 Market Identifier Code.' },
											name:     { type: 'string', example: 'New York Stock Exchange' },
											country:  { type: 'string', example: 'US', description: 'ISO 3166-1 alpha-2 country code.' },
											timezone: { type: 'string', example: 'America/New_York', description: 'IANA timezone identifier.' },
											currency: { type: 'string', example: 'USD', description: 'ISO 4217 currency code.' },
											sameAs:   { type: 'string', format: 'uri', example: 'https://www.iso20022.org/market-identifier-codes', description: 'ISO 20022 MIC registry URL.' },
										},
									},
								},
							},
						},
					},
				},
			},
		},
		'/v5/batch': {
			get: {
				summary:     'Authenticated batch receipt query',
				description: 'Returns independently signed receipts for multiple exchanges in one request. ' +
					'Each receipt goes through the same 4-tier fail-closed architecture as /v5/status. ' +
					'Receipts are built in parallel. Requires X-Oracle-Key header.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [{
					name:        'mics',
					in:          'query',
					required:    true,
					schema:      { type: 'string' },
					description: 'Comma-separated MIC codes. Duplicates are deduplicated. Example: XNYS,XNAS,XLON.',
				}],
				responses: {
					'200': {
						description: 'Batch of signed receipts',
						content: { 'application/json': { schema: {
						  type: 'object',
						  required: ['batch_id', 'queried_at', 'receipts'],
						  properties: {
						    batch_id:   { type: 'string', format: 'uuid' },
						    queried_at: { type: 'string', format: 'date-time' },
						    receipts:   { type: 'array', items: { '$ref': '#/components/schemas/SignedReceipt' } },
						  },
						} } },
					},
					'400': { description: 'Missing mics parameter or unknown MIC', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'401': { description: 'Missing API key' },
					'403': { description: 'Invalid API key' },
					'500': { description: 'Signing system offline — CRITICAL_FAILURE' },
				},
			},
		},
		'/.well-known/oracle-keys.json': {
			get: {
				summary:     'RFC 8615 key discovery',
				description: 'Standard well-known URI for Ed25519 public key discovery (RFC 8615). ' +
					'Returns active signing key(s) with lifecycle metadata. No authentication required. ' +
					'Use /v5/keys for the full canonical payload specification.',
				responses: {
					'200': { description: 'Active signing key(s)', content: { 'application/json': { schema: { type: 'object' } } } },
				},
			},
		},
		'/mcp': {
			post: {
				summary:     'MCP (Model Context Protocol) endpoint',
				description: 'JSON-RPC 2.0 / MCP Streamable HTTP (protocol version 2024-11-05). ' +
					'Tools: get_market_status, get_market_schedule, list_exchanges. No authentication required.',
				responses: {
					'200': { description: 'JSON-RPC 2.0 response' },
					'202': { description: 'Notification accepted (no body)' },
					'405': { description: 'GET not allowed — use POST' },
				},
			},
		},
		'/v5/checkout': {
			post: {
				summary:     'Create Paddle Checkout Transaction',
				description: 'Creates a Paddle transaction for the Pro plan and returns the hosted payment URL. No authentication required. Redirect the user to the returned url.',
				responses: {
					'200': {
						description: 'Checkout transaction created',
						content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } } } } },
					},
					'405': { description: 'Method not allowed — use POST', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'502': { description: 'Paddle API error', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'503': { description: 'Billing not configured', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/webhooks/paddle': {
			post: {
				summary:     'Paddle webhook receiver',
				description: 'Receives and processes Paddle events. Requires a valid Paddle-Signature header. Handles: transaction.completed (key generation + email), subscription.updated, subscription.past_due, subscription.canceled.',
				responses: {
					'200': { description: 'Event received and processed' },
					'400': { description: 'Missing Paddle-Signature header' },
					'401': { description: 'Invalid signature' },
				},
			},
		},
		'/v5/account': {
			get: {
				summary:     'Account info for the calling API key',
				description: 'Returns plan, status, and key_prefix for the authenticated key. Use to verify subscription status.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Account info',
						content: { 'application/json': { schema: { type: 'object', required: ['plan', 'status', 'key_prefix'], properties: { plan: { type: 'string', example: 'pro' }, status: { type: 'string', enum: ['active', 'suspended', 'cancelled'] }, key_prefix: { type: 'string', nullable: true, example: 'ok_live_a1b2c3' } } } } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'402': { description: 'Payment required — subscription suspended or cancelled', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'404': { description: 'Account not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/robots.txt': {
			get: {
				summary:     'robots.txt',
				description: 'Standard robots exclusion file. Explicitly permits AI crawlers to all public documentation endpoints.',
				responses: {
					'200': { description: 'robots.txt content', content: { 'text/plain': { schema: { type: 'string' } } } },
				},
			},
		},
		'/llms.txt': {
			get: {
				summary:     'llms.txt — machine-readable API summary for LLMs',
				description: 'Structured plain-text summary of the Oracle API following the llmstxt.org convention. Covers all endpoints, receipt schema, fail-closed contract, code examples, and DST event calendar.',
				responses: {
					'200': { description: 'llms.txt content', content: { 'text/plain': { schema: { type: 'string' } } } },
				},
			},
		},
		'/SKILL.md': {
			get: {
				summary:     'Agent integration guide (Markdown)',
				description: 'Step-by-step integration guide optimised for AI agents. Covers MCP setup, HTTP patterns, code examples, safety rules, verification SDK usage, and common mistakes. Returns Last-Modified and ETag headers for cache invalidation.',
				responses: {
					'200': {
						description: 'Markdown integration guide',
						content: { 'text/markdown': { schema: { type: 'string' } } },
						headers: {
							'ETag':          { schema: { type: 'string' }, description: 'FNV-1a hash of content, quoted (RFC 7232).' },
							'Last-Modified': { schema: { type: 'string' }, description: 'RFC 7231 HTTP-date of last content change.' },
						},
					},
				},
			},
		},
		'/.well-known/agent.json': {
			get: {
				summary:     'Structured agent metadata',
				description: 'Machine-readable JSON describing Oracle capabilities, MCP tools, REST endpoints, auth requirements, and trust anchors. Includes spec_version (YYYY-MM-DD) for staleness detection.',
				responses: {
					'200': {
						description: 'Agent metadata',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								schema_version: { type: 'string', example: '1.0' },
								spec_version:   { type: 'string', example: '2026-02-26', description: 'YYYY-MM-DD — compare against cached value to detect stale metadata.' },
								name:           { type: 'string' },
								capabilities:   { type: 'array', items: { type: 'string' } },
								mcp:            { type: 'object' },
								rest_api:       { type: 'object' },
								trust:          { type: 'object' },
								safety:         { type: 'object' },
							},
						} } },
					},
				},
			},
		},
	},
};

// ─── Signed Receipt Builder ───────────────────────────────────────────────────
// Implements the 4-tier fail-closed architecture. Called by both the REST routes
// (/v5/demo, /v5/status) and the MCP tool, so the same safety guarantees apply.

async function buildSignedReceipt(
	mic: string,
	env: Env,
	now: Date,
	expiresAt: string,
	mode: 'demo' | 'live',
): Promise<{ receipt: Record<string, unknown>; status: number }> {
	try {
		// ─ TIER 0: Manual Override (circuit breakers, emergency halts) ─
		if (env.ORACLE_OVERRIDES) {
			const overrideRaw = await env.ORACLE_OVERRIDES.get(mic);
			if (overrideRaw) {
				const override = JSON.parse(overrideRaw) as {
					status: string;
					reason: string;
					expires: string;
				};
				if (new Date(override.expires) > now) {
					const payload = {
						receipt_id:     crypto.randomUUID(),
						issued_at:      now.toISOString(),
						expires_at:     expiresAt,
						issuer:         ORACLE_ISSUER,
						mic,
						status:         override.status,
						source:         'OVERRIDE',
						reason:         override.reason,
						receipt_mode:   mode,
						schema_version: 'v5.0',
						public_key_id:  env.PUBLIC_KEY_ID || 'key_2026_v1',
					};
					const signature = await signPayload(payload, env.ED25519_PRIVATE_KEY);
					return { receipt: { ...payload, signature }, status: 200 };
				}
			}
		}

		// ─ TIER 1: Normal schedule-based operation ───────────────────
		const { status, source } = getScheduleStatus(mic, now);
		const payload = {
			receipt_id:     crypto.randomUUID(),
			issued_at:      now.toISOString(),
			expires_at:     expiresAt,
			issuer:         ORACLE_ISSUER,
			mic,
			status,
			source,
			receipt_mode:   mode,
			schema_version: 'v5.0',
			public_key_id:  env.PUBLIC_KEY_ID || 'key_2026_v1',
		};
		const signature = await signPayload(payload, env.ED25519_PRIVATE_KEY);
		return { receipt: { ...payload, signature }, status: 200 };

	} catch (tier1Error: unknown) {
		// ─ TIER 2: Fail-Closed Safety Net ────────────────────────────
		const msg = tier1Error instanceof Error ? tier1Error.message : 'Unknown error';
		console.error(`ORACLE_TIER_1_FAILURE: ${msg}`);

		try {
			const safePayload = {
				receipt_id:     crypto.randomUUID(),
				issued_at:      now.toISOString(),
				expires_at:     expiresAt,
				issuer:         ORACLE_ISSUER,
				mic,
				status:         'UNKNOWN',
				source:         'SYSTEM',
				receipt_mode:   mode,
				schema_version: 'v5.0',
				public_key_id:  env.PUBLIC_KEY_ID || 'key_2026_v1',
			};
			const safeSig = await signPayload(safePayload, env.ED25519_PRIVATE_KEY);
			return { receipt: { ...safePayload, signature: safeSig }, status: 200 };

		} catch (tier2Error: unknown) {
			// ─ TIER 3: Catastrophic — signing system offline ──────────
			const msg2 = tier2Error instanceof Error ? tier2Error.message : 'Unknown error';
			console.error(`ORACLE_TIER_2_CATASTROPHIC: ${msg2}`);
			return {
				receipt: {
					error:   'CRITICAL_FAILURE',
					message: 'Oracle signature system offline. Treat as UNKNOWN. Halt all execution.',
					status:  'UNKNOWN',
					source:  'SYSTEM',
				},
				status: 500,
			};
		}
	}
}

// ─── MCP Handler ─────────────────────────────────────────────────────────────
// Outside the main try/catch — has its own error handling and always returns
// JSON-RPC format, never REST CRITICAL_FAILURE format.

const MCP_RESPONSE_HEADERS = {
	'Content-Type':                 'application/json',
	'MCP-Version':                  MCP_PROTOCOL_VERSION,
	'Access-Control-Allow-Origin':  '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// ── Client Intelligence ────────────────────────────────────────────────────
	// Privacy-safe: IPs are hashed (SHA-256), never stored raw.
	// Aggregates land in ORACLE_OVERRIDES KV as mcp_clients:{date}:{ip_hash}.
	const cf         = (request as unknown as { cf?: Record<string, string> }).cf;
	const userAgent  = request.headers.get('User-Agent') ?? '';
	const rawIp      = request.headers.get('CF-Connecting-IP') ?? '';
	const ipHash     = await sha256Hex(rawIp);
	const asnOrg     = cf?.asOrganization ?? '';
	const country    = cf?.country ?? '';
	const city       = cf?.city ?? '';
	const contentLen = request.headers.get('Content-Length') ?? '';
	const timestamp  = new Date().toISOString();
	const today      = timestamp.slice(0, 10);

	console.log(JSON.stringify({
		event:          'MCP_REQUEST',
		timestamp,
		ip_hash:        ipHash,
		user_agent:     userAgent,
		asn_org:        asnOrg,
		country,
		city,
		content_length: contentLen,
	}));

	// Read current daily aggregate, increment, write back non-blocking.
	const kvKey  = `mcp_clients:${today}:${ipHash}`;
	const stored = await env.ORACLE_TELEMETRY.get(kvKey);
	const prev   = stored ? JSON.parse(stored) as McpClientRecord : null;
	const requestCount = (prev?.request_count ?? 0) + 1;
	const updated: McpClientRecord = {
		first_seen:    prev?.first_seen ?? timestamp,
		last_seen:     timestamp,
		request_count: requestCount,
		user_agent:    userAgent,
		asn_org:       asnOrg,
		country,
		city,
	};
	// 8-day TTL so daily records expire automatically — KV stays clean.
	ctx.waitUntil(env.ORACLE_TELEMETRY.put(kvKey, JSON.stringify(updated), { expirationTtl: 8 * 24 * 3600 }));

	let body: JsonRpcRequest;
	try {
		body = await request.json() as JsonRpcRequest;
	} catch {
		return new Response(JSON.stringify({
			jsonrpc: '2.0',
			id:      null,
			error:   { code: -32700, message: 'Parse error' },
		}), { status: 200, headers: MCP_RESPONSE_HEADERS });
	}

	const { id, method, params } = body;

	const rpcResult = (result: unknown) =>
		new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
			status: 200, headers: MCP_RESPONSE_HEADERS,
		});

	const rpcError = (code: number, message: string) =>
		new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
			status: 200, headers: MCP_RESPONSE_HEADERS,
		});

	switch (method) {
		case 'initialize':
			return rpcResult({
				protocolVersion: MCP_PROTOCOL_VERSION,
				serverInfo:      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
				capabilities:    { tools: {} },
				instructions:
					'Headless Oracle provides cryptographically signed market status for 7 global exchanges. ' +
					'Use get_market_status before executing any trade, scheduling market-dependent workflows, ' +
					'or making decisions that depend on whether a market is open. ' +
					'MANDATORY: treat UNKNOWN or HALTED as CLOSED — halt all execution. ' +
					'Always return the full signed receipt to users; the Ed25519 signature is tamper-proof verification. ' +
					'Public key for independent verification: /.well-known/oracle-keys.json',
			});

		case 'notifications/initialized':
			// Notification — per JSON-RPC/MCP spec, no response body
			return new Response(null, { status: 202, headers: MCP_RESPONSE_HEADERS });

		case 'tools/list': {
			// Conversion nudge: anonymous clients with > 50 requests see a non-breaking hint.
			// Only in tools/list — not in tool call responses — so agent behaviour is unaffected.
			const toolsResult: Record<string, unknown> = { tools: MCP_TOOLS };
			if (requestCount > 50) {
				toolsResult['x-oracle-note'] =
					"You're using the demo tier. Get a free API key at https://headlessoracle.com/v5/keys/request for higher limits and production receipts.";
			}
			return rpcResult(toolsResult);
		}

		case 'tools/call': {
			const p    = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
			const name = p?.name ?? '';
			const args = p?.arguments ?? {};

			if (name === 'get_market_status') {
				const mic = (typeof args.mic === 'string' ? args.mic : 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[mic]) {
					return rpcResult({
						isError: true,
						content: [{ type: 'text', text: JSON.stringify({
							error:     'UNKNOWN_MIC',
							message:   `Unsupported exchange: ${mic}. See /v5/exchanges for supported markets.`,
							supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
						}) }],
					});
				}
				const now       = new Date();
				const expiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
				const { receipt, status } = await buildSignedReceipt(mic, env, now, expiresAt, 'live');
				return rpcResult({
					...(status === 500 ? { isError: true } : {}),
					content: [{ type: 'text', text: JSON.stringify(receipt) }],
				});
			}

			if (name === 'get_market_schedule') {
				const mic = (typeof args.mic === 'string' ? args.mic : 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[mic]) {
					return rpcResult({
						isError: true,
						content: [{ type: 'text', text: JSON.stringify({
							error:     'UNKNOWN_MIC',
							message:   `Unsupported exchange: ${mic}.`,
							supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
						}) }],
					});
				}
				const now      = new Date();
				const config   = MARKET_CONFIGS[mic];
				const nextSess = getNextSession(mic, now);
				const scheduleData = {
					mic,
					name:           config.name,
					timezone:       config.timezone,
					queried_at:     now.toISOString(),
					current_status: getScheduleStatus(mic, now).status,
					next_open:      nextSess?.next_open  ?? null,
					next_close:     nextSess?.next_close ?? null,
					lunch_break:    config.lunchBreak
						? {
							start: `${pad2(config.lunchBreak.startHour)}:${pad2(config.lunchBreak.startMinute)}`,
							end:   `${pad2(config.lunchBreak.endHour)}:${pad2(config.lunchBreak.endMinute)}`,
						}
						: null,
					note: 'Times are UTC. lunch_break times are local exchange time (see timezone field).',
				};
				return rpcResult({
					content: [{ type: 'text', text: JSON.stringify(scheduleData) }],
				});
			}

			if (name === 'list_exchanges') {
				return rpcResult({
					content: [{ type: 'text', text: JSON.stringify({ exchanges: SUPPORTED_EXCHANGES }) }],
				});
			}

			return rpcError(-32601, `Method not found: tools/call/${name}`);
		}

		case 'resources/list':
			return rpcResult({ resources: [] });

		case 'prompts/list':
			return rpcResult({ prompts: [] });

		default:
			return rpcError(-32601, `Method not found: ${method}`);
	}
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Redirect www → bare domain (permanent). Keeps canonical URL consistent
		// and ensures www never serves stale Pages-cached content for Worker routes.
		if (url.hostname === 'www.headlessoracle.com') {
			url.hostname = 'headlessoracle.com';
			return Response.redirect(url.toString(), 301);
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();

		const corsHeaders = {
			'Access-Control-Allow-Origin':  '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, X-Oracle-Key',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extraHeaders },
			});

		// ── POST /mcp — MCP Streamable HTTP (outside main try/catch) ─
		if (url.pathname === '/mcp') {
			if (request.method !== 'POST') {
				return json({ error: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint requires POST' }, 405);
			}
			return handleMcp(request, env, ctx);
		}

		try {
			// ── Auth gate — /v5/status requires X-Oracle-Key ─────────────
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const auth = await checkApiKey(apiKey, env);
				if (!auth.allowed) {
					const authHeaders = auth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					return json({ error: auth.error, message: auth.message }, auth.status, authHeaders);
				}
			}

			// ── GET /v5/exchanges — public directory of supported markets ─
			if (url.pathname === '/v5/exchanges') {
				return json({ exchanges: SUPPORTED_EXCHANGES });
			}

			// ── GET /v5/keys — public key registry ───────────────────────
			if (url.pathname === '/v5/keys') {
				return json({
					keys: [{
						key_id:      env.PUBLIC_KEY_ID || 'key_2026_v1',
						algorithm:   'Ed25519',
						format:      'hex',
						public_key:  env.ED25519_PUBLIC_KEY || '',
						valid_from:  env.PUBLIC_KEY_VALID_FROM  || '2026-01-01T00:00:00Z',
						valid_until: env.PUBLIC_KEY_VALID_UNTIL || null,
					}],
					canonical_payload_spec: {
						description:     'Keys sorted alphabetically, JSON.stringify with no whitespace, UTF-8 encoded.',
						receipt_fields:  ['expires_at', 'issued_at', 'issuer', 'mic', 'public_key_id', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
						override_fields: ['expires_at', 'issued_at', 'issuer', 'mic', 'public_key_id', 'reason', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
						health_fields:   ['expires_at', 'issued_at', 'issuer', 'public_key_id', 'receipt_id', 'source', 'status'],
					},
				});
			}

			// ── GET /v5/schedule — next open/close times (public, no auth) ─
			if (url.pathname === '/v5/schedule') {
				const mic = (url.searchParams.get('mic') || 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[mic]) {
					return json({
						error:     'UNKNOWN_MIC',
						message:   `Unsupported exchange: ${mic}`,
						supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
					}, 400);
				}

				const currentStatus = getScheduleStatus(mic, now);
				const nextSession   = getNextSession(mic, now);
				const config        = MARKET_CONFIGS[mic];

				// data_coverage_years: sorted list of years with holiday data.
				// Agents querying near year-end should check coverage before trusting next_open.
				// If the current year is absent, next_open will be null (fail-closed).
				const data_coverage_years = Object.keys(config.holidays).sort();
				return json({
					mic,
					name:                config.name,
					timezone:            config.timezone,
					queried_at:          now.toISOString(),
					current_status:      currentStatus.status,
					next_open:           nextSession?.next_open  ?? null,
					next_close:          nextSession?.next_close ?? null,
					data_coverage_years,
					lunch_break:         config.lunchBreak
						? { start: `${pad2(config.lunchBreak.startHour)}:${pad2(config.lunchBreak.startMinute)}`, end: `${pad2(config.lunchBreak.endHour)}:${pad2(config.lunchBreak.endMinute)}` }
						: null,
					note:                'Times are UTC. lunch_break times are local exchange time (see timezone field). next_open is null when coverage for the current year is unavailable.',
				});
			}

			// ── GET /v5/status (authenticated) & /v5/demo (public) ───────
			if (url.pathname === '/v5/status' || url.pathname === '/v5/demo') {
				const mic = (url.searchParams.get('mic') || 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[mic]) {
					return json({
						error:     'UNKNOWN_MIC',
						message:   `Unsupported exchange: ${mic}. See /v5/exchanges for supported markets.`,
						supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
					}, 400);
				}
				const mode = url.pathname === '/v5/demo' ? 'demo' : 'live';
				const { receipt, status } = await buildSignedReceipt(mic, env, now, expiresAt, mode);
				return json(receipt, status);
			}

			// ── GET /v5/batch — authenticated batch receipt query ─────────────────────
			// Returns independently signed receipts for multiple exchanges in one request.
			// Each receipt goes through the full 4-tier fail-closed architecture.
			if (url.pathname === '/v5/batch') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const batchAuth = await checkApiKey(apiKey, env);
				if (!batchAuth.allowed) {
					const batchAuthHeaders = batchAuth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					return json({ error: batchAuth.error, message: batchAuth.message }, batchAuth.status, batchAuthHeaders);
				}

				const micsParam = url.searchParams.get('mics');
				if (!micsParam || !micsParam.trim()) {
					return json({
						error:   'MISSING_PARAMETER',
						message: 'mics parameter is required. Example: ?mics=XNYS,XNAS,XLON',
					}, 400);
				}

				// Parse, uppercase, deduplicate — preserve first-seen order
				const requestedMics = [...new Set(
					micsParam.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean),
				)];

				if (requestedMics.length === 0) {
					return json({
						error:   'MISSING_PARAMETER',
						message: 'mics parameter is required. Example: ?mics=XNYS,XNAS,XLON',
					}, 400);
				}

				// Validate all MICs before processing — fail-closed on unknown input
				const unknownMics = requestedMics.filter((m) => !MARKET_CONFIGS[m]);
				if (unknownMics.length > 0) {
					return json({
						error:     'UNKNOWN_MIC',
						message:   `Unsupported exchange(s): ${unknownMics.join(', ')}. See /v5/exchanges for supported markets.`,
						unknown:   unknownMics,
						supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
					}, 400);
				}

				// Build signed receipts in parallel — each is independently signed
				const results = await Promise.all(
					requestedMics.map((mic) => buildSignedReceipt(mic, env, now, expiresAt, 'live')),
				);

				// If signing itself is offline (Tier 3), fail the whole batch — signing failure is total
				if (results.some((r) => r.status === 500)) {
					return json({
						error:   'CRITICAL_FAILURE',
						message: 'Oracle signature system offline. Treat as UNKNOWN. Halt all execution.',
						status:  'UNKNOWN',
						source:  'SYSTEM',
					}, 500);
				}

				return json({
					batch_id:   crypto.randomUUID(),
					queried_at: now.toISOString(),
					receipts:   results.map((r) => r.receipt),
				});
			}

			// ── GET /v5/health — signed liveness probe (public, no auth) ──
			// Agents use this to distinguish "Oracle is down" from "market is UNKNOWN".
			// A signed OK receipt means signing infrastructure is alive.
			// A 500 CRITICAL_FAILURE means signing is offline — treat all market state as UNKNOWN.
			if (url.pathname === '/v5/health') {
				try {
					const healthPayload = {
						receipt_id:    crypto.randomUUID(),
						issued_at:     now.toISOString(),
						expires_at:    expiresAt,
						issuer:        ORACLE_ISSUER,
						status:        'OK',
						source:        'SYSTEM',
						public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
					};
					const signature = await signPayload(healthPayload, env.ED25519_PRIVATE_KEY);

					// Compute data coverage: years where ALL exchanges have holiday data (intersection).
					// This tells agents which years are safe to query without risk of UNKNOWN.
					const allYearSets = Object.values(MARKET_CONFIGS).map(
						(c) => new Set(Object.keys(c.holidays)),
					);
					const holidayCoverageYears = [...(allYearSets[0] ?? new Set())].filter(
						(y) => allYearSets.every((s) => s.has(y)),
					).sort();

					// Half-day coverage: unique years that appear in any exchange's halfDays array.
					const halfDayCoverageYears = [...new Set(
						Object.values(MARKET_CONFIGS).flatMap(
							(c) => (c.halfDays ?? []).map((h) => h.date.slice(0, 4)),
						),
					)].sort();

					const currentYear = now.getFullYear();

					// exchange_count, supported_mics, data_coverage, and edge_case_count are unsigned
					// informational fields — they annotate the signed health receipt but are not part
					// of the signed payload.
					return json({
						...healthPayload,
						signature,
						exchange_count:             SUPPORTED_EXCHANGES.length,
						supported_mics:             SUPPORTED_EXCHANGES.map((e) => e.mic),
						data_coverage:              {
							holidays:  holidayCoverageYears,
							half_days: halfDayCoverageYears,
						},
						edge_case_count_current_year: edgeCaseCount(currentYear).total,
					});
				} catch (healthError: unknown) {
					const msg = healthError instanceof Error ? healthError.message : 'Unknown error';
					console.error();
					return json({
						error:   'CRITICAL_FAILURE',
						message: 'Oracle signature system offline. Treat as UNKNOWN. Halt all execution.',
						status:  'UNKNOWN',
						source:  'SYSTEM',
					}, 500);
				}
			}

			if (url.pathname === '/.well-known/oracle-keys.json') {
				// RFC 8615 standard key-discovery URI. Agents and web infrastructure that follow
				// RFC 8615 look here before checking service-specific paths like /v5/keys.
				// Returns active-key data without the canonical_payload_spec to stay minimal.
				return json({
					keys: [{
						key_id:      env.PUBLIC_KEY_ID || 'key_2026_v1',
						algorithm:   'Ed25519',
						format:      'hex',
						public_key:  env.ED25519_PUBLIC_KEY || '',
						valid_from:  env.PUBLIC_KEY_VALID_FROM  || '2026-01-01T00:00:00Z',
						valid_until: env.PUBLIC_KEY_VALID_UNTIL || null,
					}],
					service: 'headless-oracle',
					spec:    'https://headlessoracle.com/openapi.json',
				});
			}
			if (url.pathname === '/openapi.json') {
				return json(OPENAPI_SPEC);
			}
			// ── GET /mics.json — machine-readable exchange registry ───────
			// Static, cacheable. Lists all supported MICs with country, timezone,
			// currency, and sameAs pointer to the ISO 20022 MIC registry.
			// No auth required. Consumed by agents building MIC-selection logic
			// without needing to parse prose documentation.
			if (url.pathname === '/mics.json') {
				return new Response(JSON.stringify(MICS_REGISTRY, null, 2), {
					headers: {
						...corsHeaders,
						'Content-Type':  'application/json',
						'Cache-Control': 'public, max-age=86400',
					},
				});
			}
			if (url.pathname === '/robots.txt') {
				return new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain' } });
			}
			if (url.pathname === '/llms.txt') {
				return new Response(LLMS_TXT, { headers: { 'Content-Type': 'text/plain' } });
			}
			if (url.pathname === '/SKILL.md') {
				return new Response(SKILL_MD, {
					headers: {
						'Content-Type':  'text/markdown; charset=utf-8',
						'Last-Modified': SKILL_MD_LAST_MOD,
						'ETag':          SKILL_MD_ETAG,
					},
				});
			}
			if (url.pathname === '/.well-known/agent.json') {
				return json(AGENT_JSON);
			}
			if (url.pathname === '/.well-known/mcp/server-card.json') {
				return json({
					name:           'Headless Oracle',
					description:    'Real-time market status verification for AI agents. Ed25519 signed receipts, fail-closed architecture.',
					url:            'https://headlessoracle.com/mcp',
					version:        '1.0.0',
					tools:          ['get_market_status', 'get_market_schedule', 'list_exchanges'],
					authentication: 'none',
				});
			}
			if (url.pathname === '/.well-known/oauth-protected-resource') {
				return json({
					resource:                 'https://headlessoracle.com',
					authorization_servers:    [],
					bearer_methods_supported: [],
					scopes_supported:         [],
				});
			}

			// ── POST /v5/checkout — create Paddle checkout transaction ───
			// No auth required. Returns { url } to redirect the user to Paddle.
			if (url.pathname === '/v5/checkout') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}
				if (!env.PADDLE_API_KEY || !env.PADDLE_PRICE_ID_BUILDER) {
					return json({ error: 'SERVICE_UNAVAILABLE', message: 'Billing not configured' }, 503);
				}
				const body = await request.json().catch(() => ({})) as { plan?: string };
				const plan = body.plan || 'builder';
				const priceId =
					plan === 'pro'      ? env.PADDLE_PRICE_ID_PRO :
					plan === 'protocol' ? env.PADDLE_PRICE_ID_PROTOCOL :
					                      env.PADDLE_PRICE_ID_BUILDER;
				const paddleRes = await fetch('https://api.paddle.com/transactions', {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${env.PADDLE_API_KEY}`,
						'Content-Type':  'application/json',
					},
					body: JSON.stringify({
						items: [{ price_id: priceId, quantity: 1 }],
					}),
				});
				const paddleBody = await paddleRes.json() as { data?: { id?: string; checkout?: { url?: string } }; error?: { detail: string } };
				const transactionId = paddleBody.data?.id;
				if (!paddleRes.ok || !transactionId) {
					console.error(`PADDLE_CHECKOUT_ERROR: ${paddleBody.error?.detail ?? 'unknown'}`);
					return json({ error: 'CHECKOUT_FAILED', message: 'Could not create checkout session' }, 502);
				}
				return json({
					url:            `https://buy.paddle.com/checkout/${transactionId}`,
					overlay_url:    paddleBody.data?.checkout?.url ?? null,
					transaction_id: transactionId,
				});
			}

			// ── POST /webhooks/paddle — handle Paddle events ─────────────
			// Verifies Paddle-Signature before processing any event.
			// Returns 200 for all recognised events, 400/401 for bad requests.
			if (url.pathname === '/webhooks/paddle') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}
				if (!env.PADDLE_WEBHOOK_SECRET) {
					return json({ error: 'SERVICE_UNAVAILABLE', message: 'Webhook not configured' }, 503);
				}

				const sigHeader = request.headers.get('Paddle-Signature');
				if (!sigHeader) {
					return json({ error: 'MISSING_SIGNATURE', message: 'Include Paddle-Signature header' }, 400);
				}

				// Must read raw body before any other processing — HMAC is over raw bytes
				const rawBody = await request.text();
				const valid   = await verifyPaddleSignature(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET);
				if (!valid) {
					return json({ error: 'INVALID_SIGNATURE', message: 'Paddle-Signature verification failed' }, 401);
				}

				const event = JSON.parse(rawBody) as { event_type: string; data: Record<string, unknown> };

				if (event.event_type === 'transaction.completed') {
					const txn = event.data;

					// Guard: skip non-subscription transactions (e.g. one-time payments)
					if (!txn['subscription_id']) return json({ received: true });

					if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
						console.error('WEBHOOK_ERROR: Supabase not configured — key not stored');
						return json({ received: true });
					}

					// Idempotency guard: skip renewals (subscription_id already has a row)
					const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
					const { data: existing } = await supabase
						.from('api_keys').select('id').eq('stripe_subscription_id', txn['subscription_id'] as string).single();
					if (existing) return json({ received: true });

					// Determine plan from transaction items price_id — fail-safe to 'pro' if unrecognised
					const items = txn['items'] as Array<{ price_id?: string }> | undefined;
					const priceId = items?.[0]?.price_id ?? null;
					let plan = 'pro';
					if (priceId) {
						if (env.PADDLE_PRICE_ID_BUILDER && priceId === env.PADDLE_PRICE_ID_BUILDER)       plan = 'builder';
						else if (env.PADDLE_PRICE_ID_PRO && priceId === env.PADDLE_PRICE_ID_PRO)           plan = 'pro';
						else if (env.PADDLE_PRICE_ID_PROTOCOL && priceId === env.PADDLE_PRICE_ID_PROTOCOL) plan = 'protocol';
					}

					// Fetch email from Paddle customer API (not included in transaction payload)
					let email: string | null = null;
					if (env.PADDLE_API_KEY && txn['customer_id']) {
						const custRes = await fetch(`https://api.paddle.com/customers/${txn['customer_id'] as string}`, {
							headers: { 'Authorization': `Bearer ${env.PADDLE_API_KEY}` },
						});
						if (custRes.ok) {
							const custBody = await custRes.json() as { data?: { email?: string } };
							email = custBody.data?.email ?? null;
						} else {
							console.error(`PADDLE_CUSTOMER_FETCH_ERROR: ${txn['customer_id'] as string}`);
						}
					}

					// Generate ho_live_ key — shown to the user exactly once via email
					const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
					const keyValue    = 'ho_live_' + toHex(rawKeyBytes);
					const keyHash     = await sha256Hex(keyValue);
					const keyPrefix   = keyValue.substring(0, 14); // 'ho_live_' + 6 chars

					// Store in Supabase (stripe_customer_id / stripe_subscription_id store Paddle IDs)
					const { error: dbError } = await supabase.from('api_keys').insert({
						id:                    crypto.randomUUID(),
						key_hash:              keyHash,
						key_prefix:            keyPrefix,
						plan,
						status:                'active',
						stripe_customer_id:    txn['customer_id'] as string | null,
						stripe_subscription_id: txn['subscription_id'] as string | null,
						email,
						created_at:            new Date().toISOString(),
					});
					if (dbError) {
						console.error(`WEBHOOK_DB_ERROR: ${dbError.message}`);
						return json({ error: 'DB_ERROR', message: 'Failed to store API key — contact support@headlessoracle.com' }, 500);
					}

					// Store in KV — persistent, no TTL; deactivated on subscription.canceled
					if (env.ORACLE_API_KEYS) {
						await env.ORACLE_API_KEYS.put(
							keyHash,
							JSON.stringify({
								plan,
								status:                 'active',
								paddle_customer_id:     txn['customer_id'] as string | null,
								paddle_subscription_id: txn['subscription_id'] as string | null,
								email,
								created_at:             new Date().toISOString(),
							}),
						);
					}

					// Send key via Resend (shown once — customer cannot recover it)
					if (env.RESEND_API_KEY && email) {
						const emailRes = await fetch('https://api.resend.com/emails', {
							method:  'POST',
							headers: {
								'Authorization': `Bearer ${env.RESEND_API_KEY}`,
								'Content-Type':  'application/json',
							},
							body: JSON.stringify({
								from:    'Headless Oracle <keys@headlessoracle.com>',
								to:      [email],
								subject: 'Your Headless Oracle API key',
								html: `<p>Thank you for subscribing to Headless Oracle.</p>
<p>Your API key (save this — it will not be shown again):</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">${keyValue}</pre>
<p>Use it in your requests as the <code>X-Oracle-Key</code> header against <code>https://headlessoracle.com/v5/status</code>.</p>
<p>Check your account status anytime: <a href="https://headlessoracle.com/v5/account">GET /v5/account</a></p>
<p>Documentation: <a href="https://headlessoracle.com/docs">headlessoracle.com/docs</a></p>`,
							}),
						});
						if (!emailRes.ok) {
							// Key is already stored — log the error but do not fail the webhook
							console.error(`RESEND_ERROR: failed to send key email to ${email}`);
						}
					}

					return json({ received: true });
				}

				if (event.event_type === 'subscription.updated') {
					const sub = event.data;
					if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
						const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
						await supabase.from('api_keys')
							.update({ status: sub['status'] === 'active' ? 'active' : 'suspended' })
							.eq('stripe_subscription_id', sub['id'] as string);
					}
					return json({ received: true });
				}

				if (event.event_type === 'subscription.past_due') {
					const sub = event.data;
					if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
						const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
						await supabase.from('api_keys')
							.update({ status: 'suspended' })
							.eq('stripe_subscription_id', sub['id'] as string);
					}
					return json({ received: true });
				}

				if (event.event_type === 'subscription.canceled') {
					const sub = event.data;
					if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
						const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
						// Fetch key_hash before updating status — needed to deactivate KV
						const { data: keyRow } = await supabase
							.from('api_keys').select('key_hash').eq('stripe_subscription_id', sub['id'] as string).single();
						await supabase.from('api_keys')
							.update({ status: 'cancelled' })
							.eq('stripe_subscription_id', sub['id'] as string);
						// Deactivate in KV so auth hot path reflects immediately
						if (keyRow?.key_hash && env.ORACLE_API_KEYS) {
							const current = await env.ORACLE_API_KEYS.get(keyRow.key_hash as string);
							if (current) {
								const parsed = JSON.parse(current) as Record<string, unknown>;
								await env.ORACLE_API_KEYS.put(
									keyRow.key_hash as string,
									JSON.stringify({ ...parsed, status: 'inactive' }),
								);
							}
						}
					}
					return json({ received: true });
				}

				// Unrecognised event — acknowledge without processing
				return json({ received: true });
			}

			// ── GET /v5/account — account info for the calling key ────────
			// Requires X-Oracle-Key. Returns { plan, status, key_prefix }.
			if (url.pathname === '/v5/account') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const accountAuth = await checkApiKey(apiKey, env);
				if (!accountAuth.allowed) {
					const accountAuthHeaders = accountAuth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					return json({ error: accountAuth.error, message: accountAuth.message }, accountAuth.status, accountAuthHeaders);
				}

				// Internal keys (master / beta) are not Supabase records
				const isMaster = apiKey === env.MASTER_API_KEY;
				const isBeta   = env.BETA_API_KEYS
					? env.BETA_API_KEYS.split(',').map((k) => k.trim()).includes(apiKey)
					: false;
				if (isMaster || isBeta) {
					return json({ plan: 'internal', status: 'active', key_prefix: null });
				}

				// Paid key — KV should be warm from checkApiKey call above
				const keyHash = await sha256Hex(apiKey);
				if (env.ORACLE_API_KEYS) {
					const cached = await env.ORACLE_API_KEYS.get(keyHash);
					if (cached) {
						const data = JSON.parse(cached) as { plan: string; status: string };
						return json({ plan: data.plan, status: data.status, key_prefix: apiKey.substring(0, 14) });
					}
				}

				// KV miss (unlikely after checkApiKey) — try Supabase for key_prefix
				if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
					const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
					const { data } = await supabase
						.from('api_keys')
						.select('plan, status, key_prefix')
						.eq('key_hash', keyHash)
						.single();
					if (data) {
						return json({ plan: data.plan, status: data.status, key_prefix: data.key_prefix });
					}
				}

				return json({ error: 'ACCOUNT_NOT_FOUND', message: 'No account found for this API key' }, 404);
			}

			// ── POST /v5/keys/request — free tier key provisioning ────────
			// No auth required. Validates email, generates ho_free_ key,
			// stores in KV + Supabase, sends via Resend.
			if (url.pathname === '/v5/keys/request') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}
				const body = await request.json().catch(() => null) as { email?: unknown } | null;
				const email = body?.email;
				if (typeof email !== 'string' || !email.trim()) {
					return json({ error: 'INVALID_EMAIL', message: 'email is required' }, 400);
				}
				// Simple RFC-5322-compatible email check: local@domain.tld
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(email.trim())) {
					return json({ error: 'INVALID_EMAIL', message: 'email format is invalid' }, 400);
				}
				const normalizedEmail = email.trim().toLowerCase();

				// Generate ho_free_ key — shown to the user exactly once via email
				const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
				const keyValue    = 'ho_free_' + toHex(rawKeyBytes);
				const keyHash     = await sha256Hex(keyValue);
				const createdAt   = new Date().toISOString();

				// Store in KV — persistent (no TTL), plan = "free"
				if (env.ORACLE_API_KEYS) {
					await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({
						plan:       'free',
						status:     'active',
						email:      normalizedEmail,
						created_at: createdAt,
					}));
				}

				// Store in Supabase
				if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
					const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
					await supabase.from('api_keys').insert({
						id:         crypto.randomUUID(),
						key_hash:   keyHash,
						key_prefix: keyValue.substring(0, 14), // 'ho_free_' + 6 chars
						plan:       'free',
						status:     'active',
						email:      normalizedEmail,
						created_at: createdAt,
					});
				}

				// Send key via Resend (shown once — user cannot recover it)
				if (env.RESEND_API_KEY) {
					const emailRes = await fetch('https://api.resend.com/emails', {
						method:  'POST',
						headers: {
							'Authorization': `Bearer ${env.RESEND_API_KEY}`,
							'Content-Type':  'application/json',
						},
						body: JSON.stringify({
							from:    'Headless Oracle <keys@headlessoracle.com>',
							to:      [normalizedEmail],
							subject: 'Your free Headless Oracle API key',
							html: `<p>Here is your free Headless Oracle API key (save this — it will not be shown again):</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">${keyValue}</pre>
<p>Use it as the <code>X-Oracle-Key</code> header when calling <code>https://headlessoracle.com/v5/status</code>.</p>
<p>Free tier is rate-limited. Upgrade anytime at <a href="https://headlessoracle.com/pricing">headlessoracle.com/pricing</a>.</p>
<p>Documentation: <a href="https://headlessoracle.com/docs">headlessoracle.com/docs</a></p>`,
						}),
					});
					if (!emailRes.ok) {
						console.error(`RESEND_ERROR: failed to send free key email to ${normalizedEmail}`);
					}
				}

				return json({ plan: 'free', message: 'API key sent to your email' });
			}

			// ── 404 ──────────────────────────────────────────────────────
			return json({ error: 'NOT_FOUND', message: 'Route not found' }, 404);

		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : 'Internal server error';
			console.error(`ORACLE_TOP_LEVEL_ERROR: ${message}`);
			return json({
				error:   'CRITICAL_FAILURE',
				message: 'Oracle system error. Treat as UNKNOWN. Halt all execution.',
				status:  'UNKNOWN',
				source:  'SYSTEM',
			}, 500);
		}
	},

	// ─── Cron handlers ────────────────────────────────────────────────────────
	// 09:00 UTC — npm download tracking for @headlessoracle/verify
	// 17:00 UTC — MCP anonymous client usage summary (high-engagement detection)
	async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		if (event.cron === '0 9 * * *') {
			// Fetch @headlessoracle/verify download counts and log for monitoring.
			try {
				const [week, month] = await Promise.all([
					fetch('https://api.npmjs.org/downloads/point/last-week/@headlessoracle/verify'),
					fetch('https://api.npmjs.org/downloads/point/last-month/@headlessoracle/verify'),
				]);
				const [weekData, monthData] = await Promise.all([
					week.json() as Promise<{ downloads?: number; package?: string }>,
					month.json() as Promise<{ downloads?: number }>,
				]);
				console.log(JSON.stringify({
					event:         'NPM_DOWNLOADS',
					package:       weekData.package ?? '@headlessoracle/verify',
					last_7_days:   weekData.downloads  ?? 0,
					last_30_days:  monthData.downloads ?? 0,
					sampled_at:    new Date().toISOString(),
				}));
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : 'unknown error';
				console.error(`NPM_TRACKING_ERROR: ${msg}`);
			}
		} else if (event.cron === '0 17 * * *') {
			// Scan today's MCP client aggregates in KV and log a summary.
			// Identifies high-engagement anonymous clients (>10 requests/day) for conversion.
			try {
				const today  = new Date().toISOString().slice(0, 10);
				const prefix = `mcp_clients:${today}:`;
				const list   = await env.ORACLE_TELEMETRY.list({ prefix });

				if (list.keys.length === 0) {
					console.log(JSON.stringify({
						event:                   'MCP_CLIENT_SUMMARY',
						date:                    today,
						high_engagement_clients: 0,
						total_unique_clients:    0,
						top_asn_orgs:            [],
					}));
					return;
				}

				const records = await Promise.all(
					list.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name)),
				);
				const valid = records
					.filter((r): r is string => r !== null)
					.map((r) => JSON.parse(r) as McpClientRecord);

				const highEngagement = valid.filter((r) => r.request_count > 10);

				// Rank ASN orgs by unique client count for pipeline prioritisation.
				const asnCounts = new Map<string, number>();
				for (const r of valid) {
					if (r.asn_org) asnCounts.set(r.asn_org, (asnCounts.get(r.asn_org) ?? 0) + 1);
				}
				const topAsnOrgs = [...asnCounts.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 10)
					.map(([org]) => org);

				console.log(JSON.stringify({
					event:                   'MCP_CLIENT_SUMMARY',
					date:                    today,
					high_engagement_clients: highEngagement.length,
					total_unique_clients:    valid.length,
					top_asn_orgs:            topAsnOrgs,
				}));
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : 'unknown error';
				console.error(`MCP_SUMMARY_ERROR: ${msg}`);
			}
		}
	},
};
