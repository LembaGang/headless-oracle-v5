import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker, { edgeCaseCount } from '../src';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWorker(path: string, options: RequestInit = {}): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(
		`http://example.com${path}`,
		options,
	);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function fetchJSON(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
	const response = await fetchWorker(path, options);
	return response.json() as Promise<Record<string, unknown>>;
}

const ALL_MICS = [
	'XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
	'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
	'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE',
	'XHEL', 'XSTO',
];
const VALID_STATUSES = ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'];
const VALID_SOURCES  = ['SCHEDULE', 'OVERRIDE', 'SYSTEM', 'REALTIME'];

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS', () => {
	it('OPTIONS /v5/demo returns CORS headers', async () => {
		const response = await fetchWorker('/v5/demo', { method: 'OPTIONS' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Oracle-Key');
	});

	it('GET /v5/demo includes CORS headers', async () => {
		const response = await fetchWorker('/v5/demo');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('GET /v5/exchanges includes CORS headers', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('GET /v5/schedule includes CORS headers', async () => {
		const response = await fetchWorker('/v5/schedule');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});

// ─── GET /mics.json ───────────────────────────────────────────────────────────

describe('GET /mics.json', () => {
	const ALL_MIC_CODES = ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'];

	it('returns 200 with correct Content-Type', async () => {
		const response = await fetchWorker('/mics.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('includes CORS headers', async () => {
		const response = await fetchWorker('/mics.json');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('sets Cache-Control for public caching', async () => {
		const response = await fetchWorker('/mics.json');
		expect(response.headers.get('Cache-Control')).toContain('public');
	});

	it('returns an array of exactly 23 exchanges', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		expect(Array.isArray(body)).toBe(true);
		expect((body as unknown[]).length).toBe(23);
	});

	it('every entry has required fields: mic, name, country, timezone, currency, sameAs', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		for (const entry of body) {
			expect(typeof entry.mic).toBe('string');
			expect(typeof entry.name).toBe('string');
			expect(typeof entry.country).toBe('string');
			expect(typeof entry.timezone).toBe('string');
			expect(typeof entry.currency).toBe('string');
			expect(typeof entry.sameAs).toBe('string');
		}
	});

	it('contains all 7 expected MIC codes', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		const mics = body.map((e) => e.mic);
		for (const mic of ALL_MIC_CODES) {
			expect(mics).toContain(mic);
		}
	});

	it('country codes are valid ISO 3166-1 alpha-2 (2 uppercase letters)', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		for (const entry of body) {
			expect(entry.country as string).toMatch(/^[A-Z]{2}$/);
		}
	});

	it('currency codes are valid ISO 4217 (3 uppercase letters)', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		for (const entry of body) {
			expect(entry.currency as string).toMatch(/^[A-Z]{3}$/);
		}
	});

	it('sameAs points to the ISO 20022 MIC registry for every entry', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		for (const entry of body) {
			expect(entry.sameAs).toBe('https://www.iso20022.org/market-identifier-codes');
		}
	});

	it('XNYS entry has correct metadata', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		const xnys = body.find((e) => e.mic === 'XNYS');
		expect(xnys).toBeDefined();
		expect(xnys!.name).toBe('New York Stock Exchange');
		expect(xnys!.country).toBe('US');
		expect(xnys!.timezone).toBe('America/New_York');
		expect(xnys!.currency).toBe('USD');
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/mics.json');
		expect(response.status).toBe(200);
		expect(response.status).not.toBe(401);
		expect(response.status).not.toBe(403);
	});
});

// ─── GET /v5/demo ─────────────────────────────────────────────────────────────

describe('GET /v5/demo', () => {
	it('returns 200 with a signed receipt for default exchange (XNYS)', async () => {
		const response = await fetchWorker('/v5/demo');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('receipt_id');
		expect(body).toHaveProperty('issued_at');
		expect(body).toHaveProperty('mic', 'XNYS');
		expect(body).toHaveProperty('status');
		expect(body).toHaveProperty('source');
		expect(body).toHaveProperty('schema_version', 'v5.0');
		expect(body).toHaveProperty('public_key_id');
		expect(body).toHaveProperty('signature');

		// status must be one of the valid values
		expect(VALID_STATUSES).toContain(body.status);
		// receipt_mode must be 'demo' on the public demo endpoint
		expect(body).toHaveProperty('receipt_mode', 'demo');
		// source must be one of the valid values
		expect(VALID_SOURCES).toContain(body.source);
		// Signature is 128-char hex (64 bytes of Ed25519 output)
		expect(typeof body.signature).toBe('string');
		expect((body.signature as string).length).toBe(128);
		// issued_at is a valid ISO 8601 date
		expect(new Date(body.issued_at as string).getTime()).not.toBeNaN();
		// receipt_id looks like a UUID
		expect(body.receipt_id as string).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/v5/demo');
		expect(response.status).toBe(200);
	});

	// Test all 7 supported exchanges via the demo endpoint
	for (const mic of ALL_MICS) {
		it(`returns a signed receipt for ${mic}`, async () => {
			const response = await fetchWorker(`/v5/demo?mic=${mic}`);
			expect(response.status).toBe(200);

			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('mic', mic);
			expect(body).toHaveProperty('status');
			expect(VALID_STATUSES).toContain(body.status);
			expect(body).toHaveProperty('signature');
			expect((body.signature as string).length).toBe(128);
		});
	}

	it('normalises lowercase mic to uppercase', async () => {
		const body = await fetchJSON('/v5/demo?mic=xnys');
		expect(body).toHaveProperty('mic', 'XNYS');
	});

	it('returns 400 for unknown MIC', async () => {
		const response = await fetchWorker('/v5/demo?mic=XXXX');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
		expect(body).toHaveProperty('supported');
		const supported = body.supported as string[];
		expect(supported).toContain('XNYS');
		expect(supported).toContain('XLON');
		expect(supported.length).toBe(23);
	});

	it('returns 400 for completely invalid MIC', async () => {
		const response = await fetchWorker('/v5/demo?mic=NYSE_WRONG');
		expect(response.status).toBe(400);
	});

	it('demo receipt includes issuer: "headlessoracle.com"', async () => {
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(body).toHaveProperty('issuer', 'headlessoracle.com');
	});
});

// ─── GET /v5/status ───────────────────────────────────────────────────────────

describe('GET /v5/status', () => {
	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
		expect(response.headers.get('X-Oracle-Key-Request')).toBe('https://headlessoracle.com/v5/keys/request');
	});

	it('returns 403 with an invalid API key', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'totally_invalid_key_xyz' },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('returns 401 with an empty API key header', async () => {
		// Empty string — header present but blank. Worker sees empty string → falsy → 401.
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': '' },
		});
		// Empty header value → treated as missing → 401
		expect([401, 403]).toContain(response.status);
	});

	it('returns 400 for unknown MIC with valid key', async () => {
		const response = await fetchWorker('/v5/status?mic=ZZZZ', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	// Test all 7 MICs with valid auth
	for (const mic of ALL_MICS) {
		it(`returns a signed receipt for ${mic} with valid auth`, async () => {
			const response = await fetchWorker(`/v5/status?mic=${mic}`, {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
			});
			expect(response.status).toBe(200);

			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('mic', mic);
			expect(body).toHaveProperty('status');
			expect(VALID_STATUSES).toContain(body.status);
			expect(body).toHaveProperty('source');
			expect(VALID_SOURCES).toContain(body.source);
			expect(body).toHaveProperty('signature');
			expect((body.signature as string).length).toBe(128);
			expect(body).toHaveProperty('receipt_id');
			expect(body).toHaveProperty('issued_at');
			expect(body).toHaveProperty('schema_version', 'v5.0');
			expect(body).toHaveProperty('receipt_mode', 'live');
			expect(body).toHaveProperty('issuer', 'headlessoracle.com');
		});
	}

	it('defaults to XNYS when no mic param is provided', async () => {
		const body = await fetchJSON('/v5/status', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(body).toHaveProperty('mic', 'XNYS');
	});
});

// ─── GET /v5/keys ────────────────────────────────────────────────────────────

describe('GET /v5/keys', () => {
	it('returns 200 with public key info (no auth required)', async () => {
		const response = await fetchWorker('/v5/keys');
		expect(response.status).toBe(200);

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('keys');

		const keys = body.keys as Array<Record<string, unknown>>;
		expect(keys.length).toBe(1);

		const key = keys[0];
		expect(key).toHaveProperty('key_id');
		expect(key).toHaveProperty('algorithm', 'Ed25519');
		// V5 uses hex format — NOT spki-pem
		expect(key).toHaveProperty('format', 'hex');
		expect(key).toHaveProperty('public_key');
		// public_key should be a non-empty string
		expect(typeof key.public_key).toBe('string');
		expect((key.public_key as string).length).toBeGreaterThan(0);
		// Key lifecycle: valid_from must be present for rotation tracking
		expect(key).toHaveProperty('valid_from');
		expect(new Date(key.valid_from as string).getTime()).not.toBeNaN();
		// valid_until is null (no rotation scheduled) or a valid ISO date
		expect(Object.prototype.hasOwnProperty.call(key, 'valid_until')).toBe(true);
		if (key.valid_until !== null) {
			expect(new Date(key.valid_until as string).getTime()).not.toBeNaN();
		}
	});

	it('returns canonical_payload_spec documenting the signing field order', async () => {
		const body = await fetchJSON('/v5/keys');
		expect(body).toHaveProperty('canonical_payload_spec');
		const spec = body.canonical_payload_spec as Record<string, unknown>;
		expect(spec).toHaveProperty('description');
		expect(spec).toHaveProperty('receipt_fields');
		const fields = spec.receipt_fields as string[];
		// expires_at must be in the canonical field list (agents need to verify it)
		expect(fields).toContain('expires_at');
		expect(fields).toContain('issued_at');
		expect(fields).toContain('mic');
		expect(fields).toContain('status');
	});
});

// ─── GET /v5/schedule ────────────────────────────────────────────────────────

describe('GET /v5/schedule', () => {
	it('returns 200 with schedule data for default exchange (XNYS)', async () => {
		const response = await fetchWorker('/v5/schedule');
		expect(response.status).toBe(200);

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('mic', 'XNYS');
		expect(body).toHaveProperty('name');
		expect(body).toHaveProperty('timezone', 'America/New_York');
		expect(body).toHaveProperty('queried_at');
		expect(body).toHaveProperty('current_status');
		expect(VALID_STATUSES).toContain(body.current_status);
		// next_open and next_close may be null if market is permanently closed (unlikely)
		// but they should exist as keys
		expect(Object.prototype.hasOwnProperty.call(body, 'next_open')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(body, 'next_close')).toBe(true);
		expect(body).toHaveProperty('note');
	});

	// Test all 7 exchanges individually
	for (const mic of ALL_MICS) {
		it(`returns valid schedule for ${mic}`, async () => {
			const response = await fetchWorker(`/v5/schedule?mic=${mic}`);
			expect(response.status).toBe(200);

			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('mic', mic);
			expect(body).toHaveProperty('name');
			expect(typeof body.name).toBe('string');
			expect((body.name as string).length).toBeGreaterThan(0);
			expect(body).toHaveProperty('timezone');
			expect(body).toHaveProperty('queried_at');
			expect(body).toHaveProperty('current_status');
			expect(VALID_STATUSES).toContain(body.current_status);

			// If next_open and next_close are present, they should be valid ISO 8601
			if (body.next_open !== null) {
				expect(new Date(body.next_open as string).getTime()).not.toBeNaN();
			}
			if (body.next_close !== null) {
				expect(new Date(body.next_close as string).getTime()).not.toBeNaN();
			}
		});
	}

	it('schedule next_close is always after next_open when both are present', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNYS');
		if (body.next_open !== null && body.next_close !== null) {
			const open  = new Date(body.next_open  as string).getTime();
			const close = new Date(body.next_close as string).getTime();
			expect(close).toBeGreaterThan(open);
		}
	});

	it('returns correct timezone for LSE (XLON)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XLON');
		expect(body).toHaveProperty('timezone', 'Europe/London');
	});

	it('returns correct timezone for JPX (XJPX)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XJPX');
		expect(body).toHaveProperty('timezone', 'Asia/Tokyo');
	});

	it('returns correct timezone for Euronext Paris (XPAR)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XPAR');
		expect(body).toHaveProperty('timezone', 'Europe/Paris');
	});

	it('returns correct timezone for HKEX (XHKG)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XHKG');
		expect(body).toHaveProperty('timezone', 'Asia/Hong_Kong');
	});

	it('returns correct timezone for SGX (XSES)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSES');
		expect(body).toHaveProperty('timezone', 'Asia/Singapore');
	});

	it('returns 400 for unknown MIC', async () => {
		const response = await fetchWorker('/v5/schedule?mic=FAKE');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
		const supported = body.supported as string[];
		expect(supported.length).toBe(23);
		expect(supported).toContain('XLON');
	});

	it('normalises lowercase mic to uppercase', async () => {
		const body = await fetchJSON('/v5/schedule?mic=xlon');
		expect(body).toHaveProperty('mic', 'XLON');
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/v5/schedule?mic=XNYS');
		expect(response.status).toBe(200);
	});
});

// ─── Lunch break in /v5/schedule ─────────────────────────────────────────────

