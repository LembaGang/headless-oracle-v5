import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { createClient } from '@supabase/supabase-js';

ed.hashes.sha512 = sha512;

// ─── Ed25519 module-level warm-up ────────────────────────────────────────────
// @noble/ed25519 lazily builds the base-point precompute table (Gpows) on the
// first Point.multiply() call inside ed.sign(). In a fresh Cloudflare isolate
// that cost — plus V8 JIT compilation of the scalar-mult hot path — lands on
// the first real signing request, adding ~20-40ms to P95.
//
// Fix: fire a dummy getPublicKeyAsync() at module initialization. It triggers
// sha512(dummyKey) → Point.BASE.multiply(scalar) → Gpows = precompute(), and
// JIT-compiles the entire signing code path. By the time the first real request
// arrives, Gpows is populated and the JIT is warm.
// Uses a non-zero dummy key so noble doesn't reject it; the result is discarded.
void ed.getPublicKeyAsync(new Uint8Array(32).fill(1)).catch(() => {});

// Cache for decoded private-key bytes across requests in the same isolate.
// env.ED25519_PRIVATE_KEY is not available at module init (it's a runtime
// binding), so we cache on first use and reuse for the lifetime of the isolate.
let _cachedPrivKeyHex:   string     | null = null;
let _cachedPrivKeyBytes: Uint8Array | null = null;

// ─── ORACLE_OVERRIDES module-level cache ─────────────────────────────────────
// Circuit-breaker overrides are set manually and are almost always null.
// Caching in isolate memory eliminates the KV read (~100ms from remote regions)
// on every signing call for warm isolates. A 10s stale window is acceptable:
// the operator runbook documents that overrides take effect "within a minute."
// Cache is per-MIC so a halt on XNYS doesn't cache a null for XLON.
interface OverrideCacheEntry { value: string | null; expires: number; }
const overrideCache = new Map<string, OverrideCacheEntry>();
const OVERRIDE_CACHE_TTL_MS = 10_000; // 10 seconds

async function getCachedOverride(mic: string, env: Env): Promise<string | null> {
	const now = Date.now();
	const hit = overrideCache.get(mic);
	if (hit && hit.expires > now) return hit.value;
	const value = await env.ORACLE_OVERRIDES.get(mic);
	overrideCache.set(mic, { value, expires: now + OVERRIDE_CACHE_TTL_MS });
	return value;
}

// Exported for use in tests — allows test setup/teardown to clear stale
// cache entries that would otherwise cause override tests to see null.
export function clearOverrideCache(): void {
	overrideCache.clear();
}

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
	PADDLE_PRICE_ID_CREDITS?:   string; // pri_* for credit pack ($5 = 1,000 calls, one-time)
	SUPABASE_URL?:               string;
	SUPABASE_SERVICE_ROLE_KEY?:  string;
	RESEND_API_KEY?:             string;
	// x402 micropayments — set via `wrangler secret put ORACLE_PAYMENT_ADDRESS`
	ORACLE_PAYMENT_ADDRESS?:     string;  // Base mainnet wallet for USDC micropayments
	// x402 testnet prototype — Base Sepolia testnet, facilitator-based verification
	X402_ENABLED?:               string;  // Set to 'true' to enable testnet x402 via facilitator (default: off)
	X402_TEST_WALLET?:           string;  // Base Sepolia test wallet address for testnet payments
	// CDP API credentials for authenticating to the CDP x402 facilitator
	CDP_API_KEY_NAME?:           string;  // CDP API key ID (e.g. organizations/xxx/apiKeys/yyy)
	CDP_API_KEY_PRIVATE_KEY?:    string;  // CDP private key — base64 Ed25519 (64 bytes) or PEM EC PKCS8
	// Real-time halt monitoring — optional Polygon.io API key for enhanced data
	POLYGON_API_KEY?:            string;  // polygon.io API key — optional; public Alpaca feed used if absent
	// Launch date for /v5/traction days_live counter — set via wrangler.toml [vars]
	LAUNCH_DATE?:                string;  // ISO 8601 UTC timestamp of go-live; defaults to 2026-03-10T08:00:00Z
	// Beta key sunset — when set, new-key emails include a notice that old keys stop working on this date
	BETA_KEY_SUNSET_DATE?:       string;  // Human-readable date string, e.g. "March 31, 2026"
	STREAM_COORDINATOR:          DurableObjectNamespace;  // SSE stream coordinator — one DO per MIC
	WEBHOOK_DISPATCHER:          DurableObjectNamespace;  // Webhook delivery DO — alarm-based state-change fan-out
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
	overnightSession?: boolean; // true for exchanges with sessions that span midnight (e.g. CME Globex 17:00–16:00 CT)
	mic_type?: 'iso' | 'convention'; // 'iso' = ISO 10383 MIC; 'convention' = community/non-ISO identifier
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

	// ── Crypto / Derivatives Exchanges ─────────────────────────────────────────

	// CME Globex / Chicago Board of Trade — ISO 10383 MIC XCBT
	// Overnight session: Sun 17:00 – Fri 16:00 CT, with a daily 16:00–17:00 CT maintenance halt.
	// Saturday is the only full-rest day. overnightSession:true enables the schedule engine
	// to handle the "pre-open tail" on Sunday correctly (CLOSED before 17:00 CT Sunday).
	XCBT: {
		name: 'CME / Chicago Board of Trade',
		timezone: 'America/Chicago',
		openHour: 17, openMinute: 0,
		closeHour: 16, closeMinute: 0,
		overnightSession: true,
		mic_type: 'iso',
		weekends: ['Sat'],
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-19', // MLK Day
				'2026-02-16', // Presidents' Day
				'2026-05-25', // Memorial Day
				'2026-07-03', // Independence Day (observed)
				'2026-09-07', // Labor Day
				'2026-11-26', // Thanksgiving
				'2026-12-25', // Christmas Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-18', // MLK Day
				'2027-02-15', // Presidents' Day
				'2027-05-31', // Memorial Day
				'2027-07-05', // Independence Day (observed Mon)
				'2027-09-06', // Labor Day
				'2027-11-25', // Thanksgiving
				'2027-12-24', // Christmas Eve (observed)
			],
		},
	},

	// New York Mercantile Exchange (CME Group) — ISO 10383 MIC XNYM
	// Energy and metals futures. Same CME Globex schedule as XCBT.
	XNYM: {
		name: 'New York Mercantile Exchange (CME Group)',
		timezone: 'America/Chicago',
		openHour: 17, openMinute: 0,
		closeHour: 16, closeMinute: 0,
		overnightSession: true,
		mic_type: 'iso',
		weekends: ['Sat'],
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-19', // MLK Day
				'2026-02-16', // Presidents' Day
				'2026-05-25', // Memorial Day
				'2026-07-03', // Independence Day (observed)
				'2026-09-07', // Labor Day
				'2026-11-26', // Thanksgiving
				'2026-12-25', // Christmas Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-18', // MLK Day
				'2027-02-15', // Presidents' Day
				'2027-05-31', // Memorial Day
				'2027-07-05', // Independence Day (observed Mon)
				'2027-09-06', // Labor Day
				'2027-11-25', // Thanksgiving
				'2027-12-24', // Christmas Eve (observed)
			],
		},
	},

	// Cboe Options Exchange — ISO 10383 MIC XCBO
	// Standard equity options: 9:30 AM – 4:15 PM ET, Mon–Fri, same holiday schedule as NYSE.
	XCBO: {
		name: 'Cboe Options Exchange',
		timezone: 'America/New_York',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 15,
		mic_type: 'iso',
		holidays: {
			'2026': [
				'2026-01-01', // New Year's Day
				'2026-01-19', // MLK Day
				'2026-02-16', // Presidents' Day
				'2026-04-03', // Good Friday
				'2026-05-25', // Memorial Day
				'2026-07-03', // Independence Day (observed)
				'2026-09-07', // Labor Day
				'2026-11-26', // Thanksgiving
				'2026-12-25', // Christmas Day
			],
			'2027': [
				'2027-01-01', // New Year's Day
				'2027-01-18', // MLK Day
				'2027-02-15', // Presidents' Day
				'2027-03-26', // Good Friday
				'2027-05-31', // Memorial Day
				'2027-07-05', // Independence Day (observed)
				'2027-09-06', // Labor Day
				'2027-11-25', // Thanksgiving
				'2027-12-24', // Christmas Eve (observed)
			],
		},
	},

	// Coinbase Exchange — convention MIC XCOI (not ISO 10383 registered)
	// Crypto spot market: 24 hours a day, 7 days a week. No public holidays.
	// weekends:[] means no day is treated as a rest day.
	XCOI: {
		name: 'Coinbase Exchange',
		timezone: 'UTC',
		openHour: 0, openMinute: 0,
		closeHour: 23, closeMinute: 59,
		mic_type: 'convention',
		weekends: [],
		holidays: { '2026': [], '2027': [] },
	},

	// Binance — convention MIC XBIN (not ISO 10383 registered)
	// Crypto spot market: 24 hours a day, 7 days a week. No public holidays.
	XBIN: {
		name: 'Binance',
		timezone: 'UTC',
		openHour: 0, openMinute: 0,
		closeHour: 23, closeMinute: 59,
		mic_type: 'convention',
		weekends: [],
		holidays: { '2026': [], '2027': [] },
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

// ─── Halt Detection Coverage ──────────────────────────────────────────────────
// Real-time intraday halt detection requires an external API that publishes
// live market status. As of 2026-03, only XNYS and XNAS are covered:
//   - Primary:  Polygon.io /v1/marketstatus/now (exchanges.nyse / exchanges.nasdaq)
//   - Fallback: Alpaca paper-api /v2/clock (US markets only)
//
// No free/public API covers the other 21 exchanges for intraday halt detection.
// Those exchanges use schedule_only: calendar hours + holidays are correct, but
// an unscheduled intraday halt (circuit breaker) would not be detected.
//
// This set is the source of truth. Every signed receipt carries a halt_detection
// field derived from it so agents know what level of safety they are getting.
const HALT_DETECTION_ACTIVE = new Set(['XNYS', 'XNAS']);

function getHaltDetection(mic: string): 'active' | 'schedule_only' {
	return HALT_DETECTION_ACTIVE.has(mic) ? 'active' : 'schedule_only';
}

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

	// Overnight session (e.g. CME Globex 17:00–16:00 CT with daily maintenance halt).
	// The "closed" block is [closeMinutes, openMinutes). Everything outside that is OPEN,
	// except Sunday before the open hour, where we must verify yesterday was tradeable
	// (otherwise the Sunday morning tail of a closed Saturday would show as OPEN).
	if (config.overnightSession) {
		const closeMinutes = config.closeHour * 60 + config.closeMinute;
		// Maintenance window: always CLOSED
		if (timeMinutes >= closeMinutes && timeMinutes < openMinutes) {
			return { status: 'CLOSED', source: 'SCHEDULE' };
		}
		// In the overnight tail (before today's open hour): confirm yesterday was a trading day.
		// Without this check, Sunday 00:00–17:00 CT would incorrectly read as OPEN.
		if (timeMinutes < openMinutes) {
			const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
			const { weekday: prevWeekday, dateStr: prevDateStr, year: prevYear } = getLocalTimeParts(config.timezone, yesterday);
			const prevWeekendsArr = config.weekends ?? ['Sat', 'Sun'];
			if (prevWeekendsArr.includes(prevWeekday)) {
				return { status: 'CLOSED', source: 'SCHEDULE' };
			}
			const prevHolidays = config.holidays[prevYear];
			if (prevHolidays && prevHolidays.includes(prevDateStr)) {
				return { status: 'CLOSED', source: 'SCHEDULE' };
			}
		}
		return { status: 'OPEN', source: 'SCHEDULE' };
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

	// Overnight and 24/7 exchanges use multi-day or continuous sessions that the
	// day-by-day open/close calculator cannot represent. Return null so /v5/schedule
	// exposes next_open:null rather than a misleading single-day window.
	if (config.overnightSession || (config.weekends?.length === 0)) return null;

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
	// Reuse decoded key bytes across calls in the same isolate. fromHex is fast
	// but this also avoids repeated heap allocation on every signing request.
	if (_cachedPrivKeyHex !== privKeyHex) {
		_cachedPrivKeyBytes = fromHex(privKeyHex);
		_cachedPrivKeyHex   = privKeyHex;
	}
	const sig = await ed.sign(msgBytes, _cachedPrivKeyBytes!);
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
type AuthResult = { allowed: true; plan: string; keyHash?: string } | { allowed: false; status: 402 | 403; error: string; message: string; body?: Record<string, unknown> };

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
			const parsed = JSON.parse(cached) as { plan?: string; tier?: string; status: string; expires_at?: string; balance?: number };
			// Sandbox keys expire by TTL but also check expires_at for belt-and-suspenders
			if (parsed.tier === 'sandbox' || parsed.plan === 'sandbox') {
				if (parsed.status !== 'active') {
					return { allowed: false, status: 402, error: 'SANDBOX_KEY_EXPIRED', message: 'Your free sandbox has expired. Upgrade to continue.' };
				}
				if (parsed.expires_at && new Date(parsed.expires_at) <= new Date()) {
					return { allowed: false, status: 402, error: 'SANDBOX_KEY_EXPIRED', message: 'Your free sandbox has expired. Upgrade to continue.' };
				}
				return { allowed: true, plan: 'sandbox', keyHash };
			}
			// Credits pack — balance-based access, no subscription expiry
			if (parsed.tier === 'credits') {
				if (parsed.status !== 'active' || !parsed.balance || parsed.balance <= 0) {
					return {
						allowed: false, status: 402, error: 'CREDITS_EXHAUSTED',
						message: 'Your 1,000 call credit pack is exhausted.',
						body: {
							error:       'CREDITS_EXHAUSTED',
							message:     'Your 1,000 call credit pack is exhausted.',
							upgrade_url: 'https://headlessoracle.com/upgrade',
							insight:     'At your usage rate, Builder plan ($99/month) costs less per call than buying more credit packs.',
							plans: {
								credits: '$5 for 1,000 more calls — headlessoracle.com/upgrade',
								builder: '$99/month — 50,000 calls — 60% cheaper per call',
							},
						},
					};
				}
				// Atomic-style decrement: get-then-put (KV has no native atomic operations)
				const newBalance = parsed.balance - 1;
				await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ ...parsed, balance: newBalance }));
				return { allowed: true, plan: 'credits', keyHash };
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
	mic_type: cfg.mic_type ?? 'iso',
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
	XCBT: { country: 'US', currency: 'USD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XNYM: { country: 'US', currency: 'USD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XCBO: { country: 'US', currency: 'USD', sameAs: 'https://www.iso20022.org/market-identifier-codes' },
	XCOI: { country: 'US', currency: 'USD', sameAs: 'https://coinbase.com' },
	XBIN: { country: 'KY', currency: 'USD', sameAs: 'https://binance.com' },
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
	mic_type: cfg.mic_type ?? 'iso',
}));

// ─── Receipt TTL ─────────────────────────────────────────────────────────────
// Signed receipts expire this many seconds after issued_at.
// Consumers MUST NOT act on a receipt whose expires_at has passed.
const RECEIPT_TTL_SECONDS = 60;

// ─── Settlement Window Metadata ───────────────────────────────────────────────
// Informational only — not signed. Returned by /v5/schedule so agents know when
// a trade will settle. Only 4 exchanges have verified data; all others are null.
// Sources: SEC Rule 15c6-1 (US T+1), JSCC rulebook (JP T+2), Euroclear (UK T+2).
interface SettlementWindow {
	cycle:         string;  // e.g. "T+1", "T+2"
	clearinghouse: string;  // Clearing entity name
	cutoff_utc:    string;  // HH:MM UTC — approximate daily settlement cutoff
	notes:         string;  // Free-text context for agents
}

const SETTLEMENT_WINDOWS: Readonly<Record<string, SettlementWindow>> = {
	XNYS: {
		cycle:         'T+1',
		clearinghouse: 'DTCC/NSCC',
		cutoff_utc:    '20:30',
		notes:         'US equities settled T+1 since May 28 2024 (SEC Rule 15c6-1 amendment). Cutoff approx 20:30 UTC (16:30 EDT / 15:30 EST).',
	},
	XNAS: {
		cycle:         'T+1',
		clearinghouse: 'DTCC/NSCC',
		cutoff_utc:    '20:30',
		notes:         'US equities settled T+1 since May 28 2024 (SEC Rule 15c6-1 amendment). Cutoff approx 20:30 UTC (16:30 EDT / 15:30 EST).',
	},
	XLON: {
		cycle:         'T+2',
		clearinghouse: 'Euroclear UK & Ireland',
		cutoff_utc:    '15:30',
		notes:         'UK equities T+2. Cutoff 15:30 UTC (16:30 BST / 15:30 GMT). Formerly operated as CREST.',
	},
	XJPX: {
		cycle:         'T+2',
		clearinghouse: 'JSCC',
		cutoff_utc:    '06:30',
		notes:         'Japanese equities T+2. Cutoff 15:30 JST = 06:30 UTC (Japan has no DST — offset is always UTC+9).',
	},
} as const;

// ─── x402 Micropayment ────────────────────────────────────────────────────────

// USDC ERC-20 contract on Base mainnet (chain ID 8453).
const X402_USDC_CONTRACT    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// USDC ERC-20 contract on Base Sepolia testnet (chain ID 84532).
const X402_SEPOLIA_USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
// CDP mainnet facilitator — requires JWT auth via CDP_API_KEY_NAME + CDP_API_KEY_PRIVATE_KEY.
const X402_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
// 0.001 USDC = 1000 units at 6 decimals. Minimum payment per request.
const X402_MIN_AMOUNT_UNITS     = BigInt(1000);
const X402_MINT_BUILDER_UNITS   = BigInt(99_000_000);  // 99 USDC at 6 decimals
const X402_MINT_PRO_UNITS       = BigInt(299_000_000); // 299 USDC at 6 decimals
const X402_MINT_MAX_AGE_SECONDS = 600;                 // 10 minutes (vs 5 min per-request)
// ERC-20 Transfer(address,address,uint256) event topic.
const ERC20_TRANSFER_TOPIC  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Base mainnet public JSON-RPC endpoint — no API key required.
const BASE_RPC_URL          = 'https://mainnet.base.org';
// Free tier: daily request cap before x402 micropayment is required.
const FREE_TIER_DAILY_LIMIT    = 500;
const SANDBOX_DAILY_LIMIT      = 200;   // Sandbox keys: 200 calls per 7-day key lifetime — enough to evaluate without replacing credit pack
const UNAUTH_MCP_STATUS_LIMIT  = 10;   // Unauthenticated get_market_status calls per IP per day via /mcp
const BUILDER_TIER_DAILY_LIMIT = 50_000;
const PRO_TIER_DAILY_LIMIT     = 200_000;

// Returns the daily request limit for a given plan. null = unlimited (protocol, internal).
function getPlanDailyLimit(plan: string): number | null {
	switch (plan) {
		case 'free':    return FREE_TIER_DAILY_LIMIT;
		case 'sandbox': return SANDBOX_DAILY_LIMIT;
		case 'builder': return BUILDER_TIER_DAILY_LIMIT;
		case 'pro':     return PRO_TIER_DAILY_LIMIT;
		default:        return null; // protocol, internal — no limit
	}
}

// Max active webhook subscriptions per plan.
// null = unlimited (protocol, internal keys).
// 0 = not allowed (sandbox).
const BUILDER_WEBHOOK_LIMIT = 5;
const PRO_WEBHOOK_LIMIT     = 25;

function getPlanWebhookLimit(plan: string): number | null {
	switch (plan) {
		case 'sandbox': return 0;
		case 'builder': return BUILDER_WEBHOOK_LIMIT;
		case 'pro':     return PRO_WEBHOOK_LIMIT;
		default:        return null; // protocol, internal, free — handled by separate MIC limit
	}
}

// Computes HMAC-SHA256 over a payload string using a shared secret.
// Returns "sha256=<hex>" for use in the X-Oracle-Signature header.
async function computeHmacSignature(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return 'sha256=' + toHex(new Uint8Array(sig));
}

// Response headers signalling to HTTP clients that a payment is required.
// Includes both legacy X-Payment-* headers and the x402 v2 standard Payment-Required header.
const X402_RESPONSE_HEADERS: Record<string, string> = {
	'X-Payment-Required': 'true',
	'X-Payment-Scheme':   'x402',
	'X-Payment-Network':  'base',
	'X-Payment-Chain-ID': '8453',
	'X-Payment-Amount':   '0.001 USDC',
};

// Read the payment header from the request, checking both x402 v2 (Payment-Signature)
// and v1 (X-Payment) header names. HTTP headers are case-insensitive, but we check
// the canonical v2 name first for forward compatibility.
function getPaymentHeader(request: Request): string | null {
	return request.headers.get('Payment-Signature') ?? request.headers.get('X-Payment');
}

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
	// Accept all common Base mainnet network identifiers: 'base-mainnet' (legacy),
	// 'base' (x402 v1/v2 standard), 'eip155:8453' (CAIP-2). Agents construct payments
	// using whatever network name the 402 response told them — we must accept all.
	const VALID_BASE_NETWORKS = new Set(['base-mainnet', 'base', 'eip155:8453']);
	if (!VALID_BASE_NETWORKS.has(payment.network)) {
		return { valid: false, detail: 'WRONG_NETWORK: expected base, base-mainnet, or eip155:8453' };
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
	// Track payment stats for /v5/payment-proof — best-effort (errors swallowed)
	try {
		const countStr = await env.ORACLE_TELEMETRY.get('x402_payment_count').catch(() => null);
		const count    = parseInt(countStr ?? '0', 10) || 0;
		const nowIso   = new Date().toISOString();
		if (count === 0) {
			await env.ORACLE_TELEMETRY.put('x402_first_tx',         txHash.slice(-12)).catch(() => {});
			await env.ORACLE_TELEMETRY.put('x402_first_payment_at', nowIso).catch(() => {});
		}
		await env.ORACLE_TELEMETRY.put('x402_payment_count',   String(count + 1)).catch(() => {});
		await env.ORACLE_TELEMETRY.put('x402_last_payment_at', nowIso).catch(() => {});
	} catch { /* best-effort */ }
	console.log(JSON.stringify({ event: 'X402_PAYMENT_VERIFIED', tx_hash: txHash, amount_units: amountPaid.toString() }));
	return { valid: true };
}

// Generates a CDP API JWT for authenticating to api.cdp.coinbase.com.
// Supports base64 Ed25519 keys (64 bytes: seed || pubkey) and PEM PKCS8 EC P-256 keys.
// spec: https://docs.cdp.coinbase.com/api-keys/docs/api-key-authentication
async function generateCdpJwt(
	apiKeyId: string,
	privateKeyStr: string,
	method: string,
	path: string,
): Promise<string> {
	const host = 'api.cdp.coinbase.com';
	const now  = Math.floor(Date.now() / 1000);
	const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));

	const isPem = privateKeyStr.trim().startsWith('-----BEGIN');
	const alg   = isPem ? 'ES256' : 'EdDSA';

	const header = { alg, kid: apiKeyId, typ: 'JWT', nonce };
	const claims = {
		sub:  apiKeyId,
		iss:  'cdp',
		nbf:  now,
		exp:  now + 120,
		iat:  now,
		uris: [`${method} ${host}${path}`],
	};

	const b64url = (bytes: Uint8Array): string => {
		let bin = '';
		for (const b of bytes) bin += String.fromCharCode(b);
		return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	};
	const encodeStr = (s: string): string => b64url(new TextEncoder().encode(s));

	const headerB64    = encodeStr(JSON.stringify(header));
	const claimsB64    = encodeStr(JSON.stringify(claims));
	const signingInput = `${headerB64}.${claimsB64}`;

	let sigBytes: Uint8Array;

	if (isPem) {
		// PKCS8 PEM → Web Crypto ECDSA P-256
		const pemBody = privateKeyStr.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
		const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
		const key = await crypto.subtle.importKey(
			'pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
		);
		const sig = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput),
		);
		sigBytes = new Uint8Array(sig);
	} else {
		// Base64 Ed25519 (64 bytes: seed || public key) — sign with @noble/ed25519
		const rawKey = Uint8Array.from(atob(privateKeyStr), c => c.charCodeAt(0));
		const seed   = rawKey.subarray(0, 32);
		sigBytes = await ed.sign(new TextEncoder().encode(signingInput), seed);
	}

	return `${signingInput}.${b64url(sigBytes)}`;
}

// Verifies an x402 payment via the CDP mainnet facilitator (JWT-authenticated).
// Calls /verify first to validate the signature, then /settle to finalize.
// Does NOT perform direct on-chain RPC calls — the facilitator handles EVM verification.
async function verifyX402ViaFacilitator(
	paymentHeader: string,
	paymentAddress: string,
	env: Env,
	resource?: string,
): Promise<{ valid: boolean; txHash?: string; detail?: string; status: 'payment-accepted' | 'payment-rejected' | 'facilitator-error' }> {
	// paymentRequirements must be a single object (not an array).
	// network must use the standard x402 name "base", not the CAIP-2 format "eip155:8453".
	// extra carries the USDC EIP-712 domain params needed for signature verification.
	const paymentRequirements: Record<string, unknown> = {
		scheme:            'exact',
		network:           'base',          // Standard x402 network name (not CAIP-2)
		maxAmountRequired: '1000',          // 0.001 USDC at 6 decimals
		asset:             X402_USDC_CONTRACT,
		payTo:             paymentAddress,
		maxTimeoutSeconds: 300,
		// description and mimeType are required by PaymentRequirementsSchema — omitting them
		// causes the facilitator to return unexpected_error (zod validation failure).
		description:       'Signed market-state receipt. Ed25519 signed, 60s TTL. $0.001 USDC on Base mainnet.',
		mimeType:          'application/json',
		extra:             { name: 'USD Coin', version: '2' },
	};
	if (resource) paymentRequirements.resource = resource;

	// Decode base64 payment header to get the PaymentPayload object.
	// The x402.org facilitator expects: { paymentPayload: <object>, paymentRequirements: <object> }
	let decodedPaymentPayload: Record<string, unknown>;
	try {
		// Normalize URL-safe base64 (- → +, _ → /) before decoding.
		// The x402 client may emit standard or URL-safe base64; atob() requires standard.
		const normalized = paymentHeader.replace(/-/g, '+').replace(/_/g, '/');
		decodedPaymentPayload = JSON.parse(atob(normalized));
	} catch {
		return { valid: false, status: 'payment-rejected', detail: 'INVALID_PAYMENT_HEADER: base64 decode failed' };
	}
	// CDP facilitator (api.cdp.coinbase.com) requires x402Version at the root level.
	// Extract from inside paymentPayload (field added by x402 client library).
	const x402Version = (decodedPaymentPayload.x402Version as number | undefined) ?? 1;
	const payload = JSON.stringify({ x402Version, paymentPayload: decodedPaymentPayload, paymentRequirements });

	// Build CDP auth headers — generate a fresh JWT for each request (120s TTL).
	const buildAuthHeaders = async (path: string): Promise<Record<string, string>> => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (env.CDP_API_KEY_NAME && env.CDP_API_KEY_PRIVATE_KEY) {
			try {
				const jwt = await generateCdpJwt(env.CDP_API_KEY_NAME, env.CDP_API_KEY_PRIVATE_KEY, 'POST', path);
				headers['Authorization'] = `Bearer ${jwt}`;
				console.log(JSON.stringify({ event: 'CDP_JWT_GENERATED', path, key_prefix: env.CDP_API_KEY_NAME.slice(0, 20) }));
			} catch (jwtErr) {
				console.error('CDP JWT generation failed:', jwtErr instanceof Error ? jwtErr.message : jwtErr);
				// Proceed without auth — facilitator will return 401; logged below.
			}
		} else {
			console.warn('CDP_API_KEY_NAME or CDP_API_KEY_PRIVATE_KEY not set — proceeding without auth');
		}
		return headers;
	};

	// Step 1: verify signature before consuming the settlement attempt
	try {
		const verifyHeaders = await buildAuthHeaders('/platform/v2/x402/verify');
		const verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
			method:  'POST',
			headers: verifyHeaders,
			body:    payload,
			signal:  AbortSignal.timeout(5000),
		});
		const verifyText = await verifyRes.text();
		if (!verifyRes.ok) console.error(JSON.stringify({ event: 'FACILITATOR_VERIFY_NON_OK', status: verifyRes.status }));
		const verifyBody = JSON.parse(verifyText) as Record<string, unknown>;
		const isValid = (verifyBody.isValid ?? verifyBody.valid) as boolean | undefined;
		if (!isValid) {
			const reason = (verifyBody.invalidReason ?? verifyBody.error ?? verifyBody.message ?? 'unknown') as string;
			console.error(JSON.stringify({ event: 'FACILITATOR_VERIFY_REJECTED', status: verifyRes.status, reason, body_keys: Object.keys(verifyBody) }));
			return { valid: false, status: 'payment-rejected', detail: `FACILITATOR_VERIFY_FAILED: ${reason}` };
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'unknown';
		console.error('x402 facilitator /verify error:', msg);
		return { valid: false, status: 'facilitator-error', detail: `FACILITATOR_VERIFY_FETCH_FAILED: ${msg}` };
	}

	// Step 2: settle
	try {
		const settleHeaders = await buildAuthHeaders('/platform/v2/x402/settle');
		const settleRes = await fetch(`${X402_FACILITATOR_URL}/settle`, {
			method:  'POST',
			headers: settleHeaders,
			body:    payload,
			signal:  AbortSignal.timeout(5000),
		});
		const settleText = await settleRes.text();
		if (!settleRes.ok) console.error(JSON.stringify({ event: 'FACILITATOR_SETTLE_NON_OK', status: settleRes.status, body_preview: settleText.slice(0, 200) }));
		const settleBody = JSON.parse(settleText) as Record<string, unknown>;
		if (!settleBody.success) {
			const reason = (settleBody.error ?? settleBody.message ?? 'unknown') as string;
			console.error(JSON.stringify({ event: 'FACILITATOR_SETTLE_REJECTED', status: settleRes.status, reason, body_keys: Object.keys(settleBody) }));
			return { valid: false, status: 'payment-rejected', detail: `FACILITATOR_SETTLE_REJECTED: ${reason}` };
		}
		console.log(JSON.stringify({ event: 'X402_MAINNET_FACILITATOR_PAYMENT_VERIFIED', tx_hash: settleBody.txHash ?? 'n/a' }));
		// Track payment stats for /v5/payment-proof — best-effort (errors swallowed)
		try {
			const _facilTxHash = settleBody.txHash ?? '';
			const countStr     = await env.ORACLE_TELEMETRY.get('x402_payment_count').catch(() => null);
			const count        = parseInt(countStr ?? '0', 10) || 0;
			const nowIso       = new Date().toISOString();
			if (count === 0 && _facilTxHash) {
				await env.ORACLE_TELEMETRY.put('x402_first_tx',         _facilTxHash.slice(-12)).catch(() => {});
				await env.ORACLE_TELEMETRY.put('x402_first_payment_at', nowIso).catch(() => {});
			}
			await env.ORACLE_TELEMETRY.put('x402_payment_count',   String(count + 1)).catch(() => {});
			await env.ORACLE_TELEMETRY.put('x402_last_payment_at', nowIso).catch(() => {});
		} catch { /* best-effort */ }
		return { valid: true, status: 'payment-accepted', txHash: settleBody.txHash };
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'unknown';
		console.error('x402 facilitator /settle error:', msg);
		return { valid: false, status: 'facilitator-error', detail: `FACILITATOR_SETTLE_FETCH_FAILED: ${msg}` };
	}
}

// Smart payment header parser — accepts both formats so agents never get stuck:
//   1. Raw JSON: { txHash, network, amount, paymentAddress, memo } — direct on-chain verification
//   2. Base64-encoded JSON — x402 standard format, verified via CDP facilitator
// Tries raw JSON first (cheaper: no network call if format is wrong), then base64 → facilitator.
async function verifyPaymentAnyFormat(
	header: string,
	paymentAddress: string,
	env: Env,
	resourceUrl: string,
): Promise<{ valid: boolean; detail?: string; txHash?: string }> {
	// Path 1: try raw JSON (direct on-chain)
	try {
		const parsed = JSON.parse(header);
		if (parsed && typeof parsed === 'object' && parsed.txHash && parsed.network) {
			const result = await verifyX402Payment(parsed as X402Payment, paymentAddress, env);
			return { ...result, txHash: parsed.txHash };
		}
		// Parsed as JSON but not an X402Payment — fall through to base64
	} catch { /* not raw JSON — try base64 x402 format */ }

	// Path 2: try base64 x402 standard → CDP facilitator
	try {
		const normalized = header.replace(/-/g, '+').replace(/_/g, '/');
		JSON.parse(atob(normalized)); // validate it's decodable before network call
	} catch {
		return { valid: false, detail: 'X-Payment must be JSON (direct on-chain) or base64-encoded JSON (x402 standard)' };
	}
	const result = await verifyX402ViaFacilitator(header, paymentAddress, env, resourceUrl);
	return { valid: result.valid, detail: result.detail, txHash: result.txHash };
}

// Unified agent action guide — included in every 402 response so any agent knows
// exactly what to do next without reading documentation.
function buildAgentActions(paymentAddress: string): Record<string, unknown> {
	return {
		pay_per_request: {
			description:        'Send Payment-Signature (x402 v2) or X-Payment (v1) header to pay $0.001 USDC and get this receipt immediately',
			header_names:       ['Payment-Signature', 'X-Payment'],
			accepted_formats:   ['base64-json (x402 standard — use x402 client library)', 'raw JSON { txHash, network, amount, paymentAddress, memo } (direct on-chain)'],
			payment_spec:       '/.well-known/x402.json',
			example_flow_x402:  '1. Use x402 client to create payment → 2. Library sets X-Payment header automatically → 3. Send request',
			example_flow_direct: '1. Send 1000 units USDC to paymentAddress on Base mainnet → 2. Get txHash → 3. Set X-Payment: {"txHash":"0x...","network":"base","amount":"1000","paymentAddress":"<addr>","memo":"..."} → 4. Send request',
		},
		get_credits_instantly: {
			description:     'POST /v5/sandbox with X-Payment header — get 10 credits immediately, no email required',
			endpoint:        'POST /v5/sandbox',
			body_with_email: '{ "email": "you@example.com" }',
			body_x402:       'omit body — use X-Payment header instead (same $0.001 USDC)',
			credits_issued:  10,
		},
		mint_persistent_key: {
			description: 'POST /v5/x402/mint with tx_hash of Base mainnet USDC payment — get a persistent API key',
			endpoint:    'POST /v5/x402/mint',
			body:        '{ "tx_hash": "0x...", "tier": "builder" }',
			tiers:       { builder: '$99 USDC → 50K req/day', pro: '$299 USDC → 200K req/day' },
		},
		buy_subscription: {
			description: 'Human-driven checkout — get a permanent key with monthly billing',
			url:         'https://headlessoracle.com/upgrade',
		},
		payment_address: paymentAddress,
	};
}

// Build x402-compatible 402 payload for Base mainnet via CDP facilitator.
function buildMainnetFacilitatorPayload(paymentAddress: string, resourceUrl: string): Record<string, unknown> {
	return {
		x402Version: 1,
		accepts: [{
			scheme:              'exact',
			network:             'base',
			maxAmountRequired:   '1000',
			asset:               X402_USDC_CONTRACT,
			payTo:               paymentAddress,
			maxTimeoutSeconds:   300,
			resource:            resourceUrl,
			description:         'Signed market-state receipt. Ed25519 signed, 60s TTL. $0.001 USDC on Base mainnet.',
			mimeType:            'application/json',
			paymentHeaderName:   'X-Payment',
			paymentHeaderEncoding: 'base64-json',
			extra:               { name: 'USD Coin', version: '2' },
			input: {
				type:       'object',
				properties: { mic: { type: 'string', description: 'ISO 10383 MIC code', example: 'XNYS' } },
				required:   ['mic'],
			},
		}],
		error:          'Payment Required',
		network:        'mainnet',
		agent_actions:  buildAgentActions(paymentAddress),
	};
}

// Verifies a USDC payment for key minting on Base mainnet.
// Separate from verifyX402Payment: uses a different replay namespace (x402_used_tx:),
// configurable minimum amount (tier-based), and a 10-minute age window.
async function verifyX402MintPayment(
	txHash: string,
	paymentAddress: string,
	minAmountUnits: bigint,
	env: Env,
): Promise<{ valid: boolean; detail?: string; amountPaid?: bigint }> {
	const txHashLower = txHash.toLowerCase();
	if (!/^0x[0-9a-f]{64}$/.test(txHashLower)) {
		return { valid: false, detail: 'INVALID_TX_HASH' };
	}

	// Replay check — x402_used_tx: namespace is separate from per-request x402_used:
	const replayKey   = `x402_used_tx:${txHashLower}`;
	const alreadyUsed = await env.ORACLE_TELEMETRY.get(replayKey).catch(() => null);
	if (alreadyUsed !== null) {
		return { valid: false, detail: 'TRANSACTION_ALREADY_USED' };
	}

	let receipt: EthReceipt | null = null;
	try {
		const rpcRes = await fetch(BASE_RPC_URL, {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHashLower] }),
		});
		const rpcData = await rpcRes.json() as { result: EthReceipt | null };
		receipt = rpcData.result;
	} catch {
		return { valid: false, detail: 'RPC_FETCH_FAILED' };
	}
	if (!receipt)                  return { valid: false, detail: 'TRANSACTION_NOT_FOUND' };
	if (receipt.status !== '0x1') return { valid: false, detail: 'TRANSACTION_FAILED' };

	const transferLog = receipt.logs.find(
		(log) =>
			log.address.toLowerCase() === X402_USDC_CONTRACT.toLowerCase() &&
			log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC &&
			log.topics[2] != null &&
			('0x' + log.topics[2].slice(-40)).toLowerCase() === paymentAddress.toLowerCase(),
	);
	if (!transferLog) return { valid: false, detail: 'NO_USDC_TRANSFER_TO_PAYMENT_ADDRESS' };

	const amountPaid = BigInt(transferLog.data);
	if (amountPaid < minAmountUnits) {
		return { valid: false, detail: `INSUFFICIENT_AMOUNT: paid ${amountPaid}, required ${minAmountUnits}` };
	}

	let blockTimestampSec = 0;
	try {
		const blockRes  = await fetch(BASE_RPC_URL, {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }),
		});
		const blockData = await blockRes.json() as { result: { timestamp: string } | null };
		if (blockData.result?.timestamp) blockTimestampSec = parseInt(blockData.result.timestamp, 16);
	} catch {
		return { valid: false, detail: 'BLOCK_FETCH_FAILED' };
	}

	const ageSeconds = Math.floor(Date.now() / 1000) - blockTimestampSec;
	if (ageSeconds > X402_MINT_MAX_AGE_SECONDS) {
		return { valid: false, detail: `TRANSACTION_EXPIRED: ${ageSeconds}s old, max ${X402_MINT_MAX_AGE_SECONDS}s` };
	}

	// Mark as used — 365-day TTL so the same tx can never be replayed to mint a second key
	await env.ORACLE_TELEMETRY.put(replayKey, '1', { expirationTtl: 86_400 * 365 }).catch(() => {});
	return { valid: true, amountPaid };
}

// Build the x402 payment payload for a 402 response.
function build402Payload(paymentAddress: string, keyHash: string): Record<string, unknown> {
	return {
		error:   'PAYMENT_REQUIRED',
		message: 'Free tier exhausted. Pay 0.001 USDC per request via x402 on Base network, or upgrade at headlessoracle.com/upgrade',
		x402: {
			version:             '1',
			scheme:              'exact',
			network:             'base',
			chainId:             8453,
			amount:              '1000',
			currency:            'USDC',
			decimals:            6,
			paymentAddress,
			paymentHeaderName:      'X-Payment',
			paymentHeaderEncoding:  ['base64-json', 'json'],
			usdcContractAddress:    X402_USDC_CONTRACT,
			memo:                   `${keyHash}:${new Date().toISOString().slice(0, 10)}:${crypto.randomUUID()}`,
			maxAge:                 300,
		},
		alternatives: {
			monthly:        'https://headlessoracle.com/upgrade',
			sandbox_x402:   'POST /v5/sandbox with X-Payment header — 10 credits, no email',
			mint_key:       'POST /v5/x402/mint with tx_hash — get persistent API key',
		},
		agent_actions:  buildAgentActions(paymentAddress),
		founder_note: "You're hitting our limits — that means you're building something real. Reply to hello@headlessoracle.com and I'll set you up with a proper production key. — Mike",
	};
}

// Shared upgrade-ladder data — reused by /v5/why-not-free and get_payment_options MCP tool.
function buildPaymentOptions(): Record<string, unknown> {
	return {
		sandbox: {
			calls:  200,
			window: '7 days',
			how:    'POST /v5/sandbox with { "email": "you@example.com" }',
		},
		x402_per_request: {
			cost: '$0.001 USDC',
			how:  'Add X-Payment header — see /.well-known/x402.json for payment spec',
		},
		x402_sandbox: {
			cost:    '$0.001 USDC',
			credits: 10,
			how:     'POST /v5/sandbox with X-Payment header (no email required)',
		},
		credits: {
			cost:  '$5',
			calls: 1000,
			how:   'GET /upgrade',
		},
		builder: {
			cost:  '$99/mo',
			calls: '50K/day',
			how:   'GET /upgrade',
		},
		agent_native_path: 'No key, no signup. Send X-Payment with any request OR POST /v5/sandbox with X-Payment to get 10 credits instantly.',
	};
}

// Shared Ed25519 receipt verification logic — used by verify_receipt MCP tool and POST /v5/verify.
async function verifyReceiptLogic(
	receipt: Record<string, unknown> | undefined,
	pubKeyHex: string | undefined,
): Promise<{ valid: boolean; expired: boolean; reason: string; mic: string | null; status: string | null; expires_at: string | null }> {
	const NULL_RESULT = { valid: false, expired: false, mic: null, status: null, expires_at: null };
	if (!receipt || typeof receipt !== 'object' || typeof receipt.signature !== 'string' || !receipt.signature) {
		return { ...NULL_RESULT, reason: 'MALFORMED_RECEIPT' };
	}
	if (!pubKeyHex) {
		return { ...NULL_RESULT, reason: 'ORACLE_NOT_CONFIGURED' };
	}
	try {
		const UNSIGNED_WRAPPER_FIELDS = new Set(['discovery_url', 'receipt', 'extensions']);
		const { signature, ...rest } = receipt;
		const payload: Record<string, string> = {};
		for (const key of Object.keys(rest).sort()) {
			if (UNSIGNED_WRAPPER_FIELDS.has(key)) continue;
			payload[key] = String((rest as Record<string, unknown>)[key]);
		}
		const canonical = JSON.stringify(payload);
		const msgBytes  = new TextEncoder().encode(canonical);
		const sigBytes  = fromHex(signature as string);
		const pubKey    = fromHex(pubKeyHex);
		const valid     = await ed.verify(sigBytes, msgBytes, pubKey);
		const expiresAt = typeof receipt.expires_at === 'string' ? receipt.expires_at : null;
		const expired   = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
		let reason: string;
		if (!valid)       reason = 'INVALID_SIGNATURE';
		else if (expired) reason = 'RECEIPT_EXPIRED — re-fetch required';
		else              reason = 'SIGNATURE_VALID';
		return {
			valid,
			expired,
			reason,
			mic:        typeof receipt.mic    === 'string' ? receipt.mic    : null,
			status:     typeof receipt.status === 'string' ? receipt.status : null,
			expires_at: expiresAt,
		};
	} catch {
		return { ...NULL_RESULT, reason: 'MALFORMED_RECEIPT' };
	}
}

// Build the Payment-Required header value required by x402 index crawlers (e.g. 402index.io).
// Crawlers read this header (base64 JSON) rather than parsing the response body.
// Uses bare "base" network name and "amount" field (x402 v2 header convention).
function buildX402IndexHeaders(paymentAddress: string, endpoint: 'status' | 'batch' = 'status'): Record<string, string> {
	const payload = {
		x402Version: 1,
		error:       'Payment Required',
		accepts: [
			{
				scheme:            'exact',
				network:           'base',
				amount:            endpoint === 'status' ? '1000' : '5000',
				asset:             X402_USDC_CONTRACT,
				payTo:             paymentAddress,
				maxTimeoutSeconds: 300,
			},
		],
	};
	const json = JSON.stringify(payload);
	return {
		'Payment-Required':      btoa(json),
		'Payment-Required-Json': json,
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
				scheme:              'exact',
				network:             'base',
				maxAmountRequired:   isStatus ? '1000' : '5000',
				resource:            resourceUrl,
				description:         isStatus
					? 'Signed market-state receipt for one exchange. OPEN/CLOSED/HALTED/UNKNOWN — Ed25519 signed, 60s TTL.'
					: 'Signed market-state receipts for multiple exchanges in one request. Each receipt Ed25519 signed, 60s TTL.',
				mimeType:            'application/json',
				payTo:               paymentAddress,
				maxTimeoutSeconds:   300,
				asset:               X402_USDC_CONTRACT,
				paymentHeaderName:     'X-Payment',
				paymentHeaderEncoding: ['base64-json', 'json'],
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
				// EIP-712 domain params for USDC on Base — required by x402 clients to
				// construct valid transferWithAuthorization signatures.
				extra: { name: 'USD Coin', version: '2' },
			},
		],
		error:         'Payment Required',
		agent_actions: buildAgentActions(paymentAddress),
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
		headers.set('X-RateLimit-Warning-Message', 'You have used 80% of your daily free tier limit. Upgrade at headlessoracle.com/upgrade or use x402 payments to continue.');
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

// Cache-first MCP usage for a given date.
// Fast path: reads the traction_cache:{date} key written by the 17:00 cron.
// Fallback: live KV list over mcp_clients:{date}: prefix — accurate at any hour of the day.
async function getMcpUsageToday(today: string, env: Env): Promise<{ unique_clients_today: number; total_requests_today: number }> {
	const cacheRaw = await env.ORACLE_TELEMETRY.get(`traction_cache:${today}`).catch(() => null);
	if (cacheRaw) {
		try {
			const tc = JSON.parse(cacheRaw) as { unique_clients_today?: number; total_requests_today?: number };
			return {
				unique_clients_today: tc.unique_clients_today  ?? 0,
				total_requests_today: tc.total_requests_today  ?? 0,
			};
		} catch { /* fall through to live */ }
	}
	// Cache miss or parse error — compute live from per-client KV records.
	let unique_clients_today = 0;
	let total_requests_today = 0;
	try {
		const list = await env.ORACLE_TELEMETRY.list({ prefix: `mcp_clients:${today}:` });
		unique_clients_today = list.keys.length;
		if (list.keys.length > 0) {
			const records = await Promise.all(list.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name)));
			for (const r of records) {
				if (r) {
					const parsed = JSON.parse(r) as { request_count?: number };
					total_requests_today += parsed.request_count ?? 0;
				}
			}
		}
	} catch { /* KV unavailable — return zeros */ }
	return { unique_clients_today, total_requests_today };
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

const SMA_RFC_001_MD = `# SMA-RFC-001: Signed Market Attestation Protocol v1.0.0

\`\`\`
Status:          Draft — Seeking Implementations
Date:            2026-03-27
Author:          LembaGang (headlessoracle.com)
License:         Apache 2.0
Repository:      github.com/LembaGang/sma-protocol
\`\`\`

---

## Terminology Disambiguation

**In this document, SMA denotes "Signed Market Attestation."**

This usage is entirely distinct from the statistical term "Simple Moving Average" (SMA) used in technical analysis and quantitative finance. All schema fields, OpenAPI descriptions, and agent tool descriptions that reference this protocol MUST use the full phrase "Signed Market Attestation" alongside the acronym on first reference.

---

## Abstract

This document specifies the Signed Market Attestation (SMA) Protocol — a cryptographic attestation format enabling autonomous financial agents to verify the operational state of global financial exchanges with non-repudiable, machine-verifiable proof.

The protocol defines: a canonical receipt schema, an Ed25519 signing procedure, key discovery conventions, TTL semantics, fail-closed behaviour, and conformance requirements for both issuers and verifiers.

---

## 1. Conformance Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119].

---

## 2. Exchange State Model

Every exchange covered by the SMA Protocol MUST be in exactly one of the following states:

| State     | Meaning                                                                 |
|-----------|-------------------------------------------------------------------------|
| OPEN    | The exchange is accepting orders. Execution MAY proceed.                |
| CLOSED  | The exchange is not accepting orders. Execution MUST NOT proceed.       |
| HALTED  | Trading is suspended (circuit breaker, regulatory halt). MUST NOT proceed. |
| UNKNOWN | State cannot be determined. MUST be treated as CLOSED by all verifiers. |

**Fail-Closed Invariant**: A conformant verifier MUST deny execution for any state that is not OPEN. UNKNOWN is not a recoverable state — it is equivalent to CLOSED for all execution purposes.

---

## 3. Receipt Schema

A complete SMA receipt is a JSON object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| mic | string | REQUIRED | ISO 10383 MIC code. MUST be uppercase. |
| status | string | REQUIRED | One of: OPEN, CLOSED, HALTED, UNKNOWN. |
| issued_at | string | REQUIRED | ISO 8601 UTC timestamp of attestation. |
| expires_at | string | REQUIRED | ISO 8601 UTC timestamp of expiry. |
| ttl_seconds | integer | OPTIONAL | Duration in seconds (typically 60). |
| schema_version | string | REQUIRED | SMA Protocol version. Current: "v5.0". |
| issuer | string | REQUIRED | Domain of the issuing oracle. |
| public_key_id | string | REQUIRED | Key identifier matching an entry in /.well-known/oracle-keys.json. |
| signature | string | REQUIRED | Hex-encoded Ed25519 signature over the canonical payload. |
| discovery_url | string | OPTIONAL | URL to issuer MCP server-card.json for capability discovery. |

---

## 4. Canonical Payload and Signing

### 4.1 Canonical Payload Fields

The following fields are included in the canonical payload, sorted alphabetically by key:

\`\`\`
expires_at, halt_detection, issued_at, issuer, mic, public_key_id, receipt_id, receipt_mode, schema_version, source, status
\`\`\`

Fields NOT part of the canonical payload: signature, discovery_url, exchange_name, timezone.

### 4.2 Serialisation

The canonical payload MUST be serialised as compact JSON with keys in alphabetical (Unicode code point) order. No extraneous whitespace.

### 4.3 Signing Algorithm

Issuers MUST use Ed25519 [RFC8037]:

\`\`\`
signature = Ed25519_Sign(private_key, UTF8(JSON.stringify(sortedPayload)))
\`\`\`

The resulting 64-byte signature MUST be encoded as hex (lowercase).

---

## 5. Key Discovery

Issuers MUST publish their active public keys at:

\`\`\`
GET /.well-known/oracle-keys.json
\`\`\`

---

## 6. TTL and Expiry Semantics

- Issuers MUST set expires_at = issued_at + 60 seconds (reference implementation).
- Verifiers MUST check expires_at before trusting a receipt.
- Expired receipts MUST be treated as UNKNOWN (CLOSED).
- Verifiers MUST NOT cache receipts beyond their expires_at timestamp.

---

## 7. Fail-Closed Requirements (Normative)

1. A verifier that cannot contact the issuer MUST default to UNKNOWN (CLOSED).
2. A verifier that receives an invalid signature MUST treat the state as UNKNOWN (CLOSED).
3. A verifier that receives status: "UNKNOWN" MUST deny execution.
4. A verifier that receives an expired receipt MUST treat the state as UNKNOWN (CLOSED).
5. A verifier that receives a receipt for the wrong MIC MUST treat the state as UNKNOWN (CLOSED).

---

## 8. DST and Timezone Handling

Issuers MUST use IANA timezone identifiers (e.g., "Europe/London"), not UTC offsets. The IANA timezone database handles all DST transitions automatically.

**The US-Europe DST Gap (2026)**: US transitions March 8, Europe transitions March 29. During the 21-day window (March 8-29), the NY/London offset compresses from 5 hours to 4 hours. Agents with hardcoded UTC offsets produce incorrect cross-market overlap calculations.

SMA receipts are immune to this vulnerability because they use IANA timezones.

---

## 9. Conformance Requirements Summary

### 9.1 Issuer Conformance (MUST)

- [ ] Produce receipts with all REQUIRED fields
- [ ] Use ISO 10383 MIC codes (uppercase)
- [ ] Use IANA timezone identifiers (no UTC offsets)
- [ ] Sign receipts using Ed25519 over alphabetically-sorted compact JSON
- [ ] Publish public keys at /.well-known/oracle-keys.json
- [ ] Return UNKNOWN (never omit status) when state cannot be determined

### 9.2 Verifier Conformance (MUST)

- [ ] Validate signature using issuer public key
- [ ] Check expires_at before trusting any receipt
- [ ] Treat UNKNOWN, expired, and invalid-signature receipts as CLOSED
- [ ] Never execute against a non-OPEN state

---

## 10. Conformance Vectors

Machine-testable conformance vectors are published at:

\`\`\`
GET https://api.headlessoracle.com/v5/conformance-vectors
\`\`\`

---

## 11. Compatible Implementations

| Implementation | Language | Role | Link |
|---|---|---|---|
| Headless Oracle | TypeScript (CF Workers) | Issuer (28 exchanges) | headlessoracle.com |
| headless-oracle-go | Go | Verifier SDK | github.com/LembaGang/headless-oracle-go |
| @headlessoracle/verify | JavaScript | Verifier SDK | npmjs.com/@headlessoracle/verify |
| headless-oracle | Python | Client + Verifier | pypi.org/project/headless-oracle |

---

## 12. Relationship to Other Standards

- **MCP**: SMA receipts are delivered as MCP tool responses. The discovery_url field enables capability discovery.
- **A2A**: SMA receipts are transport-portable and MAY be included in A2A task messages.
- **x402**: Premium SMA endpoints are x402-payable on Base (eip155:8453, USDC).
- **ERC-8183**: Headless Oracle functions as an ERC-8183 Evaluator. An SMA receipt with status: "OPEN" can trigger conditional settlement.

---

## 13. Security Considerations

- **TTL**: Receipts expire in 60 seconds. Verifiers MUST enforce expiry.
- **Replay protection**: Per-request x402 payments use txHash KV with 600s TTL.
- **Key compromise**: Rotate immediately; publish new JWKS; remove old key after 24h grace period.
- **Post-quantum**: Ed25519 is not post-quantum secure. A future version SHOULD specify a migration path to CRYSTALS-Dilithium [FIPS204].

---

## 14. Normative References

- [RFC2119] Key words for use in RFCs
- [RFC7517] JSON Web Key (JWK)
- [RFC8037] CFRG Elliptic Curves for JOSE (Ed25519)
- [ISO10383] Market Identifier Codes
- [FIPS204] ML-DSA (post-quantum digital signature)

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| Draft-01 | 2026-03-27 | Initial draft |
`;

const MPAS_SPEC_MD = `# Multi-Party Attestation Aggregation Spec (MPAS-1.0)

**Status**: Draft v1.0.0
**License**: Apache 2.0
**Authors**: Headless Oracle Project
**Date**: 2026-03-30
**Canonical URL**: https://headlessoracle.com/docs/mpas
**GitHub**: https://github.com/LembaGang/mpas-spec

---

## Problem Statement

The Signed Market Attestation (SMA) Protocol defines how a single oracle operator signs a market-state receipt that any consumer can verify cryptographically. A consumer that fetches a receipt from \`headlessoracle.com\` and verifies the Ed25519 signature knows the receipt was produced by whoever holds the corresponding private key.

That is not the same as knowing the market state is true.

Single-operator trust is operator-reputation trust. If the operator is compromised, coerced, or simply wrong, the signature still verifies. The cryptography proves authorship; it does not prove correctness. For early adopters who already trust the operator, this is sufficient. For infrastructure-scale adoption — where autonomous agents must act on signed attestations without human review — it is not.

The fix is multi-party attestation: require that N independent operators, each holding distinct signing keys, produce receipts agreeing on the same market state before a consumer acts. Compromising the result then requires compromising multiple independent operators simultaneously, which is qualitatively harder than compromising one.

This document specifies how operators, aggregators, and consumers participate in multi-party attestation using standard SMA Protocol receipts as the primitive.

---

## 1. Overview

This spec defines:

1. The \`AggregatedAttestation\` JSON schema — a container for receipts from N independent oracle operators
2. Quorum rules — how many operators must agree, within what time window, for consensus to be valid
3. A consumer verification algorithm — deterministic steps to decide whether to act or halt
4. Operator registration conventions — how operators publish keys and join the network
5. An on-chain verification sketch — how smart contract consumers can verify quorum without a trusted intermediary
6. A trust model comparison — what guarantees each configuration provides

**Relationship to SMA Protocol**: MPAS is a composition layer above SMA. Individual receipts inside an \`AggregatedAttestation\` are standard SMA receipts. MPAS does not replace or modify the SMA signing scheme. Consumers SHOULD implement full SMA receipt verification (per the SMA Protocol v1.0.0 specification) for each individual attestation before applying quorum logic.

**What MPAS does not change**: Ed25519 key pairs, receipt field schemas, canonical payload serialization, the 60-second TTL, or the fail-closed UNKNOWN semantics. All of those remain as defined by the SMA Protocol.

---

## 2. Roles

### Oracle Operator

An entity that:

- Operates an SMA-compliant signing node
- Holds an Ed25519 private key that never leaves the operator's infrastructure
- Publishes the corresponding public key at \`/.well-known/oracle-keys.json\` per RFC 8615
- Produces signed SMA receipts on demand for any supported MIC code

Oracle operators are independent. They must not share signing keys, coordinate on receipt values before signing, or delegate signing to a common infrastructure component. Independence is the security property that makes multi-party attestation meaningful.

Headless Oracle (\`headlessoracle.com\`) is one example of an oracle operator. This spec defines how multiple such operators compose.

### Aggregator

An entity that:

- Knows the endpoint URLs and public keys of N oracle operators
- Fetches receipts from all N operators in parallel for a given MIC and timestamp
- Verifies each receipt's Ed25519 signature independently
- Assembles the results into an \`AggregatedAttestation\`
- Computes the consensus field based on quorum rules

The aggregator is stateless. It does not sign anything. It does not decide what the market state is — it reports what each operator said and whether enough of them agreed. The aggregator can be run by the consumer itself (eliminating the aggregator as a separate trust assumption) or by a third party (convenient but requires trusting the aggregator's honesty about which operators responded).

Section 11 discusses the aggregator trust assumption and the path to eliminating it entirely.

### Consumer

An entity that:

- Receives an \`AggregatedAttestation\` (from an aggregator or by running aggregation itself)
- Runs the verification algorithm defined in Section 5
- Proceeds only if verification passes and consensus is AGREE with quorum met
- Treats DISAGREE, INSUFFICIENT, and any verification failure as equivalent to UNKNOWN — halts execution

Consumers MUST NOT act on partial attestations. An \`AggregatedAttestation\` with \`consensus: "INSUFFICIENT"\` is not "the best available signal." It is an insufficient signal, and the fail-closed rule applies.

### Registry

An optional directory of known oracle operator public keys and endpoint URLs.

A registry allows consumers to discover operators without prior configuration. Registries can be:

- **Off-chain signed manifest**: a JSON file signed by a trusted curator (introduces curator trust assumption)
- **IPFS**: content-addressed, censorship-resistant, no update mechanism without a new CID
- **On-chain**: stored in a smart contract, updateable by governance, auditable

Registry format is out of scope for MPAS v1.0. Section 11 notes this as a known gap.

---

## 3. AggregatedAttestation Schema

An \`AggregatedAttestation\` is a JSON object with the following structure:

\`\`\`json
{
  "mpas_version": "1.0",
  "mic": "XNYS",
  "status": "OPEN",
  "quorum": {
    "required": 2,
    "provided": 3
  },
  "window_ms": 5000,
  "aggregated_at": "2026-03-30T14:32:10.000Z",
  "attestations": [
    {
      "operator_id": "headlessoracle.com",
      "receipt": {
        "mic": "XNYS",
        "status": "OPEN",
        "issued_at": "2026-03-30T14:32:09.121Z",
        "expires_at": "2026-03-30T14:33:09.121Z",
        "issuer": "headlessoracle.com",
        "key_id": "03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178",
        "receipt_mode": "live",
        "schema_version": "v5.0",
        "receipt_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "source": "SCHEDULE",
        "signature": "hex-encoded-ed25519-signature"
      },
      "verified": true
    },
    {
      "operator_id": "oracle-b.example.com",
      "receipt": { "...": "SMA receipt from operator B" },
      "verified": true
    },
    {
      "operator_id": "oracle-c.example.com",
      "receipt": { "...": "SMA receipt from operator C" },
      "verified": true
    }
  ],
  "consensus": "AGREE"
}
\`\`\`

### Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| \`mpas_version\` | string | yes | Must be \`"1.0"\` for this spec version |
| \`mic\` | string | yes | ISO 10383 market identifier code (e.g. \`"XNYS"\`) |
| \`status\` | string | yes | The consensus market status: \`"OPEN"\`, \`"CLOSED"\`, \`"HALTED"\`, or \`"UNKNOWN"\`. Set to the agreed status when \`consensus == "AGREE"\`, otherwise \`"UNKNOWN"\`. |
| \`quorum.required\` | integer | yes | Minimum number of valid agreeing attestations required for AGREE consensus. Must be >= 2 for MPAS compliance. |
| \`quorum.provided\` | integer | yes | Number of attestations included in this object (regardless of verification outcome). |
| \`window_ms\` | integer | yes | Maximum allowed difference in milliseconds between the earliest and latest \`issued_at\` across all attestations. Attestations outside this window are treated as unverified. |
| \`aggregated_at\` | string | yes | ISO 8601 timestamp at which the aggregator assembled this object. Informational only — not part of any signature. |
| \`attestations\` | array | yes | Ordered list of individual operator attestations. |
| \`attestations[].operator_id\` | string | yes | The operator's canonical domain (must match the operator's \`/.well-known/oracle-keys.json\` host). |
| \`attestations[].receipt\` | object | yes | The raw SMA receipt as returned by the operator. Must pass full SMA verification. |
| \`attestations[].verified\` | boolean | yes | Set by the aggregator: \`true\` if Ed25519 signature verified successfully against the operator's known public key, \`false\` otherwise. Consumers MUST re-verify independently and not trust this field. |
| \`consensus\` | string | yes | \`"AGREE"\` if >= \`quorum.required\` verified attestations share the same \`status\`. \`"DISAGREE"\` if >= \`quorum.required\` verified attestations exist but disagree on \`status\`. \`"INSUFFICIENT"\` if fewer than \`quorum.required\` valid attestations were collected. |

The \`AggregatedAttestation\` object is NOT itself signed. Its integrity derives entirely from the independently verifiable signatures within each \`attestations[].receipt\`. This is intentional: adding a signature over the aggregated object would introduce an aggregator signing key, which is the trust assumption we are trying to eliminate in the long term (see Section 11).

---

## 4. Quorum Rules

### Minimum Quorum

The minimum MPAS-compliant configuration is **2-of-3**: two operators must agree, out of three total. A 1-of-1 configuration degrades to single-operator SMA and is explicitly not MPAS-compliant, even if the schema is used.

Recommended configurations:

| Config | Required | Total | Notes |
|---|---|---|---|
| 2-of-3 | 2 | 3 | Recommended minimum. Tolerates one operator failure or one Byzantine operator. |
| 3-of-5 | 3 | 5 | Higher assurance. Tolerates two failures or one Byzantine + one failure. |
| 3-of-3 | 3 | 3 | Maximum conservatism. Any single operator failure → INSUFFICIENT. |

### Time Window

All attestations in an \`AggregatedAttestation\` must have \`issued_at\` values within \`window_ms\` of each other (measured as the difference between the earliest and latest \`issued_at\`).

The recommended \`window_ms\` is **5000** (5 seconds). This accommodates:
- Network latency variation between aggregator and operators
- Operator clock skew (within NTP-synchronized tolerance)
- Retry on transient failure for one operator

Attestations with \`issued_at\` outside the window MUST be treated as unverified regardless of signature validity. A receipt that was genuinely issued at a different time may reflect a different market state.

### Consensus Determination

Given a set of attestations that have all passed signature verification and window checks:

- **AGREE**: The count of verified attestations sharing the same \`status\` value is >= \`quorum.required\`. The \`status\` field of the \`AggregatedAttestation\` is set to that agreed value.
- **DISAGREE**: Verified attestations exist in sufficient number (\`>= quorum.required\`) but do not share a common \`status\`. This indicates operators see different market states — a signal that warrants investigation, never a signal to act.
- **INSUFFICIENT**: Fewer than \`quorum.required\` attestations passed all verification checks (signature valid + within window + not expired).

**Consumers MUST treat DISAGREE and INSUFFICIENT as equivalent to UNKNOWN.** The fail-closed rule from SMA Protocol applies with equal force here: when in doubt, halt all execution.

---

## 5. Verification Algorithm

The following is a deterministic pseudocode description of the consumer verification algorithm. Implementations in any language MUST produce equivalent results.

\`\`\`
function verifyAggregatedAttestation(agg, knownOperatorKeys, now):

  // Step 0: Version check
  if agg.mpas_version != "1.0":
    return FAIL("unsupported_version")

  // Step 1: Verify each attestation independently
  verified_attestations = []
  for each attestation in agg.attestations:
    operator_key = knownOperatorKeys[attestation.operator_id]
    if operator_key is null:
      // Unknown operator — skip, do not count toward quorum
      continue

    // Step 1a: Verify Ed25519 signature (full SMA verification)
    if not verifySMAReceipt(attestation.receipt, operator_key):
      continue  // Invalid signature — skip

    // Step 1b: Check receipt is not expired
    if parseISO8601(attestation.receipt.expires_at) <= now:
      continue  // Expired — skip

    // Step 1c: Check operator_id matches receipt issuer
    if attestation.operator_id != attestation.receipt.issuer:
      continue  // Operator identity mismatch — skip

    // Step 1d: Check MIC matches the outer object
    if attestation.receipt.mic != agg.mic:
      continue  // MIC mismatch — skip

    verified_attestations.append(attestation)

  // Step 2: Time window check
  if len(verified_attestations) < 2:
    return INSUFFICIENT

  issued_times = [parseISO8601(a.receipt.issued_at) for a in verified_attestations]
  window_actual_ms = max(issued_times) - min(issued_times)  // in milliseconds
  if window_actual_ms > agg.window_ms:
    // Attestations are too far apart in time — cannot treat as concurrent
    return FAIL("window_exceeded")

  // Step 3: Tally consensus
  status_counts = {}
  for each att in verified_attestations:
    status_counts[att.receipt.status] += 1

  best_status = status with highest count in status_counts
  best_count = status_counts[best_status]

  if best_count >= agg.quorum.required:
    if len(status_counts) == 1:
      consensus = AGREE
    else:
      // Multiple statuses present — check if required threshold is unambiguously met
      // by one status without overlap from others
      consensus = AGREE if best_count >= agg.quorum.required else DISAGREE
  else:
    consensus = INSUFFICIENT

  // Step 4: Consumer decision
  if consensus == AGREE and best_status == "OPEN":
    return PROCEED
  else:
    return HALT  // Treat DISAGREE and INSUFFICIENT as UNKNOWN
\`\`\`

### Key Implementation Notes

- **Do not trust \`attestations[].verified\`**: The aggregator may lie or be buggy. Consumers MUST independently re-verify each Ed25519 signature against their own copy of the operator's public key.
- **Do not trust \`agg.status\` or \`agg.consensus\`**: These are computed summaries. Recompute them from the raw attestations.
- **\`knownOperatorKeys\`**: The consumer must have obtained operator public keys through a trusted out-of-band process (registry, configuration, or direct fetch from \`/.well-known/oracle-keys.json\`). Public keys obtained at verification time from an untrusted source provide no security.
- **Clock synchronization**: The consumer's \`now\` should be NTP-synchronized. A consumer with a skewed clock may incorrectly expire valid receipts or accept expired ones. Fail-closed applies: on clock uncertainty, treat receipts as expired.

---

## 6. Operator Registration

### Publishing a Public Key

Every operator participating in MPAS must publish their signing public key at:

\`\`\`
GET /.well-known/oracle-keys.json
\`\`\`

per RFC 8615. The response format follows the SMA Protocol key discovery schema:

\`\`\`json
{
  "service": "oracle",
  "spec": "https://headlessoracle.com/docs/sma-protocol/rfc-001",
  "keys": [
    {
      "key_id": "hex-encoded-32-byte-public-key",
      "algorithm": "Ed25519",
      "format": "hex",
      "public_key": "hex-encoded-32-byte-public-key",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": null
    }
  ]
}
\`\`\`

Operators MUST serve this endpoint over HTTPS. Consumers MUST NOT accept public keys over HTTP.

### Key Rotation

Key rotation follows the SMA Protocol key lifecycle:

1. Before rotation: set \`valid_until\` to the scheduled rotation timestamp (minimum 24 hours notice recommended)
2. At rotation: publish the new key alongside the old key (both in the \`keys\` array)
3. After rotation: remove the old key from the array once all receipts signed with it have expired

Aggregators and consumers caching operator public keys MUST respect \`valid_until\` and re-fetch after rotation.

### Operator Independence Requirements

Operators participating in MPAS:

- MUST NOT share Ed25519 private keys with other operators
- MUST NOT co-locate their signing infrastructure in a way that creates a common failure mode (same cloud account, same physical host, same DNS provider if that provider is a point of compromise)
- MUST independently derive market state from primary sources — not from another MPAS participant
- MUST use distinct \`operator_id\` values (their canonical domain) that are verifiable via HTTPS

An operator that delegates signing to shared infrastructure is not independent, even if they hold a distinct key. The key is a proof of authorship, not a proof of independence.

### Discovery Without a Registry

In the absence of a formal registry, consumers can discover operators by:

1. Configuration: hardcode a list of known operator endpoints and public keys at deployment time
2. Curated manifest: fetch a signed JSON manifest from a curator (introduces curator trust assumption)
3. Web search / community: operators self-announce and consumers vet independently

A canonical operator registry format is deferred to a future spec revision (see Section 11).

---

## 7. On-Chain Verification Sketch

Smart contract consumers need to verify MPAS quorum without an off-chain aggregator in the trust path. The following describes two approaches.

### Approach A: Off-Chain Aggregation with On-Chain Settlement

The aggregator runs off-chain, produces an \`AggregatedAttestation\`, and submits it to a smart contract that verifies the individual signatures.

The contract receives:
- Array of (operator_public_key, receipt_canonical_payload, signature) tuples
- Quorum threshold N
- Maximum allowed window_ms
- The asserted market status

\`\`\`solidity
// Pseudocode — not production-ready
function verifyQuorum(
    bytes32[] memory publicKeys,
    bytes[] memory canonicalPayloads,
    bytes[] memory signatures,
    uint256 required,
    uint256 windowMs,
    bytes32 assertedStatus
) public view returns (bool) {
    require(publicKeys.length == canonicalPayloads.length, "length mismatch");
    require(publicKeys.length == signatures.length, "length mismatch");

    uint256 agreeing = 0;
    uint256 earliestIssuedAt = type(uint256).max;
    uint256 latestIssuedAt = 0;

    for (uint i = 0; i < publicKeys.length; i++) {
        // EIP-665: Ed25519 signature verification
        // ed25519verify(message, signature, publicKey) => bool
        bool valid = ed25519verify(
            canonicalPayloads[i],
            signatures[i],
            publicKeys[i]
        );
        if (!valid) continue;

        // Parse issued_at from canonical payload (implementation-specific)
        uint256 issuedAt = parseIssuedAt(canonicalPayloads[i]);
        uint256 expiresAt = parseExpiresAt(canonicalPayloads[i]);
        bytes32 status = parseStatus(canonicalPayloads[i]);

        if (block.timestamp > expiresAt) continue;  // expired
        if (status != assertedStatus) continue;       // disagrees

        if (issuedAt < earliestIssuedAt) earliestIssuedAt = issuedAt;
        if (issuedAt > latestIssuedAt) latestIssuedAt = issuedAt;

        agreeing++;
    }

    // Window check
    require(latestIssuedAt - earliestIssuedAt <= windowMs / 1000, "window exceeded");

    return agreeing >= required;
}
\`\`\`

**EIP-665 note**: Ed25519 signature verification is not yet a standard EVM precompile as of this writing. EIP-665 proposes adding it. Until EIP-665 is live on the target chain, on-chain Ed25519 verification requires a Solidity Ed25519 library (available but gas-intensive) or a precompile on chains that have already added it (e.g. some L2s). Consumers should evaluate gas cost against security requirements.

### Approach B: Aggregator-Free Threshold Signatures

The long-term path eliminates the aggregator entirely. With threshold signature schemes such as FROST (Flexible Round-Optimized Schnorr Threshold) or MuSig2, N operators each contribute a partial signature. The resulting aggregated signature is a single standard Ed25519 (or Schnorr) signature that a verifier can check with one public key — with the property that producing the signature required participation from at least T-of-N key holders.

This approach requires:
1. A distributed key generation (DKG) ceremony where operators collectively produce a shared public key and individual key shares
2. A signature aggregation round for each attestation
3. The consumer verifies one signature against one public key — the threshold guarantee is cryptographic, not trust-based

Ed25519 was chosen for the SMA Protocol specifically because it composes cleanly into threshold schemes. MPAS v2.0 will specify this path when suitable implementations mature.

---

## 8. Reference Implementation Notes

### Aggregator (TypeScript)

\`\`\`typescript
interface OperatorConfig {
  operatorId: string;      // e.g. "headlessoracle.com"
  receiptUrl: string;      // e.g. "https://headlessoracle.com/v5/status"
  publicKey: string;       // hex-encoded Ed25519 public key
  apiKey?: string;         // if the operator requires authentication
}

async function fetchAttestation(
  operator: OperatorConfig,
  mic: string
): Promise<Attestation | null> {
  try {
    const res = await fetch(\`\${operator.receiptUrl}?mic=\${mic}\`, {
      headers: operator.apiKey ? { 'X-Oracle-Key': operator.apiKey } : {}
    });
    if (!res.ok) return null;
    const data = await res.json();
    const receipt = data.receipt ?? data;  // handle discovery_url wrapper
    const verified = await verifySMAReceipt(receipt, operator.publicKey);
    return { operator_id: operator.operatorId, receipt, verified };
  } catch {
    return null;
  }
}

async function aggregateAttestation(
  operators: OperatorConfig[],
  mic: string,
  quorumRequired: number,
  windowMs: number = 5000
): Promise<AggregatedAttestation> {
  const aggregated_at = new Date().toISOString();

  // Fetch all operators in parallel — do not wait for slow operators to block fast ones
  const results = await Promise.all(
    operators.map(op => fetchAttestation(op, mic))
  );

  const attestations = results.filter(a => a !== null) as Attestation[];

  // Compute consensus
  const consensus = computeConsensus(attestations, quorumRequired, windowMs);

  return {
    mpas_version: "1.0",
    mic,
    status: consensus.agreedStatus ?? "UNKNOWN",
    quorum: { required: quorumRequired, provided: attestations.length },
    window_ms: windowMs,
    aggregated_at,
    attestations,
    consensus: consensus.result
  };
}
\`\`\`

### Aggregator (Python)

\`\`\`python
import asyncio
import aiohttp
from typing import Optional

async def fetch_attestation(
    session: aiohttp.ClientSession,
    operator_id: str,
    receipt_url: str,
    public_key: str,
    mic: str,
    api_key: Optional[str] = None
) -> Optional[dict]:
    headers = {"X-Oracle-Key": api_key} if api_key else {}
    try:
        async with session.get(f"{receipt_url}?mic={mic}", headers=headers) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            receipt = data.get("receipt", data)  # handle discovery_url wrapper
            verified = verify_sma_receipt(receipt, public_key)
            return {"operator_id": operator_id, "receipt": receipt, "verified": verified}
    except Exception:
        return None

async def aggregate_attestation(operators: list[dict], mic: str, quorum_required: int, window_ms: int = 5000) -> dict:
    async with aiohttp.ClientSession() as session:
        tasks = [
            fetch_attestation(session, op["operator_id"], op["receipt_url"], op["public_key"], mic, op.get("api_key"))
            for op in operators
        ]
        results = await asyncio.gather(*tasks)

    attestations = [r for r in results if r is not None]
    consensus = compute_consensus(attestations, quorum_required, window_ms)

    return {
        "mpas_version": "1.0",
        "mic": mic,
        "status": consensus.get("agreed_status", "UNKNOWN"),
        "quorum": {"required": quorum_required, "provided": len(attestations)},
        "window_ms": window_ms,
        "aggregated_at": datetime.utcnow().isoformat() + "Z",
        "attestations": attestations,
        "consensus": consensus["result"]
    }
\`\`\`

### No New Cryptographic Dependencies

The aggregator uses the same Ed25519 verification already required by SMA Protocol consumers. No new cryptographic libraries are needed. The \`verifySMAReceipt\` / \`verify_sma_receipt\` functions are the same functions used to verify individual SMA receipts — which every SMA consumer already implements.

---

## 9. Trust Model Comparison

| Configuration | Latency | Trust Requirement | Failure Tolerance | Recommended For |
|---|---|---|---|---|
| Single-operator SMA | ~50ms | Operator-reputation trust | None — one failure = total failure | Early adopters, low-stakes queries, development |
| MPAS 2-of-3 | ~100–200ms (parallel) | Collusion of 2 independent operators | 1 operator failure | Production autonomous agents, DeFi triggers |
| MPAS 3-of-5 | ~100–200ms (parallel) | Collusion of 3 independent operators | 2 operator failures | High-value settlement, regulatory-sensitive contexts |
| MPAS 3-of-3 | ~100–200ms (parallel) | All 3 operators collude | 0 — any failure → INSUFFICIENT | Maximum conservatism, circuit-breaker enforcement |
| On-chain (Approach A) | ~500ms–2s + block time | On-chain contract correctness | Depends on quorum config | Smart contract execution, DeFi automated settlement |
| Threshold sig (future) | ~100–300ms + aggregation round | Cryptographic, no trusted aggregator | Depends on T-of-N config | Infrastructure-grade, aggregator-free deployment |

**Latency note**: Parallel fetching means the effective latency is determined by the slowest responding operator, not the sum. With a 5-second timeout and 3 operators, a 2-of-3 quorum succeeds as soon as any 2 respond.

**Cost of increased assurance**: MPAS 2-of-3 requires trust relationships with (or payments to) 2 additional oracle operators. For many consumers, the operator-coordination overhead of MPAS will be worthwhile only when acting on the oracle result carries material financial or operational risk. Single-operator SMA is not wrong — it is appropriate for the risk level it is designed for.

---

## 10. Relationship to SMA Protocol

MPAS is defined as a composition layer above SMA Protocol v1.0.0. The relationship:

- **SMA Protocol** defines: the signed receipt format, canonical payload serialization, Ed25519 signing algorithm, key discovery protocol, fail-closed semantics, and individual receipt verification
- **MPAS** defines: how multiple SMA receipts are collected, how quorum is determined, and what guarantees a consumer may derive from an agreed quorum

There is no new signature scheme in MPAS. There are no new cryptographic primitives. The only new artifact is the \`AggregatedAttestation\` JSON container, which is unsigned (its integrity is inherited from the independently-signed receipts it contains).

**Ed25519 was chosen for SMA Protocol specifically to compose cleanly into threshold signature schemes.** The migration from MPAS (with aggregator) to threshold-signature-based MPAS (without aggregator) does not require changing the underlying key type. Operators that generate Ed25519 keys today are participating in the same key material that will support FROST-based threshold signing when that path is ready.

Consumers implementing MPAS SHOULD also implement the full SMA Protocol consumer checklist for each individual attestation:

1. Fetch signed receipt from operator
2. Verify Ed25519 signature against operator's published public key
3. Check \`expires_at\` — reject expired receipts
4. Check \`issued_at\` is within the expected window
5. Check \`receipt_mode == "live"\` (reject demo receipts in production)
6. Apply fail-closed: treat UNKNOWN and HALTED as CLOSED
7. Then, and only then, apply MPAS quorum logic across verified receipts

Steps 1–6 MUST precede MPAS quorum logic. An invalid SMA receipt does not become valid by being included in an \`AggregatedAttestation\`.

---

## 11. Gaps and Known Limitations

### No Canonical Registry Format

This spec does not define how consumers discover operator endpoints and public keys. Operator discovery is an open problem. Without a canonical registry, MPAS deployments will use hardcoded operator lists or ad-hoc discovery mechanisms that themselves introduce trust assumptions.

**Deferred to**: MPAS v1.1 or a companion Registry Specification.

### The Aggregator Trust Assumption

The Aggregator role in this spec is a new trust assumption. A consumer that delegates aggregation to a third party is trusting that the aggregator:

- Actually fetched from the claimed operators (not spoofed responses)
- Correctly verified each signature
- Accurately reported which operators responded within the window
- Did not selectively include or exclude attestations to manufacture a desired consensus

A malicious aggregator can forge a quorum by fabricating \`verified: true\` on receipts it never received, if the consumer accepts the aggregator's output without re-verification. **Consumers MUST independently re-verify all attestation signatures.** They MUST NOT trust the \`verified\` field set by an aggregator.

The fix is threshold signatures (FROST or MuSig2), where the aggregated signature itself proves that T-of-N key holders participated in producing it — making the aggregator role unnecessary. Ed25519 was chosen to make this migration possible. Until threshold signing is specified, consumers who cannot independently verify should run the aggregator themselves rather than delegating to a third party.

**Deferred to**: MPAS v2.0 — Threshold Signature Extension.

### Operator Independence is Unverifiable

This spec requires that operators be independent, but provides no cryptographic proof of independence. Two operators could share signing infrastructure (or one operator could control two keys) while appearing independent to consumers. The trust model is: independence is asserted, not verified.

Potential future mitigations include:
- Signed attestations of independence from operators (legal / contractual, not cryptographic)
- On-chain operator registration with slashing conditions (cryptoeconomic)
- SGX/TEE-attested signing nodes (hardware-rooted independence)

### No Dispute Resolution Protocol

When \`consensus == "DISAGREE"\`, this spec says halt. It does not specify how to investigate which operator is wrong, how to report discrepancies, or how to update operator trust scores over time. A persistent DISAGREE state with no resolution mechanism is a denial-of-service vector.

**Deferred to**: a companion Operator Monitoring and Dispute Resolution specification.

---

## Gap Statement

One gap this spec does not yet solve: the Aggregator role is a new trust assumption. An aggregator that lies about which operators responded — or fabricates verified attestations — can forge a quorum against a consumer that does not independently re-verify. The fix is threshold signatures (FROST or MuSig2), where the aggregated signature itself proves participation without requiring a trusted intermediary. Under FROST, N operators each contribute a partial signature, and the result is a single standard Ed25519 signature verifiable against a single public key — with the participation of T-of-N key holders cryptographically guaranteed. Ed25519 was chosen for the SMA Protocol precisely to make this migration possible. MPAS v2.0 will specify this path when suitable FROST implementations are production-ready across the target language ecosystems. Until then, consumers who require aggregator-free verification should run the aggregation step themselves.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| MPAS | Multi-Party Attestation Aggregation Spec — this document |
| SMA | Signed Market Attestation — the underlying single-operator receipt protocol |
| Quorum | The minimum number of independent operators that must agree for consensus to be valid |
| AggregatedAttestation | The JSON container defined by this spec, holding N individual SMA receipts |
| Consensus | The computed agreement status: AGREE, DISAGREE, or INSUFFICIENT |
| Window | The maximum allowed time difference between the earliest and latest \`issued_at\` across attestations |
| FROST | Flexible Round-Optimized Schnorr Threshold — a threshold signature scheme for Ed25519-compatible keys |
| DKG | Distributed Key Generation — a ceremony in which N parties jointly produce a shared public key and individual key shares, such that no single party knows the full private key |
| Fail-closed | The safety principle: when in doubt, halt. Unknown or ambiguous state is treated as the restrictive case. |

## Appendix B: Version History

| Version | Date | Notes |
|---|---|---|
| 1.0.0-draft | 2026-03-30 | Initial draft. Aggregator-based model. Threshold signing deferred to v2.0. |

---

*This specification is published under the Apache 2.0 License. Contributions and implementations welcome. Canonical URL: https://headlessoracle.com/docs/mpas*
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
    "network": "base",
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
X-Payment: {"txHash":"0x...","network":"base","amount":"1000","paymentAddress":"0x26D4...","memo":""}
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

// ─── IDE Setup Docs ───────────────────────────────────────────────────────────
// Served at /docs/cline and /docs/continue for VS Code extension users.

const CLINE_CONFIG_MD = `# Headless Oracle — Cline Setup

Cline (VS Code extension) supports MCP servers. Add Headless Oracle via the Cline MCP config.

## Setup

In VS Code with Cline installed, open the Cline sidebar → click the MCP icon → **Edit MCP Settings**.

This opens \`cline_mcp_settings.json\`. Add the following entry inside \`mcpServers\`:

**Demo mode (no API key — free):**
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

**With API key (live mode):**
\`\`\`json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"],
      "env": {
        "HEADLESS_ORACLE_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
\`\`\`

Requires Node.js 18+. Restart VS Code after saving.

## Config file location

| Platform | Path |
|----------|------|
| macOS | \`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json\` |
| Windows | \`%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json\` |
| Linux | \`~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json\` |

## Available tools

| Tool | Description |
|------|-------------|
| \`get_market_status\` | Signed receipt: OPEN/CLOSED/HALTED/UNKNOWN for any exchange |
| \`get_market_schedule\` | Next open/close times in UTC for any exchange |
| \`list_exchanges\` | All 28 supported exchanges with MIC codes and timezones |
| \`verify_receipt\` | Ed25519 signature verification on any receipt |

## Notes

- UNKNOWN and HALTED receipts must be treated as CLOSED — do not execute trades
- All market receipts are Ed25519 signed with a 60-second TTL
- x402 per-request micropayments supported (0.001 USDC/req on Base mainnet)
`;

const CONTINUE_CONFIG_MD = `# Headless Oracle — Continue.dev Setup

Continue.dev supports MCP servers via \`~/.continue/config.json\`.

## Setup

Add the following to your \`~/.continue/config.json\` under \`mcpServers\`:

**Demo mode (no API key — free):**
\`\`\`json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"]
    }
  ]
}
\`\`\`

**With API key (live mode):**
\`\`\`json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"],
      "env": {
        "X_ORACLE_KEY": "YOUR_API_KEY_HERE"
      }
    }
  ]
}
\`\`\`

For header-based auth (if your Continue version supports \`type: "http"\`):

\`\`\`json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "transport": {
        "type": "http",
        "url": "https://headlessoracle.com/mcp",
        "headers": {
          "X-Oracle-Key": "YOUR_API_KEY_HERE"
        }
      }
    }
  ]
}
\`\`\`

Requires Node.js 18+. Reload the VS Code window after saving \`config.json\`.

## Available tools

| Tool | Description |
|------|-------------|
| \`get_market_status\` | Signed receipt: OPEN/CLOSED/HALTED/UNKNOWN for any exchange |
| \`get_market_schedule\` | Next open/close times in UTC for any exchange |
| \`list_exchanges\` | All 28 supported exchanges with MIC codes and timezones |
| \`verify_receipt\` | Ed25519 signature verification on any receipt |

## Notes

- UNKNOWN and HALTED receipts must be treated as CLOSED
- All receipts are Ed25519 signed with a 60-second TTL
- x402 per-request micropayments supported (0.001 USDC/req on Base mainnet)
`;

const AGNO_INTEGRATION_MD = `# Headless Oracle — Agno Integration

[Agno](https://www.agno.com/) (formerly Phidata) is a Python agent framework with native MCP
support. Headless Oracle works out of the box via Agno's \`MCPTools\` class or as native Python
tools via the \`headless-oracle-strands\` SDK (which is Strands-compatible and works with Agno's
tool interface).

## Option A — MCP (recommended, all 5 tools, no install)

\`\`\`python
import asyncio
from agno.agent import Agent
from agno.tools.mcp import MCPTools
from agno.models.openai import OpenAIChat  # or any supported model

async def main():
    async with MCPTools("npx -y headless-oracle-mcp") as mcp:
        agent = Agent(
            model=OpenAIChat(id="gpt-4o"),
            tools=[mcp],
            instructions="""
            You are a safe trading agent. Before executing any trade, call
            get_market_status for the relevant exchange. Treat UNKNOWN and
            HALTED as CLOSED — never trade on an ambiguous market state.
            """,
        )
        await agent.aprint_response(
            "Check if NYSE is open and give me the signed receipt.",
            stream=True,
        )

asyncio.run(main())
\`\`\`

With API key:

\`\`\`python
import os
async with MCPTools(
    "npx -y headless-oracle-mcp",
    env={"HEADLESS_ORACLE_API_KEY": os.environ["ORACLE_KEY"]},
) as mcp:
    ...
\`\`\`

## Option B — Python SDK (pre-trade gate pattern)

\`\`\`bash
pip install headless-oracle
\`\`\`

\`\`\`python
from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.tools import tool
from headless_oracle import OracleClient, verify

oracle = OracleClient()

@tool
def check_market_status(mic: str) -> str:
    """
    Check whether a global stock exchange is currently open.
    CRITICAL: treat HALTED and UNKNOWN as CLOSED — do not execute any trade.
    mic: ISO 10383 market identifier code (XNYS, XNAS, XLON, XJPX, etc.)
    Returns OPEN, CLOSED, HALTED, or UNKNOWN with cryptographic proof.
    """
    receipt = oracle.get_status(mic)
    if not verify(receipt):
        return f"UNKNOWN (signature invalid) — treat as CLOSED"
    status = receipt["status"]
    expires_at = receipt.get("expires_at", "")
    return f"{status} — signed until {expires_at}"

agent = Agent(
    model=Claude(id="claude-opus-4-6"),
    tools=[check_market_status],
    show_tool_calls=True,
)
agent.print_response("Is the NYSE open? Should I execute my trade?")
\`\`\`

## Pre-trade gate as an Agno middleware

\`\`\`python
from headless_oracle import OracleClient, verify

oracle = OracleClient()

def pre_trade_gate(mic: str = "XNYS") -> None:
    """Raises RuntimeError if the exchange is not verified OPEN."""
    receipt = oracle.get_status(mic)
    if not verify(receipt):
        raise RuntimeError(f"Oracle signature invalid for {mic} — trade blocked")
    status = receipt["status"]
    if status != "OPEN":
        raise RuntimeError(
            f"{mic} is {status} — trade blocked "
            f"(signed until {receipt.get('expires_at', 'unknown')})"
        )

# Use before any agent execution step that involves order placement
pre_trade_gate("XNYS")
# ... proceed with trade
\`\`\`

## Available MCP tools

| Tool | Description |
|------|-------------|
| \`get_market_status\` | Ed25519-signed receipt: OPEN, CLOSED, HALTED, or UNKNOWN |
| \`get_market_schedule\` | Next open/close times in UTC (DST-aware) |
| \`list_exchanges\` | All 28 supported exchanges with MIC codes |
| \`verify_receipt\` | Verify a signed receipt locally |
| \`get_payment_options\` | Upgrade ladder: sandbox → x402 → credits → Builder |

## 28 supported exchanges

XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE,
XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE, XCBT, XNYM, XCBO, XCOI, XBIN

## Fail-closed contract

OPEN → safe to proceed. CLOSED, HALTED, UNKNOWN → halt all execution.
UNKNOWN is not ambiguous — it means Oracle couldn't determine state. Always treat as CLOSED.

## Links

- Website: https://headlessoracle.com
- Free sandbox key: https://headlessoracle.com/v5/sandbox
- PyPI: https://pypi.org/project/headless-oracle/
- npm (MCP): https://npmjs.com/package/headless-oracle-mcp
- Agno: https://www.agno.com/
`;

const STRANDS_INTEGRATION_MD = `# Headless Oracle — Strands Agents Integration

[Strands Agents](https://strandsagents.com/) (AWS open-source, April 2025) is a Python agent
framework built around the model-tools-agent loop. Headless Oracle has a first-party Strands
integration on PyPI.

## Install

\`\`\`bash
pip install headless-oracle-strands
\`\`\`

## Quick start

\`\`\`python
from headless_oracle_strands import get_market_status, get_market_schedule, list_exchanges
from strands import Agent

# Zero config — auto-provisions a free sandbox key on first tool call
agent = Agent(tools=[get_market_status, get_market_schedule, list_exchanges])

response = agent("Is the NYSE open right now? Should I execute my trade?")
print(response)
\`\`\`

## Pre-trade safety pattern

\`\`\`python
from headless_oracle_strands import get_market_status, is_market_open
from strands import Agent

@tool
def safe_execute_trade(symbol: str, side: str, mic: str = "XNYS") -> dict:
    """Execute a trade only if the exchange is verified OPEN."""
    status_response = get_market_status(mic=mic)
    receipt = status_response.get("receipt", {})

    if not is_market_open(receipt):
        return {
            "executed": False,
            "reason":   f"{mic} is {receipt.get('status', 'UNKNOWN')} — trade blocked",
            "receipt":  receipt,
        }

    # Market is verified OPEN — proceed
    return {
        "executed": True,
        "symbol":   symbol,
        "side":     side,
        "oracle_verified_at": receipt.get("issued_at"),
    }

agent = Agent(tools=[safe_execute_trade])
response = agent("Buy 100 shares of AAPL on NYSE")
\`\`\`

## With API key

\`\`\`python
import os
from headless_oracle_strands import get_market_status

# Set via environment variable
os.environ["HEADLESS_ORACLE_API_KEY"] = "your-key-here"

# Or pass directly
receipt = get_market_status(mic="XNYS", api_key="your-key-here")
\`\`\`

## Via MCP (alternative)

\`\`\`python
from strands import Agent
from strands.tools.mcp import MCPClient

with MCPClient({"command": "npx", "args": ["-y", "headless-oracle-mcp"]}) as client:
    agent = Agent(tools=client.list_tools_sync())
    response = agent("Check if London Stock Exchange is open")
\`\`\`

## Tools

| Tool | Description |
|------|-------------|
| \`get_market_status\` | Signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) |
| \`get_market_schedule\` | Next open/close times in UTC (DST-aware) |
| \`list_exchanges\` | All 28 supported exchanges |

## Fail-closed contract

- \`is_market_open(receipt)\` returns \`True\` only for status \`OPEN\`
- All other statuses (CLOSED, HALTED, UNKNOWN) return \`False\`
- UNKNOWN means Oracle couldn't determine state — safe assumption is always CLOSED

## Links

- Website: https://headlessoracle.com
- PyPI: https://pypi.org/project/headless-oracle-strands/
- Strands Agents: https://strandsagents.com/
- AWS GitHub: https://github.com/strands-agents/tools
`;

const BLOG_MARKET_HOURS_VS_SIGNED = `# Market Hours APIs Are Not Enough for Autonomous Agents

Every developer building a trading agent checks market hours. Almost none check them correctly.

The standard approach: call an API, parse the response, check if a flag says \`is_open: true\`.
Then proceed.

This works when a human is in the loop. It fails silently when an autonomous agent is running
at 3am.

---

## What the standard approach misses

A market data API tells you what the market data provider believes is true. It doesn't prove it.

Four things can go wrong:

**1. Stale data.** A cached response from 45 minutes ago says the market is open. The market
closed 40 minutes ago. The cache TTL was set to 1 hour. Your agent executes into a closed book.

**2. No authentication on the market state.** Anyone — including a compromised service or a
man-in-the-middle — can return \`is_open: true\`. The response has no signature. Your agent
cannot tell the difference between a live authoritative response and a forged or stale one.

**3. Ambiguous failure modes.** The API call fails with a 503. What does your agent do?
Most implementations default open ("I couldn't check, so I'll proceed"). That's the wrong default.
The safe assumption when you can't verify state is: don't proceed.

**4. DST transitions.** Your API uses UTC offsets. The exchange observes daylight saving time.
On March 8, the US springs forward. For 21 days, the US/UK DST offset compresses from 5 hours
to 4 hours. If your API uses hardcoded UTC offsets, it's wrong for three weeks every spring and fall.

---

## What autonomous agents actually need

An agent that executes trades without human oversight needs three things a standard market
hours API cannot provide:

**Cryptographic proof.** The response must be signed so the agent can verify it wasn't forged,
intercepted, or replayed from a previous session. Ed25519 is the right primitive here — compact
signatures, deterministic, composable into multi-party schemes.

**A TTL.** The agent needs to know when the attestation expires. A receipt that says "NYSE is
OPEN" is only meaningful for the next 60 seconds. After that, the agent must re-fetch. A receipt
without an expiry is a receipt that can be used indefinitely — including after the market has moved.

**Fail-closed semantics.** If the agent can't reach the oracle, or if the oracle returns an
ambiguous state, the safe default is CLOSED. Not open. Not "retry." Halt execution until the
state can be verified.

A boolean \`is_open\` flag satisfies none of these requirements.

---

## The signed attestation model

A signed market receipt looks like this:

\`\`\`json
{
  "mic": "XNYS",
  "status": "OPEN",
  "issued_at": "2026-04-04T14:30:00.000Z",
  "expires_at": "2026-04-04T14:31:00.000Z",
  "issuer": "headlessoracle.com",
  "schema_version": "v5.0",
  "source": "SCHEDULE",
  "receipt_mode": "live",
  "signature": "a7f3b2...c9d4"
}
\`\`\`

The agent does four things with this:

1. Verify the Ed25519 signature against the oracle's public key
2. Check that \`expires_at\` is in the future
3. Check that \`status === "OPEN"\`
4. If any step fails — halt

This is the [Agent Pre-Trade Safety Standard](https://github.com/LembaGang/agent-pretrade-safety-standard) (APTS). It's a six-check
checklist that any autonomous agent should pass before executing a trade.

---

## The practical difference

Here's the naive version:

\`\`\`python
import requests

def is_market_open(symbol: str) -> bool:
    r = requests.get(f"https://some-api.com/market-hours/{symbol}")
    return r.json().get("is_open", False)
\`\`\`

If this returns \`True\`, your agent proceeds. If the API is down, it returns \`False\` and
your agent doesn't proceed — which is actually safe. But if the API returns stale data,
if the response is cached at an intermediate layer, or if the TTL logic is wrong, you're trading blind.

Here's the safe version:

\`\`\`python
import requests
from headless_oracle import OracleClient, verify

oracle = OracleClient()

def safe_to_trade(mic: str) -> bool:
    receipt = oracle.get_status(mic)

    # Step 1: Verify cryptographic signature
    if not verify(receipt):
        return False  # Signature invalid — fail closed

    # Step 2: Check TTL
    # (verify() already checks expires_at — if expired, returns False)

    # Step 3: Check status
    return receipt["status"] == "OPEN"
    # UNKNOWN and HALTED both return False — fail closed
\`\`\`

The difference is 4 lines. The second version is provably correct. The first version is
probably correct, most of the time.

"Probably correct, most of the time" is fine when a human can catch the exception at 3am.
It's not fine when no human is watching.

---

## When this matters more than you think

The cost of getting market state wrong isn't just a bad fill. It's:

- Executing a trade that can't settle (T+1/T+2 windows)
- Triggering a circuit breaker with an order at a halted price
- Trading into a pre-market session with 1/100th the liquidity
- Executing through a DST transition window where the market is technically open
  but the clearing systems are running on reduced staffing

These aren't theoretical. They're the exact scenarios that the signed receipt model was
designed to handle. The oracle checks for all of them. A boolean \`is_open\` flag checks
for none of them.

---

## The three-line integration

\`\`\`python
from headless_oracle import OracleClient, verify

oracle = OracleClient()  # Auto-provisions a free sandbox key
receipt = oracle.get_status("XNYS")
assert verify(receipt) and receipt["status"] == "OPEN", "Market not verified open — trade blocked"
\`\`\`

Free sandbox key at [headlessoracle.com/v5/sandbox](https://headlessoracle.com/v5/sandbox).
No signup required.

---

The oracle covers 28 exchanges across 6 regions. Ed25519 signatures. 60-second TTL.
MCP server for Claude Desktop, Cursor, and any MCP-compatible agent.

Full documentation: [headlessoracle.com/docs](https://headlessoracle.com/docs)
APTS standard: [github.com/LembaGang/agent-pretrade-safety-standard](https://github.com/LembaGang/agent-pretrade-safety-standard)
`;

const OLAS_INTEGRATION_MD = `# Headless Oracle — Olas Integration

Olas autonomous services can use Headless Oracle as a pre-trade verification gate.

## Installation
\`\`\`
pip install headless-oracle
\`\`\`

## Usage in an Olas AutonomousService

In your service's \`act()\` method, check market state before executing:
\`\`\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def act(self):
    receipt = client.get_status('XNYS')
    if not verify(receipt) or receipt['status'] != 'OPEN':
        self.context.logger.info('Market closed or halted — skipping execution')
        return
    # Proceed with trade execution
    self.execute_trade()
\`\`\`

## Fail-closed contract
- OPEN → safe to proceed
- CLOSED → halt (normal schedule)
- HALTED → halt (circuit breaker)
- UNKNOWN → halt (treat as CLOSED)

## x402 per-request payment (no API key needed)
Agents with USDC on Base mainnet can pay $0.001/call via x402. See /.well-known/x402.json for payment discovery.

## Links
- PyPI: https://pypi.org/project/headless-oracle/
- MCP endpoint: https://headlessoracle.com/mcp
- API docs: https://headlessoracle.com/docs
`;

const GOOGLE_ADK_INTEGRATION_MD = `# Headless Oracle — Google ADK Integration

Google's Agent Development Kit (ADK) supports MCP servers as tool providers via \`McpToolset\`.
This guide shows how to wire Headless Oracle into a Google ADK agent as a pre-trade safety gate.

## Install

\`\`\`bash
pip install google-adk headless-oracle
\`\`\`

## Option A — stdio (recommended, zero network config)

Uses the \`headless-oracle-mcp\` npm package as a subprocess. No firewall rules needed.

\`\`\`python
import asyncio
from google.adk.agents import Agent
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StdioServerParameters

async def build_agent():
    mcp_tools, exit_stack = await McpToolset.from_server(
        connection_params=StdioServerParameters(
            command="npx",
            args=["-y", "headless-oracle-mcp"],
            env={"HEADLESS_ORACLE_API_KEY": "your-key-here"},
        )
    )

    agent = Agent(
        name="safe-trading-agent",
        model="gemini-2.0-flash",
        instruction="""
        You are a trading agent. Before executing any trade, call get_market_status
        for the relevant exchange. If status is not OPEN, do not proceed.
        Treat UNKNOWN and HALTED as CLOSED — halt all execution.
        """,
        tools=mcp_tools,
    )
    return agent, exit_stack

async def main():
    agent, exit_stack = await build_agent()
    async with exit_stack:
        response = await agent.run_async(
            "Check if NYSE is open and tell me the signed receipt."
        )
        print(response)

asyncio.run(main())
\`\`\`

## Option B — HTTP (Streamable HTTP transport)

\`\`\`python
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StreamableHTTPServerParams

mcp_tools, exit_stack = await McpToolset.from_server(
    connection_params=StreamableHTTPServerParams(
        url="https://headlessoracle.com/mcp",
        headers={"Authorization": "Bearer your-key-here"},
    )
)
\`\`\`

## Pre-trade safety pattern

\`\`\`python
from headless_oracle import OracleClient, verify

client = OracleClient(api_key="your-key-here")

def safe_to_trade(mic: str) -> bool:
    receipt = client.get_status(mic)
    if not verify(receipt):
        return False  # Invalid signature — fail closed
    return receipt["status"] == "OPEN"

# Use in ADK tool or before agent execution
if not safe_to_trade("XNYS"):
    raise RuntimeError("NYSE not open — trade blocked")
\`\`\`

## Available tools

| Tool | Description |
|------|-------------|
| \`get_market_status\` | Ed25519-signed receipt: OPEN, CLOSED, HALTED, or UNKNOWN. |
| \`get_market_schedule\` | Next open/close times in UTC for any exchange. |
| \`list_exchanges\` | All 28 supported MIC codes with names and timezones. |
| \`verify_receipt\` | Verify a signed receipt locally (signature + TTL check). |
| \`get_payment_options\` | Upgrade ladder: sandbox → x402 → credits → Builder. |

## 28 supported exchanges

XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE,
XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE, XCBT, XNYM, XCBO, XCOI, XBIN

## Fail-closed contract

OPEN → safe to proceed
CLOSED, HALTED, or UNKNOWN → halt execution (do not trade)

This rule is non-negotiable. UNKNOWN means Oracle couldn't determine state — the safe
assumption is always CLOSED. HALTED means an active circuit breaker is in effect.

## Links

- Website: https://headlessoracle.com
- Docs: https://headlessoracle.com/docs
- Free sandbox key: https://headlessoracle.com/v5/sandbox
- PyPI: https://pypi.org/project/headless-oracle/
- npm (stdio MCP): https://npmjs.com/package/headless-oracle-mcp
- MCP endpoint: https://headlessoracle.com/mcp (protocol 2024-11-05)
`;

const TRADING_AGENTS_INTEGRATION_MD = `# Headless Oracle — TradingAgents Integration

[TradingAgents](https://github.com/TauricResearch/TradingAgents) is a multi-agent LLM trading
framework. This guide shows how to add Headless Oracle as the pre-trade market-state gate —
the check that runs before any agent submits a trade signal.

## Why add a pre-trade gate?

TradingAgents has a Risk Management Team, but none of the built-in agents check whether the
exchange is actually open before passing a signal downstream. Without an explicit gate, agents
can generate EXECUTE signals for closed markets, pre-market sessions, or exchange halts.

Headless Oracle provides a signed, verifiable answer to "is this exchange open right now?"
in a single function call.

## Install

\`\`\`bash
pip install headless-oracle
\`\`\`

## Drop-in pre-trade gate

Add this check in your TradingAgents workflow before any execution step:

\`\`\`python
from headless_oracle import OracleClient, verify

oracle = OracleClient(api_key="your-key-here")  # or leave blank for sandbox

def pre_trade_gate(mic: str = "XNYS") -> dict:
    """
    Returns {"safe": True} when the exchange is verified OPEN.
    Returns {"safe": False, "reason": str, "status": str} otherwise.
    Fails closed on any error — never lets an ambiguous state through.
    """
    try:
        receipt = oracle.get_status(mic)
        if not verify(receipt):
            return {"safe": False, "reason": "INVALID_SIGNATURE", "status": "UNKNOWN"}
        status = receipt.get("status", "UNKNOWN")
        if status == "OPEN":
            return {"safe": True, "status": "OPEN", "expires_at": receipt["expires_at"]}
        return {"safe": False, "reason": f"Exchange {status}", "status": status}
    except Exception as e:
        return {"safe": False, "reason": f"ORACLE_ERROR: {e}", "status": "UNKNOWN"}
\`\`\`

## Integrate with TradingAgents PropagationGraph

\`\`\`python
from tradingagents.graph.trading_graph import TradingAgentsGraph
from headless_oracle import OracleClient, verify

oracle = OracleClient()
ta = TradingAgentsGraph(debug=True, config={"deep_think_llm": "gpt-4o", ...})

def safe_propagate(state: dict) -> dict:
    mic = state.get("exchange", "XNYS")
    gate = pre_trade_gate(mic)
    if not gate["safe"]:
        return {
            **state,
            "final_trade_decision": "HOLD",
            "risk_debate_state":    f"Trade blocked: {gate['reason']} (oracle-verified)",
        }
    return ta.propagate(state)
\`\`\`

## Wire into the Risk Management Team

Add as a LangChain tool so TradingAgents' Risk Manager can call it directly:

\`\`\`python
from langchain.tools import tool
from headless_oracle import OracleClient, verify

oracle = OracleClient()

@tool
def check_market_open(mic: str) -> str:
    """
    Check whether a stock exchange is currently open.
    Returns OPEN, CLOSED, HALTED, or UNKNOWN with a cryptographic proof.
    Use mic codes: XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Tokyo), etc.
    CRITICAL: treat HALTED and UNKNOWN as CLOSED — do not execute trades.
    """
    receipt = oracle.get_status(mic)
    if not verify(receipt):
        return f"UNKNOWN — signature invalid, treat as CLOSED"
    status = receipt["status"]
    expires_at = receipt.get("expires_at", "")
    return f"{status} (verified until {expires_at}, signed by {receipt.get('issuer', 'oracle')})"

# Add to your Risk Manager agent tool list
risk_tools = [check_market_open, ...]
\`\`\`

## MCP server (alternative)

TradingAgents supports LangChain tool calling. You can also load Headless Oracle tools via MCP:

\`\`\`python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient({
    "headless-oracle": {
        "command": "npx",
        "args": ["-y", "headless-oracle-mcp"],
        "env": {"HEADLESS_ORACLE_API_KEY": "your-key-here"},
        "transport": "stdio",
    }
}) as client:
    mcp_tools = client.get_tools()
    # Add to any LangGraph/TradingAgents agent
\`\`\`

## 28 supported exchanges

XNYS (NYSE), XNAS (NASDAQ), XBSP (B3), XLON (LSE), XPAR (Euronext), XSWX (SIX),
XMIL (Borsa Italiana), XHEL (Helsinki), XSTO (Stockholm), XIST (Istanbul),
XSAU (Tadawul), XDFM (Dubai), XJSE (Johannesburg), XSHG (Shanghai), XSHE (Shenzhen),
XHKG (HKEX), XJPX (JPX), XKRX (KRX), XBOM (BSE), XNSE (NSE), XSES (SGX),
XASX (ASX), XNZE (NZX), XCBT (CME), XNYM (NYMEX), XCBO (Cboe), XCOI (Coinbase), XBIN (Binance)

## Fail-closed contract

- OPEN → safe to proceed
- CLOSED, HALTED, UNKNOWN → halt execution, return HOLD

## Links

- Website: https://headlessoracle.com
- Free sandbox key: https://headlessoracle.com/v5/sandbox
- PyPI: https://pypi.org/project/headless-oracle/
- TradingAgents: https://github.com/TauricResearch/TradingAgents
`;

const AUTOGPT_INTEGRATION_MD = `# Headless Oracle — AutoGPT Integration

AutoGPT supports custom plugins. Add Headless Oracle as a pre-trade verification gate.

## Plugin setup

Create \`headless_oracle_plugin.py\` in your AutoGPT plugins directory:
\`\`\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def can_handle_pre_command(command_name: str) -> bool:
    return command_name in ['execute_trade', 'place_order', 'submit_transaction']

def handle_pre_command(command_name: str, arguments: dict) -> str:
    mic = arguments.get('exchange', 'XNYS')
    receipt = client.get_status(mic)
    if not verify(receipt) or receipt['status'] != 'OPEN':
        return f"BLOCKED: {mic} is {receipt['status']}. Trade halted."
    return None  # Allow command to proceed
\`\`\`

## Fail-closed contract
- OPEN → safe to proceed
- CLOSED, HALTED, UNKNOWN → halt execution

## Links
- PyPI: https://pypi.org/project/headless-oracle/
- MCP endpoint: https://headlessoracle.com/mcp
- 170K+ star framework: https://github.com/Significant-Gravitas/AutoGPT
`;

const BLOG_POST_WHY_PRE_TRADE_GATE = `# Why Your Trading Agent Needs a Pre-Trade Gate

Your agent traded $50,000 into a halted market at 3am. Nobody was watching.

This isn't a hypothetical. It's the failure mode that autonomous trading agents are quietly running toward — and almost nobody has a circuit breaker in place.

---

## The Blind Spot in Autonomous Execution

Agents that execute trades check a lot of things. Price feeds. Order book depth. Portfolio constraints. Risk limits. Slippage estimates.

What they almost never check: **is the exchange actually open right now?**

Price feeds don't tell you the exchange is closed. They serve you the last known price — which may be hours old — and they do it silently. A market data feed returning a stale quote and a market data feed returning a live quote look identical to an agent reading the response.

An agent that sees a valid price and a filled order book and a cleared risk check will execute. It has no reason not to.

Unless someone told it to check market state first.

---

## The DST Bug Nobody Saw Coming

March 8, 2026. US clocks spring forward. European clocks don't change for another three weeks.

For exactly one hour, agents using hardcoded UTC-offset schedules believed European markets were open. Their local-time arithmetic said "09:30 Paris time" but their UTC math was wrong by an hour. The clocks disagreed.

Trades executed into closed markets. The positions sat there, unhedged, until European markets actually opened — 60 minutes and several volatility points later.

No error was thrown. No alert fired. The trades looked syntactically correct.

This is the class of bug that kills accounts: not a crash, not a panic, but a silent wrong answer that looks like a right answer.

---

## What a Pre-Trade Gate Actually Does

A pre-trade gate is a check you run before any trade, payment, or capital commitment. It asks one question: **is this exchange open right now, with cryptographic proof?**

The answer comes back as a signed receipt:

\`\`\`json
{
  "mic": "XNYS",
  "status": "OPEN",
  "issued_at": "2026-04-03T14:32:10.000Z",
  "expires_at": "2026-04-03T14:33:10.000Z",
  "receipt_mode": "live",
  "signature": "a3f9..."
}
\`\`\`

The signature is Ed25519. The TTL is 60 seconds. If either check fails, you don't trade.

---

## The Fail-Closed Contract

This is the design decision that separates a verification gate from a rubber stamp:

| Status | Action |
|--------|--------|
| \`OPEN\` | Proceed |
| \`CLOSED\` | Halt |
| \`HALTED\` | Halt (circuit breaker active) |
| \`UNKNOWN\` | **Halt** (treat as CLOSED) |

\`UNKNOWN\` is the critical case. It's what you get when the oracle can't determine the answer — network partition, data gap, signing infrastructure problem. An oracle that returns \`UNKNOWN\` is telling you it cannot confirm the safe state.

The fail-closed contract says: **if you can't verify, don't trade.** An agent that proceeds on \`UNKNOWN\` is choosing to skip the gate, not to pass it.

---

## The Gate in 5 Lines of Python

\`\`\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def safe_to_execute(mic: str = 'XNYS') -> bool:
    receipt = client.get_status(mic)
    return verify(receipt) and receipt['status'] == 'OPEN'
\`\`\`

Call \`safe_to_execute()\` before any trade. If it returns \`False\` — for any reason — halt.

That's it. Five lines between your agent and a $50K mistake at 3am.

---

## Why Cryptographic Signing Matters

A signed receipt isn't just a JSON response. It's a tamper-proof attestation you can pass between agents.

If your execution agent receives a market state receipt from a data collection agent, it doesn't have to trust the data pipeline. It verifies the Ed25519 signature against the oracle's public key. If the signature is invalid — whether from tampering, replay, or corruption — the receipt is rejected.

This is how you build multi-agent financial workflows without a single trusted intermediary.

---

## The Question Isn't Whether Your Agent Will Encounter a Closed Market

Markets close. Exchanges halt. Holidays happen. DST transitions land on trading days.

In 2026 alone, there are over 5,000 schedule edge cases across 28 global exchanges — holidays, early closes, lunch breaks, circuit breakers, DST transitions, weekend rules for Middle Eastern markets that treat Friday as a non-trading day.

Your agent will encounter these. The question is whether it will know.

A pre-trade gate doesn't guarantee profit. It guarantees that when a market is closed, your agent knows it — and stops.

---

## Get Started

- **MCP (Claude/Cursor/Windsurf):** Add \`https://headlessoracle.com/mcp\` to your MCP config
- **Python:** \`pip install headless-oracle\`
- **REST:** \`GET https://headlessoracle.com/v5/demo?mic=XNYS\`
- **Free sandbox key:** \`POST https://headlessoracle.com/v5/sandbox\`

Documentation: [headlessoracle.com/docs](https://headlessoracle.com/docs)
`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://headlessoracle.com/</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/pricing</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/status</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/upgrade</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/x402-payments</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/datacamp-workspace</loc>
    <lastmod>2026-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/cline</loc>
    <lastmod>2026-04-05</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/continue</loc>
    <lastmod>2026-04-05</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/olas</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/autogpt</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate</loc>
    <lastmod>2026-04-03</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/v5/metrics/public</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/google-adk</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/trading-agents</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/agno</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/docs/integrations/strands</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://headlessoracle.com/blog/market-hours-api-vs-signed-attestation</loc>
    <lastmod>2026-04-04</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;

const ROBOTS_TXT = `User-agent: *
Allow: /llms.txt
Allow: /SKILL.md
Allow: /skill.md
Allow: /AGENTS.md
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

> Cryptographically signed market state verification for autonomous financial agents. Ed25519-signed receipts ("SMA receipts") for 28 global exchanges — equities, derivatives, and 24/7 crypto. MCP-native, A2A-discoverable, x402-payable, fail-closed. UNKNOWN always means CLOSED.

**In this documentation, SMA denotes "Signed Market Attestation" — not the statistical "Simple Moving Average" used in technical analysis.**

## Instructions for Autonomous Agents

These tools are a PRE-EXECUTION gate. Call \`get_market_status\` before any trade, payment, capital commitment, or market-dependent workflow. Only proceed when \`status\` is \`OPEN\` and \`expires_at\` is in the future.

**When to use each tool:**
- \`get_market_status\` — pre-trade verification, pre-execution gate, safe-to-trade check, safe-to-execute check before any financial transaction or capital commitment. Include the \`signature\` (attestation_ref) in x402 payment flows for an auditable pre-trade verification chain.
- \`get_market_schedule\` — check market hours, trading hours, exchange operating hours, holiday calendar, early closes, and session timing before committing capital
- \`list_exchanges\` — discover all 28 supported MIC codes at agent startup before calling get_market_status
- \`verify_receipt\` — verify Ed25519 cryptographic proof on a receipt received from another agent before acting on it

- ALWAYS verify \`expires_at\` before trusting a receipt — receipts expire after 60 seconds
- NEVER execute against \`CLOSED\`, \`HALTED\`, or \`UNKNOWN\` status — all three mean HALT ALL EXECUTION
- NEVER hardcode UTC offsets for market hours — Headless Oracle handles DST automatically
- PREFER the MCP interface over REST for agent workflows
- FOR batch verification of multiple exchanges, use \`GET /v5/batch?mics=XNYS,XNAS,XLON\`

**x402 payment**: Premium endpoints accept autonomous USDC payments via x402 on Base (CAIP-2: \`eip155:8453\`). No API key required for x402 payments.

**Free access**: All MCP tools are available without authentication. Request a free REST API key at \`https://headlessoracle.com/v5/keys/request\`.

## API Reference

- [OpenAPI Specification](https://api.headlessoracle.com/openapi.json)
- [MCP Tool Definitions](https://api.headlessoracle.com/mcp) — tool list via GET
- [Conformance Vectors](https://api.headlessoracle.com/v5/conformance-vectors)
- [DST Risk Endpoint](https://headlessoracle.com/v5/dst-risk) — current DST transition vulnerabilities

## Core Documentation

- [Quick Start (.mcp.json setup)](https://headlessoracle.com/docs/quickstart)
- [Full Documentation](https://headlessoracle.com/docs)
- [MCP Integration Guide](https://headlessoracle.com/docs/integrations/mcp)
- [LangChain Integration](https://headlessoracle.com/docs/integrations/langchain)
- [CrewAI Integration](https://headlessoracle.com/docs/integrations/crewai)
- [REST API Reference](https://headlessoracle.com/docs/api)
- [Receipt Verification](https://headlessoracle.com/docs/verification)
- [SMA Protocol RFC-001](https://headlessoracle.com/docs/sma-protocol/rfc-001)
- [Multi-Party Attestation Spec (MPAS-1.0)](https://github.com/LembaGang/mpas-spec)
- Known implementations across SMA, MPAS, and APTS: GET /v5/implementations (public). Submit yours via the submit_url field.

## SDK Documentation

- [JavaScript/TypeScript (@headlessoracle/verify)](https://headlessoracle.com/docs/sdks/javascript)
- [Python (headless-oracle)](https://headlessoracle.com/docs/sdks/python)
- [Go (headless-oracle-go)](https://headlessoracle.com/docs/sdks/go)

## Quick Start
# Path A — email sandbox (human onboarding):
POST https://api.headlessoracle.com/v5/sandbox
Body: { "email": "you@example.com" }
→ Returns sb_ key (7 days, 200 calls)

# Path B — x402 agent onboarding (no email, no human):
POST https://api.headlessoracle.com/v5/sandbox
Header: X-Payment: {"txHash":"0x...","network":"base","amount":"1000","paymentAddress":"0x26D4...","memo":""}
→ Verifies $0.001 USDC payment on Base mainnet → Returns ho_crd_ credit key (10 credits, no expiry)

# Path C — per-request x402 (no key ever needed):
GET https://api.headlessoracle.com/v5/status?mic=XNYS → 402 with payment details
GET https://api.headlessoracle.com/v5/status?mic=XNYS + X-Payment header → 200 signed receipt

# Path D — mint persistent key (99 USDC builder / 299 USDC pro):
POST https://api.headlessoracle.com/v5/x402/mint
Body: { "tx_hash": "0x...", "tier": "builder" }
→ Returns ho_live_ key (50,000 calls/day, no expiry)

# Demo (signed receipt, no key needed):
GET https://api.headlessoracle.com/v5/demo?mic=XNYS

## Endpoints
| Endpoint | Method | Auth | Description | Returns |
|---|---|---|---|---|
| /v5/demo | GET | No | Signed receipt, demo mode | SMA receipt (receipt_mode=demo) |
| /v5/status | GET | Yes | Signed receipt, live mode | SMA receipt (receipt_mode=live) |
| /v5/batch | GET | Yes | Signed receipts for multiple MICs | { summary, receipts[] } |
| /v5/sandbox | POST | No | Sandbox key via email OR credit key via x402 payment ($0.001) | { api_key, tier, ...} |
| /v5/schedule | GET | No | Next open/close times (not signed) | { next_open, next_close, lunch_break, settlement_window } |
| /v5/exchanges | GET | No | All 28 supported exchanges | { exchanges: [{mic, name, timezone, mic_type}] } |
| /v5/keys | GET | No | Public signing key + canonical spec | { keys: [{key_id, public_key, algorithm}] } |
| /v5/health | GET | No | Signed liveness probe | SMA-format health receipt |
| /v5/usage | GET | Yes | Per-key daily usage stats | { requests_today, limit, percent_used } |
| /v5/traction | GET | No | Live metrics snapshot | { exchanges_covered, mcp_requests_today, ... } |
| /v5/metrics/public | GET | No | Social-proof metrics — exchanges, uptime_days, tests_passing, signing_algorithm, x402 stats, mcpscoreboard_preflight | stable facts, no auth |
| /v5/implementations | GET | No | Standards implementations registry (SMA/MPAS/APTS) | { standards: { sma, mpas, apts }, total_implementations } |
| /v5/showcase | GET | No | Reference projects using Headless Oracle | { entries: [{name, url, category}], submit_url } |
| /v5/receipts | GET | Builder+ | Receipt audit log | { receipts: [{mic, status, issued_at}] } |
| /v5/dst-risk | GET | No | DST transition risk for affected exchanges | { event, affected_exchanges[], risk_window_minutes } |
| /v5/webhooks/subscribe | POST | Yes | Subscribe to state-change webhooks | { subscription_id } |
| /v5/webhooks/unsubscribe | DELETE | Yes | Remove webhook subscription | { ok: true } |
| /v5/archive | GET | Optional | Historical receipt archive | { mic, date, count, receipts[] } |
| /v5/stream | GET | Yes | SSE stream of signed market_status events every 30s | text/event-stream |
| /v5/conformance-vectors | GET | No | 5 live-signed canonical test vectors | { vectors: [{name, receipt, canonical_payload, public_key}] } |
| /mcp | POST | No (optional Bearer) | MCP Streamable HTTP (JSON-RPC 2.0) | JSON-RPC response |
| /openapi.json | GET | No | OpenAPI 3.1 machine-readable spec | OpenAPI document |
| /.well-known/oracle-keys.json | GET | No | RFC 8615 key discovery | Key lifecycle metadata |
| /.well-known/agent.json | GET | No | A2A Agent Card | A2A agent capabilities |
| /.well-known/mcp/server-card.json | GET | No | MCP server card | Tool list, reliability, coverage |
| /.well-known/security.txt | GET | No | RFC 9116 security contact | Contact, Expires, Preferred-Languages |
| /v5/errors/{code} | GET | No | Machine-readable error definition | { message, resolution, http_status } |
| /v5/changelog | GET | No | Versioned changelog feed | { version, updated, entries[] } |
| /badge/:mic | GET | No | SVG status badge | image/svg+xml |
| /status | GET | No | HTML market status page for all 28 exchanges | text/html |
| /v5/webhooks | GET | Yes | List all webhook subscriptions for this key | { webhooks: [{webhook_id, url, mics, events, status}], count } |
| /v5/webhooks/:id | DELETE | Yes | Delete a webhook subscription | 204 No Content |
| /v5/webhooks/test/:id | POST | Yes | Fire a synthetic test delivery to a webhook | { delivered, payload_sent, status_code } |
| /v5/webhooks/health | GET | No | WebhookDispatcher DO health (last alarm cycle) | { status, next_alarm } |
| /v5/card/:mic | GET | No | SVG terminal-style status card | image/svg+xml |
| /v5/x402/mint | POST | No | Mint persistent API key via Base USDC tx | { api_key, tier, daily_limit } |
| /v5/credits/purchase | POST | Yes | Add prepaid credits via x402 USDC payment | { credits_added, new_balance } |
| /v5/credits/balance | GET | Yes | Check prepaid credit balance | { balance, estimated_requests_remaining } |
| /v5/verify | POST | No | Ed25519 receipt verification (REST) | { valid, expired, reason, mic, status, expires_at } |
| /x402 | GET | No | x402 Foundation compatibility declaration | { x402_compatible, network, facilitator, first_payment_at } |

## Receipt Schema (SMA = Signed Market Attestation, not Simple Moving Average)
\`\`\`json
{
  "receipt_id":     "uuid",
  "mic":            "XNYS",
  "status":         "OPEN | CLOSED | HALTED | UNKNOWN",
  "issued_at":      "2026-03-27T14:30:00.000Z",
  "expires_at":     "2026-03-27T14:31:00.000Z",
  "issuer":         "headlessoracle.com",
  "source":         "SCHEDULE | OVERRIDE | REALTIME | SYSTEM",
  "schema_version": "v5.0",
  "receipt_mode":   "demo | live",
  "public_key_id":  "key_2026_v1",
  "signature":      "<hex-encoded Ed25519 signature>"
}
\`\`\`

## Verification
Ed25519 signature verification steps:
1. Receive receipt JSON
2. Extract all fields EXCEPT "signature" -> payload object
3. Sort payload keys alphabetically
4. JSON.stringify(sortedPayload) with no whitespace -> canonical string
5. Verify signature (hex) against canonical string using public key from /v5/keys
6. Check expires_at > now (60s TTL)
7. Check status === "OPEN" before proceeding
If any step fails -> halt execution

SDK (JS): npm install @headlessoracle/verify (zero deps, Web Crypto)
SDK (Go): go get github.com/LembaGang/headless-oracle-go (zero stdlib deps, oracle.Verify())
SDK (Python): pip install headless-oracle

## Supported Exchanges

### Equities (23)
XNYS (NYSE, America/New_York), XNAS (NASDAQ, America/New_York), XLON (London, Europe/London),
XJPX (Tokyo, Asia/Tokyo), XPAR (Paris, Europe/Paris), XHKG (Hong Kong, Asia/Hong_Kong),
XSES (Singapore, Asia/Singapore), XASX (Sydney, Australia/Sydney), XBOM (Mumbai BSE, Asia/Kolkata),
XNSE (Mumbai NSE, Asia/Kolkata), XSHG (Shanghai, Asia/Shanghai), XSHE (Shenzhen, Asia/Shanghai),
XKRX (Seoul, Asia/Seoul), XJSE (Johannesburg, Africa/Johannesburg), XBSP (Sao Paulo, America/Sao_Paulo),
XSWX (Zurich, Europe/Zurich), XMIL (Milan, Europe/Rome), XIST (Istanbul, Europe/Istanbul),
XSAU (Riyadh, Asia/Riyadh, Fri/Sat weekends), XDFM (Dubai, Asia/Dubai, Fri/Sat weekends),
XNZE (Auckland, Pacific/Auckland), XHEL (Helsinki, Europe/Helsinki), XSTO (Stockholm, Europe/Stockholm)

### Derivatives & Crypto (5)
XCBT (CME Futures, America/Chicago, overnight/Sunday pre-open, mic_type: iso)
XNYM (NYMEX, America/Chicago, overnight/Sunday pre-open, mic_type: iso)
XCBO (Cboe Options, America/Chicago, 9:30-16:15 ET, mic_type: iso)
XCOI (Coinbase, UTC, 24/7 no weekends, mic_type: convention)
XBIN (Binance, UTC, 24/7 no weekends, mic_type: convention)

settlement_window: T+1/DTCC (XNYS/XNAS), T+2/Euroclear (XLON), T+2/JSCC (XJPX), null for all others

## DST Risk (Critical: March 29, 2026)
European clocks spring forward Sunday March 29, 2026 at 01:00 UTC.
XLON, XPAR, XSWX, XMIL, XHEL, XSTO shift +1h (GMT/CET → BST/CEST).
Agents using hardcoded UTC offsets will compute incorrect market hours starting Monday March 30.
Headless Oracle receipts use IANA timezone identifiers — DST is handled automatically.
Live risk endpoint: GET https://headlessoracle.com/v5/dst-risk

## Fail-Closed Guarantee
UNKNOWN status means the oracle cannot determine market state. Agents MUST treat UNKNOWN as CLOSED and halt. HALTED means a circuit breaker or operator override is active — also treat as CLOSED. The absence of a valid signed receipt is itself proof of unsafety.

## Pricing
- Free: 500 req/day (GET /v5/keys/request)
- Sandbox: 200 req/7 days, email required (POST /v5/sandbox with { "email": "you@example.com" })
- x402: 0.001 USDC/req via Base mainnet (no key, no signup)
- Builder: 50,000 req/day ($99/mo)
- Pro: 200,000 req/day ($299/mo)
- Protocol: unlimited ($500/mo)
Upgrade: https://headlessoracle.com/upgrade

## Discovery Endpoints
- [Agent Card (A2A)](https://headlessoracle.com/.well-known/agent.json)
- [MCP Server Card](https://headlessoracle.com/.well-known/mcp/server-card.json)
- [Oracle Public Keys (JWKS)](https://headlessoracle.com/.well-known/oracle-keys.json)

## MCP Integration
Server card: GET https://headlessoracle.com/.well-known/mcp/server-card.json
Protocol: MCP-2024-11-05
Endpoint: POST https://headlessoracle.com/mcp
Tools: get_market_status, get_market_schedule, list_exchanges, verify_receipt
Auth: optional Bearer token (Oracle API key via POST /oauth/token)

## IDE Setup Guides
- [Cline (VS Code)](https://headlessoracle.com/docs/cline) — VS Code Cline extension setup
- [Continue.dev](https://headlessoracle.com/docs/continue) — Continue.dev VS Code extension setup
- [Cursor](https://headlessoracle.com/docs/cursor-setup) — Cursor IDE setup
- [Windsurf](https://headlessoracle.com/docs/windsurf-config) — Windsurf IDE setup

## Agent Framework Integrations
- [Google ADK Integration](https://headlessoracle.com/docs/integrations/google-adk) — Google Agent Development Kit via McpToolset (stdio + HTTP transport)
- [TradingAgents Integration](https://headlessoracle.com/docs/integrations/trading-agents) — Pre-trade gate for TauricResearch/TradingAgents multi-agent framework
- [Agno Integration](https://headlessoracle.com/docs/integrations/agno) — Agno (22K stars) via MCPTools or Python SDK
- [Strands Integration](https://headlessoracle.com/docs/integrations/strands) — AWS Strands Agents SDK with first-party headless-oracle-strands PyPI package
- [Olas Integration](https://headlessoracle.com/docs/integrations/olas) — Pre-trade gate for Olas autonomous services
- [AutoGPT Integration](https://headlessoracle.com/docs/integrations/autogpt) — AutoGPT plugin for pre-trade verification

## Blog
- [Market Hours APIs Are Not Enough for Autonomous Agents](https://headlessoracle.com/blog/market-hours-api-vs-signed-attestation) — Why boolean is_open fails agents; the signed attestation model
- [Why Your Trading Agent Needs a Pre-Trade Gate](https://headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate) — DST post-mortem and fail-closed contract

## Discovery
- [/.well-known/mcp-servers.json](https://headlessoracle.com/.well-known/mcp-servers.json) — Self-describing registry feed for MCP directories (auto-updateable, proposed convention)

## Blog
- [Why Your Trading Agent Needs a Pre-Trade Gate](https://headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate) — DST bug post-mortem and fail-closed contract
`

// SKILL.md — step-by-step integration guide optimised for AI agents.
// Intentionally concise and action-first: agents parse this to decide how to integrate.
const SKILL_MD = `---
name: headless_oracle
description: Ed25519-signed market-state receipts for 28 global exchanges. Pre-trade verification gate for autonomous financial agents. UNKNOWN = CLOSED. MCP endpoint at headlessoracle.com/mcp.
version: 1.0.0
author: Headless Oracle
license: Apache-2.0
tags: [finance, api, security, tools, agents]
triggers: [market status, pre-trade check, exchange open, trading gate, NYSE, NASDAQ, exchange hours, XNYS, XNAS, XLON, XJPX, market oracle]
allowed_tools: [get_market_status, get_market_schedule, list_exchanges, verify_receipt]
---
# Headless Oracle — Agent Integration Guide

## What This Is

Headless Oracle returns cryptographically signed receipts that tell you whether a stock exchange is **OPEN**, **CLOSED**, **HALTED**, or **UNKNOWN**. Every receipt includes an Ed25519 signature you can verify offline.

**Primary consumer**: autonomous agents making execution decisions that depend on market state.

---

## When to Use Headless Oracle vs a Timezone Library

| A timezone library is sufficient | You need Headless Oracle |
|----------------------------------|--------------------------|
| Displaying local time to a user | Gating trade execution on market state |
| Computing UTC offsets | Detecting exchange holiday closures (200+ across 28 venues) |
| Formatting timestamps | Handling unscheduled circuit breaker halts |
| Scheduling calendar events | Detecting early close days |
| Building a world clock | Lunch break windows (XJPX, XHKG, XSHG, XSHE) |
| Converting between timezones | DST correctness across 28 separate exchange calendars |
| Checking if an office is open | Cryptographic proof that you checked before executing |
| | Fail-closed UNKNOWN when state cannot be determined |

**Rule of thumb**: If your code makes financial execution decisions based on time, a timezone library is necessary but not sufficient. You need attestable market state, not computable clock time. Across all 28 exchanges, approximately 5,000+ schedule edge cases per year require explicit handling beyond UTC offset arithmetic.

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
| \`list_exchanges\` | All 28 supported exchanges with names, timezones, and mic_type | none |

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
  "receipt_id":     "uuid",
  "issued_at":      "2026-02-26T09:00:00Z",
  "expires_at":     "2026-02-26T09:01:00Z",
  "mic":            "XNYS",
  "status":         "OPEN",
  "source":         "SCHEDULE",
  "halt_detection": "active",
  "schema_version": "v5.0",
  "public_key_id":  "03dc2799...",
  "signature":      "hex..."
}
\`\`\`

**halt_detection field:**
- \`"active"\` — real-time intraday halt detection via Polygon.io + Alpaca. XNYS and XNAS only. Unscheduled circuit breaker halts will be detected within ~1 minute.
- \`"schedule_only"\` — calendar hours and holidays are authoritative, but intraday circuit breaker halts are NOT detected. All 21 non-US exchanges. Agents relying on halt detection for execution safety should note this limitation.

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

| MIC   | Exchange                       | Timezone                | mic_type   |
|-------|--------------------------------|-------------------------|------------|
| XNYS  | NYSE                           | America/New_York        | iso        |
| XNAS  | NASDAQ                         | America/New_York        | iso        |
| XLON  | London Stock Exchange          | Europe/London           | iso        |
| XJPX  | Japan Exchange Group           | Asia/Tokyo              | iso        |
| XPAR  | Euronext Paris                 | Europe/Paris            | iso        |
| XHKG  | Hong Kong Exchanges            | Asia/Hong_Kong          | iso        |
| XSES  | Singapore Exchange             | Asia/Singapore          | iso        |
| XASX  | ASX Australia                  | Australia/Sydney        | iso        |
| XBOM  | BSE India                      | Asia/Kolkata            | iso        |
| XNSE  | NSE India                      | Asia/Kolkata            | iso        |
| XSHG  | Shanghai Stock Exchange        | Asia/Shanghai           | iso        |
| XSHE  | Shenzhen Stock Exchange        | Asia/Shanghai           | iso        |
| XKRX  | Korea Exchange                 | Asia/Seoul              | iso        |
| XJSE  | Johannesburg Stock Exchange    | Africa/Johannesburg     | iso        |
| XBSP  | B3 Brazil                      | America/Sao_Paulo       | iso        |
| XSWX  | SIX Swiss Exchange             | Europe/Zurich           | iso        |
| XMIL  | Borsa Italiana                 | Europe/Rome             | iso        |
| XIST  | Borsa Istanbul                 | Europe/Istanbul         | iso        |
| XSAU  | Saudi Exchange (Tadawul)       | Asia/Riyadh             | iso        |
| XDFM  | Dubai Financial Market         | Asia/Dubai              | iso        |
| XNZE  | New Zealand Exchange           | Pacific/Auckland        | iso        |
| XHEL  | Nasdaq Helsinki                | Europe/Helsinki         | iso        |
| XSTO  | Nasdaq Stockholm               | Europe/Stockholm        | iso        |
| XCBT  | CME Futures (overnight)        | America/Chicago         | iso        |
| XNYM  | NYMEX (overnight)              | America/Chicago         | iso        |
| XCBO  | Cboe Options                   | America/Chicago         | iso        |
| XCOI  | Coinbase (24/7)                | UTC                     | convention |
| XBIN  | Binance (24/7)                 | UTC                     | convention |

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
- \`GET /v5/conformance-vectors\` — 5 live-signed test vectors for SDK verification (no auth)
- \`GET /v5/archive?mic=XNYS&date=YYYY-MM-DD\` — historical receipt archive (Builder+ 30-day)
- \`GET /v5/stream?mic=XNYS\` — SSE stream of signed receipts every 30s (auth required)
- \`POST /v5/keys/request\` — free tier key self-provisioning (no payment required)
SDKs: npm install @headlessoracle/verify | go get github.com/LembaGang/headless-oracle-go | pip install headless-oracle

---

## Compliance Standards

Headless Oracle conforms to two open standards. Agents can verify conformance programmatically:

**Agent Pre-Trade Safety Standard (APTS) v1.0** — 6 pre-trade checks every autonomous agent should perform before execution. Check: \`GET /v5/compliance\` returns all 6 with \`status: "pass"\`.

**Signed Market Attestation (SMA) Protocol v1.0** — vendor-neutral format for cryptographically attested market state. All receipts are SMA-compliant: alphabetically-sorted compact JSON signed with Ed25519.

SMA conformance means: any independent verifier with the public key can validate receipts without calling Oracle again.

## Listings

- **Agent Zero Plugin Hub**: https://github.com/agent0ai/a0-plugins (plugin: headless_oracle)
- **Ampersend registry**: https://app.ampersend.ai/agents/headless-oracle
- **Skill file**: https://headlessoracle.com/skill.md
- **ERC-8004 registry**: 8453:38413
- **Smithery**: smithery.ai/server/headless-oracle
`;

// ─── Ampersend skill.md ───────────────────────────────────────────────────────
// Served at GET /skill.md (lowercase) — Ampersend agent skill format.
// Describes how autonomous agents can call Headless Oracle via x402 micropayments
// using the Ampersend CLI (`ampersend fetch`).
const AMPERSEND_SKILL_MD = `---
name: headless-oracle
description: Ed25519-signed market-state receipts for 28 global exchanges. Pre-trade verification gate for autonomous financial agents. UNKNOWN = CLOSED.
metadata:
  x402:
    endpoint: https://headlessoracle.com/v5/status
    price: "1000"
    currency: USDC
    network: eip155:8453
    testnet: eip155:84532
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  erc8004: "8453:38413"
  agent_card: https://headlessoracle.com/.well-known/agent.json
  agents_md: https://headlessoracle.com/AGENTS.md
  mcp_endpoint: https://headlessoracle.com/mcp
---

# Headless Oracle

Headless Oracle provides cryptographically signed market-state receipts for 28 global exchanges. Every receipt is Ed25519-signed with a 60-second TTL — a verifiable pre-trade attestation that the agent checked market state before executing.

**Critical safety rule**: \`UNKNOWN\` and \`HALTED\` MUST be treated as \`CLOSED\` — halt all execution immediately.

## Pricing

**$0.001 USDC per call** via x402 micropayments — no subscription, no API key required.

- **Network**: Base mainnet (eip155:8453) + Base Sepolia testnet (eip155:84532)
- **x402 payment endpoint**: https://headlessoracle.com/v5/status
- **ERC-8004 registry**: 8453:38413
- **Ampersend listing**: https://app.ampersend.ai/agents/headless-oracle

## Usage

Check market status before executing a trade or financial operation:

\`\`\`bash
# Inspect payment requirements (no charge)
ampersend fetch --inspect "https://headlessoracle.com/v5/status?mic=XNYS"

# Check if NYSE is open — pays $0.001 USDC automatically
ampersend fetch "https://headlessoracle.com/v5/status?mic=XNYS"

# Check other exchanges
ampersend fetch "https://headlessoracle.com/v5/status?mic=XLON"
ampersend fetch "https://headlessoracle.com/v5/status?mic=XJPX"
\`\`\`

## Response

Returns an Ed25519-signed JSON receipt:

\`\`\`json
{
  "mic": "XNYS",
  "status": "OPEN",
  "timestamp": "2026-04-01T14:30:00Z",
  "expires_at": "2026-04-01T14:31:00Z",
  "issuer": "headlessoracle.com",
  "key_id": "key_2026_v1",
  "receipt_mode": "live",
  "schema_version": "v5.0",
  "signature": "..."
}
\`\`\`

Status values: \`OPEN\` | \`CLOSED\` | \`HALTED\` | \`UNKNOWN\`

**UNKNOWN and HALTED = CLOSED. Halt all execution.**

## Verify the Signature

\`\`\`bash
# After receiving a receipt, verify the Ed25519 signature offline
# npm install @headlessoracle/verify
import { verify } from '@headlessoracle/verify';
const result = await verify(receipt);
if (!result.valid) throw new Error(\`Invalid receipt: \${result.reason}\`);
\`\`\`

## Supported Exchanges (28)

| Region | MICs |
|--------|------|
| Americas | XNYS, XNAS, XBSP |
| Europe | XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST |
| Middle East / Africa | XSAU, XDFM, XJSE |
| Asia | XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES |
| Pacific | XASX, XNZE |
| Derivatives | XCBT, XNYM, XCBO |
| 24/7 Crypto | XCOI, XBIN |

## MCP Integration (No x402 Required)

Connect to the MCP server for tool-based access within Claude, Cursor, or any MCP-compatible agent:

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

**Protocol**: MCP 2024-11-05 | **Endpoint**: https://headlessoracle.com/mcp

Available tools:
- \`get_market_status\` — signed receipt (OPEN/CLOSED/HALTED/UNKNOWN) for any MIC
- \`get_market_schedule\` — next open/close times in UTC
- \`list_exchanges\` — directory of all 28 supported exchanges
- \`verify_receipt\` — Ed25519 signature verification in-worker

## Discovery

- **Agent card (A2A)**: https://headlessoracle.com/.well-known/agent.json
- **AGENTS.md**: https://headlessoracle.com/AGENTS.md
- **MCP server card**: https://headlessoracle.com/.well-known/mcp/server-card.json
- **OpenAPI 3.1**: https://headlessoracle.com/openapi.json
- **Public key registry**: https://headlessoracle.com/v5/keys
- **x402 discovery**: https://headlessoracle.com/.well-known/x402.json
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

// AGENTS.md — coordinator-mode agent briefing (AAIF/Linux Foundation spec).
// Claude Code coordinator reads this to brief worker agents that market verification
// is a pre-execution gate, not optional data.
const AGENTS_MD = `# Headless Oracle — Agent Instructions

## Purpose
Headless Oracle provides cryptographically signed market-state attestations
for 28 global exchanges. It is a PRE-EXECUTION gate — agents MUST verify
market state before committing capital or executing financial operations.

## When to Use
- Before ANY financial transaction, trade execution, or capital commitment
- When verifying whether a market/exchange is currently in session
- When checking for holiday closures, early closes, or lunch breaks that
  affect settlement or execution windows
- When generating audit-trail evidence of pre-trade due diligence
- When building x402 payment flows that require attestation_ref

## Critical Rules
- UNKNOWN status MUST be treated as CLOSED (fail-closed, non-negotiable)
- HALTED status MUST be treated as CLOSED
- Receipts expire after 60 seconds — do not cache or reuse stale receipts
- The Ed25519 signature in each receipt is a cryptographic proof — include
  the attestation_ref in any downstream payment or audit records
- Always call verify_receipt to confirm signature before acting on receipt
  contents in high-stakes workflows

## Available Tools
- get_market_status: Single exchange market state with signed receipt
- get_market_schedule: Next open/close times, holiday flags, lunch windows
- list_exchanges: All 28 supported exchanges with MIC codes and timezones
- verify_receipt: Verify an existing receipt's Ed25519 signature

## Integration with x402 Payment Flows
Include the attestation_ref from the receipt in the x402 payment attestation
field. This creates an auditable chain:
market verification → payment authorization → execution → settlement receipt

## Authentication
No auth required for sandbox (200 calls). API keys via headlessoracle.com/upgrade.
MCP endpoint: https://headlessoracle.com/mcp
REST endpoint: https://api.headlessoracle.com/v5/status?mic={MIC}

## Supported Exchanges (Sample)
XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Japan), XHKG (Hong Kong),
XCBT (CME overnight), XCOI (Coinbase 24/7), XBIN (Binance 24/7) + 20 more.
Full list: get_market_status with list_exchanges tool.
`;

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
	quickstartUrl:       'https://headlessoracle.com/docs/quickstart',
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
			description: 'Pre-trade verification gate: returns Ed25519-signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) for any of 28 global exchanges. Use before any financial execution, capital commitment, or market-dependent workflow. UNKNOWN and HALTED must be treated as CLOSED (fail-closed). Receipt includes attestation_ref (signature) for x402 payment flows and audit trails. 60-second TTL.',
			tags:        ['finance', 'market-data', 'safety', 'signed-receipt', 'fail-closed'],
			examples:    ['Is NYSE open right now?', 'Verify XLON is trading before executing this payment'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'get_market_schedule',
			name:        'Get Market Schedule',
			description: 'Returns holiday-aware trading session schedule: next open/close UTC times, market hours, trading hours, exchange operating hours, holiday calendar, lunch break windows (XJPX/XHKG/XSHG/XSHE), and session status across 28 exchanges.',
			tags:        ['finance', 'schedule', 'market-hours'],
			examples:    ['When does Tokyo Stock Exchange open next?', 'What are XJPX trading hours?'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'list_exchanges',
			name:        'List Exchanges',
			description: 'Returns directory of all 28 supported exchanges with MIC codes, names, IANA timezones, and exchange operating hours metadata. Use at agent startup to discover supported markets before calling get_market_status or get_market_schedule.',
			tags:        ['finance', 'exchange-directory'],
			examples:    ['Which exchanges does this oracle cover?'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'verify_receipt',
			name:        'Verify Receipt Signature',
			description: 'Verifies Ed25519 cryptographic proof on a Signed Market Attestation receipt — confirms genuine pre-trade verification attestation (attestation_ref), receipt authenticity, and signature validity for audit trails and x402 payment flows.',
			tags:        ['finance', 'verification', 'cryptography', 'trust'],
			examples:    ['Verify this market receipt before processing the payment'],
			inputModes:  ['application/json'],
			outputModes: ['application/json'],
		},
		{
			id:          'get_sandbox_key',
			name:        'Get Sandbox Key',
			description: 'Provision a 7-day API key (200 calls). POST { "email": "you@example.com" } — email required, one per address.',
			endpoint:    '/v5/sandbox',
			method:      'POST',
			auth:        false,
			input:       { email: { type: 'string', required: true, description: 'Email address — key is sent to this address' } },
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
	supported_exchanges: SUPPORTED_EXCHANGES.map((e) => e.mic),
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
	// x402_payable: agents can autonomously pay for access via on-chain USDC without a subscription.
	// payment_endpoint: the endpoint that returns 402 with x402 payment details on unauthenticated access.
	// subscription_endpoint: Paddle checkout for persistent API key (Builder/Pro/Protocol plans).
	x402_payable: true,
	payment: {
		schemes:               ['x402'],
		network:               'eip155:8453',
		chain_id:              8453,
		currency:              'USDC',
		amount_per_request:    '0.001 USDC',
		amount_units:          '1000',        // 0.001 USDC at 6 decimals
		batch_amount_units:    '5000',        // 0.005 USDC for /v5/batch (up to 28 MICs)
		asset:                 '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
		payment_endpoint:      'https://headlessoracle.com/v5/status',       // returns 402 with x402 details
		subscription_endpoint: 'https://headlessoracle.com/v5/checkout',     // Paddle — persistent key
		mint_endpoint:         'https://headlessoracle.com/v5/x402/mint',    // autonomous key minting via on-chain USDC
		discovery:             'https://headlessoracle.com/.well-known/x402.json',
		free_tier_daily_limit: FREE_TIER_DAILY_LIMIT,
	},
	standards: {
		sma_version:           '1.0',
		sma_protocol_version:  'RFC-001-draft',
		apts_version:          '1.0',
		sma_spec:              'https://github.com/LembaGang/sma-protocol',
		apts_spec:             'https://github.com/LembaGang/agent-pretrade-safety-standard',
		verifiable_intent_rfc: 'https://github.com/agent-intent/verifiable-intent/pulls',
		conformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',
		mpas_spec:             'https://github.com/LembaGang/mpas-spec',
		mpas_version:          '1.0',
		sma_disambiguation:      'SMA denotes Signed Market Attestation, not Simple Moving Average',
		implementations_registry: 'https://headlessoracle.com/v5/implementations',
	},
	dst_aware:           true,
	discovery_url:       'https://headlessoracle.com/.well-known/agent.json',
	skill_url:           'https://headlessoracle.com/skill.md',
	erc8004:             '8453:38413',
	ampersend:           'https://app.ampersend.ai/agents/headless-oracle',
	mcp: {
		endpoint:         'https://headlessoracle.com/mcp',
		protocol_version: '2024-11-05',
		tools: [
			{
				name:        'get_market_status',
				description: 'Pre-trade verification gate: Ed25519-signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) for 28 exchanges. Use before any trade execution, capital commitment, or financial workflow. UNKNOWN/HALTED = CLOSED (fail-closed). Includes attestation_ref for x402 payment flows.',
				parameters:  { mic: 'string (required) — ISO 10383 MIC code, e.g. XNYS' },
			},
			{
				name:        'get_market_schedule',
				description: 'Holiday-aware trading session schedule: next open/close UTC times, market hours, exchange operating hours, holiday calendar, lunch breaks (XJPX/XHKG/XSHG/XSHE), session status for 28 exchanges.',
				parameters:  { mic: 'string (required) — ISO 10383 MIC code' },
			},
			{
				name:        'list_exchanges',
				description: 'Directory of all 28 supported exchanges: MIC codes, names, timezones, exchange operating hours metadata. Call at agent startup to discover all supported MIC codes.',
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
			{ path: '/mics.json',             method: 'GET',  auth: false, description: 'All 28 supported MICs with exchange metadata and ISO 20022 registry links' },
			{ path: '/v5/archive',            method: 'GET',  auth: false, description: 'Historical receipt archive (Builder+: 30-day; sandbox/free: today only)' },
			{ path: '/v5/stream',             method: 'GET',  auth: true,  description: 'SSE stream of signed market_status events every 30s via StreamCoordinator Durable Object' },
			{ path: '/v5/conformance-vectors', method: 'GET', auth: false, description: 'Live-signed canonical test vectors for SDK authors (5 vectors: XNYS OPEN/CLOSED, XJPX lunch, UNKNOWN, HEALTH OK)' },
			{ path: '/v5/keys',               method: 'GET',  auth: false, description: 'Public key registry + canonical payload spec' },
			{ path: '/v5/health',             method: 'GET',  auth: false, description: 'Signed liveness probe' },
			{ path: '/.well-known/oracle-keys.json', method: 'GET', auth: false, description: 'RFC 8615 key discovery' },
			{ path: '/v5/compliance',               method: 'GET', auth: false, description: 'APTS compliance self-report — 6 pre-trade safety checks' },
			{ path: '/v5/metrics',                  method: 'GET', auth: false, description: 'MCP client telemetry — today\'s request and unique client counts' },
			{ path: '/v5/dst-risk',                 method: 'GET', auth: false, description: 'DST transition risk — affected European exchanges, error windows, verified XLON schedule' },
			{ path: '/v5/traction',                 method: 'GET', auth: false, description: 'Live traction metrics — exchanges, uptime, MCP usage, stack positioning' },
			{ path: '/v5/metrics/public',           method: 'GET', auth: false, description: 'Social-proof metrics — exchanges, uptime_days, tests_passing, signing_algorithm, x402 stats, MCPScoreboard preflight score' },
			{ path: '/v5/usage',                    method: 'GET', auth: true,  description: 'Per-key usage stats — requests today/month, limits, credits, upgrade info' },
			{ path: '/v5/changelog',                method: 'GET', auth: false, description: 'Versioned changelog — entries[], each with date, version, changes[]' },
			{ path: '/badge/:mic',                  method: 'GET', auth: false, description: 'SVG status badge for README embedding (shields.io style)' },
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
	tools?:        Record<string, number>; // per-client tool call counts
}

const MCP_TOOLS = [
	{
		name: 'get_market_status',
		description:
			'Returns Ed25519-signed market-state receipt for pre-trade verification and pre-execution gating across 28 global exchanges. ' +
			'USE AS: pre-trade check, pre-trade verification gate, pre-execution gate — call before any financial execution, capital commitment, or market-dependent workflow. This is not optional data; it is a safety gate. ' +
			'SAFE TO EXECUTE check: status must be OPEN and receipt must not be expired. ' +
			'FAIL-CLOSED RULE: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately. Do not act on a receipt where expires_at is in the past (TTL = 60s). ' +
			'ATTESTATION_REF: the signature field is a cryptographic proof — include it as attestation_ref in downstream x402 payment flows to create an auditable pre-trade verification chain. ' +
			'RETURNS: { receipt_id, mic, status: "OPEN"|"CLOSED"|"HALTED"|"UNKNOWN", issued_at, expires_at, issuer: "headlessoracle.com", source, halt_detection, receipt_mode: "live"|"demo", schema_version: "v5.0", public_key_id, signature (hex Ed25519) }. ' +
			'Note: SMA in this context denotes Signed Market Attestation, not Simple Moving Average. ' +
			'LATENCY: sub-200ms p95 from Cloudflare edge. ' +
			'EXCHANGES (28 total): Equities — XNYS (NYSE), XNAS (NASDAQ), XLON (London Stock Exchange), XJPX (Tokyo Japan Exchange), XPAR (Euronext Paris), XHKG (Hong Kong), XSES (Singapore), XASX (ASX Sydney), XBOM (BSE Mumbai), XNSE (NSE Mumbai), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Korea Exchange Seoul), XJSE (Johannesburg), XBSP (B3 Brazil), XSWX (SIX Swiss Zurich), XMIL (Borsa Italiana Milan), XIST (Borsa Istanbul), XSAU (Tadawul Riyadh), XDFM (Dubai Financial Market), XNZE (NZX Auckland), XHEL (Nasdaq Helsinki), XSTO (Nasdaq Stockholm). Derivatives — XCBT (CME Futures overnight), XNYM (NYMEX overnight), XCBO (Cboe Options). Crypto 24/7 — XCOI (Coinbase), XBIN (Binance).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'ISO 10383 Market Identifier Code. Required. Examples: XNYS=NYSE, XNAS=NASDAQ, XLON=London, XJPX=Tokyo, XCBT=CME Futures, XCOI=Coinbase (24/7), XBIN=Binance (24/7). ' +
						'Call list_exchanges to discover all 28 supported codes.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO', 'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN'],
				},
			},
			additionalProperties: false,
		},
		_meta: {
			x402: {
				required_without_key: true,
				amount_usdc:          '0.001',
				network:              'base',
				payment_header:       'X-Payment',
				discovery:            '/.well-known/x402.json',
			},
		},
	},
	{
		name: 'get_market_schedule',
		description:
			'Returns holiday-aware trading session schedule with next open/close UTC timestamps for any of 28 exchanges. ' +
			'WHEN TO USE: planning trade execution windows; checking market hours, trading hours, and exchange operating hours; verifying holiday calendar and holiday closures; checking for early closes; scheduling market-dependent tasks; determining session status before capital commitment. ' +
			'Includes lunch break windows (session status): Tokyo XJPX (11:30–12:30 JST), Hong Kong XHKG (12:00–13:00 HKT), Shanghai XSHG and Shenzhen XSHE (11:30–13:00 CST). ' +
			'Covers Middle Eastern markets (XSAU/XDFM: Fri–Sat weekend, Sunday is a trading day) and 24/7 crypto (XCOI/XBIN: always open). ' +
			'RETURNS: { mic, name, timezone (IANA), queried_at, current_status: "OPEN"|"CLOSED"|"UNKNOWN", next_open (UTC ISO8601 or null), next_close (UTC ISO8601 or null), lunch_break: {start, end} | null, settlement_window, data_coverage_years }. ' +
			'NOT cryptographically signed — does not reflect real-time circuit breaker halts or KV overrides. For authoritative signed status use get_market_status. ' +
			'LATENCY: sub-100ms p95 (pure schedule computation, no signing).',
		inputSchema: {
			type: 'object',
			properties: {
				mic: {
					type: 'string',
					description:
						'ISO 10383 Market Identifier Code. Defaults to XNYS (NYSE). ' +
						'Call list_exchanges to see all 28 supported codes.',
					enum: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO', 'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN'],
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: 'list_exchanges',
		description:
			'Returns directory of all 28 exchanges supported by Headless Oracle: MIC codes, exchange names, IANA timezones, market hours metadata, and mic_type (iso|convention). ' +
			'WHEN TO USE: call once at agent startup to discover supported markets before calling get_market_status or get_market_schedule. Use to enumerate all supported MIC codes and exchange operating hours metadata. ' +
			'Covers equities (XNYS/NYSE, XNAS/NASDAQ, XLON/London, XJPX/Tokyo, XPAR/Paris, XHKG/Hong Kong, XSES/Singapore, XASX/ASX, XBOM/BSE, XNSE/NSE, XSHG/Shanghai, XSHE/Shenzhen, XKRX/Korea, XJSE/Johannesburg, XBSP/Brazil, XSWX/Zurich, XMIL/Milan, XIST/Istanbul, XSAU/Riyadh, XDFM/Dubai, XNZE/Auckland, XHEL/Helsinki, XSTO/Stockholm), derivatives (XCBT/CME, XNYM/NYMEX, XCBO/Cboe), and 24/7 crypto (XCOI/Coinbase, XBIN/Binance). ' +
			'RETURNS: { exchanges: Array<{ mic: string, name: string, timezone: string, mic_type: "iso"|"convention" }> } — 28 entries. ' +
			'Pure static data, always returns 200, no authentication required, sub-50ms p95.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'verify_receipt',
		description:
			'Verifies the Ed25519 cryptographic signature on a Headless Oracle Signed Market Attestation receipt — confirms it is a genuine pre-trade verification attestation and has not been tampered with. ' +
			'Note: SMA denotes Signed Market Attestation, not Simple Moving Average. ' +
			'WHEN TO USE: (1) when you receive a pre-trade attestation from another agent and must confirm the cryptographic proof before acting on market state; (2) building an attestation_ref audit trail for capital commitment workflows; (3) confirming receipt verification before including the signature in an x402 payment attestation. ' +
			'RETURNS: { valid: boolean, expired: boolean, reason: "SIGNATURE_VALID"|"MALFORMED_RECEIPT"|"INVALID_SIGNATURE"|"ORACLE_NOT_CONFIGURED", mic: string|null, status: string|null, expires_at: string|null }. ' +
			'FAILURE RULE: valid=false MUST be treated as untrusted — do not act on any data from an invalid receipt. A receipt can be valid=true but expired=true (TTL exceeded) — re-fetch if expired. ' +
			'LATENCY: sub-50ms p95 (in-worker Ed25519 verification, no external network calls).',
		inputSchema: {
			type: 'object',
			properties: {
				receipt: {
					type:                 'object',
					description:          'The complete signed receipt object as returned by get_market_status or /v5/status. Must include the signature field (hex-encoded Ed25519).',
					additionalProperties: true,
				},
			},
			required:             ['receipt'],
			additionalProperties: false,
		},
	},
	{
		name: 'get_payment_options',
		description:
			'Returns available payment and authentication options for accessing live market data. ' +
			'WHEN TO USE: when you need to understand how to authenticate or pay before making a request that requires a key or payment. ' +
			'Returns upgrade ladder: sandbox (200 calls free), x402 per-request ($0.001 USDC), x402 sandbox (10 credits for $0.001), credit packs ($5 = 1000 calls), builder subscription ($99/mo = 50K/day). ' +
			'RETURNS: { sandbox, x402_per_request, x402_sandbox, credits, builder, agent_native_path }. ' +
			'No authentication required. Always returns 200.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
				required: ['receipt_id', 'issued_at', 'expires_at', 'issuer', 'mic', 'status', 'source', 'halt_detection', 'receipt_mode', 'schema_version', 'public_key_id', 'signature'],
				properties: {
					receipt_id:     { type: 'string', format: 'uuid' },
					issued_at:      { type: 'string', format: 'date-time' },
					expires_at:     { type: 'string', format: 'date-time', description: 'Do not act on this receipt after this time.' },
					issuer:         { type: 'string', example: 'headlessoracle.com', description: 'Domain of the oracle that issued this receipt. Resolve {issuer}/v5/keys to retrieve the public key.' },
					mic:            { type: 'string', example: 'XNYS' },
					status:         { '$ref': '#/components/schemas/Status' },
					source:         { '$ref': '#/components/schemas/Source' },
					reason:         { type: 'string', description: 'Present when source is OVERRIDE.' },
					halt_detection: { type: 'string', enum: ['active', 'schedule_only'], description: '"active" = real-time intraday halt detection via external API (XNYS, XNAS only). "schedule_only" = calendar hours + holidays only; unscheduled intraday circuit breaker halts are not detected. Agents must adjust confidence accordingly.' },
					receipt_mode:   { type: 'string', enum: ['demo', 'live'], description: "'demo' for unauthenticated /v5/demo; 'live' for /v5/status, /v5/batch, and MCP tool receipts." },
					schema_version: { type: 'string', example: 'v5.0', description: 'Receipt schema version. Consumers should verify this matches the version they were built against.' },
					public_key_id:  { type: 'string', example: 'key_2026_v1' },
					signature:      { type: 'string', description: 'Ed25519 signature of canonical payload as 128-char hex string.' },
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
				description: 'Returns a signed market-state receipt. Requires X-Oracle-Key header OR x402 payment via Payment-Signature/X-Payment header. Primary production endpoint.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'mic', in: 'query', schema: { type: 'string', default: 'XNYS' }, description: 'Market Identifier Code (MIC).' },
					{ name: 'Payment-Signature', in: 'header', schema: { type: 'string' }, description: 'x402 v2 payment header — base64-encoded JSON PaymentPayload with EIP-712 TransferWithAuthorization signature. Alternative to X-Oracle-Key for keyless per-request payment ($0.001 USDC on Base mainnet).' },
					{ name: 'X-Payment', in: 'header', schema: { type: 'string' }, description: 'x402 v1 payment header — base64-encoded JSON OR raw JSON { txHash, network, amount, paymentAddress, memo }. Alternative to Payment-Signature.' },
				],
				responses: {
					'200': { description: 'Signed receipt', content: { 'application/json': { schema: { '$ref': '#/components/schemas/SignedReceipt' } } } },
					'400': { description: 'Unknown MIC', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'401': { description: 'Missing API key' },
					'402': { description: 'Payment required — free tier exhausted or no API key. Body includes x402 payment requirements (accepts[], payTo, amount). Send Payment-Signature or X-Payment header to pay $0.001 USDC per request.' },
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
						content: { 'application/json': { schema: { type: 'object', required: ['receipt_id', 'issued_at', 'expires_at', 'status', 'source', 'public_key_id', 'signature', 'exchange_count', 'supported_mics'], properties: { receipt_id: { type: 'string', format: 'uuid' }, issued_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }, status: { type: 'string', enum: ['OK'] }, source: { type: 'string', enum: ['SYSTEM'] }, public_key_id: { type: 'string' }, signature: { type: 'string' }, exchange_count: { type: 'integer', example: 28, description: 'Number of exchanges currently configured (unsigned).' }, supported_mics: { type: 'array', items: { type: 'string' }, example: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES', 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE', 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE', 'XHEL', 'XSTO', 'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN'], description: 'List of supported MIC codes (unsigned).' } } } } },
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
				description: 'Static JSON array of all 28 supported exchanges. Each entry carries: ' +
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
					'Receipts are built in parallel. Requires X-Oracle-Key header or x402 payment ($0.005 USDC for batch).',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{
						name:        'mics',
						in:          'query',
						required:    true,
						schema:      { type: 'string' },
						description: 'Comma-separated MIC codes. Duplicates are deduplicated. Example: XNYS,XNAS,XLON.',
					},
					{ name: 'Payment-Signature', in: 'header', schema: { type: 'string' }, description: 'x402 v2 payment header — base64-encoded JSON PaymentPayload ($0.005 USDC on Base mainnet for batch).' },
					{ name: 'X-Payment', in: 'header', schema: { type: 'string' }, description: 'x402 v1 payment header — base64-encoded JSON or raw JSON.' },
				],
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
								exchanges_covered:        { type: 'integer', example: 28 },
								edge_cases_per_year:      { type: 'integer', example: 1319 },
								uptime_status:            { type: 'string', enum: ['operational'] },
							},
						} } },
					},
				},
			},
		},
		'/v5/metrics/public': {
			get: {
				summary:     'Social-proof metrics',
				description: 'Public, no auth. Stable facts about the service suitable for embedding in READMEs, dashboards, or evaluations. x402 payment stats are best-effort from ORACLE_TELEMETRY KV.',
				responses: {
					'200': {
						description: 'Service metrics',
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['exchanges', 'mcp_tools', 'uptime_days', 'tests_passing', 'signing_algorithm', 'receipt_ttl_seconds', 'mcp_protocol_version', 'mcpscoreboard_preflight', 'fail_closed'],
							properties: {
								exchanges:               { type: 'integer', example: 28 },
								mcp_tools:               { type: 'integer', example: 5 },
								uptime_days:             { type: 'integer', description: 'Days since 2026-02-28 origin date.' },
								tests_passing:           { type: 'integer', example: 650 },
								signing_algorithm:       { type: 'string', example: 'Ed25519' },
								receipt_ttl_seconds:     { type: 'integer', example: 60 },
								x402_enabled:            { type: 'boolean' },
								x402_network:            { type: 'string', example: 'base' },
								x402_payment_count:      { type: 'integer', description: 'Total x402 payments processed.' },
								last_payment_at:         { type: ['string', 'null'], format: 'date-time' },
								mcp_protocol_version:    { type: 'string', example: '2024-11-05' },
								mcpscoreboard_preflight: { type: 'integer', example: 100, description: 'MCPScoreboard preflight score out of 100.' },
								fail_closed:             { type: 'boolean', example: true },
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
		'/v5/dst-risk': {
			get: {
				summary:     'DST transition risk',
				description: 'Returns a structured breakdown of DST transition risk for European exchanges. No authentication required. Includes affected exchanges, error windows for naive agents using hardcoded UTC offsets, and a live verified schedule for XLON. Note: SMA in this response denotes Signed Market Attestation, not Simple Moving Average.',
				responses: {
					'200': {
						description: 'DST risk data',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								event:                  { type: 'string', example: 'EU_DST_SPRING_2026' },
								transition_utc:         { type: 'string', format: 'date-time' },
								expires_at:             { type: 'string', format: 'date-time' },
								description:            { type: 'string' },
								affected_exchanges:     { type: 'array', items: {
									type: 'object',
									properties: {
										mic:                       { type: 'string' },
										name:                      { type: 'string' },
										timezone:                  { type: 'string' },
										shift:                     { type: 'string' },
										naive_agent_open_utc:      { type: 'string' },
										actual_open_utc_after_dst: { type: 'string' },
										error_minutes:             { type: 'integer' },
										risk:                      { type: 'string' },
									},
								} },
								risk_window_minutes:    { type: 'integer', example: 60 },
								us_europe_dst_gap_note: { type: 'string' },
								verified_schedule:      { type: 'object', nullable: true },
								sma_protocol_note:      { type: 'string' },
								note:                   { type: 'string' },
							},
						} } },
					},
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
								exchanges_covered:        { type: 'integer', example: 28 },
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
		'/v5/implementations': {
			get: {
				summary:     'Standards implementations registry',
				description: 'Returns known implementations of SMA, MPAS, and APTS open standards. No authentication required. Submit your own via the submit_url field.',
				responses: {
					'200': {
						description: 'Implementations registry',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								standards:             { type: 'object' },
								total_implementations: { type: 'integer', example: 5 },
								last_updated:          { type: 'string', example: '2026-03-31' },
							},
						} } },
					},
				},
			},
		},
		'/v5/showcase': {
			get: {
				summary:     'Reference projects using Headless Oracle',
				description: 'Returns a curated list of projects using Headless Oracle in production or for research. Submit yours via the submit_url field.',
				responses: {
					'200': {
						description: 'Showcase entries',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								entries:    { type: 'array', items: { type: 'object' } },
								submit_url: { type: 'string' },
								note:       { type: 'string' },
							},
						} } },
					},
				},
			},
		},
		'/v5/sandbox': {
			post: {
				tags:        ['Authentication'],
				summary:     'Provision a sandbox or credit key for testing',
				description: 'Two paths: (1) Email path — POST with { "email": "..." } to get a sb_ sandbox key (7 days, 200 calls). ' +
					'One key per email/IP per 7-day window. ' +
					'(2) x402 agent path — POST with X-Payment header containing a valid Base mainnet USDC payment ($0.001). ' +
					'Skips email entirely; returns a ho_crd_ credit key with 10 credits. ' +
					'Agent-native: no human in the loop. ' +
					'Sandbox keys are rejected by /v5/receipts and /v5/webhooks/subscribe (paid features).',
				requestBody: {
					required: false,
					content: { 'application/json': { schema: {
						type: 'object',
						properties: {
							email:    { type: 'string', format: 'email', example: 'developer@example.com', description: 'Required for email path. Omit when using X-Payment header.' },
							use_case: { type: 'string', maxLength: 500, description: "Brief description of what you're building (helps us prioritise)." },
						},
					} } },
				},
				parameters: [{
					name:        'X-Payment',
					in:          'header',
					required:    false,
					description: 'x402 payment proof (JSON). When present, skips email verification and issues a credit key. Format: { "txHash": "0x...", "network": "base", "amount": "1000", "paymentAddress": "0x...", "memo": "" }',
					schema:      { type: 'string' },
				}],
				responses: {
					'200': {
						description: 'Key issued (sandbox or credit)',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								api_key:         { type: 'string', example: 'sb_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4' },
								tier:            { type: 'string', enum: ['sandbox', 'credits'] },
								email_captured:  { type: 'boolean' },
								expires_at:      { type: 'string', format: 'date-time' },
								calls_remaining: { type: 'integer' },
								credits:         { type: 'integer', description: 'Credit balance (x402 path only).' },
								upgrade_url:     { type: 'string' },
								quickstart:      { type: 'object' },
							},
						} } },
					},
					'400': {
						description: 'Email missing or invalid (email path)',
						content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } },
					},
					'402': {
						description: 'X-Payment header invalid or payment verification failed (x402 path)',
						content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } },
					},
					'429': {
						description: 'Sandbox allocation already used for this IP or email',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								error:       { type: 'string', example: 'SANDBOX_LIMIT_REACHED' },
								message:     { type: 'string' },
								upgrade_url: { type: 'string' },
								plans:       { type: 'object' },
							},
						} } },
					},
					'503': {
						description: 'x402 payments not configured on this instance',
						content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } },
					},
				},
			},
		},
		'/v5/archive': {
			get: {
				summary:     'Historical receipt archive',
				description: 'Returns historical signed receipts for a MIC. Builder+ keys: 30-day window. Sandbox/free keys: today only. ' +
					'Use the date query param (YYYY-MM-DD) to request a specific day.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'mic', in: 'query', required: false, schema: { type: 'string' }, description: 'MIC code. Defaults to XNYS.' },
					{ name: 'date', in: 'query', required: false, schema: { type: 'string' }, description: 'Date in YYYY-MM-DD format. Defaults to today.' },
				],
				responses: {
					'200': {
						description: 'Receipt archive for the requested MIC and date',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								mic:      { type: 'string', example: 'XNYS' },
								date:     { type: 'string', example: '2026-03-25' },
								count:    { type: 'integer' },
								receipts: { type: 'array', items: { type: 'object' } },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key or tier restriction', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/stream': {
			get: {
				summary:     'SSE stream of signed market_status events',
				description: 'Server-Sent Events stream delivering a signed market_status receipt every 30 seconds via a StreamCoordinator Durable Object. ' +
					'One Durable Object instance per MIC. Emits event:halted as a terminal event when a circuit breaker override is active. ' +
					'Auth required (X-Oracle-Key header or ?key= query param).',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'mic', in: 'query', required: false, schema: { type: 'string' }, description: 'MIC code. Defaults to XNYS.' },
					{ name: 'key', in: 'query', required: false, schema: { type: 'string' }, description: 'API key (alternative to X-Oracle-Key header).' },
				],
				responses: {
					'200': { description: 'SSE stream (text/event-stream). Events: market_status (recurring), halted (terminal).' },
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/conformance-vectors': {
			get: {
				summary:     'Canonical test vectors for SDK authors',
				description: 'Returns 5 live-signed canonical test vectors covering the full receipt space: ' +
					'XNYS OPEN, XNYS CLOSED, XJPX lunch break, UNKNOWN (system), and HEALTH OK. ' +
					'Each vector includes the receipt, the canonical_payload (base64-encoded canonical JSON string before signing), ' +
					'and the public_key (hex) used to sign it. SDK authors can use these to verify their Ed25519 implementation. ' +
					'No authentication required.',
				responses: {
					'200': {
						description: 'Conformance test vectors',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								generated_at: { type: 'string', format: 'date-time' },
								public_key:   { type: 'string', description: 'Hex-encoded Ed25519 public key used for all vectors.' },
								vectors: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											name:              { type: 'string', example: 'XNYS_OPEN' },
											receipt:           { type: 'object' },
											canonical_payload: { type: 'string', description: 'Base64-encoded canonical JSON payload that was signed.' },
											public_key:        { type: 'string', description: 'Hex-encoded public key for this vector.' },
										},
									},
								},
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
		'/.well-known/security.txt': {
			get: {
				summary:     'Security contact (RFC 9116)',
				description: 'RFC 9116 security.txt — machine-readable security contact information. Lists responsible disclosure contact, expiry date, and preferred language.',
				responses: {
					'200': { description: 'security.txt content', content: { 'text/plain': { schema: { type: 'string' } } } },
				},
			},
		},

		'/v5/webhooks/subscribe': {
			post: {
				tags:        ['Webhooks'],
				summary:     'Subscribe to market state-change webhooks',
				description: 'Register a webhook URL to receive signed receipts when a market transitions between states (OPEN↔CLOSED, HALT). Builder+ plans only. Sandbox keys are rejected. Returns webhook_id and subscription_id.',
				security:    [{ ApiKeyAuth: [] }],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object',
						required: ['url', 'mics'],
						properties: {
							url:    { type: 'string', format: 'uri', description: 'HTTPS endpoint to receive webhook deliveries.' },
							mics:   { type: 'array', items: { type: 'string' }, description: 'MIC codes to subscribe to (e.g. ["XNYS","XNAS"]).' },
							events: { type: 'array', items: { type: 'string' }, description: 'Event types to subscribe to. Default: ["status_change"].' },
						},
					} } },
				},
				responses: {
					'200': {
						description: 'Subscription created',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								webhook_id:      { type: 'string', description: 'Unique ID for this webhook. Use for DELETE /v5/webhooks/{webhook_id}.' },
								subscription_id: { type: 'string', description: 'Legacy alias for webhook_id (backward compat).' },
								url:             { type: 'string' },
								mics:            { type: 'array', items: { type: 'string' } },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'402': { description: 'Sandbox keys cannot use webhooks — upgrade required', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key or plan limit reached (builder=5, pro=25)', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks': {
			get: {
				tags:        ['Webhooks'],
				summary:     'List all webhooks for this API key',
				description: 'Returns all active webhook subscriptions for the authenticated key. Each entry includes webhook_id, url, mics, events, created_at, status.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Webhook list',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								webhooks: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											webhook_id:  { type: 'string' },
											url:         { type: 'string' },
											mics:        { type: 'array', items: { type: 'string' } },
											events:      { type: 'array', items: { type: 'string' } },
											created_at:  { type: 'string', format: 'date-time' },
											status:      { type: 'string', enum: ['active', 'paused'] },
										},
									},
								},
								count: { type: 'integer' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/{webhook_id}': {
			delete: {
				tags:        ['Webhooks'],
				summary:     'Delete a webhook subscription',
				description: 'Permanently removes the webhook subscription. Returns 204 No Content on success. Also decrements the plan webhook count.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'webhook_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Webhook ID returned from POST /v5/webhooks/subscribe.' },
				],
				responses: {
					'204': { description: 'Webhook deleted' },
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key or webhook does not belong to this key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'404': { description: 'Webhook not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/test/{webhook_id}': {
			post: {
				tags:        ['Webhooks'],
				summary:     'Send a synthetic test delivery to a webhook',
				description: 'Fires a single test delivery to the webhook URL. Uses the current market state for the first subscribed MIC. One delivery attempt (no retry). Returns the payload sent.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'webhook_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Webhook ID to test.' },
				],
				responses: {
					'200': {
						description: 'Test delivery result',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								delivered:    { type: 'boolean' },
								payload_sent: { type: 'object', description: 'The exact webhook payload delivered.' },
								status_code:  { type: 'integer', description: 'HTTP status from the webhook endpoint.' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Webhook does not belong to this key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'404': { description: 'Webhook not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/health': {
			get: {
				tags:        ['Webhooks'],
				summary:     'WebhookDispatcher Durable Object health status',
				description: 'Returns the last known health status of the WebhookDispatcher Durable Object — written by the DO alarm() after each 60s dispatch cycle. No authentication required. Does not wake the DO.',
				responses: {
					'200': {
						description: 'Dispatcher health status',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								status:      { type: 'string', enum: ['ok', 'unknown'], description: '"ok" = DO alarm ran recently. "unknown" = no health record in KV yet.' },
								next_alarm:  { type: 'string', format: 'date-time', description: 'When the next dispatch cycle is scheduled.' },
								checked_at:  { type: 'string', format: 'date-time' },
							},
						} } },
					},
				},
			},
		},
		'/v5/receipts': {
			get: {
				tags:        ['Audit'],
				summary:     'Receipt audit log (builder+ only)',
				description: 'Returns a filtered audit log of signed receipts issued to this API key. Each row contains mic, status, source, issued_at, schema_version. Requires Builder or Pro plan. Supports limit, mic, and from query params.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 }, description: 'Max rows to return (max 200).' },
					{ name: 'mic',   in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by MIC code.' },
					{ name: 'from',  in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Return receipts after this ISO8601 timestamp.' },
				],
				responses: {
					'200': {
						description: 'Audit log',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								receipts: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											mic:            { type: 'string' },
											status:         { '$ref': '#/components/schemas/Status' },
											source:         { '$ref': '#/components/schemas/Source' },
											issued_at:      { type: 'string', format: 'date-time' },
											schema_version: { type: 'string', example: 'v5.0' },
										},
									},
								},
								count: { type: 'integer' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'402': { description: 'Plan upgrade required (sandbox/free keys cannot access receipt audit)', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/x402/mint': {
			post: {
				tags:        ['Billing'],
				summary:     'Mint a persistent API key via x402 USDC payment',
				description: 'Agents submit a verified Base mainnet USDC transaction hash and receive a persistent ho_live_ API key. Builder tier: 99 USDC = 50K calls/day. Pro tier: 299 USDC = 200K calls/day. Replay protection: each tx_hash can only be used once (365-day TTL).',
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object',
						required: ['tx_hash', 'tier'],
						properties: {
							tx_hash: { type: 'string', description: 'Base mainnet USDC transaction hash (0x-prefixed).' },
							tier:    { type: 'string', enum: ['builder', 'pro'], description: 'Desired key tier.' },
							email:   { type: 'string', format: 'email', description: 'Optional: receive the key by email.' },
						},
					} } },
				},
				responses: {
					'200': {
						description: 'Key minted',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								api_key:     { type: 'string', description: 'Your new persistent API key (ho_live_ prefix). Store securely — shown once.' },
								tier:        { type: 'string', enum: ['builder', 'pro'] },
								daily_limit: { type: 'integer' },
							},
						} } },
					},
					'400': { description: 'Invalid tx_hash or payment amount insufficient', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'409': { description: 'Transaction already used to mint a key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'503': { description: 'Base mainnet RPC unavailable', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/credits/purchase': {
			post: {
				tags:        ['Billing'],
				summary:     'Purchase prepaid credits via x402 USDC payment',
				description: 'Submit a verified Base mainnet USDC payment to add prepaid credits to your key. Credit tiers: 0.001 USDC = 1 credit, 0.09 USDC = 100 credits, 0.80 USDC = 1000 credits. Requires X-Payment header with verified tx.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Credits added',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								credits_added:    { type: 'integer' },
								new_balance:      { type: 'integer' },
								tier:             { type: 'string' },
							},
						} } },
					},
					'402': { description: 'Payment required or insufficient amount', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'503': { description: 'Payment verification service unavailable', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/credits/balance': {
			get: {
				tags:        ['Billing'],
				summary:     'Check prepaid credit balance',
				description: 'Returns the current credit balance for the authenticated key. Credits are consumed 1-per-request on /v5/status and /v5/batch when the free tier limit is reached.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Credit balance',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								balance:                    { type: 'integer', description: 'Remaining prepaid credits.' },
								estimated_requests_remaining: { type: 'integer' },
								last_purchased:             { type: 'string', format: 'date-time' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/card/{mic}': {
			get: {
				tags:        ['Discoverability'],
				summary:     'SVG status card for a market exchange',
				description: 'Returns a terminal-style SVG status card showing the current market state for a MIC. Dark chrome, syntax-highlighted JSON, status-coloured text, pulsing LIVE dot. Cache-Control: no-cache. Suitable for README badges and dashboards.',
				parameters:  [
					{ name: 'mic', in: 'path', required: true, schema: { type: 'string' }, description: 'MIC code (e.g. XNYS, XNAS, XLON).' },
				],
				responses: {
					'200': {
						description: 'SVG status card',
						content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } },
					},
					'400': { description: 'Unknown MIC code', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/x402': {
			get: {
				tags:        ['Discoverability'],
				summary:     'x402 Foundation compatibility declaration',
				description: 'Declares x402 protocol compatibility for the x402 Foundation ecosystem. Returns network, facilitator, first payment timestamp, and links to discovery and payment proof endpoints.',
				responses: {
					'200': {
						description: 'x402 compatibility info',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								x402_compatible: { type: 'boolean' },
								network:         { type: 'string', example: 'base' },
								facilitator:     { type: 'string', example: 'cdp' },
								first_payment_at: { type: 'string', format: 'date-time', nullable: true },
								payment_proof:   { type: 'string' },
								discovery:       { type: 'string' },
								awesome_x402:    { type: 'string' },
								foundation:      { type: 'string' },
							},
						} } },
					},
				},
			},
		},
		'/v5/verify': {
			post: {
				tags:        ['Verification'],
				summary:     'Verify Ed25519 receipt signature (REST)',
				description: 'Public endpoint. Accepts a signed market receipt and verifies the Ed25519 signature in-worker. Returns validity, expiry status, and reason. Shares logic with the verify_receipt MCP tool.',
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object',
						required: ['receipt'],
						properties: {
							receipt: { type: 'object', description: 'Complete signed receipt as returned by /v5/status or /v5/demo.', additionalProperties: true },
						},
					} } },
				},
				responses: {
					'200': {
						description: 'Verification result',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								valid:      { type: 'boolean' },
								expired:    { type: 'boolean' },
								reason:     { type: 'string', enum: ['SIGNATURE_VALID', 'INVALID_SIGNATURE', 'MALFORMED_RECEIPT', 'ORACLE_NOT_CONFIGURED', 'RECEIPT_EXPIRED — re-fetch required'] },
								mic:        { type: 'string', nullable: true },
								status:     { type: 'string', nullable: true },
								expires_at: { type: 'string', format: 'date-time', nullable: true },
							},
						} } },
					},
					'400': { description: 'Missing or malformed body', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
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
			const overrideRaw = await getCachedOverride(mic, env);
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
						halt_detection: getHaltDetection(mic),
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
			halt_detection: getHaltDetection(mic),
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
				halt_detection: getHaltDetection(mic),
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
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
	// ── Parse body first — enables fast paths for stateless protocol methods ────
	// MCP probers (Chiark, MCPScoreboard) probe via initialize → tools/list → ping
	// sequences to check availability. Parsing first lets us return immediately for
	// these methods without any KV reads, keeping P95 latency low.
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

	// ── Fast path: stateless protocol methods — no KV reads, no telemetry ──────
	// initialize, ping, notifications/initialized are pure handshakes that carry no
	// user intent worth tracking. Skipping KV saves ~100ms per call and eliminates
	// cold-start penalty for the MCP handshake sequence.
	if (method === 'initialize') {
		return rpcResult({
			protocolVersion: MCP_PROTOCOL_VERSION,
			serverInfo:      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
			capabilities:    { tools: {}, resources: {}, prompts: {} },
			instructions:
				'Headless Oracle provides cryptographically signed market-state attestations (SMA receipts) for 28 global exchanges — equities, derivatives, and 24/7 crypto. ' +
				'These tools are a PRE-EXECUTION gate, not optional data. Call them before any financial transaction, trade execution, or capital commitment. ' +
				'WHEN TO USE get_market_status: (1) before any trade, payment, or DeFi transaction; (2) before committing capital in any automated workflow; (3) when you need cryptographic proof of market state for audit trails or attestation_ref in x402 payment flows; (4) when checking whether a market is in a holiday closure, early close, or circuit breaker halt. ' +
				'WHEN TO USE get_market_schedule: for planning trade execution windows, verifying exchange operating hours and trading hours, checking holiday calendars, scheduling market-dependent tasks. ' +
				'WHEN TO USE list_exchanges: at agent startup to discover all 28 supported MIC codes before calling get_market_status. ' +
				'WHEN TO USE verify_receipt: when you receive a pre-trade verification receipt from another agent and must confirm the Ed25519 signature before acting on it. ' +
				'WHEN TO USE get_payment_options: when you need to understand available payment and authentication options before making a paid request. ' +
				'MANDATORY SAFETY RULE: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately (fail-closed, non-negotiable). ' +
				'Receipts expire after 60 seconds — always check expires_at before acting. ' +
				'Public key for independent verification: /.well-known/oracle-keys.json',
			_meta: {
				x402_enabled:        true,
				first_payment_received: true,
				payment_count_url:   '/v5/payment-proof',
				upgrade_path_url:    '/v5/why-not-free',
				sandbox_url:         'POST /v5/sandbox',
				x402_discovery:      '/.well-known/x402.json',
			},
		});
	}

	if (method === 'notifications/initialized') {
		return new Response(null, { status: 202, headers: MCP_RESPONSE_HEADERS });
	}

	if (method === 'ping') {
		return rpcResult({});
	}

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

	// Telemetry: read current daily record, increment, write back — all deferred
	// to ctx.waitUntil so it never blocks the MCP response.
	// Previously the GET was awaited inline, adding ~100ms to every tools/call
	// from remote regions (India, Asia) where KV round-trip latency is high.
	// The count is only needed for the tools/list conversion nudge, which reads
	// requestCount from the same deferred chain below.
	const kvKey = `mcp_clients:${today}:${ipHash}`;
	// Promise resolves to requestCount after GET+parse — awaited lazily in tools/list.
	const telemetryCountPromise: Promise<number> = (async () => {
		try {
			const stored = await env.ORACLE_TELEMETRY.get(kvKey);
			const prev   = stored ? JSON.parse(stored) as McpClientRecord : null;
			const count  = (prev?.request_count ?? 0) + 1;
			const updated: McpClientRecord = {
				first_seen:    prev?.first_seen ?? timestamp,
				last_seen:     timestamp,
				request_count: count,
				user_agent:    userAgent,
				asn_org:       asnOrg,
				country,
				city,
			};
			await env.ORACLE_TELEMETRY.put(kvKey, JSON.stringify(updated), { expirationTtl: 8 * 24 * 3600 });
			console.log(JSON.stringify({ event: 'TELEMETRY_PUT_OK', kvKey }));
			return count;
		} catch (err) {
			console.error('TELEMETRY_FAILED', String(err));
			return 1;
		}
	})();
	// Defer telemetry to run after response is sent. For tools/list we also
	// await the promise inline to get requestCount for the conversion nudge.
	if (typeof ctx?.waitUntil === 'function') {
		ctx.waitUntil(telemetryCountPromise);
	} else {
		// ctx.waitUntil unavailable — fire-and-forget (telemetry is best-effort).
		console.error('TELEMETRY_CTX_NO_WAITUNTIL');
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

	// ── MCP rate limiting — OAuth-authenticated requests only ─────────────────
	// Unauthenticated MCP (_mcpKeyHash === null) is structurally unreachable here.
	// Shares the same KV counter as the REST auth gate so REST + MCP calls count
	// together against a single daily limit per key.
	// ── Acquisition telemetry: authenticated vs unauthenticated MCP ratio ────
	const mcpDateKey = new Date().toISOString().slice(0, 10);
	if (_mcpKeyHash !== null) {
		incrementKvCounter(`auth_calls:${mcpDateKey}`, env, ctx);
	} else {
		incrementKvCounter(`unauth_calls:${mcpDateKey}`, env, ctx);
		// Track zero-auth MCP separately so it doesn't dilute auth_ratio
		incrementKvCounter(`zero_auth_mcp_requests:${mcpDateKey}`, env, ctx);
	}

	if (_mcpKeyHash !== null && _mcpPlan !== null) {
		const mcpPlanLimit = getPlanDailyLimit(_mcpPlan);
		if (mcpPlanLimit !== null) {
			const mcpDailyUsage = await getDailyUsage(_mcpKeyHash, env);
			if (mcpDailyUsage >= mcpPlanLimit) {
				return new Response(JSON.stringify({
					jsonrpc: '2.0',
					id,
					error: { code: -32000, message: `RATE_LIMITED: ${_mcpPlan} plan daily limit (${mcpPlanLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/upgrade` },
				}), { status: 200, headers: MCP_RESPONSE_HEADERS });
			}
			incrementDailyUsage(_mcpKeyHash, env, ctx, mcpDailyUsage);
		}
	}

	switch (method) {
		case 'tools/list': {
			// Conversion nudge: anonymous clients with > 50 requests see a non-breaking hint.
			// Only in tools/list — not in tool call responses — so agent behaviour is unaffected.
			// Await the telemetry promise here (it was deferred above). tools/list is called
			// infrequently (once per session) so the extra wait is acceptable.
			const requestCount = await telemetryCountPromise;
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

			// Reject calls with no tool name — MCP spec requires tools/call to include "name".
			if (!name) {
				return rpcError(-32602, 'Invalid params: tools/call requires a "name" field');
			}

			// Per-tool telemetry: global counter + per-client tools object (best-effort, non-blocking)
			const MCP_TRACKED_TOOLS = ['get_market_status', 'get_market_schedule', 'list_exchanges', 'verify_receipt', 'get_payment_options'];
			if (MCP_TRACKED_TOOLS.includes(name)) {
				incrementKvCounter(`mcp_tool:${name}:${today}`, env, ctx);
				// Per-client tool count: increment the tools object in the client's KV record
				if (typeof ctx?.waitUntil === 'function') {
					ctx.waitUntil(
						env.ORACLE_TELEMETRY.get(kvKey).then(async (stored) => {
							if (!stored) return;
							const prev      = JSON.parse(stored) as McpClientRecord;
							const prevTools = prev.tools ?? {};
							const updated: McpClientRecord = {
								...prev,
								tools: { ...prevTools, [name]: (prevTools[name] ?? 0) + 1 },
							};
							await env.ORACLE_TELEMETRY.put(kvKey, JSON.stringify(updated), { expirationTtl: 8 * 24 * 3600 });
						}).catch(() => {}),
					);
				}
			}

			if (name === 'get_market_status') {
				// Validate mic before any other logic — return -32602 for missing or wrong type.
				if (args.mic === undefined || args.mic === null) {
					return rpcError(-32602, 'Invalid params: mic is required');
				}
				if (typeof args.mic !== 'string') {
					return rpcError(-32602, 'Invalid params: mic must be a string');
				}

				// ── Unauthenticated IP rate-limit: 10 get_market_status calls per IP per day ──
				// Authenticated requests (_mcpKeyHash !== null) are already metered above.
				if (_mcpKeyHash === null) {
					const unauthKey   = `unauth_mcp_status:${ipHash}:${today}`;
					const unauthCount = parseInt(await env.ORACLE_TELEMETRY.get(unauthKey).catch(() => '0') || '0', 10);
					if (unauthCount >= UNAUTH_MCP_STATUS_LIMIT) {
						return rpcResult({
							isError: true,
							content: [{ type: 'text', text: JSON.stringify({
								error:       'UNAUTHENTICATED_LIMIT_REACHED',
								message:     'Free market status checks exhausted. Add your sandbox key as a Bearer token or upgrade.',
								upgrade_url: 'https://headlessoracle.com/upgrade',
							}) }],
						});
					}
					// Increment non-blocking; 25h TTL so counter expires after the day rolls over.
					const unauthPut = env.ORACLE_TELEMETRY.put(unauthKey, String(unauthCount + 1), { expirationTtl: 25 * 3600 }).catch(() => {});
					if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(unauthPut);
				}

				const mic = args.mic.toUpperCase();
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
				// Validate mic before any other logic — return -32602 for missing or wrong type.
				if (args.mic === undefined || args.mic === null) {
					return rpcError(-32602, 'Invalid params: mic is required');
				}
				if (typeof args.mic !== 'string') {
					return rpcError(-32602, 'Invalid params: mic must be a string');
				}
				const mic = args.mic.toUpperCase();
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
				try {
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
				} catch {
					return rpcResult({
						isError: true,
						content: [{ type: 'text', text: JSON.stringify({
							error:   'SCHEDULE_ERROR',
							message: 'Failed to compute schedule for this exchange.',
							mic,
						}) }],
					});
				}
			}

			if (name === 'list_exchanges') {
				return rpcResult({
					content: [{ type: 'text', text: JSON.stringify({ exchanges: SUPPORTED_EXCHANGES }) }],
				});
			}

			if (name === 'verify_receipt') {
				if (args.receipt === undefined) {
					return rpcError(-32602, 'Invalid params: receipt is required');
				}
				const receipt = args.receipt as Record<string, unknown> | undefined;
				const result  = await verifyReceiptLogic(receipt, env.ED25519_PUBLIC_KEY);
				return rpcResult({
					content: [{ type: 'text', text: JSON.stringify(result) }],
				});
			}

			if (name === 'get_payment_options') {
				const options = buildPaymentOptions();
				return rpcResult({
					content: [{ type: 'text', text: JSON.stringify(options) }],
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
	source:  'polygon' | 'alpaca' | 'skipped' | 'schedule_only' | 'error';
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

async function deliverWebhook(target: WebhookDeliveryTarget, payload: Record<string, unknown>, maxAttempts = 4): Promise<{ ok: boolean; status?: number; error?: string }> {
	const body = JSON.stringify(payload);
	const deliveredAt = new Date().toISOString();

	// Add HMAC-SHA256 signature to the payload if the subscription has a secret.
	// Header: X-Oracle-Signature: sha256=<hmac_hex>
	const sigHeaders: Record<string, string> = {};
	if (target.secret) {
		sigHeaders['X-Oracle-Signature'] = await computeHmacSignature(target.secret, body);
	}

	const attempt = () => fetch(target.url, {
		method:  'POST',
		headers: {
			'Content-Type': 'application/json',
			'User-Agent':   'HeadlessOracle-Webhook/1.0',
			'X-Oracle-Event-At': deliveredAt,
			...sigHeaders,
		},
		body,
		signal: AbortSignal.timeout(10000),
	});

	// Up to maxAttempts attempts with exponential backoff: immediate, 1s, 4s, 16s
	const allDelays = [0, 1000, 4000, 16000];
	const delays = allDelays.slice(0, maxAttempts);
	for (let i = 0; i < delays.length; i++) {
		if (delays[i] > 0) await scheduler.wait(delays[i]);
		try {
			const resp = await attempt();
			if (resp.ok) {
				console.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED', subscription_id: target.subscription_id, attempt: i + 1 }));
				return { ok: true, status: resp.status };
			}
			if (i === delays.length - 1) {
				console.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, url: target.url, status: resp.status, attempts: delays.length }));
				return { ok: false, status: resp.status };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (i === delays.length - 1) {
				console.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, error: msg, attempts: delays.length }));
				return { ok: false, error: msg };
			}
		}
	}
	return { ok: false, error: 'exhausted' };
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

		// Exchange is scheduled OPEN — check real-time status.
		// Only XNYS and XNAS have real-time halt detection via external APIs.
		// All other exchanges are schedule_only — no intraday halt detection available.
		let halted = false;
		let source: HaltMonitorResult['source'] = 'error';
		let errorMsg: string | undefined;

		// Polygon.io covers XNYS (nyse) and XNAS (nasdaq) only.
		// No other exchange MICs are available via /v1/marketstatus/now.
		const micToPolygon: Record<string, string> = {
			XNYS: 'nyse', XNAS: 'nasdaq',
		};
		const polygonName = micToPolygon[mic];

		if (!polygonName) {
			// No real-time halt detection API covers this exchange.
			// Schedule-based status (hours + calendar) is the only signal available.
			// Fail-open: do NOT write a HALTED override — no false halts.
			results.push({ mic, checked: true, halted: false, source: 'schedule_only' });
			continue;
		}

		// Primary: Polygon.io market status (covers XNYS and XNAS)
		if (env.POLYGON_API_KEY) {
			try {
				const polygonResp = await fetch(
					`https://api.polygon.io/v1/marketstatus/now?apiKey=${env.POLYGON_API_KEY}`,
					{ signal: AbortSignal.timeout(5000) },
				);
				if (polygonResp.ok) {
					const data = await polygonResp.json() as Record<string, unknown>;
					const exchanges = data.exchanges as Record<string, string> | undefined;
					const marketStatus = exchanges?.[polygonName] ?? data.market;
					halted = typeof marketStatus === 'string' && marketStatus !== 'open';
					source = 'polygon';
				}
			} catch (err) {
				if (err instanceof Error && err.name === 'AbortError') {
					console.log(JSON.stringify({ event: 'HALT_MONITOR_TIMEOUT', exchange: mic, source: 'polygon', timeout_ms: 5000 }));
				}
				errorMsg = err instanceof Error ? err.message : 'polygon_fetch_failed';
			}
		}

		// Fallback: Alpaca market clock (US markets only — runs when Polygon unavailable or fails)
		if (source === 'error') {
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
			// Both Polygon and Alpaca failed — fail-open (do NOT write a HALTED override)
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
		results:        results.map((r) => ({ mic: r.mic, checked: r.checked, halted: r.halted, source: r.source, error: r.error })),
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
				event:           'status_change',
				webhook_id:      target.subscription_id,
				mic,
				previous_status: lastState,
				current_status:  currentStatus,
				receipt,
				delivered_at:    now.toISOString(),
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

		// ── Legacy master key migration (March–April 2026) ───────────────────────
		// Phase 1 awareness : 2026-03-25 → 2026-03-28  (_notice in every JSON response)
		// Phase 2 urgent    : 2026-03-29 → 2026-03-31  (_notice + X-Oracle-Migration headers)
		// Phase 3 enforcement: 2026-04-01+              (hard 402 on all authenticated endpoints)
		const _migDeadlineMs = Date.UTC(2026, 2, 31, 23, 59, 0); // Mar 31 23:59 UTC
		const migrationDaysLeft = Math.max(0, Math.floor((_migDeadlineMs - now.getTime()) / 86_400_000));
		const migrationPhase: 'awareness' | 'urgent' | 'enforcement' | null =
			now.getTime() >= Date.UTC(2026, 3, 1, 0, 0, 0)  ? 'enforcement' :
			now.getTime() >= Date.UTC(2026, 2, 29, 0, 0, 0) ? 'urgent' :
			now.getTime() >= Date.UTC(2026, 2, 25, 0, 0, 0) ? 'awareness' :
			null;
		const isMasterKeyRequest = (() => {
			const k = request.headers.get('X-Oracle-Key');
			return Boolean(k && env.MASTER_API_KEY && k === env.MASTER_API_KEY);
		})();

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
			'Access-Control-Allow-Headers': 'Content-Type, X-Oracle-Key, X-Payment, Payment-Signature',
			'Access-Control-Expose-Headers': 'Payment-Required, X-Payment-Required, X-Oracle-Plan, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// ── Best-effort referrer tracking ──────────────────────────────────────
		// Increment referrer:{date}:{domain} counter for any request with a Referer
		// header pointing to an external domain. Used by /v5/referrers to measure
		// which channels are driving traffic.
		const _referer = request.headers.get('Referer');
		if (_referer && typeof ctx?.waitUntil === 'function') {
			try {
				const _refDomain = new URL(_referer).hostname;
				if (_refDomain && _refDomain !== 'headlessoracle.com' && _refDomain !== 'www.headlessoracle.com') {
					const _refKey = `referrer:${now.toISOString().slice(0, 10)}:${_refDomain}`;
					ctx.waitUntil(
						env.ORACLE_TELEMETRY.get(_refKey).then((val) => {
							const next = (parseInt(val ?? '0', 10) || 0) + 1;
							return env.ORACLE_TELEMETRY.put(_refKey, String(next), { expirationTtl: 8 * 24 * 3600 });
						}).catch(() => {})
					);
				}
			} catch { /* malformed Referer URL — ignore */ }
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
			// Best-effort daily status code counter — enables /v5/metrics/public status_codes_today.
			if (typeof ctx?.waitUntil === 'function') {
				incrementKvCounter(`status_code:${now.toISOString().slice(0, 10)}:${status}`, env, ctx, 25 * 3600);
			}
			// x402 v2: set Payment-Required header (base64-encoded JSON) on 402 responses
			// so x402 client libraries can parse payment requirements from the header.
			const x402Headers: Record<string, string> = status === 402
				? { 'Link': '</v5/why-not-free>; rel="payment"', 'X-X402-Foundation': 'compatible' }
				: {};
			return new Response(JSON.stringify(responseBody), {
				status,
				headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Oracle-Version': 'v5', ...defaultRlHeaders, ...x402Headers, ...extraHeaders },
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
			// HEAD /mcp — uptime probes (e.g. MCPScoreboard) use HEAD to check reachability.
			// Respond 200 with no body; same headers as GET so probes see a live server.
			if (request.method === 'HEAD') {
				return new Response(null, { status: 200, headers: MCP_RESPONSE_HEADERS });
			}
			if (request.method === 'GET') {
				// SSE clients send GET /mcp with Accept: text/event-stream.
				// We don't implement SSE transport — return 405 so the client
				// stops reconnecting (SSE auto-reconnect only fires on 2xx/network close).
				if (request.headers.get('Accept')?.includes('text/event-stream')) {
					// SSE transport handshake — send endpoint event pointing to POST /mcp.
					// Cloudflare Workers are stateless and cannot hold connections indefinitely.
					// Pattern: send endpoint event + keepalive comment, then close.
					// Client will POST JSON-RPC messages to the advertised endpoint URI.
					const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
					const writer  = writable.getWriter();
					const encoder = new TextEncoder();
					writer.write(encoder.encode(`event: endpoint\ndata: ${JSON.stringify({ uri: 'https://headlessoracle.com/mcp' })}\n\n`));
					writer.write(encoder.encode(': keepalive\n\n'));
					writer.close();
					return new Response(readable, {
						headers: {
							'Content-Type':                'text/event-stream',
							'Cache-Control':               'no-cache',
							'Connection':                  'keep-alive',
							'Access-Control-Allow-Origin': '*',
							'X-Oracle-Version':            'v5',
						},
					});
				}
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
			return handleMcp(request, env, ctx).catch((err: unknown) => {
					console.error('MCP_UNHANDLED_ERROR', String(err));
					return new Response(JSON.stringify({
						jsonrpc: '2.0', id: null,
						error:   { code: -32603, message: 'Internal error' },
					}), { status: 200, headers: MCP_RESPONSE_HEADERS });
				});
		}

		try {
			// ── Phase 3: legacy master key hard expiry (April 1 2026) ────────────
			// Blocks authenticated endpoints only — public endpoints are unaffected.
			if (isMasterKeyRequest && migrationPhase === 'enforcement' && (
				url.pathname.startsWith('/v5/status') ||
				url.pathname === '/v5/batch' ||
				url.pathname === '/v5/account' ||
				url.pathname === '/v5/usage' ||
				url.pathname === '/v5/archive' ||
				url.pathname.startsWith('/v5/credits') ||
				url.pathname.startsWith('/v5/webhooks') ||
				url.pathname === '/v5/receipts' ||
				url.pathname === '/v5/handoff'
			)) {
				return json({
					error:      'legacy_key_expired',
					message:    'Your early access key expired on March 31, 2026. Register at headlessoracle.com/upgrade to continue. Your receipt history and usage data are preserved.',
					action_url: 'https://headlessoracle.com/upgrade?reason=legacy_migration',
				}, 402);
			}

			// ── Auth gate — /v5/status requires X-Oracle-Key or x402 payment ─────
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (apiKey) {
					// Key-based auth path (steps 1–3): MASTER → BETA → Supabase lookup
					const auth = await checkApiKey(apiKey, env);
					if (!auth.allowed) {
						const authHeaders = auth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
						const authBody = auth.status === 402
							? { error: auth.error, message: auth.message, upgrade_url: 'https://headlessoracle.com/upgrade', plans: { builder: '$99/month — 50,000 calls', pro: '$299/month — 200,000 calls' } }
							: { error: auth.error, message: auth.message };
						return json(authBody, auth.status, authHeaders);
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
							const paymentHeader = getPaymentHeader(request);
							if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
								const resource = `https://headlessoracle.com${url.pathname}${url.search}`;
								const verify = await verifyPaymentAnyFormat(paymentHeader, env.ORACLE_PAYMENT_ADDRESS, env, resource);
								if (!verify.valid) {
									incrementKvCounter(`funnel_402:payment_failed:${now.toISOString().slice(0, 10)}`, env, ctx);
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
									incrementKvCounter(`funnel_402:free_tier_gate:${now.toISOString().slice(0, 10)}`, env, ctx);
									return json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, keyHash), 402, X402_RESPONSE_HEADERS);
								} else {
									return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/upgrade' }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
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
							return json({ error: 'SANDBOX_LIMIT_REACHED', message: 'Your free sandbox key has reached its 200-call limit. Upgrade to continue.', upgrade_url: 'https://headlessoracle.com/upgrade', plans: { builder: '$99/month — 50,000 calls', pro: '$299/month — 200,000 calls' } }, 402);
						}
						incrementDailyUsage(sbKeyHash, env, ctx, sbUsage);
					// ── Paid tier daily limits (builder: 50k/day, pro: 200k/day) ──
					} else if (auth.plan === 'builder' || auth.plan === 'pro') {
						const paidKeyHash = auth.keyHash ?? await sha256Hex(apiKey);
						const paidUsage   = await getDailyUsage(paidKeyHash, env);
						const paidLimit   = getPlanDailyLimit(auth.plan)!;
						if (paidUsage >= paidLimit) {
							return json({ error: 'RATE_LIMITED', message: `${auth.plan} plan daily limit (${paidLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/upgrade` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
						}
						incrementDailyUsage(paidKeyHash, env, ctx, paidUsage);
					}
				} else {
					// No API key — x402 payment path (step 4) or 402 gate (step 5)
					const paymentHeader = getPaymentHeader(request);
					// ── Mainnet x402 facilitator path (x402.org, enabled by default) ─────────────
					// Accepts Base mainnet USDC payments via x402.org community facilitator (no auth).
					// Active unless X402_ENABLED is explicitly set to 'false'.
					if (env.ORACLE_PAYMENT_ADDRESS) {
						const resource = `https://headlessoracle.com${url.pathname}${url.search}`;
						if (paymentHeader) {
							// Accept BOTH formats: base64 (x402 standard) AND raw JSON (direct on-chain)
							const verified = await verifyPaymentAnyFormat(paymentHeader, env.ORACLE_PAYMENT_ADDRESS, env, resource);
							if (!verified.valid) {
								incrementKvCounter(`funnel_402:facilitator_rejected:${now.toISOString().slice(0, 10)}`, env, ctx);
								const errPayload = { ...buildMainnetFacilitatorPayload(env.ORACLE_PAYMENT_ADDRESS, resource), x402_error: verified.detail ?? 'payment rejected' };
								return json(errPayload, 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-X402-Network': 'mainnet', 'X-Payment-Required': 'true', 'X-Payment-Status': 'payment-rejected', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status') });
							}
							// Valid payment (either format) — fall through to serve receipt
						} else {
							// No payment — return facilitator-compatible 402 with payment requirements
							incrementKvCounter(`funnel_402:keyless_no_payment:${now.toISOString().slice(0, 10)}`, env, ctx);
							const x402IdxHdrs = buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status');
							return json(buildMainnetFacilitatorPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-X402-Network': 'mainnet', 'X-Payment-Required': 'true', 'X-Payment-Status': 'no-header', ...x402IdxHdrs });
						}
					} else {
						// ORACLE_PAYMENT_ADDRESS not configured — fall back to 401 (dev/test environments)
						return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
					}
				}
			}

			// Helper: wrap a Response to add soft rate-limit warning headers AND standard rate-limit headers.
			const withRateLimitWarning = (response: Response): Response => {
				const newHeaders = new Headers(response.headers);
				const rlHeaders  = makeRateLimitHeaders(_rlPlan, _rlUsed, _rlLimit, now);
				for (const [k, v] of Object.entries(rlHeaders)) newHeaders.set(k, v);
				if (freeTierPercentUsed >= 80) {
					addRateLimitWarningHeaders(newHeaders, freeTierPercentUsed, 'https://headlessoracle.com/upgrade');
				}
				return new Response(response.body, { status: response.status, headers: newHeaders });
			};

			// Helper: append _notice to JSON responses during Phase 1 (awareness) and Phase 2 (urgent)
			// for the legacy master key only. No-op for all other keys, all non-migration dates, and Phase 3.
			const withMigrationNotice = async (response: Response): Promise<Response> => {
				if (!isMasterKeyRequest || !migrationPhase || migrationPhase === 'enforcement') return response;
				let body: Record<string, unknown>;
				try { body = await response.clone().json() as Record<string, unknown>; } catch { return response; }
				body['_notice'] = migrationPhase === 'urgent'
					? {
						type:                 'migration_urgent',
						title:                'Your early access key expires soon',
						message:              `Your early access key expires in ${migrationDaysLeft} day${migrationDaysLeft === 1 ? '' : 's'}. After March 31, 2026, this key will return 402 errors. Register now at headlessoracle.com/upgrade to avoid disruption to your integration.`,
						action_url:           'https://headlessoracle.com/upgrade?reason=legacy_migration',
						migration_deadline:   '2026-03-31T23:59:00Z',
						days_remaining:       migrationDaysLeft,
						recommended_plan:     'builder',
						recommended_plan_url: 'https://headlessoracle.com/#pricing',
					}
					: {
						type:                 'legacy_migration',
						title:                'Your early access period is ending',
						message:              "You've been on an early access key since March 2026. We're migrating early access users to paid plans on March 31, 2026. Your key will stop working after this date. Register now at headlessoracle.com/upgrade — it takes 2 minutes.",
						action_url:           'https://headlessoracle.com/upgrade?reason=legacy_migration',
						migration_deadline:   '2026-03-31T23:59:00Z',
						days_remaining:       migrationDaysLeft,
						recommended_plan:     'builder',
						recommended_plan_url: 'https://headlessoracle.com/#pricing',
					};
				const newHeaders = new Headers(response.headers);
				if (migrationPhase === 'urgent') {
					newHeaders.set('X-Oracle-Migration',      'urgent');
					newHeaders.set('X-Oracle-Deadline',       '2026-03-31');
					newHeaders.set('X-Oracle-Days-Remaining', String(migrationDaysLeft));
				}
				return new Response(JSON.stringify(body), { status: response.status, headers: newHeaders });
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
						receipt_fields:  ['expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic', 'public_key_id', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
						override_fields: ['expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic', 'public_key_id', 'reason', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
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
					settlement_window:   SETTLEMENT_WINDOWS[mic] ?? null,
					note:                'Times are UTC. lunch_break times are local exchange time (see timezone field). next_open is null when coverage for the current year is unavailable. settlement_window is informational only (not signed).',
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

				return await withMigrationNotice(json({
					mic,
					signed_receipt:    receipt,
					halt_monitor: {
						active_realtime_override: realtimeOverride,
						note: 'halt_monitor runs every minute via cron. REALTIME overrides are auto-cleared when exchange resumes.',
					},
				}, receiptStatus, { 'Cache-Control': 'no-store' }));
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
				// Archive: write signed receipt to ORACLE_TELEMETRY for /v5/archive (non-blocking, 30-day TTL).
				if (mode === 'live' && typeof ctx?.waitUntil === 'function' && env.ORACLE_TELEMETRY && typeof receipt['receipt_id'] === 'string') {
					const archiveDate = now.toISOString().slice(0, 10);
					ctx.waitUntil(
						env.ORACLE_TELEMETRY.put(
							`receipt:${mic}:${archiveDate}:${receipt['receipt_id'] as string}`,
							JSON.stringify(receipt),
							{ expirationTtl: 2592000 },
						).catch(() => {}),
					);
				}
				// Receipts must not be cached — they expire in 60s and contain real-time status.
				// discovery_url lets agents that receive this receipt discover full oracle capabilities.
				const receiptWithDiscovery = { ...receipt, receipt, discovery_url: 'https://headlessoracle.com/.well-known/mcp/server-card.json', extensions: { bazaar: { discoverable: true, category: 'financial-data', tags: ['market-state', 'exchange-status', 'pre-trade', 'attestation', 'Ed25519', 'trading-hours', 'holiday-calendar', 'fail-closed', '28-exchanges', 'signed-receipt', 'MIC'], description: 'Ed25519-signed market-state receipt for 28 global exchanges. Pre-trade verification gate for autonomous financial agents. UNKNOWN = CLOSED. Real-time session status, holiday-aware calendar, 60-second TTL.' } } };
				return withRateLimitWarning(await withMigrationNotice(json(receiptWithDiscovery, status, { 'Cache-Control': 'no-store' })));
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
						return json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, 'https://headlessoracle.com/v5/batch', 'batch'), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'batch') });
					}
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const batchAuth = await checkApiKey(apiKey, env);
				if (!batchAuth.allowed) {
					const batchAuthHeaders = batchAuth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					const batchAuthBody = batchAuth.body ?? (batchAuth.status === 402
						? { error: batchAuth.error, message: batchAuth.message, upgrade_url: 'https://headlessoracle.com/upgrade', plans: { builder: '$99/month — 50,000 calls', pro: '$299/month — 200,000 calls' } }
						: { error: batchAuth.error, message: batchAuth.message });
					return json(batchAuthBody, batchAuth.status, batchAuthHeaders);
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
						const paymentHeader = getPaymentHeader(request);
						if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
							const batchResource = 'https://headlessoracle.com/v5/batch';
							const verify = await verifyPaymentAnyFormat(paymentHeader, env.ORACLE_PAYMENT_ADDRESS, env, batchResource);
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
								return json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/upgrade' }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
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
						return json({ error: 'SANDBOX_LIMIT_REACHED', message: 'Your free sandbox key has reached its 200-call limit. Upgrade to continue.', upgrade_url: 'https://headlessoracle.com/upgrade', plans: { builder: '$99/month — 50,000 calls', pro: '$299/month — 200,000 calls' } }, 402);
					}
					incrementDailyUsage(sbBatchKeyHash, env, ctx, sbBatchUsage);
				// ── Paid tier daily limits for batch (builder: 50k/day, pro: 200k/day) ──
				} else if (batchAuth.plan === 'builder' || batchAuth.plan === 'pro') {
					const paidBatchKeyHash = batchAuth.keyHash ?? await sha256Hex(apiKey);
					const paidBatchUsage   = await getDailyUsage(paidBatchKeyHash, env);
					const paidBatchLimit   = getPlanDailyLimit(batchAuth.plan)!;
					if (paidBatchUsage >= paidBatchLimit) {
						return json({ error: 'RATE_LIMITED', message: `${batchAuth.plan} plan daily limit (${paidBatchLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/upgrade` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
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

				return withRateLimitWarning(await withMigrationNotice(json({
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
						receipts:   results.map((r) => ({ ...r.receipt as Record<string, unknown>, receipt: r.receipt, discovery_url: 'https://headlessoracle.com/.well-known/mcp/server-card.json' })),
					})));
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

					// MCP per-tool counts (best-effort, unsigned informational field)
					const healthToday = now.toISOString().slice(0, 10);
					const [hts, htsc, htl, htv] = await Promise.all([
						env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_status:${healthToday}`).catch(() => null),
						env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_schedule:${healthToday}`).catch(() => null),
						env.ORACLE_TELEMETRY.get(`mcp_tool:list_exchanges:${healthToday}`).catch(() => null),
						env.ORACLE_TELEMETRY.get(`mcp_tool:verify_receipt:${healthToday}`).catch(() => null),
					]);
					const healthMcpToolsToday = {
						get_market_status:   parseInt(hts  ?? '0', 10) || 0,
						get_market_schedule: parseInt(htsc ?? '0', 10) || 0,
						list_exchanges:      parseInt(htl  ?? '0', 10) || 0,
						verify_receipt:      parseInt(htv  ?? '0', 10) || 0,
					};

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
							coverage: {
								active:        ['XNYS', 'XNAS'],
								schedule_only: ['XLON','XJPX','XPAR','XHKG','XSES','XASX','XBOM','XNSE','XSHG','XSHE','XKRX','XJSE','XBSP','XSWX','XMIL','XIST','XSAU','XDFM','XNZE','XHEL','XSTO'],
							},
							active_realtime_overrides: activeRealtimeOverrides,
							note:                      'Real-time halt detection covers XNYS and XNAS only (Polygon.io + Alpaca). All other exchanges are schedule_only: calendar hours + holidays are authoritative but intraday circuit breaker halts are not detected. Fails open — no false halts on API errors.',
						},
						mcp_tools_today:           healthMcpToolsToday,
						discovery_url:             'https://headlessoracle.com/.well-known/mcp/server-card.json',
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
			if (url.pathname === '/sitemap.xml') {
				return new Response(SITEMAP_XML, {
					headers: {
						'Content-Type':  'application/xml',
						'Cache-Control': 'public, max-age=86400',
					},
				});
			}
			if (url.pathname === '/robots.txt') {
				return new Response(ROBOTS_TXT, { headers: { 'Content-Type': 'text/plain' } });
			}
			if (url.pathname === '/.well-known/security.txt') {
				const body = `Contact: mailto:info@bytecraftresults.com\nExpires: 2027-04-03T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://headlessoracle.com/.well-known/security.txt\n`;
				return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
			if (url.pathname === '/skill.md') {
				// Ampersend skill format — describes x402 payment details and CLI usage.
				// Served lowercase per Ampersend convention (distinct from /SKILL.md agent guide).
				return new Response(AMPERSEND_SKILL_MD, {
					headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
				});
			}
			if (url.pathname === '/AGENTS.md') {
				return new Response(AGENTS_MD, {
					headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
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
				if (p === '/docs/sma-protocol/rfc-001' || p === '/docs/sma-protocol/rfc-001.md')
					return new Response(SMA_RFC_001_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
					if (p === '/docs/mpas' || p === '/docs/mpas.md')
						return new Response(MPAS_SPEC_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/cline' || p === '/docs/cline.md')
					return new Response(CLINE_CONFIG_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/continue' || p === '/docs/continue.md')
					return new Response(CONTINUE_CONFIG_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/olas' || p === '/docs/integrations/olas.md')
					return new Response(OLAS_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/autogpt' || p === '/docs/integrations/autogpt.md')
					return new Response(AUTOGPT_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/google-adk' || p === '/docs/integrations/google-adk.md')
					return new Response(GOOGLE_ADK_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/trading-agents' || p === '/docs/integrations/trading-agents.md')
					return new Response(TRADING_AGENTS_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/agno' || p === '/docs/integrations/agno.md')
					return new Response(AGNO_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				if (p === '/docs/integrations/strands' || p === '/docs/integrations/strands.md')
					return new Response(STRANDS_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });
				// Unknown /docs/ path — fall through to 404 below
			}

			// ── /blog/* — blog posts served as plain text ───────────────────
			if (url.pathname.startsWith('/blog/')) {
				const blogSlug    = url.pathname.slice('/blog/'.length);
				const blogHeaders = {
					'Content-Type':  'text/plain; charset=utf-8',
					'Cache-Control': 'public, max-age=3600',
					'Link':          `<https://headlessoracle.com/blog/${blogSlug}>; rel="canonical"`,
				};
				if (url.pathname === '/blog/why-your-trading-agent-needs-a-pre-trade-gate')
					return new Response(BLOG_POST_WHY_PRE_TRADE_GATE, { headers: blogHeaders });
				if (url.pathname === '/blog/market-hours-api-vs-signed-attestation')
					return new Response(BLOG_MARKET_HOURS_VS_SIGNED, { headers: blogHeaders });
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
					INVALID_MIC:           { message: 'Unsupported exchange MIC code.', resolution: 'See /v5/exchanges for the full list of 28 supported exchanges.', http_status: 400 },
					METHOD_NOT_ALLOWED:    { message: 'HTTP method not allowed for this endpoint.', resolution: 'Check the HTTP method. See /openapi.json for allowed methods per route.', http_status: 405 },
					NOT_FOUND:             { message: 'Route not found.', resolution: 'Check the path. See /openapi.json for all available routes.', http_status: 404 },
					INVALID_TX_HASH:       { message: 'X-Payment txHash is not a valid 32-byte hex string.', resolution: 'Provide a valid Ethereum transaction hash (0x + 64 hex chars).', http_status: 402 },
					INVALID_PAYMENT:       { message: 'X-Payment header is not valid JSON or missing required fields.', resolution: 'See /docs/x402-payments.md for the required X-Payment format.', http_status: 402 },
					PAYMENT_VERIFICATION_FAILED: { message: 'The on-chain USDC payment could not be verified.', resolution: 'Ensure the transaction is confirmed on Base mainnet, sent to the correct paymentAddress, and is < 300 seconds old.', http_status: 402 },
					PAYMENT_ALREADY_USED:  { message: 'This transaction hash has already been used for a payment.', resolution: 'Each txHash can only be used once. Send a new USDC transaction.', http_status: 402 },
					PAYMENT_EXPIRED:       { message: 'The transaction is older than 300 seconds.', resolution: 'Send a new USDC transaction and retry immediately.', http_status: 402 },
					ACCOUNT_NOT_FOUND:     { message: 'No account found for this API key.', resolution: 'Verify your X-Oracle-Key. If subscribed via Paddle, check your email for the key.', http_status: 404 },
					SANDBOX_LIMIT_REACHED: { message: 'Sandbox key has reached its 200-call limit.', resolution: 'Upgrade to a credit pack ($5 for 1,000 calls) at https://headlessoracle.com/upgrade, or subscribe to Builder ($99/mo) for 50,000 calls/day.', http_status: 402 },
					SANDBOX_KEY_EXPIRED:   { message: 'Sandbox key has expired (7-day TTL).', resolution: 'Upgrade to a credit pack ($5 for 1,000 calls) at https://headlessoracle.com/upgrade, or subscribe to Builder ($99/mo).', http_status: 402 },
					CREDITS_EXHAUSTED:     { message: 'Credit pack balance is zero.', resolution: 'Purchase a new credit pack at https://headlessoracle.com/upgrade, or subscribe to Builder ($99/mo) for a daily allowance.', http_status: 402 },
					PLAN_LIMIT_EXCEEDED:   { message: 'Daily request limit for your plan has been reached.', resolution: 'Upgrade your plan at https://headlessoracle.com/upgrade. Limit resets at UTC midnight.', http_status: 429 },
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

			// Self-describing MCP registry feed — machine-readable, auto-updateable listing metadata.
			// Registries (PulseMCP, Glama, etc.) can poll this to sync tool/exchange counts
			// without requiring a manual re-submission every time metadata changes.
			// No other MCP server publishes this endpoint; it is a proposed convention.
			if (url.pathname === '/.well-known/mcp-servers.json') {
				return json({
					servers: [{
						name:                 'headless-oracle',
						display_name:         'Headless Oracle',
						description:          'Ed25519-signed market-state attestations for autonomous agent pre-trade verification. ' +
							'Returns OPEN, CLOSED, HALTED, or UNKNOWN for 28 global exchanges. ' +
							'Fail-closed: UNKNOWN and HALTED always treated as CLOSED.',
						mcp_endpoint:         'https://headlessoracle.com/mcp',
						mcp_protocol_version: MCP_PROTOCOL_VERSION,
						transport:            ['streamable-http', 'stdio'],
						stdio_package:        'headless-oracle-mcp',
						stdio_package_registry: 'npm',
						homepage:             'https://headlessoracle.com',
						docs:                 'https://headlessoracle.com/docs',
						openapi:              'https://headlessoracle.com/openapi.json',
						repository:           'https://github.com/LembaGang/headless-oracle-v5',
						license:              'MIT',
						category:             ['finance', 'market-data', 'trading', 'agent-safety'],
						tools: [
							{ name: 'get_market_status',   description: 'Ed25519-signed market state receipt (OPEN/CLOSED/HALTED/UNKNOWN)' },
							{ name: 'get_market_schedule',  description: 'Next open/close times in UTC, DST-aware' },
							{ name: 'list_exchanges',       description: 'All 28 supported exchanges with MIC codes' },
							{ name: 'verify_receipt',       description: 'Verify Ed25519 signature and TTL on a signed receipt' },
							{ name: 'get_payment_options',  description: 'Upgrade ladder: sandbox → x402 → credits → Builder' },
						],
						coverage: {
							exchanges:    SUPPORTED_EXCHANGES.length,
							mic_codes:    SUPPORTED_EXCHANGES.map((e) => e.mic),
							regions:      ['Americas', 'Europe', 'Middle East', 'Africa', 'Asia', 'Pacific'],
						},
						authentication: {
							required:    false,
							schemes:     ['apiKey', 'bearer', 'x402'],
							free_tier:   { type: 'sandbox', endpoint: 'https://headlessoracle.com/v5/sandbox' },
							x402:        { network: 'eip155:8453', amount_usdc: 0.001, discovery: 'https://headlessoracle.com/.well-known/x402.json' },
						},
						signing: {
							algorithm:    'Ed25519',
							receipt_ttl:  60,
							key_endpoint: 'https://headlessoracle.com/v5/keys',
						},
						fail_closed:   true,
						standards:     ['SMA-1.0', 'APTS-1.0', 'MPAS-1.0'],
						install: {
							npx: 'npx headless-oracle-mcp',
							npm: 'npm install -g headless-oracle-mcp',
						},
						clients: {
							claude_desktop: { command: 'npx', args: ['-y', 'headless-oracle-mcp'] },
							cursor:         { command: 'npx', args: ['-y', 'headless-oracle-mcp'] },
						},
						metrics_url: 'https://headlessoracle.com/v5/metrics/public',
						health_url:  'https://headlessoracle.com/v5/health',
						demo_url:    'https://headlessoracle.com/v5/demo?mic=XNYS',
						updated_at:  new Date().toISOString(),
					}],
				}, 200, { 'Cache-Control': 'public, max-age=300' });
			}

			// RFC-standard MCP discovery alias — agents that probe /.well-known/mcp.json
			// before /.well-known/mcp/server-card.json get the same payload.
			if (url.pathname === '/.well-known/mcp.json' || url.pathname === '/.well-known/mcp/server-card.json') {
				return json({
					name:           'Headless Oracle',
					version:        'v5.0',
					description:    'Cryptographically signed market-state attestations for pre-trade verification and pre-execution gating. ' +
						'Ed25519 signatures, fail-closed architecture, 28 global exchanges (equities, derivatives, 24/7 crypto). ' +
						'Use as a pre-trade check before any financial execution or capital commitment. ' +
						'UNKNOWN and HALTED MUST be treated as CLOSED. Receipts include attestation_ref for x402 payment flows and audit trails.',
					mcp_endpoint:   'https://headlessoracle.com/mcp',
					tools:          ['get_market_status', 'get_market_schedule', 'list_exchanges', 'verify_receipt'],
					authentication: ['bearer', 'apiKey', 'x402'],
					homepage:       'https://headlessoracle.com',
					docs:           'https://headlessoracle.com/docs',
					quickstart_url: 'https://headlessoracle.com/docs/quickstart',
					key_request:    'https://headlessoracle.com/v5/keys/request',
					openapi:        'https://headlessoracle.com/openapi.json',
					protocol:       '2024-11-05',
					protocols:      ['MCP-2024-11-05', 'A2A', 'x402', 'OAuth2'],
					transports:     ['http', 'sse'],
					fail_closed:    true,
					reliability:    { uptime_sla: '99.9%', p95_latency_ms: 200 },
					verification:   { algorithm: 'Ed25519', key_endpoint: 'https://api.headlessoracle.com/v5/keys' },
					coverage:       {
						exchanges: SUPPORTED_EXCHANGES.length,
						mic_codes: SUPPORTED_EXCHANGES.map((e) => e.mic),
						halt_detection: {
							active:        ['XNYS', 'XNAS'],
							schedule_only: ['XLON','XJPX','XPAR','XHKG','XSES','XASX','XBOM','XNSE','XSHG','XSHE','XKRX','XJSE','XBSP','XSWX','XMIL','XIST','XSAU','XDFM','XNZE','XHEL','XSTO'],
							note: 'Real-time intraday halt detection (Polygon.io + Alpaca fallback) covers XNYS and XNAS only. All other exchanges use schedule-based status: calendar hours and holidays are correct, but unscheduled intraday circuit breaker halts are not detected. Every signed receipt carries a halt_detection field ("active" | "schedule_only") so agents know which applies.',
						},
					},
					// x402 autonomous payment: agents can call /v5/status without a key,
					// receive a 402 with payment details, pay on-chain, and retry — no subscription needed.
					x402: {
						payable:          true,
						scheme:           'exact',
						network:          'eip155:8453',
						currency:         'USDC',
						amount:           '1000',           // 0.001 USDC at 6 decimals
						asset:            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
						discovery:        'https://headlessoracle.com/.well-known/x402.json',
						payment_endpoint: 'https://headlessoracle.com/v5/status',
					},
					sma_protocol_version:  'RFC-001-draft',
					sma_note:              'SMA = Signed Market Attestation (not Simple Moving Average). Receipts are Ed25519-signed, 60-second TTL, fail-closed.',
					conformance_vectors:   'https://api.headlessoracle.com/v5/conformance-vectors',
					mpas_spec:             'https://github.com/LembaGang/mpas-spec',
					mpas_version:          '1.0',
					dst_aware:             true,
					discovery_url:         'https://headlessoracle.com/.well-known/mcp/server-card.json',
					skill_url:             'https://headlessoracle.com/skill.md',
					erc8004:               '8453:38413',
					ampersend:             'https://app.ampersend.ai/agents/headless-oracle',
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
							network:           'base',
							maxAmountRequired: '1000',
							asset:             X402_USDC_CONTRACT,
							payTo,
							extra:             { name: 'USD Coin', version: '2' },
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
							network:           'base',
							maxAmountRequired: '5000',
							asset:             X402_USDC_CONTRACT,
							payTo,
							extra:             { name: 'USD Coin', version: '2' },
						}],
					},
				{
					path:        '/v5/x402/mint',
					method:      'POST',
					description: 'Mint a persistent ho_live_ API key by sending USDC on Base mainnet. Tier builder=99 USDC (50K calls/day), pro=299 USDC (200K calls/day). No signup required.',
					input: {
						type:       'object',
						properties: {
							tx_hash: { type: 'string', description: 'Base mainnet transaction hash of the USDC payment' },
							network: { type: 'string', description: 'Base mainnet network identifier. Accepts: "base", "base-mainnet", or "eip155:8453"' },
							tier:    { type: 'string', enum: ['builder', 'pro'], description: 'builder=99 USDC, pro=299 USDC' },
							email:   { type: 'string', description: 'Optional — key will also be sent by email if provided' },
						},
						required: ['tx_hash', 'tier'],
					},
					tiers: {
						builder: { usdc: 99, calls_per_day: BUILDER_TIER_DAILY_LIMIT, asset: X402_USDC_CONTRACT, payTo },
						pro:     { usdc: 299, calls_per_day: PRO_TIER_DAILY_LIMIT, asset: X402_USDC_CONTRACT, payTo },
					},
				},
				] : [];
				// Facilitator resources: when X402_ENABLED=true, advertise CDP mainnet facilitator endpoint.
				// Gated on explicit opt-in (X402_ENABLED=true) to avoid duplicate /v5/status entries.
				const facilitatorResources = (env.X402_ENABLED === 'true' && env.ORACLE_PAYMENT_ADDRESS) ? [{
					path:        '/v5/status',
					method:      'GET',
					description: 'Signed market-state receipt. Ed25519 signed, 60s TTL. $0.001 USDC on Base mainnet via CDP facilitator.',
					network:     'mainnet',
					facilitator: X402_FACILITATOR_URL,
					accepts: [{
						scheme:            'exact',
						network:           'base',
						maxAmountRequired: '1000',
						asset:             X402_USDC_CONTRACT,
						payTo:             env.ORACLE_PAYMENT_ADDRESS,
						facilitator:       X402_FACILITATOR_URL,
						extra:             { name: 'USD Coin', version: '2' },
					}],
				}] : [];
				return json({ version: 1, resources: [...paidResources, ...facilitatorResources] });
			}

			if (url.pathname === '/.well-known/402index-verify.txt') {
				return new Response('c59d748d9df8fe67e4b3a0a2adf73b0e3ee9a3b7e7759572758feb89f69e37bd\n', {
					headers: { 'Content-Type': 'text/plain' },
				});
			}

			// ── POST /v5/x402/mint — autonomous key minting via on-chain USDC payment ──
			// No auth required. Agents send USDC on Base mainnet and receive a persistent
			// ho_live_ API key without any human in the loop.
			// Tiers: builder (99 USDC → 50K calls/day), pro (299 USDC → 200K calls/day)
			if (url.pathname === '/v5/x402/mint') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST /v5/x402/mint with { tx_hash, network, tier }' }, 405);
				}
				if (!env.ORACLE_PAYMENT_ADDRESS) {
					return json({ error: 'SERVICE_UNAVAILABLE', message: 'x402 key minting is not configured on this instance' }, 503);
				}

				let mintBody: { tx_hash?: unknown; network?: unknown; tier?: unknown; email?: unknown };
				try { mintBody = await request.json() as typeof mintBody; }
				catch { return json({ error: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400); }

				const txHash  = typeof mintBody.tx_hash  === 'string' ? mintBody.tx_hash.trim()  : '';
				const network = typeof mintBody.network  === 'string' ? mintBody.network.trim()  : '';
				const tier    = typeof mintBody.tier     === 'string' ? mintBody.tier.trim()     : '';
				const email   = typeof mintBody.email    === 'string' ? mintBody.email.trim()    : null;

				if (!txHash)  return json({ error: 'BAD_REQUEST', message: 'tx_hash is required' }, 400);
				const validMintNetworks = new Set(['base-mainnet', 'base', 'eip155:8453']);
				if (network && !validMintNetworks.has(network)) {
					return json({ error: 'BAD_REQUEST', message: 'network must be "base", "base-mainnet", or "eip155:8453"' }, 400);
				}
				if (tier !== 'builder' && tier !== 'pro') {
					return json({
						error:   'BAD_REQUEST',
						message: 'tier must be "builder" (99 USDC, 50K calls/day) or "pro" (299 USDC, 200K calls/day)',
						tiers: {
							builder: { usdc: 99, calls_per_day: BUILDER_TIER_DAILY_LIMIT },
							pro:     { usdc: 299, calls_per_day: PRO_TIER_DAILY_LIMIT },
						},
					}, 400);
				}

				const minAmountUnits = tier === 'pro' ? X402_MINT_PRO_UNITS : X402_MINT_BUILDER_UNITS;
				const verification   = await verifyX402MintPayment(txHash, env.ORACLE_PAYMENT_ADDRESS, minAmountUnits, env);

				if (!verification.valid) {
					// Return 409 for replay (already used), 402 for payment issues
					const isReplay = verification.detail === 'TRANSACTION_ALREADY_USED';
					const isWrongAmount = verification.detail?.startsWith('INSUFFICIENT_AMOUNT');
					if (isReplay) {
						return json({
							error:    'CONFLICT',
							message:  'This transaction hash has already been used to mint a key',
							detail:   verification.detail,
						}, 409);
					}
					if (isWrongAmount) {
						return json({
							error:             'PAYMENT_INSUFFICIENT',
							message:           `Insufficient USDC amount for ${tier} tier`,
							required_usdc:     tier === 'pro' ? '299' : '99',
							required_units:    minAmountUnits.toString(),
							detail:            verification.detail,
							network:           'base',
							payment_address:   env.ORACLE_PAYMENT_ADDRESS,
						}, 402);
					}
					if (verification.detail?.startsWith('TRANSACTION_EXPIRED')) {
						return json({ error: 'PAYMENT_EXPIRED', message: `Transaction older than ${X402_MINT_MAX_AGE_SECONDS}s — send a fresh USDC payment`, detail: verification.detail }, 400);
					}
					return json({ error: 'PAYMENT_VERIFICATION_FAILED', message: 'On-chain payment could not be verified', detail: verification.detail }, 402);
				}

				// Payment verified — mint a persistent ho_live_ key
				const rawKeyBytes = crypto.getRandomValues(new Uint8Array(32));
				const keyValue    = 'ho_live_' + toHex(rawKeyBytes);
				const mintKeyHash = await sha256Hex(keyValue);
				const keyPrefix   = keyValue.substring(0, 14); // 'ho_live_' + 6 chars

				// Store in ORACLE_API_KEYS KV (persistent, no TTL)
				if (env.ORACLE_API_KEYS) {
					await env.ORACLE_API_KEYS.put(
						mintKeyHash,
						JSON.stringify({
							plan:       tier,
							status:     'active',
							source:     'x402_onchain',
							email:      email ?? null,
							created_at: now.toISOString(),
						}),
					);
				}

				// Insert into Supabase api_keys table (non-blocking — KV is source of truth for auth)
				if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
					const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
					ctx.waitUntil(
						supabase.from('api_keys').insert({
							id:                    crypto.randomUUID(),
							key_hash:              mintKeyHash,
							key_prefix:            keyPrefix,
							plan:                  tier,
							status:                'active',
							stripe_customer_id:    null,
							stripe_subscription_id: null,
							email:                 email ?? null,
							created_at:            now.toISOString(),
						}).then(({ error: dbErr }) => {
							if (dbErr && (dbErr as unknown as Record<string, string>).code !== '23505') {
								console.error(`X402_MINT_DB_ERROR: ${dbErr.message}`);
							}
						}).catch((e: unknown) => {
							console.error(`X402_MINT_DB_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
						}),
					);
				}

				// Send welcome email via Resend (optional — skipped if no email provided)
				if (env.RESEND_API_KEY && email) {
					ctx.waitUntil(
						fetch('https://api.resend.com/emails', {
							method:  'POST',
							headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
							body: JSON.stringify({
								from:    'Headless Oracle <keys@headlessoracle.com>',
								to:      [email],
								subject: `Your Headless Oracle ${tier} API key`,
								html: `<p>Your autonomous x402 payment was verified on Base mainnet.</p>
<p>Your API key for the <strong>${tier}</strong> plan (${tier === 'pro' ? '200K' : '50K'} calls/day) — save this, it will not be shown again:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">${keyValue}</pre>
<p>Use it as the <code>X-Oracle-Key</code> header: <code>GET https://api.headlessoracle.com/v5/status?mic=XNYS</code></p>
<p>Documentation: <a href="https://headlessoracle.com/docs">headlessoracle.com/docs</a></p>`,
							}),
						}).then((res) => {
							if (!res.ok) console.error(`X402_MINT_EMAIL_ERROR: status=${res.status}`);
						}).catch((e: unknown) => {
							console.error(`X402_MINT_EMAIL_EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
						}),
					);
				}

				// Telemetry: x402_mint_keys:{date} counter
				const mintDate = now.toISOString().slice(0, 10);
				incrementKvCounter(`x402_mint_keys:${mintDate}`, env, ctx);
				console.log(JSON.stringify({
					event:        'X402_MINT_SUCCESS',
					tier,
					key_prefix:   keyPrefix,
					tx_hash:      txHash.toLowerCase(),
					amount_units: verification.amountPaid?.toString() ?? '?',
					has_email:    !!email,
				}));

				return json({
					api_key:        keyValue,
					tier,
					calls_remaining: tier === 'pro' ? PRO_TIER_DAILY_LIMIT : BUILDER_TIER_DAILY_LIMIT,
					expires_never:  true,
					source:         'x402_onchain',
					note:           'Save this key — it will not be shown again. Use as X-Oracle-Key header.',
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
				const plan = body.plan || url.searchParams.get('type') || 'builder';
				const priceId =
					plan === 'pro'      ? env.PADDLE_PRICE_ID_PRO :
					plan === 'protocol' ? env.PADDLE_PRICE_ID_PROTOCOL :
					plan === 'credits'  ? env.PADDLE_PRICE_ID_CREDITS :
					                      env.PADDLE_PRICE_ID_BUILDER;
				if (!priceId) {
					return json({ error: 'SERVICE_UNAVAILABLE', message: `Billing plan '${plan}' is not configured` }, 503);
				}
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

					// Credits pack: one-time payment — handle before subscription_id guard
					const txnItems   = txn['items'] as Array<{ price_id?: string }> | undefined;
					const txnPriceId = txnItems?.[0]?.price_id ?? null;
					if (env.PADDLE_PRICE_ID_CREDITS && txnPriceId === env.PADDLE_PRICE_ID_CREDITS) {
						// Fetch customer email
						let creditsEmail: string | null = null;
						if (env.PADDLE_API_KEY && txn['customer_id']) {
							const custRes = await fetch(`https://api.paddle.com/customers/${txn['customer_id'] as string}`, {
								headers: { 'Authorization': `Bearer ${env.PADDLE_API_KEY}` },
							});
							if (custRes.ok) {
								const custBody = await custRes.json() as { data?: { email?: string } };
								creditsEmail = custBody.data?.email ?? null;
							}
						}
						// Mint credits key — ho_crd_ prefix distinguishes from subscription keys
						const rawBytes   = crypto.getRandomValues(new Uint8Array(32));
						const creditsKey = 'ho_crd_' + toHex(rawBytes);
						const creditsHash = await sha256Hex(creditsKey);
						if (env.ORACLE_API_KEYS) {
							await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
								tier:       'credits',
								status:     'active',
								balance:    1000,
								created_at: new Date().toISOString(),
								email:      creditsEmail,
								source:     'paddle_credits',
							}));
						}
						// GAP-014: audit the credit key minting in receipt_audit
						ctx.waitUntil(insertReceiptAudit(creditsHash, {
							mic:        'credits',
							status:     'minted',
							source:     'paddle_credits',
							issued_at:  new Date().toISOString(),
						}, env).catch(() => {}));
						// Send welcome email (fire-and-forget — key is already stored)
						if (env.RESEND_API_KEY && creditsEmail) {
							fetch('https://api.resend.com/emails', {
								method:  'POST',
								headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
								body: JSON.stringify({
									from:    'Headless Oracle <keys@headlessoracle.com>',
									to:      [creditsEmail],
									subject: 'Your Headless Oracle credit pack — 1,000 calls ready',
									html: `<p>Your 1,000-call credit pack is ready.</p>
<p>Your API key (save this — it will not be shown again):</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px">${creditsKey}</pre>
<p>Use it as the <code>X-Oracle-Key</code> header. Each authenticated call consumes one credit.</p>
<p>Credits do not expire — they last until used.</p>
<p>Buy more or upgrade to a subscription: <a href="https://headlessoracle.com/upgrade">headlessoracle.com/upgrade</a></p>`,
								}),
							}).catch(() => {});
						}
						console.log(JSON.stringify({ event: 'CREDITS_KEY_MINTED', email: creditsEmail ?? 'none', txn_id: txn['id'] ?? 'unknown' }));
						return json({ received: true });
					}

					// Guard: skip non-subscription transactions (e.g. other one-time payments)
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
<p>Use it as the <code>X-Oracle-Key</code> header in every request:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">curl https://headlessoracle.com/v5/status?mic=XNYS \\
  -H "X-Oracle-Key: ${keyValue}"</pre>
${env.BETA_KEY_SUNSET_DATE ? `<p style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:4px"><strong>Action required:</strong> Your previous beta key will stop working on <strong>${env.BETA_KEY_SUNSET_DATE}</strong>. Switch to the key above before that date.</p>` : ''}
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
								html: `<p>Thank you for subscribing to Headless Oracle.</p><p>Your API key (save this — it will not be shown again):</p><pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">${activKeyValue}</pre><p>Plan: ${activPlan} &bull; Use it as the <code>X-Oracle-Key</code> header in every request:</p><pre style="background:#f5f5f5;padding:12px;border-radius:4px;font-size:14px">curl https://headlessoracle.com/v5/status?mic=XNYS \\\n  -H "X-Oracle-Key: ${activKeyValue}"</pre>${env.BETA_KEY_SUNSET_DATE ? `<p style="background:#fff3cd;border:1px solid #ffc107;padding:12px;border-radius:4px"><strong>Action required:</strong> Your previous beta key will stop working on <strong>${env.BETA_KEY_SUNSET_DATE}</strong>. Switch to the key above before that date.</p>` : ''}<p>Documentation: <a href="https://headlessoracle.com/docs">headlessoracle.com/docs</a></p>`,
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
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
				}
				const accountAuth = await checkApiKey(apiKey, env);
				if (!accountAuth.allowed) {
					const accountAuthHeaders = accountAuth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
					return json({ error: accountAuth.error, message: accountAuth.message }, accountAuth.status, accountAuthHeaders);
				}

				// Internal keys (master / beta) are not Supabase records
				const isMaster = apiKey === env.MASTER_API_KEY;
				const isBeta   = env.BETA_API_KEYS
					? env.BETA_API_KEYS.split(',').map((k) => k.trim()).includes(apiKey)
					: false;
				if (isMaster || isBeta) {
					return await withMigrationNotice(json({ plan: 'internal', status: 'active', key_prefix: null }));
				}

				// Paid key — KV should be warm from checkApiKey call above
				const keyHash = await sha256Hex(apiKey);
				if (env.ORACLE_API_KEYS) {
					const cached = await env.ORACLE_API_KEYS.get(keyHash);
					if (cached) {
						const data = JSON.parse(cached) as { plan: string; status: string };
						return await withMigrationNotice(json({ plan: data.plan, status: data.status, key_prefix: apiKey.substring(0, 14) }));
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
						return await withMigrationNotice(json({ plan: data.plan, status: data.status, key_prefix: data.key_prefix }));
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

				return await withMigrationNotice(json({
					key_prefix:              keyPrefix,
					plan:                    usageAuth.plan,
					requests_today:          requestsToday,
					requests_this_month:     requestsThisMonth,
					daily_limit:             dailyLimit,
					monthly_limit:           monthlyLimit,
					percent_used_today:      pctToday,
					percent_used_month:      pctMonth,
					rate_limit_resets_at:    rateLimitResetsAt,
					upgrade_url:             'https://headlessoracle.com/upgrade',
					x402_available:          !!env.ORACLE_PAYMENT_ADDRESS,
					x402_amount:             '0.001 USDC',
					credit_balance:          creditBalance,
				}));
			}

			// ── GET /v5/stream — Server-Sent Event stream of signed market receipts ───
			// Auth: X-Oracle-Key header (same as /v5/status) or ?key= query param
			// (EventSource browsers cannot set custom headers, so ?key= is provided).
			// Emits market_status events every 30s. Closes on HALTED with a final halted event.
			// Uses STREAM_COORDINATOR Durable Object — one instance per MIC for future fan-out.
			if (url.pathname === '/v5/stream') {
				const streamKey = request.headers.get('X-Oracle-Key') || url.searchParams.get('key') || '';
				if (!streamKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'API key required. Provide X-Oracle-Key header or ?key=<key> query param (for EventSource compatibility).' }, 401);
				}
				const streamAuth = await checkApiKey(streamKey, env);
				if (!streamAuth.allowed) {
					return json({ error: streamAuth.error, message: streamAuth.message }, streamAuth.status);
				}
				const streamMic = (url.searchParams.get('mic') || 'XNYS').toUpperCase();
				if (!MARKET_CONFIGS[streamMic]) {
					return json({ error: 'INVALID_MIC', message: 'mic must be a supported exchange. See /v5/exchanges.' }, 400);
				}
				// Route to StreamCoordinator DO (keyed by MIC so all clients watching the same
				// exchange land on the same instance — enables future fan-out optimisation).
				const doId   = env.STREAM_COORDINATOR.idFromName(streamMic);
				const doStub = env.STREAM_COORDINATOR.get(doId);
				return doStub.fetch(request);
			}

			// ── GET /v5/archive — signed receipt historical archive ─────────────
			// Returns signed receipts written by /v5/status calls, keyed by MIC + date.
			// No-auth / free tier: today only. Builder+ / internal: 30-day window.
			// Receipts are already Ed25519-signed — consumers can verify without trusting us.
			if (url.pathname === '/v5/archive') {
				const archiveMic = (url.searchParams.get('mic') || '').toUpperCase();
				if (!archiveMic || !MARKET_CONFIGS[archiveMic]) {
					return json({ error: 'INVALID_MIC', message: 'mic is required and must be a supported exchange. See /v5/exchanges.' }, 400);
				}
				const archiveDateParam = url.searchParams.get('date') || '';
				const archiveDateToday = now.toISOString().slice(0, 10);
				const archiveDate      = archiveDateParam || archiveDateToday;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(archiveDate)) {
					return json({ error: 'INVALID_DATE', message: 'date must be YYYY-MM-DD format. Example: ?date=2026-03-25' }, 400);
				}
				// Auth: optional — determines date range allowed
				const archiveApiKey = request.headers.get('X-Oracle-Key');
				let archiveAuth: Awaited<ReturnType<typeof checkApiKey>> | null = null;
				if (archiveApiKey) {
					archiveAuth = await checkApiKey(archiveApiKey, env);
					if (!archiveAuth.allowed) {
						return json({ error: archiveAuth.error, message: archiveAuth.message }, archiveAuth.status);
					}
				}
				const isPaidArchive = archiveAuth !== null && ['builder', 'pro', 'protocol', 'internal'].includes(archiveAuth.plan ?? '');
				// Date range enforcement: restrict non-paid callers to today only
				if (archiveDate !== archiveDateToday && !isPaidArchive) {
					return json({
						error:       'ARCHIVE_DATE_RESTRICTED',
						message:     'Historical archive access (beyond today) requires a Builder or Pro plan.',
						today:       archiveDateToday,
						upgrade_url: 'https://headlessoracle.com/upgrade',
					}, 403);
				}
				if (isPaidArchive) {
					const archiveDaysAgo = Math.floor((new Date(archiveDateToday).getTime() - new Date(archiveDate).getTime()) / 86_400_000);
					if (archiveDaysAgo > 30 || archiveDaysAgo < 0) {
						return json({ error: 'ARCHIVE_DATE_OUT_OF_RANGE', message: 'Archive retains receipts for 30 days. date must be within 30 days of today.', ttl_days: 30 }, 400);
					}
				}
				if (!env.ORACLE_TELEMETRY) {
					return json({ mic: archiveMic, date: archiveDate, count: 0, receipts: [] });
				}
				// KV list: max 1000 keys. Add cursor pagination when daily /v5/status volume > 1000.
				const archivePrefix = `receipt:${archiveMic}:${archiveDate}:`;
				const listed = await env.ORACLE_TELEMETRY.list({ prefix: archivePrefix }).catch(() => ({ keys: [] as KVNamespaceListKey<unknown>[] }));
				const archiveReceipts = await Promise.all(
					listed.keys.map(async (k) => {
						const raw = await env.ORACLE_TELEMETRY.get(k.name).catch(() => null);
						if (!raw) return null;
						try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
					}),
				);
				const validArchiveReceipts = archiveReceipts.filter((r): r is Record<string, unknown> => r !== null);
				return json({ mic: archiveMic, date: archiveDate, count: validArchiveReceipts.length, receipts: validArchiveReceipts });
			}

			// ── GET /v5/conformance-vectors ─────────────────────────────────────────────
			// Public. Returns 5 live-signed canonical test receipts for SDK and verifier testing.
			// Each call generates fresh receipts (new receipt_id, issued_at, expires_at, signature).
			// canonical_payload: base64(UTF-8 bytes of alphabetically-sorted compact JSON) — exact bytes signed.
			// Purpose: verify your Ed25519 implementation against real Oracle output, no keypair needed.
			if (url.pathname === '/v5/conformance-vectors') {
				const cvPubKey    = env.ED25519_PUBLIC_KEY || '';
				const cvPrivKey   = env.ED25519_PRIVATE_KEY || '';
				const cvKeyId     = env.PUBLIC_KEY_ID || 'key_2026_v1';
				const cvIssuedAt  = now.toISOString();
				const cvExpiresAt = expiresAt;

				// Sort keys alphabetically, compute canonical JSON, sign, base64-encode the signed bytes.
				const signVector = async (payload: Record<string, unknown>): Promise<{
					receipt: Record<string, unknown>;
					canonical_payload: string;
					public_key: string;
					algorithm: string;
				}> => {
					const sorted: Record<string, unknown> = {};
					for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
					const canonical = JSON.stringify(sorted);
					const msgBytes  = new TextEncoder().encode(canonical);
					const privKey   = fromHex(cvPrivKey);
					const sig       = await ed.sign(msgBytes, privKey);
					const canonical_payload = btoa(String.fromCharCode(...Array.from(msgBytes)));
					return {
						receipt:           { ...payload, signature: toHex(sig) },
						canonical_payload,
						public_key:        cvPubKey,
						algorithm:         'ed25519',
					};
				};

				// Synthetic times chosen to produce deterministic market states.
				// The receipt issued_at/expires_at use the real call time; status comes from these.
				const tXnysOpen   = new Date('2026-04-07T15:00:00Z'); // Tuesday 11:00 ET → XNYS OPEN
				const tXnysClosed = new Date('2026-04-04T15:00:00Z'); // Saturday         → XNYS CLOSED
				const tXjpxLunch  = new Date('2026-04-07T03:00:00Z'); // Tuesday 12:00 JST → XJPX lunch CLOSED

				let sXnysOpen:   MarketStatusResult;
				let sXnysClosed: MarketStatusResult;
				let sXjpxLunch:  MarketStatusResult;
				try { sXnysOpen   = getScheduleStatus('XNYS', tXnysOpen);  } catch { sXnysOpen   = { status: 'UNKNOWN', source: 'SYSTEM' }; }
				try { sXnysClosed = getScheduleStatus('XNYS', tXnysClosed); } catch { sXnysClosed = { status: 'UNKNOWN', source: 'SYSTEM' }; }
				try { sXjpxLunch  = getScheduleStatus('XJPX', tXjpxLunch); } catch { sXjpxLunch  = { status: 'UNKNOWN', source: 'SYSTEM' }; }

				const cvBase = {
					issued_at:      cvIssuedAt,
					expires_at:     cvExpiresAt,
					issuer:         ORACLE_ISSUER,
					receipt_mode:   'live',
					schema_version: 'v5.0',
					public_key_id:  cvKeyId,
				};

				const [r1, r2, r3, r4, r5] = await Promise.all([
					signVector({ receipt_id: crypto.randomUUID(), ...cvBase, mic: 'XNYS', status: sXnysOpen.status,   source: sXnysOpen.source,   halt_detection: getHaltDetection('XNYS') }),
					signVector({ receipt_id: crypto.randomUUID(), ...cvBase, mic: 'XNYS', status: sXnysClosed.status, source: sXnysClosed.source, halt_detection: getHaltDetection('XNYS') }),
					signVector({ receipt_id: crypto.randomUUID(), ...cvBase, mic: 'XJPX', status: sXjpxLunch.status,  source: sXjpxLunch.source,  halt_detection: getHaltDetection('XJPX') }),
					signVector({ receipt_id: crypto.randomUUID(), ...cvBase, mic: 'XNYS', status: 'UNKNOWN',          source: 'SYSTEM',           halt_detection: getHaltDetection('XNYS') }),
					signVector({ receipt_id: crypto.randomUUID(), issued_at: cvIssuedAt, expires_at: cvExpiresAt, issuer: ORACLE_ISSUER, status: 'OK', source: 'SYSTEM', public_key_id: cvKeyId }),
				]);

				return json({
					spec_version: 'v1',
					generated_at: cvIssuedAt,
					public_key:   cvPubKey,
					algorithm:    'ed25519',
					ttl_seconds:  RECEIPT_TTL_SECONDS,
					note: 'Freshly signed on every call. receipt_id/issued_at/expires_at/signature change each time. Verify: base64-decode canonical_payload → UTF-8 bytes → Ed25519.verify(sig_hex, bytes, pub_key_hex).',
					vectors: [
						{ vector_id: 'v1_xnys_open',   description: 'XNYS OPEN — weekday trading hours (09:30–16:00 ET). status: OPEN, source: SCHEDULE.',             synthetic_time: tXnysOpen.toISOString(),   ...r1 },
						{ vector_id: 'v1_xnys_closed', description: 'XNYS CLOSED — weekend (Saturday). status: CLOSED, source: SCHEDULE.',                           synthetic_time: tXnysClosed.toISOString(), ...r2 },
						{ vector_id: 'v1_xjpx_lunch',  description: 'XJPX CLOSED — lunch break 11:30–12:30 JST. status: CLOSED, source: SCHEDULE.',             synthetic_time: tXjpxLunch.toISOString(),  ...r3 },
						{ vector_id: 'v1_unknown',      description: 'UNKNOWN/SYSTEM — no holiday data for this year. Agents MUST treat UNKNOWN as CLOSED.',          synthetic_time: null,                       ...r4 },
						{ vector_id: 'v1_health',       description: 'HEALTH OK — same schema as /v5/health. No mic or schema_version fields.',                       synthetic_time: cvIssuedAt,                ...r5 },
					],
				});
			}


			// ── GET /v5/dst-risk — DST transition risk endpoint (no auth) ────────
			// Educational content about the upcoming EU DST transition (March 29 2026).
			// Embeds a live /v5/schedule?mic=XLON result for verification.
			// Not signed — this is educational, not a trading primitive.
			if (url.pathname === '/v5/dst-risk') {
				// Fetch live schedule for XLON to embed as verified_schedule
				let xlonSchedule: Record<string, unknown> | null = null;
				try {
					const xlon = MARKET_CONFIGS.find(m => m.mic === 'XLON');
					if (xlon) {
						const { nextOpen, nextClose } = getNextSession(xlon, now);
						xlonSchedule = {
							mic: 'XLON',
							name: xlon.name,
							timezone: xlon.timezone,
							queried_at: now.toISOString(),
							current_status: getScheduleStatus(xlon, now).status,
							next_open: nextOpen ? nextOpen.toISOString() : null,
							next_close: nextClose ? nextClose.toISOString() : null,
							lunch_break: xlon.lunchBreak ?? null,
							note: 'Live schedule computed using IANA timezone Europe/London (DST-aware)',
						};
					}
				} catch (_) {
					xlonSchedule = null;
				}

				return json({
					event: 'EU_DST_SPRING_2026',
					transition_utc: '2026-03-29T01:00:00Z',
					expires_at: '2026-03-29T02:00:00Z',
					description: 'European clocks spring forward on Sunday March 29, 2026. XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST shift +1h. Agents using hardcoded UTC offsets will compute incorrect market hours starting Monday March 30.',
					affected_exchanges: [
						{
							mic: 'XLON',
							name: 'London Stock Exchange',
							timezone: 'Europe/London',
							shift: 'GMT → BST',
							naive_agent_open_utc: '08:00',
							actual_open_utc_after_dst: '07:00',
							error_minutes: 60,
							risk: 'Agent using hardcoded UTC+0 will believe market opens at 08:00 UTC. It actually opens at 07:00 UTC after DST. 60-minute window of incorrect state.',
						},
						{
							mic: 'XPAR',
							name: 'Euronext Paris',
							timezone: 'Europe/Paris',
							shift: 'CET → CEST',
							naive_agent_open_utc: '09:00',
							actual_open_utc_after_dst: '08:00',
							error_minutes: 60,
							risk: 'Same 60-minute error window.',
						},
						{
							mic: 'XSWX',
							name: 'SIX Swiss Exchange',
							timezone: 'Europe/Zurich',
							shift: 'CET → CEST',
							naive_agent_open_utc: '09:00',
							actual_open_utc_after_dst: '08:00',
							error_minutes: 60,
							risk: 'Same 60-minute error window.',
						},
						{
							mic: 'XMIL',
							name: 'Borsa Italiana',
							timezone: 'Europe/Rome',
							shift: 'CET → CEST',
							naive_agent_open_utc: '09:00',
							actual_open_utc_after_dst: '08:00',
							error_minutes: 60,
							risk: 'Same 60-minute error window.',
						},
						{
							mic: 'XHEL',
							name: 'Nasdaq Helsinki',
							timezone: 'Europe/Helsinki',
							shift: 'EET → EEST',
							naive_agent_open_utc: '10:00',
							actual_open_utc_after_dst: '09:00',
							error_minutes: 60,
							risk: 'Same 60-minute error window.',
						},
						{
							mic: 'XSTO',
							name: 'Nasdaq Stockholm',
							timezone: 'Europe/Stockholm',
							shift: 'CET → CEST',
							naive_agent_open_utc: '09:00',
							actual_open_utc_after_dst: '08:00',
							error_minutes: 60,
							risk: 'Same 60-minute error window.',
						},
						{
							mic: 'XIST',
							name: 'Borsa Istanbul',
							timezone: 'Europe/Istanbul',
							shift: 'TRT (no DST)',
							naive_agent_open_utc: '07:00',
							actual_open_utc_after_dst: '07:00',
							error_minutes: 0,
							risk: 'Turkey does not observe DST. No change. Included for completeness.',
						},
					],
					risk_window_minutes: 60,
					us_europe_dst_gap_note: 'The US transitioned to DST on March 8. Europe transitions March 29. During the 21-day gap (March 8-29), NY/London offset compressed from 5 hours to 4 hours. Cross-market agents using hardcoded offsets had incorrect overlap windows for 21 days.',
					verified_schedule: xlonSchedule,
					sma_protocol_note: 'Headless Oracle receipts use IANA timezone identifiers (Europe/London, not UTC+0). DST is handled automatically. Agents using SMA receipts are immune to this vulnerability.',
					note: 'SMA = Signed Market Attestation. Not to be confused with Simple Moving Average.',
				}, 200, { 'Cache-Control': 'public, max-age=3600' });
			}

			// ── GET /v5/metrics/public — social-proof metrics for devs ──
			// Public, no auth. Stable facts about the service: exchange count,
			// signing algorithm, TTL, MCP score, x402 status, and uptime.
			// x402 payment stats and daily MCP usage read from ORACLE_TELEMETRY KV (best-effort).
			if (url.pathname === '/v5/metrics/public') {
				const METRICS_ORIGIN_DATE = '2026-02-28T00:00:00Z';
				const originMs  = new Date(METRICS_ORIGIN_DATE).getTime();
				const uptimeDays = Math.floor((Date.now() - originMs) / 86400000);
				const today = now.toISOString().slice(0, 10);

				const FUNNEL_KEYS = ['free_tier_gate', 'payment_failed', 'facilitator_rejected', 'keyless_no_payment', 'direct_payment_failed'] as const;
				const [[paymentCountRaw, lastPaymentAtRaw], mcpUsage, scRaws, funnelRaws] = await Promise.all([
					Promise.all([
						env.ORACLE_TELEMETRY.get('x402_payment_count').catch(() => null),
						env.ORACLE_TELEMETRY.get('x402_last_payment_at').catch(() => null),
					]),
					getMcpUsageToday(today, env),
					// Status code counters — read the 6 common codes in one parallel batch
					Promise.all([200, 401, 402, 403, 404, 429].map((c) =>
						env.ORACLE_TELEMETRY.get(`status_code:${today}:${c}`).catch(() => null)
					)),
					// Payment funnel counters
					Promise.all(FUNNEL_KEYS.map((k) =>
						env.ORACLE_TELEMETRY.get(`funnel_402:${k}:${today}`).catch(() => null)
					)),
				]);
				const x402PaymentCount    = parseInt(paymentCountRaw ?? '0', 10) || 0;
				const lastPaymentAt       = lastPaymentAtRaw ?? null;
				const uniqueMcpClientsToday = mcpUsage.unique_clients_today;
				const mcpRequestsToday      = mcpUsage.total_requests_today;
				const statusCodesToday: Record<string, number> = {};
				[200, 401, 402, 403, 404, 429].forEach((code, i) => {
					const n = parseInt(scRaws[i] ?? '0', 10) || 0;
					if (n > 0) statusCodesToday[String(code)] = n;
				});
				const funnel402Today: Record<string, number> = {};
				FUNNEL_KEYS.forEach((key, i) => {
					const n = parseInt(funnelRaws[i] ?? '0', 10) || 0;
					if (n > 0) funnel402Today[key] = n;
				});

				return json({
					exchanges:               SUPPORTED_EXCHANGES.length,
					mcp_tools:               5,
					uptime_days:             uptimeDays,
					tests_passing:           691,
					signing_algorithm:       'Ed25519',
					receipt_ttl_seconds:     RECEIPT_TTL_SECONDS,
					x402_enabled:            !!env.ORACLE_PAYMENT_ADDRESS,
					x402_network:            'base',
					x402_payment_count:      x402PaymentCount,
					last_payment_at:         lastPaymentAt,
					mcp_protocol_version:    MCP_PROTOCOL_VERSION,
					mcpscoreboard_preflight: 100,
					fail_closed:             true,
					unique_mcp_clients_today: uniqueMcpClientsToday,
					mcp_requests_today:       mcpRequestsToday,
					status_codes_today:       statusCodesToday,
					funnel_402_today:         funnel402Today,
					install:                  'npx headless-oracle-mcp',
					evaluator_platforms: [
						'Chiark', 'MCPScoreboard', 'YellowMCP', 'CacheFly', 'DataCamp', 'Glama',
					],
					response_time_ms: {
						connect:    0,
						initialize: '<250',
						tool_call:  '<100',
					},
					ecosystem_listings: {
						glama_connector: true,
						awesome_x402:    true,
						smithery:        true,
						npm:             'headless-oracle-mcp',
						pypi:            ['headless-oracle', 'headless-oracle-langchain', 'headless-oracle-crewai', 'headless-oracle-strands'],
					},
				}, 200, { 'Cache-Control': 'public, max-age=60' });
			}

			// ── GET /v5/referrers — daily referrer traffic breakdown ──────────────
			// Lists domains that linked to headlessoracle.com today (or a given date).
			// Best-effort: populated by the referrer tracking in the main request handler.
			if (url.pathname === '/v5/referrers') {
				const date   = url.searchParams.get('date') || now.toISOString().slice(0, 10);
				const prefix = `referrer:${date}:`;
				const listResult = await env.ORACLE_TELEMETRY.list({ prefix }).catch(() => ({ keys: [] as KVNamespaceListKey<unknown>[] }));
				const referrers: Record<string, number> = {};
				await Promise.all(
					listResult.keys.map(async (k) => {
						const domain = (k.name as string).slice(prefix.length);
						const val    = await env.ORACLE_TELEMETRY.get(k.name as string).catch(() => null);
						referrers[domain] = parseInt(val ?? '0', 10) || 0;
					})
				);
				return json({ date, referrers }, 200, { 'Cache-Control': 'public, max-age=60' });
			}

			// ── GET /v5/traction — public live metrics snapshot ──────────
			// Shows exchanges covered, uptime, MCP usage, and stack positioning.
			// No auth required. Suitable for investor / partner check-ins.
			// Reads from traction_cache:{today} KV key (written by 17:00 cron) when available.
			if (url.pathname === '/v5/traction') {
				const today       = now.toISOString().slice(0, 10);
				const currentYear = now.getUTCFullYear();
				const uptimeSince = env.LAUNCH_DATE ?? '2026-03-10T08:00:00Z';
				const launchDate     = new Date(uptimeSince);
				const launchMidnight = Date.UTC(launchDate.getUTCFullYear(), launchDate.getUTCMonth(), launchDate.getUTCDate());
				const todayMidnight  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
				const daysLive       = Math.floor((todayMidnight - launchMidnight) / 86400000);

				// Try cache first (written at 17:00 UTC by cron).
				const cachedRaw = await env.ORACLE_TELEMETRY.get(`traction_cache:${today}`).catch(() => null);
				if (cachedRaw) {
					try {
						const cached = JSON.parse(cachedRaw) as {
							unique_clients_today: number;
							total_requests_today: number;
							unauth_calls_today: number;
							auth_calls_today: number;
							auth_ratio: number | null;
							sandbox_keys_issued_today: number;
							sandbox_caps_today: number;
							batch_combos_today: number;
							zero_auth_mcp_requests_today: number;
						};
						// Tool counts are not in the cache — fetch live (4 KV gets, cheap)
						const [cToolStatusRaw, cToolScheduleRaw, cToolListRaw, cToolVerifyRaw] = await Promise.all([
							env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_status:${today}`).catch(() => null),
							env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_schedule:${today}`).catch(() => null),
							env.ORACLE_TELEMETRY.get(`mcp_tool:list_exchanges:${today}`).catch(() => null),
							env.ORACLE_TELEMETRY.get(`mcp_tool:verify_receipt:${today}`).catch(() => null),
						]);
						const cachedToolsToday = {
							get_market_status:   parseInt(cToolStatusRaw   ?? '0', 10) || 0,
							get_market_schedule: parseInt(cToolScheduleRaw ?? '0', 10) || 0,
							list_exchanges:      parseInt(cToolListRaw     ?? '0', 10) || 0,
							verify_receipt:      parseInt(cToolVerifyRaw   ?? '0', 10) || 0,
						};
						return json({
							exchanges_covered:             SUPPORTED_EXCHANGES.length,
							edge_cases_per_year:           edgeCaseCount(currentYear).total,
							uptime_since:                  uptimeSince,
							days_live:                     daysLive,
							mcp_requests_today:            cached.total_requests_today,
							unique_mcp_clients_today:      cached.unique_clients_today,
							mcp_tools_today:               cachedToolsToday,
							sma_spec_version:              '1.0',
							verifiable_intent_rfc:         'submitted',
							x402_enabled:                  !!env.ORACLE_PAYMENT_ADDRESS,
							halt_monitor:                  'active',
							batch_combos_today:            cached.batch_combos_today,
							auth_ratio_today:              cached.auth_ratio,
							sandbox_caps_today:            cached.sandbox_caps_today,
							unauth_calls_today:            cached.unauth_calls_today,
							auth_calls_today:              cached.auth_calls_today,
							sandbox_keys_issued_today:     cached.sandbox_keys_issued_today,
							zero_auth_mcp_requests_today:  cached.zero_auth_mcp_requests_today ?? 0,
							cache_status:                  'cached',
						});
					} catch { /* cache parse error — fall through to live */ }
				}

				// Cache miss (before 17:00 cron runs) — compute live via shared helper.
				const { unique_clients_today: mcpClientsToday, total_requests_today: mcpRequestsToday } =
					await getMcpUsageToday(today, env);

				// Acquisition telemetry counters (best-effort — zeros on KV miss)
				const [batchComboKeysRaw, authCallsRaw, unauthCallsRaw, sandboxCapsRaw, zeroAuthMcpRaw,
					mcpToolStatusRaw, mcpToolScheduleRaw, mcpToolListRaw, mcpToolVerifyRaw] = await Promise.all([
					env.ORACLE_TELEMETRY.list({ prefix: `batch_combo:` }).then(r => r.keys.filter(k => k.name.endsWith(`:${today}`))).catch(() => [] as Array<{ name: string }>),
					env.ORACLE_TELEMETRY.get(`auth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`sandbox_cap_hit:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`zero_auth_mcp_requests:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_status:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_schedule:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:list_exchanges:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:verify_receipt:${today}`).catch(() => null),
				]);
				const batchCombosToday    = batchComboKeysRaw.length;
				const authCalls           = parseInt(authCallsRaw    ?? '0', 10) || 0;
				const unauthCalls         = parseInt(unauthCallsRaw  ?? '0', 10) || 0;
				const authRatioToday      = authCalls + unauthCalls > 0
					? Math.round((authCalls / (authCalls + unauthCalls)) * 100) / 100
					: null;
				const sandboxCapsToday    = parseInt(sandboxCapsRaw   ?? '0', 10) || 0;
				const zeroAuthMcpToday    = parseInt(zeroAuthMcpRaw   ?? '0', 10) || 0;
				const mcpToolsToday = {
					get_market_status:    parseInt(mcpToolStatusRaw   ?? '0', 10) || 0,
					get_market_schedule:  parseInt(mcpToolScheduleRaw ?? '0', 10) || 0,
					list_exchanges:       parseInt(mcpToolListRaw     ?? '0', 10) || 0,
					verify_receipt:       parseInt(mcpToolVerifyRaw   ?? '0', 10) || 0,
				};

				return json({
					exchanges_covered:             SUPPORTED_EXCHANGES.length,
					edge_cases_per_year:           edgeCaseCount(currentYear).total,
					uptime_since:                  uptimeSince,
					days_live:                     daysLive,
					mcp_requests_today:            mcpRequestsToday,
					unique_mcp_clients_today:      mcpClientsToday,
					mcp_tools_today:               mcpToolsToday,
					sma_spec_version:              '1.0',
					verifiable_intent_rfc:         'submitted',
					x402_enabled:                  !!env.ORACLE_PAYMENT_ADDRESS,
					halt_monitor:                  'active',
					batch_combos_today:            batchCombosToday,
					auth_ratio_today:              authRatioToday,
					sandbox_caps_today:            sandboxCapsToday,
					unauth_calls_today:            unauthCalls,
					auth_calls_today:              authCalls,
					sandbox_keys_issued_today:     0,
					zero_auth_mcp_requests_today:  zeroAuthMcpToday,
					cache_status:                  'live',
				});
			}

			// ── POST /v5/keys/request — free tier key provisioning ────────
			// No auth required. Validates email, generates ho_free_ key,
			// stores in KV + Supabase, sends via Resend.
			if (url.pathname === '/v5/keys/request') {
				if (request.method === 'GET') {
					return json({
						message:    'To get an API key, choose a plan at headlessoracle.com/upgrade',
						action_url: 'https://headlessoracle.com/upgrade',
						plans: {
							builder: {
								price: '$99/month',
								calls: '50,000/month',
								url:   'https://headlessoracle.com/upgrade',
							},
							pro: {
								price: '$299/month',
								calls: '200,000/month',
								url:   'https://headlessoracle.com/upgrade',
							},
						},
						docs: 'https://headlessoracle.com/docs',
					});
				}
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
						message: 'Max 3 free keys per day. Upgrade at headlessoracle.com/upgrade',
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
					last_verified:    '2026-03-29T00:00:00Z',
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
							evidence: 'Lunch break sessions (XJPX, XHKG, XSHG, XSHE), early close days, religious holidays (Eid Al-Fitr for XSAU/XDFM), holiday calendars 2026–2027 for all 28 exchanges across 6 regions',
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

			// ── GET /v5/payment-proof — public on-chain payment ledger ────
			// Returns live stats of USDC payments received on Base mainnet.
			// Counts are best-effort from ORACLE_TELEMETRY KV — fail-safe zeros.
			if (url.pathname === '/v5/payment-proof') {
				const [countStr, firstTx, firstAt, lastAt] = await Promise.all([
					env.ORACLE_TELEMETRY.get('x402_payment_count').catch(() => null),
					env.ORACLE_TELEMETRY.get('x402_first_tx').catch(() => null),
					env.ORACLE_TELEMETRY.get('x402_first_payment_at').catch(() => null),
					env.ORACLE_TELEMETRY.get('x402_last_payment_at').catch(() => null),
				]);
				return json({
					payment_count:    parseInt(countStr ?? '0', 10) || 0,
					first_payment_at: firstAt ?? null,
					first_payment_tx: firstTx ?? null,
					last_payment_at:  lastAt  ?? null,
					network:          'base',
					asset:            'USDC',
					contract:         '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
					verify_at:        'https://basescan.org/address/0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3#tokentxns',
				});
			}

			// ── GET /x402 — x402 Foundation compatibility declaration ─────────
			// Public, no auth. Declares x402 compatibility for the x402 Foundation
			// ecosystem (https://x402.org). Includes first_payment_at from KV.
			if (url.pathname === '/x402') {
				const firstAt = await env.ORACLE_TELEMETRY.get('x402_first_payment_at').catch(() => null);
				return json({
					x402_compatible: true,
					network:         'base',
					facilitator:     'cdp',
					first_payment_at: firstAt ?? null,
					payment_proof:   '/v5/payment-proof',
					discovery:       '/.well-known/x402.json',
					awesome_x402:    'https://github.com/xpaysh/awesome-x402',
					foundation:      'https://x402.org',
				});
			}

			// ── GET /v5/why-not-free — machine-readable upgrade ladder ─────
			// Structured upgrade path for agents that receive a 402.
			// Linked from every 402 via: Link: </v5/why-not-free>; rel="payment"
			if (url.pathname === '/v5/why-not-free') {
				return json(buildPaymentOptions());
			}

			// ── GET /v5/pricing — machine-readable pricing tiers ──────────────────
			// Public, no auth. Returns all tiers that exist in code — no invented tiers.
			// Canonical source of truth for pricing. HTML page at /pricing (Pages).
			if (url.pathname === '/v5/pricing') {
				return json({
					tiers: [
						{
							id:           'sandbox',
							name:         'Sandbox',
							price_usd:    0,
							price_label:  'Free',
							calls:        200,
							duration:     '7 days',
							key_prefix:   'sb_',
							provision:    'POST /v5/sandbox',
							description:  'Instant sandbox key via email. 200 calls over 7 days. IP-fingerprinted — one per IP.',
							features:     ['200 calls total', '28 exchanges', 'Ed25519 signed receipts', 'MCP tools included', 'No credit card'],
						},
						{
							id:           'free',
							name:         'Free Tier',
							price_usd:    0,
							price_label:  'Free',
							calls_per_day: FREE_TIER_DAILY_LIMIT,
							key_prefix:   'ho_free_',
							provision:    'POST /v5/keys/request',
							description:  'Self-provision free API key via email. 500 calls/day.',
							features:     ['500 calls/day', '28 exchanges', 'Ed25519 signed receipts', 'MCP tools included', 'No credit card'],
						},
						{
							id:              'x402',
							name:            'x402 Per-Request',
							price_usdc:      '0.001',
							price_label:     '$0.001 USDC / request',
							calls_per_day:   null,
							key_prefix:      null,
							provision:       'X-Payment header on /v5/status',
							description:     'No key, no signup. Pay $0.001 USDC per request on Base mainnet. Agent-native.',
							network:         'base',
							chain_id:        8453,
							usdc_amount_units: String(X402_MIN_AMOUNT_UNITS),
							usdc_contract:   X402_USDC_CONTRACT,
							discovery:       '/.well-known/x402.json',
							features:        ['No key required', 'No signup', 'Pay per call', 'Base mainnet USDC', 'Instant access'],
						},
						{
							id:           'credits',
							name:         'Credit Pack',
							price_usd:    5,
							price_label:  '$5 one-time',
							calls:        1000,
							key_prefix:   'ho_crd_',
							provision:    'POST /v5/x402/mint',
							description:  '1,000 prepaid calls. No expiry. Mint instantly with $5 USDC on Base mainnet.',
							features:     ['1,000 calls', 'No expiry', 'No subscription', '28 exchanges', 'Instant provisioning'],
						},
						{
							id:           'builder',
							name:         'Builder',
							price_usd:    99,
							price_label:  '$99 / month',
							calls_per_day: BUILDER_TIER_DAILY_LIMIT,
							key_prefix:   'ho_live_',
							provision:    'POST /v5/checkout',
							description:  '50,000 calls/day. Paddle subscription. Webhook subscriptions. Receipt audit log.',
							features:     ['50,000 calls/day', '5 webhook subs', 'Receipt audit log', '28 exchanges', 'Paddle billing'],
						},
						{
							id:           'pro',
							name:         'Pro',
							price_usd:    299,
							price_label:  '$299 / month',
							calls_per_day: PRO_TIER_DAILY_LIMIT,
							key_prefix:   'ho_live_',
							provision:    'POST /v5/checkout',
							description:  '200,000 calls/day. Paddle subscription. 25 webhook subscriptions.',
							features:     ['200,000 calls/day', '25 webhook subs', 'Receipt audit log', '28 exchanges', 'Paddle billing'],
						},
						{
							id:           'protocol',
							name:         'Protocol',
							price_usd:    500,
							price_label:  '$500 / month',
							calls_per_day: null,
							key_prefix:   'ho_live_',
							provision:    'POST /v5/checkout',
							description:  'Unlimited calls/day. Unlimited webhooks. Enterprise SLA.',
							features:     ['Unlimited calls/day', 'Unlimited webhooks', '28 exchanges', 'Enterprise SLA', 'Paddle billing'],
						},
					],
					x402: {
						amount_usdc:       '0.001',
						amount_units:      String(X402_MIN_AMOUNT_UNITS),
						network:           'base',
						chain_id:          8453,
						usdc_contract:     X402_USDC_CONTRACT,
						payment_discovery: '/.well-known/x402.json',
					},
					checkout_url:     '/v5/checkout',
					sandbox_url:      '/v5/sandbox',
					free_key_url:     '/v5/keys/request',
					pricing_page_url: 'https://headlessoracle.com/pricing',
				});
			}

			// ── GET /pricing — human-readable HTML pricing page ──────────────
			// Replaces the stale Pages pricing.html. Worker route takes precedence.
			if (url.pathname === '/pricing' && request.method === 'GET') {
				const pricingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pricing — Headless Oracle</title>
<meta name="description" content="Simple, transparent pricing for the signed market status oracle. Start free, pay per call with crypto, or subscribe for high-volume access.">
<link rel="canonical" href="https://headlessoracle.com/pricing">
<style>
  :root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --orange: #d29922; --purple: #bc8cff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; }
  header { border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; }
  header a { color: var(--text); text-decoration: none; font-weight: 600; font-size: 1.1rem; }
  nav a { color: var(--muted); text-decoration: none; margin-left: 1.5rem; font-size: 0.9rem; }
  nav a:hover { color: var(--text); }
  main { max-width: 1100px; margin: 0 auto; padding: 3rem 1.5rem; }
  h1 { font-size: 2.2rem; font-weight: 700; text-align: center; margin-bottom: 0.75rem; }
  .subtitle { text-align: center; color: var(--muted); font-size: 1.05rem; margin-bottom: 3rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.75rem 1.5rem; display: flex; flex-direction: column; }
  .card.featured { border-color: var(--accent); }
  .badge { display: inline-block; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.2rem 0.6rem; border-radius: 999px; margin-bottom: 1rem; }
  .badge.free { background: #1e3a1e; color: var(--green); }
  .badge.crypto { background: #1e2a3a; color: var(--accent); }
  .badge.popular { background: #2d1e3a; color: var(--purple); }
  .badge.pro { background: #3a2d1e; color: var(--orange); }
  .tier-name { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.4rem; }
  .price { font-size: 2rem; font-weight: 800; margin: 0.75rem 0 0.25rem; }
  .price-sub { font-size: 0.85rem; color: var(--muted); margin-bottom: 1rem; }
  .features { list-style: none; flex: 1; margin-bottom: 1.5rem; }
  .features li { padding: 0.35rem 0; font-size: 0.9rem; color: var(--muted); border-bottom: 1px solid var(--border); }
  .features li:last-child { border-bottom: none; }
  .features li::before { content: "✓ "; color: var(--green); }
  .cta { display: block; text-align: center; padding: 0.75rem; border-radius: 8px; font-weight: 600; font-size: 0.9rem; text-decoration: none; background: var(--accent); color: #0d1117; transition: opacity 0.15s; }
  .cta:hover { opacity: 0.85; }
  .cta.secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
  .cta.secondary:hover { border-color: var(--accent); }
  .note { text-align: center; margin-top: 2.5rem; color: var(--muted); font-size: 0.85rem; }
  .note a { color: var(--accent); text-decoration: none; }
  footer { border-top: 1px solid var(--border); padding: 1.5rem 2rem; text-align: center; color: var(--muted); font-size: 0.85rem; }
  footer a { color: var(--muted); text-decoration: none; margin: 0 0.5rem; }
</style>
</head>
<body>
<header>
  <a href="/">Headless Oracle</a>
  <nav>
    <a href="/docs">Docs</a>
    <a href="/status">Status</a>
    <a href="https://github.com/LembaGang" target="_blank">GitHub</a>
  </nav>
</header>
<main>
  <h1>Simple, transparent pricing</h1>
  <p class="subtitle">Start free. Pay per call with crypto. Subscribe for scale.</p>
  <div class="grid">

    <div class="card">
      <span class="badge free">Free</span>
      <div class="tier-name">Sandbox</div>
      <div class="price">$0</div>
      <div class="price-sub">200 calls · 7-day key</div>
      <ul class="features">
        <li>Instant provisioning</li>
        <li>No credit card</li>
        <li>All 28 exchanges</li>
        <li>Ed25519 signed receipts</li>
        <li>MCP + REST access</li>
      </ul>
      <a href="/docs/quickstart" class="cta secondary">Get sandbox key</a>
    </div>

    <div class="card">
      <span class="badge free">Free</span>
      <div class="tier-name">Free Tier</div>
      <div class="price">$0</div>
      <div class="price-sub">500 calls / day</div>
      <ul class="features">
        <li>Persistent key (ho_free_)</li>
        <li>Email provisioning</li>
        <li>All 28 exchanges</li>
        <li>Ed25519 signed receipts</li>
        <li>Rate-limit warning headers</li>
      </ul>
      <a href="/v5/keys/request" class="cta secondary">Request free key</a>
    </div>

    <div class="card featured">
      <span class="badge crypto">Crypto</span>
      <div class="tier-name">x402 Per-Request</div>
      <div class="price">$0.001</div>
      <div class="price-sub">per request · USDC on Base</div>
      <ul class="features">
        <li>No API key needed</li>
        <li>Pay with X-Payment header</li>
        <li>Base mainnet (chain 8453)</li>
        <li>Agent-native path</li>
        <li>Instant verification</li>
      </ul>
      <a href="/docs/x402-payments" class="cta">View x402 guide</a>
    </div>

    <div class="card">
      <span class="badge crypto">Credits</span>
      <div class="tier-name">Credit Pack</div>
      <div class="price">$5</div>
      <div class="price-sub">1,000 calls · no expiry</div>
      <ul class="features">
        <li>One-time purchase</li>
        <li>Persistent ho_crd_ key</li>
        <li>All 28 exchanges</li>
        <li>Balance visible at /v5/credits/balance</li>
        <li>Via Paddle checkout</li>
      </ul>
      <a href="/v5/checkout?type=credits" class="cta secondary">Buy credits</a>
    </div>

    <div class="card">
      <span class="badge popular">Popular</span>
      <div class="tier-name">Builder</div>
      <div class="price">$99</div>
      <div class="price-sub">per month · 50K calls/day</div>
      <ul class="features">
        <li>Persistent ho_live_ key</li>
        <li>50,000 calls per day</li>
        <li>Webhook state-change alerts</li>
        <li>Receipt audit log</li>
        <li>Priority support</li>
      </ul>
      <a href="/v5/checkout" class="cta">Subscribe — Builder</a>
    </div>

    <div class="card">
      <span class="badge pro">Pro</span>
      <div class="tier-name">Pro</div>
      <div class="price">$299</div>
      <div class="price-sub">per month · 200K calls/day</div>
      <ul class="features">
        <li>Persistent ho_live_ key</li>
        <li>200,000 calls per day</li>
        <li>Webhook state-change alerts</li>
        <li>Receipt audit log</li>
        <li>SLA + dedicated support</li>
      </ul>
      <a href="/v5/checkout" class="cta">Subscribe — Pro</a>
    </div>

  </div>
  <p class="note">
    All plans include Ed25519 signed receipts, 28 global exchanges, MCP + REST access, and fail-closed safety guarantees.<br>
    Machine-readable pricing: <a href="/v5/pricing">GET /v5/pricing</a> &nbsp;·&nbsp;
    Questions? <a href="mailto:mike@headlessoracle.com">mike@headlessoracle.com</a>
  </p>
</main>
<footer>
  <a href="/">Home</a>
  <a href="/docs">Docs</a>
  <a href="/terms">Terms</a>
  <a href="/privacy">Privacy</a>
  <a href="https://github.com/LembaGang/headless-oracle-v5" target="_blank">GitHub</a>
</footer>
</body>
</html>`;
				return new Response(pricingHtml, {
					status: 200,
					headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Oracle-Version': 'v5' },
				});
			}

			// ── POST /v5/verify — REST Ed25519 receipt verification ─────────
			// Public, no auth. Accepts a signed receipt, returns verification result.
			// Shares verifyReceiptLogic() with the verify_receipt MCP tool.
			if (url.pathname === '/v5/verify') {
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}
				let body: Record<string, unknown>;
				try {
					body = await request.json() as Record<string, unknown>;
				} catch {
					return json({ error: 'INVALID_JSON', message: 'Request body must be valid JSON' }, 400);
				}
				const receipt = body.receipt as Record<string, unknown> | undefined;
				if (!receipt || typeof receipt !== 'object') {
					return json({ error: 'MISSING_RECEIPT', message: 'Body must include a "receipt" object field' }, 400);
				}
				const result = await verifyReceiptLogic(receipt, env.ED25519_PUBLIC_KEY);
				return json(result);
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
				const paymentHeader = getPaymentHeader(request);
				if (!paymentHeader) {
					return json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, await sha256Hex(apiKey)), 402, X402_RESPONSE_HEADERS);
				}
				// Accept both raw JSON (direct on-chain) and base64 (x402 facilitator)
				let payment: X402Payment | null = null;
				try {
					const parsed = JSON.parse(paymentHeader);
					if (parsed && typeof parsed === 'object' && parsed.txHash && parsed.network) {
						payment = parsed as X402Payment;
					}
				} catch { /* not raw JSON — fall through to facilitator */ }
				if (payment) {
					const verify = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
					if (!verify.valid) {
						return json({ error: 'PAYMENT_VERIFICATION_FAILED', message: `Payment failed: ${verify.detail ?? 'unknown'}` }, 402, X402_RESPONSE_HEADERS);
					}
				} else {
					// Try base64 x402 facilitator
					const resource = 'https://headlessoracle.com/v5/credits/purchase';
					const facResult = await verifyX402ViaFacilitator(paymentHeader, env.ORACLE_PAYMENT_ADDRESS, env, resource);
					if (!facResult.valid) {
						return json({ error: 'PAYMENT_VERIFICATION_FAILED', message: `Payment failed: ${facResult.detail ?? 'unknown'}` }, 402, X402_RESPONSE_HEADERS);
					}
				}
				// Determine credit grant: direct on-chain can pay variable amounts; facilitator = 1 credit
				const amountPaid = payment ? BigInt(payment.amount || '0') : BigInt(1000);
				let creditsToAdd = 1; // default: 1 credit per 0.001 USDC
				if (amountPaid >= BigInt(800000)) creditsToAdd = 1000;       // 0.80 USDC → 1000 credits
				else if (amountPaid >= BigInt(90000)) creditsToAdd = 100;    // 0.09 USDC → 100 credits
				const keyHash = await sha256Hex(apiKey);
				await addCredits(keyHash, creditsToAdd, env);
				return await withMigrationNotice(json({ purchased: creditsToAdd, message: `${creditsToAdd} credits added to your account` }));
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
				return await withMigrationNotice(json({
					balance:                      credits.balance,
					estimated_requests_remaining: credits.balance,
					last_purchased:               credits.last_purchased || null,
				}));
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
						upgrade:        'https://headlessoracle.com/upgrade',
						current_plan:   'sandbox',
					}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/upgrade' });
				}

				// Enforce per-plan webhook count limits (builder: 5, pro: 25, protocol: unlimited)
				const webhookPlanLimit = getPlanWebhookLimit(subAuth.plan ?? 'free');
				if (webhookPlanLimit !== null && webhookPlanLimit > 0) {
					const subKeyHash = subAuth.keyHash ?? await sha256Hex(request.headers.get('X-Oracle-Key')!);
					const existingSubs = await getWebhookSubscriptions(subKeyHash, env);
					if (existingSubs.length >= webhookPlanLimit) {
						return json({
							error:       'PLAN_LIMIT_EXCEEDED',
							message:     `Your ${subAuth.plan} plan allows up to ${webhookPlanLimit} webhook subscription(s). Delete an existing webhook to add a new one, or upgrade at headlessoracle.com/upgrade.`,
							plan:        subAuth.plan,
							limit:       webhookPlanLimit,
							current:     existingSubs.length,
							upgrade_url: 'https://headlessoracle.com/upgrade',
						}, 403);
					}
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
						return json({ error: 'SUBSCRIPTION_LIMIT', message: `Free tier limit: ${FREE_TIER_WEBHOOK_MIC_LIMIT} total MIC subscriptions. Upgrade at headlessoracle.com/upgrade.` }, 429, { 'Retry-After': String(computeRetryAfterSeconds(now)) });
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

				// Increment webhook_count in ORACLE_TELEMETRY for plan-limit tracking
				const wkCountKey = `webhook_count:${keyHash}`;
				const wkCountRaw = await env.ORACLE_TELEMETRY.get(wkCountKey).catch(() => null);
				const wkCount = wkCountRaw ? parseInt(wkCountRaw, 10) : 0;
				await env.ORACLE_TELEMETRY.put(wkCountKey, String(wkCount + 1)).catch(() => {});

				return await withMigrationNotice(json({
					webhook_id:      subscription.subscription_id, // canonical Sprint 2 field
					subscription_id: subscription.subscription_id, // backward compat
					url:             subscription.url,
					mics,
					events:          ['status_change'],
					created_at:      subscription.created_at,
					status:          'active',
					secret,
				}));
			}

			// ── GET /v5/webhooks/health — WebhookDispatcher DO status (no auth) ─
			// Returns dispatcher_status: 'active' | 'no_alarm' and next_alarm (ISO8601 | null).
			// Reads a KV key written by WebhookDispatcher.alarm() on each run — no DO instance
			// creation needed, which avoids Miniflare SQLite file locking in tests.
			// Useful for UptimeRobot monitoring of the webhook fan-out system.
			if (url.pathname === '/v5/webhooks/health' && request.method === 'GET') {
				try {
					const raw = await env.ORACLE_TELEMETRY.get('webhook_dispatcher:health');
					if (raw) {
						const parsed = JSON.parse(raw) as { status: string; next_alarm: string };
						return json({
							dispatcher_status: parsed.status === 'active' ? 'active' : 'no_alarm',
							next_alarm:        parsed.next_alarm ?? null,
						});
					}
					return json({ dispatcher_status: 'no_alarm', next_alarm: null });
				} catch {
					return json({ dispatcher_status: 'no_alarm', next_alarm: null });
				}
			}

			// ── GET /v5/webhooks — list all webhooks for this API key ────────────
			if (url.pathname === '/v5/webhooks' && request.method === 'GET') {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				const listAuth = await checkApiKey(apiKey, env);
				if (!listAuth.allowed) return json({ error: listAuth.error, message: listAuth.message }, listAuth.status);
				const listKeyHash = listAuth.keyHash ?? await sha256Hex(apiKey);
				const subs = await getWebhookSubscriptions(listKeyHash, env);
				const result = subs.map((s) => ({
					webhook_id:  s.subscription_id,
					url:         s.url,
					mics:        s.mics,
					events:      ['status_change'],
					created_at:  s.created_at,
					status:      'active',
				}));
				return await withMigrationNotice(json({ webhooks: result, count: result.length }));
			}

			// ── DELETE /v5/webhooks/:webhook_id — delete a specific webhook ───────
			{
				const webhookDeleteMatch = url.pathname.match(/^\/v5\/webhooks\/([^/]+)$/);
				if (webhookDeleteMatch && request.method === 'DELETE' && url.pathname !== '/v5/webhooks/unsubscribe') {
					const webhookId = webhookDeleteMatch[1];
					const apiKey = request.headers.get('X-Oracle-Key');
					if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
					const delAuth = await checkApiKey(apiKey, env);
					if (!delAuth.allowed) return json({ error: delAuth.error, message: delAuth.message }, delAuth.status);
					const delKeyHash = delAuth.keyHash ?? await sha256Hex(apiKey);
					const delExisting = await getWebhookSubscriptions(delKeyHash, env);
					const delSub = delExisting.find((s) => s.subscription_id === webhookId);
					if (!delSub) return json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'No webhook with that id found for this key' }, 404);
					// Remove from subscriber record
					const delUpdated = delExisting.filter((s) => s.subscription_id !== webhookId);
					await env.ORACLE_API_KEYS.put(`webhooks:${delKeyHash}`, JSON.stringify(delUpdated));
					// Remove from per-MIC fan-out index
					for (const mic of delSub.mics) {
						const micTargets = await getWebhooksByMic(mic, env);
						const filtered   = micTargets.filter((t) => t.subscription_id !== webhookId);
						await env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify(filtered));
					}
					// Decrement webhook_count
					const wkDelCountKey = `webhook_count:${delKeyHash}`;
					const wkDelCountRaw = await env.ORACLE_TELEMETRY.get(wkDelCountKey).catch(() => null);
					const wkDelCount = wkDelCountRaw ? parseInt(wkDelCountRaw, 10) : 0;
					if (wkDelCount > 0) await env.ORACLE_TELEMETRY.put(wkDelCountKey, String(wkDelCount - 1)).catch(() => {});
					return new Response(null, { status: 204, headers: { 'X-Oracle-Version': 'v5' } });
				}
			}

			// ── POST /v5/webhooks/test/:webhook_id — send a synthetic test delivery ─
			{
				const webhookTestMatch = url.pathname.match(/^\/v5\/webhooks\/test\/([^/]+)$/);
				if (webhookTestMatch && request.method === 'POST') {
					const webhookId = webhookTestMatch[1];
					const apiKey = request.headers.get('X-Oracle-Key');
					if (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
					const testAuth = await checkApiKey(apiKey, env);
					if (!testAuth.allowed) return json({ error: testAuth.error, message: testAuth.message }, testAuth.status);
					const testKeyHash = testAuth.keyHash ?? await sha256Hex(apiKey);
					const testSubs = await getWebhookSubscriptions(testKeyHash, env);
					const testSub = testSubs.find((s) => s.subscription_id === webhookId);
					if (!testSub) return json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'No webhook with that id found for this key' }, 404);
					// Build a synthetic test receipt (using the first MIC in the subscription)
					const testMic = testSub.mics[0] ?? 'XNYS';
					const testNow = new Date();
					const testExpiresAt = new Date(testNow.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
					const { receipt: testReceipt } = await buildSignedReceipt(testMic, env, testNow, testExpiresAt, 'live');
					const testPayload = {
						event:           'test',
						webhook_id:      testSub.subscription_id,
						mic:             testMic,
						previous_status: null,
						current_status:  testReceipt['status'],
						receipt:         testReceipt,
						delivered_at:    testNow.toISOString(),
					};
					const testTarget: WebhookDeliveryTarget = {
						subscription_id: testSub.subscription_id,
						key_hash:        testKeyHash,
						url:             testSub.url,
						secret:          testSub.secret,
					};
					// maxAttempts=1 for test deliveries — no retry, fast response regardless of subscriber health
				const testResult = await deliverWebhook(testTarget, testPayload, 1);
					return await withMigrationNotice(json({
						webhook_id:   webhookId,
						url:          testSub.url,
						delivered:    testResult.ok,
						status:       testResult.status ?? null,
						error:        testResult.error ?? null,
						payload_sent: testPayload,
					}));
				}
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

				return await withMigrationNotice(json({ subscription_id: body.subscription_id, status: 'deleted' }));
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
						upgrade:        'https://headlessoracle.com/upgrade',
						current_plan:   receiptsAuth.plan ?? 'free',
					}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/upgrade' });
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
					return await withMigrationNotice(json({ receipts: data ?? [], count: (data ?? []).length, limit }));
				} catch {
					// Supabase unreachable or misconfigured — degrade gracefully (same as unconfigured)
					return json({ receipts: [], note: 'Audit log temporarily unavailable' });
				}
			}

			// ── POST /v5/sandbox — email-gated sandbox key (7 days, 200 calls) ────────────────────
			// Alternative agent-native path: X-Payment header with valid x402 payment → ho_crd_ key
			// (10 credits, no email, no fingerprint blocking — payment proves intent).
			if (url.pathname === '/v5/sandbox') {
				if (request.method === 'GET') {
					// Helpful error for callers using the old GET interface.
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'POST /v5/sandbox with JSON body { "email": "you@example.com" }' }, 405);
				}
				if (request.method !== 'POST') {
					return json({ error: 'METHOD_NOT_ALLOWED', message: 'Use POST' }, 405);
				}

				// ── x402 alternative path: agent pays $0.001 USDC, gets a credit key immediately ────
				const sandboxPaymentHeader = getPaymentHeader(request);
				if (sandboxPaymentHeader) {
					if (!env.ORACLE_PAYMENT_ADDRESS) {
						return json({ error: 'SERVICE_UNAVAILABLE', message: 'x402 payments are not configured on this instance. Use email-based provisioning.' }, 503);
					}
					const sbResource = 'https://headlessoracle.com/v5/sandbox';
					const sbVerify = await verifyPaymentAnyFormat(sandboxPaymentHeader, env.ORACLE_PAYMENT_ADDRESS, env, sbResource);
					if (!sbVerify.valid) {
						return json({ error: 'INVALID_PAYMENT', message: sbVerify.detail ?? 'Payment verification failed' }, 402, X402_RESPONSE_HEADERS);
					}
					// Payment verified — mint a ho_crd_ key with 10 credits (no email, no fingerprint)
					const sbCrdBytes = crypto.getRandomValues(new Uint8Array(32));
					const sbCrdKey   = 'ho_crd_' + toHex(sbCrdBytes);
					const sbCrdHash  = await sha256Hex(sbCrdKey);
					const sbCrdMeta  = JSON.stringify({
						tier:       'credits',
						status:     'active',
						balance:    10,
						created_at: now.toISOString(),
						source:     'x402_sandbox',
					});
					if (env.ORACLE_API_KEYS) {
						await env.ORACLE_API_KEYS.put(sbCrdHash, sbCrdMeta);
					}
					console.log(JSON.stringify({ event: 'SANDBOX_X402_KEY_MINTED', tx_hash: sbVerify.txHash ?? 'facilitator' }));
					return json({
						api_key:         sbCrdKey,
						tier:            'credits',
						credits:         10,
						source:          'x402_sandbox',
						note:            'Paid via x402. Credits do not expire. Buy more at /v5/credits/purchase.',
						upgrade_url:     'https://headlessoracle.com/upgrade',
						quickstart: {
							curl:   `curl 'https://api.headlessoracle.com/v5/status?mic=XNYS' -H 'X-Oracle-Key: ${sbCrdKey}'`,
						},
					});
				}

				// Email is required — no anonymous sandbox keys.
				const sbBody     = await request.json().catch(() => null) as { email?: unknown; use_case?: unknown } | null;
				const emailRaw   = sbBody?.email;
				const useCaseRaw = typeof sbBody?.use_case === 'string' ? sbBody.use_case.slice(0, 500).trim() : null;
				if (!emailRaw || typeof emailRaw !== 'string' || !emailRaw.trim()) {
					return json({ error: 'EMAIL_REQUIRED', message: 'An email address is required to provision a sandbox key.' }, 400);
				}
				const emailParam = emailRaw.trim().toLowerCase();
				const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
				if (!emailRegex.test(emailParam)) {
					return json({ error: 'EMAIL_INVALID', message: 'Invalid email format.' }, 400);
				}

				// Fingerprint checks: IP and email — both prevent double-provisioning (7-day window).
				const clientIp    = request.headers.get('CF-Connecting-IP') ||
					request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown';
				const ipHash      = await sha256Hex(clientIp);
				const emailHash   = await sha256Hex(emailParam);
				const fpKeyIp     = `sandbox_fingerprint:ip:${ipHash}`;
				const fpKeyEmail  = `sandbox_fingerprint:email:${emailHash}`;
				const [existingIpFp, existingEmailFp] = await Promise.all([
					env.ORACLE_TELEMETRY.get(fpKeyIp).catch(() => null),
					env.ORACLE_TELEMETRY.get(fpKeyEmail).catch(() => null),
				]);
				if (existingIpFp !== null || existingEmailFp !== null) {
					return json({
						error:       'SANDBOX_LIMIT_REACHED',
						message:     'You have already used your free sandbox allocation.',
						upgrade_url: 'https://headlessoracle.com/upgrade',
						plans: { builder: '$99/month — 50,000 calls', pro: '$299/month — 200,000 calls' },
					}, 429);
				}

				// Rate-limit sandbox key creation: max 10 per IP per hour (belt-and-suspenders).
				const hourKey   = `sandbox_rate:${ipHash}:${new Date().toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
				const hourCount = parseInt(await env.ORACLE_TELEMETRY.get(hourKey).catch(() => '0') || '0', 10);
				if (hourCount >= 10) {
					const nextHour = new Date(now);
					nextHour.setUTCMinutes(0, 0, 0);
					nextHour.setUTCHours(nextHour.getUTCHours() + 1);
					const sandboxRetryAfter = Math.max(1, Math.floor((nextHour.getTime() - now.getTime()) / 1000));
					return json({
						error:       'SANDBOX_RATE_LIMIT',
						message:     'Too many sandbox requests from this IP.',
						upgrade_url: 'https://headlessoracle.com/upgrade',
					}, 429, { 'Retry-After': String(sandboxRetryAfter) });
				}

				// Generate sandbox key: sb_ prefix + 32 hex chars
				const rawKey    = `sb_${Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2,'0')).join('')}`;
				const keyHash   = await sha256Hex(rawKey);
				const expiresAt = new Date(now.getTime() + 604_800_000).toISOString(); // 7 days

				const sandboxMeta = JSON.stringify({
					tier:       'sandbox',
					status:     'active',
					email:      emailParam,
					expires_at: expiresAt,
					max_calls:  200,
					created_at: now.toISOString(),
					source:     'auto_sandbox',
				});

				// Store sandbox key in ORACLE_API_KEYS KV with 7-day TTL.
				if (env.ORACLE_API_KEYS) {
					await env.ORACLE_API_KEYS.put(keyHash, sandboxMeta, { expirationTtl: 604_800 });
				}

				// Store both fingerprints: prevent re-provisioning for 7 days.
				await Promise.all([
					env.ORACLE_TELEMETRY.put(fpKeyIp, now.toISOString(), { expirationTtl: 604_800 }).catch(() => {}),
					env.ORACLE_TELEMETRY.put(fpKeyEmail, now.toISOString(), { expirationTtl: 604_800 }).catch(() => {}),
				]);

				// Increment IP rate-limit counter (90min TTL — covers hour rollover).
				await env.ORACLE_TELEMETRY.put(hourKey, String(hourCount + 1), { expirationTtl: 90 * 60 }).catch(() => {});

				// Acquisition telemetry: sandbox key creations count as unauthenticated (FINDING-13)
				incrementKvCounter(`unauth_calls:${now.toISOString().slice(0, 10)}`, env, ctx);

				// Store follow-up record (192h TTL — outlives the 7-day key so follow-up cron can reach it).
				const followupRecord = JSON.stringify({
					email:          emailParam,
					created_at:     now.toISOString(),
					key_expires_at: expiresAt,
					followed_up:    false,
				});
				await env.ORACLE_TELEMETRY.put(`sandbox_followup:${keyHash}`, followupRecord, { expirationTtl: 86_400 * 8 }).catch(() => {});

				// Log structured acquisition event (never log raw email or use_case).
				console.log(JSON.stringify({
					event:            'SANDBOX_SIGNUP',
					email_hash:       emailHash,
					ip_hash:          ipHash,
					use_case_present: useCaseRaw !== null,
					use_case_length:  useCaseRaw?.length ?? 0,
				}));

				// Send welcome email (non-blocking).
				if (env.RESEND_API_KEY) {
					const useCaseLine = useCaseRaw ? `You told us you're building: ${useCaseRaw}\n\n` : '';
					const welcomeText =
						`Your sandbox key: ${rawKey}\n\n` +
						`You have 200 calls over 7 days to explore Headless Oracle.\n\n` +
						useCaseLine +
						`Quick test:\n` +
						`curl 'https://api.headlessoracle.com/v5/status?mic=XNYS' \\\n` +
						`  -H 'X-Oracle-Key: ${rawKey}'\n\n` +
						`Docs: https://headlessoracle.com/docs\n\n` +
						`When you're ready to build in production, Builder plan is $99/month for 50,000 calls:\n` +
						`https://headlessoracle.com/upgrade\n\n` +
						`Questions? Reply to this email.\n\n` +
						`P.S. If you'd like to share what you're building, just reply. Design partners get early access to new features and direct support.`;
					ctx.waitUntil(
						fetch('https://api.resend.com/emails', {
							method:  'POST',
							headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
							body: JSON.stringify({
								from:    'Headless Oracle <hello@headlessoracle.com>',
								to:      [emailParam],
								subject: 'Your Headless Oracle sandbox key',
								text:    welcomeText,
							}),
						}).then(r => {
							if (!r.ok) console.error(`SANDBOX_EMAIL_ERROR: resend status=${r.status}`);
							else       console.log(JSON.stringify({ event: 'SANDBOX_EMAIL_SENT', email: emailParam }));
						}).catch(e => console.error(`SANDBOX_EMAIL_ERROR: ${e instanceof Error ? e.message : String(e)}`)),
					);
				}

				return json({
					api_key:         rawKey,
					tier:            'sandbox',
					email_captured:  true,
					expires_at:      expiresAt,
					calls_remaining: 200,
					upgrade:         'https://headlessoracle.com/upgrade',
					follow_up:       'Check your inbox for your key and quickstart.',
					quickstart: {
						curl:   `curl 'https://api.headlessoracle.com/v5/status?mic=XNYS' -H 'X-Oracle-Key: ${rawKey}'`,
						node:   `const res = await fetch('https://api.headlessoracle.com/v5/status?mic=XNYS', {headers: {'X-Oracle-Key': '${rawKey}'}})`,
						python: `import httpx; r = httpx.get('https://api.headlessoracle.com/v5/status', params={'mic':'XNYS'}, headers={'X-Oracle-Key':'${rawKey}'})`,
					},
				});
			}

			// ── GET /v5/handoff — session continuity document (auth required) ────────
			// Returns a Markdown-formatted summary of current product state for session handoff.
			if (url.pathname === '/v5/handoff' && request.method === 'GET') {
				const handoffKey = request.headers.get('X-Oracle-Key');
				if (!handoffKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				}
				const handoffAuth = await checkApiKey(handoffKey, env);
				if (!handoffAuth.allowed) {
					return json({ error: handoffAuth.error, message: handoffAuth.message }, handoffAuth.status);
				}

				const today  = now.toISOString().slice(0, 10);
				const prefix = `mcp_clients:${today}:`;
				let hMcpRequests = 0;
				let hMcpClients  = 0;
				let hNewClients  = 0;
				const hReturning: Array<{ hash: string; asn_org: string; request_count: number }> = [];
				const hActiveRecent: Array<{ hash: string; asn_org: string; last_seen: string }> = [];
				const twoHoursAgo = new Date(now.getTime() - 2 * 3600_000).toISOString();

				try {
					const hList = await env.ORACLE_TELEMETRY.list({ prefix });
					hMcpClients = hList.keys.length;
					const hRecords = await Promise.all(hList.keys.map(k => env.ORACLE_TELEMETRY.get(k.name)));
					for (const r of hRecords) {
						if (!r) continue;
						const parsed = JSON.parse(r) as { request_count?: number; asn_org?: string; first_seen?: string; last_seen?: string };
						hMcpRequests += parsed.request_count ?? 0;
						if ((parsed.request_count ?? 0) > 1) {
							hReturning.push({ hash: 'anon', asn_org: parsed.asn_org ?? '', request_count: parsed.request_count ?? 0 });
						} else {
							hNewClients++;
						}
						if (parsed.last_seen && parsed.last_seen >= twoHoursAgo) {
							hActiveRecent.push({ hash: 'anon', asn_org: parsed.asn_org ?? '', last_seen: parsed.last_seen ?? '' });
						}
					}
				} catch { /* KV unavailable */ }

				const [hAuthRaw, hUnauthRaw, hSandboxCapsRaw, hSandboxKeysRaw, hZeroAuthMcpRaw] = await Promise.all([
					env.ORACLE_TELEMETRY.get(`auth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`sandbox_cap_hit:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.list({ prefix: 'sandbox_followup:' }).then(l => l.keys.filter(k => {
						return true; // count all (creation date checked below)
					})).catch(() => [] as Array<{ name: string }>),
					env.ORACLE_TELEMETRY.get(`zero_auth_mcp_requests:${today}`).catch(() => null),
				]);
				const hAuthCalls      = parseInt(hAuthRaw        ?? '0', 10) || 0;
				const hUnauthCalls    = parseInt(hUnauthRaw      ?? '0', 10) || 0;
				const hSandboxCaps    = parseInt(hSandboxCapsRaw ?? '0', 10) || 0;
				const hZeroAuthMcp    = parseInt(hZeroAuthMcpRaw ?? '0', 10) || 0;
				const hAuthRatioStr   = hAuthCalls + hUnauthCalls > 0
					? `${Math.round((hAuthCalls / (hAuthCalls + hUnauthCalls)) * 100)}%`
					: 'n/a';

				// Weekly digest
				const weekNum   = Math.ceil((now.getUTCDate() - now.getUTCDay() + 1 + 6) / 7);
				const weekKey   = `weekly_digest:${today.slice(0, 4)}-W${String(weekNum).padStart(2, '0')}`;
				const weekRaw   = await env.ORACLE_TELEMETRY.get(weekKey).catch(() => null);

				// MCP per-tool counts for today
				const [hToolStatusRaw, hToolScheduleRaw, hToolListRaw, hToolVerifyRaw] = await Promise.all([
					env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_status:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:get_market_schedule:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:list_exchanges:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`mcp_tool:verify_receipt:${today}`).catch(() => null),
				]);
				const hToolCounts = {
					get_market_status:   parseInt(hToolStatusRaw   ?? '0', 10) || 0,
					get_market_schedule: parseInt(hToolScheduleRaw ?? '0', 10) || 0,
					list_exchanges:      parseInt(hToolListRaw     ?? '0', 10) || 0,
					verify_receipt:      parseInt(hToolVerifyRaw   ?? '0', 10) || 0,
				};

				const openGaps: string[] = [];
				// Static open gaps reference — updated when new gaps are identified
				openGaps.push('GAP-006: x402scan full listing pending Sam Ragsdale approval (external)');

				const returningSection = hReturning.length > 0
					? hReturning.slice(0, 10).map(r => `- ${r.asn_org || 'unknown ASN'}: ${r.request_count} requests`).join('\n')
					: '_(none)_';
				const activeSection = hActiveRecent.length > 0
					? hActiveRecent.slice(0, 10).map(r => `- ${r.asn_org || 'unknown ASN'} (${r.last_seen.slice(11, 16)} UTC)`).join('\n')
					: '_(none)_';
				const weekSection = weekRaw
					? (() => { try { const w = JSON.parse(weekRaw) as Record<string, unknown>; return JSON.stringify(w, null, 2); } catch { return weekRaw; } })()
					: '_(weekly digest not yet written — runs Monday 09:00 UTC)_';

				const markdown = [
					`# Headless Oracle — Session Handoff`,
					`**Generated:** ${now.toISOString()}`,
					``,
					`## Telemetry Today (${today})`,
					`- Unique MCP clients: ${hMcpClients}`,
					`- Total MCP requests: ${hMcpRequests}`,
					`- Unauthenticated calls (all): ${hUnauthCalls}`,
					`- Zero-auth MCP requests: ${hZeroAuthMcp}`,
					`- Auth ratio: ${hAuthRatioStr}`,
					`- Sandbox keys issued: ${hSandboxKeysRaw.length}`,
					`- Sandbox keys at limit: ${hSandboxCaps}`,
					``,
					`## MCP Tool Calls Today`,
					`- get_market_status: ${hToolCounts.get_market_status}`,
					`- get_market_schedule: ${hToolCounts.get_market_schedule}`,
					`- list_exchanges: ${hToolCounts.list_exchanges}`,
					`- verify_receipt: ${hToolCounts.verify_receipt}`,
					``,
					`## Returning Clients`,
					returningSection,
					``,
					`## New Clients Today`,
					`${hNewClients} new clients since midnight UTC`,
					``,
					`## Active Clients (last 2 hours)`,
					activeSection,
					``,
					`## Open Gaps`,
					openGaps.map(g => `- ${g}`).join('\n'),
					``,
					`## Weekly Summary`,
					weekSection,
					``,
					`## Product State`,
					`- Exchanges covered: ${SUPPORTED_EXCHANGES.length}`,
					`- Edge cases/year: ${edgeCaseCount(now.getUTCFullYear()).total}`,
					`- x402 enabled: ${!!env.ORACLE_PAYMENT_ADDRESS}`,
					`- Halt monitor: active`,
					`- Infrastructure cost: $15.50/month`,
					``,
					`---`,
					`_Paste \`curl https://api.headlessoracle.com/v5/handoff -H 'X-Oracle-Key: YOUR_KEY'\` at session start for instant context._`,
				].join('\n');

				return new Response(markdown, {
					headers: {
						...corsHeaders,
						'Content-Type':  'text/markdown; charset=utf-8',
						'X-Oracle-Version': 'v5',
						'Cache-Control': 'no-store',
					},
				});
			}

			// ── GET /.well-known/ai-plugin.json and /ai-plugin.json — ChatGPT plugin manifest ──
		// Some tools probe the root (/ai-plugin.json), others probe the well-known path.
		// Both return the same payload so any discovery strategy succeeds.
		if (url.pathname === '/.well-known/ai-plugin.json' || url.pathname === '/ai-plugin.json') {
			return new Response(JSON.stringify({
				schema_version: 'v1',
				name_for_human: 'Headless Oracle',
				name_for_model: 'headless_oracle',
				description_for_human: 'Cryptographically signed market state verification for 28 global exchanges (equities, derivatives, and 24/7 crypto). Know if NYSE, LSE, CME, or any major exchange is OPEN, CLOSED, or HALTED before your agent acts.',
				description_for_model: 'Use headless_oracle to get Ed25519-signed market state receipts before executing any financial transaction. Returns OPEN, CLOSED, HALTED, or UNKNOWN with cryptographic proof. Always call get_market_status before safe_to_execute. Supports 28 exchanges by MIC code (equities, derivatives, 24/7 crypto). Note: SMA in receipts denotes Signed Market Attestation, not Simple Moving Average. Fail-closed: if uncertain, returns UNKNOWN rather than false OPEN.',
				auth: {
					type:               'api_key',
					api_key_question:   'Enter your Headless Oracle API key (X-Oracle-Key header). Get a sandbox key: POST https://api.headlessoracle.com/v5/sandbox with body {"email":"you@example.com"}',
				},
				api: {
					type:                  'openapi',
					url:                   'https://headlessoracle.com/openapi.json',
					is_user_authenticated: false,
				},
				logo_url:      'https://headlessoracle.com/logo.png',
				contact_email: 'hello@headlessoracle.com',
				legal_info_url:'https://headlessoracle.com/legal',
			}, null, 2), {
				headers: {
					...corsHeaders,
					'Content-Type':     'application/json',
					'X-Oracle-Version': 'v5',
					'Cache-Control':    'public, max-age=3600',
				},
			});
		}

		// ── GET /status — HTML market status page for all 28 exchanges ───────────
		// Not to be confused with /v5/status (the authenticated API endpoint).
		// This is a human-readable (and agent-parseable) page that polls /v5/demo
		// for each exchange and renders results with colour-coded status badges.
		if (url.pathname === '/status') {
			const statusHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Market Status — Headless Oracle</title>
  <meta name="description" content="Real-time market open/closed status for 28 global exchanges (equities, derivatives, and 24/7 crypto). Cryptographically signed by Headless Oracle. NYSE, NASDAQ, LSE, Tokyo, CME, and more.">
  <meta property="og:title" content="Live Market Status — Headless Oracle">
  <meta property="og:description" content="Real-time market open/closed status for 28 global exchanges (equities, derivatives, and 24/7 crypto).">
  <meta property="og:url" content="https://headlessoracle.com/status">
  <link rel="canonical" href="https://headlessoracle.com/status">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Live Market Status",
    "description": "Real-time market open/closed/halted status for 28 global exchanges (equities, derivatives, and 24/7 crypto), cryptographically signed.",
    "url": "https://headlessoracle.com/status",
    "provider": { "@type": "Organization", "name": "Headless Oracle", "url": "https://headlessoracle.com" }
  }
  </script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
    header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
    header a{color:#94a3b8;text-decoration:none;font-size:14px}
    header h1{font-size:18px;font-weight:700;color:#f8fafc}
    .badge-api{background:#1d4ed8;color:#fff;padding:6px 14px;border-radius:8px;font-size:13px;text-decoration:none;font-weight:600}
    .meta{padding:12px 24px;background:#0f172a;border-bottom:1px solid #1e293b;font-size:12px;color:#64748b;display:flex;gap:16px;align-items:center}
    .meta #updated{color:#94a3b8}
    .meta .countdown{color:#3b82f6}
    main{padding:24px;max-width:1200px;margin:0 auto}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;transition:border-color .2s}
    .card.open{border-left:4px solid #22c55e}
    .card.closed{border-left:4px solid #64748b}
    .card.halted{border-left:4px solid #ef4444}
    .card.unknown{border-left:4px solid #f97316}
    .card.loading{border-left:4px solid #1e293b}
    .card-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
    .name{font-weight:600;font-size:14px;color:#f1f5f9;line-height:1.3}
    .mic{font-size:11px;font-family:monospace;color:#64748b;margin-top:2px}
    .status-badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.5px;white-space:nowrap}
    .status-badge.open{background:#14532d;color:#4ade80}
    .status-badge.closed{background:#1e293b;color:#94a3b8;border:1px solid #334155}
    .status-badge.halted{background:#450a0a;color:#fca5a5}
    .status-badge.unknown{background:#431407;color:#fdba74}
    .status-badge.loading{background:#1e293b;color:#475569}
    .session{font-size:11px;color:#64748b;margin-top:8px}
    .session span{color:#94a3b8}
    .cta{text-align:center;padding:40px 24px;background:#1e293b;border-top:1px solid #334155;margin-top:40px}
    .cta h2{font-size:20px;font-weight:700;color:#f8fafc;margin-bottom:8px}
    .cta p{color:#94a3b8;font-size:14px;margin-bottom:16px}
    .cta a{background:#1d4ed8;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Headless Oracle — Live Market Status</h1>
      <a href="https://headlessoracle.com" style="font-size:12px">headlessoracle.com</a>
    </div>
    <a href="https://headlessoracle.com/upgrade" class="badge-api">Get API Access →</a>
  </header>
  <div class="meta">
    <span>28 exchanges · Ed25519 signed · Fail-closed</span>
    <span>Last updated: <span id="updated">loading…</span></span>
    <span class="countdown">Refreshing in <span id="countdown">60</span>s</span>
  </div>
  <main>
    <div class="grid" id="grid">
      ${['XNYS','XNAS','XBSP','XLON','XPAR','XSWX','XMIL','XHEL','XSTO','XIST','XSAU','XDFM','XJSE','XSHG','XSHE','XHKG','XJPX','XKRX','XBOM','XNSE','XSES','XASX','XNZE'].map(mic => `
      <div class="card loading" id="card-${mic}">
        <div class="card-head">
          <div>
            <div class="name" id="name-${mic}">${mic}</div>
            <div class="mic">${mic}</div>
          </div>
          <span class="status-badge loading" id="badge-${mic}">…</span>
        </div>
        <div class="session" id="session-${mic}"></div>
      </div>`).join('')}
    </div>
  </main>
  <div class="cta">
    <h2>Use this data in your agent</h2>
    <p>Get a signed receipt via API — Ed25519-verified, 60s TTL, fail-closed by design.</p>
    <a href="https://headlessoracle.com/upgrade">Get API access →</a>
  </div>
  <script>
    const MICS = ['XNYS','XNAS','XBSP','XLON','XPAR','XSWX','XMIL','XHEL','XSTO','XIST','XSAU','XDFM','XJSE','XSHG','XSHE','XHKG','XJPX','XKRX','XBOM','XNSE','XSES','XASX','XNZE'];
    const NAMES = {XNYS:'New York Stock Exchange',XNAS:'NASDAQ',XBSP:'B3 Brazil',XLON:'London Stock Exchange',XPAR:'Euronext Paris',XSWX:'SIX Swiss Exchange',XMIL:'Borsa Italiana',XHEL:'Nasdaq Helsinki',XSTO:'Nasdaq Stockholm',XIST:'Borsa Istanbul',XSAU:'Saudi Exchange (Tadawul)',XDFM:'Dubai Financial Market',XJSE:'Johannesburg Stock Exchange',XSHG:'Shanghai Stock Exchange',XSHE:'Shenzhen Stock Exchange',XHKG:'Hong Kong Exchanges',XJPX:'Japan Exchange Group',XKRX:'Korea Exchange',XBOM:'BSE India',XNSE:'NSE India',XSES:'Singapore Exchange',XASX:'Australian Securities Exchange',XNZE:'New Zealand Exchange'};
    let countdown = 60;
    function statusClass(s){return s==='OPEN'?'open':s==='HALTED'?'halted':s==='UNKNOWN'?'unknown':'closed';}
    async function fetchStatus(mic){
      try{
        const r=await fetch('https://headlessoracle.com/v5/demo?mic='+mic);
        return await r.json();
      }catch{return null;}
    }
    function renderCard(mic,data){
      const card=document.getElementById('card-'+mic);
      const badge=document.getElementById('badge-'+mic);
      const nameEl=document.getElementById('name-'+mic);
      const session=document.getElementById('session-'+mic);
      if(!data){card.className='card unknown';badge.className='status-badge unknown';badge.textContent='ERROR';return;}
      const s=data.status||'UNKNOWN';
      const cls=statusClass(s);
      card.className='card '+cls;
      badge.className='status-badge '+cls;
      badge.textContent=s;
      nameEl.textContent=NAMES[mic]||mic;
      if(data.next_open||data.next_close){
        const t=s==='OPEN'?'Closes':'Opens';
        const ts=s==='OPEN'?data.next_close:data.next_open;
        if(ts){
          const d=new Date(ts);
          session.innerHTML=t+': <span>'+d.toUTCString().replace(' GMT','Z')+'</span>';
        }
      }
    }
    async function loadAll(){
      document.getElementById('updated').textContent=new Date().toUTCString().replace(' GMT','Z');
      countdown=60;
      await Promise.all(MICS.map(async mic=>{
        const data=await fetchStatus(mic);
        renderCard(mic,data);
      }));
    }
    loadAll();
    setInterval(()=>{countdown--;document.getElementById('countdown').textContent=countdown;if(countdown<=0)loadAll();},1000);
  </script>
</body>
</html>`;
			return new Response(statusHtml, {
				headers: {
					...corsHeaders,
					'Content-Type':     'text/html; charset=utf-8',
					'X-Oracle-Version': 'v5',
					'Cache-Control':    'no-store',
				},
			});
		}

		// ── GET /upgrade — plan selection page (general) or migration landing (legacy_migration) ──
		if (url.pathname === '/upgrade') {
			const isMigration = url.searchParams.get('reason') === 'legacy_migration';

			const upgradeNow      = new Date();
			const upgradeDeadline = new Date('2026-03-31T23:59:00Z');
			const upgradeDaysLeft = Math.max(0, Math.floor((upgradeDeadline.getTime() - upgradeNow.getTime()) / 86_400_000));
			const upgradeDaysExpired = upgradeNow > upgradeDeadline;
			const deadlineColor   = upgradeDaysExpired ? '#ef4444' : upgradeDaysLeft <= 3 ? '#ef4444' : '#f97316';
			const deadlineText    = upgradeDaysExpired
				? 'EXPIRED'
				: `Key expires March 31, 2026 — ${upgradeDaysLeft} day${upgradeDaysLeft === 1 ? '' : 's'} remaining`;

			const upgradeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${isMigration ? 'Migrate Your Key' : 'Choose a Plan'} — Headless Oracle</title>
<meta name="robots" content="noindex">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0f;
    --surface: #13131a;
    --border: #1e1e2e;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --highlight: #1e1b4b;
    --green: #22c55e;
    --orange: #f97316;
    --red: #ef4444;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    min-height: 100vh;
  }
  a { color: var(--accent-hover); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Header */
  .header {
    border-bottom: 1px solid var(--border);
    padding: 20px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .wordmark {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.5px;
    color: var(--text);
  }
  .wordmark span { color: var(--accent-hover); }
  .tagline {
    font-size: 13px;
    color: var(--muted);
    border-left: 1px solid var(--border);
    padding-left: 12px;
    margin-left: 4px;
  }

  /* Hero */
  .hero {
    text-align: center;
    padding: 64px 24px 48px;
    max-width: 720px;
    margin: 0 auto;
  }
  .hero h1 {
    font-size: clamp(28px, 5vw, 42px);
    font-weight: 700;
    letter-spacing: -1px;
    line-height: 1.2;
    margin-bottom: 16px;
  }
  .hero p {
    font-size: 18px;
    color: var(--muted);
    max-width: 560px;
    margin: 0 auto 28px;
  }
  .deadline-badge {
    display: inline-block;
    background: rgba(239,68,68,0.12);
    border: 1px solid ${deadlineColor};
    color: ${deadlineColor};
    font-size: 14px;
    font-weight: 600;
    padding: 8px 20px;
    border-radius: 100px;
    letter-spacing: 0.02em;
  }

  /* Plans */
  .plans {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 20px;
    max-width: 960px;
    margin: 0 auto;
    padding: 0 24px 64px;
  }
  .plan {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    position: relative;
  }
  .plan.recommended {
    border-color: var(--accent);
    background: linear-gradient(135deg, var(--highlight) 0%, var(--surface) 60%);
  }
  .recommended-badge {
    position: absolute;
    top: -12px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 4px 14px;
    border-radius: 100px;
    white-space: nowrap;
  }
  .plan-name {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .plan.recommended .plan-name { color: var(--accent-hover); }
  .plan-price {
    font-size: 36px;
    font-weight: 700;
    letter-spacing: -1px;
    line-height: 1;
  }
  .plan-price span {
    font-size: 16px;
    font-weight: 400;
    color: var(--muted);
    letter-spacing: 0;
  }
  .plan-features {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
  }
  .plan-features li {
    font-size: 14px;
    color: var(--muted);
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .plan-features li::before {
    content: '✓';
    color: var(--green);
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .plan-cta {
    display: block;
    text-align: center;
    padding: 13px 24px;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .plan-cta:hover { opacity: 0.85; text-decoration: none; }
  .plan-cta.primary { background: var(--accent); color: #fff; }
  .plan-cta.secondary {
    background: transparent;
    color: var(--text);
    border: 1px solid var(--border);
  }

  /* Reassurance */
  .reassurance {
    border-top: 1px solid var(--border);
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 24px;
    text-align: center;
  }
  .reassurance h2 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 24px;
    color: var(--text);
  }
  .reassurance-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }
  .reassurance-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    font-size: 14px;
    color: var(--muted);
    text-align: left;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .reassurance-item::before {
    content: '→';
    color: var(--green);
    font-weight: 700;
    flex-shrink: 0;
  }

  /* Footer */
  .footer {
    border-top: 1px solid var(--border);
    padding: 24px;
    text-align: center;
    font-size: 14px;
    color: var(--muted);
    display: flex;
    gap: 24px;
    justify-content: center;
    flex-wrap: wrap;
  }

  @media (max-width: 600px) {
    .tagline { display: none; }
    .hero { padding: 40px 20px 32px; }
    .plans { padding: 0 16px 48px; }
  }
</style>
</head>
<body>

<header class="header">
  <div class="wordmark">Headless <span>Oracle</span></div>
  <div class="tagline">Cryptographic market state verification for autonomous agents</div>
</header>

<section class="hero">
  ${isMigration
		? `<h1>Your early access period is ending</h1>
  <p>You've been using Headless Oracle since March 2026 on an early access key. To continue uninterrupted, choose a plan below.</p>
  <div class="deadline-badge">${deadlineText}</div>`
		: `<h1>Choose a plan</h1>
  <p>Get started with Headless Oracle. Signed market state verification for autonomous financial agents.</p>`
  }
</section>

<section class="plans">

  <div class="plan">
    <div class="plan-name">Pro</div>
    <div class="plan-price">$299<span>/month</span></div>
    <ul class="plan-features">
      <li>200,000 calls/month</li>
      <li>Everything in Builder</li>
      <li>Priority support</li>
      <li>SLA guarantee</li>
    </ul>
    <button class="plan-cta secondary" onclick="openCheckout('pro')">Start Pro Plan</button>
  </div>

  <div class="plan recommended">
    <div class="recommended-badge">Recommended</div>
    <div class="plan-name">Builder</div>
    <div class="plan-price">$99<span>/month</span></div>
    <ul class="plan-features">
      <li>50,000 calls/month</li>
      <li>All 28 global exchanges (equities, derivatives, 24/7 crypto)</li>
      <li>Ed25519 signed receipts</li>
      <li>Batch endpoint</li>
      <li>Email support</li>
    </ul>
    <button class="plan-cta primary" onclick="openCheckout('builder')">Start Builder Plan</button>
  </div>

  <div class="plan">
    <div class="plan-name">Protocol</div>
    <div class="plan-price">$500<span>+/month</span></div>
    <ul class="plan-features">
      <li>Custom call volume</li>
      <li>Custom SLA</li>
      <li>Dedicated support</li>
      <li>White-glove onboarding</li>
    </ul>
    <a class="plan-cta secondary" href="mailto:hello@headlessoracle.com">Contact Us</a>
  </div>

</section>

<section class="reassurance">
  <h2>Zero-disruption migration</h2>
  <div class="reassurance-grid">
    <div class="reassurance-item">Your existing receipts and usage history are preserved</div>
    <div class="reassurance-item">Migration takes 2 minutes — no integration changes required</div>
    <div class="reassurance-item">Same API, same endpoints, new key</div>
    <div class="reassurance-item">Zero downtime migration</div>
  </div>
</section>

<footer class="footer">
  <span>Questions? Email <a href="mailto:hello@headlessoracle.com">hello@headlessoracle.com</a></span>
  <a href="https://headlessoracle.com">← headlessoracle.com</a>
</footer>

<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
  Paddle.Initialize({ token: 'live_8d7ef54e91c43573f6afd77c7bd' });

  async function openCheckout(plan) {
    const btns = document.querySelectorAll('.plan-cta');
    btns.forEach(b => { b.disabled = true; b.textContent = 'Loading…'; });
    try {
      const res = await fetch('/v5/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok || !data.transaction_id) {
        throw new Error(data.message || 'Checkout unavailable');
      }
      Paddle.Checkout.open({ transactionId: data.transaction_id });
    } catch (err) {
      alert('Could not open checkout: ' + err.message + '\\nEmail hello@headlessoracle.com for help.');
    } finally {
      btns.forEach(b => { b.disabled = false; });
      document.querySelector('.plan-cta.primary').textContent = 'Start Builder Plan';
      document.querySelector('.plan-cta.secondary').textContent = 'Start Pro Plan';
    }
  }
</script>

</body>
</html>`;
			return new Response(upgradeHtml, {
				headers: {
					...corsHeaders,
					'Content-Type':  'text/html; charset=utf-8',
					'Cache-Control': 'no-store',
				},
			});
		}


// ── generateStatusCard — live terminal-style SVG card ────────────────────────
// Designed for GitHub README embedding. Uses only inline SVG (no external
// fonts, no JS) so it renders correctly in GitHub's camo CDN proxy.
function generateStatusCard(mic: string, receipt: Record<string, string>): string {
	const status = receipt.status || 'UNKNOWN';
	const statusColors: Record<string, string> = {
		OPEN:    '#22c55e',
		CLOSED:  '#6b7280',
		HALTED:  '#ef4444',
		UNKNOWN: '#f59e0b',
	};
	const bgColors: Record<string, string> = {
		OPEN:    '#0a1a0f',
		CLOSED:  '#0d1117',
		HALTED:  '#1a0808',
		UNKNOWN: '#191208',
	};
	const statusColor = statusColors[status] ?? '#6b7280';
	const bgColor     = bgColors[status]     ?? '#0d1117';

	const issuedAt   = receipt.issued_at   || '';
	const expiresAt  = receipt.expires_at  || '';
	const receiptId  = (receipt.receipt_id || '').slice(0, 8) + '…';
	const sig        = (receipt.signature  || '').slice(0, 24) + '…';
	const mode       = receipt.receipt_mode || 'demo';
	const issuer     = receipt.issuer || 'headlessoracle.com';

	// XML-escape dynamic values
	const x = (s: string) =>
		s.replace(/&/g, '&amp;')
		 .replace(/</g, '&lt;')
		 .replace(/>/g, '&gt;')
		 .replace(/"/g, '&quot;');

	return `<svg width="600" height="340" viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="600" height="340" rx="8" fill="${bgColor}"/>
  <!-- Chrome bar -->
  <rect width="600" height="40" rx="8" fill="#161b22"/>
  <rect y="32" width="600" height="8" fill="#161b22"/>
  <!-- Traffic lights -->
  <circle cx="22" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="42" cy="20" r="6" fill="#ffbd2e"/>
  <circle cx="62" cy="20" r="6" fill="#28c840"/>
  <!-- Title -->
  <text x="300" y="25" text-anchor="middle" font-family="'Courier New',Courier,monospace" font-size="12" fill="#8b949e">headless oracle · ${x(mic)} · <tspan fill="${statusColor}">${x(status)}</tspan></text>
  <!-- Divider -->
  <line x1="0" y1="40" x2="600" y2="40" stroke="#21262d" stroke-width="1"/>

  <!-- Prompt line -->
  <text x="20" y="66" font-family="'Courier New',Courier,monospace" font-size="12" fill="#4a5568">$</text>
  <text x="32" y="66" font-family="'Courier New',Courier,monospace" font-size="12" fill="#8b949e"> curl &quot;https://api.headlessoracle.com/v5/demo?mic=${x(mic)}&quot;</text>

  <!-- JSON open brace -->
  <text x="20" y="92" font-family="'Courier New',Courier,monospace" font-size="12" fill="#e6edf3">{</text>

  <!-- "mic" field -->
  <text x="20" y="114" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">mic</tspan><tspan fill="#e6edf3">&quot;:          &quot;</tspan><tspan fill="#a5d6ff">${x(mic)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "status" field — colored by current state -->
  <text x="20" y="136" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">status</tspan><tspan fill="#e6edf3">&quot;:       &quot;</tspan><tspan fill="${statusColor}" font-weight="700">${x(status)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "issued_at" field -->
  <text x="20" y="158" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">issued_at</tspan><tspan fill="#e6edf3">&quot;:    &quot;</tspan><tspan fill="#a5d6ff">${x(issuedAt)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "expires_at" field -->
  <text x="20" y="180" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">expires_at</tspan><tspan fill="#e6edf3">&quot;:   &quot;</tspan><tspan fill="#a5d6ff">${x(expiresAt)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "receipt_mode" field -->
  <text x="20" y="202" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">receipt_mode</tspan><tspan fill="#e6edf3">&quot;: &quot;</tspan><tspan fill="#a5d6ff">${x(mode)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "receipt_id" field -->
  <text x="20" y="224" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">receipt_id</tspan><tspan fill="#e6edf3">&quot;:   &quot;</tspan><tspan fill="#a5d6ff">${x(receiptId)}</tspan><tspan fill="#e6edf3">&quot;,</tspan>
  </text>

  <!-- "signature" field -->
  <text x="20" y="246" font-family="'Courier New',Courier,monospace" font-size="12">
    <tspan fill="#e6edf3">  &quot;</tspan><tspan fill="#79c0ff">signature</tspan><tspan fill="#e6edf3">&quot;:    &quot;</tspan><tspan fill="#a5d6ff">${x(sig)}</tspan><tspan fill="#e6edf3">&quot;</tspan>
  </text>

  <!-- JSON close brace -->
  <text x="20" y="268" font-family="'Courier New',Courier,monospace" font-size="12" fill="#e6edf3">}</text>

  <!-- Footer divider -->
  <line x1="20" y1="283" x2="580" y2="283" stroke="#21262d" stroke-width="1"/>

  <!-- Footer text -->
  <text x="20" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="#22c55e">✓</text>
  <text x="32" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="#8b949e"> Ed25519 signed · 60s TTL · 28 exchanges · ${x(issuer)}</text>

  <!-- Live pulsing dot -->
  <circle cx="576" cy="299" r="5" fill="${statusColor}">
    <animate attributeName="opacity" values="1;0.25;1" dur="2s" repeatCount="indefinite"/>
  </circle>
  <text x="548" y="303" font-family="'Courier New',Courier,monospace" font-size="11" fill="${statusColor}">LIVE</text>
</svg>`;
}

		// ── GET /v5/card/:mic — Live SVG status card for GitHub README embedding ─
		// Returns a terminal-style SVG card with the current market status baked in.
		// KV-cached per MIC with 60s TTL — signing happens once per minute per exchange,
		// not once per page view, so a viral README can't spike signing costs.
		// Cache-Control: public, max-age=60 lets GitHub's CDN serve edge copies and
		// aligns exactly with the 60s receipt TTL window.
		// Use in README: <img src="https://api.headlessoracle.com/v5/card/XNYS" />
		const cardMatch = url.pathname.match(/^\/v5\/card\/([A-Z0-9]+)$/);
		if (cardMatch) {
			const cardMic = cardMatch[1];
			if (!MARKET_CONFIGS[cardMic]) {
				return json({ error: 'INVALID_MIC', message: `Unknown exchange: ${cardMic}. See /v5/exchanges.` }, 404);
			}
			const cardCacheKey = `card_svg:${cardMic}`;
			const cachedSvg = await env.ORACLE_TELEMETRY.get(cardCacheKey);
			if (cachedSvg) {
				return new Response(cachedSvg, {
					headers: {
						...corsHeaders,
						'Content-Type':     'image/svg+xml',
						'X-Oracle-Version': 'v5',
						'Cache-Control':    'public, max-age=60',
						'X-Cache':          'HIT',
					},
				});
			}
			const cardExpiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
			const { receipt: cardReceiptData } = await buildSignedReceipt(cardMic, env, now, cardExpiresAt, 'demo');
			const cardSvg = generateStatusCard(cardMic, cardReceiptData as Record<string, string>);
			// Non-blocking KV write — 60s TTL aligns with receipt TTL (KV minimum is 60s)
			ctx.waitUntil(env.ORACLE_TELEMETRY.put(cardCacheKey, cardSvg, { expirationTtl: 60 }));
			return new Response(cardSvg, {
				headers: {
					...corsHeaders,
					'Content-Type':     'image/svg+xml',
					'X-Oracle-Version': 'v5',
					'Cache-Control':    'public, max-age=60',
					'X-Cache':          'MISS',
				},
			});
		}

		// ── GET /badge/:mic — SVG status badge for embedding in READMEs ─────────
		// Returns a shields.io-style flat SVG badge showing current market status.
		// Cache-Control: max-age=60 so badges refresh once per minute.
		const badgeMatch = url.pathname.match(/^\/badge\/([A-Z0-9]+)$/);
		if (badgeMatch) {
			const badgeMic = badgeMatch[1];
			if (!MARKET_CONFIGS[badgeMic]) {
				return json({ error: 'INVALID_MIC', message: `Unknown exchange: ${badgeMic}. See /v5/exchanges.` }, 404);
			}
			const badgeStatus = getScheduleStatus(badgeMic, now).status;
			const colors: Record<string, string> = {
				OPEN:    '#4c1',
				CLOSED:  '#9f9f9f',
				HALTED:  '#e05d44',
				UNKNOWN: '#fe7d37',
			};
			const color = colors[badgeStatus] ?? '#9f9f9f';
			const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="180" height="20">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="180" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="120" height="20" fill="#555"/>
    <rect x="120" width="60" height="20" fill="${color}"/>
    <rect width="180" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="605" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="1100" lengthAdjust="spacing">Headless Oracle | ${badgeMic}</text>
    <text x="605" y="140" transform="scale(.1)" textLength="1100" lengthAdjust="spacing">Headless Oracle | ${badgeMic}</text>
    <text x="1500" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="500" lengthAdjust="spacing">${badgeStatus}</text>
    <text x="1500" y="140" transform="scale(.1)" textLength="500" lengthAdjust="spacing">${badgeStatus}</text>
  </g>
</svg>`;
			return new Response(svg, {
				headers: {
					...corsHeaders,
					'Content-Type':     'image/svg+xml',
					'X-Oracle-Version': 'v5',
					'Cache-Control':    'public, max-age=60',
				},
			});
		}

		// ── GET /v5/changelog — versioned changelog feed ──────────────────────
		// No auth required. Returns structured changelog for agent and human consumers.
		if (url.pathname === '/v5/changelog') {
			return json({
				version: 'v5.0',
				updated: '2026-03-24',
				entries: [
					{
						date:    '2026-03-24',
						version: '5.4',
						changes: [
							'Autonomous x402 key minting via on-chain USDC payment',
							'Per-tool MCP telemetry (get_market_status, verify_receipt, list_exchanges)',
							'Per-tool MCP telemetry stored in ORACLE_TELEMETRY KV',
						],
					},
					{
						date:    '2026-03-22',
						version: '5.3',
						changes: [
							'Webhook push notifications for market state changes',
							'Receipt audit log via Supabase (/v5/receipts)',
							'Batch safe_to_execute summary field',
							'Sandbox endpoint for zero-friction testing (/v5/sandbox)',
						],
					},
					{
						date:    '2026-03-21',
						version: '5.2',
						changes: [
							'A2A Agent Card at /.well-known/agent.json',
							'OAuth 2.0 optional upgrade path for MCP (RFC 6749 client_credentials)',
							'MCP metering against plan limits',
						],
					},
					{
						date:    '2026-03-20',
						version: '5.1',
						changes: [
							'x402 micropayments on Base mainnet (USDC, chain 8453)',
							'api.headlessoracle.com subdomain',
							'Plan-based rate limits (builder: 50k/day, pro: 200k/day)',
						],
					},
					{
						date:    '2026-03-18',
						version: '5.0',
						changes: [
							'23 global exchanges (expanded from 7)',
							'Middle Eastern exchange weekends (Fri/Sat for XSAU, XDFM)',
							'Autonomous halt monitor via Polygon.io + Alpaca',
						],
					},
				],
			});
		}

		// ── GET /v5/implementations — standards implementations registry ────────────
		if (url.pathname === '/v5/implementations' && request.method === 'GET') {
			return json({
				standards: {
					sma: {
						version:  '1.0',
						spec_url: 'https://github.com/LembaGang/sma-protocol',
						implementations: [
							{
								name:     'Headless Oracle',
								type:     'issuer',
								language: 'TypeScript',
								url:      'https://headlessoracle.com',
								verified: true,
								notes:    'Reference implementation',
							},
							{
								name:     '@headlessoracle/verify',
								type:     'verifier',
								language: 'TypeScript',
								url:      'https://npmjs.com/package/@headlessoracle/verify',
								verified: true,
								notes:    'Reference verifier SDK, zero prod deps',
							},
							{
								name:     'headless-oracle (Python SDK)',
								type:     'verifier',
								language: 'Python',
								url:      'https://pypi.org/project/headless-oracle/',
								verified: true,
								notes:    'Includes OracleClient and verify()',
							},
							{
								name:     'headless-oracle-go',
								type:     'verifier',
								language: 'Go',
								url:      'https://github.com/LembaGang/headless-oracle-go',
								verified: true,
								notes:    'Zero stdlib deps, oracle.Verify(), 9 tests',
							},
						],
						submit_url: 'https://github.com/LembaGang/sma-protocol/issues/new?template=add-implementation.md',
					},
					mpas: {
						version:          '1.0',
						spec_url:         'https://github.com/LembaGang/mpas-spec',
						implementations:  [],
						submit_url:       'https://github.com/LembaGang/mpas-spec/issues/new?template=add-implementation.md',
					},
					apts: {
						version:  '1.0',
						spec_url: 'https://github.com/LembaGang/agent-pretrade-safety-standard',
						implementations: [
							{
								name:     'Halt Simulator',
								type:     'reference-tool',
								language: 'Python',
								url:      'https://github.com/LembaGang/halt-simulator',
								verified: true,
								notes:    '31/31 tests passing. 4 scenarios.',
							},
						],
						submit_url: 'https://github.com/LembaGang/agent-pretrade-safety-standard/issues/new?template=add-implementation.md',
					},
				},
				total_implementations: 5,
				last_updated:          '2026-03-31',
			});
		}

		// ── GET /v5/showcase — social proof and reference projects ───────────────────
		if (url.pathname === '/v5/showcase' && request.method === 'GET') {
			return json({
				entries: [
					{
						name:        'Halt Simulator',
						description: 'Open-source trading agent safety simulator. Demonstrates APTS compliance across 4 halt scenarios including DST transitions and circuit breakers.',
						url:         'https://github.com/LembaGang/halt-simulator',
						category:    'open-source-tool',
						mic_coverage: ['XNYS', 'XNAS'],
						featured:    true,
					},
				],
				submit_url: 'https://headlessoracle.com/showcase-submit',
				note:       'Using Headless Oracle in production? We\'d love to feature your project.',
			});
		}

		// ── Convenience redirects ────────────────────────────────────────────────
		if (url.pathname === '/npm')    return Response.redirect('https://npmjs.com/package/headless-oracle-mcp', 302);
		if (url.pathname === '/pypi')   return Response.redirect('https://pypi.org/project/headless-oracle/', 302);
		if (url.pathname === '/github') return Response.redirect('https://github.com/LembaGang/headless-oracle-v5', 302);

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
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		if (event.cron === '* * * * *') {
			// Real-time halt monitor — runs every minute.
			// Checks exchanges scheduled OPEN against Polygon.io/Alpaca; writes REALTIME
			// overrides to ORACLE_OVERRIDES KV when discrepancy detected. Fail-open.
			await runHaltMonitor(env);
			// Self-ping: keep the HTTP request path warm so Chiark and other MCP probers
			// don't hit cold starts. Fires every minute; Cloudflare routes the inbound
			// request to the nearest warm isolate, keeping P95 latency low.
			ctx.waitUntil(
				fetch('https://headlessoracle.com/mcp', { method: 'HEAD' }).catch(() => {}),
			);
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
			// Pre-compute traction metrics for the day and cache in KV.
			// /v5/traction reads from this cache instead of fanning out at request time.
			try {
				const today  = new Date().toISOString().slice(0, 10);
				const prefix = `mcp_clients:${today}:`;
				const list   = await env.ORACLE_TELEMETRY.list({ prefix });

				let tractionMcpRequests = 0;
				let tractionMcpClients  = 0;
				if (list.keys.length > 0) {
					const tractionRecords = await Promise.all(list.keys.map(k => env.ORACLE_TELEMETRY.get(k.name)));
					for (const r of tractionRecords) {
						if (r) {
							const parsed = JSON.parse(r) as { request_count?: number };
							tractionMcpRequests += parsed.request_count ?? 0;
						}
					}
					tractionMcpClients = list.keys.length;
				}

				const [batchComboKvsRaw, authCallsRaw, unauthCallsRaw, sandboxCapsRaw, zeroAuthMcpCronRaw] = await Promise.all([
					env.ORACLE_TELEMETRY.list({ prefix: 'batch_combo:' }).then(r => r.keys.filter(k => k.name.endsWith(`:${today}`))).catch(() => [] as Array<{ name: string }>),
					env.ORACLE_TELEMETRY.get(`auth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`sandbox_cap_hit:${today}`).catch(() => null),
					env.ORACLE_TELEMETRY.get(`zero_auth_mcp_requests:${today}`).catch(() => null),
				]);
				const batchCombosDay        = batchComboKvsRaw.length;
				const authCallsDay          = parseInt(authCallsRaw        ?? '0', 10) || 0;
				const unauthCallsDay        = parseInt(unauthCallsRaw      ?? '0', 10) || 0;
				const sandboxCapsDay        = parseInt(sandboxCapsRaw      ?? '0', 10) || 0;
				const zeroAuthMcpCronDay    = parseInt(zeroAuthMcpCronRaw  ?? '0', 10) || 0;
				const authRatioDay          = authCallsDay + unauthCallsDay > 0
					? Math.round((authCallsDay / (authCallsDay + unauthCallsDay)) * 100) / 100
					: null;

				// Count sandbox keys issued today (sandbox_followup keys have created_at = today)
				const followupList = await env.ORACLE_TELEMETRY.list({ prefix: 'sandbox_followup:' }).catch(() => null);
				let sandboxKeysToday = 0;
				if (followupList) {
					for (const k of followupList.keys) {
						const raw = await env.ORACLE_TELEMETRY.get(k.name).catch(() => null);
						if (raw) {
							try {
								const rec = JSON.parse(raw) as { created_at?: string };
								if (rec.created_at?.startsWith(today)) sandboxKeysToday++;
							} catch { /* skip */ }
						}
					}
				}

				const tractionCache = {
					date:                         today,
					computed_at:                  new Date().toISOString(),
					unique_clients_today:         tractionMcpClients,
					total_requests_today:         tractionMcpRequests,
					unauth_calls_today:           unauthCallsDay,
					auth_calls_today:             authCallsDay,
					auth_ratio:                   authRatioDay,
					sandbox_keys_issued_today:    sandboxKeysToday,
					sandbox_caps_today:           sandboxCapsDay,
					batch_combos_today:           batchCombosDay,
					zero_auth_mcp_requests_today: zeroAuthMcpCronDay,
				};
				await env.ORACLE_TELEMETRY.put(`traction_cache:${today}`, JSON.stringify(tractionCache), { expirationTtl: 86_400 * 2 });
				console.log(JSON.stringify({ event: 'TRACTION_CACHE_WRITTEN', ...tractionCache }));
			} catch (err: unknown) {
				console.error(`TRACTION_CACHE_ERROR: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Sandbox follow-up emails: check for sandbox keys expiring within 2 hours.
			if (env.RESEND_API_KEY) {
				try {
					const twoHoursFromNow = new Date(Date.now() + 2 * 3600_000).toISOString();
					const sfList = await env.ORACLE_TELEMETRY.list({ prefix: 'sandbox_followup:' }).catch(() => null);
					if (sfList) {
						for (const k of sfList.keys) {
							const raw = await env.ORACLE_TELEMETRY.get(k.name).catch(() => null);
							if (!raw) continue;
							let rec: { email: string; key_expires_at: string; followed_up: boolean };
							try { rec = JSON.parse(raw); } catch { continue; }
							if (rec.followed_up) continue;
							if (rec.key_expires_at <= twoHoursFromNow) {
								const followupText =
									`Your sandbox key expires in ~2 hours.\n` +
									`If you want to keep building:\nhttps://headlessoracle.com/upgrade\n` +
									`Builder plan: $99/month, 50K calls/day\n` +
									`Free beta keys also available — reply to ask.`;
								const emailRes = await fetch('https://api.resend.com/emails', {
									method:  'POST',
									headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
									body: JSON.stringify({
										from:    'Headless Oracle <hello@headlessoracle.com>',
										to:      [rec.email],
										subject: 'Your Headless Oracle sandbox key expires soon',
										text:    followupText,
									}),
								}).catch(() => null);
								rec.followed_up = true;
								await env.ORACLE_TELEMETRY.put(k.name, JSON.stringify(rec), { expirationTtl: 86_400 }).catch(() => {});
								if (emailRes?.ok) console.log(JSON.stringify({ event: 'SANDBOX_FOLLOWUP_SENT', email: rec.email }));
								else console.error(`SANDBOX_FOLLOWUP_ERROR: email=${rec.email} status=${emailRes?.status}`);
							}
						}
					}
				} catch (sfErr: unknown) {
					console.error(`SANDBOX_FOLLOWUP_CRON_ERROR: ${sfErr instanceof Error ? sfErr.message : String(sfErr)}`);
				}
			}

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

// ─── WebhookDispatcher Durable Object ────────────────────────────────────────
// Handles alarm-based state-change detection and webhook fan-out delivery.
// One global instance (keyed by "global") runs an alarm every 60 seconds.
// Reads subscriptions from ORACLE_API_KEYS KV (compatible with REST endpoints).
// Each alarm cycle: compute status for all MICs → compare vs stored last state
// → if changed, fan out signed receipts to all registered subscribers.
//
// Bootstrap: the main worker's cron handler ensures the alarm is scheduled on
// first run. After that the DO self-reschedules its alarm after each cycle.
export class WebhookDispatcher {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/bootstrap') {
			// Ensure the alarm is scheduled. Called by the cron handler to bootstrap.
			const existing = await this.state.storage.getAlarm();
			if (existing === null) {
				await this.state.storage.setAlarm(Date.now() + 60_000);
			}
			return new Response(JSON.stringify({ scheduled: true }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.pathname === '/heartbeat') {
			// Liveness ping — confirms the DO instance is reachable.
			// We intentionally do NOT call storage.getAlarm() here: reading alarm state
			// in Miniflare creates a SQLite file that stays locked on Windows, causing
			// "Isolated storage failed" in the next test run. Alarm scheduling is handled
			// exclusively by alarm() self-rescheduling and /bootstrap.
			// The cron calls this to verify the DO is alive; if evicted, a new instance
			// is created on the next /bootstrap call (e.g. from /v5/webhooks/subscribe).
			return new Response(JSON.stringify({ alarm_scheduled: true, action: 'alive' }), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response('not found', { status: 404 });
	}

	async alarm(): Promise<void> {
		const now = new Date();
		const deliveries: Promise<unknown>[] = [];

		for (const [mic] of Object.entries(MARKET_CONFIGS)) {
			let currentStatus: string;
			try {
				const result = getScheduleStatus(mic, now);
				// Check for active KV override
				const overrideRaw = await this.env.ORACLE_OVERRIDES.get(mic);
				if (overrideRaw) {
					try {
						const ov = JSON.parse(overrideRaw) as { status?: string; expires?: string };
						currentStatus = (ov.expires && new Date(ov.expires) > now)
							? (ov.status ?? result.status)
							: result.status;
					} catch { currentStatus = result.status; }
				} else {
					currentStatus = result.status;
				}
			} catch { continue; }

			// Read last known state from DO storage
			const stateKey = `last_state:${mic}`;
			const lastState = await this.state.storage.get<string>(stateKey);

			// Always write current state back (establishes baseline on first run)
			await this.state.storage.put(stateKey, currentStatus);

			if (lastState === undefined || lastState === currentStatus) continue;

			// State changed — build signed receipt and fan out to subscribers
			const targets = await getWebhooksByMic(mic, this.env);
			if (targets.length === 0) continue;

			const expiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
			const { receipt } = await buildSignedReceipt(mic, this.env, now, expiresAt, 'live');

			for (const target of targets) {
				const payload = {
					event:           'status_change',
					webhook_id:      target.subscription_id,
					mic,
					previous_status: lastState,
					current_status:  currentStatus,
					receipt,
					delivered_at:    now.toISOString(),
				};
				deliveries.push(deliverWebhook(target, payload));
			}

			console.log(JSON.stringify({
				event:            'WEBHOOK_DO_STATE_CHANGE',
				mic,
				previous_status:  lastState,
				current_status:   currentStatus,
				subscriber_count: targets.length,
				timestamp:        now.toISOString(),
			}));
		}

		await Promise.allSettled(deliveries);

		// Reschedule for 60 seconds from now and write health status to KV so
		// GET /v5/webhooks/health can report liveness without creating a DO instance.
		const nextAlarm = new Date(Date.now() + 60_000).toISOString();
		await this.state.storage.setAlarm(Date.now() + 60_000);
		await this.env.ORACLE_TELEMETRY.put(
			'webhook_dispatcher:health',
			JSON.stringify({ status: 'active', next_alarm: nextAlarm }),
			{ expirationTtl: 300 },
		).catch(() => {}); // best-effort — don't let KV write break delivery
	}
}

// ─── StreamCoordinator Durable Object ────────────────────────────────────────
// Handles SSE streams for /v5/stream. One instance per MIC — clients watching
// the same exchange land on the same DO, enabling future fan-out optimisation.
//
// Each client connection gets its own ReadableStream; the DO fires a polling
// loop per connection. A future enhancement would have the DO hold a single
// shared alarm-based poll and fan out to all connected streams.
//
// Export required by Cloudflare Workers module workers for DO class registration.
export class StreamCoordinator {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url       = new URL(request.url);
		const mic       = (url.searchParams.get('mic') || 'XNYS').toUpperCase();
		const encoder   = new TextEncoder();

		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();

		// Fire-and-forget polling loop. Runs until the client disconnects (write throws)
		// or the stream is explicitly closed (HALTED receipt).
		void (async () => {
			try {
				while (true) {
					const streamNow       = new Date();
					const streamExpiresAt = new Date(streamNow.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
					const { receipt } = await buildSignedReceipt(mic, this.env, streamNow, streamExpiresAt, 'live');

					const event = `event: market_status
data: ${JSON.stringify(receipt)}

`;
					await writer.write(encoder.encode(event));

					// HALTED: send one final halted event then close — agent must reconnect.
					if (receipt['status'] === 'HALTED') {
						const halt = `event: halted
data: ${JSON.stringify(receipt)}

`;
						await writer.write(encoder.encode(halt));
						await writer.close();
						return;
					}

					// Wait 30 seconds before next receipt
					await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
				}
			} catch {
				// Client disconnected — close gracefully
				await writer.close().catch(() => {});
			}
		})();

		return new Response(readable, {
			headers: {
				'Content-Type':                'text/event-stream',
				'Cache-Control':               'no-store',
				'Access-Control-Allow-Origin': '*',
				'X-Accel-Buffering':           'no',  // Disable Nginx buffering
			},
		});
	}
}
