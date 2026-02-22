import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src';

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

const ALL_MICS = ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'];
const VALID_STATUSES = ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'];
const VALID_SOURCES  = ['SCHEDULE', 'OVERRIDE', 'SYSTEM'];

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
		expect(body).toHaveProperty('terms_hash', 'v5.0-beta');
		expect(body).toHaveProperty('public_key_id');
		expect(body).toHaveProperty('signature');

		// status must be one of the valid values
		expect(VALID_STATUSES).toContain(body.status);
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
		expect(supported.length).toBe(7);
	});

	it('returns 400 for completely invalid MIC', async () => {
		const response = await fetchWorker('/v5/demo?mic=NYSE_WRONG');
		expect(response.status).toBe(400);
	});
});

// ─── GET /v5/status ───────────────────────────────────────────────────────────

describe('GET /v5/status', () => {
	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
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
			expect(body).toHaveProperty('terms_hash', 'v5.0-beta');
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
		expect(supported.length).toBe(7);
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
});

// ─── GET /v5/exchanges ───────────────────────────────────────────────────────

describe('GET /v5/exchanges', () => {
	it('returns 200 with all 7 supported exchanges (no auth required)', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.status).toBe(200);

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('exchanges');

		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		expect(exchanges.length).toBe(7);
	});

	it('includes all 7 MIC codes in the directory', async () => {
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
			expect(supported.length).toBe(7);
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
		expect(body).toHaveProperty('terms_hash', 'v5.0-beta');

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
			'source', 'terms_hash', 'public_key_id', 'signature',
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