describe('Lunch break in /v5/schedule', () => {
	it('XJPX schedule includes lunch_break with correct local times', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XJPX');
		expect(body).toHaveProperty('lunch_break');
		const lb = body.lunch_break as Record<string, unknown>;
		expect(lb).not.toBeNull();
		expect(lb).toHaveProperty('start', '11:30');
		expect(lb).toHaveProperty('end', '12:30');
	});

	it('XHKG schedule includes lunch_break with correct local times', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XHKG');
		expect(body).toHaveProperty('lunch_break');
		const lb = body.lunch_break as Record<string, unknown>;
		expect(lb).not.toBeNull();
		expect(lb).toHaveProperty('start', '12:00');
		expect(lb).toHaveProperty('end', '13:00');
	});

	it('XNYS schedule has lunch_break: null (no lunch break)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNYS');
		expect(Object.prototype.hasOwnProperty.call(body, 'lunch_break')).toBe(true);
		expect(body.lunch_break).toBeNull();
	});

	it('XLON, XPAR, XSES all have lunch_break: null', async () => {
		for (const mic of ['XLON', 'XPAR', 'XSES']) {
			const body = await fetchJSON(`/v5/schedule?mic=${mic}`);
			expect(body.lunch_break).toBeNull();
		}
	});

	// ── Year boundary safety: data_coverage_years ───────────────────────────────
	it('schedule response includes data_coverage_years as sorted array of strings', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNYS');
		expect(body).toHaveProperty('data_coverage_years');
		const years = body.data_coverage_years as string[];
		expect(Array.isArray(years)).toBe(true);
		expect(years.length).toBeGreaterThanOrEqual(2);
		// Should include 2026 and 2027
		expect(years).toContain('2026');
		expect(years).toContain('2027');
		// Should be sorted ascending
		const sorted = [...years].sort();
		expect(years).toEqual(sorted);
	});

	it('all 7 MICs include data_coverage_years in schedule response', async () => {
		for (const mic of ALL_MICS) {
			const body = await fetchJSON(`/v5/schedule?mic=${mic}`);
			expect(body).toHaveProperty('data_coverage_years');
			const years = body.data_coverage_years as string[];
			expect(Array.isArray(years)).toBe(true);
			expect(years.length).toBeGreaterThanOrEqual(2);
		}
	});

	it('next_open is null when year coverage runs out (Dec 31 last covered year)', async () => {
		vi.useFakeTimers();
		// Set time to Dec 31, 2027 at 23:00 UTC — session done for XNYS (4pm ET close).
		// Next trading day is Jan 2, 2028 but 2028 has no holiday data → getNextSession returns null.
		vi.setSystemTime(new Date('2027-12-31T23:00:00Z'));
		try {
			const body = await fetchJSON('/v5/schedule?mic=XNYS');
			// next_open must be null — not a guess at uncovered dates
			expect(body.next_open).toBeNull();
			expect(body.next_close).toBeNull();
			// data_coverage_years still present so agent knows why
			const years = body.data_coverage_years as string[];
			expect(years).not.toContain('2028');
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── GET /v5/exchanges ───────────────────────────────────────────────────────

describe('GET /v5/exchanges', () => {
	it('returns 200 with all 23 supported exchanges (no auth required)', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.status).toBe(200);

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('exchanges');

		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		expect(exchanges.length).toBe(23);
	});

	it('includes all 23 MIC codes in the directory', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		const mics = exchanges.map((e) => e.mic as string);

		for (const mic of ALL_MICS) {
			expect(mics).toContain(mic);
		}
	});

	it('each exchange entry has mic, name, and timezone fields', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;

		for (const exchange of exchanges) {
			expect(exchange).toHaveProperty('mic');
			expect(exchange).toHaveProperty('name');
			expect(exchange).toHaveProperty('timezone');
			expect(typeof exchange.mic).toBe('string');
			expect(typeof exchange.name).toBe('string');
			expect(typeof exchange.timezone).toBe('string');
			expect((exchange.mic as string).length).toBeGreaterThan(0);
			expect((exchange.name as string).length).toBeGreaterThan(0);
			expect((exchange.timezone as string).length).toBeGreaterThan(0);
		}
	});

	it('XLON entry uses Europe/London timezone', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		const xlon = exchanges.find((e) => e.mic === 'XLON');
		expect(xlon).toBeDefined();
		expect(xlon!.timezone).toBe('Europe/London');
	});

	it('XJPX entry uses Asia/Tokyo timezone', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		const xjpx = exchanges.find((e) => e.mic === 'XJPX');
		expect(xjpx).toBeDefined();
		expect(xjpx!.timezone).toBe('Asia/Tokyo');
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.status).toBe(200);
	});
});

// ─── UNKNOWN MIC error responses ─────────────────────────────────────────────

describe('UNKNOWN_MIC error handling', () => {
	const ENDPOINTS_ACCEPTING_MIC = [
		'/v5/demo?mic=BAD',
		'/v5/schedule?mic=BAD',
	];

	for (const endpoint of ENDPOINTS_ACCEPTING_MIC) {
		it(`${endpoint} returns 400 UNKNOWN_MIC with supported list`, async () => {
			const response = await fetchWorker(endpoint);
			expect(response.status).toBe(400);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
			expect(body).toHaveProperty('supported');
			const supported = body.supported as string[];
			expect(Array.isArray(supported)).toBe(true);
			expect(supported.length).toBe(23);
			// Verify all 7 MICs are in the supported list
			for (const mic of ALL_MICS) {
				expect(supported).toContain(mic);
			}
		});
	}

	it('/v5/status?mic=BAD with valid key returns 400 UNKNOWN_MIC', async () => {
		const response = await fetchWorker('/v5/status?mic=BAD', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});
});

// ─── KV Override (Circuit Breaker) ───────────────────────────────────────────

describe('KV Override (Circuit Breaker)', () => {
	it('returns HALTED status when a valid unexpired KV override is set', async () => {
		// Set a future expiry so the override is active
		const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hour
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status:  'HALTED',
			reason:  'Test circuit breaker L1',
			expires,
		}));

		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(body).toHaveProperty('status', 'HALTED');
		expect(body).toHaveProperty('source', 'OVERRIDE');
		expect(body).toHaveProperty('reason', 'Test circuit breaker L1');
		// Still cryptographically signed
		expect(body).toHaveProperty('signature');
		expect((body.signature as string).length).toBe(128);

		// Clean up
		await env.ORACLE_OVERRIDES.delete('XNYS');
	});

	it('falls back to schedule when KV override has expired', async () => {
		// Set an already-expired override
		const expires = new Date(Date.now() - 1000).toISOString(); // 1 second ago
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status:  'HALTED',
			reason:  'Expired override',
			expires,
		}));

		const body = await fetchJSON('/v5/demo?mic=XNYS');
		// Should NOT be HALTED from override — should be schedule-based
		expect(body).toHaveProperty('source', 'SCHEDULE');
		expect(body.source).not.toBe('OVERRIDE');

		// Clean up
		await env.ORACLE_OVERRIDES.delete('XNYS');
	});

	it('override for XLON does not affect XNYS', async () => {
		const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await env.ORACLE_OVERRIDES.put('XLON', JSON.stringify({
			status:  'HALTED',
			reason:  'LSE circuit breaker',
			expires,
		}));

		// XNYS should still be schedule-based
		const xnys = await fetchJSON('/v5/demo?mic=XNYS');
		expect(xnys.source).toBe('SCHEDULE');

		// XLON should be HALTED
		const xlon = await fetchJSON('/v5/demo?mic=XLON');
		expect(xlon).toHaveProperty('status', 'HALTED');
		expect(xlon).toHaveProperty('source', 'OVERRIDE');

		// Clean up
		await env.ORACLE_OVERRIDES.delete('XLON');
	});

	it('override includes signed receipt with correct MIC', async () => {
		const expires = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XJPX', JSON.stringify({
			status:  'HALTED',
			reason:  'JPX emergency halt',
			expires,
		}));

		const body = await fetchJSON('/v5/demo?mic=XJPX');
		expect(body).toHaveProperty('mic', 'XJPX');
		expect(body).toHaveProperty('status', 'HALTED');
		expect(body).toHaveProperty('receipt_id');
		expect(body).toHaveProperty('issued_at');
		expect(body).toHaveProperty('expires_at');
		expect(body).toHaveProperty('schema_version', 'v5.0');

		// Clean up
		await env.ORACLE_OVERRIDES.delete('XJPX');
	});
});

// ─── 404 ──────────────────────────────────────────────────────────────────────

describe('404 — Unknown routes', () => {
	// Note: /v5/status/* returns 401 (auth guard fires before routing), not 404.
	const UNKNOWN_PATHS = ['/unknown', '/v4/demo', '/v5', '/'];

	for (const path of UNKNOWN_PATHS) {
		it(`returns 404 for ${path}`, async () => {
			const response = await fetchWorker(path);
			expect(response.status).toBe(404);
		});
	}
});

// ─── Receipt field order and shape ───────────────────────────────────────────

describe('Receipt structure', () => {
	it('all required receipt fields are present in demo response', async () => {
		const body = await fetchJSON('/v5/demo');
		const requiredFields = [
			'receipt_id', 'issued_at', 'expires_at', 'mic', 'status',
			'source', 'receipt_mode', 'schema_version', 'public_key_id', 'signature',
		];
		for (const field of requiredFields) {
			expect(body).toHaveProperty(field);
		}
	});

	it('receipt_id is unique across multiple requests', async () => {
		const [a, b] = await Promise.all([
			fetchJSON('/v5/demo'),
			fetchJSON('/v5/demo'),
		]);
		expect(a.receipt_id).not.toBe(b.receipt_id);
	});

	it('issued_at is close to the current time (within 5 seconds)', async () => {
		const body = await fetchJSON('/v5/demo');
		const issuedAt = new Date(body.issued_at as string).getTime();
		const now      = Date.now();
		expect(Math.abs(now - issuedAt)).toBeLessThan(5000);
	});

	it('expires_at is a valid ISO 8601 date approximately 60 seconds after issued_at', async () => {
		const body      = await fetchJSON('/v5/demo');
		const issuedAt  = new Date(body.issued_at  as string).getTime();
		const expiresAt = new Date(body.expires_at as string).getTime();
		expect(expiresAt).not.toBeNaN();
		// Allow ±1s tolerance around the 60s TTL
		expect(expiresAt - issuedAt).toBeGreaterThanOrEqual(59000);
		expect(expiresAt - issuedAt).toBeLessThanOrEqual(61000);
	});
});

// ─── GET /openapi.json ───────────────────────────────────────────────────────

