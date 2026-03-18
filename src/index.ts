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

type AuthResult = { allowed: true; plan: string } | { allowed: false; status: 402 | 403; error: string; message: string };

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
			const { plan, status } = JSON.parse(cached) as { plan: string; status: string };
			if (status === 'active') return { allowed: true, plan };
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
			if (data.status === 'active') return { allowed: true, plan: data.plan };
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
const FREE_TIER_DAILY_LIMIT = 500;
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

> Market status API built for AI agents. Cryptographically signed attestations of whether global stock exchanges are OPEN, CLOSED, HALTED, or UNKNOWN — purpose-built for autonomous trading agents, DeFi bots, and AI-driven execution systems in the tokenized RWA economy.

This is a defensive execution layer — not a price feed. It is a compliance-grade safety primitive that prevents automated systems from executing trades during market closures, circuit breaker halts, holiday closures, and unscheduled outages. Every API response is a Liability Receipt: cryptographically signed, timestamped, independently verifiable proof that your agent checked before it executed.

## Supported Exchanges (23)

XNYS — New York Stock Exchange
XNAS — NASDAQ
XLON — London Stock Exchange
XJPX — Japan Exchange Group (Tokyo) — has lunch break
XPAR — Euronext Paris
XHKG — Hong Kong Stock Exchange — has lunch break
XSES — Singapore Exchange
XASX — Australian Securities Exchange (Sydney)
XBOM — BSE Ltd (Bombay Stock Exchange, Mumbai)
XNSE — National Stock Exchange of India (Mumbai)
XSHG — Shanghai Stock Exchange — has lunch break
XSHE — Shenzhen Stock Exchange — has lunch break
XKRX — Korea Exchange (Seoul)
XJSE — Johannesburg Stock Exchange
XBSP — B3 (São Paulo Stock Exchange)
XSWX — SIX Swiss Exchange (Zurich)
XMIL — Borsa Italiana (Milan)
XIST — Borsa Istanbul
XSAU — Saudi Exchange (Tadawul, Riyadh) — weekends: Fri–Sat; Sunday is a trading day
XDFM — Dubai Financial Market — weekends: Fri–Sat; Sunday is a trading day
XNZE — New Zealand Exchange (Auckland)
XHEL — Nasdaq Helsinki
XSTO — Nasdaq Stockholm

All exchanges use ISO 10383 Market Identifier Codes (MIC).

## Timezone Coverage

