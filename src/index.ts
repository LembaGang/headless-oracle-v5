import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

// ─── Environment ─────────────────────────────────────────────────────────────

export interface Env {
	ED25519_PRIVATE_KEY: string;
	ED25519_PUBLIC_KEY: string;
	MASTER_API_KEY: string;
	BETA_API_KEYS: string;
	PUBLIC_KEY_ID: string;
	ORACLE_OVERRIDES: KVNamespace; // Cloudflare KV — manual circuit-breaker overrides
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

// ─── Market Configuration ────────────────────────────────────────────────────
//
// All times are LOCAL to the exchange timezone.
// DST is handled automatically via Intl.DateTimeFormat with named IANA timezones.
// No hardcoded UTC offsets anywhere in this file.

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
	holidays: string[]; // YYYY-MM-DD in local exchange timezone
	halfDays?: HalfDay[];
	lunchBreak?: LunchBreak;
}

const MARKET_CONFIGS: Record<string, MarketConfig> = {

	// ── United States ──────────────────────────────────────────────────────────
	XNYS: {
		name: 'New York Stock Exchange',
		timezone: 'America/New_York',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 0,
		holidays: [
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
		halfDays: [
			{ date: '2026-11-27', closeHour: 13, closeMinute: 0 }, // Black Friday
			{ date: '2026-12-24', closeHour: 13, closeMinute: 0 }, // Christmas Eve
		],
	},

	XNAS: {
		name: 'NASDAQ',
		timezone: 'America/New_York',
		openHour: 9, openMinute: 30,
		closeHour: 16, closeMinute: 0,
		holidays: [
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
		halfDays: [
			{ date: '2026-11-27', closeHour: 13, closeMinute: 0 },
			{ date: '2026-12-24', closeHour: 13, closeMinute: 0 },
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
		holidays: [
			'2026-01-01', // New Year's Day
			'2026-04-03', // Good Friday
			'2026-04-06', // Easter Monday
			'2026-05-04', // Early May Bank Holiday
			'2026-05-25', // Spring Bank Holiday
			'2026-08-31', // Summer Bank Holiday
			'2026-12-25', // Christmas Day
			'2026-12-28', // Boxing Day (observed; Dec 26 falls on Saturday)
		],
		halfDays: [
			{ date: '2026-12-24', closeHour: 12, closeMinute: 30 }, // Christmas Eve
			{ date: '2026-12-31', closeHour: 12, closeMinute: 30 }, // New Year's Eve
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
		holidays: [
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
	},

	// ── Euronext Paris ────────────────────────────────────────────────────────
	// DST: EU clocks spring forward 29 March 2026 (CET→CEST, UTC+1→UTC+2).
	XPAR: {
		name: 'Euronext Paris',
		timezone: 'Europe/Paris',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 30,
		holidays: [
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
		halfDays: [
			{ date: '2026-12-24', closeHour: 14, closeMinute: 5 }, // Christmas Eve
			{ date: '2026-12-31', closeHour: 14, closeMinute: 5 }, // New Year's Eve
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
		holidays: [
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
		halfDays: [
			{ date: '2026-02-16', closeHour: 12, closeMinute: 0 }, // CNY Eve (morning only)
		],
	},

	// ── Singapore ─────────────────────────────────────────────────────────────
	// No DST. SGT = UTC+8 year-round.
	XSES: {
		name: 'Singapore Exchange',
		timezone: 'Asia/Singapore',
		openHour: 9, openMinute: 0,
		closeHour: 17, closeMinute: 0,
		holidays: [
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
	},
};

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

	const { weekday, dateStr, hour, minute } = getLocalTimeParts(config.timezone, now);

	// Weekend
	if (weekday === 'Sat' || weekday === 'Sun') {
		return { status: 'CLOSED', source: 'SCHEDULE' };
	}

	// Full holiday
	if (config.holidays.includes(dateStr)) {
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

		if (weekday !== 'Sat' && weekday !== 'Sun' && !config.holidays.includes(dateStr)) {
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

	return null; // Unreachable under normal circumstances
}

// ─── Signing ─────────────────────────────────────────────────────────────────

async function signPayload(payload: Record<string, string>, privKeyHex: string): Promise<string> {
	const canonical = JSON.stringify(payload);
	const msgBytes  = new TextEncoder().encode(canonical);
	const privKey   = fromHex(privKeyHex);
	const sig       = await ed.sign(msgBytes, privKey);
	return toHex(sig);
}

// ─── API Key Validation ───────────────────────────────────────────────────────

function isValidApiKey(key: string, env: Env): boolean {
	if (key === env.MASTER_API_KEY) return true;
	if (env.BETA_API_KEYS) {
		const betaKeys = env.BETA_API_KEYS.split(',').map((k) => k.trim());
		if (betaKeys.includes(key)) return true;
	}
	return false;
}

// ─── Supported Exchange Directory ─────────────────────────────────────────────

const SUPPORTED_EXCHANGES = Object.entries(MARKET_CONFIGS).map(([mic, cfg]) => ({
	mic,
	name:     cfg.name,
	timezone: cfg.timezone,
}));

// ─── Worker ───────────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const now = new Date();

		const corsHeaders = {
			'Access-Control-Allow-Origin':  '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, X-Oracle-Key',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			});

		try {
			// ── Auth gate — /v5/status requires X-Oracle-Key ─────────────
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey) {
					return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
				}
				if (!isValidApiKey(apiKey, env)) {
					return json({ error: 'INVALID_API_KEY' }, 403);
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
						key_id:     env.PUBLIC_KEY_ID || 'key_2026_v1',
						algorithm:  'Ed25519',
						format:     'hex',
						public_key: env.ED25519_PUBLIC_KEY || '',
					}],
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

				return json({
					mic,
					name:           config.name,
					timezone:       config.timezone,
					queried_at:     now.toISOString(),
					current_status: currentStatus.status,
					next_open:      nextSession?.next_open  ?? null,
					next_close:     nextSession?.next_close ?? null,
					note:           'Times are UTC. Schedule-based only — does not reflect real-time halts or overrides.',
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

				try {
					// ─ TIER 0: Manual Override (circuit breakers, emergency halts) ─
					//
					// Set overrides via the Cloudflare dashboard:
					//   Workers & Pages → KV → ORACLE_OVERRIDES → Add entry
					//   Key:   MIC code, e.g. "XNYS"
					//   Value: {"status":"HALTED","reason":"NYSE circuit breaker L1","expires":"2026-03-09T20:00:00Z"}
					//
					// Clear the key to return to normal schedule-based operation.
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
									receipt_id:    crypto.randomUUID(),
									issued_at:     now.toISOString(),
									mic,
									status:        override.status,
									source:        'OVERRIDE',
									reason:        override.reason,
									terms_hash:    'v5.0-beta',
									public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
								};
								const signature = await signPayload(payload, env.ED25519_PRIVATE_KEY);
								return json({ ...payload, signature });
							}
						}
					}

					// ─ TIER 1: Normal schedule-based operation ────────────────
					const { status, source } = getScheduleStatus(mic, now);

					const payload = {
						receipt_id:    crypto.randomUUID(),
						issued_at:     now.toISOString(),
						mic,
						status,
						source,
						terms_hash:    'v5.0-beta',
						public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
					};

					const signature = await signPayload(payload, env.ED25519_PRIVATE_KEY);
					return json({ ...payload, signature });

				} catch (tier1Error: unknown) {
					// ─ TIER 2: Fail-Closed Safety Net ────────────────────────
					const msg = tier1Error instanceof Error ? tier1Error.message : 'Unknown error';
					console.error(`ORACLE_TIER_1_FAILURE: ${msg}`);

					try {
						const safePayload = {
							receipt_id:    crypto.randomUUID(),
							issued_at:     now.toISOString(),
							mic,
							status:        'UNKNOWN',
							source:        'SYSTEM',
							terms_hash:    'v5.0-beta',
							public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
						};
						const safeSig = await signPayload(safePayload, env.ED25519_PRIVATE_KEY);
						return json({ ...safePayload, signature: safeSig });

					} catch (tier2Error: unknown) {
						// ─ TIER 3: Catastrophic — signing system offline ──────
						const msg2 = tier2Error instanceof Error ? tier2Error.message : 'Unknown error';
						console.error(`ORACLE_TIER_2_CATASTROPHIC: ${msg2}`);
						return json({
							error:   'CRITICAL_FAILURE',
							message: 'Oracle signature system offline. Treat as UNKNOWN. Halt all execution.',
							status:  'UNKNOWN',
							source:  'SYSTEM',
						}, 500);
					}
				}
			}

			// ── 404 ──────────────────────────────────────────────────────
			return json({ error: 'Not Found' }, 404);

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
};