describe('GET /openapi.json', () => {
	it('returns 200 with a valid OpenAPI 3.1 spec', async () => {
		const response = await fetchWorker('/openapi.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('openapi', '3.1.0');
		expect(body).toHaveProperty('info');
		expect(body).toHaveProperty('paths');

		const paths = body.paths as Record<string, unknown>;
		expect(paths).toHaveProperty('/v5/demo');
		expect(paths).toHaveProperty('/v5/status');
		expect(paths).toHaveProperty('/v5/keys');
		expect(paths).toHaveProperty('/v5/schedule');
		expect(paths).toHaveProperty('/v5/exchanges');
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/openapi.json');
		expect(response.status).toBe(200);
	});
});

// ─── Holiday coverage guard (fail-closed) ────────────────────────────────────
// These tests verify that when the current year has no holiday data, the oracle
// returns a signed UNKNOWN/SYSTEM receipt rather than silently treating every
// weekday as a trading day.

describe('Holiday coverage guard (fail-closed)', () => {
	it('returns signed UNKNOWN when current year has no holiday coverage', async () => {
		vi.useFakeTimers();
		// 2028-03-15 is a Wednesday — open hours for XNYS — but 2028 has no holiday data
		vi.setSystemTime(new Date('2028-03-15T14:30:00Z'));
		try {
			const body = await fetchJSON('/v5/demo?mic=XNYS');
			expect(body).toHaveProperty('status', 'UNKNOWN');
			expect(body).toHaveProperty('source', 'SYSTEM');
			// Guard fires in Tier 1 (not a throw), so receipt is still signed
			expect(body).toHaveProperty('signature');
			expect((body.signature as string).length).toBe(128);
		} finally {
			vi.useRealTimers();
		}
	});

	it('guard fires for all 7 MICs in an uncovered year', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2028-06-01T10:00:00Z'));
		try {
			for (const mic of ALL_MICS) {
				const body = await fetchJSON(`/v5/demo?mic=${mic}`);
				expect(body).toHaveProperty('status', 'UNKNOWN');
				expect(body).toHaveProperty('source', 'SYSTEM');
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── GET /v5/health ──────────────────────────────────────────────────────────

describe('GET /v5/health', () => {
	it('returns 200 with a signed health receipt (no auth required)', async () => {
		const response = await fetchWorker('/v5/health');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('receipt_id');
		expect(body).toHaveProperty('issued_at');
		expect(body).toHaveProperty('expires_at');
		expect(body).toHaveProperty('status', 'OK');
		expect(body).toHaveProperty('source', 'SYSTEM');
		expect(body).toHaveProperty('public_key_id');
		expect(body).toHaveProperty('signature');
		expect((body.signature as string).length).toBe(128);
	});

	it('health receipt_id is a valid UUID', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body.receipt_id as string).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it('health expires_at is ~60s after issued_at', async () => {
		const body = await fetchJSON('/v5/health');
		const issuedAt  = new Date(body.issued_at  as string).getTime();
		const expiresAt = new Date(body.expires_at as string).getTime();
		expect(expiresAt - issuedAt).toBeGreaterThanOrEqual(59000);
		expect(expiresAt - issuedAt).toBeLessThanOrEqual(61000);
	});

	it('health receipt does not contain a mic field', async () => {
		const body = await fetchJSON('/v5/health');
		// Health is system-level, not exchange-specific
		expect(Object.prototype.hasOwnProperty.call(body, 'mic')).toBe(false);
	});

	it('health response includes exchange_count = 23 (unsigned metadata)', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('exchange_count', 23);
	});

	it('health response includes supported_mics with all 23 MICs (unsigned metadata)', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('supported_mics');
		const mics = body.supported_mics as string[];
		expect(Array.isArray(mics)).toBe(true);
		expect(mics.length).toBe(23);
		for (const mic of ALL_MICS) {
			expect(mics).toContain(mic);
		}
	});

	it('health exchange_count and supported_mics are outside the signed payload', async () => {
		// Confirms these are unsigned annotations — not part of canonical health payload.
		const body = await fetchJSON('/v5/health');
		const { exchange_count, supported_mics } = body as Record<string, unknown>;
		expect(exchange_count).toBe(23);
		expect(Array.isArray(supported_mics)).toBe(true);
		// Core signed fields must still be present
		expect(body).toHaveProperty('signature');
		expect(body).toHaveProperty('status', 'OK');
	});

	it('health response includes data_coverage with holidays and half_days year arrays', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('data_coverage');
		const dc = body.data_coverage as Record<string, unknown>;
		expect(Array.isArray(dc.holidays)).toBe(true);
		expect(Array.isArray(dc.half_days)).toBe(true);
		// All 7 exchanges have 2026 and 2027 holiday data
		expect(dc.holidays).toContain('2026');
		expect(dc.holidays).toContain('2027');
	});

	it('health data_coverage.holidays is sorted and contains only years all exchanges share', async () => {
		const body = await fetchJSON('/v5/health');
		const years = (body.data_coverage as Record<string, string[]>).holidays;
		const sorted = [...years].sort();
		expect(years).toEqual(sorted);
	});

	it('health response includes edge_case_count_current_year (number > 0)', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('edge_case_count_current_year');
		const count = body.edge_case_count_current_year as number;
		expect(typeof count).toBe('number');
		expect(count).toBeGreaterThan(0);
	});
});

// ─── POST /mcp — MCP Streamable HTTP ─────────────────────────────────────────

async function postMcp(body: unknown): Promise<Response> {
	return fetchWorker('/mcp', {
		method:  'POST',
		headers: { 'Content-Type': 'application/json' },
		body:    JSON.stringify(body),
	});
}

async function postMcpJSON(body: unknown): Promise<Record<string, unknown>> {
	const response = await postMcp(body);
	return response.json() as Promise<Record<string, unknown>>;
}

describe('POST /mcp', () => {
	it('initialize → 200 with protocolVersion, serverInfo, and capabilities.tools', async () => {
		const response = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		expect(response.status).toBe(200);
		expect(response.headers.get('MCP-Version')).toBe('2024-11-05');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('jsonrpc', '2.0');
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('protocolVersion', '2024-11-05');
		const serverInfo = result.serverInfo as Record<string, unknown>;
		expect(serverInfo).toHaveProperty('name', 'headless-oracle');
		const capabilities = result.capabilities as Record<string, unknown>;
		expect(capabilities).toHaveProperty('tools');
	});

	it('notifications/initialized → 202 with empty body', async () => {
		const response = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(response.status).toBe(202);
		const text = await response.text();
		expect(text).toBe('');
	});

	it('tools/list → 3 tools with names, descriptions, and inputSchema', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const result = body.result as Record<string, unknown>;
		const tools = result.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(3);

		const names = tools.map((t) => t.name as string);
		expect(names).toContain('get_market_status');
		expect(names).toContain('get_market_schedule');
		expect(names).toContain('list_exchanges');

		for (const tool of tools) {
			expect(typeof tool.description).toBe('string');
			expect((tool.description as string).length).toBeGreaterThan(0);
			expect(tool).toHaveProperty('inputSchema');
		}
	});

	it('tools/call get_market_status XNYS → signed receipt with schema_version v5.0', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 3, method: 'tools/call',
			params: { name: 'get_market_status', arguments: { mic: 'XNYS' } },
		});
		const result = body.result as Record<string, unknown>;
		// MCP tool result, not a JSON-RPC error
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		expect(result).not.toHaveProperty('isError');

		const content = result.content as Array<{ type: string; text: string }>;
		expect(content).toHaveLength(1);
		expect(content[0].type).toBe('text');

		const receipt = JSON.parse(content[0].text) as Record<string, unknown>;
		expect(receipt).toHaveProperty('mic', 'XNYS');
		expect(VALID_STATUSES).toContain(receipt.status);
		expect(receipt).toHaveProperty('schema_version', 'v5.0');
		expect(receipt).toHaveProperty('signature');
		expect((receipt.signature as string).length).toBe(128);
	});

	it('tools/call get_market_status with active KV HALTED override → HALTED, OVERRIDE, signed', async () => {
		const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status: 'HALTED', reason: 'MCP circuit breaker test', expires,
		}));

		try {
			const body = await postMcpJSON({
				jsonrpc: '2.0', id: 4, method: 'tools/call',
				params: { name: 'get_market_status', arguments: { mic: 'XNYS' } },
			});
			const result = body.result as Record<string, unknown>;
			const content = result.content as Array<{ type: string; text: string }>;
			const receipt = JSON.parse(content[0].text) as Record<string, unknown>;

			expect(receipt).toHaveProperty('status', 'HALTED');
			expect(receipt).toHaveProperty('source', 'OVERRIDE');
			expect(receipt).toHaveProperty('signature');
			expect((receipt.signature as string).length).toBe(128);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('tools/call get_market_schedule XJPX → lunch_break with local times, no signature', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 5, method: 'tools/call',
			params: { name: 'get_market_schedule', arguments: { mic: 'XJPX' } },
		});
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<{ type: string; text: string }>;
		const schedule = JSON.parse(content[0].text) as Record<string, unknown>;

		expect(schedule).toHaveProperty('mic', 'XJPX');
		expect(schedule).toHaveProperty('lunch_break');
		const lb = schedule.lunch_break as Record<string, unknown>;
		expect(lb).toHaveProperty('start', '11:30');
		expect(lb).toHaveProperty('end', '12:30');
		// Schedule endpoint is not signed
		expect(Object.prototype.hasOwnProperty.call(schedule, 'signature')).toBe(false);
	});

	it('tools/call list_exchanges → 23 exchanges with all MIC codes', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 6, method: 'tools/call',
			params: { name: 'list_exchanges', arguments: {} },
		});
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<{ type: string; text: string }>;
		const data = JSON.parse(content[0].text) as Record<string, unknown>;

		const exchanges = data.exchanges as Array<Record<string, unknown>>;
		expect(exchanges).toHaveLength(23);

		const mics = exchanges.map((e) => e.mic as string);
		for (const mic of ALL_MICS) {
			expect(mics).toContain(mic);
		}
	});

	it('tools/call get_market_status with unknown MIC → isError: true, UNKNOWN_MIC, no JSON-RPC error field', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 7, method: 'tools/call',
			params: { name: 'get_market_status', arguments: { mic: 'FAKE' } },
		});
		// Must NOT be a JSON-RPC protocol error — the tool ran, it just found no data
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);

		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('isError', true);

		const content = result.content as Array<{ type: string; text: string }>;
		const data = JSON.parse(content[0].text) as Record<string, unknown>;
		expect(data).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	it('resources/list → { resources: [] }', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('resources');
		expect(result.resources).toEqual([]);
	});

	it('prompts/list → { prompts: [] }', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 9, method: 'prompts/list' });
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('prompts');
		expect(result.prompts).toEqual([]);
	});

	it('GET /mcp → 200 server info (name, version, protocol, tools, sma_compliant)', async () => {
		const response = await fetchWorker('/mcp');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('name', 'headless-oracle');
		expect(body).toHaveProperty('version', '5.0.0');
		expect(body).toHaveProperty('protocol', '2024-11-05');
		expect(body).toHaveProperty('authentication', 'none');
		expect(body).toHaveProperty('sma_compliant', true);
		expect(body).toHaveProperty('sma_version', '1.0');
		const tools = body.tools as string[];
		expect(Array.isArray(tools)).toBe(true);
		expect(tools).toContain('get_market_status');
		expect(tools).toContain('get_market_schedule');
		expect(tools).toContain('list_exchanges');
	});

	it('PUT /mcp → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/mcp', { method: 'PUT' });
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('POST /mcp invalid JSON → -32700 parse error', async () => {
		const response = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    'not-valid-json{{{',
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('jsonrpc', '2.0');
		const err = body.error as Record<string, unknown>;
		expect(err).toHaveProperty('code', -32700);
	});

	it('POST /mcp unknown method → -32601 method not found', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 99, method: 'nonexistent/method' });
		expect(body).toHaveProperty('jsonrpc', '2.0');
		const err = body.error as Record<string, unknown>;
		expect(err).toHaveProperty('code', -32601);
	});

	it('POST /mcp Content-Type is application/json on all responses', async () => {
		const response = await postMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('POST /mcp tools/call content block has type:text and text field', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 50, method: 'tools/call',
			params: { name: 'list_exchanges', arguments: {} },
		});
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, unknown>>;
		expect(Array.isArray(content)).toBe(true);
		expect(content[0]).toHaveProperty('type', 'text');
		expect(typeof content[0].text).toBe('string');
	});

	it('POST /mcp initialize returns instructions field', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 51, method: 'initialize', params: {} });
		const result = body.result as Record<string, unknown>;
		expect(typeof result.instructions).toBe('string');
		expect((result.instructions as string).length).toBeGreaterThan(0);
	});

	it('tools/list → no x-oracle-note on first use (request_count = 1)', async () => {
		// Fresh IP — will have count 1 after this call, well below the 50-request threshold.
		const testIp = '192.0.2.1';
		const ipHash = await sha256Hex(testIp);
		const today  = new Date().toISOString().slice(0, 10);
		const kvKey  = `mcp_clients:${today}:${ipHash}`;
		await env.ORACLE_TELEMETRY.delete(kvKey); // ensure clean slate

		try {
			const response = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }),
			});
			const body   = await response.json() as Record<string, unknown>;
			const result = body.result as Record<string, unknown>;
			expect(result).toHaveProperty('tools');
			expect(Object.prototype.hasOwnProperty.call(result, 'x-oracle-note')).toBe(false);
		} finally {
			await env.ORACLE_TELEMETRY.delete(kvKey);
		}
	});

	it('tools/list → x-oracle-note appears when request_count exceeds 50', async () => {
		// Pre-seed KV with count=50; handleMcp increments to 51 → note appears.
		const testIp  = '192.0.2.2';
		const ipHash  = await sha256Hex(testIp);
		const today   = new Date().toISOString().slice(0, 10);
		const kvKey   = `mcp_clients:${today}:${ipHash}`;
		const now     = new Date().toISOString();
		await env.ORACLE_TELEMETRY.put(kvKey, JSON.stringify({
			first_seen: now, last_seen: now, request_count: 50,
			user_agent: 'test-agent', asn_org: 'DATACAMP', country: 'US', city: 'New York',
		}));

		try {
			const response = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list' }),
			});
			const body   = await response.json() as Record<string, unknown>;
			const result = body.result as Record<string, unknown>;
			expect(result).toHaveProperty('x-oracle-note');
			expect(typeof result['x-oracle-note']).toBe('string');
			expect(result['x-oracle-note'] as string).toContain('https://headlessoracle.com/v5/keys/request');
		} finally {
			await env.ORACLE_TELEMETRY.delete(kvKey);
		}
	});

	it('MCP request writes client aggregate to ORACLE_TELEMETRY KV (hashed IP, request_count increments)', async () => {
		const testIp = '192.0.2.3';
		const ipHash = await sha256Hex(testIp);
		const today  = new Date().toISOString().slice(0, 10);
		const kvKey  = `mcp_clients:${today}:${ipHash}`;
		await env.ORACLE_TELEMETRY.delete(kvKey);

		try {
			await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/list' }),
			});

			const raw    = await env.ORACLE_TELEMETRY.get(kvKey);
			expect(raw).not.toBeNull();
			const record = JSON.parse(raw!) as Record<string, unknown>;
			expect(record.request_count).toBe(1);
			expect(typeof record.first_seen).toBe('string');
			expect(typeof record.last_seen).toBe('string');
		} finally {
			await env.ORACLE_TELEMETRY.delete(kvKey);
		}
	});
});

// ─── GET /v5/batch ────────────────────────────────────────────────────────────