Americas: XNYS/XNAS (America/New_York), XBSP (America/Sao_Paulo)
Europe: XLON (Europe/London), XPAR (Europe/Paris), XSWX (Europe/Zurich), XMIL (Europe/Rome), XIST (Europe/Istanbul), XHEL (Europe/Helsinki), XSTO (Europe/Stockholm)
Middle East: XSAU (Asia/Riyadh), XDFM (Asia/Dubai)
Asia: XJPX (Asia/Tokyo), XHKG (Asia/Hong_Kong), XSES (Asia/Singapore), XSHG/XSHE (Asia/Shanghai), XBOM/XNSE (Asia/Kolkata), XKRX (Asia/Seoul)
Africa: XJSE (Africa/Johannesburg)
Pacific: XASX (Australia/Sydney), XNZE (Pacific/Auckland)

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
- Response fields: \`receipt_id\` (UUID), \`issued_at\` (ISO 8601), \`expires_at\` (ISO 8601), \`mic\` (string), \`status\` (enum: OPEN | CLOSED | HALTED | UNKNOWN), \`source\` (enum: SCHEDULE | OVERRIDE | SYSTEM | REALTIME), \`receipt_mode\` (enum: demo | live), \`schema_version\` (string), \`public_key_id\` (string), \`signature\` (hex-encoded Ed25519)
- [Full API docs](https://headlessoracle.com/docs.html)

### GET /v5/schedule — Market Schedule Lookup (Unsigned)

Returns next open/close times for a given exchange. Use for planning execution windows and scheduling tasks around market hours. Includes lunch break windows for XJPX and XHKG.

- NOT cryptographically signed — schedule-based only, does not reflect real-time halts
- For verified real-time status, use /v5/status instead

### GET /v5/exchanges — Exchange Discovery

Returns all 23 supported exchanges with MIC codes, full names, and IANA timezone identifiers. Use to discover available markets or resolve exchange names to MIC codes.

### GET /mics.json — Exchange Registry (ISO Metadata)

All 23 supported exchanges with MIC codes, names, timezones, currencies, and ISO 20022 registry links. No auth required.

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

Across all 23 exchanges, approximately **5,000+ schedule edge cases per year** fall into one of the above categories. A hardcoded timezone offset handles zero of them.

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

## Compliance and Standards

### GET /v5/compliance — APTS Self-Report

Returns a machine-readable compliance report for the Agent Pre-Trade Safety Standard (APTS v1.0). Use to verify that Oracle meets your compliance requirements before integrating.

- No authentication required
- Response: \`checks\` array — 6 pre-trade safety checks, each with \`id\`, \`description\`, \`status\` ("pass" | "fail")
- Also returns \`standard\`, \`standard_version\`, \`sma_spec_version\`, \`verify_sdk\`, \`standard_url\`

Checks performed:
1. \`signed_attestation\` — All market status responses are cryptographically signed (Ed25519)
2. \`circuit_breaker_detection\` — Unscheduled halts propagated via KV override within operator SLA
3. \`settlement_window_verification\` — Exchange schedule includes pre-open and post-close windows
4. \`receipt_ttl_enforcement\` — All receipts include expires_at (60s TTL), signed in canonical payload
5. \`signature_verification\` — Ed25519 signatures verifiable via @headlessoracle/verify SDK
6. \`fail_closed_on_unknown\` — UNKNOWN status contractually requires halt — never treated as OPEN

### Signed Market Attestation (SMA) Protocol v1.0

Headless Oracle receipts conform to the SMA Protocol v1.0 — a vendor-neutral open standard for cryptographically attested market state.

SMA receipt fields: \`mic\`, \`status\`, \`timestamp\`, \`expires_at\`, \`issuer\`, \`key_id\`, \`receipt_mode\`, \`signature\`

Signing algorithm: Ed25519 over alphabetically-sorted compact JSON (excluding \`signature\` field).

Any conforming oracle can issue SMA receipts. Any conforming verifier can verify them independently.

## x402 Micropayments

Headless Oracle supports the x402 protocol: agents can pay per request in USDC on Base mainnet without a subscription.

- **Amount**: 0.001 USDC (1000 units at 6 decimals) per request
- **Network**: Base mainnet (chainId 8453)
- **When it applies**: Free tier keys (ho_free_*) after 500 req/day limit
- **How it works**: On limit exhaustion the server returns HTTP 402 with a machine-readable x402 payload. The agent sends USDC and retries with X-Payment header.

### POST /v5/credits/purchase — Prepaid Credits

Buy credits in bulk to avoid per-request on-chain payments.

- Required header: X-Oracle-Key
- Required header: X-Payment (USDC tx on Base mainnet)
- 100 credits = 90000 USDC units (0.09 USDC)
- 1000 credits = 800000 USDC units (0.80 USDC)
- Credits are consumed before x402 per-request payments kick in

### GET /v5/credits/balance — Credit Balance

Returns remaining prepaid credit balance for the authenticated key.

- Required header: X-Oracle-Key
- Response: balance, estimated_requests_remaining, last_purchased

### GET /v5/errors/{code} — Error Documentation

Machine-readable documentation for any error code returned by the API.

- No authentication required
- Response: code, message, resolution, http_status, docs_url
- Example: GET /v5/errors/PAYMENT_REQUIRED

### GET /v5/metrics — Usage Metrics

Returns today's MCP request count and unique client count from telemetry.

- No authentication required
- Response: total_mcp_requests_today, unique_mcp_clients_today, date

Full guide: https://headlessoracle.com/docs/x402-payments.md

## Autonomous Halt Monitoring

Headless Oracle runs an autonomous halt monitor every minute via Cloudflare Cron. It checks exchanges that are currently scheduled OPEN against real-time market data sources and writes REALTIME override signals to the circuit breaker KV when a discrepancy is detected.

- **Cron**: \`* * * * *\` (every minute)
- **Sources**: Polygon.io (primary, requires POLYGON_API_KEY secret) → Alpaca paper-api (fallback, US markets only)
- **Behavior**: Fail-open — if both sources are unavailable, the schedule-based status is preserved. No false halts on API errors.
- **Override TTL**: 2 hours — auto-clears when the exchange resumes trading
- **Source field**: REALTIME overrides set \`source: 'REALTIME'\` in the signed receipt, distinguishable from manual OVERRIDE entries

### GET /v5/status/realtime — Real-Time Status with Halt Monitor Metadata

Authenticated endpoint that returns the standard signed receipt plus halt monitor state for a specific exchange.

- Required header: X-Oracle-Key
- Optional parameter: mic (default: XNYS)
- Response: signed_receipt (full signed receipt), halt_monitor (active_realtime_override if any, note)

## Agent Discovery

- [Skill File](https://headlessoracle.com/SKILL.md): Step-by-step integration guide optimised for AI agents. Covers MCP setup, HTTP patterns, code examples, safety rules, and common mistakes.
- [Agent Metadata](https://headlessoracle.com/.well-known/agent.json): Structured JSON describing capabilities, MCP tools, payment scheme, and discovery endpoints.
- [OpenAPI Spec](https://headlessoracle.com/openapi.json): Machine-readable API contract (OpenAPI 3.1).
- [MCP Endpoint](https://headlessoracle.com/mcp): Protocol version 2024-11-05. Tools: get_market_status, get_market_schedule, list_exchanges.
- [APTS Compliance](https://headlessoracle.com/v5/compliance): Machine-readable Agent Pre-Trade Safety Standard compliance self-report.
- [Traction](https://headlessoracle.com/v5/traction): Live metrics — exchanges covered, uptime, MCP usage today, stack positioning. No auth required.
- [x402 Guide](https://headlessoracle.com/docs/x402-payments.md): Per-request micropayment protocol for agent-native API access.
- [SMA Specification](https://github.com/LembaGang/sma-protocol): Signed Market Attestation Protocol v1.0 (GitHub — Apache 2.0).
- [Error Docs](https://headlessoracle.com/v5/errors/PAYMENT_REQUIRED): Machine-readable error documentation for any error code.

## Standards & RFCs

- SMA Protocol v1.0: https://github.com/LembaGang/sma-protocol
- External State Attestation RFC: submitted to https://github.com/agent-intent/verifiable-intent on 2026-03-17
- Agent Pre-Trade Safety Standard: https://github.com/LembaGang/agent-pretrade-safety-standard
- Verifiable Intent compatibility: headlessoracle.com implements the reference oracle for the proposed environment.market_state constraint type

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

// agent.json — structured agent metadata for programmatic discovery.
// Follows the emerging agent.json convention (no formal spec yet — designed to be stable).
// Intentionally minimal: capabilities, tools, endpoints, and trust anchors only.
const AGENT_JSON = {
	schema_version: '1.0',
	spec_version:   DEPLOY_DATE,
	name:           'Headless Oracle',
	description:    'Cryptographically signed market-state attestations for AI agents. Ed25519-signed receipts for 23 global exchanges. Fail-closed: UNKNOWN always means CLOSED.',
	url:            'https://headlessoracle.com',
	capabilities: [
		'market_status',
		'market_schedule',
		'exchange_directory',
		'batch_query',
		'signed_receipts',
		'portable_receipts',
		'mcp_tools',
		'compliance_check',
		'sma_attestation',
		'x402_micropayments',
	],
	payment: {
		schemes:              ['x402'],
		network:              'base-mainnet',
		chain_id:             8453,
		currency:             'USDC',
		amount_per_request:   '0.001',
		payment_address_env:  'ORACLE_PAYMENT_ADDRESS',
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
			{ path: '/mics.json',             method: 'GET',  auth: false, description: 'GET /mics.json — all 23 supported MICs with exchange metadata and ISO 20022 registry links' },
			{ path: '/v5/keys',               method: 'GET',  auth: false, description: 'Public key registry + canonical payload spec' },
			{ path: '/v5/health',             method: 'GET',  auth: false, description: 'Signed liveness probe' },
			{ path: '/.well-known/oracle-keys.json', method: 'GET', auth: false, description: 'RFC 8615 key discovery' },
			{ path: '/v5/compliance',               method: 'GET', auth: false, description: 'APTS compliance self-report — 6 pre-trade safety checks' },
			{ path: '/v5/metrics',                  method: 'GET', auth: false, description: 'MCP client telemetry — today\'s request and unique client counts' },
			{ path: '/v5/traction',                 method: 'GET', auth: false, description: 'Live traction metrics — exchanges, uptime, MCP usage, stack positioning' },
			{ path: '/v5/usage',                    method: 'GET', auth: true,  description: 'Per-key usage stats — requests today/month, limits, credits, upgrade info' },
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
			'Check whether a stock exchange is currently open or closed. ' +
			'Call this before executing trades, scheduling market-hours workflows, or routing orders. ' +
			'Returns a cryptographically signed receipt with status OPEN, CLOSED, HALTED, or UNKNOWN. ' +
			'MANDATORY: treat UNKNOWN or HALTED as CLOSED and halt execution. ' +
			'Do not act on a receipt past its expires_at timestamp. ' +
			'Supported exchanges: NYSE (XNYS), NASDAQ (XNAS), London (XLON), Tokyo (XJPX), ' +
			'Paris (XPAR), Hong Kong (XHKG), Singapore (XSES), Sydney (XASX), Mumbai BSE (XBOM), ' +
			'Mumbai NSE (XNSE), Shanghai (XSHG), Shenzhen (XSHE), Seoul (XKRX), Johannesburg (XJSE), ' +
			'São Paulo (XBSP), Zurich (XSWX), Milan (XMIL), Istanbul (XIST), Riyadh (XSAU), ' +
			'Dubai (XDFM), Auckland (XNZE), Helsinki (XHEL), Stockholm (XSTO).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'Exchange identifier (MIC code). Common values: XNYS=NYSE, XNAS=NASDAQ, ' +
						'XLON=London, XJPX=Tokyo, XPAR=Paris, XHKG=Hong Kong, XSES=Singapore. ' +
						'Use list_exchanges to see all 23 supported exchanges. Defaults to XNYS.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO'],
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
			'Includes lunch break windows for Tokyo (XJPX), Hong Kong (XHKG), Shanghai (XSHG), and Shenzhen (XSHE) where applicable. ' +
			'NOT cryptographically signed — does not reflect real-time halts or circuit breakers. ' +
			'For verified real-time status, use get_market_status instead. ' +
			'Use list_exchanges to see all 23 supported exchanges.',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'Exchange identifier (MIC code). Common values: XNYS=NYSE, XNAS=NASDAQ, ' +
						'XLON=London, XJPX=Tokyo, XPAR=Paris, XHKG=Hong Kong, XSES=Singapore. ' +
						'Defaults to XNYS.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO'],
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
			'Returns MIC codes, full exchange names, and IANA timezone identifiers for all 23 supported markets.',
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

async function runHaltMonitor(env: Env): Promise<void> {
	const now = new Date();
	const results: HaltMonitorResult[] = [];

	for (const [mic, config] of Object.entries(MARKET_CONFIGS)) {
		// Only check exchanges that are scheduled OPEN right now
		let scheduleResult: MarketStatusResult;
		try {
			scheduleResult = getScheduleStatus(mic, config, now);
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
				const errorCode = (body as Record<string, unknown>).error as string;
				responseBody = {
					...(body as Record<string, unknown>),
					docs: `https://headlessoracle.com/docs`,
				};
			}
			return new Response(JSON.stringify(responseBody), {
				status,
				headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Oracle-Version': 'v5', ...extraHeaders },
			});
		};

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
				// ── Free tier daily limit + x402 micropayment gate ───────────
				if (auth.plan === 'free') {
					const keyHash = await sha256Hex(apiKey);
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
								return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/pricing' }, 429);
							}
						}
					} else {
						incrementDailyUsage(keyHash, env, ctx, usage);
					}
				}
			}

			// Helper: wrap a Response to add soft rate-limit warning headers for free tier.
			// Only applies when freeTierPercentUsed >= 80. No-op for paid or public routes.
			const withRateLimitWarning = (response: Response): Response => {
				if (freeTierPercentUsed < 80) return response;
				const newHeaders = new Headers(response.headers);
				addRateLimitWarningHeaders(newHeaders, freeTierPercentUsed, 'https://headlessoracle.com/pricing');
				return new Response(response.body, { status: response.status, headers: newHeaders });
			};

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
				const { receipt, status } = await buildSignedReceipt(mic, env, now, expiresAt, mode);
				// Receipts must not be cached — they expire in 60s and contain real-time status.
				return withRateLimitWarning(json(receipt, status, { 'Cache-Control': 'no-store' }));
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
				// Free tier limit check for batch
				if (batchAuth.plan === 'free') {
					const batchKeyHash = await sha256Hex(apiKey);
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
								return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/pricing' }, 429);
							}
						}
					} else {
						incrementDailyUsage(batchKeyHash, env, ctx, batchUsage);
					}
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

				return withRateLimitWarning(json({
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

					return json({
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
					}, 429);
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
							from:    'Mike at Headless Oracle <mike@headlessoracle.com>',
							to:      [normalizedEmail],
							subject: 'Your Headless Oracle API key',
							html: `<p>Hey,</p>

<p>Your Headless Oracle API key is below — keep this safe, it won’t be shown again:</p>

<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px;font-family:monospace">${keyValue}</pre>

<p>Use it as the <code>X-Oracle-Key</code> header when calling <code>https://headlessoracle.com/v5/status</code>.</p>

<p><strong>Good starting points:</strong></p>
<ul>
  <li><a href="https://headlessoracle.com/docs/integrations/datacamp-workspace">DataLab / Jupyter integration guide</a> — most comprehensive walkthrough</li>
  <li><a href="https://headlessoracle.com/docs">Full documentation</a></li>
  <li><a href="https://headlessoracle.com/v5/stack">Where Oracle fits in the autonomous finance stack</a></li>
  <li><a href="https://github.com/agent-intent/verifiable-intent/pulls">External State Attestation RFC</a> — the protocol we submitted to Mastercard’s Verifiable Intent framework today</li>
</ul>

<p><strong>When you hit the free tier limit (500 req/day):</strong><br>
You can pay per-request with 0.001 USDC on Base mainnet — no subscription needed. Details at <a href="https://headlessoracle.com/docs/x402-payments">headlessoracle.com/docs/x402-payments</a>.</p>

<p>Reply to this email if you have any questions — happy to jump on a call if you’re building something interesting.</p>

<p>Mike<br>
<a href="mailto:mike@headlessoracle.com">mike@headlessoracle.com</a></p>`,
						}),
					});
					if (!emailRes.ok) {
						console.error(`RESEND_ERROR: failed to send free key email to ${normalizedEmail}`);
					}
				}

				// Increment rate limit counter — 25-hour TTL (covers the full calendar day + drift).
				ctx.waitUntil(env.ORACLE_TELEMETRY.put(rlKey, String(rlCount + 1), { expirationTtl: 25 * 3600 }));

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
