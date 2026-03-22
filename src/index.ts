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
	// x402 micropayments — set via `wrangler secret put ORACLE_PAYMENT_ADDRESS`
	ORACLE_PAYMENT_ADDRESS?:     string;  // Base mainnet wallet for USDC micropayments
	// Real-time halt monitoring — optional Polygon.io API key for enhanced data
	POLYGON_API_KEY?:            string;  // polygon.io API key — optional; public Alpaca feed used if absent
	// Launch date for /v5/traction days_live counter — set via wrangler.toml [vars]
	LAUNCH_DATE?:                string;  // ISO 8601 UTC timestamp of go-live; defaults to 2026-03-10T08:00:00Z
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
	weekends?: string[]; // e.g. ['Fri', 'Sat'] for Middle Eastern exchanges; default ['Sat', 'Sun']
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

	// ── Australia ──────────────────────────────────────────────────────────────
	// DST: Australia/Sydney observes AEDT (UTC+11) Oct–Apr, AEST (UTC+10) Apr–Oct.
	XASX: {
		name: 'Australian Securities Exchange',
		timezone: 'Australia/Sydney',
		openHour: 10, openMinute: 0,
		closeHour: 16, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-26', // Australia Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-04-25', // ANZAC Day
				'2026-06-08', // Queen's Birthday (NSW — ASX follows NSW)
				'2026-12-25', // Christmas Day
				'2026-12-28', // Boxing Day observed (Dec 26 = Sat, Dec 27 = Sun → Mon Dec 28)
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-26', // Australia Day
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-04-26', // ANZAC Day observed (Apr 25 = Sun → Mon Apr 26)
				'2027-06-14', // Queen's Birthday (NSW)
				'2027-12-27', // Christmas Day observed (Dec 25 = Sat → Mon Dec 27)
				'2027-12-28', // Boxing Day observed (Dec 26 = Sun → Tue Dec 28)
			],
		},
	},

	// ── India ──────────────────────────────────────────────────────────────────
	// No DST. IST = UTC+5:30 year-round.
	XBOM: {
		name: 'BSE India (Bombay Stock Exchange)',
		timezone: 'Asia/Kolkata',
		openHour: 9, openMinute: 15,
		closeHour: 15, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-26', // Republic Day
				'2026-03-02', // Mahashivratri
				'2026-03-25', // Holi
				'2026-04-03', // Good Friday
				'2026-04-14', // Dr. Ambedkar Jayanti
				'2026-05-01', // Maharashtra Day
				'2026-08-15', // Independence Day
				'2026-10-02', // Gandhi Jayanti
				'2026-10-21', // Diwali Laxmi Puja (approx)
				'2026-11-04', // Diwali Balipratipada (approx)
				'2026-11-19', // Gurunanak Jayanti (approx)
				'2026-12-25', // Christmas Day
			],
			'2027': [
				'2027-01-26', // Republic Day
				'2027-02-19', // Mahashivratri (approx)
				'2027-03-17', // Holi (approx)
				'2027-04-02', // Good Friday
				'2027-04-14', // Dr. Ambedkar Jayanti
				'2027-05-03', // Maharashtra Day observed (May 1 = Sat)
				'2027-08-15', // Independence Day
				'2027-10-02', // Gandhi Jayanti
				'2027-10-11', // Diwali (approx)
				'2027-12-25', // Christmas Day (Sat — included for completeness)
			],
		},
	},

	XNSE: {
		name: 'NSE India (National Stock Exchange)',
		timezone: 'Asia/Kolkata',
		openHour: 9, openMinute: 15,
		closeHour: 15, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-26',
				'2026-03-02',
				'2026-03-25',
				'2026-04-03',
				'2026-04-14',
				'2026-05-01',
				'2026-08-15',
				'2026-10-02',
				'2026-10-21',
				'2026-11-04',
				'2026-11-19',
				'2026-12-25',
			],
			'2027': [
				'2027-01-26',
				'2027-02-19',
				'2027-03-17',
				'2027-04-02',
				'2027-04-14',
				'2027-05-03',
				'2027-08-15',
				'2027-10-02',
				'2027-10-11',
				'2027-12-25',
			],
		},
	},

	// ── China ──────────────────────────────────────────────────────────────────
	// No DST. CST = UTC+8 year-round.
	// Chinese exchanges have a lunch break 11:30–13:00 local time.
	// MAINTENANCE: Chinese holiday schedule is set annually by CSRC — verify before Dec 31.
	XSHG: {
		name: 'Shanghai Stock Exchange',
		timezone: 'Asia/Shanghai',
		openHour: 9, openMinute: 30,
		closeHour: 15, closeMinute: 0,
		lunchBreak: { startHour: 11, startMinute: 30, endHour: 13, endMinute: 0 },
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', // Chinese New Year
				'2026-04-03', '2026-04-06', // Qingming + extended
				'2026-05-01', '2026-05-04', '2026-05-05', // Labour Day
				'2026-06-19', // Dragon Boat
				'2026-09-25', // Mid-Autumn
				'2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', // Golden Week
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', // Chinese New Year (approx)
				'2027-03-29', // Qingming (approx)
				'2027-04-30', '2027-05-03', '2027-05-04', // Labour Day (approx)
				'2027-05-31', // Dragon Boat (approx)
				'2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07', // Golden Week (approx)
			],
		},
	},

	XSHE: {
		name: 'Shenzhen Stock Exchange',
		timezone: 'Asia/Shanghai',
		openHour: 9, openMinute: 30,
		closeHour: 15, closeMinute: 0,
		lunchBreak: { startHour: 11, startMinute: 30, endHour: 13, endMinute: 0 },
		holidays: {
			'2026': [
				'2026-01-01',
				'2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
				'2026-04-03', '2026-04-06',
				'2026-05-01', '2026-05-04', '2026-05-05',
				'2026-06-19',
				'2026-09-25',
				'2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
			],
			'2027': [
				'2027-01-01',
				'2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
				'2027-03-29',
				'2027-04-30', '2027-05-03', '2027-05-04',
				'2027-05-31',
				'2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
			],
		},
	},

	// ── South Korea ────────────────────────────────────────────────────────────
	// No DST. KST = UTC+9 year-round.
	XKRX: {
		name: 'Korea Exchange',
		timezone: 'Asia/Seoul',
		openHour: 9, openMinute: 0,
		closeHour: 15, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-28', '2026-01-29', '2026-01-30', // Lunar New Year
				'2026-03-01', // Independence Movement Day
				'2026-05-01', // Labour Day
				'2026-05-05', // Children's Day
				'2026-05-15', // Buddha's Birthday
				'2026-06-06', // Memorial Day
				'2026-08-15', // Liberation Day
				'2026-09-24', '2026-09-25', '2026-09-26', // Chuseok
				'2026-10-03', // National Foundation Day
				'2026-10-09', // Hangul Day
				'2026-12-25', // Christmas
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-02-15', '2027-02-16', '2027-02-17', // Lunar New Year (approx)
				'2027-03-01', // Independence Movement Day
				'2027-05-03', // Labour Day observed (May 1 = Sat)
				'2027-05-05', // Children's Day
				'2027-05-24', // Buddha's Birthday (approx)
				'2027-06-06', // Memorial Day
				'2027-08-15', // Liberation Day
				'2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', // Chuseok (approx)
				'2027-10-09', // Hangul Day
				'2027-12-25', // Christmas
			],
		},
	},

	// ── South Africa ───────────────────────────────────────────────────────────
	// No DST. SAST = UTC+2 year-round.
	XJSE: {
		name: 'Johannesburg Stock Exchange',
		timezone: 'Africa/Johannesburg',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-03-21', // Human Rights Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Family Day (Easter Monday)
				'2026-04-27', // Freedom Day
				'2026-05-01', // Workers Day
				'2026-06-16', // Youth Day
				'2026-08-10', // Women's Day observed (Aug 9 = Sun → Mon Aug 10)
				'2026-09-24', // Heritage Day
				'2026-12-16', // Day of Reconciliation
				'2026-12-25', // Christmas Day
				'2026-12-26', // Day of Goodwill
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-21', // Human Rights Day (Sun — weekend)
				'2027-03-26', // Good Friday
				'2027-03-29', // Family Day (Easter Monday)
				'2027-04-27', // Freedom Day
				'2027-05-01', // Workers Day (Sat — weekend)
				'2027-06-16', // Youth Day
				'2027-08-09', // Women's Day
				'2027-09-24', // Heritage Day
				'2027-12-16', // Day of Reconciliation
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Day of Goodwill
				'2027-12-27', // Christmas observed (Mon)
			],
		},
	},

	// ── Brazil ─────────────────────────────────────────────────────────────────
	// DST: Brazil/São Paulo observes DST (Southern Hemisphere — summer Oct–Feb).
	XBSP: {
		name: 'B3 Brazil',
		timezone: 'America/Sao_Paulo',
		openHour: 10, openMinute: 0,
		closeHour: 17, closeMinute: 55,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-02-16', '2026-02-17', // Carnival
				'2026-04-03', // Good Friday
				'2026-04-21', // Tiradentes
				'2026-05-01', // Labour Day
				'2026-06-04', // Corpus Christi
				'2026-07-09', // Constitutionalist Revolution (São Paulo state)
				'2026-09-07', // Independence Day
				'2026-10-12', // Nossa Senhora Aparecida
				'2026-11-02', // All Souls' Day
				'2026-11-15', // Proclamation of the Republic
				'2026-11-20', // Black Consciousness Day
				'2026-12-24', // Christmas Eve
				'2026-12-25', // Christmas Day
				'2026-12-31', // New Year's Eve
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-01', '2027-03-02', // Carnival (approx)
				'2027-03-26', // Good Friday
				'2027-04-21', // Tiradentes
				'2027-05-01', // Labour Day (Sat — weekend)
				'2027-05-24', // Corpus Christi (approx)
				'2027-07-09', // Constitutionalist Revolution
				'2027-09-07', // Independence Day
				'2027-10-12', // Nossa Senhora Aparecida
				'2027-11-02', // All Souls' Day
				'2027-11-15', // Proclamation of the Republic
				'2027-11-20', // Black Consciousness Day (Sat — weekend)
				'2027-12-24', // Christmas Eve
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-31', // New Year's Eve
			],
		},
	},

	// ── Switzerland ────────────────────────────────────────────────────────────
	// DST: Europe/Zurich observes DST (same as EU — last Sun Mar to last Sun Oct).
	XSWX: {
		name: 'SIX Swiss Exchange',
		timezone: 'Europe/Zurich',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-05-14', // Ascension Day
				'2026-05-25', // Whit Monday
				'2026-08-01', // Swiss National Day
				'2026-12-24', // Christmas Eve
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
				'2026-12-31', // New Year's Eve
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-05-06', // Ascension Day
				'2027-05-17', // Whit Monday
				'2027-08-01', // Swiss National Day
				'2027-12-24', // Christmas Eve
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Boxing Day (Sun — weekend)
				'2027-12-31', // New Year's Eve
			],
		},
	},

	// ── Italy ──────────────────────────────────────────────────────────────────
	// DST: Europe/Rome observes DST (same transition as Paris/Zurich).
	XMIL: {
		name: 'Borsa Italiana',
		timezone: 'Europe/Rome',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 35,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-04-25', // Liberation Day
				'2026-05-01', // Labour Day
				'2026-06-02', // Republic Day
				'2026-08-15', // Assumption of Mary
				'2026-11-01', // All Saints' Day
				'2026-12-08', // Immaculate Conception
				'2026-12-24', // Christmas Eve
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
				'2026-12-31', // New Year's Eve
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-04-25', // Liberation Day
				'2027-05-01', // Labour Day (Sat — weekend)
				'2027-06-02', // Republic Day
				'2027-08-15', // Assumption of Mary (Sun — weekend)
				'2027-11-01', // All Saints' Day
				'2027-12-08', // Immaculate Conception
				'2027-12-24', // Christmas Eve
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Boxing Day (Sun — weekend)
				'2027-12-31', // New Year's Eve
			],
		},
	},

	// ── Turkey ─────────────────────────────────────────────────────────────────
	// No DST since 2016. TRT = UTC+3 year-round.
	// Islamic holidays (Eid al-Fitr, Eid al-Adha) shift ~11 days earlier each year.
	// MAINTENANCE: verify Islamic holiday dates annually via Islamic calendar.
	XIST: {
		name: 'Borsa Istanbul',
		timezone: 'Europe/Istanbul',
		openHour: 10, openMinute: 0,
		closeHour: 18, closeMinute: 0,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-03-31', '2026-04-01', '2026-04-02', // Eid al-Fitr (approx Mar 30–Apr 1)
				'2026-04-23', // National Sovereignty and Children's Day
				'2026-05-01', // Labour Day
				'2026-05-19', // Commemoration of Atatürk / Youth Day
				'2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09', // Eid al-Adha (approx)
				'2026-07-15', // Democracy and National Unity Day
				'2026-08-30', // Victory Day
				'2026-10-28', '2026-10-29', // Republic Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-20', '2027-03-21', '2027-03-22', // Eid al-Fitr (approx)
				'2027-04-23', // National Sovereignty and Children's Day
				'2027-05-01', // Labour Day (Sat — weekend)
				'2027-05-19', // Commemoration of Atatürk / Youth Day
				'2027-05-26', '2027-05-27', '2027-05-28', '2027-05-29', // Eid al-Adha (approx)
				'2027-07-15', // Democracy and National Unity Day
				'2027-08-30', // Victory Day
				'2027-10-28', '2027-10-29', // Republic Day
			],
		},
	},

	// ── Saudi Arabia ───────────────────────────────────────────────────────────
	// No DST. AST = UTC+3 year-round.
	// CRITICAL: weekends are Friday and Saturday — Sunday IS a trading day.
	// Islamic holidays shift ~11 days earlier each year.
	// MAINTENANCE: verify Islamic holiday dates annually.
	XSAU: {
		name: 'Saudi Exchange (Tadawul)',
		timezone: 'Asia/Riyadh',
		openHour: 10, openMinute: 0,
		closeHour: 15, closeMinute: 0,
		weekends: ['Fri', 'Sat'], // Sunday is a trading day
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day (observed)
				'2026-02-22', // Saudi Founding Day
				'2026-03-29', '2026-03-30', '2026-03-31', // Eid al-Fitr (approx)
				'2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', // Eid al-Adha (approx)
				'2026-09-23', // Saudi National Day
			],
			'2027': [
				'2027-01-01', // New Year's Day (observed)
				'2027-02-22', // Saudi Founding Day
				'2027-03-18', '2027-03-19', '2027-03-20', // Eid al-Fitr (approx)
				'2027-05-25', '2027-05-26', '2027-05-27', '2027-05-28', // Eid al-Adha (approx)
				'2027-09-23', // Saudi National Day
			],
		},
	},

	// ── United Arab Emirates ───────────────────────────────────────────────────
	// No DST. GST = UTC+4 year-round.
	// CRITICAL: weekends are Friday and Saturday — Sunday IS a trading day.
	// Islamic holidays shift ~11 days earlier each year.
	// MAINTENANCE: verify Islamic holiday dates annually.
	XDFM: {
		name: 'Dubai Financial Market',
		timezone: 'Asia/Dubai',
		openHour: 10, openMinute: 0,
		closeHour: 14, closeMinute: 0,
		weekends: ['Fri', 'Sat'], // Sunday is a trading day
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-03-29', '2026-03-30', '2026-03-31', // Eid al-Fitr (approx)
				'2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', // Eid al-Adha (approx)
				'2026-12-01', '2026-12-02', '2026-12-03', // UAE National Day (Dec 2-3) + bridge
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-03-18', '2027-03-19', '2027-03-20', // Eid al-Fitr (approx)
				'2027-05-25', '2027-05-26', '2027-05-27', '2027-05-28', // Eid al-Adha (approx)
				'2027-12-01', '2027-12-02', '2027-12-03', // UAE National Day
			],
		},
	},

	// ── New Zealand ────────────────────────────────────────────────────────────
	// DST: Pacific/Auckland observes NZDT (UTC+13) Oct–Apr, NZST (UTC+12) Apr–Oct.
	XNZE: {
		name: 'New Zealand Exchange',
		timezone: 'Pacific/Auckland',
		openHour: 10, openMinute: 0,
		closeHour: 16, closeMinute: 45,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-02-06', // Waitangi Day
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-04-25', // ANZAC Day
				'2026-06-01', // Queen's Birthday (1st Mon Jun)
				'2026-06-24', // Matariki (Maori New Year — approx, varies annually)
				'2026-10-26', // Labour Day (4th Mon Oct)
				'2026-12-25', // Christmas Day
				'2026-12-28', // Boxing Day observed (Dec 26 = Sat, Dec 27 = Sun → Mon Dec 28)
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-02-08', // Waitangi Day observed (Feb 6 = Sat → Mon Feb 8)
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-04-26', // ANZAC Day observed (Apr 25 = Sun → Mon Apr 26)
				'2027-06-07', // Queen's Birthday
				'2027-06-25', // Matariki (approx — verify annually via NZ Govt)
				'2027-10-25', // Labour Day
				'2027-12-24', // Christmas Eve (observed as Christmas — Dec 25 = Sat)
				'2027-12-27', // Boxing Day observed
			],
		},
	},

	// ── Finland ────────────────────────────────────────────────────────────────
	// DST: Europe/Helsinki observes EEST (UTC+3) late Mar to late Oct, EET (UTC+2) otherwise.
	XHEL: {
		name: 'Nasdaq Helsinki',
		timezone: 'Europe/Helsinki',
		openHour: 10, openMinute: 0,
		closeHour: 18, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-06', // Epiphany
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-05-01', // May Day
				'2026-05-14', // Ascension Day
				'2026-05-15', // Ascension Friday (bridge day)
				'2026-06-19', // Midsummer Eve (Fri nearest Jun 24)
				'2026-06-20', // Midsummer Day
				'2026-10-31', // All Saints (Sat nearest Nov 1)
				'2026-12-06', // Finnish Independence Day
				'2026-12-24', // Christmas Eve
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
				'2026-12-31', // New Year's Eve
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-06', // Epiphany
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-05-01', // May Day (Sat — weekend)
				'2027-05-06', // Ascension Day
				'2027-05-17', // Whit Monday
				'2027-06-25', // Midsummer Eve (approx)
				'2027-10-30', // All Saints (approx)
				'2027-12-06', // Finnish Independence Day
				'2027-12-24', // Christmas Eve
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Boxing Day (Sun — weekend)
				'2027-12-31', // New Year's Eve
			],
		},
	},

	// ── Sweden ─────────────────────────────────────────────────────────────────
	// DST: Europe/Stockholm observes CEST (UTC+2) late Mar to late Oct, CET (UTC+1) otherwise.
	XSTO: {
		name: 'Nasdaq Stockholm',
		timezone: 'Europe/Stockholm',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 30,
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-06', // Epiphany
				'2026-04-03', // Good Friday
				'2026-04-06', // Easter Monday
				'2026-05-01', // Labour Day
				'2026-05-14', // Ascension Day
				'2026-05-15', // Ascension Friday (bridge)
				'2026-06-06', // National Day of Sweden
				'2026-06-19', // Midsummer Eve (Fri nearest Jun 24)
				'2026-06-20', // Midsummer Day
				'2026-12-24', // Christmas Eve
				'2026-12-25', // Christmas Day
				'2026-12-26', // Boxing Day
				'2026-12-31', // New Year's Eve
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-06', // Epiphany
				'2027-03-26', // Good Friday
				'2027-03-29', // Easter Monday
				'2027-05-01', // Labour Day (Sat — weekend)
				'2027-05-06', // Ascension Day
				'2027-05-14', // Ascension Friday (bridge — approx)
				'2027-06-06', // National Day of Sweden
				'2027-06-25', // Midsummer Eve (approx)
				'2027-12-24', // Christmas Eve
				'2027-12-25', // Christmas Day (Sat — weekend)
				'2027-12-26', // Boxing Day (Sun — weekend)
				'2027-12-31', // New Year's Eve
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

	// Short weekday names matching Intl.DateTimeFormat 'short' weekday output
	const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	// Count every day of the year to get weekday/weekend totals for default (Sat/Sun) calendar
	let weekdaysInYear = 0;
	let weekendDaysInYear = 0;
	const cursor = new Date(Date.UTC(year, 0, 1));
	while (cursor.getUTCFullYear() === year) {
		const dow = cursor.getUTCDay(); // 0 = Sun, 6 = Sat
		if (dow === 0 || dow === 6) weekendDaysInYear++;
		else weekdaysInYear++;
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}

	// Pre-compute per-weekday counts for non-standard weekend support
	const dowCountInYear: Record<string, number> = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
	const cursor2 = new Date(Date.UTC(year, 0, 1));
	while (cursor2.getUTCFullYear() === year) {
		dowCountInYear[DAY_NAMES[cursor2.getUTCDay()]]++;
		cursor2.setUTCDate(cursor2.getUTCDate() + 1);
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
			// Trading days = non-weekend days minus holidays that fall on a trading day
			const configWeekends = config.weekends ?? ['Sat', 'Sun'];
			const tradingDaysInYear = Object.entries(dowCountInYear)
				.filter(([day]) => !configWeekends.includes(day))
				.reduce((sum, [, cnt]) => sum + cnt, 0);
			const tradingDayHolidayCount = yearHols.filter((dateStr) => {
				const dayName = DAY_NAMES[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
				return !configWeekends.includes(dayName);
			}).length;
			lunchBreakSessions += tradingDaysInYear - tradingDayHolidayCount;
		}
	}

	// Sum weekend days per exchange (each exchange has its own weekend configuration)
	let weekendDays = 0;
	for (const config of Object.values(MARKET_CONFIGS)) {
		const configWeekends = config.weekends ?? ['Sat', 'Sun'];
		weekendDays += configWeekends.reduce((sum, day) => sum + (dowCountInYear[day] ?? 0), 0);
	}
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
type SourceValue = 'SCHEDULE' | 'OVERRIDE' | 'SYSTEM' | 'REALTIME';

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

	// Weekend — Middle Eastern exchanges use ['Fri', 'Sat']; default is ['Sat', 'Sun']
	const weekends = config.weekends ?? ['Sat', 'Sun'];
	if (weekends.includes(weekday)) {
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

		const sessionWeekends = config.weekends ?? ['Sat', 'Sun'];
		if (!sessionWeekends.includes(weekday) && !yearHolidays.includes(dateStr)) {
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

// keyHash is included when the key was authenticated via KV or Supabase (steps 3–4).
// It is absent for MASTER_API_KEY and BETA_API_KEYS (which have no Supabase row).
// Callers use it to update last_used_at without re-hashing.
type AuthResult = { allowed: true; plan: string; keyHash?: string } | { allowed: false; status: 402 | 403; error: string; message: string };

async function checkApiKey(key: string, env: Env): Promise<AuthResult> {
	// Step 1: master key — fastest possible path
	if (key === env.MASTER_API_KEY) return { allowed: true, plan: 'internal' };

	// Step 2: beta keys — no lookup
	if (env.BETA_API_KEYS) {
		const betaKeys = env.BETA_API_KEYS.split(',').map((k) => k.trim());
		if (betaKeys.includes(key)) return { allowed: true, plan: 'internal' };
	}

	// Steps 3–5: paid key — hash once, use for KV and Supabase
	const keyHash = await sha256Hex(key);

	// Step 3: KV cache
	if (env.ORACLE_API_KEYS) {
		const cached = await env.ORACLE_API_KEYS.get(keyHash);
		if (cached) {
			const parsed = JSON.parse(cached) as { plan?: string; tier?: string; status: string; expires_at?: string };
			// Sandbox keys expire by TTL but also check expires_at for belt-and-suspenders
			if (parsed.tier === 'sandbox' || parsed.plan === 'sandbox') {
				if (parsed.status !== 'active') {
					return { allowed: false, status: 402, error: 'PAYMENT_REQUIRED', message: 'Sandbox key inactive or expired' };
				}
				if (parsed.expires_at && new Date(parsed.expires_at) <= new Date()) {
					return { allowed: false, status: 402, error: 'PAYMENT_REQUIRED', message: 'Sandbox key expired. Get a fresh key at headlessoracle.com/v5/sandbox' };
				}
				return { allowed: true, plan: 'sandbox', keyHash };
			}
			const plan   = parsed.plan ?? 'free';
			const status = parsed.status;
			if (status === 'active') return { allowed: true, plan, keyHash };
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
			if (data.status === 'active') return { allowed: true, plan: data.plan, keyHash };
			return { allowed: false, status: 402, error: 'PAYMENT_REQUIRED', message: 'Subscription suspended or cancelled — renew at headlessoracle.com' };
		}
	}

	// Step 5: not found anywhere
	return { allowed: false, status: 403, error: 'INVALID_API_KEY', message: 'Invalid API key' };
}

// ─── Key Usage Tracking ───────────────────────────────────────────────────────
// Called after every successful authenticated request for keys tracked in Supabase.
// Updates last_used_at. Non-blocking — always called via ctx.waitUntil().
//
// NOTE: request_count increment requires a DB migration and a Supabase RPC function
// for atomic increment (PostgREST cannot do column += 1 without raw SQL).
// Human task: ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 0;
// Then add a Supabase function: CREATE OR REPLACE FUNCTION increment_key_usage(p_key_hash text)
//   RETURNS void AS $$ UPDATE api_keys SET last_used_at = now(), request_count = request_count + 1
//   WHERE key_hash = p_key_hash; $$ LANGUAGE sql;
// And call via: supabase.rpc('increment_key_usage', { p_key_hash: keyHash })

async function updateKeyUsage(keyHash: string, env: Env): Promise<void> {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
	try {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
		const { error } = await supabase
			.from('api_keys')
			.update({ last_used_at: new Date().toISOString() })
			.eq('key_hash', keyHash);
		if (error) console.error(`USAGE_TRACK_ERROR: ${error.message}`);
	} catch (e) {
		console.error(`USAGE_TRACK_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function insertReceiptAudit(
	keyHash: string,
	receipt: Record<string, unknown>,
	env: Env,
): Promise<void> {
	if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
	try {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
		const { error } = await supabase.from('receipt_audit').insert({
			key_hash:       keyHash,
			mic:            String(receipt.mic ?? ''),
			status:         String(receipt.status ?? ''),
			source:         String(receipt.source ?? ''),
			issued_at:      String(receipt.issued_at ?? new Date().toISOString()),
			schema_version: String(receipt.schema_version ?? 'v5.0'),
		});
		if (error) console.error(`RECEIPT_AUDIT_ERROR: ${error.message}`);
	} catch (e) {
		console.error(`RECEIPT_AUDIT_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
	}
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
	XASX: { country: 'AU', currency: 'AUD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XBOM: { country: 'IN', currency: 'INR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XNSE: { country: 'IN', currency: 'INR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSHG: { country: 'CN', currency: 'CNY', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSHE: { country: 'CN', currency: 'CNY', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XKRX: { country: 'KR', currency: 'KRW', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XJSE: { country: 'ZA', currency: 'ZAR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XBSP: { country: 'BR', currency: 'BRL', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSWX: { country: 'CH', currency: 'CHF', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XMIL: { country: 'IT', currency: 'EUR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XIST: { country: 'TR', currency: 'TRY', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSAU: { country: 'SA', currency: 'SAR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XDFM: { country: 'AE', currency: 'AED', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XNZE: { country: 'NZ', currency: 'NZD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XHEL: { country: 'FI', currency: 'EUR', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XSTO: { country: 'SE', currency: 'SEK', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
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

// ─── x402 Micropayment ────────────────────────────────────────────────────────

// USDC ERC-20 contract on Base mainnet (chain ID 8453).
const X402_USDC_CONTRACT    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// 0.001 USDC = 1000 units at 6 decimals. Minimum payment per request.
const X402_MIN_AMOUNT_UNITS = BigInt(1000);
// ERC-20 Transfer(address,address,uint256) event topic.
const ERC20_TRANSFER_TOPIC  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Base mainnet public JSON-RPC endpoint — no API key required.
const BASE_RPC_URL          = 'https://mainnet.base.org';
// Free tier: daily request cap before x402 micropayment is required.
const FREE_TIER_DAILY_LIMIT    = 500;
const SANDBOX_DAILY_LIMIT      = 100;   // Sandbox keys: 100 calls per 24h key lifetime
const BUILDER_TIER_DAILY_LIMIT = 50_000;
const PRO_TIER_DAILY_LIMIT     = 200_000;

// Returns the daily request limit for a given plan. null = unlimited (protocol, internal).
function getPlanDailyLimit(plan: string): number | null {
	switch (plan) {
		case 'free':    return FREE_TIER_DAILY_LIMIT;
		case 'builder': return BUILDER_TIER_DAILY_LIMIT;
		case 'pro':     return PRO_TIER_DAILY_LIMIT;
		default:        return null; // protocol, internal — no limit
	}
}

// Response headers signalling to HTTP clients that a payment is required.
const X402_RESPONSE_HEADERS: Record<string, string> = {
	'X-Payment-Required': 'true',
	'X-Payment-Scheme':   'x402',
	'X-Payment-Network':  'base-mainnet',
	'X-Payment-Chain-ID': '8453',
	'X-Payment-Amount':   '0.001 USDC',
};

interface X402Payment {
	txHash:         string;
	network:        string;
	amount:         string;
	paymentAddress: string;
	memo:           string;
}

interface EthLog {
	address: string;
	topics:  string[];
	data:    string;
}

interface EthReceipt {
	status:      string;
	to:          string | null;
	blockNumber: string;
	logs:        EthLog[];
}

interface CreditRecord {
	balance:        number;
	last_purchased: string;
}

// Verifies a USDC payment on Base mainnet via public JSON-RPC.
// Checks: tx status, USDC contract, recipient address, amount, age, replay.
async function verifyX402Payment(
	payment: X402Payment,
	paymentAddress: string,
	env: Env,
): Promise<{ valid: boolean; detail?: string }> {
	if (payment.network !== 'base-mainnet') {
		return { valid: false, detail: 'WRONG_NETWORK: expected base-mainnet' };
	}
	const txHash = payment.txHash.toLowerCase();
	if (!/^0x[0-9a-f]{64}$/.test(txHash)) {
		return { valid: false, detail: 'INVALID_TX_HASH' };
	}

	// Replay check first — prevent double-spend before any network call
	const replayKey   = `x402_used:${txHash}`;
	const alreadyUsed = await env.ORACLE_TELEMETRY.get(replayKey).catch(() => null);
	if (alreadyUsed !== null) {
		return { valid: false, detail: 'TRANSACTION_ALREADY_USED' };
	}

	// Fetch receipt from Base mainnet (status, logs)
	let receipt: EthReceipt | null = null;
	try {
		const rpcRes = await fetch(BASE_RPC_URL, {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({
				jsonrpc: '2.0', id: 1,
				method:  'eth_getTransactionReceipt',
				params:  [txHash],
			}),
		});
		const rpcData = await rpcRes.json() as { result: EthReceipt | null };
		receipt = rpcData.result;
	} catch {
		return { valid: false, detail: 'RPC_FETCH_FAILED' };
	}
	if (!receipt) return { valid: false, detail: 'TRANSACTION_NOT_FOUND' };
	if (receipt.status !== '0x1') return { valid: false, detail: 'TRANSACTION_FAILED' };

	// Find the USDC Transfer event crediting our payment address
	const transferLog = receipt.logs.find(
		(log) =>
			log.address.toLowerCase() === X402_USDC_CONTRACT.toLowerCase() &&
			log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
			log.topics[2] != null &&
			('0x' + log.topics[2].slice(-40)).toLowerCase() === paymentAddress.toLowerCase(),
	);
	if (!transferLog) {
		return { valid: false, detail: 'NO_USDC_TRANSFER_TO_PAYMENT_ADDRESS' };
	}
	const amountPaid = BigInt(transferLog.data);
	if (amountPaid < X402_MIN_AMOUNT_UNITS) {
		return { valid: false, detail: `INSUFFICIENT_AMOUNT: paid ${amountPaid}, required ${X402_MIN_AMOUNT_UNITS}` };
	}

	// Fetch block to verify transaction age (max 300 seconds)
	let blockTimestampSec = 0;
	try {
		const blockRes = await fetch(BASE_RPC_URL, {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({
				jsonrpc: '2.0', id: 2,
				method:  'eth_getBlockByNumber',
				params:  [receipt.blockNumber, false],
			}),
		});
		const blockData = await blockRes.json() as { result: { timestamp: string } | null };
		if (blockData.result?.timestamp) {
			blockTimestampSec = parseInt(blockData.result.timestamp, 16);
		}
	} catch {
		return { valid: false, detail: 'BLOCK_FETCH_FAILED' };
	}

	const ageSeconds = Math.floor(Date.now() / 1000) - blockTimestampSec;
	if (ageSeconds > 300) {
		return { valid: false, detail: `TRANSACTION_EXPIRED: ${ageSeconds}s old, max 300s` };
	}

	// Mark as used — 600s TTL prevents replay across the boundary window
	await env.ORACLE_TELEMETRY.put(replayKey, '1', { expirationTtl: 600 }).catch(() => {});
	console.log(JSON.stringify({ event: 'X402_PAYMENT_VERIFIED', tx_hash: txHash, amount_units: amountPaid.toString() }));
	return { valid: true };
}

// Build the x402 payment payload for a 402 response.
function build402Payload(paymentAddress: string, keyHash: string): Record<string, unknown> {
	return {
		error:   'PAYMENT_REQUIRED',
		message: 'Free tier exhausted. Pay 0.001 USDC per request via x402 on Base network, or upgrade at headlessoracle.com/pricing',
		x402: {
			version:             '1',
			scheme:              'exact',
			network:             'base-mainnet',
			chainId:             8453,
			amount:              '1000',
			currency:            'USDC',
			decimals:            6,
			paymentAddress,
			usdcContractAddress: X402_USDC_CONTRACT,
			memo:                `${keyHash}:${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`,
			maxAge:              300,
		},
		alternatives: {
			monthly:  'https://headlessoracle.com/pricing',
			free_key: 'https://headlessoracle.com/v5/keys/request',
			prepaid:  'https://headlessoracle.com/v5/credits/purchase',
		},
		founder_note: "You're hitting our limits — that means you're building something real. Reply to hello@headlessoracle.com and I'll set you up with a proper production key. — Mike",
	};
}

// Build an x402scan-compatible 402 payload.
// Format matches the x402 standard (https://x402.org): x402Version, accepts[], error.
// endpoint: 'status' for /v5/status (mic param), 'batch' for /v5/batch (mics param).
function buildX402ScanPayload(paymentAddress: string, resourceUrl: string, endpoint: 'status' | 'batch' = 'status'): Record<string, unknown> {
	const isStatus = endpoint === 'status';
	return {
		x402Version: 1,
		accepts: [
			{
				scheme:            'exact',
				network:           'eip155:8453',
				maxAmountRequired: isStatus ? '1000' : '5000',
				resource:          resourceUrl,
				description:       isStatus
					? 'Signed market-state receipt for one exchange. OPEN/CLOSED/HALTED/UNKNOWN — Ed25519 signed, 60s TTL.'
					: 'Signed market-state receipts for multiple exchanges in one request. Each receipt Ed25519 signed, 60s TTL.',
				mimeType:          'application/json',
				payTo:             paymentAddress,
				maxTimeoutSeconds: 60,
				asset:             X402_USDC_CONTRACT,
				input: isStatus
					? {
						type:       'object',
						properties: {
							mic: {
								type:        'string',
								description: 'ISO 10383 Market Identifier Code (e.g. XNYS, XNAS, XLON)',
								example:     'XNYS',
							},
						},
						required: ['mic'],
					}
					: {
						type:       'object',
						properties: {
							mics: {
								type:        'string',
								description: 'Comma-separated list of MIC codes (e.g. XNYS,XNAS,XLON)',
								example:     'XNYS,XNAS,XLON',
							},
						},
						required: ['mics'],
					},
				extra: {
					name:    'Headless Oracle',
					version: 'v5.0',
				},
			},
		],
		error: 'X-Payment-Required',
	};
}

// ─── Standard Rate-Limit Headers ──────────────────────────────────────────────────────────────────────────────
// Builds the X-Oracle-Plan / X-RateLimit-* header set for any response.
// plan: the key's plan tier (free, builder, pro, protocol, sandbox, internal)
// used: requests used today
// limit: daily limit for this plan (0 = unlimited)
// now: current request time (used to compute reset = next UTC midnight)
function makeRateLimitHeaders(plan: string, used: number, limit: number, now: Date): Record<string, string> {
	const midnight = new Date(now);
	midnight.setUTCDate(midnight.getUTCDate() + 1);
	midnight.setUTCHours(0, 0, 0, 0);
	return {
		'X-Oracle-Plan':         plan,
		'X-RateLimit-Limit':     String(limit),
		'X-RateLimit-Remaining': String(Math.max(0, limit - used)),
		'X-RateLimit-Reset':     midnight.toISOString(),
	};
}

// Compute seconds until next UTC midnight — used for Retry-After on 429 responses.
// Minimum 1 to avoid a 0-second retry-after that some clients treat as "retry immediately".
function computeRetryAfterSeconds(now: Date): number {
	const midnight = new Date(now);
	midnight.setUTCDate(midnight.getUTCDate() + 1);
	midnight.setUTCHours(0, 0, 0, 0);
	return Math.max(1, Math.floor((midnight.getTime() - now.getTime()) / 1000));
}

// Add soft rate-limit warning headers when free tier usage crosses 80% or 95%.
function addRateLimitWarningHeaders(headers: Headers, percentUsed: number, upgradeUrl: string): void {
	if (percentUsed >= 95) {
		headers.set('X-RateLimit-Warning', 'true');
		headers.set('X-RateLimit-Warning-Message', 'You have used 95% of your daily free tier limit. Next requests will require x402 payment or upgrade.');
		headers.set('X-RateLimit-Upgrade-URL', upgradeUrl);
	} else if (percentUsed >= 80) {
		headers.set('X-RateLimit-Warning', 'true');
		headers.set('X-RateLimit-Warning-Message', 'You have used 80% of your daily free tier limit. Upgrade at headlessoracle.com/pricing or use x402 payments to continue.');
		headers.set('X-RateLimit-Upgrade-URL', upgradeUrl);
	}
}

// Get the number of requests made today by a free tier key.
async function getDailyUsage(keyHash: string, env: Env): Promise<number> {
	const key    = `free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`;
	const stored = await env.ORACLE_TELEMETRY.get(key).catch(() => null);
	return stored ? parseInt(stored, 10) : 0;
}

// Increment the daily usage counter for a free tier key (non-blocking).
function incrementDailyUsage(keyHash: string, env: Env, ctx: ExecutionContext, current: number): void {
	const key  = `free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`;
	const putP = env.ORACLE_TELEMETRY.put(key, String(current + 1), { expirationTtl: 25 * 3600 }).catch(() => {});
	if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(putP);
}

// Increment a named KV counter non-blockingly (acquisition telemetry).
// key: full KV key string; ttlSeconds: expiration (default 25h to survive midnight with margin).
function incrementKvCounter(key: string, env: Env, ctx: ExecutionContext, ttlSeconds = 25 * 3600): void {
	if (typeof ctx?.waitUntil !== 'function') return;
	ctx.waitUntil(
		env.ORACLE_TELEMETRY.get(key).then((val) => {
			const next = (parseInt(val ?? '0', 10) || 0) + 1;
			return env.ORACLE_TELEMETRY.put(key, String(next), { expirationTtl: ttlSeconds });
		}).catch(() => {}),
	);
}

// Read credit balance for a key.
async function getCreditBalance(keyHash: string, env: Env): Promise<CreditRecord> {
	const stored = await env.ORACLE_TELEMETRY.get(`credits:${keyHash}`).catch(() => null);
	return stored ? JSON.parse(stored) as CreditRecord : { balance: 0, last_purchased: '' };
}

// Add credits to a key's balance.
async function addCredits(keyHash: string, credits: number, env: Env): Promise<void> {
	const key     = `credits:${keyHash}`;
	const current = await getCreditBalance(keyHash, env);
	await env.ORACLE_TELEMETRY.put(key, JSON.stringify({
		balance:        current.balance + credits,
		last_purchased: new Date().toISOString(),
	}));
}

// Consume 1 credit from a key's balance (non-blocking).
function consumeCredit(keyHash: string, credits: CreditRecord, env: Env, ctx: ExecutionContext): void {
	const key  = `credits:${keyHash}`;
	const putP = env.ORACLE_TELEMETRY.put(key, JSON.stringify({
		...credits,
		balance: Math.max(0, credits.balance - 1),
	})).catch(() => {});
	if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(putP);
}

// ─── ISO week utility ────────────────────────────────────────────────────────

function getISOWeek(date: Date): string {
	const d      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo    = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
	return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

// ─── Weekly digest ────────────────────────────────────────────────────────────
// Runs Monday 09:00 UTC. Summarises the past 7 days of MCP client activity from
// ORACLE_TELEMETRY KV and writes a weekly_digest:{YYYY-WW} summary key (90-day TTL).

async function runWeeklyDigest(env: Env): Promise<void> {
	try {
		const allKeys = await env.ORACLE_TELEMETRY.list({ prefix: 'mcp_clients:' });
		if (allKeys.keys.length === 0) {
			console.log(JSON.stringify({ event: 'WEEKLY_DIGEST', week: getISOWeek(new Date()), unique_clients: 0, total_requests: 0 }));
			return;
		}

		// Parse key structure: mcp_clients:{date}:{clientHash}
		// Only process past 7 days
		const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
		const recentKeys   = allKeys.keys.filter((k) => {
			const parts = k.name.split(':');
			return parts.length === 3 && parts[1] >= sevenDaysAgo;
		});

		// Limit to 100 fetches to avoid overload
		const sample  = recentKeys.slice(0, 100);
		const records = await Promise.all(
			sample.map((k) => env.ORACLE_TELEMETRY.get(k.name).catch(() => null)),
		);

		// Aggregate metrics
		const clientDateMap = new Map<string, Set<string>>(); // clientHash → set of dates seen
		let totalRequests    = 0;
		const asnRequestMap  = new Map<string, number>();

		for (let i = 0; i < sample.length; i++) {
			const raw = records[i];
			if (!raw) continue;
			const parts      = sample[i].name.split(':');
			const date        = parts[1];
			const clientHash  = parts[2];
			const parsed      = JSON.parse(raw) as { request_count?: number; asn_org?: string };
			const reqCount    = parsed.request_count ?? 0;

			totalRequests += reqCount;

			if (!clientDateMap.has(clientHash)) clientDateMap.set(clientHash, new Set());
			clientDateMap.get(clientHash)!.add(date);

			if (parsed.asn_org) {
				asnRequestMap.set(parsed.asn_org, (asnRequestMap.get(parsed.asn_org) ?? 0) + reqCount);
			}
		}

		const uniqueClients    = clientDateMap.size;
		const newClients       = [...clientDateMap.entries()].filter(([, dates]) => dates.size === 1).length;
		const returningClients = [...clientDateMap.entries()].filter(([, dates]) => dates.size > 1).length;
		const topClientAsn     = [...asnRequestMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

		const isoWeek = getISOWeek(new Date());
		const digest  = {
			week:               isoWeek,
			unique_clients:     uniqueClients,
			total_requests:     totalRequests,
			new_clients:        newClients,
			returning_clients:  returningClients,
			top_client_asn:     topClientAsn,
			sampled_at:         new Date().toISOString(),
		};

		await env.ORACLE_TELEMETRY.put(`weekly_digest:${isoWeek}`, JSON.stringify(digest), { expirationTtl: 90 * 86400 });
		console.log(JSON.stringify({ event: 'WEEKLY_DIGEST', ...digest }));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : 'unknown error';
		console.error(`WEEKLY_DIGEST_ERROR: ${msg}`);
	}
}

// ─── Static discovery files ───────────────────────────────────────────────────
// Served as plain text. robots.txt signals to AI crawlers which paths are open.
// llms.txt (llmstxt.org convention) provides a machine-readable summary for LLMs.

// ─── Embedded doc files served at /docs/*.md ─────────────────────────────────
// These are referenced from /v5/compliance and /.well-known/agent.json.
// Content is embedded here rather than read from filesystem (Workers have no FS access).

const SMA_SPEC_MD = `# SMA Protocol v1.0 — Specification

**Version**: 1.0.0  **Status**: Stable  **License**: Apache 2.0

Full specification: https://headlessoracle.com/docs/sma-protocol-repo/SPEC.md

## Receipt Schema

| Field | Type | Description |
|---|---|---|
| mic | string | ISO 10383 Market Identifier Code |
| status | string | OPEN \| CLOSED \| HALTED \| UNKNOWN |
| timestamp | string | ISO 8601 UTC datetime of receipt issuance |
| expires_at | string | ISO 8601 UTC — receipt must not be acted on after this |
| issuer | string | FQDN of the oracle operator (e.g. "headlessoracle.com") |
| key_id | string | Signing key identifier |
| receipt_mode | string | "demo" or "live" |
| schema_version | string | Protocol schema version (e.g. "v5.0") |
| public_key_id | string | Hex-encoded Ed25519 public key |
| signature | string | Hex-encoded Ed25519 signature over canonical payload |

## Status Enum

OPEN — market is in a trading session
CLOSED — market is outside trading hours
HALTED — trading suspended (circuit breaker / operator override)
UNKNOWN — oracle cannot determine state with confidence

Consumers MUST treat UNKNOWN identically to CLOSED.

## TTL

expires_at = timestamp + 60 seconds

Consumers MUST reject receipts where now > expires_at.

## Canonical Payload Construction

1. Take all fields except signature.
2. Sort keys alphabetically (lexicographic, case-sensitive).
3. Serialize to compact JSON (no whitespace).
4. Encode as UTF-8 bytes.

## Signing Algorithm

Algorithm: Ed25519 (RFC 8032)
Input: UTF-8 encoded canonical payload bytes
Output: 64-byte signature, hex-encoded, stored in signature field

## Consumer Requirements

1. Fetch public key via /.well-known/oracle-keys.json
2. Reconstruct canonical payload per above
3. Verify Ed25519 signature before acting on any status field
4. Reject receipts where now > expires_at
5. Treat UNKNOWN as CLOSED
6. Check receipt_mode — reject "demo" for production decisions
7. On timeout or verification failure: default to UNKNOWN (fail closed)

## Changelog

| Version | Date | Notes |
|---|---|---|
| 1.0.0 | 2026-03-17 | Initial stable release |
`;

const APTS_STANDARD_MD = `# Agent Pre-Trade Safety Standard

**Version:** 1.0.0-draft  **Status:** Public Draft  **License:** Apache 2.0

Full standard: https://headlessoracle.com/docs/agent-safety-standard/STANDARD.md

## Abstract

This document defines a minimum pre-trade safety checklist for autonomous AI agents
executing orders on financial exchanges. Vendor-neutral open standard.

## The Six Checks

### Check 1 — Obtain a Signed Market Status Attestation

GET https://headlessoracle.com/v5/status?mic={MIC}
X-Oracle-Key: {api_key}

Fail: unable to reach oracle, non-200, or unparseable response → HALT.

### Check 2 — Verify No Active Circuit Breakers

If source == "OVERRIDE" → HALT (log the reason field).
If source == "SYSTEM" → HALT (treat as UNKNOWN).

### Check 3 — Verify the Settlement Window Is Open

Exchange-level OPEN is necessary but not sufficient. Verify instrument settlement window
separately via broker/exchange API.

### Check 4 — Verify the Oracle Receipt Is Fresh

Reject if expires_at < now. Fetch fresh receipt. If unavailable → HALT.

### Check 5 — Verify the Ed25519 Signature

\`\`\`js
import { verify } from '@headlessoracle/verify';
const { ok, reason } = await verify(receipt);
if (!ok) halt(\`Signature failed: \${reason}\`);
\`\`\`

\`\`\`python
from headless_oracle import verify
result = verify(receipt)
if not result.ok: halt(f"Signature failed: {result.reason}")
\`\`\`

### Check 6 — Halt on Any Failure

On ANY check failure: halt and log. Never fall back to permissive default.

## Conformance

An implementation is conformant if it:
- Obtains a Signed Attestation before each trade decision
- Checks source for OVERRIDE/SYSTEM conditions
- Verifies receipt is not expired
- Cryptographically verifies the Ed25519 signature
- Halts on ANY check failure without permissive fallback
- Logs the outcome of each check for audit

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0-draft | 2026-03-15 | Initial public draft |
`;

const RFC_EXTERNAL_STATE_MD = `# RFC: Verifiable External State Attestation for Autonomous Agent Systems

**Document type**: Informational RFC
**Working group**: Verifiable Intent / Agent Interoperability
**Status**: Draft v1.0
**Date**: March 2026
**Author**: Headless Oracle Project
**License**: Apache 2.0
**Submitted**: 2026-03-17 to https://github.com/agent-intent/verifiable-intent

---

## Abstract

This document defines a protocol for cryptographically attested external state claims consumed by autonomous agent systems. As AI agents increasingly make consequential decisions, they require a trustworthy, independently verifiable ground truth about the state of the external world. This RFC proposes a minimal, composable attestation format and consumption protocol suitable for any external state domain, with market state as the primary reference implementation.

Full RFC: https://github.com/agent-intent/verifiable-intent/pulls
Reference implementation: https://headlessoracle.com/v5/compliance
Stack context: https://headlessoracle.com/v5/stack
`;

const X402_PAYMENTS_MD = `# x402 Micropayments — Headless Oracle

Headless Oracle supports the x402 protocol for per-request USDC micropayments on Base mainnet.
Autonomous agents can pay for API access without a subscription or pre-registered API key.

Guide: https://headlessoracle.com/docs/x402-payments

## When x402 kicks in

Free tier keys (ho_free_*) have a 500 requests/day limit. After the limit:

1. If your account has prepaid credits → one credit is consumed automatically.
2. If X-Payment header is present with a valid Base mainnet USDC transaction → request is fulfilled.
3. Otherwise → HTTP 402 with machine-readable payment instruction.

## The 402 Response

\`\`\`json
{
  "error": "PAYMENT_REQUIRED",
  "x402": {
    "version": "1",
    "scheme": "exact",
    "network": "base-mainnet",
    "chainId": 8453,
    "amount": "1000",
    "currency": "USDC",
    "decimals": 6,
    "paymentAddress": "0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3",
    "usdcContractAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxAge": 300
  }
}
\`\`\`

## Paying with X-Payment header

1. Send 0.001 USDC (1000 units at 6 decimals) to paymentAddress on Base mainnet.
2. Retry the request with X-Payment header:

\`\`\`
X-Payment: {"txHash":"0x...","network":"base-mainnet","amount":"1000","paymentAddress":"0x26D4...","memo":""}
\`\`\`

## Prepaid Credits

POST /v5/credits/purchase — send X-Payment header with bulk USDC payment
GET /v5/credits/balance — check remaining credits

100 credits = 90000 USDC units (0.09 USDC)
1000 credits = 800000 USDC units (0.80 USDC)

## Security Notes

- Transactions expire after 300 seconds
- Each txHash can only be used once (replay protection, 600s TTL)
- Verify paymentAddress before sending funds
`;

const DATACAMP_WORKSPACE_MD = `# Headless Oracle — DataCamp Workspace Integration

Use Headless Oracle in a DataCamp Workspace (Jupyter) notebook to gate financial analysis
on cryptographically verified market state. Every cell that touches live market data should
call \`safe_market_check()\` first — if the market is not OPEN, the analysis halts automatically.

## Setup

Run this cell once at the top of your workspace:

\`\`\`python
# Cell 1 — Install SDK
!pip install headless-oracle
\`\`\`

\`\`\`python
# Cell 2 — Configuration
import os

# Set your Oracle API key.
# In DataCamp Workspaces: Environment → Secrets → add ORACLE_KEY
# Locally: export ORACLE_KEY=your_key_here
ORACLE_KEY = os.environ["ORACLE_KEY"]
ORACLE_BASE = "https://headlessoracle.com"
\`\`\`

## safe_market_check() Pattern

\`\`\`python
# Cell 3 — Market safety gate
from headless_oracle import OracleClient, verify
import pandas as pd
from datetime import datetime, timezone

client = OracleClient(api_key=ORACLE_KEY)

def safe_market_check(mic: str = "XNYS") -> dict:
    """
    Fetch and verify a signed market receipt from Headless Oracle.

    Returns a dict with:
      - safe_to_trade (bool): True only when status is OPEN and signature is valid
      - status (str): OPEN | CLOSED | HALTED | UNKNOWN
      - mic (str): exchange MIC code
      - expires_at (str | None): ISO 8601 UTC expiry of this receipt
      - reason (str): human-readable explanation

    UNKNOWN means the Oracle's signing infrastructure returned an unverifiable state.
    Treat UNKNOWN as CLOSED — do not proceed with analysis that depends on live data.
    """
    try:
        receipt = client.status(mic=mic)
        result  = verify(receipt)

        if not result["valid"]:
            return {
                "safe_to_trade": False,
                "status":        "UNKNOWN",
                "mic":           mic,
                "expires_at":    None,
                "reason":        f"Signature invalid: {result['reason']}",
            }

        is_open = receipt.get("status") == "OPEN"
        return {
            "safe_to_trade": is_open,
            "status":        receipt.get("status", "UNKNOWN"),
            "mic":           mic,
            "expires_at":    receipt.get("expires_at"),
            "reason":        "Verified OPEN." if is_open else f"Market is {receipt.get('status')} — halting analysis.",
        }
    except Exception as exc:
        return {
            "safe_to_trade": False,
            "status":        "UNKNOWN",
            "mic":           mic,
            "expires_at":    None,
            "reason":        f"Oracle error: {exc}",
        }
\`\`\`

## Full Notebook Cell Sequence — Safe Market Analysis

\`\`\`python
# Cell 4 — Run safety check before any live-data analysis
gate = safe_market_check("XNYS")
print(f"[{gate['mic']}] {gate['status']} — safe_to_trade={gate['safe_to_trade']}")
print(f"  Reason   : {gate['reason']}")
print(f"  Expires  : {gate['expires_at']}")

if not gate["safe_to_trade"]:
    raise SystemExit(f"Market gate failed: {gate['reason']}. Analysis halted.")
\`\`\`

\`\`\`python
# Cell 5 — Build a summary DataFrame (only reached when market is OPEN)
# Replace the data source below with your own: yfinance, DataCamp datasets, CSV, etc.

import yfinance as yf  # or any data source you use in DataCamp

tickers = ["AAPL", "MSFT", "GOOGL"]
data    = yf.download(tickers, period="5d", interval="1d", auto_adjust=True)["Close"]

summary = pd.DataFrame({
    "ticker":    tickers,
    "last_close": [data[t].iloc[-1] for t in tickers],
    "5d_change":  [(data[t].iloc[-1] / data[t].iloc[0] - 1) * 100 for t in tickers],
    "oracle_verified_at": gate["expires_at"],
})

summary
\`\`\`

\`\`\`python
# Cell 6 — Multi-exchange batch check (optional)
# Check all supported markets at once before a multi-region analysis (23 available — pick yours)

mics = ["XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"]
rows = []
for mic in mics:
    g = safe_market_check(mic)
    rows.append(g)

status_df = pd.DataFrame(rows)[["mic", "status", "safe_to_trade", "reason", "expires_at"]]
print(status_df.to_string(index=False))

# Halt if any exchange you need is not OPEN
required = {"XNYS", "XLON"}
unsafe   = {r["mic"] for r in rows if r["mic"] in required and not r["safe_to_trade"]}
if unsafe:
    raise SystemExit(f"Required exchanges not OPEN: {unsafe}. Analysis halted.")
\`\`\`

## Important

- **Always run \`safe_market_check()\` before cells that fetch or act on live prices.**
  Market data fetched outside trading hours may be stale, delayed, or from a prior session.
- **The receipt expires in 60 seconds.** Do not cache the result across cells; call
  \`safe_market_check()\` at each decision point in a long-running notebook.
- **UNKNOWN is not a soft signal.** An UNKNOWN status means the Oracle could not produce
  a cryptographically verified receipt. Treat it as CLOSED and halt the cell.
- **Use \`raise SystemExit(...)\`** rather than a conditional skip — it stops all subsequent
  cells from running automatically, which is the correct fail-closed behaviour in a notebook.

## Links

- Python SDK: \`pip install headless-oracle\` — [PyPI](https://pypi.org/project/headless-oracle/)
- API docs: https://headlessoracle.com/docs
- Supported exchanges: https://headlessoracle.com/v5/exchanges
- Get a free API key: https://headlessoracle.com/v5/keys/request
`;

const BUN_MD = `# Bun Integration

Use Headless Oracle in a Bun TypeScript runtime: fetch and verify signed receipts with native \`fetch\`, gate a \`Bun.serve()\` webhook on market status, and schedule periodic checks with a cron-style pattern. \`@headlessoracle/verify\` uses the Web Crypto API which Bun provides natively — no polyfills required.

## Prerequisites

\`\`\`bash
bun add @headlessoracle/verify
\`\`\`

## Complete Example

\`\`\`typescript
// oracle-gate.ts
import { verify } from "@headlessoracle/verify";

const ORACLE_BASE = "https://headlessoracle.com";
const ORACLE_KEY = Bun.env.ORACLE_KEY!;

// Cache the public key after first fetch to avoid a network round-trip per receipt.
// The key at /v5/keys rotates infrequently — safe to hold in memory for a process lifetime.
let cachedPublicKey: string | null = null;

async function getPublicKey(): Promise<string> {
  if (cachedPublicKey) return cachedPublicKey;
  const res = await fetch(\`\${ORACLE_BASE}/v5/keys\`);
  const data = await res.json() as { keys: Array<{ public_key: string }> };
  cachedPublicKey = data.keys[0].public_key;
  return cachedPublicKey;
}

interface OracleResult {
  mic: string;
  status: string;
  safeToTrade: boolean;
  reason: string;
  expiresAt: string | null;
}

export async function checkMarket(mic: string): Promise<OracleResult> {
  try {
    const res = await fetch(\`\${ORACLE_BASE}/v5/status?mic=\${mic}\`, {
      headers: { "X-Oracle-Key": ORACLE_KEY },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { mic, status: "UNKNOWN", safeToTrade: false,
               reason: \`HTTP \${res.status}\`, expiresAt: null };
    }

    const receipt = await res.json() as Record<string, unknown>;
    const publicKey = await getPublicKey();

    // Pass the cached key — skips the /v5/keys fetch inside verify()
    const result = await verify(receipt, { publicKey });

    if (!result.valid) {
      return { mic, status: "UNKNOWN", safeToTrade: false,
               reason: \`Verification failed: \${result.reason}\`, expiresAt: null };
    }

    const isOpen = receipt.status === "OPEN";
    return {
      mic,
      status: receipt.status as string,
      safeToTrade: isOpen,
      reason: isOpen ? "Verified OPEN." : \`Market is \${receipt.status}.\`,
      expiresAt: receipt.expires_at as string,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { mic, status: "UNKNOWN", safeToTrade: false,
             reason: \`Error: \${message}\`, expiresAt: null };
  }
}


// --- Webhook server: gate trade signals on market status ---

const server = Bun.serve({
  port: 3000,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/trade-signal") {
      const body = await req.json() as { mic: string; symbol: string; action: string };
      const { mic, symbol, action } = body;

      // Gate every incoming trade signal on live Oracle check
      const oracle = await checkMarket(mic);

      if (!oracle.safeToTrade) {
        return Response.json(
          { accepted: false, reason: oracle.reason, mic, oracle_status: oracle.status },
          { status: 422 }
        );
      }

      // Market is verified OPEN — process the signal
      console.log(\`[trade] \${action} \${symbol} on \${mic} — Oracle verified OPEN\`);
      return Response.json({ accepted: true, mic, oracle_status: oracle.status });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const oracle = await checkMarket("XNYS");
      return Response.json({ oracle });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(\`Webhook server listening on http://localhost:\${server.port}\`);


// --- Scheduled market check (cron-style) ---
// Bun does not have a built-in cron scheduler; use setInterval for periodic checks.
// For production, prefer a Cloudflare Worker Cron or system cron calling this endpoint.

const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

const MICs = ["XNYS", "XNAS", "XLON"] as const;

async function scheduledMarketCheck() {
  console.log(\`[cron] Running market status check for \${MICs.join(", ")}\`);
  for (const mic of MICs) {
    const result = await checkMarket(mic);
    if (!result.safeToTrade) {
      console.warn(\`[cron] HALT signal: \${mic} — \${result.reason}\`);
      // Emit to your alerting system here (e.g. webhook, Slack, PagerDuty)
    } else {
      console.log(\`[cron] \${mic} OPEN — verified until \${result.expiresAt}\`);
    }
  }
}

// Run immediately on startup, then on interval
scheduledMarketCheck();
setInterval(scheduledMarketCheck, CHECK_INTERVAL_MS);
\`\`\`

Run with:

\`\`\`bash
bun run oracle-gate.ts
\`\`\`

## Important

- **Cache the public key, not the receipt.** The public key is stable across a process lifetime. The receipt expires in 60 seconds and must never be cached or reused between requests.
- **\`AbortSignal.timeout(5000)\` is Bun-native.** It works without any polyfill. On timeout, \`checkMarket\` returns \`safeToTrade: false\` — fail-closed.
- **Return \`422 Unprocessable Entity\` (not \`200\`) for rejected signals.** A 200 response with \`accepted: false\` in the body is ambiguous for agent callers. A 4xx status is deterministic.
`;

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
> Cryptographically signed, fail-closed market-state receipts for AI agents. Ed25519-signed. 23 global exchanges.

## What this is
Headless Oracle provides cryptographically signed market-state attestations (Signed Market Attestations, SMAs) for 23 global stock exchanges. Every receipt is Ed25519-signed, expires after 60 seconds, and is fail-closed: UNKNOWN or HALTED status MUST prevent agent execution.

## When to use this
- Before executing any trade, payment, or financial action on a stock exchange
- Before routing an order to any venue that could be closed, halted, or in a settlement window
- When receiving a receipt from another agent and needing to verify it was genuinely issued by this oracle
- When scheduling market-hours-dependent workflows (cron, webhooks, batch jobs)
- When aggregating multi-exchange status before a portfolio-level action (use /v5/batch)
- When subscribing to state-change events to avoid polling (use /v5/webhooks/subscribe)

## Quick start (no signup required)
# Get an instant sandbox key (24h, 100 calls):
GET https://api.headlessoracle.com/v5/sandbox

# Use it immediately:
GET https://api.headlessoracle.com/v5/status?mic=XNYS
Header: X-Oracle-Key: {your_sandbox_key}

# Verify the public key:
GET https://api.headlessoracle.com/v5/keys

# Demo (signed receipt, no key needed):
GET https://api.headlessoracle.com/v5/demo?mic=XNYS

## Authentication
- Free key (500 req/day): POST https://headlessoracle.com/v5/keys/request
- Sandbox key (instant, 100 calls, no signup): GET https://headlessoracle.com/v5/sandbox
- Paid key: https://headlessoracle.com/pricing
- Header: X-Oracle-Key: {your_key}
- Without key: demo endpoint works; /v5/status returns 402 with x402 payment object

## Endpoints
| Endpoint | Method | Auth | Description | Returns |
|---|---|---|---|---|
| /v5/demo | GET | No | Signed receipt, demo mode | SMA receipt (receipt_mode=demo) |
| /v5/status | GET | Yes | Signed receipt, live mode | SMA receipt (receipt_mode=live) |
| /v5/batch | GET | Yes | Signed receipts for multiple MICs | { summary, receipts[] } |
| /v5/sandbox | GET | No | Instant sandbox key (24h, 100 calls) | { api_key, tier, expires_at, quickstart } |
| /v5/schedule | GET | No | Next open/close times (not signed) | { next_open, next_close, lunch_break } |
| /v5/exchanges | GET | No | All 23 supported exchanges | { exchanges: [{mic, name, timezone}] } |
| /v5/keys | GET | No | Public signing key + canonical spec | { keys: [{key_id, public_key, algorithm}] } |
| /v5/health | GET | No | Signed liveness probe | SMA-format health receipt |
| /v5/usage | GET | Yes | Per-key daily usage stats | { requests_today, limit, percent_used } |
| /v5/traction | GET | No | Live metrics snapshot | { exchanges_covered, mcp_requests_today, ... } |
| /v5/receipts | GET | Builder+ | Receipt audit log | { receipts: [{mic, status, issued_at}] } |
| /v5/webhooks/subscribe | POST | Yes | Subscribe to state-change webhooks | { subscription_id } |
| /v5/webhooks/unsubscribe | DELETE | Yes | Remove webhook subscription | { ok: true } |
| /mcp | POST | No (optional Bearer) | MCP Streamable HTTP (JSON-RPC 2.0) | JSON-RPC response |
| /openapi.json | GET | No | OpenAPI 3.1 machine-readable spec | OpenAPI document |
| /.well-known/oracle-keys.json | GET | No | RFC 8615 key discovery | Key lifecycle metadata |
| /.well-known/agent.json | GET | No | A2A Agent Card | A2A agent capabilities |
| /.well-known/mcp/server-card.json | GET | No | MCP server card | Tool list, reliability, coverage |
| /v5/errors/{code} | GET | No | Machine-readable error definition | { message, resolution, http_status } |

## Receipt schema
\`\`\`json
{
  "receipt_id":     "uuid",
  "mic":            "XNYS",
  "status":         "OPEN | CLOSED | HALTED | UNKNOWN",
  "issued_at":      "2026-03-22T15:00:00.000Z",
  "expires_at":     "2026-03-22T15:01:00.000Z",
  "issuer":         "headlessoracle.com",
  "source":         "SCHEDULE | OVERRIDE | REALTIME | SYSTEM",
  "schema_version": "v5.0",
  "receipt_mode":   "demo | live",
  "public_key_id":  "key_2026_v1",
  "signature":      "<hex-encoded Ed25519 signature>"
}
\`\`\`

## Verification
Ed25519 signature verification (pseudocode):
1. Receive receipt JSON
2. Extract all fields EXCEPT "signature" -> payload object
3. Sort payload keys alphabetically
4. JSON.stringify(sortedPayload) with no whitespace -> canonical string
5. Verify signature (hex) against canonical string using public key from /v5/keys
6. Check expires_at > now (60s TTL)
7. Check status === "OPEN" before proceeding
If any step fails -> halt execution

SDK: npm install @headlessoracle/verify (zero deps, Web Crypto)

## Exchanges covered
XNYS (NYSE, America/New_York)
XNAS (NASDAQ, America/New_York)
XLON (London, Europe/London)
XJPX (Tokyo, Asia/Tokyo)
XPAR (Paris, Europe/Paris)
XHKG (Hong Kong, Asia/Hong_Kong)
XSES (Singapore, Asia/Singapore)
XASX (Sydney, Australia/Sydney)
XBOM (Mumbai BSE, Asia/Kolkata)
XNSE (Mumbai NSE, Asia/Kolkata)
XSHG (Shanghai, Asia/Shanghai)
XSHE (Shenzhen, Asia/Shanghai)
XKRX (Seoul, Asia/Seoul)
XJSE (Johannesburg, Africa/Johannesburg)
XBSP (Sao Paulo, America/Sao_Paulo)
XSWX (Zurich, Europe/Zurich)
XMIL (Milan, Europe/Rome)
XIST (Istanbul, Europe/Istanbul)
XSAU (Riyadh, Asia/Riyadh) -- Fri/Sat weekends
XDFM (Dubai, Asia/Dubai) -- Fri/Sat weekends
XNZE (Auckland, Pacific/Auckland)
XHEL (Helsinki, Europe/Helsinki)
XSTO (Stockholm, Europe/Stockholm)

## Fail-closed guarantee
UNKNOWN status means the oracle cannot determine market state (signing offline, missing holiday data, unknown year). Agents MUST treat UNKNOWN as CLOSED and halt. This is not optional. HALTED means a circuit breaker or operator override is active -- also treat as CLOSED. The absence of a valid signed receipt is itself proof of unsafety.

## Pricing
- Free: 500 req/day (GET /v5/keys/request)
- Sandbox: 100 req/24h, instant, no signup (GET /v5/sandbox)
- x402: 0.001 USDC/req via Base mainnet (no key needed)
- Builder: 50,000 req/day ($99/mo)
- Pro: 200,000 req/day ($299/mo)
- Protocol: unlimited ($500/mo)
Upgrade: https://headlessoracle.com/pricing

## MCP integration
Server card: GET https://headlessoracle.com/.well-known/mcp/server-card.json
Protocol: MCP-2024-11-05
Endpoint: POST https://headlessoracle.com/mcp
Tools: get_market_status, get_market_schedule, list_exchanges, verify_receipt
Auth: optional Bearer token (Oracle API key via POST /oauth/token)
`

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
| Computing UTC offsets | Detecting exchange holiday closures (200+ across 23 venues) |
| Formatting timestamps | Handling unscheduled circuit breaker halts |
| Scheduling calendar events | Detecting early close days |
| Building a world clock | Lunch break windows (XJPX, XHKG, XSHG, XSHE) |
| Converting between timezones | DST correctness across 23 separate exchange calendars |
| Checking if an office is open | Cryptographic proof that you checked before executing |
| | Fail-closed UNKNOWN when state cannot be determined |

**Rule of thumb**: If your code makes financial execution decisions based on time, a timezone library is necessary but not sufficient. You need attestable market state, not computable clock time. Across all 23 exchanges, approximately 5,000+ schedule edge cases per year require explicit handling beyond UTC offset arithmetic.

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
| \`list_exchanges\` | All 23 supported exchanges with names and timezones | none |

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
- \`GET /v5/compliance\` — APTS v1.0 compliance self-report (6 pre-trade safety checks)
- \`POST /v5/keys/request\` — free tier key self-provisioning (no payment required)

---

## Compliance Standards

Headless Oracle conforms to two open standards. Agents can verify conformance programmatically:

**Agent Pre-Trade Safety Standard (APTS) v1.0** — 6 pre-trade checks every autonomous agent should perform before execution. Check: \`GET /v5/compliance\` returns all 6 with \`status: "pass"\`.

**Signed Market Attestation (SMA) Protocol v1.0** — vendor-neutral format for cryptographically attested market state. All receipts are SMA-compliant: alphabetically-sorted compact JSON signed with Ed25519.

SMA conformance means: any independent verifier with the public key can validate receipts without calling Oracle again.
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

// agent.json — A2A Agent Card (google.github.io/A2A/spec/) + Oracle-specific extensions.
// A2A-required fields appear first; Oracle extensions follow as non-standard additions.
// Additive only — existing consumers see a strict superset of the previous structure.
// spec_version removed: DEPLOY_DATE resolved to epoch (Date.now()=0 at Workers module init).
const AGENT_JSON = {
	// ── A2A AgentCard required/recommended fields ─────────────────────────────
	name:           'Headless Oracle',
	version:        'v5.0',
	description:    'Autonomous agents execute trades and payments during market closures, circuit breaker halts, and DST transitions without knowing it — this oracle provides cryptographically signed market-state receipts so agents can gate execution on confirmed open markets.',
	url:            'https://headlessoracle.com',
	provider: {
		organization: 'LembaGang',
		url:          'https://headlessoracle.com',
	},
	documentationUrl:    'https://headlessoracle.com/docs',
	// A2A capabilities object — streaming/push/history are all false (pure request/response).
	capabilities: {
		streaming:              false,
		pushNotifications:      false,
		stateTransitionHistory: false,
	},
	authentication: {
		schemes:     ['bearer', 'apiKey', 'x402'],
		credentials: 'https://headlessoracle.com/v5/keys/request',
	},
	defaultInputModes:  ['application/json'],
	defaultOutputModes: ['application/json'],
	skills: [
		{
			id:          'get_market_status',
			name:        'Get Market Status',
			description: 'Returns a cryptographically signed receipt for one exchange: OPEN, CLOSED, HALTED, or UNKNOWN. Ed25519-signed, 60-second TTL. Treat UNKNOWN as CLOSED — halt all execution.',
			tags:        ['finance', 'market-data', 'safety', 'signed-receipt', 'fail-closed'],
			examples:    ['Is NYSE open right now?', 'Verify XLON is trading before executing this payment'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'get_market_schedule',
			name:        'Get Market Schedule',
			description: 'Returns next open and close times in UTC for a given exchange, including lunch break windows and 2026–2027 holiday coverage.',
			tags:        ['finance', 'schedule', 'market-hours'],
			examples:    ['When does Tokyo Stock Exchange open next?', 'What are XJPX trading hours?'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'list_exchanges',
			name:        'List Exchanges',
			description: 'Returns all 23 supported exchanges with MIC codes, names, and timezones. Use to discover supported markets before calling get_market_status.',
			tags:        ['finance', 'exchange-directory'],
			examples:    ['Which exchanges does this oracle cover?'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'verify_receipt',
			name:        'Verify Receipt Signature',
			description: 'Verifies an Ed25519-signed receipt against the Headless Oracle public key. Allows downstream agents to independently confirm receipt authenticity without trusting the caller.',
			tags:        ['finance', 'verification', 'cryptography', 'trust'],
			examples:    ['Verify this market receipt before processing the payment'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'get_sandbox_key',
			name:        'Get Sandbox Key',
			description: 'Get an instant 24-hour API key with 100 calls. No signup. Start calling /v5/status immediately.',
			endpoint:    '/v5/sandbox',
			method:      'GET',
			auth:        false,
			input:       {},
			output:      {
				type:       'object',
				properties: {
					api_key:         { type: 'string', description: 'Sandbox API key (sb_ prefix)' },
					tier:            { type: 'string', enum: ['sandbox'] },
					expires_at:      { type: 'string', format: 'date-time' },
					calls_remaining: { type: 'integer' },
				},
			},
		},
	],

	// ── Oracle-specific extensions ────────────────────────────────────────────
	// fail_closed promoted to top level — explicit signal for any consuming agent.
	fail_closed:         true,
	supported_exchanges: [
		'XNYS', 'XNAS', 'XBSP', 'XLON', 'XPAR', 'XSWX', 'XMIL', 'XHEL', 'XSTO',
		'XIST', 'XSAU', 'XDFM', 'XJSE', 'XSHG', 'XSHE', 'XHKG', 'XJPX', 'XKRX',
		'XBOM', 'XNSE', 'XSES', 'XASX', 'XNZE',
	],
	input_schema: {
		type:       'object',
		properties: {
			mic: {
				type:        'string',
				description: 'ISO 10383 Market Identifier Code',
				examples:    ['XNYS', 'XLON', 'XJPX'],
			},
		},
		required: ['mic'],
	},
	output_schema: {
		type:       'object',
		properties: {
			mic:            { type: 'string' },
			status:         { type: 'string', enum: ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'] },
			timestamp:      { type: 'string', format: 'date-time' },
			expires_at:     { type: 'string', format: 'date-time', description: 'Receipt invalid after this time. Re-fetch required.' },
			issuer:         { type: 'string', example: 'headlessoracle.com' },
			key_id:         { type: 'string', example: 'key_2026_v1' },
			receipt_mode:   { type: 'string', enum: ['demo', 'live'] },
			schema_version: { type: 'string', example: 'v5.0' },
			signature:      { type: 'string', description: 'Hex-encoded Ed25519 signature over canonical payload (alphabetical key sort, compact JSON)' },
		},
		required: ['mic', 'status', 'timestamp', 'expires_at', 'issuer', 'key_id', 'receipt_mode', 'schema_version', 'signature'],
	},
	endpoints: {
		mcp:        'https://headlessoracle.com/mcp',
		rest:       'https://headlessoracle.com/v5/status',
		oauth:      'https://headlessoracle.com/oauth/token',
		introspect: 'https://headlessoracle.com/oauth/introspect',
		openapi:    'https://headlessoracle.com/openapi.json',
	},

	// ── Retained Oracle-specific blocks (existing consumers see unchanged fields) ──
	payment: {
		schemes:               ['x402'],
		network:               'base-mainnet',
		chain_id:              8453,
		currency:              'USDC',
		amount_per_request:    '0.001',
		payment_address_env:   'ORACLE_PAYMENT_ADDRESS',
		free_tier_daily_limit: FREE_TIER_DAILY_LIMIT,
	},
	standards: {
		sma_version:           '1.0',
		apts_version:          '1.0',
		sma_spec:              'https://github.com/LembaGang/sma-protocol',
		apts_spec:             'https://github.com/LembaGang/agent-pretrade-safety-standard',
		verifiable_intent_rfc: 'https://github.com/agent-intent/verifiable-intent/pulls',
	},
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
			{ path: '/mics.json',             method: 'GET',  auth: false, description: 'All 23 supported MICs with exchange metadata and ISO 20022 registry links' },
			{ path: '/v5/keys',               method: 'GET',  auth: false, description: 'Public key registry + canonical payload spec' },
			{ path: '/v5/health',             method: 'GET',  auth: false, description: 'Signed liveness probe' },
			{ path: '/.well-known/oracle-keys.json', method: 'GET', auth: false, description: 'RFC 8615 key discovery' },
			{ path: '/v5/compliance',               method: 'GET', auth: false, description: 'APTS compliance self-report — 6 pre-trade safety checks' },
			{ path: '/v5/metrics',                  method: 'GET', auth: false, description: 'MCP client telemetry — today\'s request and unique client counts' },
			{ path: '/v5/traction',                 method: 'GET', auth: false, description: 'Live traction metrics — exchanges, uptime, MCP usage, stack positioning' },
			{ path: '/v5/usage',                    method: 'GET', auth: true,  description: 'Per-key usage stats — requests today/month, limits, credits, upgrade info' },
		],
		auth: {
			header:           'X-Oracle-Key',
			missing:          401,
			invalid:          403,
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

// Shape of daily MCP client aggregates stored in ORACLE_TELEMETRY KV.
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
			'Returns a cryptographically signed Ed25519 receipt stating whether a stock exchange is OPEN, CLOSED, HALTED, or UNKNOWN. ' +
			'WHEN TO USE: call this before executing any trade, payment, or market-dependent workflow on a specific exchange. ' +
			'RETURNS: { receipt_id: string, mic: string, status: "OPEN"|"CLOSED"|"HALTED"|"UNKNOWN", issued_at: ISO8601, expires_at: ISO8601, issuer: string, source: "SCHEDULE"|"OVERRIDE"|"REALTIME"|"SYSTEM", schema_version: "v5.0", receipt_mode: "live"|"demo", public_key_id: string, signature: string (hex Ed25519) }. ' +
			'FAILURE BEHAVIOUR: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately. Do not act on a receipt where expires_at is in the past (TTL = 60s). ' +
			'LATENCY: sub-200ms p95 from Cloudflare edge. ' +
			'Covers 23 global exchanges: XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Tokyo), XPAR (Paris), XHKG (Hong Kong), XSES (Singapore), XASX (Sydney), XBOM (Mumbai BSE), XNSE (Mumbai NSE), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Seoul), XJSE (Johannesburg), XBSP (São Paulo), XSWX (Zurich), XMIL (Milan), XIST (Istanbul), XSAU (Riyadh), XDFM (Dubai), XNZE (Auckland), XHEL (Helsinki), XSTO (Stockholm).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'ISO 10383 Market Identifier Code. Required. Examples: XNYS=NYSE, XNAS=NASDAQ, XLON=London, XJPX=Tokyo. ' +
						'Call list_exchanges to discover all 23 supported codes.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO'],
				},
			},
		},
	},
	{
		name: 'get_market_schedule',
		description:
			'Returns the next open and close UTC timestamps for a stock exchange. ' +
			'WHEN TO USE: call this to plan trade execution windows, schedule market-dependent tasks, check session times, or determine how long until a market opens. ' +
			'RETURNS: { mic: string, name: string, timezone: string (IANA), queried_at: ISO8601, current_status: "OPEN"|"CLOSED"|"UNKNOWN", next_open: ISO8601|null, next_close: ISO8601|null, lunch_break: { start: "HH:MM", end: "HH:MM" }|null, data_coverage_years: string[] }. ' +
			'FAILURE BEHAVIOUR: NOT cryptographically signed. Does not reflect real-time halts, circuit breakers, or KV overrides. For authoritative signed status use get_market_status instead. ' +
			'LATENCY: sub-100ms p95 (pure schedule computation, no signing). ' +
			'Includes lunch break windows for Tokyo (XJPX: 11:30–12:30 JST), Hong Kong (XHKG: 12:00–13:00 HKT), Shanghai (XSHG: 11:30–13:00 CST), Shenzhen (XSHE: 11:30–13:00 CST).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'ISO 10383 Market Identifier Code. Defaults to XNYS (NYSE). ' +
						'Call list_exchanges to see all 23 supported codes.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO'],
				},
			},
		},
	},
	{
		name: 'list_exchanges',
		description:
			'Returns all 23 stock exchanges supported by Headless Oracle with their MIC codes, names, and IANA timezones. ' +
			'WHEN TO USE: call this once at agent startup to discover supported markets before calling get_market_status or get_market_schedule. ' +
			'RETURNS: { exchanges: Array<{ mic: string, name: string, timezone: string }> } — 23 entries. ' +
			'FAILURE BEHAVIOUR: pure static data, no signing, no failure modes. Always returns 200. ' +
			'LATENCY: sub-50ms p95.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: 'verify_receipt',
		description:
			'Verifies the Ed25519 cryptographic signature on a Headless Oracle signed receipt. ' +
			'WHEN TO USE: call this when you receive a receipt from another agent or upstream system and must confirm it was genuinely issued by Headless Oracle and has not been tampered with or expired. ' +
			'RETURNS: { valid: boolean, expired: boolean, reason: "signature_valid"|"MISSING_FIELDS"|"EXPIRED"|"INVALID_SIGNATURE"|"ORACLE_NOT_CONFIGURED"|"MALFORMED_RECEIPT"|"VERIFY_ERROR", mic: string|null, status: string|null, expires_at: string|null }. ' +
			'FAILURE BEHAVIOUR: valid=false MUST be treated as an untrusted receipt — do not act on any data from it. A receipt can be valid=true but expired=true (past TTL) — re-fetch if expired. ' +
			'LATENCY: sub-50ms p95 (in-worker Ed25519 verification, no network calls).',
		inputSchema: {
			type: 'object',
			properties: {
				receipt: {
					type:        'object',
					description: 'The complete signed receipt object as returned by get_market_status or /v5/status. Must include the signature field (hex-encoded Ed25519).',
				},
			},
			required: ['receipt'],
		},
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
				enum: ['SCHEDULE', 'OVERRIDE', 'SYSTEM', 'REALTIME'],
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
						content: { 'application/json': { schema: { type: 'object', required: ['receipt_id', 'issued_at', 'expires_at', 'status', 'source', 'public_key_id', 'signature', 'exchange_count', 'supported_mics'], properties: { receipt_id: { type: 'string', format: 'uuid' }, issued_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['OK'] }, source: { type: 'string', enum: ['SYSTEM'] }, public_key_id: { type: 'string' }, signature: { type: 'string' }, exchange_count: { type: 'integer', example: 23, description: 'Number of exchanges currently configured (unsigned).' }, supported_mics: { type: 'array', items: { type: 'string' }, example: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO'], description: 'List of supported MIC codes (unsigned).' } } } } },
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
				description: 'Static JSON array of all 23 supported exchanges. Each entry carries: ' +
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
		'/v5/metrics': {
			get: {
				summary:     'Public usage stats',
				description: 'Returns today\'s MCP request totals and unique client count from ORACLE_TELEMETRY KV. No authentication required. Metrics are best-effort — KV unavailability returns zeros rather than 500.',
				responses: {
					'200': {
						description: 'Usage statistics',
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['total_mcp_requests_today', 'unique_mcp_clients_today', 'exchanges_covered', 'edge_cases_per_year', 'uptime_status'],
							properties: {
								total_mcp_requests_today: { type: 'integer', description: 'Sum of all MCP request_count values for today.' },
								unique_mcp_clients_today: { type: 'integer', description: 'Distinct MCP client IPs seen today (hashed).' },
								exchanges_covered:        { type: 'integer', example: 23 },
								edge_cases_per_year:      { type: 'integer', example: 1319 },
								uptime_status:            { type: 'string', enum: ['operational'] },
							},
						} } },
					},
				},
			},
		},
		'/v5/keys/request': {
			post: {
				summary:     'Provision a free-tier API key',
				description: 'Generates a ho_free_ prefixed API key and emails it to the provided address. Rate-limited to 3 requests per IP per 24 hours. No authentication required.',
				requestBody: {
					required: true,
					content:  { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } },
				},
				responses: {
					'200': { description: 'Key sent to email', content: { 'application/json': { schema: { type: 'object', properties: { plan: { type: 'string', example: 'free' }, message: { type: 'string' } } } } } },
					'400': { description: 'Invalid or missing email', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'405': { description: 'Method not allowed — use POST', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'429': { description: 'Rate limited — max 3 free keys per day per IP', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/compliance': {
			get: {
				summary:     'APTS compliance declaration',
				description: 'Machine-readable proof that Headless Oracle satisfies the Agent Pre-Trade Safety Standard v1.0. ' +
					'All 6 APTS checks documented with evidence. No authentication required. ' +
					'Suitable for CI pipelines and MCP evaluation tools.',
				responses: {
					'200': {
						description: 'Compliance document',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								standard:      { type: 'string', example: 'Agent Pre-Trade Safety Standard v1.0' },
								oracle:        { type: 'string' },
								version:       { type: 'string' },
								last_verified: { type: 'string', format: 'date-time' },
								checks: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail'] }, evidence: { type: 'string' } } } },
							},
						} } },
					},
				},
			},
		},
		'/v5/stack': {
			get: {
				summary:     'Autonomous finance stack positioning',
				description: 'Returns the three-layer autonomous finance stack showing where Headless Oracle fits: ' +
					'Authorization (Verifiable Intent), Execution (BVNK), and Verification (Headless Oracle SMA). ' +
					'No authentication required.',
				responses: {
					'200': {
						description: 'Stack positioning document',
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['stack', 'description', 'reference_implementation'],
							properties: {
								stack: {
									type: 'object',
									required: ['layer_1', 'layer_2', 'layer_3'],
									properties: {
										layer_1: {
											type: 'object',
											required: ['name', 'standard', 'url'],
											properties: {
												name:     { type: 'string', example: 'Authorization' },
												standard: { type: 'string', example: 'Mastercard Verifiable Intent' },
												url:      { type: 'string', format: 'uri', example: 'https://verifiableintent.dev' },
											},
										},
										layer_2: {
											type: 'object',
											required: ['name', 'standard', 'url'],
											properties: {
												name:     { type: 'string', example: 'Execution' },
												standard: { type: 'string', example: 'BVNK Layer1 / Mastercard' },
												url:      { type: 'string', format: 'uri', example: 'https://bvnk.com' },
											},
										},
										layer_3: {
											type: 'object',
											required: ['name', 'standard', 'url'],
											properties: {
												name:       { type: 'string', example: 'Verification' },
												standard:   { type: 'string', example: 'Headless Oracle SMA Protocol v1.0' },
												url:        { type: 'string', format: 'uri', example: 'https://headlessoracle.com' },
												rfc:        { type: 'string', format: 'uri' },
												compliance: { type: 'string', format: 'uri' },
											},
										},
									},
								},
								description:              { type: 'string' },
								reference_implementation: { type: 'string', format: 'uri', example: 'https://headlessoracle.com/v5/compliance' },
							},
						} } },
					},
				},
			},
		},
		'/v5/usage': {
			get: {
				summary:     'Per-key usage statistics',
				description: 'Returns today/month request counts, free tier limits, credit balance, and upgrade info for the authenticated key. Requires X-Oracle-Key header. Paid keys return null limits and 0 usage counts.',
				security: [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Usage statistics for the calling key',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								key_prefix:           { type: 'string' },
								plan:                 { type: 'string' },
								requests_today:       { type: 'integer' },
								requests_this_month:  { type: 'integer' },
								daily_limit:          { type: ['integer', 'null'] },
								monthly_limit:        { type: ['integer', 'null'] },
								percent_used_today:   { type: 'number' },
								percent_used_month:   { type: 'number' },
								rate_limit_resets_at: { type: 'string', format: 'date-time' },
								upgrade_url:          { type: 'string', format: 'uri' },
								x402_available:       { type: 'boolean' },
								x402_amount:          { type: 'string' },
								credit_balance:       { type: 'integer' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/traction': {
			get: {
				summary:     'Live traction metrics',
				description: 'Public endpoint returning exchanges covered, uptime, today\'s MCP usage, and stack positioning. No authentication required. Suitable for investor and partner check-ins.',
				responses: {
					'200': {
						description: 'Traction metrics',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								exchanges_covered:        { type: 'integer', example: 23 },
								edge_cases_per_year:      { type: 'integer', example: 1319 },
								uptime_since:             { type: 'string', format: 'date-time' },
								days_live:                { type: 'integer' },
								mcp_requests_today:       { type: 'integer' },
								unique_mcp_clients_today: { type: 'integer' },
								sma_spec_version:         { type: 'string', example: '1.0' },
								verifiable_intent_rfc:    { type: 'string', example: 'submitted' },
								x402_enabled:             { type: 'boolean' },
								halt_monitor:             { type: 'string', example: 'active' },
							},
						} } },
					},
				},
			},
		},
		'/v5/sandbox': {
			get: {
				tags:        ['Authentication'],
				summary:     'Instant 24-hour sandbox API key — no signup required',
				description: 'Generates a temporary API key valid for 24 hours and 100 calls. No authentication required. ' +
					'Use for integration testing, demos, and evaluating Headless Oracle before committing to a free tier key. ' +
					'Sandbox keys are rejected by /v5/receipts and /v5/webhooks/subscribe (paid features). ' +
					'Rate limited to 10 keys per IP per hour.',
				parameters: [],
				responses: {
					'200': {
						description: 'Sandbox key issued',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								api_key:         { type: 'string', example: 'sb_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' },
								tier:            { type: 'string', enum: ['sandbox'] },
								expires_at:      { type: 'string', format: 'date-time' },
								calls_remaining: { type: 'integer', example: 100 },
								upgrade:         { type: 'string', example: 'https://headlessoracle.com/pricing' },
								quickstart: {
									type: 'object',
									properties: {
										curl:   { type: 'string' },
										node:   { type: 'string' },
										python: { type: 'string' },
									},
								},
							},
						} } },
					},
					'429': {
						description: 'IP rate limit exceeded — max 10 sandbox keys per hour',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								error:   { type: 'string', example: 'SANDBOX_RATE_LIMIT' },
								message: { type: 'string' },
								upgrade: { type: 'string' },
							},
						} } },
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

// ─── OAuth 2.0 Token Endpoint ────────────────────────────────────────────────
// RFC 6749 §4.4 Client Credentials Grant.
// client_id = existing Oracle API key; client_secret = same value (no separate secret).
// Issues a short-lived opaque access token stored in ORACLE_API_KEYS KV ('oauth:' prefix).
// Completely isolated — does not share code paths with any existing route.
async function handleOAuthToken(request: Request, env: Env): Promise<Response> {
	const oauthHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
	const oauthError = (status: number, error: string, description: string) =>
		new Response(JSON.stringify({ error, error_description: description }), { status, headers: oauthHeaders });

	if (request.method !== 'POST') return oauthError(405, 'invalid_request', 'POST required');

	let params: URLSearchParams;
	try {
		const body = await request.text();
		params = new URLSearchParams(body);
	} catch {
		return oauthError(400, 'invalid_request', 'Could not parse request body');
	}

	const grantType = params.get('grant_type');
	if (grantType !== 'client_credentials')
		return oauthError(400, 'unsupported_grant_type', 'Only client_credentials is supported');

	const clientId = params.get('client_id');
	if (!clientId)
		return oauthError(400, 'invalid_request', 'client_id is required');

	const auth = await checkApiKey(clientId, env);
	if (!auth.allowed)
		return new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Invalid API key' }), {
			status: 401,
			headers: { ...oauthHeaders, 'WWW-Authenticate': 'Bearer' },
		});

	// Generate opaque token: 32 random bytes → hex string.
	const tokenBytes  = crypto.getRandomValues(new Uint8Array(32));
	const accessToken = toHex(tokenBytes);
	const tokenHash   = await sha256Hex(accessToken);
	// keyHash is present for Supabase-backed keys; compute deterministically for MASTER/BETA.
	const keyHash     = auth.keyHash ?? await sha256Hex(clientId);

	// expires_at stored in the record so introspection can return exp without a
	// second KV call. KV TTL (3600s) is the authoritative expiry; expires_at is
	// a convenience copy for RFC 7662 introspection responses.
	const expiresAt = Math.floor(Date.now() / 1000) + 3600;

	await env.ORACLE_API_KEYS.put(
		`oauth:${tokenHash}`,
		JSON.stringify({ keyHash, plan: auth.plan, status: 'active', expires_at: expiresAt }),
		{ expirationTtl: 3600 },
	);

	return new Response(JSON.stringify({
		access_token: accessToken,
		token_type:   'bearer',
		expires_in:   3600,
		scope:        'oracle:read',
	}), { status: 200, headers: oauthHeaders });
}

// ─── OAuth 2.0 Token Introspection ────────────────────────────────────────────
// RFC 7662 §2 — POST /oauth/introspect.
// Returns { active: true, scope, exp } for valid tokens, { active: false } for
// all others. Never returns 4xx — RFC 7662 §2.2 requires 200 for all valid requests.
async function handleOAuthIntrospect(request: Request, env: Env): Promise<Response> {
	const introspectHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
	const inactive = () => new Response(JSON.stringify({ active: false }), { status: 200, headers: introspectHeaders });

	if (request.method !== 'POST') return inactive();

	let token: string | null = null;
	try {
		const body = await request.text();
		token = new URLSearchParams(body).get('token');
	} catch { return inactive(); }

	if (!token || !env.ORACLE_API_KEYS) return inactive();

	try {
		const tokenHash = await sha256Hex(token);
		const cached    = await env.ORACLE_API_KEYS.get(`oauth:${tokenHash}`);
		if (!cached) return inactive();

		const parsed = JSON.parse(cached) as { keyHash: string; plan: string; status: string; expires_at?: number };
		// Treat logically expired tokens as inactive (guards against KV eventual consistency lag).
		if (parsed.status !== 'active') return inactive();
		if (parsed.expires_at && Math.floor(Date.now() / 1000) > parsed.expires_at) return inactive();

		return new Response(JSON.stringify({
			active:    true,
			scope:     'oracle:read',
			exp:       parsed.expires_at ?? null,
			token_type: 'bearer',
		}), { status: 200, headers: introspectHeaders });
	} catch { return inactive(); }
}

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	// ── Client Intelligence ────────────────────────────────────────────────────
	// Privacy-safe: IPs are hashed (SHA-256), never stored raw.
	// Aggregates land in ORACLE_TELEMETRY KV as mcp_clients:{date}:{ip_hash}.
	const cf         = (request as unknown as { cf?: Record<string, string> }).cf;
	const userAgent  = request.headers.get('User-Agent') ?? '';
	// Prefer headers injected by the headlessoracle.workers.dev proxy so we see the
	// real client IP/geo rather than Cloudflare's own ASN on proxied requests.
	const rawIp      = request.headers.get('X-Original-IP') || (request.headers.get('CF-Connecting-IP') ?? '');
	const ipHash     = await sha256Hex(rawIp);
	const asnOrg     = request.headers.get('X-Original-ASN-Org') || (cf?.asOrganization ?? '');
	const country    = request.headers.get('X-Original-Country') || (cf?.country ?? '');
	const city       = request.headers.get('X-Original-City')    || (cf?.city ?? '');
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
	// Telemetry is best-effort — a KV failure must never affect the MCP response.
	// ctx.waitUntil() silently drops rejected promises, so we attach .then()/.catch()
	// to surface both success and failure in Workers Logs.
	// Fallback: if ctx.waitUntil is unavailable (observed on some Workers Routes
	// configurations when requests arrive via a custom domain rather than workers.dev),
	// we await the put directly — adds minor latency but guarantees the write completes.
	let requestCount = 1; // default if KV read fails
	const kvKey = `mcp_clients:${today}:${ipHash}`;
	try {
		const stored = await env.ORACLE_TELEMETRY.get(kvKey);
		const prev   = stored ? JSON.parse(stored) as McpClientRecord : null;
		requestCount = (prev?.request_count ?? 0) + 1;
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
		// .then()/.catch() make both success and failure visible in Workers Logs —
		// ctx.waitUntil() itself swallows rejections silently.
		const putPromise = env.ORACLE_TELEMETRY.put(kvKey, JSON.stringify(updated), { expirationTtl: 8 * 24 * 3600 })
			.then(() => console.log(JSON.stringify({ event: 'TELEMETRY_PUT_OK', kvKey })))
			.catch((err: unknown) => console.error('TELEMETRY_PUT_FAILED', String(err)));
		if (typeof ctx?.waitUntil === 'function') {
			ctx.waitUntil(putPromise);
		} else {
			// ctx.waitUntil unavailable — await directly so the write is not lost.
			console.error('TELEMETRY_CTX_NO_WAITUNTIL — awaiting put directly');
			await putPromise;
		}
	} catch (err) {
		console.error('TELEMETRY_GET_FAILED', String(err));
	}

	// ── Soft OAuth auth — completely additive, never blocks unauthenticated access ──
	// If a valid Bearer token is present, mcpKeyHash/mcpPlan are populated for
	// rate-limit accounting. Any failure (missing token, KV miss, parse error,
	// expired token) falls through silently — request proceeds as anonymous.
	let _mcpKeyHash: string | null = null; // eslint-disable-line @typescript-eslint/no-unused-vars
	let _mcpPlan:    string | null = null; // eslint-disable-line @typescript-eslint/no-unused-vars
	try {
		const authHeader = request.headers.get('Authorization');
		if (authHeader?.startsWith('Bearer ') && env.ORACLE_API_KEYS) {
			const token      = authHeader.slice(7);
			const tokenHash  = await sha256Hex(token);
			const cached     = await env.ORACLE_API_KEYS.get(`oauth:${tokenHash}`);
			if (cached) {
				const parsed = JSON.parse(cached) as { keyHash: string; plan: string; status: string; expires_at?: number };
				if (parsed.status === 'active' && !(parsed.expires_at && Math.floor(Date.now() / 1000) > parsed.expires_at)) {
					_mcpKeyHash = parsed.keyHash;
					_mcpPlan    = parsed.plan;
				}
			}
		}
	} catch { /* fall through as anonymous — soft auth must never break MCP access */ }

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

	// ── MCP rate limiting — OAuth-authenticated requests only ─────────────────
	// Unauthenticated MCP (_mcpKeyHash === null) is structurally unreachable here.
	// Shares the same KV counter as the REST auth gate so REST + MCP calls count
	// together against a single daily limit per key.
	if (_mcpKeyHash !== null && _mcpPlan !== null) {
		const mcpPlanLimit = getPlanDailyLimit(_mcpPlan);
		if (mcpPlanLimit !== null) {
			const mcpDailyUsage = await getDailyUsage(_mcpKeyHash, env);
			if (mcpDailyUsage >= mcpPlanLimit) {
				return new Response(JSON.stringify({
					jsonrpc: '2.0',
					id,
					error: { code: -32000, message: `RATE_LIMITED: ${_mcpPlan} plan daily limit (${mcpPlanLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/pricing` },
				}), { status: 200, headers: MCP_RESPONSE_HEADERS });
			}
			incrementDailyUsage(_mcpKeyHash, env, ctx, mcpDailyUsage);
		}
	}

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
					'Headless Oracle provides cryptographically signed market status for 23 global exchanges. ' +
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

			if (name === 'verify_receipt') {
				const receipt = args.receipt as Record<string, unknown> | undefined;

				// Structural validation — must be an object with a signature field
				if (!receipt || typeof receipt !== 'object' || typeof receipt.signature !== 'string' || !receipt.signature) {
					return rpcResult({
						content: [{ type: 'text', text: JSON.stringify({ valid: false, expired: false, reason: 'MALFORMED_RECEIPT', mic: null, status: null, expires_at: null }) }],
					});
				}

				const pubKeyHex = env.ED25519_PUBLIC_KEY;
				if (!pubKeyHex) {
					return rpcResult({
						content: [{ type: 'text', text: JSON.stringify({ valid: false, expired: false, reason: 'ORACLE_NOT_CONFIGURED', mic: null, status: null, expires_at: null }) }],
					});
				}

				try {
					// Reconstruct canonical payload: all fields except signature, sorted alphabetically
					const { signature, ...rest } = receipt as Record<string, unknown>;
					const payload: Record<string, string> = {};
					for (const key of Object.keys(rest).sort()) {
						payload[key] = String(rest[key]);
					}
					const canonical = JSON.stringify(payload);
					const msgBytes  = new TextEncoder().encode(canonical);
					const sigBytes  = fromHex(signature as string);
					const pubKey    = fromHex(pubKeyHex);

					const valid = await ed.verify(sigBytes, msgBytes, pubKey);

					const expiresAt = typeof receipt.expires_at === 'string' ? receipt.expires_at : null;
					const expired   = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;

					let reason: string;
					if (!valid)        reason = 'INVALID_SIGNATURE';
					else if (expired)  reason = 'RECEIPT_EXPIRED — re-fetch required';
					else               reason = 'SIGNATURE_VALID';

					return rpcResult({
						content: [{ type: 'text', text: JSON.stringify({
							valid,
							expired,
							reason,
							mic:        typeof receipt.mic    === 'string' ? receipt.mic    : null,
							status:     typeof receipt.status === 'string' ? receipt.status : null,
							expires_at: expiresAt,
						}) }],
					});
				} catch {
					return rpcResult({
						content: [{ type: 'text', text: JSON.stringify({ valid: false, expired: false, reason: 'MALFORMED_RECEIPT', mic: null, status: null, expires_at: null }) }],
					});
				}
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

// ─── Autonomous Halt Monitor ─────────────────────────────────────────────────
// Runs every minute via cron. Checks Polygon.io (primary) or Alpaca (fallback)
// for real-time trade status. If an exchange is scheduled OPEN but real-time
// says the market is halted, writes a REALTIME override to ORACLE_OVERRIDES KV
// with a 2-hour TTL. Auto-clears when the exchange resumes.
//
// Design decisions:
// - Only checks exchanges that SHOULD be open right now (avoids noise)
// - Uses REALTIME source rather than OVERRIDE to distinguish from manual halts
// - 2h TTL: long enough to survive transient API failures, short enough to
//   auto-clear after market open the next session
// - Fail-open: if both APIs fail, the schedule-based state is preserved (no
//   false halts). A false halt is worse than a missed halt for most consumers.

interface HaltMonitorResult {
	mic:     string;
	checked: boolean;   // false if market was CLOSED per schedule (skip)
	halted:  boolean;   // true if real-time source says HALTED
	source:  'polygon' | 'alpaca' | 'skipped' | 'error';
	error?:  string;
}

// ─── Webhook subscriptions ────────────────────────────────────────────────────
// KV key patterns:
//   webhooks:{keyHash}             → JSON array of Subscription (subscriber's own records)
//   webhooks_by_mic:{mic}          → JSON array of WebhookDeliveryTarget (fan-out index)
//   last_state:{mic}               → JSON { status, updated_at } (state-change detection)

interface WebhookSubscription {
	subscription_id: string;
	url:             string;
	mics:            string[];
	secret:          string;
	created_at:      string;
}

interface WebhookDeliveryTarget {
	subscription_id: string;
	key_hash:        string;
	url:             string;
	secret:          string;
}

const FREE_TIER_WEBHOOK_MIC_LIMIT = 10; // max total MIC subscriptions per free key

async function getWebhookSubscriptions(keyHash: string, env: Env): Promise<WebhookSubscription[]> {
	const raw = await env.ORACLE_API_KEYS.get(`webhooks:${keyHash}`);
	if (!raw) return [];
	try { return JSON.parse(raw) as WebhookSubscription[]; }
	catch { return []; }
}

async function getWebhooksByMic(mic: string, env: Env): Promise<WebhookDeliveryTarget[]> {
	const raw = await env.ORACLE_API_KEYS.get(`webhooks_by_mic:${mic}`);
	if (!raw) return [];
	try { return JSON.parse(raw) as WebhookDeliveryTarget[]; }
	catch { return []; }
}

async function deliverWebhook(target: WebhookDeliveryTarget, payload: Record<string, unknown>): Promise<void> {
	const body = JSON.stringify(payload);
	const attempt = async () => fetch(target.url, {
		method:  'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': 'HeadlessOracle-Webhook/1.0' },
		body,
		signal:  AbortSignal.timeout(10000),
	});
	try {
		const resp = await attempt();
		if (!resp.ok) {
			// One retry after 1 second
			await scheduler.wait(1000);
			const retry = await attempt();
			if (!retry.ok) {
				console.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, url: target.url, status: retry.status }));
				return;
			}
		}
		console.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED', subscription_id: target.subscription_id }));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		try {
			await scheduler.wait(1000);
			const retry = await attempt();
			if (retry.ok) { console.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED_RETRY', subscription_id: target.subscription_id })); return; }
		} catch { /* ignore retry error */ }
		console.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, error: msg }));
	}
}

async function runHaltMonitor(env: Env): Promise<void> {
	const now = new Date();
	const results: HaltMonitorResult[] = [];

	for (const [mic, config] of Object.entries(MARKET_CONFIGS)) {
		// Only check exchanges that are scheduled OPEN right now
		let scheduleResult: MarketStatusResult;
		try {
			scheduleResult = getScheduleStatus(mic, now);
		} catch {
			results.push({ mic, checked: false, halted: false, source: 'error', error: 'schedule_error' });
			continue;
		}

		if (scheduleResult.status !== 'OPEN') {
			results.push({ mic, checked: false, halted: false, source: 'skipped' });
			continue;
		}

		// Exchange is scheduled OPEN — check real-time status
		let halted = false;
		let source: HaltMonitorResult['source'] = 'error';
		let errorMsg: string | undefined;

		// Primary: Polygon.io market status
		if (env.POLYGON_API_KEY) {
			try {
				const polygonResp = await fetch(
					`https://api.polygon.io/v1/marketstatus/now?apiKey=${env.POLYGON_API_KEY}`,
					{ signal: AbortSignal.timeout(5000) },
				);
				if (polygonResp.ok) {
					const data = await polygonResp.json() as Record<string, unknown>;
					// Polygon returns market (US) and currencies status; for non-US exchanges
					// we map MICs to Polygon market names where available.
					const micToPolygon: Record<string, string> = {
						XNYS: 'nyse', XNAS: 'nasdaq', XASX: 'asx',
					};
					const polygonName = micToPolygon[mic];
					if (polygonName) {
						const exchanges = data.exchanges as Record<string, string> | undefined;
						const marketStatus = exchanges?.[polygonName] ?? data.market;
						halted = typeof marketStatus === 'string' && marketStatus !== 'open';
						source = 'polygon';
					} else {
						// Polygon doesn't cover this MIC — fall through to Alpaca
						source = 'error';
						errorMsg = 'mic_not_in_polygon';
					}
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') {
					console.log(JSON.stringify({ event: 'HALT_MONITOR_TIMEOUT', exchange: mic, source: 'polygon', timeout_ms: 5000 }));
				}
				errorMsg = err instanceof Error ? err.message : 'polygon_fetch_failed';
			}
		}

		// Fallback: Alpaca market clock (US markets only, paper API — public)
		if (source === 'error' && (mic === 'XNYS' || mic === 'XNAS')) {
			try {
				const alpacaResp = await fetch(
					'https://paper-api.alpaca.markets/v2/clock',
					{
						headers: { 'APCA-API-KEY-ID': 'PKJ...', 'APCA-API-SECRET-KEY': 'ignored' },
						signal: AbortSignal.timeout(5000),
					},
				);
				if (alpacaResp.ok) {
					const clock = await alpacaResp.json() as { is_open?: boolean };
					halted = clock.is_open === false;
					source = 'alpaca';
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') {
					console.log(JSON.stringify({ event: 'HALT_MONITOR_TIMEOUT', exchange: mic, source: 'alpaca', timeout_ms: 5000 }));
				}
				errorMsg = err instanceof Error ? err.message : 'alpaca_fetch_failed';
			}
		}

		if (source === 'error') {
			// Both APIs failed — fail-open (do NOT write a HALTED override)
			results.push({ mic, checked: true, halted: false, source: 'error', error: errorMsg });
			continue;
		}

		results.push({ mic, checked: true, halted, source });

		if (halted) {
			// Write REALTIME override to ORACLE_OVERRIDES KV — 2h TTL
			const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
			const overrideVal = JSON.stringify({
				status:         'HALTED',
				source:         'REALTIME',
				reason:         `Real-time halt detected by halt monitor (source: ${source})`,
				expires:        expiresAt,
				auto_clear_at:  expiresAt,
				detected_at:    now.toISOString(),
			});
			await env.ORACLE_OVERRIDES.put(mic, overrideVal, { expirationTtl: 7200 });
			console.log(JSON.stringify({
				event:      'HALT_MONITOR_HALTED',
				mic,
				source,
				expires_at: expiresAt,
				timestamp:  now.toISOString(),
			}));
		} else {
			// Exchange is OPEN per real-time — clear any existing REALTIME override
			// (but do NOT clear manual OVERRIDE entries set by operators)
			const existing = await env.ORACLE_OVERRIDES.get(mic);
			if (existing) {
				try {
					const parsed = JSON.parse(existing) as { source?: string };
					if (parsed.source === 'REALTIME') {
						await env.ORACLE_OVERRIDES.delete(mic);
						console.log(JSON.stringify({
							event:     'HALT_MONITOR_CLEARED',
							mic,
							timestamp: now.toISOString(),
						}));
					}
				} catch {
					// Malformed KV value — leave it for operator review
				}
			}
		}
	}

	console.log(JSON.stringify({
		event:          'HALT_MONITOR_RUN',
		timestamp:      now.toISOString(),
		exchanges_checked: results.filter((r) => r.checked).length,
		halts_detected: results.filter((r) => r.halted).length,
		results:        results.map((r) => ({ mic: r.mic, checked: r.checked, halted: r.halted, source: r.source })),
	}));

	// ── State-change detection and webhook fan-out ────────────────────────────
	// For each exchange, compare current schedule-based status against last known state.
	// If changed, fire webhooks to all registered subscribers for that MIC.
	// Uses schedule-based status (not halt-monitor results) — more broadly applicable.
	const webhookDeliveries: Promise<void>[] = [];

	for (const [mic, config] of Object.entries(MARKET_CONFIGS)) {
		let currentStatus: string;
		try {
			const result = getScheduleStatus(mic, now);
			// If a KV override is active, reflect that in the status
			const override = await env.ORACLE_OVERRIDES.get(mic);
			if (override) {
				try {
					const ov = JSON.parse(override) as { status?: string; expires?: string };
					if (ov.expires && new Date(ov.expires) > now) {
						currentStatus = ov.status ?? result.status;
					} else {
						currentStatus = result.status;
					}
				} catch { currentStatus = result.status; }
			} else {
				currentStatus = result.status;
			}
		} catch { continue; }

		const stateKey = `last_state:${mic}`;
		const lastRaw  = await env.ORACLE_API_KEYS.get(stateKey);
		const lastState = lastRaw ? (JSON.parse(lastRaw) as { status: string }).status : null;

		// Write current state back (always — establishes baseline on first run)
		await env.ORACLE_API_KEYS.put(stateKey, JSON.stringify({ status: currentStatus, updated_at: now.toISOString() }));

		if (lastState === null || lastState === currentStatus) continue; // no change or first run

		// State changed — fan out to subscribers
		const targets = await getWebhooksByMic(mic, env);
		if (targets.length === 0) continue;

		const expiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
		const { receipt } = await buildSignedReceipt(mic, env, now, expiresAt, 'live');

		for (const target of targets) {
			const payload = {
				event:           'state_changed',
				mic,
				previous_status: lastState,
				new_status:      currentStatus,
				receipt,
				secret:          target.secret,
				timestamp:       now.toISOString(),
			};
			webhookDeliveries.push(deliverWebhook(target, payload));
		}

		console.log(JSON.stringify({
			event:           'WEBHOOK_STATE_CHANGE',
			mic,
			previous_status: lastState,
			new_status:      currentStatus,
			subscriber_count: targets.length,
			timestamp:       now.toISOString(),
		}));
	}

	await Promise.allSettled(webhookDeliveries);
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

		// Tracks the free-tier percent-used for the current request; set during the x402 gate.
		// Used to add soft-limit warning headers to authenticated responses.
		let freeTierPercentUsed = 0;

		// Rate-limit context for the current request — updated during auth processing.
		// Applied to responses via withRateLimitWarning or explicit extraHeaders.
		let _rlPlan  = 'free';
		let _rlUsed  = 0;
		let _rlLimit = FREE_TIER_DAILY_LIMIT;

		const corsHeaders = {
			'Access-Control-Allow-Origin':  '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, X-Oracle-Key',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => {
			let responseBody = body;
			// Auto-append docs link to 4xx error responses for agent-readable error recovery.
			if (
				status >= 400 && status < 500 &&
				typeof body === 'object' && body !== null && 'error' in body &&
				typeof (body as Record<string, unknown>).error === 'string'
			) {
				responseBody = {
					...(body as Record<string, unknown>),
					docs: `https://headlessoracle.com/docs`,
				};
			}
			// Default rate-limit headers — overridden by withRateLimitWarning for authenticated paths.
			// _rlPlan/_rlUsed/_rlLimit default to 'free'/0/FREE_TIER_DAILY_LIMIT for unauthenticated requests.
			const rlMidnight = new Date(now);
			rlMidnight.setUTCDate(rlMidnight.getUTCDate() + 1);
			rlMidnight.setUTCHours(0, 0, 0, 0);
			const defaultRlHeaders: Record<string, string> = {
				'X-Oracle-Plan':         _rlPlan,
				'X-RateLimit-Limit':     String(_rlLimit),
				'X-RateLimit-Remaining': String(Math.max(0, _rlLimit - _rlUsed)),
				'X-RateLimit-Reset':     rlMidnight.toISOString(),
			};
			return new Response(JSON.stringify(responseBody), {
				status,
				headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Oracle-Version': 'v5', ...defaultRlHeaders, ...extraHeaders },
			});
		};

		// ── POST /oauth/token — OAuth 2.0 Client Credentials token endpoint ──
		// Isolated from all existing routes. Dispatched before the main try/catch.
		// Errors use RFC 6749 format (not the Oracle json() helper) so they are
		// not decorated with 'docs' fields or X-Oracle-Version headers.
		if (url.pathname === '/oauth/token') {
			return handleOAuthToken(request, env);
		}

		// ── POST /oauth/introspect — RFC 7662 token introspection ──
		// Returns { active: true/false }. Always HTTP 200 per RFC 7662 §2.2.
		if (url.pathname === '/oauth/introspect') {
			return handleOAuthIntrospect(request, env);
		}

		// ── GET /mcp — server info; POST /mcp — MCP Streamable HTTP ──
		// GET returns machine-readable server metadata for MCP evaluation tools.
		// POST is the actual MCP endpoint (outside main try/catch — isolated error handling).
		if (url.pathname === '/mcp') {
			if (request.method === 'GET') {
				return json({
					name:           MCP_SERVER_NAME,
					version:        MCP_SERVER_VERSION,
					protocol:       MCP_PROTOCOL_VERSION,
					description:    'Cryptographically signed market status verification for AI agents',
					tools:          MCP_TOOLS.map((t) => t.name),
					authentication: 'none',
					sma_compliant:  true,
					sma_version:    '1.0',
				});
			}
			if (request.method !== 'POST') {
				return json({ error: 'METHOD_NOT_ALLOWED', message: 'MCP endpoint requires POST' }, 405);
			}
			return handleMcp(request, env, ctx);
		}

		try {
			// ── Auth gate — /v5/status requires X-Oracle-Key or x402 payment ─────
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (apiKey) {
					// Key-based auth path (steps 1–3): MASTER → BETA → Supabase lookup
					const auth = await checkApiKey(apiKey, env);
					if (!auth.allowed) {
						const authHeaders = auth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
						return json({ error: auth.error, message: auth.message }, auth.status, authHeaders);
					}
					// Update last_used_at for keys tracked in Supabase (non-blocking, best-effort).
					if (auth.keyHash && typeof ctx?.waitUntil === 'function') {
						ctx.waitUntil(updateKeyUsage(auth.keyHash, env).catch(() => {}));
					}
					// ── Free tier daily limit + x402 micropayment gate ─────────────
					if (auth.plan === 'free') {
						// Reuse keyHash from auth result — avoids a redundant sha256 on the hot path.
						const keyHash = auth.keyHash ?? await sha256Hex(apiKey);
						const usage   = await getDailyUsage(keyHash, env);

						// Track percent used for soft-limit warning headers on the response.
						freeTierPercentUsed = Math.round((usage / FREE_TIER_DAILY_LIMIT) * 1000) / 10;

						// Design partner detection: log once per key per day when usage > 200
						if (usage > 200) {
							const dpKey    = `design_partner:${keyHash}:${new Date().toISOString().slice(0, 10)}`;
							const dpExists = await env.ORACLE_TELEMETRY.get(dpKey).catch(() => null);
							if (dpExists === null) {
								const putDp = env.ORACLE_TELEMETRY.put(dpKey, '1', { expirationTtl: 25 * 3600 }).catch(() => {});
								if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(putDp);
								console.log(JSON.stringify({
									event:          'DESIGN_PARTNER_CANDIDATE',
									key_hash:       keyHash,
									requests_today: usage,
									plan:           'free',
									timestamp:      new Date().toISOString(),
									note:           'High-volume free tier user — potential design partner',
								}));
							}
						}

						if (usage >= FREE_TIER_DAILY_LIMIT) {
							const paymentHeader = request.headers.get('X-Payment');
							if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
								let payment: X402Payment;
								try { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
									return json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
								}
								const verify = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
								if (!verify.valid) {
									return json({
										error:   'PAYMENT_VERIFICATION_FAILED',
										message: `Payment verification failed: ${verify.detail ?? 'unknown'}`,
										x402:    build402Payload(env.ORACLE_PAYMENT_ADDRESS, keyHash).x402,
									}, 402, X402_RESPONSE_HEADERS);
								}
								// Valid x402 payment — proceed without counting against daily usage
							} else {
								const credits = await getCreditBalance(keyHash, env);
								if (credits.balance > 0) {
									consumeCredit(keyHash, credits, env, ctx);
								} else if (env.ORACLE_PAYMENT_ADDRESS) {
									return json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, keyHash), 402, X402_RESPONSE_HEADERS);
								} else {
									return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/pricing' }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
								}
							}
						} else {
							incrementDailyUsage(keyHash, env, ctx, usage);
						}
					// ── Sandbox daily limit (100 calls per 24h key lifetime) ──
					} else if (auth.plan === 'sandbox') {
						const sbKeyHash = auth.keyHash ?? await sha256Hex(apiKey);
						const sbUsage   = await getDailyUsage(sbKeyHash, env);
						if (sbUsage >= SANDBOX_DAILY_LIMIT) {
							// Track sandbox cap hits for acquisition telemetry (FINDING-13)
							incrementKvCounter(`sandbox_cap_hit:${now.toISOString().slice(0, 10)}`, env, ctx);
							return json({ error: 'SANDBOX_LIMIT_REACHED', message: 'Sandbox key limit (100 calls) reached. Get a new sandbox key at /v5/sandbox or upgrade at headlessoracle.com/pricing', upgrade: 'https://headlessoracle.com/pricing' }, 402);
						}
						incrementDailyUsage(sbKeyHash, env, ctx, sbUsage);
					// ── Paid tier daily limits (builder: 50k/day, pro: 200k/day) ──
					} else if (auth.plan === 'builder' || auth.plan === 'pro') {
						const paidKeyHash = auth.keyHash ?? await sha256Hex(apiKey);
						const paidUsage   = await getDailyUsage(paidKeyHash, env);
						const paidLimit   = getPlanDailyLimit(auth.plan)!;
						if (paidUsage >= paidLimit) {
							return json({ error: 'RATE_LIMITED', message: `${auth.plan} plan daily limit (${paidLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/pricing` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
						}
						incrementDailyUsage(paidKeyHash, env, ctx, paidUsage);
					}
				} else {
					// No API key — x402 payment path (step 4) or 402 gate (step 5)
					const paymentHeader = request.headers.get('X-Payment');
					if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
						// Keyless x402: verify on-chain payment, then serve receipt
						let payment: X402Payment;
						try { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
							return json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
						}
						const verified = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
						if (!verified.valid) {
							const resource = `https://headlessoracle.com${url.pathname}${url.search}`;
							return json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
						}
						// Valid keyless x402 payment — fall through to serve receipt (no rate limit applied)
					} else if (env.ORACLE_PAYMENT_ADDRESS) {
						// No key, no payment — return x402scan-compatible 402 so crawlers can register this endpoint
						const resource = `https://headlessoracle.com${url.pathname}${url.search}`;
						return json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
					} else {
						// ORACLE_PAYMENT_ADDRESS not configured — fall back to 401 (dev/test environments)
						return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
					}
				}
			}

			// Helper: wrap a Response to add soft rate-limit warning headers AND standard rate-limit headers.
			const withRateLimitWarning = (response: Response): Response => {
				const newHeaders = new Headers(response.headers);
				const rlHeaders  = makeRateLimitHeaders(_rlPlan, _rlUsed, _rlLimit, now);
				for (const [k, v] of Object.entries(rlHeaders)) newHeaders.set(k, v);
				if (freeTierPercentUsed >= 80) {
					addRateLimitWarningHeaders(newHeaders, freeTierPercentUsed, 'https://headlessoracle.com/pricing');
				}
				return new Response(response.body, { status: response.status, headers: newHeaders });
			};

			// ── GET /v5/exchanges — public directory of supported markets ─
			if (url.pathname === '/v5/exchanges') {
				return withRateLimitWarning(json({ exchanges: SUPPORTED_EXCHANGES }));
			}

			// ── GET /v5/keys — public key registry ───────────────────────
			if (url.pathname === '/v5/keys') {
				return withRateLimitWarning(json({
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
				}));
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
				return withRateLimitWarning(json({
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
				}));
			}

			// ── GET /v5/status/realtime — authenticated, returns halt_monitor metadata ──
			// Returns the current halt monitor status: when it last ran, which sources were
			// checked, and which exchanges have active REALTIME overrides right now.
			// Requires X-Oracle-Key. Auth already verified above.
			if (url.pathname === '/v5/status/realtime') {
				const mic = (url.searchParams.get('mic') || 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[mic]) {
					return json({
						error:     'UNKNOWN_MIC',
						message:   `Unsupported exchange: ${mic}. See /v5/exchanges for supported markets.`,
						supported: SUPPORTED_EXCHANGES.map((e) => e.mic),
					}, 400);
				}

				// Check if there is a REALTIME override active for this MIC
				const overrideRaw = await env.ORACLE_OVERRIDES.get(mic);
				let realtimeOverride: Record<string, unknown> | null = null;
				if (overrideRaw) {
					try {
						const parsed = JSON.parse(overrideRaw) as Record<string, unknown>;
						if (parsed.source === 'REALTIME') {
							realtimeOverride = parsed;
						}
					} catch { /* malformed — ignore */ }
				}

				// Also return the signed receipt for this MIC
				const { receipt, status: receiptStatus } = await buildSignedReceipt(mic, env, now, expiresAt, 'live');

				return json({
					mic,
					signed_receipt:    receipt,
					halt_monitor: {
						active_realtime_override: realtimeOverride,
						note: 'halt_monitor runs every minute via cron. REALTIME overrides are auto-cleared when exchange resumes.',
					},
				}, receiptStatus, { 'Cache-Control': 'no-store' });
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
				// Acquisition telemetry: track authenticated vs unauthenticated call ratio (FINDING-13)
				if (mode === 'live') {
					incrementKvCounter(`auth_calls:${now.toISOString().slice(0, 10)}`, env, ctx);
				} else {
					incrementKvCounter(`unauth_calls:${now.toISOString().slice(0, 10)}`, env, ctx);
				}
				const { receipt, status } = await buildSignedReceipt(mic, env, now, expiresAt, mode);
				// Audit: log receipt to Supabase for authenticated /v5/status calls (non-blocking)
				if (mode === 'live' && typeof ctx?.waitUntil === 'function') {
					const auditApiKey = request.headers.get('X-Oracle-Key') ?? '';
					if (auditApiKey) {
						const auditKeyHash = await sha256Hex(auditApiKey);
						ctx.waitUntil(insertReceiptAudit(auditKeyHash, receipt as Record<string, unknown>, env).catch(() => {}));
					}
				}
				// Receipts must not be cached — they expire in 60s and contain real-time status.
				return withRateLimitWarning(json(receipt, status, { 'Cache-Control': 'no-store' }));
			}

			// ── GET /v5/batch — authenticated batch receipt query ─────────────────────
			// Returns independently signed receipts for multiple exchanges in one request.
			// Each receipt goes through the full 4-tier fail-closed architecture.
			if (url.pathname === '/v5/batch') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					// No key — return x402scan-compatible 402 so the endpoint is registered as x402-native.
					// Keyless batch execution requires a key (use /v5/status for single keyless x402 requests).
					if (env.ORACLE_PAYMENT_ADDRESS) {
						return json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, 'https://headlessoracle.com/v5/batch', 'batch'), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
					}
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const batchAuth = await checkApiKey(apiKey, env);
				if (!batchAuth.allowed) {
					const batchAuthHeaders = batchAuth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					return json({ error: batchAuth.error, message: batchAuth.message }, batchAuth.status, batchAuthHeaders);
				}
				// Update last_used_at for keys tracked in Supabase (non-blocking, best-effort).
				if (batchAuth.keyHash && typeof ctx?.waitUntil === 'function') {
					ctx.waitUntil(updateKeyUsage(batchAuth.keyHash, env).catch(() => {}));
				}
				// Free tier limit check for batch
				if (batchAuth.plan === 'free') {
					// Reuse keyHash from auth result — avoids a redundant sha256 on the hot path.
					const batchKeyHash = batchAuth.keyHash ?? await sha256Hex(apiKey);
					const batchUsage   = await getDailyUsage(batchKeyHash, env);
					freeTierPercentUsed = Math.round((batchUsage / FREE_TIER_DAILY_LIMIT) * 1000) / 10;
					if (batchUsage >= FREE_TIER_DAILY_LIMIT) {
						const paymentHeader = request.headers.get('X-Payment');
						if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
							let payment: X402Payment;
							try { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
								return json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
							}
							const verify = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
							if (!verify.valid) {
								return json({
									error:   'PAYMENT_VERIFICATION_FAILED',
									message: `Payment verification failed: ${verify.detail ?? 'unknown'}`,
									x402:    build402Payload(env.ORACLE_PAYMENT_ADDRESS, batchKeyHash).x402,
								}, 402, X402_RESPONSE_HEADERS);
							}
						} else {
							const credits = await getCreditBalance(batchKeyHash, env);
							if (credits.balance > 0) {
								consumeCredit(batchKeyHash, credits, env, ctx);
							} else if (env.ORACLE_PAYMENT_ADDRESS) {
								return json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, batchKeyHash), 402, X402_RESPONSE_HEADERS);
							} else {
								return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/pricing' }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
							}
						}
					} else {
						incrementDailyUsage(batchKeyHash, env, ctx, batchUsage);
					}
				// ── Sandbox daily limit for batch ──
				} else if (batchAuth.plan === 'sandbox') {
					const sbBatchKeyHash = batchAuth.keyHash ?? await sha256Hex(apiKey);
					const sbBatchUsage   = await getDailyUsage(sbBatchKeyHash, env);
					if (sbBatchUsage >= SANDBOX_DAILY_LIMIT) {
						incrementKvCounter(`sandbox_cap_hit:${now.toISOString().slice(0, 10)}`, env, ctx);
						return json({ error: 'SANDBOX_LIMIT_REACHED', message: 'Sandbox key limit (100 calls) reached. Get a new sandbox key at /v5/sandbox or upgrade at headlessoracle.com/pricing', upgrade: 'https://headlessoracle.com/pricing' }, 402);
					}
					incrementDailyUsage(sbBatchKeyHash, env, ctx, sbBatchUsage);
				// ── Paid tier daily limits for batch (builder: 50k/day, pro: 200k/day) ──
				} else if (batchAuth.plan === 'builder' || batchAuth.plan === 'pro') {
					const paidBatchKeyHash = batchAuth.keyHash ?? await sha256Hex(apiKey);
					const paidBatchUsage   = await getDailyUsage(paidBatchKeyHash, env);
					const paidBatchLimit   = getPlanDailyLimit(batchAuth.plan)!;
					if (paidBatchUsage >= paidBatchLimit) {
						return json({ error: 'RATE_LIMITED', message: `${batchAuth.plan} plan daily limit (${paidBatchLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/pricing` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
					}
					incrementDailyUsage(paidBatchKeyHash, env, ctx, paidBatchUsage);
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

				// Acquisition telemetry: track unique MIC combinations requested (FINDING-13)
				const sortedComboKey = `batch_combo:${[...requestedMics].sort().join('+')}:${now.toISOString().slice(0, 10)}`;
				incrementKvCounter(sortedComboKey, env, ctx, 25 * 3600);

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

				// GAP-012: Re-check ORACLE_OVERRIDES after receipt build to catch halt-monitor eventual-consistency race.
				// buildSignedReceipt already checks overrides (Tier 0) but a KV write from the halt monitor
				// could arrive in the window between the Tier-0 read and the summary computation.
				const overrideRecheck = await Promise.all(
					requestedMics.map(async (mic) => {
						if (!env.ORACLE_OVERRIDES) return null;
						const raw = await env.ORACLE_OVERRIDES.get(mic).catch(() => null);
						if (!raw) return null;
						try {
							const ov = JSON.parse(raw) as { status: string; reason: string; expires: string };
							if (new Date(ov.expires) > now) {
								console.log(`OVERRIDE_APPLIED: ${mic} -> ${ov.status}`);
								return { mic, status: ov.status };
							}
						} catch { /* malformed override — ignore */ }
						return null;
					})
				);

				// Build portfolio-level summary: counts by status + safe_to_execute gate
				// effectiveStatuses merges the built receipt status with any active override re-check (GAP-012).
				const effectiveStatuses = results.map((r, i) => {
					const ov = overrideRecheck[i];
					if (ov) return ov.status;
					return (r.receipt as Record<string, unknown>).status as string;
				});
				const countOpen    = effectiveStatuses.filter((s) => s === 'OPEN').length;
				const countClosed  = effectiveStatuses.filter((s) => s === 'CLOSED').length;
				const countHalted  = effectiveStatuses.filter((s) => s === 'HALTED').length;
				const countUnknown = effectiveStatuses.filter((s) => s === 'UNKNOWN').length;
				const anyHalted    = countHalted > 0;
				const anyUnknown   = countUnknown > 0;
				const safeToExecute = countOpen === results.length && !anyHalted && !anyUnknown;

				let summaryReason: string | null = null;
				if (!safeToExecute) {
					if (anyHalted)       summaryReason = `${countHalted} exchange${countHalted > 1 ? 's' : ''} HALTED — fail-closed`;
					else if (anyUnknown) summaryReason = `${countUnknown} exchange${countUnknown > 1 ? 's' : ''} UNKNOWN — fail-closed`;
					else                 summaryReason = `${results.length - countOpen} exchange${results.length - countOpen > 1 ? 's' : ''} not OPEN`;
				}

				// GAP-013: Audit each receipt in the batch (non-blocking, fire-and-forget).
				// Uses source='batch' to distinguish from individual /v5/status audit rows.
				const auditKeyHash = batchAuth.keyHash ?? await sha256Hex(apiKey);
				if (typeof ctx?.waitUntil === 'function') {
					ctx.waitUntil(Promise.all(
						results.map((r) =>
							insertReceiptAudit(
								auditKeyHash,
								{ ...(r.receipt as Record<string, unknown>), source: 'batch' },
								env,
							).catch(() => {})
						)
					));
				}

				return withRateLimitWarning(json({
						summary: {
							total:          results.length,
							open:           countOpen,
							closed:         countClosed,
							halted:         countHalted,
							unknown:        countUnknown,
							all_open:       countOpen === results.length,
							any_halted:     anyHalted,
							safe_to_execute: safeToExecute,
							reason:         summaryReason,
						},
						batch_id:   crypto.randomUUID(),
						queried_at: now.toISOString(),
						receipts:   results.map((r) => r.receipt),
					}));
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
					// of the signed payload. version/sma_spec_version/mcp_protocol_version added
					// for MCP evaluation tools that check server capabilities.
					// Count active REALTIME overrides from ORACLE_OVERRIDES KV
					let activeRealtimeOverrides: string[] = [];
					try {
						const allMics = Object.keys(MARKET_CONFIGS);
						const overrideChecks = await Promise.all(
							allMics.map(async (m) => {
								const raw = await env.ORACLE_OVERRIDES.get(m);
								if (!raw) return null;
								try {
									const parsed = JSON.parse(raw) as { source?: string };
									return parsed.source === 'REALTIME' ? m : null;
								} catch { return null; }
							}),
						);
						activeRealtimeOverrides = overrideChecks.filter((m): m is string => m !== null);
					} catch { /* KV unavailable — report empty */ }

					return withRateLimitWarning(json({
						...healthPayload,
						signature,
						version:              'v5.0',
						sma_spec_version:     '1.0',
						mcp_protocol_version: MCP_PROTOCOL_VERSION,
						uptime_since:         '2026-03-10T08:00:00Z',
						fail_closed:          true,
						payment_schemes:      ['x402'],
						exchange_count:             SUPPORTED_EXCHANGES.length,
						supported_mics:             SUPPORTED_EXCHANGES.map((e) => e.mic),
						data_coverage:              {
							holidays:  holidayCoverageYears,
							half_days: halfDayCoverageYears,
						},
						edge_case_count_current_year: edgeCaseCount(currentYear).total,
						halt_monitor: {
							status:                    'active',
							cron:                      '* * * * *',
							sources:                   ['polygon', 'alpaca'],
							active_realtime_overrides: activeRealtimeOverrides,
							note:                      'Checks scheduled-OPEN exchanges every minute. Writes REALTIME overrides on discrepancy. Fails open (no false halts on API errors).',
						},
					}));
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
			// ── /docs/*.md and extensionless /docs/* — embedded markdown docs ───────
			// .md variants: Content-Type text/markdown (for agents/LLMs)
			// Extensionless variants: Content-Type text/plain (for direct browser/email links)
			if (url.pathname.startsWith('/docs/')) {
				const mdHeaders = {
					'Content-Type':  'text/markdown; charset=utf-8',
					'Cache-Control': 'public, max-age=3600',
				};
				const plainHeaders = {
					'Content-Type':  'text/plain; charset=utf-8',
					'Cache-Control': 'public, max-age=3600',
				};
				const p = url.pathname;
				// .md variants (canonical for agents)
				if (p === '/docs/sma-protocol-repo/SPEC.md')
					return new Response(SMA_SPEC_MD, { headers: mdHeaders });
				if (p === '/docs/agent-safety-standard/STANDARD.md' || p === '/docs/agent-safety-standard-repo/STANDARD.md')
					return new Response(APTS_STANDARD_MD, { headers: mdHeaders });
				if (p === '/docs/x402-payments.md')
					return new Response(X402_PAYMENTS_MD, { headers: mdHeaders });
				if (p === '/docs/integrations/datacamp-workspace.md')
					return new Response(DATACAMP_WORKSPACE_MD, { headers: mdHeaders });
				if (p === '/docs/integrations/bun.md')
					return new Response(BUN_MD, { headers: mdHeaders });
				if (p === '/docs/rfc.md' || p === '/docs/rfc-external-state-attestation.md')
					return new Response(RFC_EXTERNAL_STATE_MD, { headers: mdHeaders });
				// Extensionless variants (for email links and browser navigation)
				if (p === '/docs/x402-payments')
					return new Response(X402_PAYMENTS_MD, { headers: plainHeaders });
				if (p === '/docs/integrations/datacamp-workspace')
					return new Response(DATACAMP_WORKSPACE_MD, { headers: plainHeaders });
				if (p === '/docs/integrations/bun')
					return new Response(BUN_MD, { headers: plainHeaders });
				if (p === '/docs/rfc')
					return new Response(RFC_EXTERNAL_STATE_MD, { headers: plainHeaders });
				// Unknown /docs/ path — fall through to 404 below
			}

			// ── /v5/errors/{code} — machine-readable error documentation ─────────
			const errMatch = url.pathname.match(/^\/v5\/errors\/([A-Z_]+)$/);
			if (errMatch) {
				const code = errMatch[1];
				const errorDocs: Record<string, { message: string; resolution: string; http_status: number }> = {
					API_KEY_REQUIRED:      { message: 'No X-Oracle-Key header supplied.', resolution: 'Add X-Oracle-Key header. Get a free key at /v5/keys/request.', http_status: 401 },
					INVALID_API_KEY:       { message: 'The supplied API key was not recognised.', resolution: 'Check the key value. Get a free key at /v5/keys/request.', http_status: 403 },
					PAYMENT_REQUIRED:      { message: 'Free tier daily limit reached.', resolution: 'Supply X-Payment header with a valid Base mainnet USDC tx, or upgrade at /pricing. See /docs/x402-payments.md.', http_status: 402 },
					RATE_LIMITED:          { message: 'Free tier daily limit (500 req/day) exhausted.', resolution: 'Wait for the daily reset, purchase credits at /v5/credits/purchase, or upgrade at /pricing.', http_status: 429 },
					INVALID_MIC:           { message: 'Unsupported exchange MIC code.', resolution: 'See /v5/exchanges for the full list of 23 supported exchanges.', http_status: 400 },
					METHOD_NOT_ALLOWED:    { message: 'HTTP method not allowed for this endpoint.', resolution: 'Check the HTTP method. See /openapi.json for allowed methods per route.', http_status: 405 },
					NOT_FOUND:             { message: 'Route not found.', resolution: 'Check the path. See /openapi.json for all available routes.', http_status: 404 },
					INVALID_TX_HASH:       { message: 'X-Payment txHash is not a valid 32-byte hex string.', resolution: 'Provide a valid Ethereum transaction hash (0x + 64 hex chars).', http_status: 402 },
					INVALID_PAYMENT:       { message: 'X-Payment header is not valid JSON or missing required fields.', resolution: 'See /docs/x402-payments.md for the required X-Payment format.', http_status: 402 },
					PAYMENT_VERIFICATION_FAILED: { message: 'The on-chain USDC payment could not be verified.', resolution: 'Ensure the transaction is confirmed on Base mainnet, sent to the correct paymentAddress, and is < 300 seconds old.', http_status: 402 },
					PAYMENT_ALREADY_USED:  { message: 'This transaction hash has already been used for a payment.', resolution: 'Each txHash can only be used once. Send a new USDC transaction.', http_status: 402 },
					PAYMENT_EXPIRED:       { message: 'The transaction is older than 300 seconds.', resolution: 'Send a new USDC transaction and retry immediately.', http_status: 402 },
					ACCOUNT_NOT_FOUND:     { message: 'No account found for this API key.', resolution: 'Verify your X-Oracle-Key. If subscribed via Paddle, check your email for the key.', http_status: 404 },
				};
				const doc = errorDocs[code];
				if (!doc) {
					return json({
						error: 'NOT_FOUND',
						message: `No documentation for error code: ${code}`,
						known_codes: Object.keys(errorDocs),
					}, 404);
				}
				return json({
					code,
					...doc,
					docs_url: `https://headlessoracle.com/docs#${code}`,
					openapi:  'https://headlessoracle.com/openapi.json',
				});
			}

			if (url.pathname === '/.well-known/agent.json') {
				return json(AGENT_JSON);
			}
			if (url.pathname === '/.well-known/mcp/server-card.json') {
				return json({
					name:           'Headless Oracle',
					version:        'v5.0',
					description:    'Cryptographically signed market-state receipts for AI agents. ' +
						'Ed25519 signatures, fail-closed architecture, 23 global exchanges. ' +
						'Treat UNKNOWN or HALTED as CLOSED — halt all execution.',
					mcp_endpoint:   'https://headlessoracle.com/mcp',
					tools:          ['get_market_status', 'get_market_schedule', 'list_exchanges', 'verify_receipt'],
					authentication: ['bearer', 'apiKey', 'x402'],
					homepage:       'https://headlessoracle.com',
					docs:           'https://headlessoracle.com/docs',
					key_request:    'https://headlessoracle.com/v5/keys/request',
					openapi:        'https://headlessoracle.com/openapi.json',
					protocol:       '2024-11-05',
					protocols:      ['MCP-2024-11-05', 'A2A', 'x402', 'OAuth2'],
					fail_closed:    true,
					reliability:    { uptime_sla: '99.9%', p95_latency_ms: 200 },
					verification:   { algorithm: 'Ed25519', key_endpoint: 'https://api.headlessoracle.com/v5/keys' },
					coverage:       {
						exchanges: 23,
						mic_codes: ['XNYS','XNAS','XLON','XJPX','XPAR','XHKG','XSES','XASX','XBOM','XNSE','XSHG','XSHE','XKRX','XJSE','XBSP','XSWX','XMIL','XIST','XSAU','XDFM','XNZE','XHEL','XSTO'],
					},
				});
			}
			if (url.pathname === '/.well-known/oauth-protected-resource') {
				// RFC 8705 — OAuth 2.0 Protected Resource Metadata.
				// MCP clients fetch this to discover the authorization server for optional OAuth.
				// OAuth is additive — /mcp continues to work without a Bearer token.
				// bearer_methods_supported: ["header"] — token delivered via Authorization: Bearer.
				return json({
					resource:                            'https://headlessoracle.com',
					authorization_servers:               ['https://headlessoracle.com/oauth'],
					bearer_methods_supported:            ['header'],
					resource_documentation:              'https://headlessoracle.com/docs',
					resource_signing_alg_values_supported: ['EdDSA'],
					scopes_supported:                    ['oracle:read'],
				});
			}
			if (url.pathname === '/.well-known/oauth-authorization-server') {
				// RFC 8414 — OAuth 2.0 Authorization Server Metadata.
				// Describes the token endpoint and supported grant types.
				return json({
					issuer:                              'https://headlessoracle.com/oauth',
					token_endpoint:                      'https://headlessoracle.com/oauth/token',
					introspection_endpoint:              'https://headlessoracle.com/oauth/introspect',
					grant_types_supported:               ['client_credentials'],
					token_endpoint_auth_methods_supported: ['client_secret_post'],
					introspection_endpoint_auth_methods_supported: ['none'],
					scopes_supported:                    ['oracle:read'],
				});
			}
			if (url.pathname === '/.well-known/x402.json') {
				// x402 payment resource discovery. x402scan fetches this to discover which
				// endpoints require payment without probing each one individually.
				// Only /v5/status and /v5/batch are pay-per-request. All others are free.
				// When ORACLE_PAYMENT_ADDRESS is unset, return empty resources rather than
				// resources with payTo:"" — consistent with how the 402 gate falls back to 401.
				const payTo = env.ORACLE_PAYMENT_ADDRESS;
				const paidResources = payTo ? [
					{
						path:        '/v5/status',
						method:      'GET',
						description: 'Signed market-state receipt for one exchange. Ed25519 signed, 60s TTL.',
						input: {
							type:       'object',
							properties: { mic: { type: 'string', description: 'ISO 10383 MIC code', example: 'XNYS' } },
							required:   ['mic'],
						},
						accepts: [{
							scheme:            'exact',
							network:           'eip155:8453',
							maxAmountRequired: '1000',
							asset:             X402_USDC_CONTRACT,
							payTo,
						}],
					},
					{
						path:        '/v5/batch',
						method:      'GET',
						description: 'Signed market-state receipts for multiple exchanges. Each receipt Ed25519 signed, 60s TTL.',
						input: {
							type:       'object',
							properties: { mics: { type: 'string', description: 'Comma-separated MIC codes', example: 'XNYS,XNAS,XLON' } },
							required:   ['mics'],
						},
						accepts: [{
							scheme:            'exact',
							network:           'eip155:8453',
							maxAmountRequired: '5000',
							asset:             X402_USDC_CONTRACT,
							payTo,
						}],
					},
				] : [];
				return json({ version: 1, resources: paidResources });
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
						// code 23505 = unique_violation — a concurrent webhook already inserted this
						// subscription_id. Race condition won by peer; treat as idempotent success.
						if ((dbError as unknown as Record<string, string>).code === '23505') {
							console.log(`WEBHOOK_RACE_WON_BY_PEER: subscription ${txn['subscription_id'] as string} — treating as idempotent success`);
							return json({ received: true });
						}
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
						const newStatus = sub['status'] === 'active' ? 'active' : 'suspended';
						// Fetch key_hash before update — needed to sync KV immediately
						const { data: updKeyRow } = await supabase
							.from('api_keys').select('key_hash').eq('stripe_subscription_id', sub['id'] as string).single();
						await supabase.from('api_keys')
							.update({ status: newStatus })
							.eq('stripe_subscription_id', sub['id'] as string);
						// Sync KV so auth hot path reflects billing change immediately (not after 300s TTL)
						if (updKeyRow?.key_hash && env.ORACLE_API_KEYS) {
							const current = await env.ORACLE_API_KEYS.get(updKeyRow.key_hash as string);
							if (current) {
								const parsed = JSON.parse(current) as Record<string, unknown>;
								await env.ORACLE_API_KEYS.put(
									updKeyRow.key_hash as string,
									JSON.stringify({ ...parsed, status: newStatus }),
								);
							}
						}
					}
					return json({ received: true });
				}

				if (event.event_type === 'subscription.past_due') {
					const sub = event.data;
					if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
						const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
						// Fetch key_hash before update — needed to sync KV immediately
						const { data: pdKeyRow } = await supabase
							.from('api_keys').select('key_hash').eq('stripe_subscription_id', sub['id'] as string).single();
						await supabase.from('api_keys')
							.update({ status: 'suspended' })
							.eq('stripe_subscription_id', sub['id'] as string);
						// Sync KV so suspended status takes effect in seconds, not 300s
						if (pdKeyRow?.key_hash && env.ORACLE_API_KEYS) {
							const current = await env.ORACLE_API_KEYS.get(pdKeyRow.key_hash as string);
							if (current) {
								const parsed = JSON.parse(current) as Record<string, unknown>;
								await env.ORACLE_API_KEYS.put(
									pdKeyRow.key_hash as string,
									JSON.stringify({ ...parsed, status: 'suspended' }),
								);
							}
						}
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

				if (event.event_type === 'subscription.activated') {
					const sub = event.data;
					const subscriptionId = sub['id'] as string;
					if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
						console.error('WEBHOOK_ERROR: Supabase not configured — key not stored');
						return json({ received: true });
					}
					const supabaseActiv = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

					// Idempotency: if this subscription already has a key, update plan (upgrade flow)
					const { data: existingActiv } = await supabaseActiv
						.from('api_keys').select('id, key_hash, plan').eq('stripe_subscription_id', subscriptionId).single();

					// Determine plan — items[0].price.id for subscription.activated (differs from transaction.completed)
					const activItems = sub['items'] as Array<{ price?: { id?: string } }> | undefined;
					const activPriceId = activItems?.[0]?.price?.id ?? null;
					let activPlan = 'pro';
					if (activPriceId) {
						if (env.PADDLE_PRICE_ID_BUILDER && activPriceId === env.PADDLE_PRICE_ID_BUILDER)       activPlan = 'builder';
						else if (env.PADDLE_PRICE_ID_PRO && activPriceId === env.PADDLE_PRICE_ID_PRO)           activPlan = 'pro';
						else if (env.PADDLE_PRICE_ID_PROTOCOL && activPriceId === env.PADDLE_PRICE_ID_PROTOCOL) activPlan = 'protocol';
					}

					// Fetch customer email from Paddle API (not included in subscription event payload)
					let activEmail: string | null = null;
					if (env.PADDLE_API_KEY && sub['customer_id']) {
						const custActivRes = await fetch(`https://api.paddle.com/customers/${sub['customer_id'] as string}`, {
							headers: { 'Authorization': `Bearer ${env.PADDLE_API_KEY}` },
						});
						if (custActivRes.ok) {
							const custActivBody = await custActivRes.json() as { data?: { email?: string } };
							activEmail = custActivBody.data?.email ?? null;
						} else {
							console.error(`PADDLE_CUSTOMER_FETCH_ERROR: ${sub['customer_id'] as string}`);
						}
					}

					if (existingActiv) {
						// Subscription already has a key — update plan if it changed (upgrade path)
						if (existingActiv.plan !== activPlan) {
							await supabaseActiv.from('api_keys').update({ plan: activPlan, status: 'active' }).eq('stripe_subscription_id', subscriptionId);
							if (env.ORACLE_API_KEYS && existingActiv.key_hash) {
								const kvExisting = await env.ORACLE_API_KEYS.get(existingActiv.key_hash as string);
								if (kvExisting) {
									const kvExistingParsed = JSON.parse(kvExisting) as Record<string, unknown>;
									await env.ORACLE_API_KEYS.put(existingActiv.key_hash as string, JSON.stringify({ ...kvExistingParsed, plan: activPlan, status: 'active' }));
								}
							}
						}
						return json({ received: true });
					}

					// New subscription — generate and store key
					const activKeyBytes  = crypto.getRandomValues(new Uint8Array(32));
					const activKeyValue  = 'ho_live_' + toHex(activKeyBytes);
					const activKeyHash   = await sha256Hex(activKeyValue);
					const activKeyPrefix = activKeyValue.substring(0, 14);

					const { error: activDbError } = await supabaseActiv.from('api_keys').insert({
						id:                     crypto.randomUUID(),
						key_hash:               activKeyHash,
						key_prefix:             activKeyPrefix,
						plan:                   activPlan,
						status:                 'active',
						stripe_customer_id:     sub['customer_id'] as string | null,
						stripe_subscription_id: subscriptionId,
						email:                  activEmail,
						created_at:             new Date().toISOString(),
					});
					if (activDbError) {
						// code 23505 = unique_violation — concurrent transaction.completed already
						// inserted this subscription_id. Race won by peer; idempotent success.
						if ((activDbError as unknown as Record<string, string>).code === '23505') {
							console.log(`WEBHOOK_RACE_WON_BY_PEER: subscription ${subscriptionId} — treating as idempotent success`);
							return json({ received: true });
						}
						console.error(`WEBHOOK_DB_ERROR: ${activDbError.message}`);
						return json({ error: 'DB_ERROR', message: 'Failed to store API key — contact support@headlessoracle.com' }, 500);
					}

					if (env.ORACLE_API_KEYS) {
						await env.ORACLE_API_KEYS.put(activKeyHash, JSON.stringify({
							plan:                   activPlan,
							status:                 'active',
							paddle_customer_id:     sub['customer_id'] as string | null,
							paddle_subscription_id: subscriptionId,
							email:                  activEmail,
							created_at:             new Date().toISOString(),
						}));
					}

					if (env.RESEND_API_KEY && activEmail) {
						const activEmailRes = await fetch('https://api.resend.com/emails', {
							method:  'POST',
							headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
							body: JSON.stringify({
								from:    'Headless Oracle <keys@headlessoracle.com>',
								to:      [activEmail],
								subject: 'Your Headless Oracle API key',
								html: `<p>Thank you for subscribing to Headless Oracle.</p><p>Your API key (save this — it will not be shown again):</p><pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">${activKeyValue}</pre><p>Plan: ${activPlan} • Use as <code>X-Oracle-Key</code> header against <code>https://headlessoracle.com/v5/status</code>.</p><p>Documentation: <a href="https://headlessoracle.com/docs">headlessoracle.com/docs</a></p>`,
							}),
						});
						if (!activEmailRes.ok) console.error(`RESEND_ERROR: failed to send key email to ${activEmail}`);
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

			// ── GET /v5/metrics — public usage stats ─────────────────────
			if (url.pathname === '/v5/metrics') {
				const today  = new Date().toISOString().slice(0, 10);
				const prefix = `mcp_clients:${today}:`;
				let uniqueMcpClientsToday    = 0;
				let totalMcpRequestsToday    = 0;
				try {
					const list = await env.ORACLE_TELEMETRY.list({ prefix });
					uniqueMcpClientsToday = list.keys.length;
					if (list.keys.length > 0) {
						const records = await Promise.all(
							list.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name)),
						);
						for (const r of records) {
							if (r) {
								const parsed = JSON.parse(r) as { request_count?: number };
								totalMcpRequestsToday += parsed.request_count ?? 0;
							}
						}
					}
				} catch (err) {
					// KV unavailable — return zeros rather than 500.
					// Log so the error is visible in Workers Logs.
					console.error('METRICS_KV_ERROR', String(err));
				}
				const currentYear = new Date().getFullYear();
				return json({
					total_mcp_requests_today: totalMcpRequestsToday,
					unique_mcp_clients_today: uniqueMcpClientsToday,
					exchanges_covered:        SUPPORTED_EXCHANGES.length,
					edge_cases_per_year:      edgeCaseCount(currentYear).total,
					uptime_status:            'operational',
				});
			}

			// ── GET /v5/usage — per-key usage stats (requires auth) ──────
			// Shows today/month request counts, free tier limits, and upgrade info.
			// Paid keys return 0 usage counts and null limits (no metering).
			if (url.pathname === '/v5/usage') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				}
				const usageAuth = await checkApiKey(apiKey, env);
				if (!usageAuth.allowed) {
					return json({ error: usageAuth.error, message: usageAuth.message }, usageAuth.status);
				}

				const isFree   = usageAuth.plan === 'free';
				const keyHash  = await sha256Hex(apiKey);
				const keyPrefix = apiKey.length >= 14 ? apiKey.substring(0, 14) : apiKey;

				let requestsToday        = 0;
				let requestsThisMonth    = 0;
				let creditBalance        = 0;

				if (isFree) {
					// Today's usage
					requestsToday = await getDailyUsage(keyHash, env);

					// This month's usage — list all daily keys for current month and sum
					const today    = new Date();
					const yearStr  = String(today.getUTCFullYear());
					const monthStr = String(today.getUTCMonth() + 1).padStart(2, '0');
					try {
						const monthList = await env.ORACLE_TELEMETRY.list({ prefix: `free_usage:${keyHash}:${yearStr}-${monthStr}` });
						if (monthList.keys.length > 0) {
							const monthValues = await Promise.all(
								monthList.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name).catch(() => null)),
							);
							for (const v of monthValues) {
								if (v) requestsThisMonth += parseInt(v, 10) || 0;
							}
						}
					} catch { /* KV error — leave at 0 */ }

					// Credit balance
					const credits = await getCreditBalance(keyHash, env);
					creditBalance = credits.balance;
				}

				// rate_limit_resets_at: midnight UTC today (next day 00:00:00Z)
				const resetDate = new Date();
				resetDate.setUTCHours(24, 0, 0, 0);
				const rateLimitResetsAt = resetDate.toISOString();

				const dailyLimit   = isFree ? FREE_TIER_DAILY_LIMIT : null;
				const monthlyLimit = isFree ? 15000 : null;
				const pctToday     = isFree && dailyLimit ? Math.round((requestsToday / dailyLimit) * 1000) / 10 : 0;
				const pctMonth     = isFree && monthlyLimit ? Math.round((requestsThisMonth / monthlyLimit) * 1000) / 10 : 0;

				return json({
					key_prefix:              keyPrefix,
					plan:                    usageAuth.plan,
					requests_today:          requestsToday,
					requests_this_month:     requestsThisMonth,
					daily_limit:             dailyLimit,
					monthly_limit:           monthlyLimit,
					percent_used_today:      pctToday,
					percent_used_month:      pctMonth,
					rate_limit_resets_at:    rateLimitResetsAt,
					upgrade_url:             'https://headlessoracle.com/pricing',
					x402_available:          !!env.ORACLE_PAYMENT_ADDRESS,
					x402_amount:             '0.001 USDC',
					credit_balance:          creditBalance,
				});
			}

			// ── GET /v5/traction — public live metrics snapshot ──────────
			// Shows exchanges covered, uptime, MCP usage, and stack positioning.
			// No auth required. Suitable for investor / partner check-ins.
			if (url.pathname === '/v5/traction') {
				const today  = new Date().toISOString().slice(0, 10);
				const prefix = `mcp_clients:${today}:`;
				let mcpRequestsToday  = 0;
				let mcpClientsToday   = 0;
				try {
					const list = await env.ORACLE_TELEMETRY.list({ prefix });
					mcpClientsToday = list.keys.length;
					if (list.keys.length > 0) {
						const records = await Promise.all(
							list.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name)),
						);
						for (const r of records) {
							if (r) {
								const parsed = JSON.parse(r) as { request_count?: number };
								mcpRequestsToday += parsed.request_count ?? 0;
							}
						}
					}
				} catch { /* KV unavailable — return zeros */ }

				// Acquisition telemetry counters (best-effort — zeros on KV miss)
				const [batchComboKeysRaw, authCallsRaw, unauthCallsRaw, sandboxCapsRaw] = await Promise.all([
					env.ORACLE_TELEMETRY.list({ prefix: `batch_combo:` }).then(r => r.keys.filter(k => k.name.endsWith(`:${today}`))).catch(() => [] as Array<{ name: string }>),
					env.ORACLE_TELEMETRY.get(`auth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`sandbox_cap_hit:${today}`).catch(() => null),
				]);
				const batchCombosToday = batchComboKeysRaw.length;
				const authCalls        = parseInt(authCallsRaw   ?? '0', 10) || 0;
				const unauthCalls      = parseInt(unauthCallsRaw ?? '0', 10) || 0;
				const authRatioToday   = authCalls + unauthCalls > 0
					? Math.round((authCalls / (authCalls + unauthCalls)) * 100) / 100
					: null;
				const sandboxCapsToday = parseInt(sandboxCapsRaw ?? '0', 10) || 0;

				const currentYear = now.getUTCFullYear();
				const uptimeSince = env.LAUNCH_DATE ?? '2026-03-10T08:00:00Z';
				const launchDate     = new Date(uptimeSince);
				const launchMidnight = Date.UTC(launchDate.getUTCFullYear(), launchDate.getUTCMonth(), launchDate.getUTCDate());
				const todayMidnight  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
				const daysLive       = Math.floor((todayMidnight - launchMidnight) / 86400000);

				return json({
					exchanges_covered:        SUPPORTED_EXCHANGES.length,
					edge_cases_per_year:      edgeCaseCount(currentYear).total,
					uptime_since:             uptimeSince,
					days_live:                daysLive,
					mcp_requests_today:       mcpRequestsToday,
					unique_mcp_clients_today: mcpClientsToday,
					sma_spec_version:         '1.0',
					verifiable_intent_rfc:    'submitted',
					x402_enabled:             !!env.ORACLE_PAYMENT_ADDRESS,
					halt_monitor:             'active',
					batch_combos_today:       batchCombosToday,
					auth_ratio_today:         authRatioToday,
					sandbox_caps_today:       sandboxCapsToday,
				});
			}

			// ── POST /v5/keys/request — free tier key provisioning ────────
			// No auth required. Validates email, generates ho_free_ key,
			// stores in KV + Supabase, sends via Resend.
			if (url.pathname === '/v5/keys/request') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}

				// IP-based rate limit: max 3 free key requests per IP per 24 hours.
				// Key: ratelimit:keys:{ip_hash}:{YYYY-MM-DD} in ORACLE_TELEMETRY KV.
				const rawIpRl   = request.headers.get('CF-Connecting-IP') ?? '';
				const ipHashRl  = await sha256Hex(rawIpRl || 'unknown');
				const dateRl    = new Date().toISOString().slice(0, 10);
				const rlKey     = `ratelimit:keys:${ipHashRl}:${dateRl}`;
				const rlStored  = await env.ORACLE_TELEMETRY.get(rlKey).catch(() => null);
				const rlCount   = rlStored ? parseInt(rlStored, 10) : 0;
				if (rlCount >= 3) {
					return json({
						error:   'RATE_LIMITED',
						message: 'Max 3 free keys per day. Upgrade at headlessoracle.com/pricing',
					}, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
				}

				// Fail-closed: Supabase is required to issue a key.
				// We must be able to track every key we issue — a key we can't record
				// would be unrevokable and invisible to billing and abuse detection.
				// Note: use SUPABASE_SERVICE_ROLE_KEY (not SUPABASE_KEY) — the service
				// role bypasses Row Level Security, which blocks inserts with the anon key.
				if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
					console.error('KEY_REQUEST_ERROR: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
					return json({ error: 'SERVICE_UNAVAILABLE', message: 'Key issuance is temporarily unavailable — try again shortly or contact support@headlessoracle.com' }, 503);
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

				// Generate ho_free_ key — shown to the user exactly once via email.
				// The plaintext key is NEVER stored — only the sha256 hash goes to KV and Supabase.
				const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
				const keyValue    = 'ho_free_' + toHex(rawKeyBytes);
				const keyHash     = await sha256Hex(keyValue);
				const createdAt   = new Date().toISOString();

				// Step 1: Insert into Supabase first.
				// If this fails we stop — no email is sent, no KV entry is written.
				// A key we cannot track (no Supabase row) must never be issued.
				// Use SUPABASE_SERVICE_ROLE_KEY — the anon SUPABASE_KEY is blocked by RLS.
				const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
				const { error: insertError } = await supabase.from('api_keys').insert({
					id:         crypto.randomUUID(),
					key_hash:   keyHash,
					key_prefix: keyValue.substring(0, 14), // 'ho_free_' + 6 chars
					plan:       'free',
					status:     'active',
					email:      normalizedEmail,
					created_at: createdAt,
				});
				if (insertError) {
					console.error(`KEY_REQUEST_DB_ERROR: ${insertError.message} (code: ${insertError.code})`);
					return json({ error: 'KEY_CREATION_FAILED', message: 'Unable to create key — please try again or contact support@headlessoracle.com' }, 500);
				}

				// Step 2: Warm KV cache — Supabase is the source of truth; KV is the hot-path cache.
				// KV write failure is recoverable: checkApiKey falls through to Supabase on KV miss.
				if (env.ORACLE_API_KEYS) {
					await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({
						plan:       'free',
						status:     'active',
						email:      normalizedEmail,
						created_at: createdAt,
					}));
				}

				// Step 3: Send key via Resend (shown once — user cannot recover it).
				// Key is already in Supabase/KV at this point.
				// On Resend failure: return 200 with a warning field — the key is valid and
				// the user can contact support to retrieve it from the db by email address.
				if (!env.RESEND_API_KEY) {
					// Resend not configured — key is stored but cannot be delivered.
					console.error('KEY_REQUEST_ERROR: RESEND_API_KEY not configured — key stored but not delivered');
					ctx.waitUntil(env.ORACLE_TELEMETRY.put(rlKey, String(rlCount + 1), { expirationTtl: 25 * 3600 }));
					return json({ plan: 'free', warning: 'Key created and stored, but email delivery is not configured — contact support@headlessoracle.com for your key' });
				}

				const emailRes = await fetch('https://api.resend.com/emails', {
					method:  'POST',
					headers: {
						'Authorization': `Bearer ${env.RESEND_API_KEY}`,
						'Content-Type':  'application/json',
					},
					body: JSON.stringify({
						from:    'Mike at Headless Oracle <mike@headlessoracle.com>',
						to:      [normalizedEmail],
						subject: 'Your Headless Oracle API key',
						html: `<p>Hey,</p>

<p>Your Headless Oracle API key is below — keep this safe, it won't be shown again:</p>

<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px;font-family:monospace">${keyValue}</pre>

<p>Use it as the <code>X-Oracle-Key</code> header when calling <code>https://headlessoracle.com/v5/status</code>.</p>

<p><strong>Good starting points:</strong></p>
<ul>
  <li><a href="https://headlessoracle.com/docs/integrations/datacamp-workspace">DataLab / Jupyter integration guide</a> — most comprehensive walkthrough</li>
  <li><a href="https://headlessoracle.com/docs">Full documentation</a></li>
  <li><a href="https://headlessoracle.com/v5/stack">Where Oracle fits in the autonomous finance stack</a></li>
  <li><a href="https://github.com/agent-intent/verifiable-intent/pulls">External State Attestation RFC</a> — the protocol we submitted to Mastercard's Verifiable Intent framework today</li>
</ul>

<p><strong>When you hit the free tier limit (500 req/day):</strong><br>
You can pay per-request with 0.001 USDC on Base mainnet — no subscription needed. Details at <a href="https://headlessoracle.com/docs/x402-payments">headlessoracle.com/docs/x402-payments</a>.</p>

<p>Reply to this email if you have any questions — happy to jump on a call if you're building something interesting.</p>

<p>Mike<br>
<a href="mailto:mike@headlessoracle.com">mike@headlessoracle.com</a></p>`,
					}),
				});

				// Increment rate limit counter — 25-hour TTL (covers the full calendar day + drift).
				ctx.waitUntil(env.ORACLE_TELEMETRY.put(rlKey, String(rlCount + 1), { expirationTtl: 25 * 3600 }));

				if (!emailRes.ok) {
					const resendErrorBody = await emailRes.text().catch(() => '(unreadable)');
					console.error(`RESEND_ERROR: status=${emailRes.status} body=${resendErrorBody}`);
					return json({
						plan:        'free',
						warning:     'Key created and stored, but email delivery failed — contact support@headlessoracle.com for your key',
						resend_error: resendErrorBody,
					});
				}

				return json({ plan: 'free', message: 'API key sent to your email' });
			}

			// ── GET /v5/compliance — APTS compliance declaration ─────────
			// Machine-readable proof that Oracle satisfies the Agent Pre-Trade Safety Standard.
			// No auth required. Designed to be polled by CI pipelines and evaluation tools.
			if (url.pathname === '/v5/compliance') {
				return json({
					standard:         'Agent Pre-Trade Safety Standard v1.0',
					oracle:           'Headless Oracle v5',
					version:          'v5.0',
					last_verified:    '2026-03-17T00:00:00Z',
					checks: [
						{
							check:    'APTS-001',
							name:     'signed_attestation',
							status:   'pass',
							evidence: 'Ed25519 signed receipt on every response via /v5/status, /v5/demo, /v5/batch, and MCP get_market_status tool',
						},
						{
							check:    'APTS-002',
							name:     'circuit_breaker_detection',
							status:   'pass',
							evidence: 'ORACLE_OVERRIDES KV namespace — real-time HALTED/OVERRIDE status with reason field',
						},
						{
							check:    'APTS-003',
							name:     'settlement_window',
							status:   'pass',
							evidence: 'Lunch break sessions (XJPX, XHKG, XSHG, XSHE), early close days, religious holidays (Eid Al-Fitr for XSAU/XDFM), holiday calendars 2026–2027 for all 23 exchanges across 6 regions',
						},
						{
							check:    'APTS-004',
							name:     'receipt_freshness',
							status:   'pass',
							evidence: '60-second TTL — all receipts include expires_at = issued_at + 60s, signed as part of canonical payload',
						},
						{
							check:    'APTS-005',
							name:     'signature_verification',
							status:   'pass',
							evidence: 'Ed25519 via @noble/ed25519 — public key at /.well-known/oracle-keys.json — consumer SDK @headlessoracle/verify',
						},
						{
							check:    'APTS-006',
							name:     'fail_closed',
							status:   'pass',
							evidence: '4-tier fail-closed architecture: UNKNOWN status on all error paths — consumers must treat UNKNOWN as CLOSED',
						},
					],
					sma_spec_version: '1.0',
					sma_spec_url:     'https://github.com/LembaGang/sma-protocol/blob/master/SPEC.md',
					verify_sdk:       'https://npmjs.com/package/@headlessoracle/verify',
					standard_url:     'https://github.com/LembaGang/agent-pretrade-safety-standard/blob/master/STANDARD.md',
					rfc: {
						title:     'External State Attestation for Verifiable Intent',
						url:       'https://github.com/agent-intent/verifiable-intent/pulls',
						spec_url:  'https://headlessoracle.com/docs/rfc',
						submitted: '2026-03-17',
					},
				});
			}

			// ── POST /v5/credits/purchase — buy prepaid credits via x402 ─
			// -- GET /v5/stack -- autonomous finance stack positioning
				// Public endpoint. No auth required. Returns three-layer stack positioning.
				if (url.pathname === '/v5/stack') {
					return json({
						stack: {
							layer_1: {
								name:     'Authorization',
								standard: 'Mastercard Verifiable Intent',
								url:      'https://verifiableintent.dev',
							},
							layer_2: {
								name:     'Execution',
								standard: 'BVNK Layer1 / Mastercard',
								url:      'https://bvnk.com',
							},
							layer_3: {
								name:       'Verification',
								standard:   'Headless Oracle SMA Protocol v1.0',
								url:        'https://headlessoracle.com',
								rfc:        'https://github.com/agent-intent/verifiable-intent/pulls',
								compliance: 'https://headlessoracle.com/v5/compliance',
							},
						},
						description: 'Headless Oracle provides the verification layer in the autonomous finance stack. When an agent has authorization (Verifiable Intent) and payment rails (BVNK), it still needs cryptographic proof the market was open at execution time.',
						reference_implementation: 'https://headlessoracle.com/v5/compliance',
					});
				}

				if (url.pathname === '/v5/credits/purchase') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}
				if (!env.ORACLE_PAYMENT_ADDRESS) {
					return json({ error: 'SERVICE_UNAVAILABLE', message: 'Prepaid credits not available' }, 503);
				}
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				}
				const creditAuth = await checkApiKey(apiKey, env);
				if (!creditAuth.allowed) {
					return json({ error: creditAuth.error, message: creditAuth.message }, creditAuth.status);
				}
				const paymentHeader = request.headers.get('X-Payment');
				if (!paymentHeader) {
					return json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, await sha256Hex(apiKey)), 402, X402_RESPONSE_HEADERS);
				}
				let payment: X402Payment;
				try { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
					return json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
				}
				const verify = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
				if (!verify.valid) {
					return json({ error: 'PAYMENT_VERIFICATION_FAILED', message: `Payment failed: ${verify.detail ?? 'unknown'}` }, 402, X402_RESPONSE_HEADERS);
				}
				// Determine credit grant based on amount paid
				const amountPaid = BigInt(payment.amount || '0');
				let creditsToAdd = 1; // default: 1 credit per 0.001 USDC
				if (amountPaid >= BigInt(800000)) creditsToAdd = 1000;       // 0.80 USDC → 1000 credits
				else if (amountPaid >= BigInt(90000)) creditsToAdd = 100;    // 0.09 USDC → 100 credits
				const keyHash = await sha256Hex(apiKey);
				await addCredits(keyHash, creditsToAdd, env);
				return json({ purchased: creditsToAdd, message: `${creditsToAdd} credits added to your account` });
			}

			// ── GET /v5/credits/balance — credit balance for the calling key
			if (url.pathname === '/v5/credits/balance') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				}
				const balanceAuth = await checkApiKey(apiKey, env);
				if (!balanceAuth.allowed) {
					return json({ error: balanceAuth.error, message: balanceAuth.message }, balanceAuth.status);
				}
				const keyHash = await sha256Hex(apiKey);
				const credits = await getCreditBalance(keyHash, env);
				return json({
					balance:                      credits.balance,
					estimated_requests_remaining: credits.balance,
					last_purchased:               credits.last_purchased || null,
				});
			}

			// ── POST /v5/webhooks/subscribe — register a webhook for state-change events ──
			if (url.pathname === '/v5/webhooks/subscribe' && request.method === 'POST') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				const subAuth = await checkApiKey(apiKey, env);
				if (!subAuth.allowed) return json({ error: subAuth.error, message: subAuth.message }, subAuth.status);

				// Webhook subscriptions require at least a free key with MIC limits, or a paid key.
				// Sandbox keys are not eligible for persistent webhook subscriptions.
				if (subAuth.plan === 'sandbox') {
					return json({
						error:          'paid_feature',
						feature:        'webhook_subscriptions',
						available_from: 'free',
						upgrade:        'https://headlessoracle.com/pricing',
						current_plan:   'sandbox',
					}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/pricing' });
				}

				let body: { url?: unknown; mics?: unknown; secret?: unknown };
				try { body = await request.json() as typeof body; }
				catch { return json({ error: 'INVALID_REQUEST', message: 'Request body must be valid JSON' }, 400); }

				if (typeof body.url !== 'string' || !body.url.startsWith('https://')) {
					return json({ error: 'INVALID_URL', message: 'url must be an https:// endpoint' }, 400);
				}
				if (!Array.isArray(body.mics) || body.mics.length === 0) {
					return json({ error: 'INVALID_MICS', message: 'mics must be a non-empty array of MIC codes' }, 400);
				}
				const mics = (body.mics as unknown[]).filter((m): m is string => typeof m === 'string' && m in MARKET_CONFIGS);
				if (mics.length === 0) {
					return json({ error: 'INVALID_MICS', message: 'No valid MIC codes. See /v5/exchanges for supported markets.' }, 400);
				}
				const secret = typeof body.secret === 'string' && body.secret ? body.secret : crypto.randomUUID();

				const keyHash = subAuth.keyHash ?? await sha256Hex(apiKey);

				// Rate-limit: free keys max 10 MIC subscriptions total
				if (subAuth.plan === 'free') {
					const existing = await getWebhookSubscriptions(keyHash, env);
					const totalMics = existing.reduce((n, s) => n + s.mics.length, 0);
					if (totalMics + mics.length > FREE_TIER_WEBHOOK_MIC_LIMIT) {
						return json({ error: 'SUBSCRIPTION_LIMIT', message: `Free tier limit: ${FREE_TIER_WEBHOOK_MIC_LIMIT} total MIC subscriptions. Upgrade at headlessoracle.com/pricing.` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
					}
				}

				const subscription: WebhookSubscription = {
					subscription_id: crypto.randomUUID(),
					url:             body.url,
					mics,
					secret,
					created_at:      new Date().toISOString(),
				};

				// Write to subscriber's record
				const existing = await getWebhookSubscriptions(keyHash, env);
				existing.push(subscription);
				await env.ORACLE_API_KEYS.put(`webhooks:${keyHash}`, JSON.stringify(existing));

				// Add to per-MIC fan-out index
				const target: WebhookDeliveryTarget = { subscription_id: subscription.subscription_id, key_hash: keyHash, url: body.url, secret };
				for (const mic of mics) {
					const micTargets = await getWebhooksByMic(mic, env);
					micTargets.push(target);
					await env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify(micTargets));
				}

				return json({ subscription_id: subscription.subscription_id, mics, status: 'active', secret });
			}

			// ── DELETE /v5/webhooks/unsubscribe — remove a subscription ──────────
			if (url.pathname === '/v5/webhooks/unsubscribe' && request.method === 'DELETE') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				const unsubAuth = await checkApiKey(apiKey, env);
				if (!unsubAuth.allowed) return json({ error: unsubAuth.error, message: unsubAuth.message }, unsubAuth.status);

				let body: { subscription_id?: unknown };
				try { body = await request.json() as typeof body; }
				catch { return json({ error: 'INVALID_REQUEST', message: 'Request body must be valid JSON' }, 400); }

				if (typeof body.subscription_id !== 'string') {
					return json({ error: 'INVALID_REQUEST', message: 'subscription_id required' }, 400);
				}

				const keyHash = unsubAuth.keyHash ?? await sha256Hex(apiKey);
				const existing = await getWebhookSubscriptions(keyHash, env);
				const sub = existing.find((s) => s.subscription_id === body.subscription_id);
				if (!sub) return json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'No subscription with that id found for this key' }, 404);

				// Remove from subscriber record
				const updated = existing.filter((s) => s.subscription_id !== body.subscription_id);
				await env.ORACLE_API_KEYS.put(`webhooks:${keyHash}`, JSON.stringify(updated));

				// Remove from per-MIC fan-out index
				for (const mic of sub.mics) {
					const micTargets = await getWebhooksByMic(mic, env);
					const filtered   = micTargets.filter((t) => t.subscription_id !== body.subscription_id);
					await env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify(filtered));
				}

				return json({ subscription_id: body.subscription_id, status: 'deleted' });
			}

			// ── 404 ──────────────────────────────────────────────────────
			// ── GET /v5/receipts — receipt audit log (requires auth) ─────────────
			if (url.pathname === '/v5/receipts') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				const receiptsAuth = await checkApiKey(apiKey, env);
				if (!receiptsAuth.allowed) return json({ error: receiptsAuth.error, message: receiptsAuth.message }, receiptsAuth.status);

				// Receipt audit log is a paid feature — free and sandbox keys get 402 with upgrade path.
				if (receiptsAuth.plan === 'free' || receiptsAuth.plan === 'sandbox') {
					return json({
						error:          'paid_feature',
						feature:        'receipt_audit',
						available_from: 'builder',
						upgrade:        'https://headlessoracle.com/pricing',
						current_plan:   receiptsAuth.plan ?? 'free',
					}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/pricing' });
				}

				if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
					return json({ receipts: [], note: 'Audit log not available in this environment' });
				}

				const keyHash   = receiptsAuth.keyHash ?? await sha256Hex(apiKey);
				const limitRaw  = parseInt(url.searchParams.get('limit') ?? '100', 10);
				const limit     = Math.min(isNaN(limitRaw) || limitRaw < 1 ? 100 : limitRaw, 100);
				const micParam  = url.searchParams.get('mic')?.toUpperCase() ?? null;
				const fromParam = url.searchParams.get('from') ?? null;

				if (micParam && !MARKET_CONFIGS[micParam]) {
					return json({ error: 'INVALID_MIC', message: `Unknown exchange: ${micParam}. See /v5/exchanges.` }, 400);
				}

				try {
					const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
					let query = supabase
						.from('receipt_audit')
						.select('id, mic, status, source, issued_at, schema_version')
						.eq('key_hash', keyHash)
						.order('issued_at', { ascending: false })
						.limit(limit);
					if (micParam)  query = query.eq('mic', micParam);
					if (fromParam) query = query.gte('issued_at', fromParam);
					const { data, error } = await query;
					if (error) return json({ error: 'QUERY_ERROR', message: error.message }, 500);
					return json({ receipts: data ?? [], count: (data ?? []).length, limit });
				} catch (e) {
					return json({ error: 'QUERY_ERROR', message: e instanceof Error ? e.message : 'Unknown error' }, 500);
				}
			}

			// ── GET /v5/sandbox — instant no-auth sandbox key (24h, 100 calls) ───────────────────
			if (url.pathname === '/v5/sandbox' && request.method === 'GET') {
				// Rate-limit sandbox key creation: max 10 per IP per hour to prevent abuse.
				const clientIp = request.headers.get('CF-Connecting-IP') ||
					request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
				const ipHash    = await sha256Hex(clientIp);
				const hourKey   = `sandbox_rate:${ipHash}:${new Date().toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
				const hourCount = parseInt(await env.ORACLE_TELEMETRY.get(hourKey).catch(() => '0') || '0', 10);
				if (hourCount >= 10) {
					// Sandbox rate limit resets on the hour — Retry-After is seconds to next hour boundary.
					const nextHour = new Date(now);
					nextHour.setUTCMinutes(0, 0, 0);
					nextHour.setUTCHours(nextHour.getUTCHours() + 1);
					const sandboxRetryAfter = Math.max(1, Math.floor((nextHour.getTime() - now.getTime()) / 1000));
					return json({
						error:   'SANDBOX_RATE_LIMIT',
						message: 'Maximum 10 sandbox keys per IP per hour. Try again next hour or get a free key at headlessoracle.com/v5/keys/request',
						upgrade: 'https://headlessoracle.com/pricing',
					}, 429, { 'Retry-After': String(sandboxRetryAfter) });
				}

				// Generate sandbox key: sb_ prefix + 32 hex chars
				const rawKey    = `sb_${Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')}`;
				const keyHash   = await sha256Hex(rawKey);
				const expiresAt = new Date(now.getTime() + 86_400_000).toISOString(); // 24 hours

				const sandboxMeta = JSON.stringify({
					tier:       'sandbox',
					status:     'active',
					expires_at: expiresAt,
					max_calls:  100,
					created_at: now.toISOString(),
					source:     'auto_sandbox',
				});

				// Store sandbox key in ORACLE_API_KEYS KV with 24h TTL.
				if (env.ORACLE_API_KEYS) {
					await env.ORACLE_API_KEYS.put(keyHash, sandboxMeta, { expirationTtl: 86_400 });
				}

				// Increment IP rate-limit counter (90min TTL — covers hour rollover).
				await env.ORACLE_TELEMETRY.put(hourKey, String(hourCount + 1), { expirationTtl: 90 * 60 }).catch(() => {});

				// Acquisition telemetry: sandbox key creations count as unauthenticated (FINDING-13)
				incrementKvCounter(`unauth_calls:${now.toISOString().slice(0, 10)}`, env, ctx);

				return json({
					api_key:         rawKey,
					tier:            'sandbox',
					expires_at:      expiresAt,
					calls_remaining: 100,
					upgrade:         'https://headlessoracle.com/pricing',
					quickstart: {
						curl:   `curl 'https://api.headlessoracle.com/v5/status?mic=XNYS' -H 'X-Oracle-Key: ${rawKey}'`,
						node:   `const res = await fetch('https://api.headlessoracle.com/v5/status?mic=XNYS', {headers: {'X-Oracle-Key': '${rawKey}'}})`,
						python: `import httpx; r = httpx.get('https://api.headlessoracle.com/v5/status', params={'mic':'XNYS'}, headers={'X-Oracle-Key':'${rawKey}'})`,
					},
				});
			}

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
	// * * * * *  — real-time halt monitor (every minute)
	// 09:00 UTC — npm download tracking for @headlessoracle/verify
	// 17:00 UTC — MCP anonymous client usage summary (high-engagement detection)
	async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		if (event.cron === '* * * * *') {
			// Real-time halt monitor — runs every minute.
			// Checks exchanges scheduled OPEN against Polygon.io/Alpaca; writes REALTIME
			// overrides to ORACLE_OVERRIDES KV when discrepancy detected. Fail-open.
			await runHaltMonitor(env);
		} else if (event.cron === '0 9 * * *') {
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
			// EU/UK DST reminders — checked daily at 09:00 UTC to stay within the 5-cron limit.
			// March 28: one day before EU/UK spring-forward (last Sunday of March).
			// October 25: EU/UK fall-back day (last Sunday of October).
			const todayMD = new Date().toISOString().slice(5, 10); // MM-DD
			if (todayMD === '03-28') {
				console.log(JSON.stringify({
					event:              'DST_REMINDER',
					type:               'spring_forward',
					region:             'EU_UK',
					transition_date:    'March 29',
					affected_exchanges: ['XLON', 'XPAR'],
					impact:             'UK clocks GMT\u2192BST (UTC+0\u2192UTC+1), EU clocks CET\u2192CEST (UTC+1\u2192UTC+2)',
					action_required:    'Verify schedule-based logic is using IANA timezone names, not hardcoded UTC offsets. Headless Oracle handles this automatically.',
					sampled_at:         new Date().toISOString(),
				}));
			} else if (todayMD === '10-25') {
				console.log(JSON.stringify({
					event:              'DST_REMINDER',
					type:               'fall_back',
					region:             'EU_UK',
					transition_date:    'October 25',
					affected_exchanges: ['XLON', 'XPAR'],
					impact:             'UK clocks BST\u2192GMT (UTC+1\u2192UTC+0), EU clocks CEST\u2192CET (UTC+2\u2192UTC+1)',
					action_required:    'Verify schedule-based logic is using IANA timezone names, not hardcoded UTC offsets. Headless Oracle handles this automatically.',
					sampled_at:         new Date().toISOString(),
				}));
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
		} else if (event.cron === '0 9 * * 1') {
			// Weekly digest — runs Monday 09:00 UTC.
			// Summarises past 7 days of MCP client activity and writes weekly_digest KV key.
			await runWeeklyDigest(env);
		}
	},
};