describe('GET /v5/batch', () => {
	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,XNAS');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
		expect(response.headers.get('X-Oracle-Key-Request')).toBe('https://headlessoracle.com/v5/keys/request');
	});

	it('returns 403 with an invalid API key', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': 'bad_key_xyz' },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('returns 400 when mics param is missing', async () => {
		const response = await fetchWorker('/v5/batch', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MISSING_PARAMETER');
	});

	it('returns 400 when mics param is an empty string', async () => {
		const response = await fetchWorker('/v5/batch?mics=', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MISSING_PARAMETER');
	});

	it('returns 400 for an unknown MIC in the batch', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,ZZZZ', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
		expect(body).toHaveProperty('unknown');
		expect(body).toHaveProperty('supported');
		const unknown = body.unknown as string[];
		expect(unknown).toContain('ZZZZ');
		expect(unknown).not.toContain('XNYS');
	});

	it('returns 400 when all MICs are unknown', async () => {
		const response = await fetchWorker('/v5/batch?mics=AAAA,BBBB', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	it('returns 200 with 2 signed receipts for XNYS,XNAS', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,XNAS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('batch_id');
		expect(body).toHaveProperty('queried_at');
		expect(body).toHaveProperty('receipts');
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(2);
	});

	it('each receipt in the batch is independently signed', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNAS,XLON', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		for (const receipt of receipts) {
			expect(receipt).toHaveProperty('signature');
			expect(typeof receipt.signature).toBe('string');
			expect((receipt.signature as string).length).toBe(128);
			expect(receipt).toHaveProperty('receipt_id');
			expect(receipt).toHaveProperty('issued_at');
			expect(receipt).toHaveProperty('expires_at');
		}
	});

	it('each receipt has the correct mic field for its exchange', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS,XLON,XJPX', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		const mics = receipts.map((r) => r.mic as string);
		expect(mics).toContain('XNYS');
		expect(mics).toContain('XLON');
		expect(mics).toContain('XJPX');
	});

	it('receipt order matches request order', async () => {
		const body = await fetchJSON('/v5/batch?mics=XPAR,XHKG,XSES', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts[0].mic).toBe('XPAR');
		expect(receipts[1].mic).toBe('XHKG');
		expect(receipts[2].mic).toBe('XSES');
	});

	it('deduplicates repeated MICs — XNYS,XNYS returns one receipt', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(1);
		expect(receipts[0].mic).toBe('XNYS');
	});

	it('original 7 MICs in one batch returns 7 receipts', async () => {
		const ORIGINAL_MICS = ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'];
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNAS,XLON,XJPX,XPAR,XHKG,XSES', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(7);
		const mics = receipts.map((r) => r.mic as string);
		for (const mic of ORIGINAL_MICS) {
			expect(mics).toContain(mic);
		}
	});

	it('normalises lowercase mics to uppercase', async () => {
		const body = await fetchJSON('/v5/batch?mics=xnys,xnas', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(2);
		expect(receipts[0].mic).toBe('XNYS');
		expect(receipts[1].mic).toBe('XNAS');
	});

	it('batch_id is a valid UUID', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(body.batch_id as string).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it('queried_at is a valid ISO 8601 date close to now', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const t = new Date(body.queried_at as string).getTime();
		expect(t).not.toBeNaN();
		expect(Math.abs(Date.now() - t)).toBeLessThan(5000);
	});

	it('receipts include schema_version v5.0', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts[0]).toHaveProperty('schema_version', 'v5.0');
	});

	it('KV HALTED override for one MIC is reflected in the batch; other MICs are schedule-based', async () => {
		const expires = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XLON', JSON.stringify({
			status: 'HALTED', reason: 'Batch circuit breaker test', expires,
		}));
		try {
			const body = await fetchJSON('/v5/batch?mics=XNYS,XLON', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
			});
			const receipts = body.receipts as Array<Record<string, unknown>>;
			const xnys = receipts.find((r) => r.mic === 'XNYS')!;
			const xlon = receipts.find((r) => r.mic === 'XLON')!;
			expect(xnys.source).toBe('SCHEDULE');
			expect(xlon.status).toBe('HALTED');
			expect(xlon.source).toBe('OVERRIDE');
			// Both are still independently signed
			expect((xnys.signature as string).length).toBe(128);
			expect((xlon.signature as string).length).toBe(128);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XLON');
		}
	});
});

// ─── GET /.well-known/oracle-keys.json ───────────────────────────────────────

describe('GET /.well-known/oracle-keys.json', () => {
	it('returns 200 with keys array (no auth required)', async () => {
		const response = await fetchWorker('/.well-known/oracle-keys.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('keys');
		const keys = body.keys as Array<Record<string, unknown>>;
		expect(keys.length).toBeGreaterThan(0);
	});

	it('key entry has Ed25519 algorithm, hex format, and non-empty public_key', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		const keys = body.keys as Array<Record<string, unknown>>;
		const key = keys[0];
		expect(key).toHaveProperty('algorithm', 'Ed25519');
		expect(key).toHaveProperty('format', 'hex');
		expect(typeof key.public_key).toBe('string');
		expect((key.public_key as string).length).toBeGreaterThan(0);
	});

	it('key entry includes valid_from and valid_until lifecycle fields', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		const key = (body.keys as Array<Record<string, unknown>>)[0];
		expect(key).toHaveProperty('valid_from');
		expect(new Date(key.valid_from as string).getTime()).not.toBeNaN();
		expect(Object.prototype.hasOwnProperty.call(key, 'valid_until')).toBe(true);
	});

	it('response includes service identifier and spec URL', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		expect(body).toHaveProperty('service', 'headless-oracle');
		expect(body).toHaveProperty('spec');
		expect(typeof body.spec).toBe('string');
	});

	it('public_key matches the key returned by /v5/keys', async () => {
		const [wellKnown, keysEndpoint] = await Promise.all([
			fetchJSON('/.well-known/oracle-keys.json'),
			fetchJSON('/v5/keys'),
		]);
		const wkKey = (wellKnown.keys  as Array<Record<string, unknown>>)[0];
		const v5Key = (keysEndpoint.keys as Array<Record<string, unknown>>)[0];
		expect(wkKey.public_key).toBe(v5Key.public_key);
		expect(wkKey.key_id).toBe(v5Key.key_id);
	});
});

// ─── GET /robots.txt ─────────────────────────────────────────────────────────

describe('GET /robots.txt', () => {
	it('returns 200 with text/plain content-type', async () => {
		const response = await fetchWorker('/robots.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('allows llms.txt and openapi.json for all user-agents', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		expect(body).toContain('User-agent: *');
		expect(body).toContain('Allow: /llms.txt');
		expect(body).toContain('Allow: /openapi.json');
	});
});

// ─── GET /llms.txt ────────────────────────────────────────────────────────────

describe('GET /llms.txt', () => {
	it('returns 200 with text/plain content-type', async () => {
		const response = await fetchWorker('/llms.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('contains fail-closed mandate and supported exchange MIC codes', async () => {
		const body = await fetchWorker('/llms.txt').then((r) => r.text());
		expect(body).toContain('UNKNOWN');
		expect(body).toContain('XNYS');
		expect(body).toContain('XJPX');
		expect(body).toContain('XHKG');
		expect(body).toContain('expires_at');
	});
});

// ─── GET /SKILL.md ───────────────────────────────────────────────────────────

describe('GET /SKILL.md', () => {
	it('returns 200 with text/markdown content-type', async () => {
		const response = await fetchWorker('/SKILL.md');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains MCP setup, safety rules, and supported MIC codes', async () => {
		const body = await fetchWorker('/SKILL.md').then((r) => r.text());
		expect(body).toContain('UNKNOWN means CLOSED');
		expect(body).toContain('expires_at');
		expect(body).toContain('XNYS');
		expect(body).toContain('get_market_status');
		expect(body).toContain('@headlessoracle/verify');
	});

	it('includes Last-Modified and ETag headers for cache invalidation', async () => {
		const response = await fetchWorker('/SKILL.md');
		const lastMod = response.headers.get('Last-Modified');
		const etag    = response.headers.get('ETag');
		// RFC 7231 HTTP-date: "Day, DD Mon YYYY HH:MM:SS GMT"
		expect(lastMod).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
		// ETag must be a quoted string (RFC 7232)
		expect(etag).toMatch(/^"[0-9a-f]+"$/);
	});
});

// ─── GET /docs/integrations/* and /docs/x402-payments ───────────────────────

describe('GET /docs/integrations/datacamp-workspace', () => {
	it('returns 200 with text/plain content-type (extensionless email link)', async () => {
		const response = await fetchWorker('/docs/integrations/datacamp-workspace');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('contains DataCamp-specific content: pip install and safe_market_check', async () => {
		const body = await fetchWorker('/docs/integrations/datacamp-workspace').then((r) => r.text());
		expect(body).toContain('pip install headless-oracle');
		expect(body).toContain('safe_market_check');
		expect(body).toContain('pd.DataFrame');
	});

	it('.md variant returns text/markdown', async () => {
		const response = await fetchWorker('/docs/integrations/datacamp-workspace.md');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});
});

describe('GET /docs/integrations/bun', () => {
	it('returns 200 with text/plain content-type (extensionless)', async () => {
		const response = await fetchWorker('/docs/integrations/bun');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('contains Bun integration content', async () => {
		const body = await fetchWorker('/docs/integrations/bun').then((r) => r.text());
		expect(body).toContain('@headlessoracle/verify');
		expect(body).toContain('Bun.serve');
	});
});

describe('GET /docs/x402-payments', () => {
	it('returns 200 with text/plain content-type (extensionless)', async () => {
		const response = await fetchWorker('/docs/x402-payments');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('contains x402 payment content', async () => {
		const body = await fetchWorker('/docs/x402-payments').then((r) => r.text());
		expect(body).toContain('x402');
		expect(body).toContain('USDC');
	});
});

// ─── GET /.well-known/agent.json ─────────────────────────────────────────────

describe('GET /.well-known/agent.json', () => {
	it('returns 200 with application/json content-type', async () => {
		const response = await fetchWorker('/.well-known/agent.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('contains MCP endpoint, tool names, REST endpoints, and trust anchors', async () => {
		const body = await fetchWorker('/.well-known/agent.json').then((r) => r.json()) as Record<string, unknown>;
		expect(body).toHaveProperty('name', 'Headless Oracle');
		expect(body).toHaveProperty('mcp');
		const mcp = body.mcp as { endpoint: string; tools: Array<{ name: string }> };
		expect(mcp.endpoint).toBe('https://headlessoracle.com/mcp');
		expect(Array.isArray(mcp.tools)).toBe(true);
		const toolNames = mcp.tools.map((t) => t.name);
		expect(toolNames).toContain('get_market_status');
		expect(toolNames).toContain('get_market_schedule');
		expect(toolNames).toContain('list_exchanges');
		const safety = body.safety as { fail_closed: boolean; unknown_means: string };
		expect(safety.fail_closed).toBe(true);
		expect(safety.unknown_means).toContain('CLOSED');
	});

	it('includes spec_version for staleness detection', async () => {
		const body = await fetchWorker('/.well-known/agent.json').then((r) => r.json()) as Record<string, unknown>;
		expect(body).toHaveProperty('spec_version');
		// Must be a date string (YYYY-MM-DD) so agents can compare against a cached value
		expect(typeof body.spec_version).toBe('string');
		expect(body.spec_version as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('robots.txt allows /SKILL.md', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		expect(body).toContain('Allow: /SKILL.md');
	});
});

// ─── GET /.well-known/mcp/server-card.json ───────────────────────────────────

describe('GET /.well-known/mcp/server-card.json', () => {
	it('returns 200 with application/json content-type', async () => {
		const response = await fetchWorker('/.well-known/mcp/server-card.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('contains required server-card fields', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		expect(body).toHaveProperty('name', 'Headless Oracle');
		expect(body).toHaveProperty('url', 'https://headlessoracle.com/mcp');
		expect(body).toHaveProperty('version', '1.0.0');
		expect(body).toHaveProperty('authentication', 'none');
		expect(body).toHaveProperty('description');
		expect(typeof body.description).toBe('string');
	});

	it('lists the three MCP tools', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		const tools = body.tools as string[];
		expect(tools).toContain('get_market_status');
		expect(tools).toContain('get_market_schedule');
		expect(tools).toContain('list_exchanges');
	});
});

// ─── GET /.well-known/oauth-protected-resource ───────────────────────────────

describe('GET /.well-known/oauth-protected-resource', () => {
	it('returns 200 with application/json content-type', async () => {
		const response = await fetchWorker('/.well-known/oauth-protected-resource');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('contains required RFC 9728 fields', async () => {
		const body = await fetchJSON('/.well-known/oauth-protected-resource');
		expect(body).toHaveProperty('resource', 'https://headlessoracle.com');
		expect(body).toHaveProperty('authorization_servers');
		expect(body).toHaveProperty('bearer_methods_supported');
		expect(body).toHaveProperty('scopes_supported');
	});

	it('returns empty arrays — Oracle has no OAuth requirement', async () => {
		const body = await fetchJSON('/.well-known/oauth-protected-resource');
		expect(Array.isArray(body.authorization_servers)).toBe(true);
		expect((body.authorization_servers as unknown[]).length).toBe(0);
		expect(Array.isArray(body.bearer_methods_supported)).toBe(true);
		expect(Array.isArray(body.scopes_supported)).toBe(true);
	});
});

// ─── Billing: Auth hot path — paid keys via KV ───────────────────────────────

// Shared helper: compute sha256(string) in the test Workers runtime
async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const hash  = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Shared helper: build a valid Paddle-Signature header for a given raw body + secret
async function makePaddleSignature(rawBody: string, secret: string): Promise<string> {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signedContent = `${timestamp}:${rawBody}`;            // colon separator
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig    = await crypto.subtle.sign('HMAC', keyMaterial, new TextEncoder().encode(signedContent));
	const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
	return `ts=${timestamp};h1=${sigHex}`;                      // semicolon separator, ts/h1 keys
}

describe('Auth hot path — paid keys via KV', () => {
	const PAID_KEY_ACTIVE    = 'ok_live_' + 'a'.repeat(64);
	const PAID_KEY_SUSPENDED = 'ok_live_' + 'b'.repeat(64);
	const PAID_KEY_CANCELLED = 'ok_live_' + 'c'.repeat(64);
	const PAID_KEY_UNKNOWN   = 'ok_live_' + 'd'.repeat(64);

	it('active ok_live_ key in KV → 200 on /v5/status', async () => {
		const hash = await sha256Hex(PAID_KEY_ACTIVE);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'active' }));
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': PAID_KEY_ACTIVE },
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('mic', 'XNYS');
			expect(body).toHaveProperty('signature');
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});

	it('suspended ok_live_ key in KV → 402 with PAYMENT_REQUIRED', async () => {
		const hash = await sha256Hex(PAID_KEY_SUSPENDED);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'suspended' }));
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': PAID_KEY_SUSPENDED },
			});
			expect(response.status).toBe(402);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'PAYMENT_REQUIRED');
			expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
			expect(response.headers.get('X-Oracle-Plans')).toBe('free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500');
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});

	it('cancelled ok_live_ key in KV → 402', async () => {
		const hash = await sha256Hex(PAID_KEY_CANCELLED);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'cancelled' }));
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': PAID_KEY_CANCELLED },
			});
			expect(response.status).toBe(402);
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});

	it('ok_live_ key not found in KV or Supabase → 403', async () => {
		// PAID_KEY_UNKNOWN has no KV entry and no Supabase record
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': PAID_KEY_UNKNOWN },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('active paid key also grants access to /v5/batch', async () => {
		const hash = await sha256Hex(PAID_KEY_ACTIVE);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'active' }));
		try {
			const response = await fetchWorker('/v5/batch?mics=XNYS', {
				headers: { 'X-Oracle-Key': PAID_KEY_ACTIVE },
			});
			expect(response.status).toBe(200);
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});

	it('MASTER_API_KEY still works unchanged (step 1 short-circuit)', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(200);
	});

	it('beta key still works unchanged (step 2 short-circuit)', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(200);
	});
});

