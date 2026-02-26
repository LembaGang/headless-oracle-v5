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
		expect(body).toHaveProperty('schema_version', 'v5.0');
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
			expect(body).toHaveProperty('schema_version', 'v5.0');
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
			'source', 'schema_version', 'public_key_id', 'signature',
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

	it('tools/call list_exchanges → 7 exchanges with all MIC codes', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 6, method: 'tools/call',
			params: { name: 'list_exchanges', arguments: {} },
		});
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<{ type: string; text: string }>;
		const data = JSON.parse(content[0].text) as Record<string, unknown>;

		const exchanges = data.exchanges as Array<Record<string, unknown>>;
		expect(exchanges).toHaveLength(7);

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

	it('unknown method prompts/list → JSON-RPC error code -32601', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 8, method: 'prompts/list' });
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(true);
		const error = body.error as Record<string, unknown>;
		expect(error).toHaveProperty('code', -32601);
	});

	it('GET /mcp → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/mcp');
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});
});

// ─── GET /v5/batch ────────────────────────────────────────────────────────────

describe('GET /v5/batch', () => {
	it('returns 401 without API key', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,XNAS');
		expect(response.status).toBe(401);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
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

	it('all 7 MICs in one batch returns 7 receipts', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNAS,XLON,XJPX,XPAR,XHKG,XSES', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(7);
		const mics = receipts.map((r) => r.mic as string);
		for (const mic of ALL_MICS) {
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

// ─── Billing: POST /v5/checkout ──────────────────────────────────────────────

describe('POST /v5/checkout', () => {
	it('GET /v5/checkout → 405 Method Not Allowed', async () => {
		const response = await fetchWorker('/v5/checkout');
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('POST /v5/checkout → 200 with Paddle url when Paddle responds OK', async () => {
		const mockCheckoutUrl = 'https://buy.paddle.com/checkout/cs_test_mock_txn';

		const originalFetch = globalThis.fetch;
		// Replace global fetch only for Paddle API calls
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				return new Response(JSON.stringify({ data: { checkout: { url: mockCheckoutUrl } } }), {
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
});