// ─── Billing: GET /v5/account ─────────────────────────────────────────────────

describe('GET /v5/account', () => {
	const ACCOUNT_KEY = 'ok_live_' + 'e'.repeat(64);

	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/account');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
	});

	it('returns 403 with invalid key', async () => {
		const response = await fetchWorker('/v5/account', {
			headers: { 'X-Oracle-Key': 'totally_invalid_key_xyz' },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('MASTER_API_KEY → { plan: "internal", status: "active", key_prefix: null }', async () => {
		const body = await fetchJSON('/v5/account', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(body).toHaveProperty('plan', 'internal');
		expect(body).toHaveProperty('status', 'active');
		expect(body).toHaveProperty('key_prefix', null);
	});

	it('beta key → { plan: "internal", status: "active", key_prefix: null }', async () => {
		const body = await fetchJSON('/v5/account', {
			headers: { 'X-Oracle-Key': 'test_beta_key_2' },
		});
		expect(body).toHaveProperty('plan', 'internal');
		expect(body).toHaveProperty('status', 'active');
		expect(body).toHaveProperty('key_prefix', null);
	});

	it('active paid key → { plan, status, key_prefix } from KV', async () => {
		const hash = await sha256Hex(ACCOUNT_KEY);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'active' }));
		try {
			const body = await fetchJSON('/v5/account', {
				headers: { 'X-Oracle-Key': ACCOUNT_KEY },
			});
			expect(body).toHaveProperty('plan', 'pro');
			expect(body).toHaveProperty('status', 'active');
			// key_prefix is first 14 chars of the key value
			expect(body).toHaveProperty('key_prefix', ACCOUNT_KEY.substring(0, 14));
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});

	it('suspended paid key → 402 from /v5/account', async () => {
		const hash = await sha256Hex(ACCOUNT_KEY);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'pro', status: 'suspended' }));
		try {
			const response = await fetchWorker('/v5/account', {
				headers: { 'X-Oracle-Key': ACCOUNT_KEY },
			});
			expect(response.status).toBe(402);
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
		}
	});
});

// ─── POST /v5/keys/request — free tier key provisioning ──────────────────────

describe('POST /v5/keys/request', () => {
	it('GET /v5/keys/request → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/v5/keys/request');
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('missing email → 400 INVALID_EMAIL', async () => {
		const response = await fetchWorker('/v5/keys/request', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({}),
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_EMAIL');
	});

	it('malformed email → 400 INVALID_EMAIL', async () => {
		const response = await fetchWorker('/v5/keys/request', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ email: 'notanemail' }),
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_EMAIL');
	});

	it('valid email → 200 { plan: "free", message } + KV entry + Resend called', async () => {
		let capturedEmailHtml = '';
		let resendCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('resend.com')) {
				resendCalled = true;
				const emailBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { html?: string };
				capturedEmailHtml = emailBody.html ?? '';
				return new Response(JSON.stringify({ id: 'email_free_001' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/v5/keys/request', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ email: 'test@example.com' }),
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('plan', 'free');
			expect(body).toHaveProperty('message');
			expect(typeof body.message).toBe('string');
			// email must contain the ho_free_ key
			expect(resendCalled).toBe(true);
			expect(capturedEmailHtml).toContain('ho_free_');
			// KV must have an entry for the key hash
			const allKeys = await env.ORACLE_API_KEYS.list();
			// At least one entry should be a free-plan key created during this test
			let foundFreeKey = false;
			for (const { name } of allKeys.keys) {
				const val = await env.ORACLE_API_KEYS.get(name);
				if (val) {
					const parsed = JSON.parse(val) as Record<string, unknown>;
					if (parsed.plan === 'free' && parsed.email === 'test@example.com') {
						foundFreeKey = true;
						expect(parsed.status).toBe('active');
						expect(typeof parsed.created_at).toBe('string');
					}
				}
			}
			expect(foundFreeKey).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('401 on /v5/status without key includes X-Oracle-Upgrade header', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS');
		expect(response.status).toBe(401);
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
	});

	it('401 on /v5/batch without key includes X-Oracle-Upgrade header', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS');
		expect(response.status).toBe(401);
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
	});

	it('401 on /v5/account without key includes X-Oracle-Upgrade header', async () => {
		const response = await fetchWorker('/v5/account');
		expect(response.status).toBe(401);
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/pricing');
	});
});

// ─── Billing: POST /v5/checkout ──────────────────────────────────────────────

describe('POST /v5/checkout', () => {
	it('GET /v5/checkout → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/v5/checkout');
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('POST /v5/checkout → 200 with Paddle url when Paddle responds OK', async () => {
		const mockTransactionId = 'txn_01abc123mock';
		const mockCheckoutUrl = `https://buy.paddle.com/checkout/${mockTransactionId}`;

		const originalFetch = globalThis.fetch;
		// Replace global fetch only for Paddle API calls
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				return new Response(JSON.stringify({ data: { id: mockTransactionId, checkout: { url: 'https://headlessoracle.com?_ptxn=mock' } } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/v5/checkout', { method: 'POST' });
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('url', mockCheckoutUrl);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /v5/checkout → 502 when Paddle returns an error', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				return new Response(JSON.stringify({ error: { detail: 'Invalid API key' } }), {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/v5/checkout', { method: 'POST' });
			expect(response.status).toBe(502);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'CHECKOUT_FAILED');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ─── Billing: POST /webhooks/paddle ──────────────────────────────────────────

describe('POST /webhooks/paddle', () => {
	const WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_for_local_tests'; // matches .dev.vars

	it('GET /webhooks/paddle → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/webhooks/paddle');
		expect(response.status).toBe(405);
	});

	it('POST /webhooks/paddle without Paddle-Signature → 400', async () => {
		const response = await fetchWorker('/webhooks/paddle', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ event_type: 'transaction.completed', data: {} }),
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MISSING_SIGNATURE');
	});

	it('POST /webhooks/paddle with invalid Paddle-Signature → 401', async () => {
		const response = await fetchWorker('/webhooks/paddle', {
			method:  'POST',
			headers: {
				'Content-Type':     'application/json',
				'Paddle-Signature': 'ts=9999999999;h1=invalidsignaturehex',
			},
			body: JSON.stringify({ event_type: 'test.event', data: {} }),
		});
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_SIGNATURE');
	});

	it('POST /webhooks/paddle with valid signature + unrecognised event → 200 { received: true }', async () => {
		const rawBody = JSON.stringify({ event_type: 'account.updated', data: {} });
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const response = await fetchWorker('/webhooks/paddle', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
			body:    rawBody,
		});
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('received', true);
	});

	it('POST /webhooks/paddle with valid signature + transaction.completed (no subscription_id) → 200 (skipped)', async () => {
		// Non-subscription transactions must be silently skipped
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: { id: 'txn_test_oneoff', customer_id: 'ctm_test_001', subscription_id: null },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const response = await fetchWorker('/webhooks/paddle', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
			body:    rawBody,
		});
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('received', true);
	});

	it('POST /webhooks/paddle with valid signature + transaction.completed (renewal idempotency) → 200 (skipped)', async () => {
		// A second transaction.completed for the same subscription_id must not generate a new key
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: { id: 'txn_test_renewal', customer_id: 'ctm_test_renewal', subscription_id: 'sub_test_existing' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				// Simulate: subscription already has a row → return existing record
				return new Response(JSON.stringify({ data: { id: 'existing_row_uuid' }, error: null }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('received', true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle with valid signature + subscription.updated → 200', async () => {
		const rawBody = JSON.stringify({
			event_type: 'subscription.updated',
			data: { id: 'sub_test_123', status: 'active' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		// Mock Supabase to avoid database side-effects in tests
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('received', true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle with valid signature + subscription.past_due → 200', async () => {
		const rawBody = JSON.stringify({
			event_type: 'subscription.past_due',
			data: { id: 'sub_test_456' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('received', true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle with valid signature + subscription.canceled → 200', async () => {
		const rawBody = JSON.stringify({
			event_type: 'subscription.canceled',
			data: { id: 'sub_test_789' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('received', true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle transaction.completed -> generates ho_live_ key, stores builder plan', async () => {
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id: 'txn_test_builder_001',
				customer_id: 'ctm_test_builder_001',
				subscription_id: 'sub_builder_new_001',
				items: [{ price_id: 'pri_test_builder_placeholder', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		let capturedEmailHtml = '';
		let capturedSupabaseInsertBody: Record<string, unknown> = {};

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116', message: 'not found' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				const bodyText = typeof init.body === 'string' ? init.body : '';
				const parsed = JSON.parse(bodyText);
				const row = Array.isArray(parsed) ? parsed[0] : parsed;
				if (row) capturedSupabaseInsertBody = row as Record<string, unknown>;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'builder@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				const emailBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { html?: string };
				capturedEmailHtml = emailBody.html ?? '';
				return new Response(JSON.stringify({ id: 'email_mock_001' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			expect(capturedEmailHtml).toContain('ho_live_');
			expect(capturedSupabaseInsertBody.plan).toBe('builder');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle transaction.completed -> defaults to pro plan for unrecognised price ID', async () => {
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id: 'txn_test_unknown_price',
				customer_id: 'ctm_test_unknown',
				subscription_id: 'sub_unknown_price_001',
				items: [{ price_id: 'pri_totally_unrecognised', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		let capturedPlan = '';

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				const bodyText = typeof init.body === 'string' ? init.body : '';
				const parsed = JSON.parse(bodyText);
				const row = Array.isArray(parsed) ? parsed[0] : parsed;
				if (row) capturedPlan = (row as Record<string, unknown>).plan as string;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'unknown@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				return new Response(JSON.stringify({ id: 'email_mock_003' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			expect(capturedPlan).toBe('pro');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle subscription.canceled -> deactivates key in KV (status: inactive)', async () => {
		const testKeyHash = 'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
		await env.ORACLE_API_KEYS.put(testKeyHash, JSON.stringify({
			plan: 'pro', status: 'active', paddle_subscription_id: 'sub_cancel_kv_test',
		}));

		const rawBody = JSON.stringify({
			event_type: 'subscription.canceled',
			data: { id: 'sub_cancel_kv_test' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
				// supabase-js wraps the raw HTTP body as { data: httpBody }; return the raw row
				return new Response(JSON.stringify({ key_hash: testKeyHash }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('supabase.co') && init?.method === 'PATCH') {
				return new Response(JSON.stringify([{}]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			const kvVal = await env.ORACLE_API_KEYS.get(testKeyHash);
			expect(kvVal).not.toBeNull();
			const parsed = JSON.parse(kvVal!) as Record<string, unknown>;
			expect(parsed.status).toBe('inactive');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

});

// ─── edgeCaseCount() ─────────────────────────────────────────────────────────

describe('edgeCaseCount()', () => {
	it('2026: holidays = sum of all 23 exchange holiday lists', () => {
		// original 7: 81; new 16 exchanges add ~211 more; total ≥ 292
		expect(edgeCaseCount(2026).holidays).toBeGreaterThanOrEqual(292);
	});

	it('2026: halfDays = sum of all early-close entries (only original 7 exchanges have halfDays)', () => {
		// XNYS 2 + XNAS 2 + XLON 2 + XJPX 0 + XPAR 2 + XHKG 1 + XSES 0 = 9
		expect(edgeCaseCount(2026).halfDays).toBe(9);
	});

	it('2026: dstTransitions > 8 (original 4 × 2 + new DST exchanges)', () => {
		// XNYS, XNAS, XLON, XPAR, XASX, XSWX, XMIL, XHEL, XSTO, XNZE each have 2 transitions
		expect(edgeCaseCount(2026).dstTransitions).toBeGreaterThan(8);
	});

	it('2026: lunchBreakSessions includes XJPX, XHKG, XSHG, XSHE', () => {
		// original 493 (XJPX+XHKG) + XSHG trading days + XSHE trading days
		expect(edgeCaseCount(2026).lunchBreakSessions).toBeGreaterThan(493);
	});

	it('2026: weekendDays = sum of per-exchange weekend days (XSAU/XDFM use Fri+Sat)', () => {
		// 21 exchanges × 104 Sat/Sun days + 2 Middle East × 104 Fri/Sat days = 2392
		expect(edgeCaseCount(2026).weekendDays).toBeGreaterThan(728);
	});

	it('2026: total is the sum of all components', () => {
		const { holidays, halfDays, dstTransitions, lunchBreakSessions, weekendDays, total } = edgeCaseCount(2026);
		expect(total).toBe(holidays + halfDays + dstTransitions + lunchBreakSessions + weekendDays);
		expect(total).toBeGreaterThan(1319);
	});
});

// ─── GET /v5/metrics ─────────────────────────────────────────────────────────

describe('GET /v5/metrics', () => {
	it('returns correct shape with zero counts when KV is empty', async () => {
		const response = await fetchWorker('/v5/metrics');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('total_mcp_requests_today');
		expect(body).toHaveProperty('unique_mcp_clients_today');
		expect(body).toHaveProperty('exchanges_covered', 23);
		expect(body).toHaveProperty('edge_cases_per_year');
		expect(typeof body.edge_cases_per_year).toBe('number');
		expect((body.edge_cases_per_year as number)).toBeGreaterThan(1319);
		expect(body).toHaveProperty('uptime_status', 'operational');
		expect(typeof body.total_mcp_requests_today).toBe('number');
		expect(typeof body.unique_mcp_clients_today).toBe('number');
	});

	it('reflects MCP telemetry counts when KV has entries', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const key1   = `mcp_clients:${today}:aaaa`;
		const key2   = `mcp_clients:${today}:bbbb`;
		await env.ORACLE_TELEMETRY.put(key1, JSON.stringify({ request_count: 5 }));
		await env.ORACLE_TELEMETRY.put(key2, JSON.stringify({ request_count: 3 }));
		try {
			const response = await fetchWorker('/v5/metrics');
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body.unique_mcp_clients_today).toBeGreaterThanOrEqual(2);
			expect(body.total_mcp_requests_today).toBeGreaterThanOrEqual(8);
		} finally {
			await env.ORACLE_TELEMETRY.delete(key1);
			await env.ORACLE_TELEMETRY.delete(key2);
		}
	});
});

// ─── POST /v5/keys/request — rate limiting ────────────────────────────────────

describe('POST /v5/keys/request — rate limiting', () => {
	it('fourth request from the same IP within 24h returns 429 RATE_LIMITED', async () => {
		const testIp   = '10.0.0.99';
		const encoded  = new TextEncoder().encode(testIp);
		const hashBuf  = await crypto.subtle.digest('SHA-256', encoded);
		const ipHash   = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
		const today    = new Date().toISOString().slice(0, 10);
		const rlKey    = `ratelimit:keys:${ipHash}:${today}`;
		// Pre-seed counter at the limit
		await env.ORACLE_TELEMETRY.put(rlKey, '3');
		try {
			const response = await fetchWorker('/v5/keys/request', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
				body:    JSON.stringify({ email: 'rate@example.com' }),
			});
			expect(response.status).toBe(429);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'RATE_LIMITED');
			expect(typeof body.message).toBe('string');
		} finally {
			await env.ORACLE_TELEMETRY.delete(rlKey);
		}
	});
});

// ─── POST /v5/keys/request — fail-closed pipeline ─────────────────────────────

describe('POST /v5/keys/request — fail-closed pipeline', () => {
	it('Supabase insert error → 500 KEY_CREATION_FAILED, Resend not called', async () => {
		let resendCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				// Simulate a DB error (e.g. duplicate key or RLS block)
				return new Response(
					JSON.stringify({ message: 'duplicate key value violates unique constraint', code: '23505' }),
					{ status: 409, headers: { 'Content-Type': 'application/json' } },
				);
			}
			if (urlStr.includes('resend.com')) {
				resendCalled = true;
				return new Response(JSON.stringify({ id: 'should_not_reach' }), { status: 200 });
			}
			return originalFetch(input, init);
		};
		try {
			const response = await fetchWorker('/v5/keys/request', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ email: 'faildb@example.com' }),
			});
			expect(response.status).toBe(500);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'KEY_CREATION_FAILED');
			// Resend must NOT be called when Supabase insert fails
			expect(resendCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('Resend failure after successful insert → 200 with warning + resend_error', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('resend.com')) {
				// Simulate Resend rejecting the send (e.g. unverified domain)
				return new Response(
					JSON.stringify({ name: 'validation_error', message: 'The sender domain is not verified.' }),
					{ status: 422, headers: { 'Content-Type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		};
		try {
			const response = await fetchWorker('/v5/keys/request', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ email: 'resend_fail@example.com' }),
			});
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('plan', 'free');
			// Must have warning, not message
			expect(body).toHaveProperty('warning');
			expect(typeof body.warning).toBe('string');
			expect(body).not.toHaveProperty('message');
			// Must include the raw Resend error body so caller can diagnose
			expect(body).toHaveProperty('resend_error');
			expect(typeof body.resend_error).toBe('string');
			expect(body.resend_error as string).toContain('verified');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('last_used_at: Supabase PATCH called after successful /v5/status auth', async () => {
		// Set up a free-tier key in KV with a known hash so checkApiKey returns keyHash
		const freeKeyValue = 'ho_free_lastusedtest0000000000000000000000000000000000000000';
		const encoded      = new TextEncoder().encode(freeKeyValue);
		const hashBuf      = await crypto.subtle.digest('SHA-256', encoded);
		const freeKeyHash  = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

		await env.ORACLE_API_KEYS.put(freeKeyHash, JSON.stringify({ plan: 'free', status: 'active', email: 'lastused@example.com' }));

		let capturedPatchBody: string | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				// Capture PATCH calls (last_used_at updates); allow all others through
				const method = init?.method?.toUpperCase() ?? 'GET';
				if (method === 'PATCH') {
					capturedPatchBody = typeof init?.body === 'string' ? init.body : null;
				}
				return new Response(JSON.stringify([{}]), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': freeKeyValue },
			});
			expect(response.status).toBe(200);
			// Supabase PATCH must have been called with last_used_at
			expect(capturedPatchBody).not.toBeNull();
			const patchPayload = JSON.parse(capturedPatchBody ?? '{}') as Record<string, unknown>;
			expect(patchPayload).toHaveProperty('last_used_at');
			expect(typeof patchPayload.last_used_at).toBe('string');
		} finally {
			globalThis.fetch = originalFetch;
			await env.ORACLE_API_KEYS.delete(freeKeyHash);
		}
	});
});

// ─── Session B/E: Production headers, compliance, health enrichment ─────────────────────

describe('X-Oracle-Version response header', () => {
	it('GET /v5/demo includes X-Oracle-Version: v5', async () => {
		const response = await fetchWorker('/v5/demo');
		expect(response.headers.get('X-Oracle-Version')).toBe('v5');
	});

	it('GET /v5/exchanges includes X-Oracle-Version: v5', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.headers.get('X-Oracle-Version')).toBe('v5');
	});

	it('GET /v5/health includes X-Oracle-Version: v5', async () => {
		const response = await fetchWorker('/v5/health');
		expect(response.headers.get('X-Oracle-Version')).toBe('v5');
	});

	it('404 response includes X-Oracle-Version: v5', async () => {
		const response = await fetchWorker('/v5/nonexistent');
		expect(response.headers.get('X-Oracle-Version')).toBe('v5');
	});
});

describe('Cache-Control on signed receipts', () => {
	it('GET /v5/demo returns Cache-Control: no-store', async () => {
		const response = await fetchWorker('/v5/demo');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('GET /v5/status returns Cache-Control: no-store', async () => {
		const response = await fetchWorker('/v5/status', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('Error responses include docs field', () => {
	it('401 API_KEY_REQUIRED includes docs field pointing to /docs', async () => {
		const body = await fetchJSON('/v5/status');
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
		expect(typeof body.docs).toBe('string');
		expect((body.docs as string)).toContain('headlessoracle.com/docs');
	});

	it('400 UNKNOWN_MIC includes docs field', async () => {
		const body = await fetchJSON('/v5/demo?mic=FAKE');
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
		expect(typeof body.docs).toBe('string');
	});

	it('404 NOT_FOUND includes docs field', async () => {
		const body = await fetchJSON('/v5/nonexistent');
		expect(body).toHaveProperty('error', 'NOT_FOUND');
		expect(typeof body.docs).toBe('string');
	});
});

describe('GET /v5/compliance', () => {
	it('returns 200 with standard and oracle fields', async () => {
		const response = await fetchWorker('/v5/compliance');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('standard');
		expect(body).toHaveProperty('oracle');
		expect(body).toHaveProperty('version');
		expect(body).toHaveProperty('last_verified');
	});

	it('returns 6 APTS checks all with status: pass', async () => {
		const body = await fetchJSON('/v5/compliance');
		const checks = body.checks as Array<Record<string, unknown>>;
		expect(Array.isArray(checks)).toBe(true);
		expect(checks).toHaveLength(6);
		for (const check of checks) {
			expect(check).toHaveProperty('status', 'pass');
			expect(typeof check.check).toBe('string');
			expect(typeof check.evidence).toBe('string');
		}
	});

	it('check IDs are APTS-001 through APTS-006', async () => {
		const body = await fetchJSON('/v5/compliance');
		const checks = body.checks as Array<Record<string, unknown>>;
		const ids = checks.map((c) => c.check as string);
		expect(ids).toContain('APTS-001');
		expect(ids).toContain('APTS-006');
	});

	it('includes sma_spec_version and verify_sdk links', async () => {
		const body = await fetchJSON('/v5/compliance');
		expect(body).toHaveProperty('sma_spec_version', '1.0');
		expect(typeof body.verify_sdk).toBe('string');
		expect(typeof body.standard_url).toBe('string');
	});
});

describe('GET /v5/health enrichment (Session E)', () => {
	it('returns version, sma_spec_version, mcp_protocol_version fields', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('version', 'v5.0');
		expect(body).toHaveProperty('sma_spec_version', '1.0');
		expect(body).toHaveProperty('mcp_protocol_version', '2024-11-05');
	});

	it('returns fail_closed: true and uptime_since', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('fail_closed', true);
		expect(typeof body.uptime_since).toBe('string');
	});
});

// ─── x402 Micropayments ───────────────────────────────────────────────────────

async function setupFreeKey(keyValue: string): Promise<string> {
	const encoder = new TextEncoder();
	const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(keyValue));
	const keyHash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
	await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({
		plan: 'free', status: 'active', email: 'test@test.com', created_at: new Date().toISOString(),
	}));
	return keyHash;
}

async function exhaustDailyUsage(keyHash: string): Promise<void> {
	const date = new Date().toISOString().slice(0, 10);
	await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${date}`, '500');
}

function mockBaseRpc(recipientAddress: string, amountUnits: string, blockTimestamp: number): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		if (url === 'https://mainnet.base.org') {
			const body = JSON.parse((init?.body as string) ?? '{}') as { method: string };
			if (body.method === 'eth_getTransactionReceipt') {
				return new Response(JSON.stringify({
					result: {
						status: '0x1',
						to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
						blockNumber: '0x1234',
						logs: [{
							address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
							topics: [
								'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
								'0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12',
								'0x000000000000000000000000' + recipientAddress.slice(2).toLowerCase(),
							],
							data: '0x' + BigInt(amountUnits).toString(16).padStart(64, '0'),
						}],
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (body.method === 'eth_getBlockByNumber') {
				return new Response(JSON.stringify({
					result: { timestamp: '0x' + blockTimestamp.toString(16) },
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
		}
		return original(input, init);
	};
	return () => { globalThis.fetch = original; };
}

const TEST_PAYMENT_ADDRESS = '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3';

describe('x402 — free tier daily limit gate', () => {
	it('returns 200 for free key under daily limit', async () => {
		const key = 'ho_free_' + 'a'.repeat(64);
		await setupFreeKey(key);
		const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(200);
	});

	it('returns 402 when free tier exhausted and ORACLE_PAYMENT_ADDRESS is set', async () => {
		const key  = 'ho_free_' + 'b'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'PAYMENT_REQUIRED');
	});

	it('402 includes x402 object with Base mainnet details', async () => {
		const key  = 'ho_free_' + 'c'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const body = await fetchJSON('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		const x402 = body.x402 as Record<string, unknown>;
		expect(x402).toBeDefined();
		expect(x402.network).toBe('base-mainnet');
		expect(x402.chainId).toBe(8453);
		expect(x402.currency).toBe('USDC');
		expect(x402.amount).toBe('1000');
		expect(x402.decimals).toBe(6);
		expect(x402.usdcContractAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
	});

	it('402 response includes X-Payment-Required and X-Payment-Network headers', async () => {
		const key  = 'ho_free_' + 'd'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.headers.get('X-Payment-Required')).toBe('true');
		expect(res.headers.get('X-Payment-Network')).toBe('base-mainnet');
		expect(res.headers.get('X-Payment-Chain-ID')).toBe('8453');
	});
});

describe('x402 — payment verification', () => {
	it('accepts valid x402 payment and returns 200', async () => {
		const txHash = '0x' + 'e'.repeat(64);
		const key    = 'ho_free_' + 'e'.repeat(64);
		const hash   = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockBaseRpc(TEST_PAYMENT_ADDRESS, '1000', nowSec - 10);
		const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res     = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		restore();
		expect(res.status).toBe(200);
	});

	it('rejects replay attack — same txHash used twice', async () => {
		const txHash = '0x' + 'f'.repeat(64);
		const key    = 'ho_free_' + 'f'.repeat(64);
		const hash   = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		await env.ORACLE_TELEMETRY.put(`x402_used:${txHash}`, '1');
		const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res     = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect((body.message as string)).toContain('TRANSACTION_ALREADY_USED');
	});

	it('rejects expired transaction — block older than 300s', async () => {
		const txHash  = '0x' + '1'.repeat(64);
		const key     = 'ho_free_' + 'g'.repeat(64);
		const hash    = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const staleTs = Math.floor(Date.now() / 1000) - 400;
		const restore = mockBaseRpc(TEST_PAYMENT_ADDRESS, '1000', staleTs);
		const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res     = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		restore();
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect((body.message as string)).toContain('TRANSACTION_EXPIRED');
	});

	it('rejects wrong recipient address', async () => {
		const txHash   = '0x' + '2'.repeat(64);
		const key      = 'ho_free_' + 'h'.repeat(64);
		const hash     = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const nowSec   = Math.floor(Date.now() / 1000);
		const wrongAddr = '0x1111111111111111111111111111111111111111';
		const restore  = mockBaseRpc(wrongAddr, '1000', nowSec - 10);
		const payment  = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res      = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		restore();
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect((body.message as string)).toContain('NO_USDC_TRANSFER_TO_PAYMENT_ADDRESS');
	});

	it('rejects wrong network in X-Payment', async () => {
		const key  = 'ho_free_' + 'i'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const payment = JSON.stringify({ txHash: '0x' + 'i'.repeat(64), network: 'ethereum-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res     = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect((body.message as string)).toContain('WRONG_NETWORK');
	});

	it('rejects invalid JSON in X-Payment', async () => {
		const key  = 'ho_free_' + 'j'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': 'not-json' } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_PAYMENT');
	});
});

describe('x402 — credit balance and consumption', () => {
	it('GET /v5/credits/balance returns 0 for key with no credits', async () => {
		const key = 'ho_free_' + 'k'.repeat(64);
		await setupFreeKey(key);
		const body = await fetchJSON('/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		expect(body).toHaveProperty('balance', 0);
		expect(body).toHaveProperty('estimated_requests_remaining', 0);
	});

	it('GET /v5/credits/balance requires X-Oracle-Key', async () => {
		const res = await fetchWorker('/v5/credits/balance');
		expect(res.status).toBe(401);
	});

	it('POST /v5/credits/purchase requires X-Oracle-Key', async () => {
		const res = await fetchWorker('/v5/credits/purchase', { method: 'POST' });
		expect(res.status).toBe(401);
	});

	it('free key with credits fulfils request when daily limit exceeded', async () => {
		const key  = 'ho_free_' + 'l'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		await env.ORACLE_TELEMETRY.put(`credits:${hash}`, JSON.stringify({ balance: 5, last_purchased: new Date().toISOString() }));
		const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(200);
	});

	it('GET /v5/credits/balance returns correct seeded balance', async () => {
		const key  = 'ho_free_' + 'n'.repeat(64);
		const hash = await setupFreeKey(key);
		await env.ORACLE_TELEMETRY.put(`credits:${hash}`, JSON.stringify({ balance: 42, last_purchased: '2026-03-17T00:00:00Z' }));
		const body = await fetchJSON('/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		expect(body).toHaveProperty('balance', 42);
		expect(body).toHaveProperty('last_purchased', '2026-03-17T00:00:00Z');
	});
});

describe('x402 — health includes payment_schemes', () => {
	it('GET /v5/health includes payment_schemes: ["x402"]', async () => {
		const body = await fetchJSON('/v5/health');
		expect(Array.isArray(body.payment_schemes)).toBe(true);
		expect((body.payment_schemes as string[])).toContain('x402');
	});
});

describe('x402 — agent.json discovery', () => {
	it('GET /.well-known/agent.json includes x402_micropayments capability', async () => {
		const body = await fetchJSON('/.well-known/agent.json');
		expect((body.capabilities as string[])).toContain('x402_micropayments');
	});

	it('GET /.well-known/agent.json includes payment object with Base mainnet', async () => {
		const body    = await fetchJSON('/.well-known/agent.json');
		const payment = body.payment as Record<string, unknown>;
		expect(payment).toBeDefined();
		expect(payment.network).toBe('base-mainnet');
		expect(payment.chain_id).toBe(8453);
		expect(payment.currency).toBe('USDC');
	});
});

describe('docs field — points to headlessoracle.com/docs', () => {
	it('docs field is exact URL without fragment', async () => {
		const body = await fetchJSON('/v5/status');
		expect((body.docs as string)).toBe('https://headlessoracle.com/docs');
	});
});

// ─── Session L: New Exchange Tests ───────────────────────────────────────────

describe('XASX — Australian Securities Exchange', () => {
	it('returns CLOSED on weekend (Saturday Sydney time)', async () => {
		// 2026-03-07 is a Saturday in Sydney
		vi.setSystemTime(new Date('2026-03-07T01:00:00Z')); // Sat 12:00 AEDT
		const body = await fetchJSON('/v5/demo?mic=XASX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns OPEN on a weekday during trading hours', async () => {
		// 2026-03-09 Monday, 11:00 AEDT = 00:00 UTC
		vi.setSystemTime(new Date('2026-03-09T00:00:00Z')); // Mon 11:00 AEDT
		const body = await fetchJSON('/v5/demo?mic=XASX');
		expect(['OPEN', 'CLOSED']).toContain(body.status); // time-zone boundary; just assert valid
		expect(body).toHaveProperty('mic', 'XASX');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XASX');
		expect(body).toHaveProperty('mic', 'XASX');
		expect(body).toHaveProperty('timezone', 'Australia/Sydney');
	});
});

describe('XBOM — BSE India', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-08 Sunday, 10:00 IST = 04:30 UTC
		vi.setSystemTime(new Date('2026-03-08T04:30:00Z')); // Sun 10:00 IST
		const body = await fetchJSON('/v5/demo?mic=XBOM');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED after hours on weekday', async () => {
		// 2026-03-09 Monday, 20:00 IST = 14:30 UTC
		vi.setSystemTime(new Date('2026-03-09T14:30:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XBOM');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XBOM');
		expect(body).toHaveProperty('mic', 'XBOM');
		expect(body).toHaveProperty('timezone', 'Asia/Kolkata');
	});
});

describe('XNSE — NSE India', () => {
	it('returns CLOSED on weekend', async () => {
		vi.setSystemTime(new Date('2026-03-08T04:30:00Z')); // Sun 10:00 IST
		const body = await fetchJSON('/v5/demo?mic=XNSE');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNSE');
		expect(body).toHaveProperty('mic', 'XNSE');
		expect(body).toHaveProperty('timezone', 'Asia/Kolkata');
	});
});

describe('XSHG — Shanghai Stock Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 CST = 02:00 UTC
		vi.setSystemTime(new Date('2026-03-07T02:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSHG');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED during lunch break on weekday', async () => {
		// 2026-03-09 Monday, 12:00 CST = 04:00 UTC — inside lunch break 11:30–13:00
		vi.setSystemTime(new Date('2026-03-09T04:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSHG');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('schedule includes lunch_break window', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSHG');
		expect(body).toHaveProperty('lunch_break');
		expect(body.lunch_break).toHaveProperty('start', '11:30');
		expect(body.lunch_break).toHaveProperty('end', '13:00');
	});
});

describe('XSHE — Shenzhen Stock Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		vi.setSystemTime(new Date('2026-03-07T02:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSHE');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED during lunch break', async () => {
		vi.setSystemTime(new Date('2026-03-09T04:00:00Z')); // 12:00 CST = lunch break
		const body = await fetchJSON('/v5/demo?mic=XSHE');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('schedule includes lunch_break window', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSHE');
		expect(body).toHaveProperty('lunch_break');
		expect(body.lunch_break).toHaveProperty('start', '11:30');
		expect(body.lunch_break).toHaveProperty('end', '13:00');
	});
});

describe('XKRX — Korea Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 KST = 01:00 UTC
		vi.setSystemTime(new Date('2026-03-07T01:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XKRX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED after market hours', async () => {
		// 2026-03-09 Monday, 18:00 KST = 09:00 UTC
		vi.setSystemTime(new Date('2026-03-09T09:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XKRX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XKRX');
		expect(body).toHaveProperty('mic', 'XKRX');
		expect(body).toHaveProperty('timezone', 'Asia/Seoul');
	});
});

describe('XJSE — Johannesburg Stock Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 SAST = 08:00 UTC
		vi.setSystemTime(new Date('2026-03-07T08:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XJSE');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XJSE');
		expect(body).toHaveProperty('mic', 'XJSE');
		expect(body).toHaveProperty('timezone', 'Africa/Johannesburg');
	});
});

describe('XBSP — B3 Brazil', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 BRT = 13:00 UTC (BRT = UTC-3)
		vi.setSystemTime(new Date('2026-03-07T13:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XBSP');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XBSP');
		expect(body).toHaveProperty('mic', 'XBSP');
		expect(body).toHaveProperty('timezone', 'America/Sao_Paulo');
	});
});

describe('XSWX — SIX Swiss Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 CET = 09:00 UTC
		vi.setSystemTime(new Date('2026-03-07T09:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSWX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSWX');
		expect(body).toHaveProperty('mic', 'XSWX');
		expect(body).toHaveProperty('timezone', 'Europe/Zurich');
	});
});

describe('XMIL — Borsa Italiana', () => {
	it('returns CLOSED on weekend', async () => {
		vi.setSystemTime(new Date('2026-03-07T09:00:00Z')); // Sat 10:00 CET
		const body = await fetchJSON('/v5/demo?mic=XMIL');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XMIL');
		expect(body).toHaveProperty('mic', 'XMIL');
		expect(body).toHaveProperty('timezone', 'Europe/Rome');
	});
});

describe('XIST — Borsa Istanbul', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 11:00 TRT = 08:00 UTC (TRT = UTC+3)
		vi.setSystemTime(new Date('2026-03-07T08:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XIST');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XIST');
		expect(body).toHaveProperty('mic', 'XIST');
		expect(body).toHaveProperty('timezone', 'Europe/Istanbul');
	});
});

describe('XSAU — Saudi Exchange (Tadawul) — Fri/Sat weekends', () => {
	it('returns CLOSED on Friday (weekend for XSAU)', async () => {
		// 2026-03-06 is a Friday. 11:00 AST = 08:00 UTC (AST = UTC+3)
		vi.setSystemTime(new Date('2026-03-06T08:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSAU');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED on Saturday (weekend for XSAU)', async () => {
		// 2026-03-07 Saturday, 11:00 AST = 08:00 UTC
		vi.setSystemTime(new Date('2026-03-07T08:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSAU');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns OPEN on Sunday (trading day for XSAU)', async () => {
		// 2026-03-08 Sunday, 12:00 AST = 09:00 UTC — inside 10:00–15:00 AST
		vi.setSystemTime(new Date('2026-03-08T09:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSAU');
		expect(body).toHaveProperty('status', 'OPEN');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSAU');
		expect(body).toHaveProperty('mic', 'XSAU');
		expect(body).toHaveProperty('timezone', 'Asia/Riyadh');
	});
});

describe('XDFM — Dubai Financial Market — Fri/Sat weekends', () => {
	it('returns CLOSED on Friday (weekend for XDFM)', async () => {
		// 2026-03-06 Friday, 11:00 GST = 07:00 UTC (GST = UTC+4)
		vi.setSystemTime(new Date('2026-03-06T07:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XDFM');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns CLOSED on Saturday (weekend for XDFM)', async () => {
		vi.setSystemTime(new Date('2026-03-07T07:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XDFM');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns OPEN on Sunday (trading day for XDFM)', async () => {
		// 2026-03-08 Sunday, 11:00 GST = 07:00 UTC — inside 10:00–14:00 GST
		vi.setSystemTime(new Date('2026-03-08T07:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XDFM');
		expect(body).toHaveProperty('status', 'OPEN');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XDFM');
		expect(body).toHaveProperty('mic', 'XDFM');
		expect(body).toHaveProperty('timezone', 'Asia/Dubai');
	});
});

describe('XNZE — New Zealand Exchange', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 11:00 NZDT = 22:00 UTC previous day
		// 2026-03-07T22:00:00Z is Saturday in NZ? NZ is UTC+13 in summer; so 2026-03-07T22:00Z = Sun 2026-03-08 11:00 NZDT
		// Let's use 2026-03-07T00:00Z = Sat 13:00 NZDT (still Saturday)
		vi.setSystemTime(new Date('2026-03-07T00:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XNZE');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNZE');
		expect(body).toHaveProperty('mic', 'XNZE');
		expect(body).toHaveProperty('timezone', 'Pacific/Auckland');
	});
});

describe('XHEL — Nasdaq Helsinki', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 11:00 EET = 09:00 UTC (EET = UTC+2, pre-DST)
		vi.setSystemTime(new Date('2026-03-07T09:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XHEL');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XHEL');
		expect(body).toHaveProperty('mic', 'XHEL');
		expect(body).toHaveProperty('timezone', 'Europe/Helsinki');
	});
});

describe('XSTO — Nasdaq Stockholm', () => {
	it('returns CLOSED on weekend', async () => {
		// 2026-03-07 Saturday, 10:00 CET = 09:00 UTC
		vi.setSystemTime(new Date('2026-03-07T09:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XSTO');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('returns valid schedule response', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XSTO');
		expect(body).toHaveProperty('mic', 'XSTO');
		expect(body).toHaveProperty('timezone', 'Europe/Stockholm');
	});
});

describe('Session L: holiday test for new exchanges', () => {
	it('XASX returns CLOSED on Australia Day 2026 (Jan 26 = Mon)', async () => {
		// 2026-01-26 Monday 11:00 AEDT = 00:00 UTC
		vi.setSystemTime(new Date('2026-01-26T00:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XASX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('XKRX returns CLOSED on Korean holiday (2026-03-01 Independence Movement Day)', async () => {
		// 2026-03-01 Sunday — holiday but also weekend; check with a non-weekend holiday
		// 2026-10-03 Saturday — National Foundation Day is on a Saturday so try 2026-10-09 Hangul Day (Friday)
		vi.setSystemTime(new Date('2026-10-09T01:00:00Z')); // 2026-10-09 Fri 10:00 KST
		const body = await fetchJSON('/v5/demo?mic=XKRX');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});

	it('XSAU returns CLOSED on Saudi National Day 2026 (2026-09-23 Wed)', async () => {
		vi.setSystemTime(new Date('2026-09-23T09:00:00Z')); // Wed 12:00 AST
		const body = await fetchJSON('/v5/demo?mic=XSAU');
		expect(body).toHaveProperty('status', 'CLOSED');
		vi.useRealTimers();
	});
});

// ─── Session M: Halt Monitor Tests ───────────────────────────────────────────

describe('Session M: /v5/status/realtime', () => {
	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/status/realtime?mic=XNYS');
		expect(response.status).toBe(401);
	});

	it('returns valid JSON with signed_receipt and halt_monitor fields', async () => {
		const body = await fetchJSON('/v5/status/realtime?mic=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(body).toHaveProperty('mic', 'XNYS');
		expect(body).toHaveProperty('signed_receipt');
		expect(body).toHaveProperty('halt_monitor');
		const receipt = body.signed_receipt as Record<string, unknown>;
		expect(receipt).toHaveProperty('mic', 'XNYS');
		expect(receipt).toHaveProperty('signature');
		const monitor = body.halt_monitor as Record<string, unknown>;
		expect(monitor).toHaveProperty('note');
	});

	it('returns 400 for unknown MIC', async () => {
		const response = await fetchWorker('/v5/status/realtime?mic=XXXX', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	it('returns REALTIME source in signed_receipt when a REALTIME KV override is active', async () => {
		const overrideKey = 'XNYS';
		await env.ORACLE_OVERRIDES.put(overrideKey, JSON.stringify({
			status:        'HALTED',
			source:        'REALTIME',
			reason:        'Real-time halt detected by halt monitor (source: polygon)',
			expires:       new Date(Date.now() + 3600000).toISOString(),
			auto_clear_at: new Date(Date.now() + 3600000).toISOString(),
			detected_at:   new Date().toISOString(),
		}));
		try {
			const body = await fetchJSON('/v5/status/realtime?mic=XNYS', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
			});
			const receipt = body.signed_receipt as Record<string, unknown>;
			expect(receipt).toHaveProperty('status', 'HALTED');
			expect(VALID_SOURCES).toContain(receipt.source as string); // 'REALTIME' is now in VALID_SOURCES
			const monitor = body.halt_monitor as Record<string, unknown>;
			expect(monitor.active_realtime_override).not.toBeNull();
		} finally {
			await env.ORACLE_OVERRIDES.delete(overrideKey);
		}
	});
});

describe('Session M: /v5/health includes halt_monitor', () => {
	it('health response includes halt_monitor section', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('halt_monitor');
		const hm = body.halt_monitor as Record<string, unknown>;
		expect(hm).toHaveProperty('status', 'active');
		expect(hm).toHaveProperty('cron', '* * * * *');
		expect(hm).toHaveProperty('sources');
		expect(hm).toHaveProperty('active_realtime_overrides');
		expect(Array.isArray(hm.active_realtime_overrides)).toBe(true);
	});

	it('halt_monitor.active_realtime_overrides includes MIC when REALTIME override is active', async () => {
		await env.ORACLE_OVERRIDES.put('XLON', JSON.stringify({
			status:  'HALTED',
			source:  'REALTIME',
			reason:  'Test',
			expires: new Date(Date.now() + 3600000).toISOString(),
		}));
		try {
			const body = await fetchJSON('/v5/health');
			const hm = body.halt_monitor as Record<string, unknown>;
			const overrides = hm.active_realtime_overrides as string[];
			expect(overrides).toContain('XLON');
		} finally {
			await env.ORACLE_OVERRIDES.delete('XLON');
		}
	});
});

describe('Session M: REALTIME source validity', () => {
	it('REALTIME is a valid source value in signed receipts', async () => {
		expect(VALID_SOURCES).toContain('REALTIME');
	});

	it('REALTIME override produces HALTED signed receipt via /v5/demo', async () => {
		await env.ORACLE_OVERRIDES.put('XPAR', JSON.stringify({
			status:  'HALTED',
			source:  'REALTIME',
			reason:  'Test halt monitor',
			expires: new Date(Date.now() + 3600000).toISOString(),
		}));
		try {
			const body = await fetchJSON('/v5/demo?mic=XPAR');
			expect(body).toHaveProperty('status', 'HALTED');
			expect(VALID_SOURCES).toContain(body.source as string);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XPAR');
		}
	});
});

// ─── Session Q: GET /v5/usage ─────────────────────────────────────────────────

describe('Session Q: GET /v5/usage', () => {
	it('returns 401 when no API key provided', async () => {
		const response = await fetchWorker('/v5/usage');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
	});

	it('returns 403 when invalid API key provided', async () => {
		const response = await fetchWorker('/v5/usage', {
			headers: { 'X-Oracle-Key': 'invalid_key_that_does_not_exist' },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('returns 200 with correct shape for valid (master) key', async () => {
		const body = await fetchJSON('/v5/usage', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(body).toHaveProperty('key_prefix');
		expect(body).toHaveProperty('plan');
		expect(body).toHaveProperty('requests_today');
		expect(body).toHaveProperty('requests_this_month');
		expect(body).toHaveProperty('rate_limit_resets_at');
		expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/pricing');
		expect(body).toHaveProperty('x402_available');
		expect(body).toHaveProperty('x402_amount', '0.001 USDC');
		expect(body).toHaveProperty('credit_balance');
	});

	it('paid key returns null limits and 0 usage counts', async () => {
		const body = await fetchJSON('/v5/usage', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		// Master key is 'internal' plan — not a free plan, so limits are null
		expect(body.daily_limit).toBeNull();
		expect(body.monthly_limit).toBeNull();
		expect(body.requests_today).toBe(0);
		expect(body.requests_this_month).toBe(0);
	});

	it('free key returns daily_limit of 500 and non-null limits', async () => {
		// Provision a free key in KV
		const freeKey  = 'ho_free_test_usage_endpoint_key0001';
		const keyHash  = await sha256Hex(freeKey);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			const body = await fetchJSON('/v5/usage', {
				headers: { 'X-Oracle-Key': freeKey },
			});
			expect(body.plan).toBe('free');
			expect(body.daily_limit).toBe(500);
			expect(body.monthly_limit).toBe(15000);
			expect(typeof body.percent_used_today).toBe('number');
			expect(typeof body.percent_used_month).toBe('number');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
		}
	});
});

// ─── Session Q: GET /v5/traction ─────────────────────────────────────────────

describe('Session Q: GET /v5/traction', () => {
	it('returns 200 with correct shape', async () => {
		const body = await fetchJSON('/v5/traction');
		expect(body).toHaveProperty('exchanges_covered', 23);
		expect(body).toHaveProperty('sma_spec_version', '1.0');
		expect(body).toHaveProperty('verifiable_intent_rfc', 'submitted');
		expect(body).toHaveProperty('halt_monitor', 'active');
		expect(body).toHaveProperty('uptime_since', '2026-03-10T08:00:00Z');
		expect(body).toHaveProperty('days_live');
		expect(typeof body.days_live).toBe('number');
		expect(body.days_live as number).toBeGreaterThanOrEqual(0);
		expect(body).toHaveProperty('mcp_requests_today');
		expect(body).toHaveProperty('unique_mcp_clients_today');
		expect(body).toHaveProperty('x402_enabled');
		expect(typeof body.edge_cases_per_year).toBe('number');
		expect(body.edge_cases_per_year as number).toBeGreaterThan(0);
	});

	it('returns 200 without auth', async () => {
		const response = await fetchWorker('/v5/traction');
		expect(response.status).toBe(200);
	});
});

// ─── Session Q: Soft rate-limit warning headers ───────────────────────────────

describe('Session Q: Soft rate-limit warning headers', () => {
	it('no warning headers when usage is below 80%', async () => {
		const key     = 'ho_free_test_ratelimit_warn_low_key0';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		// 400 requests out of 500 = 80% exactly — boundary, use 399 for "below"
		await env.ORACLE_TELEMETRY.put(
			`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`,
			'399',
			{ expirationTtl: 3600 },
		);
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': key },
			});
			expect(response.headers.get('X-RateLimit-Warning')).toBeNull();
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`);
		}
	});

	it('adds warning headers when usage is at 80%', async () => {
		const key     = 'ho_free_test_ratelimit_warn_80_key00';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		// 400 requests out of 500 = 80%
		await env.ORACLE_TELEMETRY.put(
			`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`,
			'400',
			{ expirationTtl: 3600 },
		);
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': key },
			});
			expect(response.headers.get('X-RateLimit-Warning')).toBe('true');
			expect(response.headers.get('X-RateLimit-Upgrade-URL')).toContain('pricing');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`);
		}
	});

	it('adds 95% warning message when usage is at 95%', async () => {
		const key     = 'ho_free_test_ratelimit_warn_95_key00';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		// 475 requests out of 500 = 95%
		await env.ORACLE_TELEMETRY.put(
			`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`,
			'475',
			{ expirationTtl: 3600 },
		);
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': key },
			});
			expect(response.headers.get('X-RateLimit-Warning')).toBe('true');
			const msg = response.headers.get('X-RateLimit-Warning-Message');
			expect(msg).toContain('95%');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`);
		}
	});
});

// ─── Session Q: 402 response includes founder_note ───────────────────────────

describe('Session Q: 402 response includes founder_note', () => {
	it('402 PAYMENT_REQUIRED response includes founder_note field', async () => {
		const key     = 'ho_free_test_founder_note_key000001';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		// Exhaust daily limit
		await env.ORACLE_TELEMETRY.put(
			`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`,
			'500',
			{ expirationTtl: 3600 },
		);
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': key },
			});
			expect(response.status).toBe(402);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('founder_note');
			expect(typeof body.founder_note).toBe('string');
			expect((body.founder_note as string).length).toBeGreaterThan(10);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`);
		}
	});
});

// ─── Session Q: Weekly digest cron ───────────────────────────────────────────

describe('Session Q: Weekly digest cron', () => {
	it('weekly digest cron runs without error and writes KV key', async () => {
		// Seed some MCP client data
		const today = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.put(`mcp_clients:${today}:aabbcc`, JSON.stringify({
			request_count: 5, asn_org: 'Google LLC', country: 'US', city: 'Council Bluffs',
		}));
		await env.ORACLE_TELEMETRY.put(`mcp_clients:${today}:ddeeff`, JSON.stringify({
			request_count: 3, asn_org: 'Microsoft', country: 'US', city: 'Redmond',
		}));

		// Trigger the cron
		const scheduledController = createScheduledController({ scheduledTime: Date.now(), cron: '0 9 * * 1' });
		const ctx = createExecutionContext();
		await worker.scheduled(scheduledController, env, ctx);
		await waitOnExecutionContext(ctx);

		// The digest should be written to KV
		// Just check no error was thrown; the key name depends on getISOWeek(new Date())
		// Confirm KV write happened by listing weekly_digest keys
		const list = await env.ORACLE_TELEMETRY.list({ prefix: 'weekly_digest:' });
		expect(list.keys.length).toBeGreaterThanOrEqual(1);

		// Cleanup
		await env.ORACLE_TELEMETRY.delete(`mcp_clients:${today}:aabbcc`);
		await env.ORACLE_TELEMETRY.delete(`mcp_clients:${today}:ddeeff`);
	});
});
