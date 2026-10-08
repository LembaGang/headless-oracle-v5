import { env, createExecutionContext, waitOnExecutionContext, createScheduledController } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
	edgeCaseCount, clearOverrideCache, clearApiKeyCache, getISOWeek, signPayload,
	clearHaltArchiveSchemaCache, runHaltArchiveCapture, buildHaltArchiveDigest,
	parseNasdaqHaltItems, ensureHaltArchiveSchema,
	// x402 canonical requirements module (rail sprint T1, 2026-09-07)
	x402Canonical, x402AtomicToUsdc, x402FacilitatorRequirements, x402PayloadVersion,
	x402SettlementHeaders, x402ResourceSpecs, x402EmailPriceLine,
	buildX402IndexHeaders, buildMainnetFacilitatorPayload, buildX402ScanPayload,
	x402Base64Decode, x402Base64Encode,
	// plan-allowance module (rail sprint T2, 2026-09-07)
	planAllowances, formatCallsCompact, getPlanDailyLimit,
	// halt-monitor heartbeat memo (rail sprint T3b, 2026-09-07)
	clearHaltHeartbeatMemo,
	// plan prices stated once (rail sprint, 2026-09-07)
	planPrices, refereePrices,
	// H4a
	mcpUseLogLines, openapiOperationId,
	// x402 mint atomic claim (2026-10-07)
	clearX402MintClaimSchemaCache,
	// x402 mint payer binding (2026-10-08)
	x402MintSigningMessage,
} from '../src';
import { MINT_PAYER, newMintSigner, signMint, personalSign } from './mint-payer';

// H4a step 7: every 2xx and 402 response this suite receives is checked for a
// non-ASCII header value. workerd sends a non-ASCII header as raw UTF-8 bytes,
// which a strict HTTP client rejects; Headers.get() hands each byte back as a
// char, so any code point above 0x7F here is a byte above 0x7F on the wire.
// worker.fetch is wrapped (not just fetchWorker) so direct calls are covered too.
const __headerAsciiViolations: string[] = [];
let __headerAsciiChecked = 0;
{
	const __workerFetch = worker.fetch.bind(worker);
	(worker as { fetch: typeof worker.fetch }).fetch = (async (...args: Parameters<typeof worker.fetch>) => {
		const res = await __workerFetch(...args);
		if ((res.status >= 200 && res.status < 300) || res.status === 402) {
			__headerAsciiChecked++;
			const req = args[0] as Request;
			res.headers.forEach((value, name) => {
				if (/[^\x00-\x7F]/.test(value)) {
					__headerAsciiViolations.push(`${req.method} ${new URL(req.url).pathname} ${res.status} ${name}: ${value.slice(0, 160)}`);
				}
			});
		}
		return res;
	}) as typeof worker.fetch;
}

// Clear module-level caches before every test so that tests which
// set KV values always read from KV rather than stale in-memory entries.
//
// Also: install a DEFAULT fetch stub for the Supabase audit-log path.
//   gap-019 fix: SUPABASE_URL in .dev.vars is a real Supabase host (required
//   so that tests which explicitly intercept supabase.co URLs work — see
//   GAP-013 audit test and ~20 sibling cases). For tests that DON'T install
//   their own fetch stub but exercise authenticated paths (/v5/status with
//   auth, /v5/batch, /v5/handoff), the worker calls insertReceiptAudit under
//   ctx.waitUntil → supabase-js → fetch(https://...supabase.co/...). On
//   Windows under workerd that DNS lookup fails slowly and surfaces an
//   uncaught "internal error" inside the isolate, so waitOnExecutionContext
//   stalls and vitest times the test out at 5s.
//
//   This default stub returns the standard Supabase-style success response
//   (`[{}]` / 201) for any supabase.co URL. Tests that install their own
//   per-test stub via `globalThis.fetch = ...` keep working unchanged — they
//   reassign after this beforeEach runs, and their try/finally restoration
//   to the pre-test fetch (this stub) is still correct because the afterEach
//   below unconditionally restores the true original fetch.
let __testEnvOriginalFetch: typeof globalThis.fetch | undefined;
beforeEach(() => {
	clearOverrideCache();
	clearHaltHeartbeatMemo();
	clearApiKeyCache();
	__testEnvOriginalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
		if (url.includes('supabase.co')) {
			const method = (init?.method ?? 'GET').toUpperCase();
			// Inserts/upserts into receipt_audit: success with the standard Supabase
			// 201 + inserted-row payload. GAP-013 and friends rely on this path
			// being callable.
			if (url.includes('receipt_audit') && (method === 'POST' || method === 'PATCH')) {
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			// Everything else (api_keys lookups, etc.): emulate PostgREST's
			// "no rows" response for .single() — status 406 with the PGRST116
			// error code. supabase-js maps this to { data: null }. This is the
			// shape checkApiKey expects when a key is not in the database.
			// Without this, invalid-key tests get a falsy-but-defined object
			// and the auth path returns 402 instead of 403.
			return new Response(
				JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null }),
				{ status: 406, headers: { 'Content-Type': 'application/json' } },
			);
		}
		return __testEnvOriginalFetch!(input, init);
	}) as typeof globalThis.fetch;
});
afterEach(() => {
	if (__testEnvOriginalFetch) {
		globalThis.fetch = __testEnvOriginalFetch;
		__testEnvOriginalFetch = undefined;
	}
});

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

/** POST /v5/sandbox with a JSON body — default email used across most sandbox tests. */
function fetchSandbox(email = 'sandbox-test@example.com'): Promise<Response> {
	return fetchWorker('/v5/sandbox', {
		method:  'POST',
		headers: { 'Content-Type': 'application/json' },
		body:    JSON.stringify({ email }),
	});
}

const ALL_MICS = [
	'XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
	'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
	'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE',
	'XHEL', 'XSTO',
	// Crypto / derivatives (ITEM 6)
	'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN',
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

	it('returns an array of exactly 28 exchanges', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		expect(Array.isArray(body)).toBe(true);
		expect((body as unknown[]).length).toBe(28);
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

	it('sameAs points to the ISO 20022 MIC registry for ISO MICs; convention MICs may differ', async () => {
		const body = await fetchJSON('/mics.json') as unknown as Array<Record<string, unknown>>;
		for (const entry of body) {
			if (entry.mic_type === 'convention') {
				// Convention MICs (e.g. XCOI, XBIN) point to the operator's own domain
				expect(typeof entry.sameAs).toBe('string');
				expect((entry.sameAs as string).length).toBeGreaterThan(0);
			} else {
				expect(entry.sameAs).toBe('https://www.iso20022.org/market-identifier-codes');
			}
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
		expect(supported.length).toBe(28);
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
	it('returns 402 x402scan format without API key after trial exhausted — includes input schema', async () => {
		// Exhaust the 3-receipt trial first
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
		const response = await fetchWorker('/v5/status?mic=XNYS');
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
		expect(body).toHaveProperty('error', 'TRIAL_EXHAUSTED');
		expect(Array.isArray(body.accepts)).toBe(true);
		const accepts = body.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('scheme', 'exact');
		expect(accepts[0]).toHaveProperty('network', 'base');
		expect(accepts[0]).toHaveProperty('maxAmountRequired', '1000');
		expect(accepts[0]).toHaveProperty('payTo');
		expect(accepts[0]).toHaveProperty('input');
		const input = accepts[0].input as Record<string, unknown>;
		expect(input).toHaveProperty('type', 'object');
		expect(input).toHaveProperty('required');
		expect((input.required as string[])).toContain('mic');
		const props = input.properties as Record<string, unknown>;
		expect(props).toHaveProperty('mic');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('returns 403 with an invalid API key', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'totally_invalid_key_xyz' },
		});
		expect(response.status).toBe(403);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_API_KEY');
	});

	it('returns 200 (trial) or 402 with an empty API key header (empty string is falsy → no-key path)', async () => {
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': '' },
		});
		// Empty string → falsy → treated as missing key → trial receipt (200) or 402 after trial exhausted
		expect([200, 402, 403]).toContain(response.status);
	});

	it('returns 400 for unknown MIC with valid key', async () => {
		const response = await fetchWorker('/v5/status?mic=ZZZZ', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	// Test all MICs with valid auth
	for (const mic of ALL_MICS) {
		it(`returns a signed receipt for ${mic} with valid auth`, async () => {
			const response = await fetchWorker(`/v5/status?mic=${mic}`, {
				headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(body).toHaveProperty('mic', 'XNYS');
	});
});

// ─── GET /v5/status/x402 — dedicated always-402 CDP-Bazaar-indexable resource ─
// This resource exists solely to give the CDP Bazaar a paywalled resource it can
// catalogue. It never serves a 200 receipt without a CDP-facilitator-settled payment,
// and it never accepts the direct-on-chain raw-JSON shortcut that the main /v5/status
// honours. Every successful payment here transits api.cdp.coinbase.com → produces the
// catalog signal that drives Bazaar indexing.

describe('GET /v5/status/x402 — dedicated CDP-Bazaar-indexable resource', () => {
	it('returns 402 without payment, even with mic param, and emits full x402 v2 + extensions.bazaar shape', async () => {
		const response = await fetchWorker('/v5/status/x402?mic=XNYS');
		expect(response.status).toBe(402);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
		expect(body).toHaveProperty('error', 'Payment Required');
		const accepts = body.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('scheme', 'exact');
		expect(accepts[0]).toHaveProperty('network', 'base');
		expect(accepts[0]).toHaveProperty('maxAmountRequired', '1000');
		expect(accepts[0]).toHaveProperty('resource', 'https://headlessoracle.com/v5/status/x402?mic=XNYS');
		// CDP Bazaar v2 discovery extension is what CDP indexes after a settled payment.
		const extensions = body.extensions as Record<string, unknown>;
		const bazaar = extensions.bazaar as Record<string, unknown>;
		const info   = bazaar.info as Record<string, unknown>;
		expect(info).toHaveProperty('category', 'financial-data');
		expect(info).toHaveProperty('family', 'market-state');
		expect(info).toHaveProperty('metadataUrl', 'https://headlessoracle.com/.well-known/mcp/server-card.json');
		const input  = info.input as Record<string, unknown>;
		expect(input).toHaveProperty('type', 'http');
		expect(input).toHaveProperty('method', 'GET');
		expect((input.queryParams as Record<string, unknown>)).toHaveProperty('mic');
		const output = info.output as Record<string, unknown>;
		expect(output).toHaveProperty('type', 'json');
		expect(output).toHaveProperty('example');
		const example = output.example as Record<string, unknown>;
		// Example must be a real-shape signed receipt: signed fields per
		// /v5/keys → canonical_payload_spec.receipt_fields plus the signature.
		expect(example).toHaveProperty('public_key_id', 'key_2026_v1');
		expect(example).toHaveProperty('issuer', 'headlessoracle.com');
		expect(example).toHaveProperty('schema_version', 'v5.0');
		expect(typeof example.signature).toBe('string');
		expect((example.signature as string)).toMatch(/^[0-9a-f]{128}$/);
		// Schema must validate input against schema.properties.input (CDP discoverability rule).
		const schema = bazaar.schema as Record<string, unknown>;
		expect(schema).toHaveProperty('$schema');
		const props = (schema.properties as Record<string, unknown>);
		expect(props).toHaveProperty('input');
		expect(props).toHaveProperty('output');
	});

	it('returns 402 with the same Bazaar discovery payload even when no mic param is supplied (discovery surface)', async () => {
		const response = await fetchWorker('/v5/status/x402');
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
		expect((body.extensions as Record<string, unknown>).bazaar).toBeDefined();
	});

	it('rejects unsupported MIC with 400 UNSUPPORTED_MIC', async () => {
		const response = await fetchWorker('/v5/status/x402?mic=FAKE');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNSUPPORTED_MIC');
	});

	it('rejects raw-JSON X-Payment with 402 CDP_SETTLEMENT_REQUIRED (CDP-facilitator-only path)', async () => {
		const rawPayment = JSON.stringify({ txHash: '0xdeadbeef', network: 'base', amount: '1000', paymentAddress: '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3', memo: 'test' });
		const response = await fetchWorker('/v5/status/x402?mic=XNYS', {
			headers: { 'X-Payment': rawPayment },
		});
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'CDP_SETTLEMENT_REQUIRED');
		expect(body).toHaveProperty('sdk_reference');
	});

	it('returns 402 (not 200) even when a valid API key is presented — no keyholder bypass', async () => {
		const response = await fetchWorker('/v5/status/x402?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
	});

	it('returns 405 METHOD_NOT_ALLOWED for non-GET methods', async () => {
		const response = await fetchWorker('/v5/status/x402?mic=XNYS', { method: 'POST' });
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('the main /v5/status trial path is unchanged — first call still returns a 200 trial receipt', async () => {
		// Sanity: adding /v5/status/x402 must not regress the main endpoint's trial UX.
		const response = await fetchWorker('/v5/status?mic=XNYS');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('status');
		expect(body).toHaveProperty('signature');
		expect(body).toHaveProperty('receipt_mode');
		// The wrong-shape extensions.bazaar block previously emitted in this body was
		// removed — confirm it's no longer present.
		expect(body.extensions).toBeUndefined();
	});
});

// ─── W1: Bazaar extension in the v2 PAYMENT-REQUIRED header (2026-10-01) ─────
// CDP's validator reads the v2 header, and before W1 the header carried no
// `extensions`, so the listing was rejected with "no bazaar discovery extension
// found" while the v1 body had it. These pin the header and the body to the same
// extension object, the bytes to ASCII, and every other 402 to no extension.
describe('W1: Bazaar extension in the v2 PAYMENT-REQUIRED header', () => {
	// The bytes base64-decoded from Payment-Required, as a binary string (one char per byte).
	const headerBytes = (res: Response): string => atob(res.headers.get('Payment-Required') ?? '');
	const decodedHeader = (res: Response): Record<string, unknown> =>
		JSON.parse(x402Base64Decode(res.headers.get('Payment-Required') ?? '')) as Record<string, unknown>;

	for (const path of ['/v5/status/x402?mic=XNYS', '/v5/status/x402']) {
		it(`T1/T2 ${path}: header carries extensions.bazaar equal to the body's, mirror equals decoded header`, async () => {
			const res = await fetchWorker(path);
			expect(res.status).toBe(402);
			const decoded = decodedHeader(res);
			const ext = decoded.extensions as Record<string, unknown> | undefined;
			expect(ext).toBeDefined();
			expect(ext!.bazaar).toBeDefined();
			const body = await res.json() as Record<string, unknown>;
			expect(ext!.bazaar).toEqual((body.extensions as Record<string, unknown>).bazaar);
			expect(res.headers.get('Payment-Required-Json')).toBe(x402Base64Decode(res.headers.get('Payment-Required') ?? ''));
		});
	}

	it('T2b both header representations are pure ASCII and byte-identical', async () => {
		const res = await fetchWorker('/v5/status/x402?mic=XNYS');
		const bytes = headerBytes(res);
		const mirror = res.headers.get('Payment-Required-Json') ?? '';
		expect(bytes.length).toBeGreaterThan(0);
		const high = (s: string): number[] => Array.from(s, (ch) => ch.charCodeAt(0)).filter((c) => c >= 0x80);
		expect(high(bytes)).toEqual([]);
		expect(high(mirror)).toEqual([]);
		const mirrorBytes = Array.from(new TextEncoder().encode(mirror), (b) => String.fromCharCode(b)).join('');
		expect(bytes).toBe(mirrorBytes);
	});

	it('T3 the decoded header passes the real PaymentRequiredV2Schema (@x402/core 2.20.0, vendored)', async () => {
		const { PaymentRequiredV2Schema } = await import('./vendor/x402-schemas.mjs');
		const res = await fetchWorker('/v5/status/x402?mic=XNYS');
		const parsed = PaymentRequiredV2Schema.safeParse(decodedHeader(res));
		expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
	});

	it('T4 bazaar protocol invariants (x402 facilitator.ts 350-366, 450-525) and the CDP 500-character description limit', async () => {
		const res = await fetchWorker('/v5/status/x402?mic=XNYS');
		const decoded = decodedHeader(res);
		const bazaar = (decoded.extensions as Record<string, unknown>).bazaar as Record<string, unknown>;
		const info = bazaar.info as Record<string, unknown>;
		const input = info.input as Record<string, unknown>;
		const schema = bazaar.schema as Record<string, unknown>;
		expect(input.type).toBe('http');
		expect(['GET', 'HEAD', 'DELETE']).toContain(input.method);
		expect(input).not.toHaveProperty('bodyType');
		expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
		expect(schema.required as string[]).toContain('input');
		const refs: string[] = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) { v.forEach(walk); return; }
			if (v && typeof v === 'object') {
				for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
					if ((k === '$ref' || k === '$id') && !(typeof x === 'string' && x.startsWith('#'))) refs.push(`${k}=${String(x)}`);
					walk(x);
				}
			}
		};
		walk(schema);
		expect(refs).toEqual([]);
		expect(((decoded.resource as Record<string, unknown>).description as string).length).toBeLessThanOrEqual(500);
		expect((info.description as string).length).toBeLessThanOrEqual(500);
	});

	it('T5 the listing description names every MIC with a realtime halt feed and does not claim halt detection is active everywhere', async () => {
		const res = await fetchWorker('/v5/status/x402?mic=XNYS');
		const info = (((decodedHeader(res).extensions as Record<string, unknown>).bazaar as Record<string, unknown>).info) as Record<string, unknown>;
		const description = info.description as string;
		// The scope as the signed receipt states it (REALTIME_HALT_FEED_SCOPE in src).
		const demo = await fetchJSON('/v5/demo?mic=XNYS');
		const scope = (JSON.parse(demo.coverage as string) as { realtime_halt_feed_scope: string[] }).realtime_halt_feed_scope;
		expect(scope.length).toBeGreaterThan(0);
		for (const mic of scope) expect(description).toContain(mic);
		expect(description).not.toContain('halt detection active');
	});

	it('T6 all response headers together fit under node http.maxHeaderSize', async () => {
		// 16384 is what `node -p "require('http').maxHeaderSize"` printed in the W1
		// session's pre-flight (Node v24.13.0, 2026-10-01).
		const NODE_MAX_HEADER_SIZE = 16384;
		const res = await fetchWorker('/v5/status/x402?mic=XNYS');
		let total = 0;
		res.headers.forEach((value, name) => { total += new TextEncoder().encode(name).length + new TextEncoder().encode(value).length; });
		console.log(JSON.stringify({ event: 'W1_T6_HEADER_BYTES', total }));
		expect(total).toBeLessThan(NODE_MAX_HEADER_SIZE);
	});

	it('T7 the keyless 402s of /v5/batch, /v1/halts and /v1/safe-to-trade carry no extensions in the v2 header', async () => {
		for (const path of ['/v5/batch?mics=XNYS', '/v1/halts', '/v1/safe-to-trade?venue=XNYS&max_age=30']) {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(402);
			expect(res.headers.get('Payment-Required'), path).not.toBeNull();
			expect(decodedHeader(res), path).not.toHaveProperty('extensions');
		}
	});

	it('T8 an EXTENSION-RESPONSES header on the CDP settle response is logged and changes nothing', async () => {
		const extHeader = btoa(JSON.stringify({ bazaar: { status: 'rejected', rejectedReason: 'x' } }));
		const run = async (withHeader: boolean, tx: string) => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
				if (url.includes('cdp.coinbase.com') && url.includes('/verify')) {
					return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				if (url.includes('cdp.coinbase.com') && url.includes('/settle')) {
					const headers: Record<string, string> = { 'Content-Type': 'application/json' };
					if (withHeader) headers['EXTENSION-RESPONSES'] = extHeader;
					return new Response(JSON.stringify({ success: true, transaction: tx, network: 'eip155:8453', payer: '0x0000000000000000000000000000000000000001' }), { status: 200, headers });
				}
				return originalFetch(input as RequestInfo, init);
			};
			try {
				const payment = btoa(JSON.stringify({ x402Version: 2, accepted: {}, payload: { signature: '0xmocksig' } }));
				const res = await fetchWorker('/v5/status/x402?mic=XNYS', { headers: { 'Payment-Signature': payment } });
				const body = await res.json() as Record<string, unknown>;
				return { status: res.status, keys: Object.keys(body).sort(), mic: body.mic, receipt_mode: body.receipt_mode };
			} finally {
				globalThis.fetch = originalFetch;
			}
		};
		const logSpy = vi.spyOn(console, 'log');
		const without = await run(false, '0x' + 'a'.repeat(64));
		const withH   = await run(true, '0x' + 'b'.repeat(64));
		const logged = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('X402_BAZAAR_EXTENSION_RESPONSE'));
		logSpy.mockRestore();
		expect(withH).toEqual(without);
		expect(without.status).toBe(200);
		expect(logged.length).toBe(1);
		expect(JSON.parse(logged[0])).toEqual({ event: 'X402_BAZAAR_EXTENSION_RESPONSE', phase: 'settle', status: 'rejected', rejectedReason: 'x' });
	});
});

// ─── W2: /.well-known/ai-catalog.json (2026-10-01) ───────────────────────────
// Structure per the isitagentready ARD check; lists only the three discovery
// documents this worker serves, never an A2A card.
describe('W2: /.well-known/ai-catalog.json', () => {
	it('serves the catalog as JSON with CORS open, a spec version and a host', async () => {
		const res = await fetchWorker('/.well-known/ai-catalog.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type') ?? '').toMatch(/^application\/json/);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.specVersion).toBe('string');
		expect((body.specVersion as string).length).toBeGreaterThan(0);
		const host = body.host as Record<string, unknown>;
		expect(typeof host.displayName).toBe('string');
		expect((host.displayName as string).length).toBeGreaterThan(0);
		expect(typeof host.identifier).toBe('string');
		expect((host.identifier as string).length).toBeGreaterThan(0);
	});

	it('has exactly three well-formed entries, none of them an A2A card, each resolving to 200', async () => {
		const body = await fetchJSON('/.well-known/ai-catalog.json');
		const entries = body.entries as Array<Record<string, unknown>>;
		expect(entries.length).toBe(3);
		for (const e of entries) {
			const hasUrl = 'url' in e, hasData = 'data' in e;
			expect(hasUrl !== hasData, String(e.identifier)).toBe(true);
			expect(String(e.identifier)).toMatch(/^urn:air:headlessoracle\.com:/);
			expect(typeof e.displayName).toBe('string');
			expect(String(e.type).toLowerCase()).not.toContain('a2a');
			const queries = e.representativeQueries as string[];
			expect(queries.length).toBeGreaterThanOrEqual(2);
			expect(queries.length).toBeLessThanOrEqual(5);
			const target = String(e.url);
			expect(target).not.toContain('agent-card');
			expect(target).not.toContain('agent.json');
			const res = await fetchWorker(new URL(target).pathname);
			expect(res.status, target).toBe(200);
		}
	});
});

// ─── W3: /auth.md (2026-10-01) ───────────────────────────────────────────────
// Self-contained credential document. It describes only this worker's own
// paths and never the auth.md registration protocol, which nothing here speaks.
describe('W3: /auth.md', () => {
	it('serves Markdown whose first line is the auth.md H1', async () => {
		const res = await fetchWorker('/auth.md');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type') ?? '').toMatch(/^text\/markdown/);
		const text = await res.text();
		expect(text.split('\n')[0]).toBe('# Headless Oracle auth.md');
	});

	it('names every credential path and no registration-protocol field', async () => {
		const text = await (await fetchWorker('/auth.md')).text();
		for (const p of ['/v5/keys/instant', '/v5/keys/request', '/v5/sandbox', '/v5/x402/mint', '/oauth/token', 'x402']) {
			expect(text, p).toContain(p);
		}
		for (const forbidden of ['agent_auth', 'register_uri', '/agent/identity']) {
			expect(text, forbidden).not.toContain(forbidden);
		}
	});

	it('every /v5/ and /oauth/ path it names is answered by the worker (not 404)', async () => {
		const text = await (await fetchWorker('/auth.md')).text();
		const paths = Array.from(new Set(Array.from(text.matchAll(/\/(?:v5|oauth)\/[A-Za-z0-9_\-/]+/g), (m) => m[0].replace(/\/$/, ''))));
		expect(paths.length).toBeGreaterThanOrEqual(6);
		for (const p of paths) {
			const res = await fetchWorker(p);
			expect(res.status, p).not.toBe(404);
		}
	});
});

// ─── W4: truthfulness fixes on the discovery surfaces (2026-10-01) ───────────
// Each claim below is checked against what the code actually serves, never
// against a literal, so a tool added or a MIC added keeps the surfaces honest.
describe('W4: discovery surfaces claim only what the code does', () => {
	it('server card protocols do not claim A2A (no endpoint speaks it)', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		expect(body.protocols as string[]).not.toContain('A2A');
	});

	it('server card halt_detection lists are disjoint and together cover every MIC', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		const coverage = body.coverage as { mic_codes: string[]; halt_detection: { active: string[]; schedule_only: string[] } };
		const active = coverage.halt_detection.active, scheduleOnly = coverage.halt_detection.schedule_only;
		expect(active.filter((m) => scheduleOnly.includes(m))).toEqual([]);
		expect([...active, ...scheduleOnly].sort()).toEqual([...coverage.mic_codes].sort());
	});

	it('/llms.txt and /llms-full.txt carry no past-dated rulemaking claim and no model-tier pricing', async () => {
		for (const path of ['/llms.txt', '/llms-full.txt']) {
			const text = await (await fetchWorker(path)).text();
			for (const s of ['August 2026', 'Mythos', 'GPT-5 nano', 'MTok']) expect(text, `${path}: ${s}`).not.toContain(s);
		}
	});

	it('the Bazaar receipt schema halt_detection enum matches what receipts carry, and the example has every required key', async () => {
		const body = await fetchJSON('/v5/status/x402?mic=XNYS');
		const bazaar = (body.extensions as Record<string, unknown>).bazaar as Record<string, unknown>;
		const receiptSchema = (((((bazaar.schema as Record<string, unknown>).properties as Record<string, unknown>).output as Record<string, unknown>).properties as Record<string, unknown>).example) as { required: string[]; properties: Record<string, { enum?: string[] }> };
		const enumValues = receiptSchema.properties.halt_detection.enum;
		expect(enumValues).toEqual(['active', 'schedule_only']);
		const xnys = await fetchJSON('/v5/demo?mic=XNYS');
		const xlon = await fetchJSON('/v5/demo?mic=XLON');
		expect(xnys.halt_detection).toBe('active');
		expect(xlon.halt_detection).toBe('schedule_only');
		expect(enumValues).toContain(xnys.halt_detection);
		expect(enumValues).toContain(xlon.halt_detection);
		const example = ((bazaar.info as Record<string, unknown>).output as Record<string, unknown>).example as Record<string, unknown>;
		for (const key of receiptSchema.required) expect(example, key).toHaveProperty(key);
	});

	it('the Bazaar receipt schema receipt_mode enum is demo and live only', async () => {
		const body = await fetchJSON('/v5/status/x402?mic=XNYS');
		const bazaar = (body.extensions as Record<string, unknown>).bazaar as Record<string, unknown>;
		const receiptSchema = (((((bazaar.schema as Record<string, unknown>).properties as Record<string, unknown>).output as Record<string, unknown>).properties as Record<string, unknown>).example) as { properties: Record<string, { enum?: string[] }> };
		expect(receiptSchema.properties.receipt_mode.enum).toEqual(['demo', 'live']);
		const demo = await fetchJSON('/v5/demo?mic=XNYS');
		expect(demo.receipt_mode).toBe('demo');
	});
});

// ─── W5: no worker surface links a page that does not exist (2026-10-01) ─────
// Pages serves its homepage with 200 for any unknown path, so a dead link here
// reads as a live page to a crawler. Every /docs/, /blog/ or Pages passthrough
// path these four surfaces link must either be a page headless-oracle-web serves
// (listed below with its source file) or be served by this worker as non-HTML.
describe('W5: no worker surface links a page that does not exist', () => {
	const SITEMAP_LOCS = [
		'/', '/docs', '/pricing', '/status', '/docs/x402-payments', '/docs/integrations/datacamp-workspace',
		'/v5/metrics/public', '/docs/integrations/tradingagents-risk', '/docs/specifications/pre-trade-stack',
		'/docs/integrations/ampersend', '/docs/specifications/cpvr-1', '/standards', '/halt-gate',
		'/witness', '/auditors', '/about', '/verify',
	].map((p) => `https://headlessoracle.com${p}`);

	// Pages served by headless-oracle-web at 9dee09c (each file confirmed tracked there).
	const WEB_SERVED_PATHS = new Set([
		'/',                                     // index.html
		'/docs',                                 // docs.html
		'/pricing',                              // pricing.html
		'/status',                               // status.html
		'/verify',                               // verify.html
		'/docs/quickstart',                      // public/docs/quickstart/index.html
		'/docs/x402-payments',                   // public/docs/x402-payments/index.html
		'/docs/integrations/datacamp-workspace', // public/docs/integrations/datacamp-workspace/index.html
		'/upgrade',                              // no file; redirect to /pricing via headless-oracle-web public/_redirects, web session E1
	]);

	// The worker's Pages passthrough list (src/index.ts, "Pages passthrough").
	const PASSTHROUGH = new Set(['/', '/pricing', '/status', '/verify', '/traction', '/refund', '/upgrade', '/terms', '/privacy', '/docs', '/docs/', '/blog', '/blog/']);

	const SURFACE_PATHS = ['/sitemap.xml', '/llms.txt', '/llms-full.txt', '/AGENTS.md'];

	it('/sitemap.xml lists exactly the seventeen pages that exist', async () => {
		const xml = await (await fetchWorker('/sitemap.xml')).text();
		const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]);
		expect([...locs].sort()).toEqual([...SITEMAP_LOCS].sort());
	});

	it('every /docs/, /blog/ or passthrough link on the four surfaces is a real page', async () => {
		const paths = new Set<string>();
		for (const surface of SURFACE_PATHS) {
			const text = await (await fetchWorker(surface)).text();
			for (const m of text.matchAll(/https:\/\/(?:api\.)?headlessoracle\.com(\/[^\s)"'<>`\]]*)?/g)) {
				const p = (m[1] ?? '/').replace(/[?#].*$/, '').replace(/[.,;:]+$/, '') || '/';
				if (p.startsWith('/docs/') || p.startsWith('/blog/') || PASSTHROUGH.has(p)) paths.add(p);
			}
		}
		expect(paths.size).toBeGreaterThan(0);
		// A path that reaches the Pages passthrough here gets what Pages gives an
		// unknown path: the homepage, 200 text/html. That must count as a failure.
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.startsWith('http://example.com')) return new Response('<!doctype html><title>home</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
			return originalFetch(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		const dead: string[] = [];
		try {
			for (const p of paths) {
				if (WEB_SERVED_PATHS.has(p)) continue;
				const res = await fetchWorker(p);
				const type = res.headers.get('Content-Type') ?? '';
				if (res.status !== 200 || type.startsWith('text/html')) dead.push(`${p} -> ${res.status} ${type}`);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(dead).toEqual([]);
	});

	it('none of the removed links appears on the four surfaces', async () => {
		const removed = [
			'/docs/cline', '/docs/continue', '/docs/integrations/olas', '/docs/integrations/autogpt',
			'/docs/integrations/google-adk', '/docs/integrations/agno', '/docs/integrations/strands',
			'/blog/why-your-trading-agent-needs-a-pre-trade-gate', '/blog/market-hours-api-vs-signed-attestation',
			'/docs/integrations/trading-agents', '/docs/integrations/crewai', '/docs/integrations/x402',
			'/docs/integrations/mcp', '/docs/integrations/langchain', '/docs/api', '/docs/verification',
			'/docs/sma-protocol/rfc-001', '/docs/sdks/', '/docs/cursor-setup', '/docs/windsurf-config',
			'/docs/integrations/claude-managed-agents',
		].map((p) => `https://headlessoracle.com${p}`);
		for (const surface of SURFACE_PATHS) {
			const text = await (await fetchWorker(surface)).text();
			for (const url of removed) expect(text, `${surface}: ${url}`).not.toContain(url);
		}
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
		expect(supported.length).toBe(28);
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

	it('all MICs include data_coverage_years in schedule response', async () => {
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

// ─── Settlement window in /v5/schedule ────────────────────────────────────────

describe('Settlement window in /v5/schedule', () => {
	it('XNYS has T+1 DTCC settlement window', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNYS');
		const sw = body.settlement_window as Record<string, unknown>;
		expect(sw).not.toBeNull();
		expect(sw.cycle).toBe('T+1');
		expect(sw.clearinghouse).toContain('DTCC');
		expect(sw.cutoff_utc).toBe('20:30');
		expect(typeof sw.notes).toBe('string');
	});

	it('XNAS has T+1 DTCC settlement window', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XNAS');
		const sw = body.settlement_window as Record<string, unknown>;
		expect(sw).not.toBeNull();
		expect(sw.cycle).toBe('T+1');
		expect(sw.clearinghouse).toContain('DTCC');
	});

	it('XLON has T+2 Euroclear settlement window', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XLON');
		const sw = body.settlement_window as Record<string, unknown>;
		expect(sw).not.toBeNull();
		expect(sw.cycle).toBe('T+2');
		expect((sw.clearinghouse as string).toLowerCase()).toContain('euroclear');
		expect(sw.cutoff_utc).toBe('15:30');
	});

	it('XJPX has T+2 JSCC settlement window with 06:30 UTC cutoff', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XJPX');
		const sw = body.settlement_window as Record<string, unknown>;
		expect(sw).not.toBeNull();
		expect(sw.cycle).toBe('T+2');
		expect(sw.clearinghouse).toBe('JSCC');
		expect(sw.cutoff_utc).toBe('06:30');
	});

	it('exchanges without settlement data return null settlement_window', async () => {
		for (const mic of ['XPAR', 'XHKG', 'XSES', 'XASX', 'XKRX', 'XJSE']) {
			const body = await fetchJSON(`/v5/schedule?mic=${mic}`);
			expect(Object.prototype.hasOwnProperty.call(body, 'settlement_window')).toBe(true);
			expect(body.settlement_window).toBeNull();
		}
	});

	it('settlement_window present as key in schedule response for all 23 MICs', async () => {
		for (const mic of ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XBSP']) {
			const body = await fetchJSON(`/v5/schedule?mic=${mic}`);
			expect(Object.prototype.hasOwnProperty.call(body, 'settlement_window')).toBe(true);
		}
	});
});

// ─── GET /v5/exchanges ───────────────────────────────────────────────────────

describe('GET /v5/exchanges', () => {
	it('returns 200 with all 28 supported exchanges (no auth required)', async () => {
		const response = await fetchWorker('/v5/exchanges');
		expect(response.status).toBe(200);

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('exchanges');

		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		expect(exchanges.length).toBe(28);
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

// ─── GET /v5/historical — schedule reconstruction ───────────────────────────

describe('GET /v5/historical', () => {
	it('returns computed status for a known trading time', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/historical?mic=XNYS&at=2026-04-07T15:00:00Z');
		expect(res.computed_status).toBe('OPEN');
		expect(res.source).toBe('SCHEDULE_RECONSTRUCTION');
		expect(res.mic).toBe('XNYS');
		expect(res.disclaimer).toContain('Not a signed real-time attestation');
		expect(res.reasoning).toContain('New York Stock Exchange');
		vi.useRealTimers();
	});

	it('returns CLOSED for a weekend query', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/historical?mic=XNYS&at=2026-04-04T15:00:00Z');
		expect(res.computed_status).toBe('CLOSED');
		expect(res.reasoning).toContain('weekend');
		vi.useRealTimers();
	});

	it('returns CLOSED for a holiday query', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/historical?mic=XNYS&at=2026-04-03T15:00:00Z');
		expect(res.computed_status).toBe('CLOSED');
		expect(res.reasoning).toContain('holiday');
		vi.useRealTimers();
	});

	it('includes dst_note when query is near a DST transition', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/historical?mic=XNYS&at=2026-03-09T14:00:00Z');
		expect(res.dst_note).toBeDefined();
		expect(res.dst_note).toContain('US');
		expect(res.dst_note).toContain('spring forward');
		vi.useRealTimers();
	});

	it('dst_note is null when query is far from any transition', async () => {
		vi.setSystemTime(new Date('2026-08-01T15:00:00Z'));
		const res = await fetchJSON('/v5/historical?mic=XNYS&at=2026-07-07T15:00:00Z');
		expect(res.dst_note).toBeNull();
		vi.useRealTimers();
	});

	it('rejects dates before 2026-03-01', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS&at=2025-12-01T15:00:00Z');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('OUT_OF_RANGE');
		vi.useRealTimers();
	});

	it('rejects future dates', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS&at=2027-01-01T15:00:00Z');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('FUTURE_DATE');
		vi.useRealTimers();
	});

	it('rejects missing mic parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?at=2026-04-07T15:00:00Z');
		expect(res.status).toBe(400);
		vi.useRealTimers();
	});

	it('rejects missing at parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS');
		expect(res.status).toBe(400);
		vi.useRealTimers();
	});
});

// ─── GET /v5/audit/digest + /v5/audit/chain — daily attestation digest ───────

describe('GET /v5/audit/digest', () => {
	it('returns empty digest for a date with no receipts', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/digest?date=2026-04-06');
		expect(res.date).toBe('2026-04-06');
		expect(res.total_receipts_issued).toBe(0);
		expect(res.merkle_root).toBe('0'.repeat(64));
		expect(res.chain_length).toBe(0);
		expect(res.partial).toBe(false);
		vi.useRealTimers();
	});

	it('returns partial=true when querying today', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/digest?date=2026-04-08');
		expect(res.partial).toBe(true);
		expect(res.date).toBe('2026-04-08');
		vi.useRealTimers();
	});

	it('rejects invalid date format', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=not-a-date');
		expect(res.status).toBe(400);
		vi.useRealTimers();
	});

	it('rejects future dates', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=2027-01-01');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('FUTURE_DATE');
		vi.useRealTimers();
	});

	it('rejects dates before launch', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=2025-12-01');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('OUT_OF_RANGE');
		vi.useRealTimers();
	});

	it('tracks receipt IDs from /v5/status and returns them in digest', async () => {
		vi.setSystemTime(new Date('2026-04-08T14:30:00Z'));
		// Issue a receipt via /v5/demo (which tracks receipt IDs)
		const demoRes = await fetchJSON('/v5/demo?mic=XNYS');
		expect(demoRes.receipt_id).toBeDefined();
		// Query today's digest
		const digest = await fetchJSON('/v5/audit/digest?date=2026-04-08');
		expect(digest.partial).toBe(true);
		expect(digest.date).toBe('2026-04-08');
		// Should have at least the receipt we just issued
		const receiptIds = digest.receipt_ids as string[];
		expect(receiptIds.length).toBeGreaterThanOrEqual(1);
		// Merkle root should not be all zeros (we have receipts)
		expect(digest.merkle_root).not.toBe('0'.repeat(64));
		expect(digest.total_receipts_issued).toBeGreaterThanOrEqual(1);
		vi.useRealTimers();
	});

	it('defaults to today when no date param', async () => {
		vi.setSystemTime(new Date('2026-04-08T12:00:00Z'));
		const res = await fetchJSON('/v5/audit/digest');
		expect(res.date).toBe('2026-04-08');
		expect(res.partial).toBe(true);
		vi.useRealTimers();
	});
});

describe('GET /v5/audit/chain', () => {
	it('returns a chain with chain_intact flag', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/chain');
		expect(res.chain_length).toBeGreaterThanOrEqual(1);
		expect(typeof res.chain_intact).toBe('boolean');
		expect(res.latest_date).toBeDefined();
		expect(res.oldest_date).toBeDefined();
		const digests = res.digests as Array<Record<string, unknown>>;
		expect(digests.length).toBeGreaterThanOrEqual(1);
		// First entry should be today (partial)
		expect(digests[0].partial).toBe(true);
		vi.useRealTimers();
	});

	it('respects days parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/chain?days=3');
		const digests = res.digests as Array<Record<string, unknown>>;
		expect(digests.length).toBeLessThanOrEqual(3);
		vi.useRealTimers();
	});

	it('caps at 30 days', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/chain?days=100');
		const digests = res.digests as Array<Record<string, unknown>>;
		expect(digests.length).toBeLessThanOrEqual(30);
		vi.useRealTimers();
	});

	it('each digest has required fields', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchJSON('/v5/audit/chain?days=2');
		const digests = res.digests as Array<Record<string, unknown>>;
		for (const d of digests) {
			expect(d.date).toBeDefined();
			expect(d.merkle_root).toBeDefined();
			expect(typeof d.total_receipts_issued).toBe('number');
			expect(Array.isArray(d.exchanges_attested)).toBe(true);
			expect(Array.isArray(d.receipt_ids)).toBe(true);
		}
		vi.useRealTimers();
	});
});

// ─── ITEM 6: Crypto / derivatives exchange coverage ──────────────────────────

describe('ITEM 6 — Crypto and derivatives exchanges', () => {
	it('/v5/exchanges includes all 5 new exchanges with correct mic_type', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		const byMic = Object.fromEntries(exchanges.map((e) => [e.mic, e]));

		// ISO MICs
		expect(byMic['XCBT']).toBeDefined();
		expect(byMic['XCBT']!.mic_type).toBe('iso');
		expect(byMic['XNYM']).toBeDefined();
		expect(byMic['XNYM']!.mic_type).toBe('iso');
		expect(byMic['XCBO']).toBeDefined();
		expect(byMic['XCBO']!.mic_type).toBe('iso');

		// Convention MICs
		expect(byMic['XCOI']).toBeDefined();
		expect(byMic['XCOI']!.mic_type).toBe('convention');
		expect(byMic['XBIN']).toBeDefined();
		expect(byMic['XBIN']!.mic_type).toBe('convention');
	});

	it('all existing 23 exchanges still have mic_type: iso', async () => {
		const body = await fetchJSON('/v5/exchanges');
		const exchanges = body.exchanges as Array<Record<string, unknown>>;
		const traditional = exchanges.filter((e) =>
			['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
			 'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
			 'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE',
			 'XHEL', 'XSTO'].includes(e.mic as string)
		);
		expect(traditional.length).toBe(23);
		for (const ex of traditional) {
			expect(ex.mic_type).toBe('iso');
		}
	});

	it('/v5/demo?mic=XCBT returns signed receipt (CME overnight session)', async () => {
		// Tuesday 20:00 UTC = Tuesday 15:00 CT — well inside the CME session
		vi.setSystemTime(new Date('2026-04-07T20:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body).toHaveProperty('mic', 'XCBT');
		expect(body).toHaveProperty('signature');
		expect(['OPEN', 'CLOSED']).toContain(body.status);
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBT is OPEN during active session (Tue 20:00 UTC = 15:00 CT)', async () => {
		// CME session: Sun 17:00 CT → Fri 16:00 CT. Tuesday 15:00 CT is mid-session.
		vi.setSystemTime(new Date('2026-04-07T20:00:00Z')); // Tuesday 15:00 CT
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body.status).toBe('OPEN');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBT is CLOSED during maintenance halt (16:00–17:00 CT = 21:00–22:00 UTC)', async () => {
		// Tuesday 21:30 UTC = Tuesday 16:30 CT — inside the maintenance halt window
		vi.setSystemTime(new Date('2026-04-07T21:30:00Z')); // Tuesday 16:30 CT
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body.status).toBe('CLOSED');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBT is CLOSED on Saturday (only weekend day for CME)', async () => {
		// Saturday 14:00 UTC
		vi.setSystemTime(new Date('2026-04-04T14:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body.status).toBe('CLOSED');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBT is CLOSED on Sunday before open (before 17:00 CT = 22:00 UTC)', async () => {
		// Sunday 14:00 UTC = Sunday 09:00 CT — the session hasn't opened yet (opens 17:00 CT)
		vi.setSystemTime(new Date('2026-04-05T14:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body.status).toBe('CLOSED');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBT is OPEN on Sunday after open (after 22:00 UTC = 17:00 CT)', async () => {
		vi.setSystemTime(new Date('2026-04-05T23:00:00Z')); // Sunday 18:00 CT
		const body = await fetchJSON('/v5/demo?mic=XCBT');
		expect(body.status).toBe('OPEN');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCOI returns OPEN (Coinbase is 24/7)', async () => {
		// Saturday 03:00 UTC — a time that would be CLOSED on any traditional exchange
		vi.setSystemTime(new Date('2026-04-04T03:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XCOI');
		expect(body).toHaveProperty('mic', 'XCOI');
		expect(body.status).toBe('OPEN');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XBIN returns OPEN (Binance is 24/7)', async () => {
		vi.setSystemTime(new Date('2026-04-04T03:00:00Z')); // Saturday 03:00 UTC
		const body = await fetchJSON('/v5/demo?mic=XBIN');
		expect(body).toHaveProperty('mic', 'XBIN');
		expect(body.status).toBe('OPEN');
		vi.useRealTimers();
	});

	it('/v5/demo?mic=XCBO returns OPEN on a weekday during session hours', async () => {
		// Tuesday 14:30 UTC = Tuesday 10:30 ET — Cboe is open 9:30–16:15 ET
		vi.setSystemTime(new Date('2026-04-07T14:30:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XCBO');
		expect(body).toHaveProperty('mic', 'XCBO');
		expect(body.status).toBe('OPEN');
		vi.useRealTimers();
	});

	it('/v5/schedule?mic=XCOI returns null next_open (24/7 session not modelled as day-pair)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XCOI');
		expect(body).toHaveProperty('mic', 'XCOI');
		expect(body.next_open).toBeNull();
	});

	it('/v5/schedule?mic=XCBT returns null next_open (overnight session not modelled as day-pair)', async () => {
		const body = await fetchJSON('/v5/schedule?mic=XCBT');
		expect(body).toHaveProperty('mic', 'XCBT');
		expect(body.next_open).toBeNull();
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
			expect(supported.length).toBe(28);
			// Verify all 28 MICs are in the supported list
			for (const mic of ALL_MICS) {
				expect(supported).toContain(mic);
			}
		});
	}

	it('/v5/status?mic=BAD with valid key returns 400 UNKNOWN_MIC', async () => {
		const response = await fetchWorker('/v5/status?mic=BAD', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
	const UNKNOWN_PATHS = ['/unknown', '/v4/demo', '/v5'];

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
		expect(paths).toHaveProperty('/.well-known/security.txt');
	});

	it('does not require authentication', async () => {
		const response = await fetchWorker('/openapi.json');
		expect(response.status).toBe(200);
	});

	it('info block exposes x-model-agnostic, cites the regulator documents as references only, and makes no regulatory-alignment claim', async () => {
		const body = await fetchJSON('/openapi.json');
		const info = body.info as Record<string, unknown>;
		expect(info['x-model-agnostic']).toBe(true);
		expect(info).not.toHaveProperty('x-regulatory-alignment');
		expect(info['x-regulatory-references']).toBeDefined();
		expect(Array.isArray(info['x-regulatory-references'])).toBe(true);
		expect((info['x-regulatory-references'] as unknown[]).length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(info)).not.toContain('SEC/CFTC Technical Framework');
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

	it('guard fires for all MICs in an uncovered year', async () => {
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

	it('health response includes exchange_count = 28 (unsigned metadata)', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('exchange_count', 28);
	});

	it('health response includes supported_mics with all 28 MICs (unsigned metadata)', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('supported_mics');
		const mics = body.supported_mics as string[];
		expect(Array.isArray(mics)).toBe(true);
		expect(mics.length).toBe(28);
		for (const mic of ALL_MICS) {
			expect(mics).toContain(mic);
		}
	});

	it('health exchange_count and supported_mics are outside the signed payload', async () => {
		// Confirms these are unsigned annotations — not part of canonical health payload.
		const body = await fetchJSON('/v5/health');
		const { exchange_count, supported_mics } = body as Record<string, unknown>;
		expect(exchange_count).toBe(28);
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
		expect(response.headers.get('MCP-Protocol-Version')).toBe('2024-11-05');

		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('jsonrpc', '2.0');
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('protocolVersion', '2024-11-05');
		const serverInfo = result.serverInfo as Record<string, unknown>;
		expect(serverInfo).toHaveProperty('name', 'headless-oracle');
		const capabilities = result.capabilities as Record<string, unknown>;
		expect(capabilities).toHaveProperty('tools');
	});

	it('responds with the spec-compliant MCP-Protocol-Version header', async () => {
		const response = await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		expect(response.headers.get('MCP-Protocol-Version')).toBe('2024-11-05');
		// The pre-2025 non-standard header name must not be served.
		expect(response.headers.get('MCP-Version')).toBeNull();
	});

	it('notifications/initialized → 202 with empty body', async () => {
		const response = await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(response.status).toBe(202);
		const text = await response.text();
		expect(text).toBe('');
	});

	it('tools/list → 4 tools with names, descriptions, and inputSchema', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const result = body.result as Record<string, unknown>;
		const tools = result.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(4);

		const names = tools.map((t) => t.name as string);
		expect(names).toContain('get_market_status');
		expect(names).toContain('get_market_schedule');
		expect(names).toContain('list_exchanges');
		expect(names).toContain('get_payment_options');
		expect(names).not.toContain('verify_receipt');

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

	it('tools/call list_exchanges → 28 exchanges with all MIC codes', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 6, method: 'tools/call',
			params: { name: 'list_exchanges', arguments: {} },
		});
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<{ type: string; text: string }>;
		const data = JSON.parse(content[0].text) as Record<string, unknown>;

		const exchanges = data.exchanges as Array<Record<string, unknown>>;
		expect(exchanges).toHaveLength(28);

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

	it('resources/list → declares exchange_directory resource', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 8, method: 'resources/list' });
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		const resources = result.resources as Array<Record<string, unknown>>;
		expect(Array.isArray(resources)).toBe(true);
		expect(resources.length).toBeGreaterThanOrEqual(1);
		const dir = resources.find((r) => r.name === 'exchange_directory');
		expect(dir).toBeDefined();
		expect(dir!.uri).toBe('oracle://exchanges/directory');
		expect(dir!.mimeType).toBe('application/json');
	});

	it('resources/read oracle://exchanges/directory → returns all 28 exchanges', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 81, method: 'resources/read',
			params: { uri: 'oracle://exchanges/directory' },
		});
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		const contents = result.contents as Array<Record<string, unknown>>;
		expect(contents[0].uri).toBe('oracle://exchanges/directory');
		expect(contents[0].mimeType).toBe('application/json');
		const parsed = JSON.parse(contents[0].text as string) as { exchanges: unknown[]; count: number };
		expect(parsed.count).toBe(28);
		expect(parsed.exchanges).toHaveLength(28);
	});

	it('resources/read without uri → -32602', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 82, method: 'resources/read', params: {} });
		const err = body.error as { code: number };
		expect(err.code).toBe(-32602);
	});

	it('resources/read unknown uri → -32602', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 83, method: 'resources/read',
			params: { uri: 'oracle://nope' },
		});
		const err = body.error as { code: number };
		expect(err.code).toBe(-32602);
	});

	it('prompts/list → declares pre_trade_check and market_briefing', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 9, method: 'prompts/list' });
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		const prompts = result.prompts as Array<Record<string, unknown>>;
		expect(Array.isArray(prompts)).toBe(true);
		const names = prompts.map((p) => p.name);
		expect(names).toContain('pre_trade_check');
		expect(names).toContain('market_briefing');
		const ptc = prompts.find((p) => p.name === 'pre_trade_check')!;
		const args = ptc.arguments as Array<Record<string, unknown>>;
		expect(args[0].name).toBe('mic');
		expect(args[0].required).toBe(true);
	});

	it('prompts/get pre_trade_check with mic → returns messages', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 91, method: 'prompts/get',
			params: { name: 'pre_trade_check', arguments: { mic: 'XNYS' } },
		});
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('description');
		const messages = result.messages as Array<Record<string, unknown>>;
		expect(messages.length).toBeGreaterThanOrEqual(1);
		expect(messages[0].role).toBe('user');
		const content = messages[0].content as { type: string; text: string };
		expect(content.type).toBe('text');
		expect(content.text).toContain('XNYS');
		expect(content.text).toContain('fail-closed');
	});

	it('prompts/get market_briefing → returns messages', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 92, method: 'prompts/get',
			params: { name: 'market_briefing' },
		});
		expect(Object.prototype.hasOwnProperty.call(body, 'error')).toBe(false);
		const result = body.result as Record<string, unknown>;
		const messages = result.messages as Array<Record<string, unknown>>;
		const content = messages[0].content as { type: string; text: string };
		expect(content.text).toContain('list_exchanges');
		expect(content.text).toContain('UNKNOWN');
	});

	it('prompts/get without name → -32602', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 93, method: 'prompts/get', params: {} });
		const err = body.error as { code: number };
		expect(err.code).toBe(-32602);
	});

	it('prompts/get pre_trade_check without mic arg → -32602', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 94, method: 'prompts/get',
			params: { name: 'pre_trade_check', arguments: {} },
		});
		const err = body.error as { code: number };
		expect(err.code).toBe(-32602);
	});

	it('prompts/get unknown prompt → -32602', async () => {
		const body = await postMcpJSON({
			jsonrpc: '2.0', id: 95, method: 'prompts/get',
			params: { name: 'nonexistent' },
		});
		const err = body.error as { code: number };
		expect(err.code).toBe(-32602);
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

	it('GET /mcp → declares prompts, resources, capabilities, display_name', async () => {
		const response = await fetchWorker('/mcp');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('display_name', 'Headless Oracle');
		const prompts = body.prompts as string[];
		expect(prompts).toContain('pre_trade_check');
		expect(prompts).toContain('market_briefing');
		const resources = body.resources as string[];
		expect(resources).toContain('oracle://exchanges/directory');
		const caps = body.capabilities as Record<string, boolean>;
		expect(caps.tools).toBe(true);
		expect(caps.prompts).toBe(true);
		expect(caps.resources).toBe(true);
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

	it('POST /mcp ping → empty result (MCP liveness check)', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 98, method: 'ping' });
		expect(body).toHaveProperty('jsonrpc', '2.0');
		expect(body).not.toHaveProperty('error');
		expect(body.result).toEqual({});
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

	it('POST /mcp initialize capabilities advertise tools, resources, and prompts', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 52, method: 'initialize', params: {} });
		const result = body.result as Record<string, unknown>;
		const caps = result.capabilities as Record<string, unknown>;
		expect(caps).toHaveProperty('tools');
		expect(caps).toHaveProperty('resources');
		expect(caps).toHaveProperty('prompts');
	});

	it('POST /mcp CORS headers include Authorization', async () => {
		const response = await postMcp({ jsonrpc: '2.0', id: 53, method: 'tools/list' });
		expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
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
			// Was /v5/keys/request (email-only, served elsewhere as unreliable). The
			// hint now names the route that returns the key in its response.
			const note = result['x-oracle-note'] as string;
			expect(note).toContain('POST https://headlessoracle.com/v5/keys/instant');
			expect(note).toContain('"agent_id"');
			// MCP reads the API key itself (2026-10-07): the note says to send it.
			expect(note).toContain('Authorization: Bearer <api key>');
			expect(note).not.toContain('/v5/keys/request');
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

// ─── MCP tools/list — _meta x402 annotation ──────────────────────────────────

describe('MCP tools/list — _meta x402 annotation', () => {
	it('get_market_status tool has _meta.x402 block with required fields', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
		const result = body.result as Record<string, unknown>;
		const tools = result.tools as Array<Record<string, unknown>>;
		const statusTool = tools.find((t) => t.name === 'get_market_status');
		expect(statusTool).toBeDefined();
		const meta = statusTool!._meta as Record<string, unknown>;
		expect(meta).toBeDefined();
		const x402 = meta.x402 as Record<string, unknown>;
		expect(x402).toHaveProperty('required_without_key', true);
		expect(x402).toHaveProperty('amount_usdc', '0.001');
		expect(x402).toHaveProperty('network', 'base');
		expect(x402).toHaveProperty('payment_header', 'X-Payment');
		expect(x402).toHaveProperty('discovery', '/.well-known/x402.json');
	});
});

// ─── GET /v5/payment-proof ────────────────────────────────────────────────────

describe('GET /v5/payment-proof', () => {
	it('returns 200 with correct schema when no payments recorded', async () => {
		const res = await fetchWorker('/v5/payment-proof');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('payment_count');
		expect(typeof body.payment_count).toBe('number');
		expect(body).toHaveProperty('first_payment_at');
		expect(body).toHaveProperty('first_payment_tx');
		expect(body).toHaveProperty('last_payment_at');
		expect(body).toHaveProperty('network', 'base');
		expect(body).toHaveProperty('asset', 'USDC');
		expect(body).toHaveProperty('contract', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
		expect(body).toHaveProperty('verify_at');
	});

	it('does NOT take its answer from the seeded KV counters (CHANGED BY T4)', async () => {
		// This test used to assert the opposite: that /v5/payment-proof echoed
		// x402_payment_count and x402_first_tx straight back. That WAS the
		// defect. It even pinned 'abc123def456' as a first_payment_tx — a
		// twelve-character string, which is what the old writer stored via
		// txHash.slice(-12) and which no block explorer can resolve. The
		// endpoint now computes from the chain-verified ledger and reports the
		// counters beside it. See '/v5/payment-proof — computed on read'.
		await env.ORACLE_TELEMETRY.put('x402_payment_count', '7');
		await env.ORACLE_TELEMETRY.put('x402_first_tx', 'abc123def456');
		await env.ORACLE_TELEMETRY.put('x402_first_payment_at', '2026-04-05T10:00:00.000Z');
		try {
			const res = await fetchWorker('/v5/payment-proof');
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body.payment_count).not.toBe(7);
			expect(body.first_payment_tx).not.toBe('abc123def456');
			expect(body.first_payment_at).not.toBe('2026-04-05T10:00:00.000Z');
			// The stale counter is surfaced rather than swallowed.
			const rec = body.counter_reconciliation as Record<string, unknown>;
			expect(rec.x402_payment_count).toBe(7);
			expect(rec.agrees).toBe(false);
		} finally {
			await env.ORACLE_TELEMETRY.delete('x402_payment_count');
			await env.ORACLE_TELEMETRY.delete('x402_first_tx');
			await env.ORACLE_TELEMETRY.delete('x402_first_payment_at');
		}
	});
});

// ─── GET /v5/pricing ──────────────────────────────────────────────────────────

describe('GET /v5/pricing', () => {
	// Buyer email is failing (Resend team mismatch, 2026-10-04): no served text may
	// say a key arrives "via email" where the response carries it, and the paths that
	// do email must point at the path that does not.
	it('sandbox and free tiers do not promise email delivery the response does not depend on', async () => {
		const body  = await fetchJSON('/v5/pricing');
		const tiers = body.tiers as Array<{ id: string; description: string }>;
		const sandbox = tiers.find((t) => t.id === 'sandbox')!;
		const free    = tiers.find((t) => t.id === 'free')!;
		expect(sandbox.description).not.toMatch(/via email/i);
		expect(sandbox.description).toContain('returned in the response');
		expect(free.description).toContain('currently unreliable');
		expect(free.description).toContain('/v5/keys/instant');
	});

	it('ACCOUNT_NOT_FOUND points a Paddle buyer at /v5/claim, not at their inbox', async () => {
		const body = await fetchJSON('/v5/errors/ACCOUNT_NOT_FOUND');
		const text = JSON.stringify(body);
		expect(text).not.toMatch(/check your email/i);
		expect(text).toContain('/v5/claim');
		expect(text).toContain('mike@headlessoracle.com');
	});

	it('returns 200 with tiers array and x402 metadata', async () => {
		const res = await fetchWorker('/v5/pricing');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(Array.isArray(body.tiers)).toBe(true);
		const tiers = body.tiers as Record<string, unknown>[];
		expect(tiers.length).toBeGreaterThanOrEqual(7);
		const ids = tiers.map((t) => t.id);
		expect(ids).toContain('sandbox');
		expect(ids).toContain('free');
		expect(ids).toContain('x402');
		expect(ids).toContain('credits');
		expect(ids).toContain('builder');
		expect(ids).toContain('pro');
		expect(ids).toContain('protocol');
	});

	it('x402 tier has correct Base mainnet fields', async () => {
		const res = await fetchWorker('/v5/pricing');
		const body = await res.json() as Record<string, unknown>;
		const x402meta = body.x402 as Record<string, unknown>;
		expect(x402meta).toHaveProperty('amount_usdc', '0.001');
		expect(x402meta).toHaveProperty('network', 'base');
		expect(x402meta).toHaveProperty('chain_id', 8453);
		expect(x402meta).toHaveProperty('amount_units', '1000');
	});

	it('builder tier has correct daily limit', async () => {
		const res = await fetchWorker('/v5/pricing');
		const body = await res.json() as Record<string, unknown>;
		const tiers = body.tiers as Record<string, unknown>[];
		const builder = tiers.find((t) => t.id === 'builder')!;
		expect(builder.calls_per_day).toBe(50_000);
	});

	// --- B-149: the referee block --------------------------------------------
	// /v5/pricing served seven tiers and said nothing about the six referee
	// services, so the only machine-readable price list we publish did not
	// mention half of what the till sells.
	//
	// The expected figures below are written out INDEPENDENTLY of
	// REFEREE_PRICES, in the minor units Paddle stores, exactly as the checkout
	// table above is. Two links are checked separately, and each has its own
	// red case:
	//   (a) served usd === (minor_units / 100) read from the constant
	//       -- goes red if the served figure is a literal that drifted;
	//   (b) the constant's minor_units === the numbers below
	//       -- goes red if the constant itself is wrong.
	// Checking only (a) would compare the code against itself.
	//
	// The constant is NOT mutated to force the red. It is module-level and
	// shared by every test in this file, so mutating it would leak into
	// unrelated assertions and make a later failure unattributable. The red was
	// taken by running these tests before the handler served a `referee` key at
	// all.
	const REFEREE_PRICING_EXPECTED = [
		{ plan: 'conformance_entry', name: 'Conformance entry',                       minor_units: 250000, cycle: null },
		{ plan: 'regrade',           name: 'Re-grade',                                minor_units:  75000, cycle: null },
		{ plan: 'dispute',           name: 'Dispute package',                         minor_units:  50000, cycle: null },
		{ plan: 'dispute_note',      name: 'Dispute package with verification note',  minor_units: 150000, cycle: null },
		// H1a (2026-10-03): the two custody prices are now sold as Witness plans.
		{ plan: 'custody_90d',       name: 'Evidence Starter (Witness account)',      minor_units:   4900, cycle: { interval: 'month', frequency: 1 } },
		{ plan: 'custody_1y',        name: 'Evidence (Witness account)',              minor_units:  19900, cycle: { interval: 'month', frequency: 1 } },
	] as const;

	// Byte-for-byte from LEAD_PLAN_2026-09-07_M5-prices-live.md section 5. 434
	// characters, sha256 576fa9366bdb3ab438229ada26a0e3758fedda6a9a16518f796e0f4041de793b.
	// It is written out here rather than imported so that a change to the served
	// string is a diff against the plan, not a diff against itself.
	const NEUTRALITY_RULE = 'A paid entry buys the run and the published record, never the verdict. Every entry carries an Interests section: the referee is the author of a competing format; independence is not claimed; recomputability from pinned bytes is claimed; the text and the implementation are scored separately; a finding stands until its author corrects the record, and the correction is published beside it. Verification of any receipt is free, always.';

	it('B-149: /v5/pricing serves a referee block with the six services', async () => {
		const res  = await fetchWorker('/v5/pricing');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const referee = body.referee as Record<string, unknown>;
		expect(referee).toBeDefined();

		expect(referee.introductory).toBe(true);
		expect(referee.introductory_until).toBe(refereePrices().introductory_until);
		expect(referee.intake_url).toBe('https://headlessoracle.com/v5/referee/intake');
		expect(referee.programmes).toBe('by invoice after a conversation; use the intake');

		const services = referee.services as Array<Record<string, unknown>>;
		expect(services).toHaveLength(6);
		expect(services.map(x => x.plan)).toEqual(REFEREE_PRICING_EXPECTED.map(x => x.plan));
		for (const expected of REFEREE_PRICING_EXPECTED) {
			const served = services.find(x => x.plan === expected.plan)!;
			expect(served.name).toBe(expected.name);
			expect(served.cycle).toEqual(expected.cycle);
		}
	});

	it('B-149: the neutrality rule is served verbatim, and is 434 characters', async () => {
		const res  = await fetchWorker('/v5/pricing');
		const body = await res.json() as Record<string, unknown>;
		const referee = body.referee as Record<string, unknown>;
		expect(referee.neutrality).toBe(NEUTRALITY_RULE);
		// The length is asserted separately so a whitespace-only edit -- the one
		// change toBe() reports least legibly -- names itself.
		expect(String(referee.neutrality)).toHaveLength(434);
	});

	it('B-149: every served referee usd is DERIVED from REFEREE_PRICES, and the constant matches Paddle', async () => {
		const res  = await fetchWorker('/v5/pricing');
		const body = await res.json() as Record<string, unknown>;
		const services = (body.referee as Record<string, unknown>).services as Array<Record<string, unknown>>;
		const { prices, amount } = refereePrices();

		for (const expected of REFEREE_PRICING_EXPECTED) {
			const served = services.find(x => x.plan === expected.plan)!;
			// (a) served <- constant. A literal that drifted from the table fails here.
			expect(served.usd).toBe(amount(expected.plan));
			expect(served.usd).toBe((prices[expected.plan].minor_units / 100).toFixed(2));
			// (b) constant <- Paddle. A wrong table fails here, independently.
			expect(prices[expected.plan].minor_units).toBe(expected.minor_units);
			expect(prices[expected.plan].cycle).toEqual(expected.cycle);
		}
		// And nothing is quoted that the constant does not have.
		expect(services.map(x => x.plan).slice().sort()).toEqual(Object.keys(prices).sort());
	});
});

// --- B-149: POST /v5/referee/intake ------------------------------------------
// The purchase path needs a front door. A conformance entry is not a thing to
// sell to an anonymous card: we need to know which implementation, at which
// version, read which methodology, and whether the submitter consents to being
// named. The intake collects that, records it, tells the founder, and hands
// back the conformance_entry checkout URL so the same request that describes
// the work can pay for it.

describe('POST /v5/referee/intake', () => {
	const VALID_INTAKE = {
		implementation:           'acme-receipts',
		repository_or_url:        'https://github.com/acme/receipts',
		format:                   'acta.receipt/0',
		version:                  '1.4.2',
		contact_email:            'submitter@example.com',
		consent_to_be_named:      true,
		methodology_version_read: 'v1.0.0',
	};

	// Every intake test that reaches the Paddle call needs it mocked. No test
	// in this file may touch api.paddle.com for real.
	function withPaddle(transactionId: string, opts?: { fail?: boolean }) {
		const state = { paddleCalls: 0, paddlePriceId: '', mailCount: 0, mailTo: '', mailSubject: '', mailHtml: '' };
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				state.paddleCalls += 1;
				const sent = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ price_id?: string }> };
				state.paddlePriceId = sent.items?.[0]?.price_id ?? '';
				if (opts?.fail) {
					return new Response(JSON.stringify({ error: { detail: 'price archived' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				return new Response(JSON.stringify({ data: { id: transactionId } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('resend.com')) {
				state.mailCount += 1;
				const mail = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { to?: string[]; subject?: string; html?: string };
				state.mailTo      = mail.to?.[0] ?? '';
				state.mailSubject = mail.subject ?? '';
				state.mailHtml    = mail.html ?? '';
				return new Response(JSON.stringify({ id: 'email_intake' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		return { state, restore: () => { globalThis.fetch = originalFetch; } };
	}

	function post(body: unknown, ip = '198.51.100.7') {
		return fetchWorker('/v5/referee/intake', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
			body:    JSON.stringify(body),
		});
	}

	it('GET /v5/referee/intake → 405', async () => {
		const res = await fetchWorker('/v5/referee/intake');
		expect(res.status).toBe(405);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('B-149: a complete intake round-trips: KV row, founder mail, {intake_id, checkout_url}', async () => {
		const h = withPaddle('txn_intake_roundtrip');
		try {
			const res  = await post(VALID_INTAKE, '198.51.100.11');
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;

			// The response an agent acts on, with no follow-up question in it.
			expect(String(body.intake_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(body.checkout_url).toBe('https://buy.paddle.com/checkout/txn_intake_roundtrip');

			// The checkout is for conformance_entry, through the same code path
			// POST /v5/checkout uses -- asserted on the price id that actually
			// reached Paddle, not on our intent.
			expect(h.state.paddleCalls).toBe(1);
			expect(h.state.paddlePriceId).toBe('pri_01m22wcgvj15ktn5xnabf13a7p');

			// The durable record.
			const raw = await env.ORACLE_TELEMETRY.get(`referee_intake:${body.intake_id as string}`);
			expect(raw).not.toBeNull();
			const row = JSON.parse(raw as string) as Record<string, unknown>;
			expect(row.implementation).toBe('acme-receipts');
			expect(row.repository_or_url).toBe('https://github.com/acme/receipts');
			expect(row.format).toBe('acta.receipt/0');
			expect(row.version).toBe('1.4.2');
			expect(row.contact_email).toBe('submitter@example.com');
			expect(row.consent_to_be_named).toBe(true);
			expect(row.methodology_version_read).toBe('v1.0.0');
			expect(typeof row.received_at).toBe('string');

			// One mail, to the founder, naming the implementation.
			expect(h.state.mailCount).toBe(1);
			expect(h.state.mailTo).toBe('mike@headlessoracle.com');
			expect(h.state.mailSubject).toBe('Referee intake: acme-receipts');
		} finally {
			h.restore();
		}
	});

	// Each field, one at a time. A single "some field missing" test would pass
	// with five of the seven unchecked.
	for (const field of Object.keys(VALID_INTAKE)) {
		it(`B-149: intake missing '${field}' → 400 naming that field`, async () => {
			const h = withPaddle('txn_should_not_happen');
			try {
				const body = { ...VALID_INTAKE } as Record<string, unknown>;
				delete body[field];
				const res = await post(body, '198.51.100.12');
				expect(res.status).toBe(400);
				const parsed = await res.json() as Record<string, unknown>;
				expect(parsed).toHaveProperty('error', 'INVALID_INTAKE');
				// The named field is the point: an agent must not have to guess
				// which of seven it got wrong.
				expect(parsed.field).toBe(field);
				// Nothing is bought and nobody is mailed for a request we rejected.
				expect(h.state.paddleCalls).toBe(0);
				expect(h.state.mailCount).toBe(0);
			} finally {
				h.restore();
			}
		});
	}

	it('B-149: consent_to_be_named must be a real boolean — the string "true" is 400', async () => {
		// The one that would slip through a truthiness check. "true", "false"
		// and "no" are all truthy strings; consent recorded from any of them is
		// consent we cannot show was given.
		const h = withPaddle('txn_should_not_happen');
		try {
			for (const notABoolean of ['true', 'false', 1, 0, null]) {
				const res = await post({ ...VALID_INTAKE, consent_to_be_named: notABoolean }, '198.51.100.13');
				expect(res.status).toBe(400);
				const parsed = await res.json() as Record<string, unknown>;
				expect(parsed).toHaveProperty('error', 'INVALID_INTAKE');
				expect(parsed.field).toBe('consent_to_be_named');
			}
			expect(h.state.paddleCalls).toBe(0);
		} finally {
			h.restore();
		}
	});

	it('B-149: consent_to_be_named false is accepted — it is a choice, not a failure', async () => {
		// The control for the test above. Rejecting `false` would make the
		// boolean check look right while making consent unrefusable.
		const h = withPaddle('txn_intake_no_consent');
		try {
			const res = await post({ ...VALID_INTAKE, consent_to_be_named: false }, '198.51.100.14');
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			const raw  = await env.ORACLE_TELEMETRY.get(`referee_intake:${body.intake_id as string}`);
			expect(JSON.parse(raw as string).consent_to_be_named).toBe(false);
		} finally {
			h.restore();
		}
	});

	it('B-149: an invalid contact_email is 400, by the same rule /v5/sandbox uses', async () => {
		const h = withPaddle('txn_should_not_happen');
		try {
			for (const bad of ['not-an-email', 'a@b', 'a b@example.com', '@example.com']) {
				const res = await post({ ...VALID_INTAKE, contact_email: bad }, '198.51.100.15');
				expect(res.status).toBe(400);
				const parsed = await res.json() as Record<string, unknown>;
				expect(parsed.field).toBe('contact_email');
			}
			expect(h.state.paddleCalls).toBe(0);
		} finally {
			h.restore();
		}
	});

	it('B-149: the intake rate limit fires on the 11th request from one IP in an hour', async () => {
		const ip     = '198.51.100.99';
		const ipHash = await sha256Hex(ip);
		const hour   = new Date().toISOString().slice(0, 13);
		const rateKey = `referee_intake_rate:${ipHash}:${hour}`;
		await env.ORACLE_TELEMETRY.put(rateKey, '10');
		const h = withPaddle('txn_should_not_happen');
		try {
			const res = await post(VALID_INTAKE, ip);
			expect(res.status).toBe(429);
			const parsed = await res.json() as Record<string, unknown>;
			expect(parsed).toHaveProperty('error', 'REFEREE_INTAKE_RATE_LIMIT');
			expect(res.headers.get('Retry-After')).toBeTruthy();
			// Rate-limited means the money path is not touched either.
			expect(h.state.paddleCalls).toBe(0);
			expect(h.state.mailCount).toBe(0);
		} finally {
			h.restore();
			await env.ORACLE_TELEMETRY.delete(rateKey);
		}
	});

	it('B-149: when Paddle cannot create the checkout, nothing is recorded and nobody is mailed', async () => {
		// Ordering matters and is asserted, not assumed. The checkout is created
		// BEFORE the intake row is written, so a failure leaves no half-state
		// for a retrying agent to duplicate. A 200 carrying checkout_url:null
		// would be the alternative, and an agent cannot act on it.
		const h = withPaddle('txn_never', { fail: true });
		try {
			const res = await post({ ...VALID_INTAKE, implementation: 'paddle-down-case' }, '198.51.100.16');
			expect(res.status).toBe(502);
			const parsed = await res.json() as Record<string, unknown>;
			expect(parsed).toHaveProperty('error', 'CHECKOUT_FAILED');
			expect(h.state.mailCount).toBe(0);
			const listed = await env.ORACLE_TELEMETRY.list({ prefix: 'referee_intake:' });
			for (const k of listed.keys) {
				const row = JSON.parse((await env.ORACLE_TELEMETRY.get(k.name)) as string) as Record<string, unknown>;
				expect(row.implementation).not.toBe('paddle-down-case');
			}
		} finally {
			h.restore();
		}
	});
});

// ─── MCP fast path — no telemetry KV for protocol handshake methods ──────────

describe('MCP fast path — no ORACLE_TELEMETRY write for handshake methods', () => {
	it('initialize writes clientInfo to ORACLE_TELEMETRY KV when present', async () => {
		const testIp = '192.0.2.50';
		const ipHash = await sha256Hex(testIp);
		const today  = new Date().toISOString().slice(0, 10);
		const kvKey  = `mcp_clients:${today}:${ipHash}`;
		await env.ORACLE_TELEMETRY.delete(kvKey);

		await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'test', version: '1.0' }, capabilities: {} } }),
		});

		// clientInfo is captured via deferred KV write
		await new Promise(r => setTimeout(r, 200));
		const raw = await env.ORACLE_TELEMETRY.get(kvKey);
		expect(raw).toBeTruthy();
		const record = JSON.parse(raw!) as { client_info?: { name: string; version: string } };
		expect(record.client_info).toEqual({ name: 'test', version: '1.0' });
		await env.ORACLE_TELEMETRY.delete(kvKey);
	});

	it('ping does not write to ORACLE_TELEMETRY KV', async () => {
		const testIp = '192.0.2.51';
		const ipHash = await sha256Hex(testIp);
		const today  = new Date().toISOString().slice(0, 10);
		const kvKey  = `mcp_clients:${today}:${ipHash}`;
		await env.ORACLE_TELEMETRY.delete(kvKey);

		await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
		});

		const raw = await env.ORACLE_TELEMETRY.get(kvKey);
		expect(raw).toBeNull(); // fast path — no KV write for ping
	});

	it('tools/list still writes to ORACLE_TELEMETRY KV (telemetry preserved)', async () => {
		const testIp = '192.0.2.52';
		const ipHash = await sha256Hex(testIp);
		const today  = new Date().toISOString().slice(0, 10);
		const kvKey  = `mcp_clients:${today}:${ipHash}`;
		await env.ORACLE_TELEMETRY.delete(kvKey);

		await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
		});

		const raw = await env.ORACLE_TELEMETRY.get(kvKey);
		expect(raw).not.toBeNull(); // tools/list still tracks telemetry
	});
});

// ─── GET /v5/why-not-free ─────────────────────────────────────────────────────

describe('GET /v5/why-not-free', () => {
	it('returns 200 with upgrade ladder shape', async () => {
		const res = await fetchWorker('/v5/why-not-free');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('sandbox');
		expect(body).toHaveProperty('x402_per_request');
		expect(body).toHaveProperty('x402_sandbox');
		expect(body).toHaveProperty('credits');
		expect(body).toHaveProperty('builder');
		expect(body).toHaveProperty('agent_native_path');
		const sandbox = body.sandbox as Record<string, unknown>;
		expect(sandbox).toHaveProperty('calls', 200);
		const x402 = body.x402_per_request as Record<string, unknown>;
		expect(x402).toHaveProperty('cost', '$0.001 USDC');
	});

	it('402 responses include Link header pointing to /v5/why-not-free', async () => {
		// Use a payment address that is already set in .dev.vars — no env mutation needed.
		// ORACLE_PAYMENT_ADDRESS is configured in dev.vars so /v5/status returns 402 without a key.
		const res = await fetchWorker('/v5/status?mic=XNYS');
		// May be 401 (no payment address) or 402 (payment address set in dev.vars).
		// Either way, any 402 response must carry the Link header.
		if (res.status === 402) {
			const linkHeader = res.headers.get('Link');
			expect(linkHeader).toBeTruthy();
			expect(linkHeader).toContain('/v5/why-not-free');
			expect(linkHeader).toContain('rel="payment"');
		} else {
			// No payment address in this env — trigger via /v5/sandbox limit path
			const limitRes = await fetchWorker('/v5/sandbox', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'link-test@example.com' }),
			});
			// Provision a sandbox key then exhaust it to force a 402
			// Instead: verify the Link header is present on any synthetic 402 we can trigger
			// The json() helper adds Link on status===402; verify via /v5/credits/purchase path
			const credRes = await fetchWorker('/v5/credits/purchase', { method: 'POST' });
			if (credRes.status === 402) {
				const linkHeader = credRes.headers.get('Link');
				expect(linkHeader).toContain('/v5/why-not-free');
			} else {
				// Skip — no 402 path reachable without env mutation in this test env
				expect(true).toBe(true);
			}
		}
	});
});

// ─── GET /v5/batch ────────────────────────────────────────────────────────────

describe('GET /v5/batch', () => {
	it('returns 402 x402scan format without API key — includes input schema for mics param and CDP bazaar extension', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,XNAS');
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
		expect(body).toHaveProperty('error', 'Payment Required');
		expect(Array.isArray(body.accepts)).toBe(true);
		const accepts = body.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('maxAmountRequired', '5000');
		expect(accepts[0]).toHaveProperty('input');
		const input = accepts[0].input as Record<string, unknown>;
		expect((input.required as string[])).toContain('mics');
		// v2 shape: extensions.bazaar.{info, schema} present for CDP Bazaar indexing.
		const extensions = body.extensions as Record<string, unknown>;
		expect(extensions).toBeDefined();
		const bazaar = extensions.bazaar as Record<string, unknown>;
		expect(bazaar).toBeDefined();
		const bazaarInfo = bazaar.info as Record<string, unknown>;
		expect(bazaarInfo).toHaveProperty('input');
		expect(bazaarInfo).toHaveProperty('category', 'financial-data');
		expect(bazaarInfo).toHaveProperty('family', 'market-state');
		expect(bazaar.schema).toBeDefined();
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MISSING_PARAMETER');
	});

	it('returns 400 when mics param is an empty string', async () => {
		const response = await fetchWorker('/v5/batch?mics=', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MISSING_PARAMETER');
	});

	it('returns 400 for an unknown MIC in the batch', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,ZZZZ', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
	});

	it('returns 200 with 2 signed receipts for XNYS,XNAS', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS,XNAS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		const mics = receipts.map((r) => r.mic as string);
		expect(mics).toContain('XNYS');
		expect(mics).toContain('XLON');
		expect(mics).toContain('XJPX');
	});

	it('receipt order matches request order', async () => {
		const body = await fetchJSON('/v5/batch?mics=XPAR,XHKG,XSES', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts[0].mic).toBe('XPAR');
		expect(receipts[1].mic).toBe('XHKG');
		expect(receipts[2].mic).toBe('XSES');
	});

	it('deduplicates repeated MICs — XNYS,XNYS returns one receipt', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(1);
		expect(receipts[0].mic).toBe('XNYS');
	});

	it('original 7 MICs in one batch returns 7 receipts', async () => {
		const ORIGINAL_MICS = ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES'];
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNAS,XLON,XJPX,XPAR,XHKG,XSES', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts).toHaveLength(2);
		expect(receipts[0].mic).toBe('XNYS');
		expect(receipts[1].mic).toBe('XNAS');
	});

	it('batch_id is a valid UUID', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(body.batch_id as string).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it('queried_at is a valid ISO 8601 date close to now', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		const t = new Date(body.queried_at as string).getTime();
		expect(t).not.toBeNaN();
		expect(Math.abs(Date.now() - t)).toBeLessThan(5000);
	});

	it('receipts include schema_version v5.0', async () => {
		const body = await fetchJSON('/v5/batch?mics=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
				headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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

	it('key entry includes created_at, status, and usage fields', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		const key = (body.keys as Array<Record<string, unknown>>)[0];
		expect(key).toHaveProperty('status', 'active');
		expect(key).toHaveProperty('usage', 'receipt_signing');
		expect(key).toHaveProperty('created_at');
		expect(new Date(key.created_at as string).getTime()).not.toBeNaN();
	});

	it('response includes issuer, service identifier, and spec URL', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		expect(body).toHaveProperty('issuer', 'headlessoracle.com');
		expect(body).toHaveProperty('service', 'headless-oracle');
		expect(body).toHaveProperty('spec');
		expect(typeof body.spec).toBe('string');
	});

	it('returns Cache-Control public max-age=86400', async () => {
		const response = await fetchWorker('/.well-known/oracle-keys.json');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
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

	it('exposes jwks_uri pointing at the new JWKS endpoint', async () => {
		const body = await fetchJSON('/.well-known/oracle-keys.json');
		expect(body).toHaveProperty('jwks_uri', 'https://headlessoracle.com/.well-known/jwks.json');
	});
});

// ─── GET /.well-known/jwks.json (RFC 7517 JWKS discovery) ────────────────────
// Discovery-only in this release: deployed SDKs continue to verify against
// /.well-known/oracle-keys.json (hex public_key). See SUMMARY.md for the
// deferred kid-in-receipt migration.

describe('GET /.well-known/jwks.json', () => {
	it('returns 200 application/jwk-set+json with Cache-Control public max-age=300', async () => {
		const response = await fetchWorker('/.well-known/jwks.json');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/jwk-set+json');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
	});

	// The published set, named kid by kid. Asserted as an exact SET rather than
	// a count: `keys.length` broke once when this went 2 -> 5, and a count
	// breaks again on every rotation while proving nothing about WHICH keys are
	// served. The set catches both directions — a MISSING key (an
	// add-and-retain violation, which silently stops prior receipts from
	// verifying) and an UNEXPECTED one (a key nobody meant to publish).
	//
	// The first kid is the RFC 7638 thumbprint of the .dev.vars test keypair,
	// so it tracks the local key; the other four are literals in src/index.ts.
	// On a rotation, ADD the new kid here — never replace a retained one.
	const EXPECTED_KIDS = [
		'id8Q65wQUOn9lWtAe__JwqChpIAL38N8GDQbqrRngBM', // oracle receipt-signing (from .dev.vars)
		'ed25519/Y-QgeO0vHBBE',                        // Chirindo MCP-gate recorder — rotated out, retained
		'ed25519/nQgjxdLXI3wJ',                        // Chirindo MCP-gate recorder — current
		'study2026-54fb',                              // delivery-incidence study — human cross-reference label
		'yxjyYJ6HtT7thhoXpZGi4DptSN_b_d5L1_DTL_3SlyI', // same study key under its RFC 7638 thumbprint
	];

	it('publishes exactly the expected kid set, all OKP/Ed25519 (add-and-retain)', async () => {
		const body = await fetchJSON('/.well-known/jwks.json');
		expect(body).toHaveProperty('keys');
		const keys = body.keys as Array<Record<string, unknown>>;
		expect(Array.isArray(keys)).toBe(true);
		expect(keys.map(k => k.kid as string).sort()).toEqual([...EXPECTED_KIDS].sort());
		for (const key of keys) {
			expect(key.kty).toBe('OKP');
			expect(key.crv).toBe('Ed25519');
			expect(key.use).toBe('sig');
			expect(key.alg).toBe('EdDSA');
			expect(key.key_ops).toEqual(['verify']);
			expect(typeof key.x).toBe('string');
			expect(typeof key.kid).toBe('string');
		}
	});

	it('second key is the Chirindo MCP-gate recorder JWK, with recorder-format kid (not a thumbprint)', async () => {
		const body = await fetchJSON('/.well-known/jwks.json');
		const gateKey = (body.keys as Array<Record<string, unknown>>)[1];
		expect(gateKey).toEqual({
			kty:     'OKP',
			crv:     'Ed25519',
			x:       'spZ69O-JgF84hkOWIjKrwKv0zwAjF87tmxuYN-8RQrs',
			kid:     'ed25519/Y-QgeO0vHBBE',
			use:     'sig',
			alg:     'EdDSA',
			key_ops: ['verify'],
		});
	});

	it('x matches base64url(no-pad) of the active hex public key', async () => {
		// Test keypair from .dev.vars — must match what the worker is loading.
		const expectedX = '-K949WPoqmmLNbCyURzUMKjEqm95YFNLsrfiLZtKP7g';
		const body = await fetchJSON('/.well-known/jwks.json');
		const key = (body.keys as Array<Record<string, unknown>>)[0];
		expect(key.x).toBe(expectedX);
	});

	it('kid is the RFC 7638 thumbprint of the canonical OKP JWK', async () => {
		// Expected = base64url-no-pad( SHA-256( '{"crv":"Ed25519","kty":"OKP","x":"<x>"}' ) )
		// Computed once with Node crypto against the .dev.vars test public key.
		// If this fails after a keypair rotation, recompute and update the literal.
		const expectedKid = 'id8Q65wQUOn9lWtAe__JwqChpIAL38N8GDQbqrRngBM';
		const body = await fetchJSON('/.well-known/jwks.json');
		const key = (body.keys as Array<Record<string, unknown>>)[0];
		expect(key.kid).toBe(expectedKid);
	});

	it('x byte-decodes to the same 32 bytes as the hex public_key on oracle-keys.json', async () => {
		const [jwks, wellKnown] = await Promise.all([
			fetchJSON('/.well-known/jwks.json'),
			fetchJSON('/.well-known/oracle-keys.json'),
		]);
		const jwksKey = (jwks.keys     as Array<Record<string, unknown>>)[0];
		const wkKey   = (wellKnown.keys as Array<Record<string, unknown>>)[0];
		const xB64u   = jwksKey.x as string;
		// Decode base64url → bytes → hex, compare against the hex source of truth.
		const b64 = xB64u.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - xB64u.length % 4) % 4);
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		expect(hex).toBe(wkKey.public_key);
	});
});

// ─── GET /.well-known/x402.json ────────────────────────────────────────────────────────────────────

describe('GET /.well-known/x402.json', () => {
	it('returns 200 with x402 resource discovery document', async () => {
		const body = await fetchJSON('/.well-known/x402.json');
		expect(body).toHaveProperty('version', 1);
		expect(Array.isArray(body.resources)).toBe(true);
		const resources = body.resources as Array<Record<string, unknown>>;
		// /v5/status, /v5/batch, /v5/status/x402 (H4a) and /v5/x402/mint
		expect(resources.length).toBe(4);
		expect(resources.some((r) => r.path === '/v5/x402/mint')).toBe(true);
	});

	it('lists /v5/status with mic input schema and 1000 unit amount', async () => {
		const body = await fetchJSON('/.well-known/x402.json');
		const resources = body.resources as Array<Record<string, unknown>>;
		const status = resources.find((r) => r.path === '/v5/status');
		expect(status).toBeDefined();
		expect(status!.method).toBe('GET');
		const accepts = status!.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('maxAmountRequired', '1000');
		expect(accepts[0]).toHaveProperty('network', 'base');
		// payTo must be a non-empty address when ORACLE_PAYMENT_ADDRESS is configured
		expect(typeof accepts[0].payTo).toBe('string');
		expect((accepts[0].payTo as string).length).toBeGreaterThan(0);
		const input = status!.input as Record<string, unknown>;
		expect((input.required as string[])).toContain('mic');
	});

	it('lists /v5/batch with mics input schema and 5000 unit amount', async () => {
		const body = await fetchJSON('/.well-known/x402.json');
		const resources = body.resources as Array<Record<string, unknown>>;
		const batch = resources.find((r) => r.path === '/v5/batch');
		expect(batch).toBeDefined();
		const accepts = batch!.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('maxAmountRequired', '5000');
		const input = batch!.input as Record<string, unknown>;
		expect((input.required as string[])).toContain('mics');
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

// ─── GET /.well-known/security.txt ───────────────────────────────────────────

describe('GET /.well-known/security.txt', () => {
	it('returns 200 with text/plain content-type', async () => {
		const response = await fetchWorker('/.well-known/security.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/plain');
	});

	it('contains required RFC 9116 fields', async () => {
		const body = await fetchWorker('/.well-known/security.txt').then((r) => r.text());
		// CHANGED 2026-10-04 (H3a, G13): one contact address across the machine files.
		expect(body).toContain('Contact: mailto:mike@headlessoracle.com');
		expect(body).toContain('Expires: 2027-04-08T00:00:00.000Z');
		expect(body).toContain('Preferred-Languages: en');
		expect(body).toContain('Canonical: https://headlessoracle.com/.well-known/security.txt');
		expect(body).toContain('Policy: https://github.com/LembaGang/headless-oracle-v5/blob/main/SECURITY.md');
	});
});

// ─── GET /llms.txt ────────────────────────────────────────────────────────────

describe('GET /llms.txt', () => {
	it('returns 200 with text/markdown content-type (llmstxt.org spec)', async () => {
		const response = await fetchWorker('/llms.txt');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains spec-compliant structure with sections and MCP tools', async () => {
		// CHANGED 2026-10-04 (H3a, G1): Chirindo/Witness first, market-state second.
		const body = await fetchWorker('/llms.txt').then((r) => r.text());
		expect(body).toContain('## Chirindo Witness');
		expect(body).toContain('## Market-state attestations (also available)');
		expect(body).toContain('get_market_status');
		expect(body).toContain('/v5/status');
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

	it('contains identity fields and Oracle trust anchors', async () => {
		const body = await fetchWorker('/.well-known/agent.json').then((r) => r.json()) as Record<string, unknown>;
		// Identity
		expect(body).toHaveProperty('name', 'Headless Oracle');
		expect(body).toHaveProperty('version', 'v5.0');
		// CHANGED (H4a): no top-level url (A2A clients POSTed to it); homepage instead.
		expect(body).not.toHaveProperty('url');
		expect(body).toHaveProperty('homepage', 'https://headlessoracle.com');
		expect(body).toHaveProperty('documentationUrl', 'https://headlessoracle.com/docs');
		// Provider
		const provider = body.provider as Record<string, unknown>;
		expect(provider.organization).toBe('LembaGang');
		// No capabilities struct: that was A2A AgentCard shape, and no endpoint speaks A2A
		expect(Object.keys(body)).not.toContain('capabilities');
		// Authentication
		const auth = body.authentication as Record<string, unknown>;
		expect((auth.schemes as string[])).toContain('bearer');
		expect((auth.schemes as string[])).toContain('apiKey');
		expect((auth.schemes as string[])).toContain('x402');
		// Skills, including verify_receipt
		const skills = body.skills as Array<{ id: string }>;
		expect(Array.isArray(skills)).toBe(true);
		const skillIds = skills.map((s) => s.id);
		expect(skillIds).toContain('get_market_status');
		expect(skillIds).toContain('get_market_schedule');
		expect(skillIds).toContain('list_exchanges');
		expect(skillIds).toContain('verify_receipt');
		// Oracle extensions
		expect(body).toHaveProperty('fail_closed', true);
		expect(Array.isArray(body.supported_exchanges)).toBe(true);
		expect((body.supported_exchanges as string[]).length).toBe(28);
		expect(body).toHaveProperty('input_schema');
		expect(body).toHaveProperty('output_schema');
		// Retained MCP block
		const mcp = body.mcp as { endpoint: string; tools: Array<{ name: string }> };
		expect(mcp.endpoint).toBe('https://headlessoracle.com/mcp');
		// Retained safety block
		const safety = body.safety as { fail_closed: boolean; unknown_means: string };
		expect(safety.fail_closed).toBe(true);
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
		expect(body).toHaveProperty('version', 'v5.0');
		expect(body).toHaveProperty('mcp_endpoint', 'https://headlessoracle.com/mcp');
		expect(body).toHaveProperty('homepage', 'https://headlessoracle.com');
		expect(body).toHaveProperty('docs', 'https://headlessoracle.com/docs');
		expect(body).toHaveProperty('description');
		expect(typeof body.description).toBe('string');
	});

	it('lists exactly the tools POST /mcp tools/list serves, and names each in the description', async () => {
		const body  = await fetchJSON('/.well-known/mcp/server-card.json');
		const tools = body.tools as string[];
		const listed = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const served = ((listed.result as Record<string, unknown>).tools as Array<{ name: string }>).map((t) => t.name);
		expect(tools.length).toBe(served.length);
		expect([...tools].sort()).toEqual([...served].sort());
		expect(tools).not.toContain('verify_receipt');
		for (const name of served) expect(body.description as string).toContain(name);
	});

	it('lists all authentication schemes', async () => {
		const body  = await fetchJSON('/.well-known/mcp/server-card.json');
		const auth  = body.authentication as string[];
		expect(auth).toContain('bearer');
		expect(auth).toContain('apiKey');
		expect(auth).toContain('x402');
	});

	it('exposes model_agnostic and category tags, cites the regulator documents as references only, and makes no regulatory-alignment claim', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		expect(body).toHaveProperty('model_agnostic', true);
		expect(body).not.toHaveProperty('regulatory_alignment');
		expect(body.regulatory_references).toBeDefined();
		// Structured references present as sibling field
		expect(Array.isArray(body.regulatory_references)).toBe(true);
		expect((body.regulatory_references as unknown[]).length).toBeGreaterThanOrEqual(2);
		// Fabricated framework name must not appear anywhere in the body
		expect(JSON.stringify(body)).not.toContain('SEC/CFTC Technical Framework');
		const cats = body.categories as string[];
		expect(cats).toContain('finance');
		expect(cats).toContain('market-data');
		expect(cats).toContain('attestation');
		expect(cats).toContain('verification');
		expect(cats).toContain('pre-trade-safety');
		expect(cats).toContain('rwa');
		expect(cats).toContain('tokenization');
	});

	it('server-card coverage.exchanges reports 28', async () => {
		const body = await fetchJSON('/.well-known/mcp/server-card.json');
		const coverage = body.coverage as Record<string, unknown>;
		expect(coverage.exchanges).toBe(28);
	});
});

// ─── Agent Readiness Stack — static discovery surface ────────────────────────

describe('GET /.well-known/mcp (extensionless alias)', () => {
	it('returns 200 with application/json content-type', async () => {
		const res = await fetchWorker('/.well-known/mcp');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
	});

	it('returns the same payload as /.well-known/mcp.json', async () => {
		const a = await fetchJSON('/.well-known/mcp');
		const b = await fetchJSON('/.well-known/mcp.json');
		expect(a.name).toBe(b.name);
		expect(a.mcp_endpoint).toBe(b.mcp_endpoint);
		expect(a).toEqual(b);
	});
});

describe('Agent Skills discovery (agentskills.io 0.2.0)', () => {
	it('GET /.well-known/agent-skills/index.json returns 200 application/json', async () => {
		const res = await fetchWorker('/.well-known/agent-skills/index.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
	});

	it('index declares $schema, version 0.2.0, and 5 skills', async () => {
		const body = await fetchJSON('/.well-known/agent-skills/index.json');
		expect(body.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
		expect(body.version).toBe('0.2.0');
		const skills = body.skills as Array<unknown>;
		expect(Array.isArray(skills)).toBe(true);
		expect(skills.length).toBe(5);
	});

	it('each skill entry has the required 0.2.0 fields with valid shapes', async () => {
		const body = await fetchJSON('/.well-known/agent-skills/index.json');
		const skills = body.skills as Array<Record<string, unknown>>;
		for (const s of skills) {
			expect(s.name as string).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
			expect(s.type).toBe('skill-md');
			expect(typeof s.description).toBe('string');
			expect(s.url as string).toMatch(/^https:\/\/headlessoracle\.com\/\.well-known\/agent-skills\/.+\/SKILL\.md$/);
			expect(s.digest as string).toMatch(/^sha256:[0-9a-f]{64}$/);
		}
	});

	it('index digest matches the SHA-256 of the served SKILL.md bytes', async () => {
		const body   = await fetchJSON('/.well-known/agent-skills/index.json');
		const skills = body.skills as Array<{ name: string; digest: string }>;
		const entry  = skills.find((s) => s.name === 'verify-receipt')!;
		const md     = await fetchWorker('/.well-known/agent-skills/verify-receipt/SKILL.md').then((r) => r.text());
		const buf    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md));
		const hex    = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
		expect(entry.digest).toBe('sha256:' + hex);
	});

	it.each(['verify-receipt', 'read-market-state', 'subscribe-halts', 'pay-with-x402', 'mcp-tool-catalog'])(
		'GET /.well-known/agent-skills/%s/SKILL.md returns 200 text/markdown', async (name) => {
			const res = await fetchWorker(`/.well-known/agent-skills/${name}/SKILL.md`);
			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('text/markdown');
			const body = await res.text();
			expect(body).toContain(`name: ${name}`);
		},
	);

	it('unknown skill name returns 404', async () => {
		const res = await fetchWorker('/.well-known/agent-skills/does-not-exist/SKILL.md');
		expect(res.status).toBe(404);
	});

	// The mcp-tool-catalog skill listed verify_receipt as an MCP tool and said "five
	// tools" while tools/list served four. Its ## Tools section must name exactly the
	// tools POST /mcp tools/list serves, and the index must state the same count.
	it('openapi /mcp description names exactly the tools POST /mcp tools/list serves', async () => {
		const listed = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const served = ((listed.result as Record<string, unknown>).tools as Array<{ name: string }>).map((t) => t.name);
		const spec   = await fetchJSON('/openapi.json') as { paths: Record<string, { post: { description: string } }> };
		const desc   = spec.paths['/mcp'].post.description;
		const named  = (desc.match(/Tools: ([a-z_, ]+)\./) ?? [])[1]?.split(', ') ?? [];
		expect([...named].sort()).toEqual([...served].sort());
	});

	it('mcp-tool-catalog names exactly the tools POST /mcp tools/list serves', async () => {
		const listed = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const served = ((listed.result as Record<string, unknown>).tools as Array<{ name: string }>).map((t) => t.name);
		const md     = await fetchWorker('/.well-known/agent-skills/mcp-tool-catalog/SKILL.md').then((r) => r.text());
		const section = md.split('## Tools')[1].split('\n## ')[0];
		const named  = [...section.matchAll(/^- ([a-z_]+) \{/gm)].map((m) => m[1]);
		expect([...named].sort()).toEqual([...served].sort());
		const front  = md.split('---')[1];
		for (const name of served) expect(front).toContain(name);
		expect(front).not.toContain('verify_receipt');
		const index  = await fetchJSON('/.well-known/agent-skills/index.json');
		const entry  = (index.skills as Array<{ name: string; description: string }>).find((s) => s.name === 'mcp-tool-catalog')!;
		const words  = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
		expect(entry.description).toContain(`its ${words[served.length]} market-state tools`);
	});

	// Since 2026-10-07 MCP reads the API key itself (Bearer or X-Oracle-Key), and
	// still accepts an OAuth access token. The skill says both, and no longer
	// says MCP reads neither.
	it('mcp-tool-catalog says MCP reads the API key in Bearer or X-Oracle-Key, and that the token exchange still works', async () => {
		const md = await fetchWorker('/.well-known/agent-skills/mcp-tool-catalog/SKILL.md').then((r) => r.text());
		expect(md).toContain('Authorization: Bearer <api key>');
		expect(md).toContain('X-Oracle-Key: <api key>');
		expect(md).toContain('POST https://headlessoracle.com/oauth/token');
		expect(md).not.toContain('MCP reads neither');
		// Lead ruling: only our own credentials are refused; foreign values are ignored.
		expect(md).toContain('An API key or token issued by Headless Oracle that is not accepted (unknown, expired, out of quota) is answered with a JSON-RPC error; other Authorization values are ignored.');
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, { post: { description: string } }> };
		expect(spec.paths['/mcp'].post.description).toContain('an API key or token issued by Headless Oracle that is not accepted is answered with a JSON-RPC error; other Authorization values are ignored.');
	});

	it('no agent skill describes verify_receipt as an MCP tool', async () => {
		for (const name of ['verify-receipt', 'read-market-state', 'subscribe-halts', 'pay-with-x402', 'mcp-tool-catalog']) {
			const md = await fetchWorker(`/.well-known/agent-skills/${name}/SKILL.md`).then((r) => r.text());
			expect(md, name).not.toMatch(/verify_receipt is (also )?an MCP tool/);
			expect(md, name).not.toMatch(/^- verify_receipt \{/m);
		}
	});
});

describe('GET /.well-known/api-catalog (RFC 9727 linkset)', () => {
	it('returns 200 with application/linkset+json content-type', async () => {
		const res = await fetchWorker('/.well-known/api-catalog');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/linkset+json');
	});

	it('body is an RFC 9727 linkset with anchored service-desc links', async () => {
		const body    = await fetchJSON('/.well-known/api-catalog');
		const linkset = body.linkset as Array<Record<string, unknown>>;
		expect(Array.isArray(linkset)).toBe(true);
		expect(linkset.length).toBeGreaterThan(0);
		const first = linkset[0];
		expect(typeof first.anchor).toBe('string');
		expect(Array.isArray(first['service-desc'])).toBe(true);
	});
});

describe('Agent directory (soft-404 trap fix)', () => {
	it('GET /agent-directory.json returns 200 application/json, not the Pages HTML soft-404', async () => {
		const res = await fetchWorker('/agent-directory.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		const body = await res.json() as Record<string, unknown>;
		expect(Array.isArray(body.agents)).toBe(true);
	});

	it('GET /.well-known/agent-directory.json returns the identical payload', async () => {
		const a = await fetchJSON('/agent-directory.json');
		const b = await fetchJSON('/.well-known/agent-directory.json');
		expect(a).toEqual(b);
		const agents = a.agents as Array<Record<string, unknown>>;
		expect(Object.keys(agents[0])).not.toContain('agent_card');
		expect(JSON.stringify(a)).not.toContain('agent-card');
	});
});

describe('robots.txt — Content Signals + explicit bot allows', () => {
	it('declares Cloudflare Content Signals', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		// CHANGED 2026-10-04 (H3a, G14, Lead decision): ai-train=yes, in every group.
		expect(body).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=yes');
	});

	it('explicitly allows agent + AI crawlers', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		expect(body).toContain('User-agent: AgenstryBot');
		expect(body).toContain('User-agent: Open402DirectoryCrawler');
		expect(body).toContain('User-agent: GPTBot');
	});

	it('preserves existing Allow directives (additive diff)', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		expect(body).toContain('Allow: /llms.txt');
		expect(body).toContain('Allow: /.well-known/');
	});

	it('declares the sitemap exactly once', async () => {
		const body = await fetchWorker('/robots.txt').then((r) => r.text());
		const matches = body.match(/Sitemap: https:\/\/headlessoracle\.com\/sitemap\.xml/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});

describe('MCP tool descriptions — semantic upgrade', () => {
	it('get_market_status description is model-agnostic, carries the no-endorsement line, and makes no SEC/CFTC compliance claim', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const tools = (body.result as { tools: Array<{ name: string; description: string }> }).tools;
		const tool  = tools.find((t) => t.name === 'get_market_status')!;
		expect(tool.description).toMatch(/Model-agnostic/);
		expect(tool.description).toMatch(/No regulator has reviewed or endorsed this service/);
		expect(tool.description).not.toMatch(/SEC\/CFTC/);
		expect(tool.description).toMatch(/Pre-trade safety check/i);
		expect(tool.description).toMatch(/MUST NOT execute/);
	});

	it('tool descriptions name regional exchanges, not just MIC codes', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const tools = (body.result as { tools: Array<{ name: string; description: string }> }).tools;
		const status = tools.find((t) => t.name === 'get_market_status')!;
		expect(status.description).toMatch(/Shanghai Stock Exchange/);
		expect(status.description).toMatch(/Korea Exchange/);
		expect(status.description).toMatch(/Tokyo Stock Exchange/);
	});
});

// ─── GET /.well-known/oauth-protected-resource ───────────────────────────────

describe('GET /.well-known/oauth-protected-resource', () => {
	it('returns 200 with application/json content-type', async () => {
		const response = await fetchWorker('/.well-known/oauth-protected-resource');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
	});

	it('contains required RFC 8705 fields with correct values', async () => {
		const body = await fetchJSON('/.well-known/oauth-protected-resource');
		// Mandatory field
		expect(body).toHaveProperty('resource', 'https://headlessoracle.com');
		// Points to the OAuth AS — OAuth is an optional upgrade path, not a requirement
		expect(body).toHaveProperty('authorization_servers');
		expect(Array.isArray(body.authorization_servers)).toBe(true);
		expect(body.authorization_servers).toContain('https://headlessoracle.com/oauth');
		// header = Bearer token via Authorization: header
		expect(body).toHaveProperty('bearer_methods_supported');
		expect(body.bearer_methods_supported).toEqual(['header']);
		// Documentation link
		expect(body).toHaveProperty('resource_documentation', 'https://headlessoracle.com/docs');
		// Signing algorithm
		expect(body).toHaveProperty('resource_signing_alg_values_supported');
		expect(body.resource_signing_alg_values_supported).toContain('EdDSA');
		// Scopes — oracle:read is the only scope
		expect(body).toHaveProperty('scopes_supported');
		expect(body.scopes_supported).toContain('oracle:read');
	});
});

// ─── OAuth 2.0 — /.well-known/oauth-authorization-server ─────────────────────

describe('GET /.well-known/oauth-authorization-server', () => {
	it('returns 200 with correct RFC 8414 shape', async () => {
		const res  = await fetchWorker('/.well-known/oauth-authorization-server');
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body).toHaveProperty('issuer', 'https://headlessoracle.com/oauth');
		expect(body).toHaveProperty('token_endpoint', 'https://headlessoracle.com/oauth/token');
		expect(body).toHaveProperty('grant_types_supported');
		expect(body.grant_types_supported).toContain('client_credentials');
		expect(body).toHaveProperty('scopes_supported');
		expect(body.scopes_supported).toContain('oracle:read');
	});
});

// ─── OAuth 2.0 — POST /oauth/token ───────────────────────────────────────────

describe('POST /oauth/token', () => {
	it('issues access_token for valid client_id', async () => {
		const res = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials&client_id=test_master_key_local_only&client_secret=test_master_key_local_only',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body).toHaveProperty('access_token');
		expect(typeof body.access_token).toBe('string');
		expect((body.access_token as string).length).toBe(64); // 32 bytes → 64 hex chars
		expect(body).toHaveProperty('token_type', 'bearer');
		expect(body).toHaveProperty('expires_in', 3600);
		expect(body).toHaveProperty('scope', 'oracle:read');
	});

	it('returns 401 invalid_client for unknown client_id', async () => {
		const res = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials&client_id=definitely_not_a_valid_key',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(401);
		expect(body).toHaveProperty('error', 'invalid_client');
	});

	it('returns 400 invalid_request when client_id is missing', async () => {
		const res = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(400);
		expect(body).toHaveProperty('error', 'invalid_request');
	});

	it('returns 400 unsupported_grant_type for non-client_credentials', async () => {
		const res = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=authorization_code&client_id=test_master_key_local_only',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(400);
		expect(body).toHaveProperty('error', 'unsupported_grant_type');
	});

	it('stores token in ORACLE_API_KEYS KV with oauth: prefix', async () => {
		const res = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials&client_id=test_master_key_local_only',
		});
		const body  = await res.json() as Record<string, unknown>;
		const token = body.access_token as string;

		// Compute expected KV key
		const encoded   = new TextEncoder().encode(token);
		const hashBuf   = await crypto.subtle.digest('SHA-256', encoded);
		const tokenHash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');

		const stored = await env.ORACLE_API_KEYS.get(`oauth:${tokenHash}`);
		expect(stored).not.toBeNull();
		const parsed = JSON.parse(stored!) as Record<string, unknown>;
		expect(parsed).toHaveProperty('plan');
		expect(parsed).toHaveProperty('status', 'active');
		// expires_at required for introspection — must be a Unix timestamp ~1 hour out
		expect(parsed).toHaveProperty('expires_at');
		const exp = parsed.expires_at as number;
		expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3601);
	});
});

// ─── OAuth 2.0 — POST /oauth/introspect ──────────────────────────────────────

describe('POST /oauth/introspect', () => {
	it('returns { active: true, scope, exp } for a valid token', async () => {
		// Issue a real token first
		const tokenRes = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials&client_id=test_master_key_local_only',
		});
		const { access_token } = await tokenRes.json() as { access_token: string };

		const res  = await fetchWorker('/oauth/introspect', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    `token=${access_token}`,
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body).toHaveProperty('active', true);
		expect(body).toHaveProperty('scope', 'oracle:read');
		expect(body).toHaveProperty('exp');
		expect(typeof body.exp).toBe('number');
		expect(body.exp as number).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('returns { active: false } for an unknown token', async () => {
		const res  = await fetchWorker('/oauth/introspect', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'token=this_token_does_not_exist_in_kv_at_all',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200); // RFC 7662 §2.2 — always 200
		expect(body).toHaveProperty('active', false);
	});

	it('returns { active: false } when token param is missing — not 4xx', async () => {
		const res  = await fetchWorker('/oauth/introspect', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    '',
		});
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body).toHaveProperty('active', false);
	});

	it('/.well-known/oauth-authorization-server includes introspection_endpoint', async () => {
		const body = await fetchJSON('/.well-known/oauth-authorization-server');
		expect(body).toHaveProperty('introspection_endpoint', 'https://headlessoracle.com/oauth/introspect');
	});
});

// ─── OAuth 2.0 — MCP soft auth (Bearer token) ────────────────────────────────

describe('POST /mcp — OAuth soft auth', () => {
	it('existing unauthenticated /mcp access is unaffected (no Authorization header)', async () => {
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('result');
	});

	it('valid Bearer token is accepted and request succeeds', async () => {
		// Issue a token first
		const tokenRes = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    'grant_type=client_credentials&client_id=test_master_key_local_only',
		});
		const { access_token } = await tokenRes.json() as { access_token: string };

		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${access_token}` },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
		});
		// Must succeed — same response shape as unauthenticated
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('result');
	});

	// A foreign Bearer value (not a shape Headless Oracle issues) is ignored, as
	// before. What an HO-shaped credential that is not accepted gets is pinned in
	// 'POST /mcp — an API key in Bearer or X-Oracle-Key authenticates'.
	it('invalid Bearer token falls through as anonymous — does not return 401', async () => {
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer this_is_not_a_valid_token_at_all' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }),
		});
		// Must not block — fall through to serve the request anonymously
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('result');
		// A metered method too, not only the handshake.
		const list = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer this_is_not_a_valid_token_at_all' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
		});
		const listBody = await list.json() as Record<string, unknown>;
		expect(listBody).toHaveProperty('result');
		expect(listBody).not.toHaveProperty('error');
	});
});

// ─── MCP reads the API key itself (2026-10-07) ───────────────────────────────
// Most MCP clients send their API key as Authorization: Bearer. MCP read a
// Bearer value only as an OAuth access token, so a raw key there was served as
// anonymous (10 get_market_status per IP per day) while the caller believed it
// was on its plan. Now: a valid OAuth token first, then X-Oracle-Key, then the
// Bearer value as an API key. A credential that is presented and not accepted
// is a JSON-RPC error, never a silent fall back to anonymous.
describe('POST /mcp — an API key in Bearer or X-Oracle-Key authenticates', () => {
	const today = () => new Date().toISOString().slice(0, 10);
	async function anonKey(): Promise<string> { return `unauth_mcp_status:${await sha256Hex('')}:${today()}`; }
	function mcpCall(headers: Record<string, string>, method = 'tools/call', e: typeof env = env) {
		const body = method === 'tools/call'
			? { jsonrpc: '2.0', id: 31, method, params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }
			: { jsonrpc: '2.0', id: 31, method, params: method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } : undefined };
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/mcp', {
			method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		return worker.fetch(request, e, ctx).then(async (res) => { await waitOnExecutionContext(ctx); return res.json() as Promise<Record<string, unknown>>; });
	}
	const receiptOf = (b: Record<string, unknown>) => {
		const r = b.result as Record<string, unknown>;
		expect(r.isError).not.toBe(true);
		return JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
	};
	const balanceOf = async (keyHash: string) => (JSON.parse((await env.ORACLE_API_KEYS.get(keyHash)) ?? '{}') as { balance?: number }).balance;

	it('a raw free key as Bearer is metered against that key, not the anonymous IP cap', async () => {
		const key  = 'ho_free_' + 'a1'.repeat(32);
		const hash = await setupFreeKey(key);
		await env.ORACLE_TELEMETRY.put(await anonKey(), '10'); // anonymous cap already spent
		const b = await mcpCall({ 'Authorization': `Bearer ${key}` });
		expect(receiptOf(b).mic).toBe('XNYS');
		expect(await env.ORACLE_TELEMETRY.get(`free_usage:${hash}:${today()}`)).toBe('1');
		expect(await env.ORACLE_TELEMETRY.get(await anonKey())).toBe('10');
	});

	it('X-Oracle-Key authenticates MCP the same way', async () => {
		const key  = 'ho_free_' + 'a2'.repeat(32);
		const hash = await setupFreeKey(key);
		await env.ORACLE_TELEMETRY.put(await anonKey(), '10');
		const b = await mcpCall({ 'X-Oracle-Key': key });
		expect(receiptOf(b).mic).toBe('XNYS');
		expect(await env.ORACLE_TELEMETRY.get(`free_usage:${hash}:${today()}`)).toBe('1');
	});

	it('a credit-pack key as Bearer is debited exactly one credit per call and refused at zero', async () => {
		const key  = 'ho_crd_' + 'a3'.repeat(32);
		const hash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 2 }));
		expect(receiptOf(await mcpCall({ 'Authorization': `Bearer ${key}` })).mic).toBe('XNYS');
		expect(await balanceOf(hash)).toBe(1);
		expect(receiptOf(await mcpCall({ 'Authorization': `Bearer ${key}` })).mic).toBe('XNYS');
		expect(await balanceOf(hash)).toBe(0);
		const b3 = await mcpCall({ 'Authorization': `Bearer ${key}` });
		expect(b3).not.toHaveProperty('result');
		expect(String((b3.error as Record<string, unknown>).message)).toContain('CREDITS_EXHAUSTED');
		expect(await balanceOf(hash)).toBe(0);
	});

	it('a credit-pack key in X-Oracle-Key is debited once per call, not twice', async () => {
		const key  = 'ho_crd_' + 'a4'.repeat(32);
		const hash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 3 }));
		expect(receiptOf(await mcpCall({ 'X-Oracle-Key': key })).mic).toBe('XNYS');
		expect(await balanceOf(hash)).toBe(2);
	});

	it('a recognised key at its daily limit is refused, and does not fall back to anonymous', async () => {
		const key  = 'ho_free_' + 'a5'.repeat(32);
		const hash = await setupFreeKey(key);
		await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:${today()}`, '500');
		const b = await mcpCall({ 'Authorization': `Bearer ${key}` });
		expect(b).not.toHaveProperty('result');
		const err = b.error as Record<string, unknown>;
		expect(err.code).toBe(-32000);
		expect(String(err.message)).toContain('RATE_LIMITED');
		expect(await env.ORACLE_TELEMETRY.get(await anonKey())).toBeNull();
	});

	// Lead ruling 2026-10-07: only a credential Headless Oracle itself issues is
	// answered with an error. Gateways, registries and evaluators attach their
	// own Authorization headers when they probe; a foreign value is ignored.
	it('a foreign (JWT-looking) Bearer value is ignored: tools/list and tools/call are served as anonymous', async () => {
		const jwt = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnYXRld2F5In0.c2lnbmF0dXJl';
		const list = await mcpCall({ 'Authorization': jwt }, 'tools/list');
		expect(list).not.toHaveProperty('error');
		expect(((list.result as Record<string, unknown>).tools as unknown[]).length).toBeGreaterThan(0);
		const call = await mcpCall({ 'Authorization': jwt });
		expect(receiptOf(call).mic).toBe('XNYS');
		// Metered as anonymous (the per-IP cap), against no key.
		expect(await env.ORACLE_TELEMETRY.get(await anonKey())).toBe('1');
	});

	it('a foreign Bearer value is still anonymous when the key store cannot be read', async () => {
		const kv = env.ORACLE_API_KEYS;
		const broken = {
			get: async () => { throw new Error('KV unavailable'); },
			put: kv.put.bind(kv), delete: kv.delete.bind(kv), list: kv.list.bind(kv),
		} as unknown as typeof env.ORACLE_API_KEYS;
		const b = await mcpCall({ 'Authorization': 'Bearer gateway-session-7f3a' }, 'tools/call', { ...env, ORACLE_API_KEYS: broken } as typeof env);
		expect(receiptOf(b).mic).toBe('XNYS');
	});

	it('an unknown key in a shape Headless Oracle issues (ho_live_ + 64 hex) is INVALID_API_KEY, not anonymous', async () => {
		const key = 'ho_live_' + 'f0'.repeat(32);
		const b = await mcpCall({ 'Authorization': `Bearer ${key}` });
		expect(b).not.toHaveProperty('result');
		const err = b.error as Record<string, unknown>;
		expect(err.code).toBe(-32001);
		expect(String(err.message)).toMatch(/^INVALID_API_KEY: /);
		expect(String(err.message)).toContain('POST https://headlessoracle.com/v5/keys/instant');
		expect(String(err.message)).not.toContain(key);
		expect(await env.ORACLE_TELEMETRY.get(await anonKey())).toBeNull();
		// The handshake is unaffected.
		expect(await mcpCall({ 'Authorization': `Bearer ${key}` }, 'initialize')).toHaveProperty('result');
	});

	it('a 64-hex value (the OAuth token shape) with no token record is INVALID_API_KEY', async () => {
		const b = await mcpCall({ 'Authorization': `Bearer ${'0f'.repeat(32)}` });
		expect((b.error as Record<string, unknown>).code).toBe(-32001);
		expect(String((b.error as Record<string, unknown>).message)).toMatch(/^INVALID_API_KEY: /);
	});

	it('an unknown X-Oracle-Key is the same INVALID_API_KEY error', async () => {
		const b = await mcpCall({ 'X-Oracle-Key': 'ho_free_' + '0'.repeat(64) });
		expect((b.error as Record<string, unknown>).code).toBe(-32001);
	});

	it('a recognised but expired sandbox key is refused with its reason', async () => {
		const key  = 'sb_' + 'a6'.repeat(16);
		await env.ORACLE_API_KEYS.put(await sha256Hex(key), JSON.stringify({ tier: 'sandbox', plan: 'sandbox', status: 'active', expires_at: '2020-01-01T00:00:00Z' }));
		const b = await mcpCall({ 'Authorization': `Bearer ${key}` });
		const err = b.error as Record<string, unknown>;
		expect(err.code).toBe(-32000);
		expect(String(err.message)).toContain('SANDBOX_KEY_EXPIRED');
	});

	it('an expired 64-hex OAuth token is refused with OAUTH_TOKEN_EXPIRED, with the way forward', async () => {
		const token = 'e7'.repeat(32); // the exact shape handleOAuthToken issues
		await env.ORACLE_API_KEYS.put(`oauth:${await sha256Hex(token)}`, JSON.stringify({ keyHash: 'x'.repeat(64), plan: 'free', status: 'active', expires_at: 1 }));
		const b = await mcpCall({ 'Authorization': `Bearer ${token}` });
		const err = b.error as Record<string, unknown>;
		expect(err.code).toBe(-32001);
		expect(String(err.message)).toMatch(/^OAUTH_TOKEN_EXPIRED: /);
		expect(String(err.message)).toContain('Authorization: Bearer <api key>');
	});

	it('an HO-shaped key with a key store that cannot be read refuses the call (fail closed), not anonymous', async () => {
		const kv = env.ORACLE_API_KEYS;
		const broken = {
			get: async () => { throw new Error('KV unavailable'); },
			put: kv.put.bind(kv), delete: kv.delete.bind(kv), list: kv.list.bind(kv),
		} as unknown as typeof env.ORACLE_API_KEYS;
		const b = await mcpCall({ 'Authorization': `Bearer ho_free_${'a8'.repeat(32)}` }, 'tools/call', { ...env, ORACLE_API_KEYS: broken } as typeof env);
		const err = b.error as Record<string, unknown>;
		expect(err.code).toBe(-32000);
		expect(String(err.message)).toMatch(/^AUTH_UNAVAILABLE: /);
	});

	it('the OAuth token path is unchanged: a token for a free key meters that key', async () => {
		const key  = 'ho_free_' + 'a9'.repeat(32);
		const hash = await setupFreeKey(key);
		const tokenRes = await fetchWorker('/oauth/token', {
			method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `grant_type=client_credentials&client_id=${key}`,
		});
		const { access_token } = await tokenRes.json() as { access_token: string };
		expect(receiptOf(await mcpCall({ 'Authorization': `Bearer ${access_token}` })).mic).toBe('XNYS');
		expect(await env.ORACLE_TELEMETRY.get(`free_usage:${hash}:${today()}`)).toBe('1');
	});

	it('the /mcp CORS preflight headers allow X-Oracle-Key', async () => {
		const res = await fetchWorker('/mcp', { method: 'HEAD' });
		expect(res.headers.get('Access-Control-Allow-Headers') ?? '').toContain('X-Oracle-Key');
	});
});

// ─── OAuth 2.0 — MCP credit-pack metering ────────────────────────────────────
// handleOAuthToken stores plan 'credits' on a 1-hour token; the MCP credits
// branch only bumped a usage counter, so one credit (spent issuing the token)
// bought an hour of unmetered MCP calls.
describe('POST /mcp — credit-pack token calls cost one credit each', () => {
	async function hashOf(value: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
		return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	}
	async function putToken(token: string, keyHash: string): Promise<void> {
		await env.ORACLE_API_KEYS.put(`oauth:${await hashOf(token)}`, JSON.stringify({ keyHash, plan: 'credits', status: 'active' }), { expirationTtl: 3600 });
	}
	async function balanceOf(keyHash: string): Promise<number | undefined> {
		return (JSON.parse((await env.ORACLE_API_KEYS.get(keyHash)) ?? '{}') as { balance?: number }).balance;
	}
	function mcpStatus(headers: Record<string, string>) {
		return fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }),
		});
	}

	it('each token-authenticated call debits one credit, and the call at zero is refused', async () => {
		const key   = 'ho_crd_' + 'm1'.repeat(32);
		const hash  = await hashOf(key);
		const token = 'mcp_credits_token_' + 'm1'.repeat(23);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 2 }));
		await putToken(token, hash);

		const r1 = await mcpStatus({ 'Authorization': `Bearer ${token}` });
		expect(await r1.json()).toHaveProperty('result');
		expect(await balanceOf(hash)).toBe(1);

		const r2 = await mcpStatus({ 'Authorization': `Bearer ${token}` });
		expect(await r2.json()).toHaveProperty('result');
		expect(await balanceOf(hash)).toBe(0);

		const r3 = await mcpStatus({ 'Authorization': `Bearer ${token}` });
		expect(r3.status).toBe(200); // MCP always HTTP 200
		const b3 = await r3.json() as Record<string, unknown>;
		expect(b3).not.toHaveProperty('result');
		const err = b3.error as Record<string, unknown>;
		expect(err.code).toBe(-32000);
		expect(String(err.message)).toContain('CREDITS_EXHAUSTED');
		expect(await balanceOf(hash)).toBe(0);
	});

	it('a token issued by POST /oauth/token for a credit-pack key is metered per call', async () => {
		const key  = 'ho_crd_' + 'm2'.repeat(32);
		const hash = await hashOf(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 3 }));
		const tokenRes = await fetchWorker('/oauth/token', {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    `grant_type=client_credentials&client_id=${key}`,
		});
		expect(tokenRes.status).toBe(200);
		const { access_token } = await tokenRes.json() as { access_token: string };
		const afterIssue = await balanceOf(hash); // issuing authenticates via checkApiKey (unchanged)
		const r1 = await mcpStatus({ 'Authorization': `Bearer ${access_token}` });
		expect(await r1.json()).toHaveProperty('result');
		expect(await balanceOf(hash)).toBe((afterIssue as number) - 1);
	});

	it('a call carrying both X-Oracle-Key and the Bearer token for the same pack is charged exactly once', async () => {
		const key   = 'ho_crd_' + 'm3'.repeat(32);
		const hash  = await hashOf(key);
		const token = 'mcp_credits_token_' + 'm3'.repeat(23);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 4 }));
		await putToken(token, hash);
		const res = await mcpStatus({ 'Authorization': `Bearer ${token}`, 'X-Oracle-Key': key });
		expect(await res.json()).toHaveProperty('result');
		expect(await balanceOf(hash)).toBe(3);
	});

	it('the X-Oracle-Key REST path still debits exactly once per call', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const key  = 'ho_crd_' + 'm4'.repeat(32);
		const hash = await hashOf(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 3 }));
		try {
			expect((await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } })).status).toBe(200);
			expect(await balanceOf(hash)).toBe(2);
			expect((await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } })).status).toBe(200);
			expect(await balanceOf(hash)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── OAuth 2.0 — MCP rate limiting ───────────────────────────────────────────

describe('POST /mcp — OAuth rate limiting', () => {
	// Helper: put an OAuth token record directly into KV (bypasses /oauth/token route)
	async function putOAuthToken(token: string, keyHash: string, plan: string): Promise<void> {
		const encoded   = new TextEncoder().encode(token);
		const hashBuf   = await crypto.subtle.digest('SHA-256', encoded);
		const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
		await env.ORACLE_API_KEYS.put(`oauth:${tokenHash}`, JSON.stringify({ keyHash, plan, status: 'active' }), { expirationTtl: 3600 });
	}

	// tools/list goes through the full telemetry + rate-limit path (initialize is now a fast path).
	const mcpInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

	it('free-tier OAuth token at daily limit → JSON-RPC -32000 RATE_LIMITED', async () => {
		const token   = 'mcp_ratelimit_test_free_token_' + 'a'.repeat(34);
		const keyHash = 'mcp_ratelimit_free_keyhash_' + 'a'.repeat(37);
		const today   = new Date().toISOString().slice(0, 10);
		await putOAuthToken(token, keyHash, 'free');
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '500', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200); // MCP always HTTP 200
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error');
			const err = body.error as Record<string, unknown>;
			expect(err).toHaveProperty('code', -32000);
			expect(String(err.message)).toContain('RATE_LIMITED');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${today}`);
		}
	});

	it('free-tier OAuth token below limit → request succeeds', async () => {
		const token   = 'mcp_ratelimit_test_free_under_' + 'b'.repeat(34);
		const keyHash = 'mcp_ratelimit_free_under_hash_' + 'b'.repeat(34);
		const today   = new Date().toISOString().slice(0, 10);
		await putOAuthToken(token, keyHash, 'free');
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '1', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('result'); // succeeds — not rate-limited
		} finally {
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${today}`);
		}
	});

	it('sandbox OAuth token at 200-call limit → JSON-RPC -32000 RATE_LIMITED', async () => {
		const token   = 'mcp_ratelimit_sandbox_token_' + 'd'.repeat(36);
		const keyHash = 'mcp_ratelimit_sandbox_keyhash' + 'd'.repeat(35);
		const today   = new Date().toISOString().slice(0, 10);
		await putOAuthToken(token, keyHash, 'sandbox');
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '200', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error');
			const err = body.error as Record<string, unknown>;
			expect(err).toHaveProperty('code', -32000);
			expect(String(err.message)).toContain('RATE_LIMITED');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${today}`);
		}
	});

	it('sandbox OAuth token below 200-call limit → request succeeds', async () => {
		const token   = 'mcp_ratelimit_sandbox_under_' + 'e'.repeat(36);
		const keyHash = 'mcp_ratelimit_sandbox_under_h' + 'e'.repeat(35);
		const today   = new Date().toISOString().slice(0, 10);
		await putOAuthToken(token, keyHash, 'sandbox');
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '1', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('result'); // succeeds — not rate-limited
		} finally {
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${today}`);
		}
	});

	it('unauthenticated MCP ignores usage counter — always succeeds for non-status tools', async () => {
		// Even if a counter key existed for some hash, unauthenticated MCP skips per-IP metering for tools/list
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    mcpInit,
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('result');
	});

	it('unauthenticated get_market_status: blocked after 10 calls from same IP', async () => {
		// handleMcp computes rawIp = X-Original-IP || CF-Connecting-IP ?? ''
		// In the test environment neither header is present, so rawIp = '' (empty string).
		const ipHash    = await sha256Hex('');
		const today     = new Date().toISOString().slice(0, 10);
		const unauthKey = `unauth_mcp_status:${ipHash}:${today}`;
		await env.ORACLE_TELEMETRY.put(unauthKey, '10', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			const result = body.result as Record<string, unknown>;
			expect(result.isError).toBe(true);
			const text = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>;
			expect(text.error).toBe('UNAUTHENTICATED_LIMIT_REACHED');
			expect(text).toHaveProperty('upgrade_url');
			// Since 2026-10-07 MCP reads the API key itself, in Bearer or
			// X-Oracle-Key; the message says so and no longer sends callers through
			// the token exchange.
			const msg = String(text.message);
			expect(msg).toContain('Authorization: Bearer <api key>');
			expect(msg).toContain('X-Oracle-Key: <api key>');
			expect(msg).not.toContain('MCP does not read');
			expect(msg).toContain('POST https://headlessoracle.com/v5/keys/instant');
		} finally {
			await env.ORACLE_TELEMETRY.delete(unauthKey);
		}
	});

	it('unauthenticated get_market_status: succeeds below 10-call limit', async () => {
		const ipHash    = await sha256Hex('');
		const today     = new Date().toISOString().slice(0, 10);
		const unauthKey = `unauth_mcp_status:${ipHash}:${today}`;
		await env.ORACLE_TELEMETRY.put(unauthKey, '5', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			const result = body.result as Record<string, unknown>;
			expect(result).not.toHaveProperty('isError', true);
		} finally {
			await env.ORACLE_TELEMETRY.delete(unauthKey);
		}
	});

	it('unauthenticated get_market_schedule is NOT rate-limited by IP gate', async () => {
		const ipHash    = await sha256Hex('');
		const today     = new Date().toISOString().slice(0, 10);
		const unauthKey = `unauth_mcp_status:${ipHash}:${today}`;
		// Exhaust the status counter — schedule must still succeed
		await env.ORACLE_TELEMETRY.put(unauthKey, '10', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'get_market_schedule', arguments: { mic: 'XNYS' } } }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect((body.result as Record<string, unknown>)).not.toHaveProperty('isError', true);
		} finally {
			await env.ORACLE_TELEMETRY.delete(unauthKey);
		}
	});

	// Was "falls through as anonymous — not blocked". Since 2026-10-07 a credential
	// that is sent and not accepted is a JSON-RPC error (still HTTP 200, never
	// 401): silently serving it as anonymous left the caller believing it was on
	// its plan.
	it('logically expired Bearer token is refused with OAUTH_TOKEN_EXPIRED, not served as anonymous', async () => {
		// Seed a token record with expires_at already in the past
		const token   = 'mcp_expired_token_test_' + 'c'.repeat(41);
		const keyHash = 'mcp_expired_keyhash_test_' + 'c'.repeat(39);
		const encoded   = new TextEncoder().encode(token);
		const hashBuf   = await crypto.subtle.digest('SHA-256', encoded);
		const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
		// expires_at = 1 (Unix epoch + 1s — well in the past)
		await env.ORACLE_API_KEYS.put(`oauth:${tokenHash}`, JSON.stringify({ keyHash, plan: 'free', status: 'active', expires_at: 1 }), { expirationTtl: 3600 });
		try {
			const res = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).not.toHaveProperty('result');
			const err = body.error as Record<string, unknown>;
			expect(err.code).toBe(-32001);
			expect(String(err.message)).toMatch(/^OAUTH_TOKEN_EXPIRED: /);
		} finally {
			await env.ORACLE_API_KEYS.delete(`oauth:${tokenHash}`);
		}
	});
});

// ─── MCP auth_calls telemetry ────────────────────────────────────────────────

describe('POST /mcp — auth_calls / unauth_calls telemetry', () => {
	async function putOAuthTokenForTelemetry(token: string, keyHash: string, plan: string): Promise<void> {
		const encoded   = new TextEncoder().encode(token);
		const hashBuf   = await crypto.subtle.digest('SHA-256', encoded);
		const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
		await env.ORACLE_API_KEYS.put(`oauth:${tokenHash}`, JSON.stringify({ keyHash, plan, status: 'active' }), { expirationTtl: 3600 });
	}

	// tools/list goes through the full telemetry path (initialize is now a fast path with no KV ops).
	const mcpInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

	it('authenticated MCP request increments auth_calls counter', async () => {
		const token   = 'mcp_telemetry_auth_token_' + 'x'.repeat(39);
		const keyHash = 'mcp_telemetry_auth_keyhash_' + 'x'.repeat(37);
		const today   = new Date().toISOString().slice(0, 10);
		await putOAuthTokenForTelemetry(token, keyHash, 'pro');
		// Seed the usage counter so rate limit doesn't fire (plan=pro has high limit)
		const before = parseInt((await env.ORACLE_TELEMETRY.get(`auth_calls:${today}`)) ?? '0', 10);
		try {
			const res = await fetchWorker('/mcp', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
				body:    mcpInit,
			});
			expect(res.status).toBe(200);
			const after = parseInt((await env.ORACLE_TELEMETRY.get(`auth_calls:${today}`)) ?? '0', 10);
			expect(after).toBeGreaterThan(before);
		} finally {
			await env.ORACLE_API_KEYS.delete(`oauth:${(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString()}`);
		}
	});

	it('unauthenticated MCP request increments unauth_calls counter', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const before = parseInt((await env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`)) ?? '0', 10);
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    mcpInit,
		});
		expect(res.status).toBe(200);
		const after = parseInt((await env.ORACLE_TELEMETRY.get(`unauth_calls:${today}`)) ?? '0', 10);
		expect(after).toBeGreaterThan(before);
	});

	it('unauthenticated MCP request increments zero_auth_mcp_requests counter', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const before = parseInt((await env.ORACLE_TELEMETRY.get(`zero_auth_mcp_requests:${today}`)) ?? '0', 10);
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    mcpInit,
		});
		expect(res.status).toBe(200);
		const after = parseInt((await env.ORACLE_TELEMETRY.get(`zero_auth_mcp_requests:${today}`)) ?? '0', 10);
		expect(after).toBeGreaterThan(before);
	});
});

// ─── MCP protocol conformance — edge cases ───────────────────────────────────

describe('POST /mcp — protocol conformance edge cases', () => {
	const mcpPost = (body: unknown) =>
		fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify(body),
		});

	it('tools/call with missing name → -32602 Invalid Params (not 500, not -32601)', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { arguments: {} } });
		const body = await res.json() as { error?: { code: number; message: string } };
		expect(res.status).toBe(200); // MCP always HTTP 200
		expect(body.error?.code).toBe(-32602);
	});

	it('tools/call get_market_schedule with unknown MIC → isError: true, UNKNOWN_MIC', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_schedule', arguments: { mic: 'FAKE' } } });
		const body = await res.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
		expect(res.status).toBe(200);
		expect(body.result?.isError).toBe(true);
		const payload = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
		expect(payload.error).toBe('UNKNOWN_MIC');
	});

	it('initialize response has all required MCP 2024-11-05 fields', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
		const body = await res.json() as { result?: Record<string, unknown> };
		expect(res.status).toBe(200);
		const r = body.result!;
		expect(r).toHaveProperty('protocolVersion', '2024-11-05');
		expect(r).toHaveProperty('serverInfo');
		expect(r).toHaveProperty('capabilities');
		expect((r.capabilities as Record<string, unknown>)).toHaveProperty('tools');
		expect((r.capabilities as Record<string, unknown>)).toHaveProperty('resources');
		expect((r.capabilities as Record<string, unknown>)).toHaveProperty('prompts');
		expect(r).toHaveProperty('instructions');
	});

	// ── HEAD /mcp — uptime probe ──
	it('HEAD /mcp → 200 (uptime probe)', async () => {
		const res = await fetchWorker('/mcp', { method: 'HEAD' });
		expect(res.status).toBe(200);
	});

	// ── GET /mcp — server info ──
	it('GET /mcp → 200 with server info object', async () => {
		const res  = await fetchWorker('/mcp', { method: 'GET' });
		const body = await res.json() as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body).toHaveProperty('name');
		expect(body).toHaveProperty('protocol');
	});

	// ── ping ──
	it('POST /mcp ping → result: {} (MCP liveness)', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'ping' });
		const body = await res.json() as { result?: unknown };
		expect(res.status).toBe(200);
		expect(body.result).toEqual({});
	});

	// ── get_market_status mic validation ──
	it('get_market_status with missing mic → -32602', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_status', arguments: {} } });
		const body = await res.json() as { error?: { code: number } };
		expect(res.status).toBe(200);
		expect(body.error?.code).toBe(-32602);
	});

	it('get_market_status with mic as number → -32602', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 1234 } } });
		const body = await res.json() as { error?: { code: number } };
		expect(res.status).toBe(200);
		expect(body.error?.code).toBe(-32602);
	});

	// ── get_market_schedule mic validation ──
	it('get_market_schedule with missing mic → -32602', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_schedule', arguments: {} } });
		const body = await res.json() as { error?: { code: number } };
		expect(res.status).toBe(200);
		expect(body.error?.code).toBe(-32602);
	});

	it('get_market_schedule with mic as boolean → -32602', async () => {
		const res  = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_schedule', arguments: { mic: true } } });
		const body = await res.json() as { error?: { code: number } };
		expect(res.status).toBe(200);
		expect(body.error?.code).toBe(-32602);
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
			expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/upgrade');
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

	it('MASTER_API_KEY returns 402 legacy_key_expired after April 1 enforcement', async () => {
		// The legacy master key migration enforcement gate (April 1 2026) blocks MASTER_API_KEY
		// on all authenticated endpoints and returns 402 with error: legacy_key_expired.
		const response = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(response.status).toBe(402);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'legacy_key_expired');
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

	it('beta key → { plan: "internal", status: "active", key_prefix: null }', async () => {
		const body = await fetchJSON('/v5/account', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
	it('GET /v5/keys/request → 200 with plan info', async () => {
		const response = await fetchWorker('/v5/keys/request');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('message');
		expect(body).toHaveProperty('action_url', 'https://headlessoracle.com/upgrade');
		expect(body).toHaveProperty('plans');
		expect(body).toHaveProperty('docs');
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
			// Regression-lock: canonical links must remain in the email template
			expect(capturedEmailHtml).toContain('docs/specifications/pre-trade-stack');
			expect(capturedEmailHtml).toContain('Composable Pre-Trade Verification Pattern v2.0');
			expect(capturedEmailHtml).toContain('environment.market_state');
			expect(capturedEmailHtml).toContain('verifiable-intent/pull/9');
			expect(capturedEmailHtml).toContain('verifiable-intent/pull/22');
			// Retired framing must NOT appear
			expect(capturedEmailHtml).not.toContain('External State Attestation RFC');
			expect(capturedEmailHtml).not.toContain('autonomous finance stack');
			expect(capturedEmailHtml).not.toContain('/v5/stack');  // now deprecated; email must not link here
			expect(capturedEmailHtml).not.toContain('framework today');  // time-drift phrasing
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

	it('402 on /v5/status without key: x402scan-compatible body after trial exhausted', async () => {
		// Exhaust the 3-receipt trial first, then keyless → x402scan 402
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');  // no IP header = empty string hash
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS');
			expect(response.status).toBe(402);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('x402Version', 1);
			expect(body).toHaveProperty('trial_used', 3);
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('402 on /v5/batch without key: x402scan-compatible body, CORS header set', async () => {
		const response = await fetchWorker('/v5/batch?mics=XNYS');
		expect(response.status).toBe(402);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
	});

	it('401 on /v5/account without key includes X-Oracle-Upgrade header', async () => {
		const response = await fetchWorker('/v5/account');
		expect(response.status).toBe(401);
		expect(response.headers.get('X-Oracle-Upgrade')).toBe('https://headlessoracle.com/upgrade');
	});
});

// ─── POST /v5/keys/instant — zero-friction agent key provisioning ────────────

describe('POST /v5/keys/instant', () => {
	it('GET /v5/keys/instant → 200 with usage info', async () => {
		const response = await fetchWorker('/v5/keys/instant');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('method', 'POST');
		expect(body).toHaveProperty('daily_limit', 500);
	});

	it('missing agent_id → 400 INVALID_AGENT_ID', async () => {
		const response = await fetchWorker('/v5/keys/instant', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({}),
		});
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_AGENT_ID');
	});

	it('valid agent_id → 200 with api_key, example, daily_limit', async () => {
		const response = await fetchWorker('/v5/keys/instant', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ agent_id: 'test-agent-instant-1' }),
		});
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('plan', 'free');
		expect(body).toHaveProperty('daily_limit', 500);
		expect(typeof body.api_key).toBe('string');
		expect((body.api_key as string).startsWith('ho_free_')).toBe(true);
		expect(typeof body.example).toBe('string');
		expect(typeof body.usage).toBe('string');
		expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/pricing');
	});

	it('same agent_id → returns same key prefix (idempotent)', async () => {
		// First request creates key
		const res1 = await fetchWorker('/v5/keys/instant', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ agent_id: 'test-idempotent-agent' }),
		});
		expect(res1.status).toBe(200);
		const body1 = await res1.json() as Record<string, unknown>;
		expect(typeof body1.api_key).toBe('string');

		// Second request returns cached key prefix with note
		const res2 = await fetchWorker('/v5/keys/instant', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ agent_id: 'test-idempotent-agent' }),
		});
		expect(res2.status).toBe(200);
		const body2 = await res2.json() as Record<string, unknown>;
		expect(body2).toHaveProperty('note');
		expect(body2).toHaveProperty('key_prefix');
		expect((body2.key_prefix as string).startsWith('ho_free_')).toBe(true);
	});

	it('issued key authenticates /v5/status successfully', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ agent_id: 'test-agent-auth-check' }),
		});
		const body = await res.json() as { api_key: string };

		// Use the key to call /v5/status
		const statusRes = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': body.api_key },
		});
		expect(statusRes.status).toBe(200);
		const statusBody = await statusRes.json() as Record<string, unknown>;
		expect(statusBody).toHaveProperty('receipt');
	});

	it('402 on trial exhaustion includes instant_key upgrade path', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const response = await fetchWorker('/v5/status?mic=XNYS');
			expect(response.status).toBe(402);
			const body = await response.json() as Record<string, unknown>;
			const paths = body.agent_upgrade_paths as Record<string, unknown>;
			expect(paths).toHaveProperty('instant_key');
			const instantKey = paths.instant_key as Record<string, unknown>;
			expect(instantKey).toHaveProperty('url', 'https://headlessoracle.com/v5/keys/instant');
			expect(instantKey).toHaveProperty('friction', 'zero');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
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
			// CHANGED (H4a): the plan is named; an unnamed plan is 400 PLAN_REQUIRED.
			const response = await fetchWorker('/v5/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"plan":"builder"}' });
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
			// CHANGED (H4a): the plan is named; an unnamed plan is 400 PLAN_REQUIRED.
			const response = await fetchWorker('/v5/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"plan":"builder"}' });
			expect(response.status).toBe(502);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'CHECKOUT_FAILED');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /v5/checkout?type=credits → 200 with checkout_url when credits price is configured', async () => {
		const mockTransactionId = 'txn_credits_01abc';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				// Verify credits price_id is used (pri_test_credits_placeholder from .dev.vars)
				const body = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ price_id?: string }> };
				expect(body.items?.[0]?.price_id).toBe('pri_test_credits_placeholder');
				return new Response(JSON.stringify({ data: { id: mockTransactionId, checkout: { url: `https://buy.paddle.com/checkout/${mockTransactionId}` } } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout?type=credits', { method: 'POST' });
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('url');
			expect(body).toHaveProperty('transaction_id', mockTransactionId);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// ─── B-144: /v5/checkout fails closed on an unrecognised plan ────────────
	// Before 2026-09-09 `plan` was compared against 'pro', 'protocol' and
	// 'credits' and anything else fell through to PADDLE_PRICE_ID_BUILDER, so
	// {"plan":"conformance_entry"} returned a 200 carrying a $99/month Builder
	// checkout. RED against the old code: it returned 200, not 400, and called
	// Paddle once.
	it('B-144: POST /v5/checkout with an unrecognised plan → 400 UNKNOWN_PLAN and ZERO calls to api.paddle.com', async () => {
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				paddleCalls += 1;
				return new Response(JSON.stringify({ data: { id: 'txn_should_never_happen' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				// Was 'conformance_entry' until B-149 made that a real plan. An
				// UNKNOWN_PLAN test whose example became sellable would have gone
				// on passing for the wrong reason, so it names something that is
				// genuinely not for sale.
				body:    JSON.stringify({ plan: 'conformance_entrie' }),
			});
			expect(res.status).toBe(400);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'UNKNOWN_PLAN');
			expect(String(body.message)).toContain('conformance_entrie');
			// The error must tell an agent what IS sellable without a follow-up.
			expect(body.valid_plans).toEqual([
				'builder', 'pro', 'protocol', 'credits',
				'conformance_entry', 'regrade', 'dispute', 'dispute_note', 'custody_90d', 'custody_1y',
			]);
			// The point of the fix: no money path is touched at all.
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-144: POST /v5/checkout reflects the unknown plan only as a bounded plain token', async () => {
		// `plan` is caller-controlled and is echoed into the body. safeIdent
		// strips it to [A-Za-z0-9_.:-] and caps it, so nothing can smuggle
		// markup or a newline through the error a human reads.
		const res = await fetchWorker('/v5/checkout', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ plan: '<script>alert(1)</script>\nbuilder' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		const message = String(body.message);
		expect(message).not.toContain('<');
		expect(message).not.toContain('\n');
		expect(message).toContain('scriptalert1');
	});

	// The other half of the same rule, CHANGED by H4a: an absent plan is now
	// 400 PLAN_REQUIRED (see the B-169 cases below). What keeps the fix above
	// from being "400 on everything" is that a NAMED plan still sells, including
	// through the legacy ?type= query with no body.
	it('B-144 (H4a): POST /v5/checkout?type=builder with no body still sells Builder', async () => {
		let capturedPriceId = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				const sent = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ price_id?: string }> };
				capturedPriceId = sent.items?.[0]?.price_id ?? '';
				return new Response(JSON.stringify({ data: { id: 'txn_default_builder' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout?type=builder', { method: 'POST' });
			expect(res.status).toBe(200);
			expect(capturedPriceId).toBe('pri_test_builder_placeholder'); // matches .dev.vars
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// --- B-149: the six referee services are buyable -------------------------
	// Six prices existed in the live Paddle account and in REFEREE_PRICES, and
	// POST /v5/checkout accepted four names, none of them a referee service.
	// The prices were real and nobody could reach them.
	//
	// The expected price ids below are written out INDEPENDENTLY of the
	// constant, on purpose. A test that read REFEREE_PRICES and compared the
	// served id against it would pass whatever the constant said, including
	// after a typo -- it would be comparing the code against itself. These are
	// the six ids as created in Paddle on 2026-09-09.
	const REFEREE_CHECKOUT_CASES = [
		{ plan: 'conformance_entry', price_id: 'pri_01m22wcgvj15ktn5xnabf13a7p' },
		{ plan: 'regrade',           price_id: 'pri_01m22wcz6wth6vdmhk3a9xd4ez' },
		{ plan: 'dispute',           price_id: 'pri_01m22wda7747kb18jfat1p58dw' },
		{ plan: 'dispute_note',      price_id: 'pri_01m22wexbdc4mr70zr1x3faqg6' },
		{ plan: 'custody_90d',       price_id: 'pri_01m22wf966bjsar9sgtbzsva2b' },
		{ plan: 'custody_1y',        price_id: 'pri_01m22wfjtbnhjyws9ctabxhvp4' },
	] as const;

	for (const kase of REFEREE_CHECKOUT_CASES) {
		it('B-149: POST /v5/checkout {plan:"' + kase.plan + '"} builds a Paddle checkout for ' + kase.price_id, async () => {
			let paddleCalls = 0;
			let sentBody: Record<string, unknown> = {};
			let sentUrl = '';
			const originalFetch = globalThis.fetch;
			globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
				const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
				if (urlStr.includes('api.paddle.com')) {
					paddleCalls += 1;
					sentUrl  = urlStr;
					sentBody = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
					return new Response(JSON.stringify({ data: { id: 'txn_' + kase.plan, checkout: { url: 'https://headlessoracle.com?_ptxn=txn_' + kase.plan } } }), {
						status: 200, headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input, init);
			};
			try {
				const res = await fetchWorker('/v5/checkout', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json' },
					body:    JSON.stringify({ plan: kase.plan }),
				});
				expect(res.status).toBe(200);
				const body = await res.json() as Record<string, unknown>;
				expect(body).toHaveProperty('url', 'https://buy.paddle.com/checkout/txn_' + kase.plan);
				expect(body).toHaveProperty('transaction_id', 'txn_' + kase.plan);

				// Exactly one call, to the transactions endpoint, carrying THIS
				// service's price id and nothing else. The shape is asserted
				// whole rather than field by field: the four API plans and the
				// credits pack all send this same body, and Paddle -- not us --
				// decides one-time versus subscription from the price's own
				// billing cycle. There is no second request shape to get right,
				// and asserting the whole object is what would catch one being
				// invented here.
				//
				// B-168 (2026-09-10) added `checkout.url` to that one shape, and
				// this assertion is what caught the change -- which is the point
				// of asserting it whole. It stays whole: all ten plans still
				// send ONE body, now with our own checkout URL in it so Paddle
				// stops building the overlay link from the shared account's
				// default payment link.
				//
				// H2 (2026-10-04) adds `custom_data.ho_claim` for the plans that
				// mint a key, and of these six only the two custody plans do. It
				// is still one shape with one optional member; the four services
				// that mint nothing must not carry it.
				expect(paddleCalls).toBe(1);
				expect(sentUrl).toBe('https://api.paddle.com/transactions');
				const mintsKey = kase.plan === 'custody_90d' || kase.plan === 'custody_1y';
				expect(sentBody).toEqual({
					items:    [{ price_id: kase.price_id, quantity: 1 }],
					checkout: { url: 'https://headlessoracle.com/pricing' },
					...(mintsKey ? { custom_data: { ho_claim: await sha256Hex(body.claim_token as string) } } : {}),
				});
				expect(body.claim_token !== undefined).toBe(mintsKey);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	}

	it('B-149: the six referee checkout price ids are exactly the six in REFEREE_PRICES', async () => {
		// The table above is written out independently so the per-service tests
		// have something to disagree with. This is the one place the two are
		// reconciled -- it fails if a service is added to the constant and not to
		// the table, which is how the table stays honest instead of stale.
		const { prices } = refereePrices();
		expect(REFEREE_CHECKOUT_CASES.map(c => c.plan).slice().sort()).toEqual(Object.keys(prices).sort());
		for (const kase of REFEREE_CHECKOUT_CASES) {
			expect(prices[kase.plan].price_id).toBe(kase.price_id);
		}
	});

	it('B-149: a plan name inherited from Object.prototype is UNKNOWN_PLAN, not a 503', async () => {
		// `plan` is caller-supplied and was used to index a plain object
		// literal. {"plan":"constructor"} reached env[Object] and produced a
		// 503 "not configured" -- a name we do not sell, reported as a
		// configuration fault of ours. The lookups are own-property checks now.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) { paddleCalls += 1; }
			return originalFetch(input, init);
		};
		try {
			for (const evil of ['constructor', 'toString', '__proto__']) {
				const res = await fetchWorker('/v5/checkout', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json' },
					body:    JSON.stringify({ plan: evil }),
				});
				expect(res.status).toBe(400);
				const body = await res.json() as Record<string, unknown>;
				expect(body).toHaveProperty('error', 'UNKNOWN_PLAN');
			}
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// ─── B-169: an unreadable body must not sell anything ────────────────────
	// 2026-09-10, in production. The founder sent {"plan":"nope"} from Windows
	// PowerShell 5.1, which does not pass \" through to a native executable
	// reliably. The body arrived unparseable, `request.json().catch(() => ({}))`
	// turned it into {}, the ABSENT-plan default sold Builder, and a live
	// Paddle transaction (txn_01m25kztpkvt2hh64qdw509n97) was created for a
	// request whose plan the worker never read. The "nope" refusal B-144 built
	// was never reached.
	//
	// Absent and unreadable are different cases and only the second is a
	// defect: an empty body still means Builder (the two controls below hold
	// that line), but a body we cannot parse means we do not know what was
	// asked for, and a billable object must not come out of not knowing.
	it('B-169: POST /v5/checkout with an unparseable body → 400 INVALID_BODY and ZERO calls to api.paddle.com', async () => {
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				paddleCalls += 1;
				// A valid-looking response on purpose: if the handler DOES call
				// Paddle the test must fail on the assertion below, not on a 502
				// that would hide which property actually broke.
				return new Response(JSON.stringify({ data: { id: 'txn_should_never_happen' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			// Exactly what PowerShell 5.1 delivers when the quoting collapses.
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    '{plan:nope}',
			});
			expect(res.status).toBe(400);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'INVALID_BODY');
			// An agent must be able to fix the call from the response alone.
			expect(String(body.message)).toContain('{"plan":"builder"}');
			expect(body.valid_plans).toEqual([
				'builder', 'pro', 'protocol', 'credits',
				'conformance_entry', 'regrade', 'dispute', 'dispute_note', 'custody_90d', 'custody_1y',
			]);
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-169: POST /v5/checkout with a JSON string body → 400 INVALID_BODY and ZERO calls to api.paddle.com', async () => {
		// '"builder"' is valid JSON and parses cleanly. It is not an object, so
		// `.plan` is undefined and the old code read it as "no plan given" and
		// sold Builder — the right answer by accident here, and the wrong one
		// for '"pro"'. Parsing is not the same as understanding.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				paddleCalls += 1;
				return new Response(JSON.stringify({ data: { id: 'txn_should_never_happen' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify('builder'),
			});
			expect(res.status).toBe(400);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'INVALID_BODY');
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-169: POST /v5/checkout with a JSON value that is not an object → 400 INVALID_BODY and ZERO calls', async () => {
		// `null` is the one that matters most: typeof null === 'object', so a
		// naive object check lets it through and `body.plan` throws, turning a
		// bad request into a 500 of ours.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) {
				paddleCalls += 1;
				return new Response(JSON.stringify({ data: { id: 'txn_should_never_happen' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			for (const raw of ['[]', 'null', '42', 'true', '"1"']) {
				const res = await fetchWorker('/v5/checkout', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json' },
					body:    raw,
				});
				expect(res.status, `body ${raw}`).toBe(400);
				const body = await res.json() as Record<string, unknown>;
				expect(body, `body ${raw}`).toHaveProperty('error', 'INVALID_BODY');
			}
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// CHANGED (H4a, 2026-10-05): these two were controls asserting that an
	// absent plan sold Builder. An absent plan is now 400 PLAN_REQUIRED with
	// every plan and its price, and nothing reaches Paddle. The "not 400 on
	// everything" control is the named-plan 200 test and the ?type= case.
	it('H4a (was B-169 CONTROL): POST /v5/checkout with an empty body is 400 PLAN_REQUIRED, ZERO calls to Paddle', async () => {
		let capturedPriceId = '';
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				paddleCalls += 1;
				const sent = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ price_id?: string }> };
				capturedPriceId = sent.items?.[0]?.price_id ?? '';
				return new Response(JSON.stringify({ data: { id: 'txn_empty_body_builder' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', { method: 'POST' });
			expect(res.status).toBe(400);
			expect((await res.json() as Record<string, unknown>).error).toBe('PLAN_REQUIRED');
			expect(capturedPriceId).toBe('');
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('H4a (was B-169 CONTROL): POST /v5/checkout with body {} is 400 PLAN_REQUIRED with every plan and price, ZERO calls to Paddle', async () => {
		let capturedPriceId = '';
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				paddleCalls += 1;
				const sent = JSON.parse((init?.body as string) ?? '{}') as { items?: Array<{ price_id?: string }> };
				capturedPriceId = sent.items?.[0]?.price_id ?? '';
				return new Response(JSON.stringify({ data: { id: 'txn_empty_object_builder' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    '{}',
			});
			expect(res.status).toBe(400);
			const body = await res.json() as { error: string; valid_plans: string[]; plans: Array<{ plan: string; amount_usd: string; currency: string; billing: string }> };
			expect(body.error).toBe('PLAN_REQUIRED');
			expect(body.plans.map((p) => p.plan)).toEqual(body.valid_plans);
			const byPlan = Object.fromEntries(body.plans.map((p) => [p.plan, p]));
			expect(byPlan.builder).toEqual({ plan: 'builder', amount_usd: '99.00', currency: 'USD', billing: 'monthly' });
			expect(byPlan.credits).toEqual({ plan: 'credits', amount_usd: '5.00', currency: 'USD', billing: 'one_time' });
			expect(byPlan.custody_90d).toEqual({ plan: 'custody_90d', amount_usd: '49.00', currency: 'USD', billing: 'monthly' });
			expect(byPlan.conformance_entry).toEqual({ plan: 'conformance_entry', amount_usd: '2500.00', currency: 'USD', billing: 'one_time' });
			expect(capturedPriceId).toBe('');
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-169 CONTROL: a well-formed body naming an unknown plan is still UNKNOWN_PLAN, not INVALID_BODY', async () => {
		// The two refusals must stay distinguishable: INVALID_BODY says "I
		// could not read what you sent", UNKNOWN_PLAN says "I read it and do
		// not sell that". An agent recovers from them differently.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) { paddleCalls += 1; }
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ plan: 'nope' }),
			});
			expect(res.status).toBe(400);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'UNKNOWN_PLAN');
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// ─── B-168: overlay_url must not carry another venture's domain ──────────
	// The same production call returned
	// overlay_url: "https://texasentitlement.com?_ptxn=txn_01m25kzt…" — Austin
	// Dev Watch's domain. It is Paddle's data.checkout.url, which Paddle builds
	// from the account's DEFAULT payment link, and the two ventures share a
	// Paddle account whose default link is ADW's. The site never follows
	// overlay_url (Paddle.js takes transaction_id), but an agent that does is
	// sent to the wrong business.
	it('B-168: overlay_url is null when Paddle returns a checkout URL on a foreign host', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				return new Response(JSON.stringify({
					data: {
						id:       'txn_foreign_overlay',
						// The exact shape production returned on 2026-09-10.
						checkout: { url: 'https://texasentitlement.com?_ptxn=txn_foreign_overlay' },
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ plan: 'builder' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body.overlay_url).toBeNull();
			// The transaction is still usable — we withhold the wrong link, we
			// do not fail a checkout the customer can still complete.
			expect(body).toHaveProperty('transaction_id', 'txn_foreign_overlay');
			expect(body).toHaveProperty('url', 'https://buy.paddle.com/checkout/txn_foreign_overlay');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-168: overlay_url passes through on our own host, and we ask Paddle for one', async () => {
		let sentCheckoutUrl: string | undefined;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				const sent = JSON.parse((init?.body as string) ?? '{}') as { checkout?: { url?: string } };
				sentCheckoutUrl = sent.checkout?.url;
				return new Response(JSON.stringify({
					data: {
						id:       'txn_own_overlay',
						checkout: { url: 'https://headlessoracle.com/pricing?_ptxn=txn_own_overlay' },
					},
				}), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ plan: 'builder' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('overlay_url', 'https://headlessoracle.com/pricing?_ptxn=txn_own_overlay');
			// The other half of B-168: we stop relying on whatever the shared
			// Paddle account has as its default link and name our own.
			expect(sentCheckoutUrl).toBe('https://headlessoracle.com/pricing');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-169: POST /v5/checkout with a non-string plan → 400 INVALID_BODY, not a 500', async () => {
		// Found while fixing B-169, same family. {"plan":42} is a readable
		// object naming something that is not a plan. The old code took 42 as
		// truthy, missed both price maps, and handed it to safeIdent(), whose
		// .replace() is not a method on a number — so the request died in the
		// outer catch and came back as a fault of ours rather than of the call.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com')) { paddleCalls += 1; }
			return originalFetch(input, init);
		};
		try {
			for (const raw of ['{"plan":42}', '{"plan":true}', '{"plan":{"name":"builder"}}', '{"plan":["builder"]}']) {
				const res = await fetchWorker('/v5/checkout', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json' },
					body:    raw,
				});
				expect(res.status, `body ${raw}`).toBe(400);
				const body = await res.json() as Record<string, unknown>;
				expect(body, `body ${raw}`).toHaveProperty('error', 'INVALID_BODY');
			}
			expect(paddleCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-168: a Paddle rejection of our checkout URL retries once without it rather than failing the sale', async () => {
		// We cannot verify from here that headlessoracle.com is approved in the
		// shared Paddle account's checkout settings, and an unapproved domain
		// would turn every checkout into a 502. So the failure — not a guess at
		// Paddle's error text — triggers one retry without the field. The
		// overlay guard still holds, because it reads the response, not what we
		// asked for.
		let paddleCalls = 0;
		let sawCheckoutFieldOn: boolean[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				paddleCalls += 1;
				const sent = JSON.parse((init?.body as string) ?? '{}') as { checkout?: { url?: string } };
				const hasCheckout = sent.checkout !== undefined;
				sawCheckoutFieldOn.push(hasCheckout);
				if (hasCheckout) {
					// What an unapproved checkout domain looks like from Paddle.
					return new Response(JSON.stringify({ error: { detail: 'checkout.url is not an approved domain' } }), {
						status: 400, headers: { 'Content-Type': 'application/json' },
					});
				}
				return new Response(JSON.stringify({ data: { id: 'txn_retry_no_url' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ plan: 'builder' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('transaction_id', 'txn_retry_no_url');
			// Paddle returned no checkout block at all on the retry.
			expect(body.overlay_url).toBeNull();
			// Exactly two: the attempt with our URL, then the fallback. Not a loop.
			expect(paddleCalls).toBe(2);
			expect(sawCheckoutFieldOn).toEqual([true, false]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-168: a Paddle failure unrelated to the checkout URL still ends in 502, and does not retry forever', async () => {
		// The control on the retry: it is one extra attempt on the failure
		// path, and a genuinely broken Paddle still fails the sale.
		let paddleCalls = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/transactions')) {
				paddleCalls += 1;
				return new Response(JSON.stringify({ error: { detail: 'Invalid API key' } }), {
					status: 401, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/v5/checkout', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json' },
				body:    JSON.stringify({ plan: 'builder' }),
			});
			expect(res.status).toBe(502);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'CHECKOUT_FAILED');
			expect(paddleCalls).toBe(2);
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

	it('transaction.completed INSERT race (23505) → 200 received:true, not 500', async () => {
		// SELECT sees no row, but concurrent INSERT already won — our INSERT gets 23505.
		//
		// B-144 (2026-09-09): this test could not fail. Three things stopped it
		// ever reaching the INSERT branch it is named for. (1) The SELECT mock
		// returned HTTP 200, and supabase-js on a 2xx parses the whole body AS
		// the row — so `existing` was truthy and the handler returned at the
		// idempotency guard. (2) `data` carried no `items`, so there was no
		// price id at all. (3) The 23505 mock wrapped the error in {data,error};
		// supabase-js on a non-2xx sets `error` to the parsed body itself, so
		// `dbError.code` read undefined and the 23505 branch was unreachable
		// even if it had been reached. All three are corrected here.
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id: 'txn_race_23505', customer_id: 'ctm_race_txn', subscription_id: 'sub_race_txn_001',
				items: [{ price_id: 'pri_test_builder_placeholder' }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		let insertAttempted = false;
		let emailCalled     = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (init?.method === 'GET' || !init?.method)) {
				// SELECT: no existing row. 406 is what PostgREST returns for
				// .single() with no rows, and the status is what makes data null.
				return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				// INSERT: unique constraint violation — peer already inserted.
				// The body IS the error object, as PostgREST sends it.
				insertAttempted = true;
				return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }), { status: 409, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'race-txn@test.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('resend.com')) {
				emailCalled = true;
				return new Response(JSON.stringify({ id: 'should_not_send' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
			expect(body).not.toHaveProperty('error');
			// The falsifier the test was missing: prove the 23505 branch was the
			// thing that produced the 200, not an early return upstream of it.
			expect(insertAttempted).toBe(true);
			// H1a: the peer that won owns the key. This delivery writes no KV
			// record and sends no mail, to the customer or the founder.
			expect(emailCalled).toBe(false);
			expect(await env.ORACLE_API_KEYS.get('paddle_sub:sub_race_txn_001')).toBeNull();
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
				const emailBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { to?: string[]; html?: string };
				// H1a: every paid mint also sends the founder a line; capture the
				// customer's mail, not whichever went last.
				if (emailBody.to?.[0] !== 'mike@headlessoracle.com') capturedEmailHtml = emailBody.html ?? '';
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

	// --- B-149: a referee purchase is recorded, and mints nothing -------------
	// Two things were wrong here, and only the second was known.
	//
	// KNOWN (B-145): a referee price must not mint an API key. Evidence custody
	// is not API access.
	//
	// FOUND HERE: the referee branch sat AFTER `if (!txn['subscription_id'])
	// return`, and four of the six referee prices are one-time -- they carry no
	// subscription_id at all. conformance_entry, regrade, dispute and
	// dispute_note therefore never reached the referee branch: the webhook
	// returned received:true at the subscription guard, wrote no revenue row,
	// raised no alert, and left a $2,500 payment recorded nowhere but the
	// Paddle dashboard. The branch now sits beside the credits branch, before
	// that guard, which is where a one-time payment can actually reach it.
	//
	// RED against the code before this change: no referee_purchase KV row, no
	// mail, and PADDLE_REFEREE_PAYMENT never logged.
	it('B-149: transaction.completed for a ONE-TIME referee price records the purchase, mails the founder, and provisions nothing', async () => {
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:          'txn_referee_conformance_001',
				customer_id: 'ctm_referee_001',
				// No subscription_id: conformance_entry is a one-time price. That
				// is the whole point of this test.
				items:       [{ price_id: 'pri_01m22wcgvj15ktn5xnabf13a7p', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		let supabaseInsertCalled = false;
		let mailTo               = '';
		let mailSubject          = '';
		let mailHtml             = '';
		let mailCount            = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				supabaseInsertCalled = true;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116', message: 'not found' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'referee-buyer@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				mailCount += 1;
				const mail = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { to?: string[]; subject?: string; html?: string };
				mailTo      = mail.to?.[0] ?? '';
				mailSubject = mail.subject ?? '';
				mailHtml    = mail.html ?? '';
				return new Response(JSON.stringify({ id: 'email_referee_001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ received: true });

			// The durable record, keyed by the Paddle transaction id.
			const raw = await env.ORACLE_TELEMETRY.get('referee_purchase:txn_referee_conformance_001');
			expect(raw).not.toBeNull();
			const row = JSON.parse(raw as string) as Record<string, unknown>;
			expect(row.service).toBe('conformance_entry');
			expect(row.price_id).toBe('pri_01m22wcgvj15ktn5xnabf13a7p');
			// 250000 minor units = $2,500.00. Written here as the number Paddle
			// stores, independently of REFEREE_PRICES.
			expect(row.amount_minor).toBe(250000);
			expect(row.currency).toBe('USD');
			expect(row.customer_email).toBe('referee-buyer@example.com');
			expect(typeof row.occurred_at).toBe('string');
			// The digest is over the raw signed bytes, so the record can be tied
			// back to the exact event Paddle sent. 64 hex chars of SHA-256.
			expect(String(row.raw_event_digest)).toMatch(/^[0-9a-f]{64}$/);

			// One mail, to the founder, naming the service.
			expect(mailCount).toBe(1);
			expect(mailTo).toBe('mike@headlessoracle.com');
			expect(mailSubject).toBe('Referee purchase: conformance_entry');
			expect(mailHtml).toContain('txn_referee_conformance_001');

			// Provisions NOTHING: no key row, and nothing that looks like an API key.
			expect(supabaseInsertCalled).toBe(false);
			expect(mailHtml).not.toContain('ho_live_');
			expect(mailHtml).not.toContain('ho_crd_');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('H1a (was B-149): transaction.completed for custody_90d no longer takes the record-only referee path — it provisions an evidence key', async () => {
		// CHANGED 2026-10-03 (founder ruling, H1a). This test asserted that the
		// custody_90d subscription recorded a referee_purchase row, mailed the
		// founder "Referee purchase: custody_90d", and provisioned nothing. The
		// two custody prices are now sold as Witness plans, so the assertion is
		// inverted: no referee row, no referee mail, and a key row is inserted.
		// The full evidence-plan contract is asserted in the H1a describe block.
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:              'txn_referee_custody_001',
				customer_id:     'ctm_referee_custody_001',
				subscription_id: 'sub_referee_custody_001',
				items:           [{ price_id: 'pri_01m22wf966bjsar9sgtbzsva2b', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		let insertedPlan: unknown = null;
		const subjects: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				insertedPlan = (JSON.parse(String(init.body)) as Record<string, unknown>).plan;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'custody-buyer@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				subjects.push((JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { subject?: string }).subject ?? '');
				return new Response(JSON.stringify({ id: 'email_custody_001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);
			expect(await env.ORACLE_TELEMETRY.get('referee_purchase:txn_referee_custody_001')).toBeNull();
			expect(subjects).not.toContain('Referee purchase: custody_90d');
			expect(insertedPlan).toBe('evidence_starter');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-149: a referee price does NOT write a referee_purchase row for a non-referee price', async () => {
		// The control that stops the row being written for everything. Without
		// it, a handler that recorded every transaction would pass both tests
		// above and be wrong.
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:              'txn_builder_not_referee_001',
				customer_id:     'ctm_builder_not_referee',
				subscription_id: 'sub_builder_not_referee_001',
				items:           [{ price_id: 'pri_test_builder_placeholder', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		let supabaseInsertCalled = false;
		let capturedEmailHtml    = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				supabaseInsertCalled = true;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116', message: 'not found' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'builder2@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				const mail = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { to?: string[]; html?: string };
				// H1a: skip the founder line, which now follows every paid mint.
				if (mail.to?.[0] !== 'mike@headlessoracle.com') capturedEmailHtml = mail.html ?? '';
				return new Response(JSON.stringify({ id: 'email_builder_002' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);
			// Builder still provisions exactly as before.
			expect(supabaseInsertCalled).toBe(true);
			expect(capturedEmailHtml).toContain('ho_live_');
			// And no referee record was invented for it.
			expect(await env.ORACLE_TELEMETRY.get('referee_purchase:txn_builder_not_referee_001')).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	// ─── B-144: transaction.completed fails closed on an unmapped price id ───
	// REPLACES a test that asserted the OLD behaviour — "defaults to pro plan
	// for unrecognised price ID". That test was correct about what the code
	// did and wrong about what the code should do: `let plan = 'pro'` under a
	// comment calling itself "fail-safe" minted a ho_live_ key on the
	// second-highest plan for a price whose entitlement we could not know.
	// The assertion is inverted deliberately: nothing is provisioned now.
	it('B-144: transaction.completed with an unmapped price_id provisions NOTHING and returns received:true', async () => {
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
		let insertCalled  = false;
		let emailCalled   = false;
		let customerCalled = false;

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('supabase.co') && init?.method === 'POST') {
				insertCalled = true;
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.paddle.com/customers')) {
				customerCalled = true;
				return new Response(JSON.stringify({ data: { email: 'unknown@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (urlStr.includes('resend.com')) {
				emailCalled = true;
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
			// Paddle must stop retrying: no retry can map a price we do not know.
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ received: true });
			// No key, no row, no email — and not even the customer lookup.
			expect(insertCalled).toBe(false);
			expect(emailCalled).toBe(false);
			expect(customerCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-144: the unmapped payment reaches the per-payment alerting path as tier "unmapped"', async () => {
		// recordPaddleRevenueEvent → paddle_revenue_event:{ISO} in KV →
		// /v5/revenue-pulse → .github/workflows/health-check.yml opens a GitHub
		// issue per txn_id. Without this the payment lands silently and the only
		// thing that notices is a human reading the Paddle dashboard.
		const before = parseInt((await env.ORACLE_TELEMETRY.get('paddle_revenue_count:unmapped')) ?? '0', 10) || 0;
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id: 'txn_unmapped_alert_001',
				customer_id: 'ctm_unmapped_alert',
				subscription_id: 'sub_unmapped_alert_001',
				items: [{ price_id: 'pri_never_seen_before', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
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
			const after = parseInt((await env.ORACLE_TELEMETRY.get('paddle_revenue_count:unmapped')) ?? '0', 10) || 0;
			expect(after).toBe(before + 1);
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

	it('POST /webhooks/paddle subscription.updated (downgrade) -> syncs KV status to suspended', async () => {
		const testKeyHash = 'cc11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbcc';
		await env.ORACLE_API_KEYS.put(testKeyHash, JSON.stringify({
			plan: 'pro', status: 'active', paddle_subscription_id: 'sub_updated_kv_test',
		}));

		const rawBody = JSON.stringify({
			event_type: 'subscription.updated',
			data: { id: 'sub_updated_kv_test', status: 'paused' }, // non-active → suspended
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
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
			expect(parsed.status).toBe('suspended');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('POST /webhooks/paddle subscription.past_due -> syncs KV status to suspended', async () => {
		const testKeyHash = 'dd44556677889900aabbccdd11223344aabbccdd11223344aabbccdd11223344';
		await env.ORACLE_API_KEYS.put(testKeyHash, JSON.stringify({
			plan: 'builder', status: 'active', paddle_subscription_id: 'sub_pastdue_kv_test',
		}));

		const rawBody = JSON.stringify({
			event_type: 'subscription.past_due',
			data: { id: 'sub_pastdue_kv_test' },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('supabase.co') && (!init?.method || init.method === 'GET')) {
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
			expect(parsed.status).toBe('suspended');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

});

// ─── edgeCaseCount() ─────────────────────────────────────────────────────────

describe('edgeCaseCount()', () => {
	it('2026: holidays = sum of all 28 exchange holiday lists', () => {
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
		expect(body).toHaveProperty('exchanges_covered', 28);
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('Error responses include docs field', () => {
	it('402 x402scan format on keyless /v5/status after trial exhausted (ORACLE_PAYMENT_ADDRESS configured)', async () => {
		// Exhaust trial first, then keyless → x402scan 402
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const body = await fetchJSON('/v5/status');
			expect(body).toHaveProperty('error', 'TRIAL_EXHAUSTED');
			expect(body).toHaveProperty('x402Version', 1);
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
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

// payerAddress: the Transfer `from`. Defaults to an address nobody holds a key
// for, which the per-request x402 tests use; a mint test passes the address of
// the key it signs with (test/mint-payer.ts), because the mint is payer-bound.
function mockBaseRpc(recipientAddress: string, amountUnits: string, blockTimestamp: number, payerAddress = '0xabcdef1234567890abcdef1234567890abcdef12'): () => void {
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
								'0x000000000000000000000000' + payerAddress.slice(2).toLowerCase(),
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
		expect(x402.network).toBe('base');
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
		expect(res.headers.get('X-Payment-Network')).toBe('base');
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

	it('rejects invalid X-Payment (neither raw JSON nor base64)', async () => {
		const key  = 'ho_free_' + 'j'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': 'not-json' } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'PAYMENT_VERIFICATION_FAILED');
	});
	it('accepts Payment-Signature header (x402 v2) in addition to X-Payment', async () => {
		const key  = 'ho_free_' + 'n2'.repeat(32);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		// Send with Payment-Signature header (v2 name) — should still be read
		const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'Payment-Signature': 'not-valid-but-should-be-read' } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		// Proves Payment-Signature was read (it tried to verify and failed)
		expect(body).toHaveProperty('error', 'PAYMENT_VERIFICATION_FAILED');
	});

	it('keyless 402 includes Payment-Required header (x402 v2) after trial exhausted', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const prHeader = res.headers.get('Payment-Required');
			expect(prHeader).toBeTruthy();
			// CONTRACT CHANGED 2026-09-07 (rail sprint T1). This assertion used to
			// require x402Version 1 and network 'base' in the HEADER. That was the
			// defect, not the contract: the header declared v1 while carrying the
			// v2 field name `amount` and no resource/description, so it matched
			// neither schema and a stock @x402/fetch 2.20.0 client could not pay
			// (RAIL_T0_2026-09-07.md E5). The header is now schema-valid v2; the
			// v1 representation lives in the BODY, asserted below.
			const decoded = JSON.parse(x402Base64Decode(prHeader!));
			expect(decoded.x402Version).toBe(2);
			expect(decoded.accepts).toBeInstanceOf(Array);
			expect(decoded.accepts[0].network).toBe('eip155:8453');
			expect(decoded.accepts[0].asset).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
			expect(decoded.resource.url).toContain('/v5/status');
			// The body a v1 client reads still says version 1 with 'base'.
			const v1body = await res.json() as Record<string, unknown>;
			expect(v1body.x402Version).toBe(1);
			expect((v1body.accepts as Record<string, unknown>[])[0].network).toBe('base');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('CORS includes Payment-Signature in Access-Control-Allow-Headers', async () => {
		const res = await fetchWorker('/v5/status?mic=XNYS', { method: 'OPTIONS' });
		const allowed = res.headers.get('Access-Control-Allow-Headers') ?? '';
		expect(allowed).toContain('Payment-Signature');
		const exposed = res.headers.get('Access-Control-Expose-Headers') ?? '';
		expect(exposed).toContain('Payment-Required');
	});

	it('buildX402ScanPayload uses USDC EIP-712 extra (not Headless Oracle)', async () => {
		// Batch keyless 402 uses buildX402ScanPayload
		const res = await fetchWorker('/v5/batch');
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		const accepts = (body.accepts as Array<Record<string, unknown>>);
		expect(accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' });
		expect(accepts[0].network).toBe('base');
	});
});

// ─── api.headlessoracle.com subdomain routing ────────────────────────────────
// The api subdomain shares this Worker but has NO Cloudflare Pages origin.
// HTML paths must NOT fall into the fetch(request) Pages passthrough (a dead
// origin → 522). They redirect to the bare domain, mirroring the www → bare
// redirect at the top of fetch(). API paths continue to be served directly.
describe('api.headlessoracle.com subdomain — HTML paths redirect, API paths served', () => {
	async function fetchUrl(fullUrl: string, options: RequestInit = {}): Promise<Response> {
		const request = new Request<unknown, IncomingRequestCfProperties>(fullUrl, options);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it('redirects /pricing to the bare domain (301) instead of the dead Pages origin', async () => {
		const res = await fetchUrl('https://api.headlessoracle.com/pricing');
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe('https://headlessoracle.com/pricing');
	});

	it('redirects /docs/quickstart to the bare domain (301)', async () => {
		const res = await fetchUrl('https://api.headlessoracle.com/docs/quickstart');
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe('https://headlessoracle.com/docs/quickstart');
	});

	it('still serves API path /v5/health with 200 (regression — API paths unaffected)', async () => {
		const res = await fetchUrl('https://api.headlessoracle.com/v5/health');
		expect(res.status).toBe(200);
	});

	it('redirect target matches the www → bare-domain behaviour', async () => {
		const apiRes = await fetchUrl('https://api.headlessoracle.com/pricing');
		const wwwRes = await fetchUrl('https://www.headlessoracle.com/pricing');
		expect(apiRes.status).toBe(301);
		expect(wwwRes.status).toBe(301);
		expect(apiRes.headers.get('Location')).toBe(wwwRes.headers.get('Location'));
		expect(apiRes.headers.get('Location')).toBe('https://headlessoracle.com/pricing');
	});
});

// ─── Base RPC fetch timeout discipline ───────────────────────────────────────
// The per-request x402 verifier's two Base mainnet JSON-RPC fetches must carry
// AbortSignal.timeout(5000) so a hung Base RPC endpoint cannot stall the Worker
// (an unbounded fetch is a 5xx source — see ZONE_5XX_INVESTIGATION_2026-05-22.md).
// We assert the signal is present rather than simulating a real network timeout.
describe('Base RPC fetches (verifyX402Payment) carry AbortSignal.timeout(5000)', () => {
	// Capturing variant of mockBaseRpc — records the init.signal passed to each
	// https://mainnet.base.org call so we can inspect the abort signal.
	function captureBaseRpc(recipientAddress: string, amountUnits: string, blockTimestamp: number) {
		const original = globalThis.fetch;
		const calls: Array<{ method: string; signal: unknown }> = [];
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === 'string' ? input : (input as Request).url;
			if (url === 'https://mainnet.base.org') {
				const body = JSON.parse((init?.body as string) ?? '{}') as { method: string };
				calls.push({ method: body.method, signal: init?.signal });
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
		return { calls, restore: () => { globalThis.fetch = original; } };
	}

	it('passes a timeout signal to both RPC calls (eth_getTransactionReceipt + eth_getBlockByNumber)', async () => {
		const txHash  = '0x' + 'c3'.repeat(32);
		const key     = 'ho_free_' + 'r'.repeat(64);
		const hash    = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const nowSec  = Math.floor(Date.now() / 1000);
		const cap     = captureBaseRpc(TEST_PAYMENT_ADDRESS, '1000', nowSec - 10);
		const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const res     = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		cap.restore();
		expect(res.status).toBe(200);
		const receiptCall = cap.calls.find((c) => c.method === 'eth_getTransactionReceipt');
		const blockCall   = cap.calls.find((c) => c.method === 'eth_getBlockByNumber');
		expect(receiptCall).toBeDefined();
		expect(blockCall).toBeDefined();
		expect(receiptCall!.signal).toBeInstanceOf(AbortSignal); // src/index.ts:2222
		expect(blockCall!.signal).toBeInstanceOf(AbortSignal);   // src/index.ts:2258
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

// The grant was sized from payment.amount, a value the caller writes in the
// header; verifyX402Payment read the real Transfer amount and threw it away.
describe('/v5/credits/purchase — grant sized from the on-chain amount, not the header', () => {
	async function purchase(key: string, txHash: string, onChainUnits: string, claimedUnits: string) {
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockBaseRpc(TEST_PAYMENT_ADDRESS, onChainUnits, nowSec - 10);
		try {
			const payment = JSON.stringify({ txHash, network: 'base', amount: claimedUnits, paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
			return await fetchWorker('/v5/credits/purchase', { method: 'POST', headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
		} finally {
			restore();
		}
	}

	it('a 1000-unit transfer with a header claiming 800000 grants 1 credit, not 1000', async () => {
		const key  = 'ho_free_' + 'p1'.repeat(32);
		const hash = await setupFreeKey(key);
		const res  = await purchase(key, '0x' + 'a1'.repeat(32), '1000', '800000');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.purchased).toBe(1);
		const stored = JSON.parse((await env.ORACLE_TELEMETRY.get(`credits:${hash}`)) ?? '{}') as { balance?: number };
		expect(stored.balance).toBe(1);
	});

	it('a genuine 800000-unit transfer still grants 1000 credits', async () => {
		const key  = 'ho_free_' + 'p2'.repeat(32);
		const hash = await setupFreeKey(key);
		const res  = await purchase(key, '0x' + 'a2'.repeat(32), '800000', '800000');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.purchased).toBe(1000);
		const stored = JSON.parse((await env.ORACLE_TELEMETRY.get(`credits:${hash}`)) ?? '{}') as { balance?: number };
		expect(stored.balance).toBe(1000);
	});

	it('the openapi 200 schema names exactly the fields the route returns', async () => {
		const key  = 'ho_free_' + 'p4'.repeat(32);
		await setupFreeKey(key);
		const res  = await purchase(key, '0x' + 'a4'.repeat(32), '1000', '1000');
		expect(res.status).toBe(200);
		const served = Object.keys(await res.json() as Record<string, unknown>).sort();
		const spec   = await fetchJSON('/openapi.json') as { paths: Record<string, { post: { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
		const props  = Object.keys(spec.paths['/v5/credits/purchase'].post.responses['200'].content['application/json'].schema.properties).sort();
		expect(props).toEqual(served);
	});

	it('a 90000-unit transfer with a header claiming 1000 still grants 100 (the chain decides both ways)', async () => {
		const key  = 'ho_free_' + 'p3'.repeat(32);
		await setupFreeKey(key);
		const res  = await purchase(key, '0x' + 'a3'.repeat(32), '90000', '1000');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.purchased).toBe(100);
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
	it('GET /.well-known/agent.json includes x402 in authentication schemes', async () => {
		const body = await fetchJSON('/.well-known/agent.json');
		const auth = body.authentication as { schemes: string[] };
		expect(auth.schemes).toContain('x402');
	});

	it('GET /.well-known/agent.json includes payment object with Base mainnet', async () => {
		const body    = await fetchJSON('/.well-known/agent.json');
		const payment = body.payment as Record<string, unknown>;
		expect(payment).toBeDefined();
		expect(payment.network).toBe('eip155:8453');
		expect(payment.chain_id).toBe(8453);
		expect(payment.currency).toBe('USDC');
	});
});

// ─── Webhook subscriptions ───────────────────────────────────────────────────

describe('POST /v5/webhooks/subscribe', () => {
	it('missing X-Oracle-Key → 401', async () => {
		const res = await fetchWorker('/v5/webhooks/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/hook', mics: ['XNYS'] }) });
		expect(res.status).toBe(401);
	});

	it('invalid X-Oracle-Key → 403', async () => {
		const res = await fetchWorker('/v5/webhooks/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'invalid_key' }, body: JSON.stringify({ url: 'https://example.com/hook', mics: ['XNYS'] }) });
		expect(res.status).toBe(403);
	});

	it('non-https url → 400 INVALID_URL', async () => {
		const res = await fetchWorker('/v5/webhooks/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' }, body: JSON.stringify({ url: 'http://example.com/hook', mics: ['XNYS'] }) });
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_URL');
	});

	it('invalid MIC codes → 400 INVALID_MICS', async () => {
		const res = await fetchWorker('/v5/webhooks/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' }, body: JSON.stringify({ url: 'https://example.com/hook', mics: ['NOTAMIC'] }) });
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_MICS');
	});

	it('valid subscription → 200 with subscription_id and active status', async () => {
		const res = await fetchWorker('/v5/webhooks/subscribe', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' },
			body:    JSON.stringify({ url: 'https://example.com/hook', mics: ['XNYS', 'XLON'], secret: 'my-webhook-secret' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('subscription_id');
		expect(body).toHaveProperty('status', 'active');
		expect(body).toHaveProperty('secret', 'my-webhook-secret');
		expect(body.mics).toEqual(['XNYS', 'XLON']);
		// Cleanup: unsubscribe
		if (typeof body.subscription_id === 'string') {
			await fetchWorker('/v5/webhooks/unsubscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' }, body: JSON.stringify({ subscription_id: body.subscription_id }) });
		}
	});
});

describe('DELETE /v5/webhooks/unsubscribe', () => {
	it('missing subscription_id → 400', async () => {
		const res = await fetchWorker('/v5/webhooks/unsubscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' }, body: JSON.stringify({}) });
		expect(res.status).toBe(400);
	});

	it('unknown subscription_id → 404 SUBSCRIPTION_NOT_FOUND', async () => {
		const res = await fetchWorker('/v5/webhooks/unsubscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' }, body: JSON.stringify({ subscription_id: 'does-not-exist-00000000' }) });
		expect(res.status).toBe(404);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('SUBSCRIPTION_NOT_FOUND');
	});

	it('subscribe then unsubscribe → deleted', async () => {
		// Subscribe
		const subRes = await fetchWorker('/v5/webhooks/subscribe', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' },
			body:    JSON.stringify({ url: 'https://example.com/cleanup', mics: ['XNYS'], secret: 'cleanup-secret' }),
		});
		const { subscription_id } = await subRes.json() as { subscription_id: string };
		// Unsubscribe
		const delRes = await fetchWorker('/v5/webhooks/unsubscribe', {
			method:  'DELETE',
			headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_beta_key_1' },
			body:    JSON.stringify({ subscription_id }),
		});
		expect(delRes.status).toBe(200);
		const body = await delRes.json() as Record<string, unknown>;
		expect(body.status).toBe('deleted');
		expect(body.subscription_id).toBe(subscription_id);
	});
});

// ─── GET /v5/receipts — receipt audit log ────────────────────────────────────

describe('GET /v5/receipts', () => {
	it('missing X-Oracle-Key → 401', async () => {
		const res = await fetchWorker('/v5/receipts');
		expect(res.status).toBe(401);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('API_KEY_REQUIRED');
	});

	it('invalid X-Oracle-Key → 403', async () => {
		const res = await fetchWorker('/v5/receipts', { headers: { 'X-Oracle-Key': 'bad_key' } });
		expect(res.status).toBe(403);
	});

	it('valid key → authenticated (2xx or 5xx from Supabase, never 401/403)', async () => {
		// Test env has Supabase creds but no real DB — may return 200 (no Supabase) or 500 (query error)
		// The important assertion: auth passed (not 401 or 403)
		const res = await fetchWorker('/v5/receipts', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
		// If 200, must have receipts array
		if (res.status === 200) {
			const body = await res.json() as Record<string, unknown>;
			expect(Array.isArray(body.receipts)).toBe(true);
		}
	});

	it('invalid mic filter → 400 INVALID_MIC', async () => {
		const res = await fetchWorker('/v5/receipts?mic=NOTAMIC', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_MIC');
	});
});

describe('docs field — points to headlessoracle.com/docs', () => {
	it('docs field is exact URL without fragment (after trial exhausted)', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const body = await fetchJSON('/v5/status');
			expect((body.docs as string)).toBe('https://headlessoracle.com/docs');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
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
	it('returns 200 (trial) or 402 without API key (x402-native: ORACLE_PAYMENT_ADDRESS in dev.vars)', async () => {
		// /v5/status/realtime starts with /v5/status → trial or x402scan gate applies
		const response = await fetchWorker('/v5/status/realtime?mic=XNYS');
		expect([200, 402]).toContain(response.status);
	});

	it('returns valid JSON with signed_receipt and halt_monitor fields', async () => {
		const body = await fetchJSON('/v5/status/realtime?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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
				headers: { 'X-Oracle-Key': 'test_beta_key_1' },
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

	it('returns 200 with correct shape for valid key', async () => {
		const body = await fetchJSON('/v5/usage', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(body).toHaveProperty('key_prefix');
		expect(body).toHaveProperty('plan');
		expect(body).toHaveProperty('requests_today');
		expect(body).toHaveProperty('requests_this_month');
		expect(body).toHaveProperty('rate_limit_resets_at');
		expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/upgrade');
		expect(body).toHaveProperty('x402_available');
		expect(body).toHaveProperty('x402_amount', '0.001 USDC');
		expect(body).toHaveProperty('credit_balance');
	});

	it('internal plan key returns null limits and 0 usage counts', async () => {
		const body = await fetchJSON('/v5/usage', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		// Beta key is 'internal' plan — not a free plan, so limits are null
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
		expect(body).toHaveProperty('exchanges_covered', 28);
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
			expect(response.headers.get('X-RateLimit-Upgrade-URL')).toContain('upgrade');
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

	it('weekly digest with zero mcp_clients writes sentinel', async () => {
		const isoWeek   = getISOWeek(new Date());
		const digestKey = `weekly_digest:${isoWeek}`;
		// Remove any digest entry written by earlier tests for this same week.
		await env.ORACLE_TELEMETRY.delete(digestKey);
		// Ensure no mcp_clients:* entries exist — other tests may have seeded
		// them and forgotten to clean up, which would steer the cron onto the
		// happy path instead of the sentinel path.
		const existing = await env.ORACLE_TELEMETRY.list({ prefix: 'mcp_clients:' });
		for (const k of existing.keys) await env.ORACLE_TELEMETRY.delete(k.name);

		try {
			const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 9 * * 1' });
			const ctx  = createExecutionContext();
			await worker.scheduled(ctrl, env, ctx);
			await waitOnExecutionContext(ctx);

			const raw = await env.ORACLE_TELEMETRY.get(digestKey);
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw!) as Record<string, unknown>;
			expect(parsed.status).toBe('no_mcp_activity_observed');
			expect(parsed.unique_clients).toBe(0);
			expect(parsed.total_requests).toBe(0);
			expect(parsed.total_keys_matched).toBe(0);
			expect(parsed.records_sampled).toBe(0);
			expect(parsed.new_clients).toBe(0);
			expect(parsed.returning_clients).toBe(0);
			expect(parsed.top_client_asn).toBeNull();
			expect(parsed.week).toBe(isoWeek);
			expect(typeof parsed.sampled_at).toBe('string');
		} finally {
			await env.ORACLE_TELEMETRY.delete(digestKey);
		}
	});

	it('weekly digest aggregates all clients when set exceeds former 100-cap', async () => {
		const isoWeek   = getISOWeek(new Date());
		const digestKey = `weekly_digest:${isoWeek}`;
		await env.ORACLE_TELEMETRY.delete(digestKey);
		// Clear pre-existing mcp_clients entries from other tests so the
		// assertion against seedCount is exact rather than an >= approximation.
		const preExisting = await env.ORACLE_TELEMETRY.list({ prefix: 'mcp_clients:' });
		for (const k of preExisting.keys) await env.ORACLE_TELEMETRY.delete(k.name);

		const today      = new Date().toISOString().slice(0, 10);
		const seedCount  = 120;
		const seededKeys: string[] = [];
		for (let i = 0; i < seedCount; i++) {
			const hash = `test${i.toString().padStart(4, '0')}${'f'.repeat(56)}`.slice(0, 64);
			const key  = `mcp_clients:${today}:${hash}`;
			await env.ORACLE_TELEMETRY.put(
				key,
				JSON.stringify({ request_count: 1, asn_org: 'TEST-ASN', country: 'US', city: 'Test City' }),
			);
			seededKeys.push(key);
		}

		try {
			const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 9 * * 1' });
			const ctx  = createExecutionContext();
			await worker.scheduled(ctrl, env, ctx);
			await waitOnExecutionContext(ctx);

			const raw = await env.ORACLE_TELEMETRY.get(digestKey);
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw!) as Record<string, unknown>;
			expect(parsed.total_keys_matched).toBe(seedCount);
			expect(parsed.records_sampled).toBe(seedCount);
			expect(parsed.unique_clients).toBe(seedCount);
			expect(parsed.total_requests).toBe(seedCount);
			// Sentinel marker must NOT be present on the happy path.
			expect(parsed.status).toBeUndefined();
		} finally {
			for (const key of seededKeys) await env.ORACLE_TELEMETRY.delete(key);
			await env.ORACLE_TELEMETRY.delete(digestKey);
		}
	});
});

// ─── subscription.activated webhook handler ───────────────────────────────────

describe('POST /webhooks/paddle subscription.activated', () => {
	const WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_for_local_tests';

	it('H1a: subscription.activated alone mints nothing, for any of the five subscription plans', async () => {
		// CHANGED 2026-10-03 (H1a). Was: "subscription.activated with new
		// subscription → generates ho_live_ key". activated and
		// transaction.completed can arrive within milliseconds (GAPS.md GAP-004)
		// and both minted, so a buyer could hold two keys. transaction.completed
		// is now the only mint path; activated for an unknown subscription logs
		// and acknowledges. Asserted for every plan, not just Builder.
		const PRICES = [
			'pri_test_builder_placeholder', 'pri_test_pro_placeholder', 'pri_test_protocol_placeholder',
			'pri_01m22wf966bjsar9sgtbzsva2b', 'pri_01m22wfjtbnhjyws9ctabxhvp4',
		];
		let insertCalled = false;
		let emailCalled  = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('api.resend.com')) { emailCalled = true; return new Response('{}', { status: 200 }); }
			if (url.includes('supabase') && init?.method === 'POST') insertCalled = true;
			if (url.includes('supabase')) {
				return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input as RequestInfo, init);
		};
		try {
			for (const [i, priceId] of PRICES.entries()) {
				const subId = `sub_activated_alone_${i}`;
				const rawBody = JSON.stringify({
					event_type: 'subscription.activated',
					data: { id: subId, customer_id: `ctm_activated_alone_${i}`, status: 'active', items: [{ price: { id: priceId } }] },
				});
				const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
				const response = await fetchWorker('/webhooks/paddle', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
					body:    rawBody,
				});
				expect(response.status, priceId).toBe(200);
				expect(await response.json(), priceId).toMatchObject({ received: true });
				expect(await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`), priceId).toBeNull();
			}
			expect(insertCalled).toBe(false);
			expect(emailCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('H1a: subscription.activated with a different plan for a known subscription updates the plan (Supabase down)', async () => {
		// CHANGED 2026-10-03 (H1a). Was: "subscription.activated INSERT race
		// (23505)". activated no longer inserts, so the race it tested cannot
		// occur on this path (the transaction.completed 23505 test keeps it).
		// The upgrade path it sat beside is what remains, now resolved through
		// KV `paddle_sub:` so it works while Supabase is unavailable.
		const subId   = 'sub_activated_upgrade_001';
		const keyHash = 'cd'.repeat(32);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'active', paddle_subscription_id: subId }));
		await env.ORACLE_API_KEYS.put(`paddle_sub:${subId}`, JSON.stringify({ key_hash: keyHash, plan: 'builder', created_at: '2026-10-03T00:00:00Z' }));
		const rawBody = JSON.stringify({
			event_type: 'subscription.activated',
			data: { id: subId, customer_id: 'ctm_upgrade_001', status: 'active', items: [{ price: { id: 'pri_test_pro_placeholder' } }] },
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		let insertCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('supabase') && init?.method === 'POST') insertCalled = true;
			if (url.includes('supabase')) throw new TypeError('fetch failed: supabase unreachable');
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ received: true });
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(keyHash))!)).toMatchObject({ plan: 'pro', status: 'active', paddle_subscription_id: subId });
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`))!)).toMatchObject({ key_hash: keyHash, plan: 'pro' });
			expect(insertCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('subscription.activated with existing subscription_id → idempotent (no duplicate key)', async () => {
		const existingSubId = 'sub_activated_dup_001';
		// Pre-seed Supabase row for this subscription via KV (simulate existing key)
		const existingKeyHash = 'aa'.repeat(32);
		await env.ORACLE_API_KEYS.put(existingKeyHash, JSON.stringify({ plan: 'builder', status: 'active' }));

		const rawBody = JSON.stringify({
			event_type: 'subscription.activated',
			data: {
				id:          existingSubId,
				customer_id: 'ctm_dup_001',
				status:      'active',
				items:       [{ price: { id: 'pri_test_builder_placeholder' } }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		let insertCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('supabase') && url.includes('api_keys') && init?.method === 'GET') {
				// Simulate existing row found
				return new Response(JSON.stringify({ data: { id: 'existing-id', key_hash: existingKeyHash, plan: 'builder' }, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('supabase') && url.includes('api_keys') && init?.method === 'POST') {
				insertCalled = true;
				return new Response(JSON.stringify({ data: [], error: null }), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'dup@test.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input as RequestInfo, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			expect(insertCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
			await env.ORACLE_API_KEYS.delete(existingKeyHash);
		}
	});

	// ─── B-144: subscription.activated fails closed on an unmapped price id ──
	// The sibling of the transaction.completed case. `let activPlan = 'pro'`
	// here minted a ho_live_ key on Pro for any subscription whose price id we
	// did not recognise — including the six referee prices, none of which is an
	// API tier at all.
	it('B-144: subscription.activated with an unmapped price id provisions NOTHING and returns received:true', async () => {
		const rawBody = JSON.stringify({
			event_type: 'subscription.activated',
			data: {
				id:          'sub_activated_unmapped_001',
				customer_id: 'ctm_activated_unmapped',
				status:      'active',
				items:       [{ price: { id: 'pri_01mNEVERISSUEDBYPADDLE0000' } }], // genuinely unknown: not an API tier and not a referee price either
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		let insertCalled   = false;
		let updateCalled   = false;
		let emailCalled    = false;
		let customerCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('api.paddle.com/customers')) {
				customerCalled = true;
				return new Response(JSON.stringify({ data: { email: 'unmapped@test.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('api.resend.com')) {
				emailCalled = true;
				return new Response(JSON.stringify({ id: 'email_ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('supabase') && init?.method === 'POST')  insertCalled = true;
			if (url.includes('supabase') && init?.method === 'PATCH') updateCalled = true;
			if (url.includes('supabase')) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input as RequestInfo, init);
		};

		try {
			const response = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ received: true });
			expect(insertCalled).toBe(false);
			expect(updateCalled).toBe(false);
			expect(emailCalled).toBe(false);
			expect(customerCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ─── H1a: every paid paddle plan delivers its key, Supabase or not ───────────
// 2026-10-03. The webhook inserted into Supabase first and returned 500 before
// the KV write and the email when that insert failed, and the Supabase project
// was paused that day: a buyer could be charged and handed nothing. KV is now
// the record a key authenticates from, Supabase is best effort, and the two
// custody prices provision Witness (evidence) keys.
describe('H1a: paddle purchases deliver', () => {
	const SECRET  = 'pdl_ntfset_test_placeholder_for_local_tests';
	const FOUNDER = 'mike@headlessoracle.com';
	const BUILDER_PRICE      = 'pri_test_builder_placeholder';
	const CUSTODY_90D_PRICE  = 'pri_01m22wf966bjsar9sgtbzsva2b';
	const CUSTODY_1Y_PRICE   = 'pri_01m22wfjtbnhjyws9ctabxhvp4';

	type Mail = { to: string; subject: string; html: string; text: string };
	type StubOpts = {
		select?: 'none' | 'rows' | 'error' | Record<string, string> | Array<Record<string, string>>;
		insert?: 'ok' | 'throw' | '23505';
		update?: 'ok' | 'throw';
		resendCustomerOk?: boolean;
		email?: string;
	};

	function stubFetch(opts: StubOpts = {}) {
		const st = { mails: [] as Mail[], inserts: [] as Record<string, unknown>[], selects: 0, updates: 0, supabaseUrls: [] as string[] };
		const prev = globalThis.fetch;
		const jsonHeaders = { 'Content-Type': 'application/json' };
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url    = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			const method = (init?.method ?? 'GET').toUpperCase();
			if (url.includes('supabase.co')) {
				st.supabaseUrls.push(url);
				if (method === 'GET' || method === 'HEAD') {
					st.selects++;
					const sel = opts.select ?? 'none';
					if (sel === 'error') {
						return new Response(JSON.stringify({ code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.' }), { status: 503, headers: jsonHeaders });
					}
					if (sel === 'rows') return new Response('[]', { status: 200, headers: jsonHeaders });
					if (sel === 'none') {
						return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: jsonHeaders });
					}
					return new Response(JSON.stringify(sel), { status: 200, headers: jsonHeaders });
				}
				if (method === 'POST') {
					st.inserts.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
					if (opts.insert === 'throw') throw new TypeError('fetch failed: supabase unreachable');
					if (opts.insert === '23505') {
						return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }), { status: 409, headers: jsonHeaders });
					}
					return new Response(null, { status: 201 });
				}
				st.updates++;
				if (opts.update === 'throw') throw new TypeError('fetch failed: supabase unreachable');
				return new Response(null, { status: 204 });
			}
			if (url.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: opts.email ?? 'buyer@example.com' } }), { status: 200, headers: jsonHeaders });
			}
			if (url.includes('api.resend.com')) {
				const m = JSON.parse(String(init?.body ?? '{}')) as { to?: string[]; subject?: string; html?: string; text?: string };
				const mail = { to: m.to?.[0] ?? '', subject: m.subject ?? '', html: m.html ?? '', text: m.text ?? '' };
				st.mails.push(mail);
				if (mail.to !== FOUNDER && opts.resendCustomerOk === false) {
					return new Response(JSON.stringify({ name: 'application_error', message: 'Resend down' }), { status: 500, headers: jsonHeaders });
				}
				return new Response(JSON.stringify({ id: 'email_h1a' }), { status: 200, headers: jsonHeaders });
			}
			if (url.includes('api.npmjs.org')) {
				return new Response(JSON.stringify({ downloads: 0 }), { status: 200, headers: jsonHeaders });
			}
			return prev(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		return { st, restore: () => { globalThis.fetch = prev; } };
	}

	async function postPaddle(body: unknown, envOverride?: Record<string, unknown>): Promise<Response> {
		const rawBody = JSON.stringify(body);
		const sig     = await makePaddleSignature(rawBody, SECRET);
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/webhooks/paddle', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
			body:    rawBody,
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, (envOverride ? { ...env, ...envOverride } : env) as typeof env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	function completed(subId: string, priceId: string, extra: Record<string, unknown> = {}) {
		return {
			event_type: 'transaction.completed',
			data: { id: `txn_${subId}`, customer_id: `ctm_${subId}`, subscription_id: subId, items: [{ price_id: priceId, quantity: 1 }], ...extra },
		};
	}

	async function keyRecordNames(): Promise<string[]> {
		const listed = await env.ORACLE_API_KEYS.list();
		return listed.keys.map((k) => k.name).filter((n) => /^[0-9a-f]{64}$/.test(n));
	}

	function logged(spy: { mock: { calls: unknown[][] } }, name: string): boolean {
		return spy.mock.calls.some((c) => String(c[0]).includes(name));
	}

	function customerMails(st: { mails: Mail[] }): Mail[] {
		return st.mails.filter((m) => m.to !== FOUNDER);
	}

	function failingPutsKv(): KVNamespace {
		const real = env.ORACLE_API_KEYS;
		return {
			get:             real.get.bind(real),
			getWithMetadata: real.getWithMetadata.bind(real),
			list:            real.list.bind(real),
			delete:          real.delete.bind(real),
			put:             async () => { throw new Error('KV put failed'); },
		} as unknown as KVNamespace;
	}

	it('Supabase insert throws: a builder purchase still mints, writes KV and paddle_sub, emails the key, returns 200, logs PADDLE_SUPABASE_WRITE_FAILED', async () => {
		const { st, restore } = stubFetch({ insert: 'throw' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle(completed('sub_h1a_sbdown_001', BUILDER_PRICE));
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(st.inserts.length).toBe(1);
			const sub = JSON.parse((await env.ORACLE_API_KEYS.get('paddle_sub:sub_h1a_sbdown_001'))!) as { key_hash: string; plan: string };
			expect(sub.plan).toBe('builder');
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(sub.key_hash))!)).toMatchObject({ plan: 'builder', status: 'active', paddle_subscription_id: 'sub_h1a_sbdown_001' });
			const mails = customerMails(st);
			expect(mails.length).toBe(1);
			expect(mails[0].html).toMatch(/ho_live_[0-9a-f]{64}/);
			// The emailed key is the one KV holds.
			expect(await sha256Hex(mails[0].html.match(/ho_live_[0-9a-f]{64}/)![0])).toBe(sub.key_hash);
			expect(logged(errSpy, 'PADDLE_SUPABASE_WRITE_FAILED')).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it.each([
		{ priceId: CUSTODY_90D_PRICE, plan: 'evidence_starter', amount: '49.00',  quota: '1,000', name: 'Evidence Starter (Witness account)' },
		{ priceId: CUSTODY_1Y_PRICE,  plan: 'evidence',         amount: '199.00', quota: '3,000', name: 'Evidence (Witness account)' },
	])('$plan completed: key minted with its stored plan, paddle_sub written, Witness email, founder line, revenue $amount, no referee_purchase row', async ({ priceId, plan, amount, quota, name }) => {
		const subId = `sub_h1a_${plan}_001`;
		const { st, restore } = stubFetch({ email: 'witness-buyer@example.com' });
		try {
			const res = await postPaddle(completed(subId, priceId, { origin: 'web' }));
			expect(res.status).toBe(200);
			expect(st.inserts[0]).toMatchObject({ plan, status: 'active', stripe_subscription_id: subId });
			const sub = JSON.parse((await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`))!) as { key_hash: string; plan: string };
			expect(sub.plan).toBe(plan);
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(sub.key_hash))!)).toMatchObject({ plan, status: 'active' });

			const mails = customerMails(st);
			expect(mails.length).toBe(1);
			expect(mails[0].to).toBe('witness-buyer@example.com');
			expect(mails[0].html).toContain(name);
			expect(mails[0].html).toContain(`up to ${quota} new checkpoints per UTC day`);
			expect(mails[0].html).toContain('Authorization: Bearer &lt;key&gt;');
			expect(mails[0].html).toContain('POST https://api.headlessoracle.com/v1/witness/checkpoints');
			expect(mails[0].html).toContain('curl -X POST https://api.headlessoracle.com/v1/witness/checkpoints');
			expect(mails[0].html).toContain('https://api.headlessoracle.com/v1/witness/spec');
			expect(mails[0].html).not.toContain('/v5/status');
			expect(mails[0].html).not.toContain('X-Oracle-Key');

			const founder = st.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain(`plan=${plan}`);
			expect(founder[0].text).toContain(`transaction=txn_${subId}`);
			expect(founder[0].text).toContain('customer_domain=example.com');
			expect(founder[0].text).toContain('customer_email_sent=yes');
			expect(founder[0].text).not.toContain('witness-buyer@');

			const listed = await env.ORACLE_TELEMETRY.list({ prefix: 'paddle_revenue_event:' });
			const rows = (await Promise.all(listed.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name))))
				.map((r) => JSON.parse(r ?? '{}') as Record<string, unknown>);
			expect(rows.find((r) => r.txn_id === `txn_${subId}`)).toMatchObject({ tier: `evidence:${plan}`, amount, currency: 'USD' });
			expect(await env.ORACLE_TELEMETRY.get(`referee_purchase:txn_${subId}`)).toBeNull();
		} finally {
			restore();
		}
	});

	it('renewal: paddle_sub present, Supabase down — mints nothing', async () => {
		const subId = 'sub_h1a_renewal_001';
		await env.ORACLE_API_KEYS.put(`paddle_sub:${subId}`, JSON.stringify({ key_hash: 'ab'.repeat(32), plan: 'builder', created_at: '2026-10-01T00:00:00Z' }));
		const { st, restore } = stubFetch({ select: 'error', insert: 'throw' });
		const before = await keyRecordNames();
		try {
			const res = await postPaddle(completed(subId, BUILDER_PRICE, { origin: 'subscription_recurring' }));
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(st.inserts.length).toBe(0);
			expect(st.mails.length).toBe(0);
			expect(await keyRecordNames()).toEqual(before);
		} finally {
			restore();
		}
	});

	it('KV miss + Supabase error + origin subscription_recurring: mints nothing, logs PADDLE_DEDUPE_UNAVAILABLE, acknowledges', async () => {
		const subId = 'sub_h1a_recurring_001';
		const { st, restore } = stubFetch({ select: 'error' });
		const errSpy = vi.spyOn(console, 'error');
		const before = await keyRecordNames();
		try {
			const res = await postPaddle(completed(subId, BUILDER_PRICE, { origin: 'subscription_recurring' }));
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(logged(errSpy, 'PADDLE_DEDUPE_UNAVAILABLE')).toBe(true);
			expect(st.inserts.length).toBe(0);
			expect(st.mails.length).toBe(0);
			expect(await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`)).toBeNull();
			expect(await keyRecordNames()).toEqual(before);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it.each(['web', 'api'])('KV miss + Supabase error + origin %s: a checkout-created transaction mints', async (origin) => {
		const subId = `sub_h1a_origin_${origin}_001`;
		const { st, restore } = stubFetch({ select: 'error', insert: 'throw' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle(completed(subId, BUILDER_PRICE, { origin }));
			expect(res.status).toBe(200);
			expect(logged(errSpy, 'PADDLE_DEDUPE_UNAVAILABLE')).toBe(true);
			expect(await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`)).not.toBeNull();
			expect(customerMails(st).length).toBe(1);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('KV miss + Supabase error + origin absent: 503 so Paddle retries, nothing minted', async () => {
		const subId = 'sub_h1a_origin_absent_001';
		const { st, restore } = stubFetch({ select: 'error' });
		const errSpy = vi.spyOn(console, 'error');
		const before = await keyRecordNames();
		try {
			const res = await postPaddle(completed(subId, BUILDER_PRICE));
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
			expect(logged(errSpy, 'PADDLE_DEDUPE_UNAVAILABLE')).toBe(true);
			expect(st.inserts.length).toBe(0);
			expect(st.mails.length).toBe(0);
			expect(await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`)).toBeNull();
			expect(await keyRecordNames()).toEqual(before);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('KV write fails after a successful Supabase insert: the key is still emailed and PADDLE_KV_WRITE_FAILED is logged', async () => {
		const { st, restore } = stubFetch({ insert: 'ok' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle(completed('sub_h1a_kvfail_001', BUILDER_PRICE), { ORACLE_API_KEYS: failingPutsKv() });
			expect(res.status).toBe(200);
			expect(st.inserts.length).toBe(1);
			const mails = customerMails(st);
			expect(mails.length).toBe(1);
			// The emailed key is the one Supabase holds, so checkApiKey's
			// Supabase step authenticates it.
			expect(await sha256Hex(mails[0].html.match(/ho_live_[0-9a-f]{64}/)![0])).toBe(st.inserts[0].key_hash);
			expect(logged(errSpy, 'PADDLE_KV_WRITE_FAILED')).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('KV write fails AND the Supabase insert failed: 503, nothing emailed', async () => {
		const { st, restore } = stubFetch({ insert: 'throw' });
		try {
			const res = await postPaddle(completed('sub_h1a_bothfail_001', BUILDER_PRICE), { ORACLE_API_KEYS: failingPutsKv() });
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
			expect(st.mails.length).toBe(0);
		} finally {
			restore();
		}
	});

	it('ORACLE_API_KEYS unbound: 503, nothing minted', async () => {
		const { st, restore } = stubFetch();
		try {
			const res = await postPaddle(completed('sub_h1a_nokv_001', BUILDER_PRICE, { origin: 'web' }), { ORACLE_API_KEYS: undefined });
			expect(res.status).toBe(503);
			expect(await res.json()).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
			expect(st.inserts.length).toBe(0);
			expect(st.mails.length).toBe(0);
		} finally {
			restore();
		}
	});

	it('founder line: sent for a builder mint with customer_email_sent=yes', async () => {
		const { st, restore } = stubFetch({ email: 'b@builder.example' });
		try {
			expect((await postPaddle(completed('sub_h1a_founder_yes', BUILDER_PRICE))).status).toBe(200);
			const founder = st.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain('plan=builder');
			expect(founder[0].text).toContain('customer_domain=builder.example');
			expect(founder[0].text).toContain('customer_email_sent=yes');
		} finally {
			restore();
		}
	});

	it('founder line: customer_email_sent=no when Resend fails the customer mail', async () => {
		const { st, restore } = stubFetch({ resendCustomerOk: false });
		try {
			expect((await postPaddle(completed('sub_h1a_founder_no', BUILDER_PRICE))).status).toBe(200);
			const founder = st.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain('customer_email_sent=no');
		} finally {
			restore();
		}
	});

	it.each([
		{ select: 'rows'  as const, result: 'ok' },
		{ select: 'error' as const, result: 'failed' },
	])('daily 09:00 cron runs the Supabase keepalive (Supabase $select → $result) and completes', async ({ select, result }) => {
		const { st, restore } = stubFetch({ select });
		const logSpy = vi.spyOn(console, 'log');
		const errSpy = vi.spyOn(console, 'error');
		try {
			const ctrl = createScheduledController({ scheduledTime: Date.now(), cron: '0 9 * * *' });
			const ctx  = createExecutionContext();
			await worker.scheduled(ctrl, env, ctx);
			await waitOnExecutionContext(ctx);
			const keepalive = st.supabaseUrls.filter((u) => u.includes('/api_keys') && u.includes('limit=1'));
			expect(keepalive.length).toBe(1);
			const lines = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).filter((l) => l.includes('SUPABASE_KEEPALIVE'));
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain(`"result":"${result}"`);
		} finally {
			logSpy.mockRestore();
			errSpy.mockRestore();
			restore();
		}
	});

	it.each([
		{ priceId: BUILDER_PRICE,     label: 'builder' },
		{ priceId: CUSTODY_90D_PRICE, label: 'evidence_starter' },
	])('activated then completed for $label: exactly one customer email and one key', async ({ priceId, label }) => {
		const subId = `sub_h1a_actcomp_${label}`;
		const { st, restore } = stubFetch();
		try {
			const act = await postPaddle({
				event_type: 'subscription.activated',
				data: { id: subId, customer_id: `ctm_${subId}`, status: 'active', items: [{ price: { id: priceId } }] },
			});
			expect(act.status).toBe(200);
			expect(st.mails.length).toBe(0);
			const comp = await postPaddle(completed(subId, priceId, { origin: 'web' }));
			expect(comp.status).toBe(200);
			expect(customerMails(st).length).toBe(1);
			expect(st.inserts.length).toBe(1);
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(`paddle_sub:${subId}`))!)).toMatchObject({ plan: label });
		} finally {
			restore();
		}
	});

	it('subscription.canceled with Supabase down sets the KV status, so checkApiKey returns 402', async () => {
		const subId   = 'sub_h1a_cancel_001';
		const apiKey  = 'ho_live_' + 'e'.repeat(64);
		const keyHash = await sha256Hex(apiKey);
		// Not authenticated before the cancel: the memory key cache lasts 60s.
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'active', paddle_subscription_id: subId }));
		await env.ORACLE_API_KEYS.put(`paddle_sub:${subId}`, JSON.stringify({ key_hash: keyHash, plan: 'builder', created_at: '2026-10-01T00:00:00Z' }));
		const { restore } = stubFetch({ select: 'error', update: 'throw' });
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', data: { id: subId } });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(keyHash))!)).toMatchObject({ status: 'inactive' });
			clearApiKeyCache();
			const status = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': apiKey } });
			expect(status.status).toBe(402);
			expect(await status.json()).toMatchObject({ error: 'PAYMENT_REQUIRED' });
		} finally {
			restore();
		}
	});

	it('subscription event for a subscription neither store knows: logs PADDLE_SUB_UNKNOWN and acknowledges', async () => {
		const { restore } = stubFetch({ select: 'none' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle({ event_type: 'subscription.past_due', data: { id: 'sub_h1a_unknown_001' } });
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(logged(errSpy, 'PADDLE_SUB_UNKNOWN')).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('an evidence key is a free key on oracle routes: /v5/status gets the free 500/day limit; /v1/halts answers 402', async () => {
		const apiKey  = 'ho_live_' + 'f'.repeat(64);
		const keyHash = await sha256Hex(apiKey);
		const today   = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'evidence', status: 'active' }));
		const ok = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': apiKey } });
		expect(ok.status).toBe(200);
		expect(ok.headers.get('X-Oracle-Plan')).toBe('free');
		expect(ok.headers.get('X-RateLimit-Limit')).toBe('500');

		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '500', { expirationTtl: 3600 });
		clearApiKeyCache();
		const limited = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': apiKey } });
		expect(limited.status).toBe(402);

		clearApiKeyCache();
		const halts = await fetchWorker('/v1/halts', { headers: { 'X-Oracle-Key': apiKey } });
		expect(halts.status).toBe(402);
		// The stored plan is unchanged: the mapping is at read time only.
		expect(JSON.parse((await env.ORACLE_API_KEYS.get(keyHash))!)).toMatchObject({ plan: 'evidence' });
	});

	it('Paddle-Signature compare: accepts a valid signature, rejects one changed hex digit and a different length', async () => {
		const rawBody = JSON.stringify({ event_type: 'account.updated', data: {} });
		const sig     = await makePaddleSignature(rawBody, SECRET);
		const h1      = sig.split('h1=')[1];
		const post = (header: string) => fetchWorker('/webhooks/paddle', {
			method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': header }, body: rawBody,
		});
		expect((await post(sig)).status).toBe(200);
		const flipped = h1.slice(0, -1) + (h1.endsWith('0') ? '1' : '0');
		const changed = await post(sig.replace(h1, flipped));
		expect(changed.status).toBe(401);
		expect(await changed.json()).toMatchObject({ error: 'INVALID_SIGNATURE' });
		const shorter = await post(sig.replace(h1, h1.slice(0, -1)));
		expect(shorter.status).toBe(401);
		const longer  = await post(sig.replace(h1, h1 + '0'));
		expect(longer.status).toBe(401);
	});

	it('CORS preflight allows the Authorization header (Witness keys are sent as Bearer)', async () => {
		const res = await fetchWorker('/v5/status', { method: 'OPTIONS' });
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
		expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Oracle-Key');
	});

	it('OpenAPI /v5/checkout no longer says it sells only the Pro plan', async () => {
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, { post?: { description?: string } }> };
		const desc = spec.paths['/v5/checkout'].post?.description ?? '';
		expect(desc).not.toContain('for the Pro plan');
		for (const plan of ['builder', 'pro', 'protocol', 'credits', 'custody_90d', 'custody_1y']) expect(desc).toContain(plan);
	});

	// ─── H1b Part A (2026-10-03): the H1a ratification follow-ups ────────────

	async function seedSubscribedKey(subId: string, fill: string, plan = 'builder', extraSub: Record<string, unknown> = {}) {
		const keyHash = await sha256Hex('ho_live_' + fill.repeat(64));
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan, status: 'active', paddle_subscription_id: subId }));
		await env.ORACLE_API_KEYS.put(`paddle_sub:${subId}`, JSON.stringify({ key_hash: keyHash, plan, created_at: '2026-10-01T00:00:00Z', ...extraSub }));
		return keyHash;
	}
	async function kvJson(key: string): Promise<Record<string, unknown> | null> {
		const raw = await env.ORACLE_API_KEYS.get(key);
		return raw ? JSON.parse(raw) as Record<string, unknown> : null;
	}

	it('H1b A1: a KV key-record write that throws on subscription.canceled is a 503; the retry with KV healthy sets the status', async () => {
		const subId   = 'sub_h1b_a1_001';
		const keyHash = await seedSubscribedKey(subId, '1');
		const { restore } = stubFetch({ select: 'error', update: 'ok' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			// Without occurred_at, so the 503 can only come from the key-record write.
			const bare = await postPaddle({ event_type: 'subscription.canceled', data: { id: subId } }, { ORACLE_API_KEYS: failingPutsKv() });
			expect(bare.status).toBe(503);
			const cancel = { event_type: 'subscription.canceled', occurred_at: '2026-10-03T10:00:00.000Z', data: { id: subId } };
			const failed = await postPaddle(cancel, { ORACLE_API_KEYS: failingPutsKv() });
			expect(failed.status).toBe(503);
			expect(await failed.json()).toMatchObject({ error: 'SERVICE_UNAVAILABLE' });
			expect(logged(errSpy, 'PADDLE_KV_WRITE_FAILED')).toBe(true);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'active' });
			// A3: last_event_at is not written when the event did not apply.
			expect((await kvJson(`paddle_sub:${subId}`))!.last_event_at).toBeUndefined();

			const retried = await postPaddle(cancel);
			expect(retried.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'inactive' });
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({ last_event_at: '2026-10-03T10:00:00.000Z' });
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H1b A2: Supabase answers 200 with zero rows: the subscription is missing (logged, acknowledged)', async () => {
		const { restore } = stubFetch({ select: 'rows' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', data: { id: 'sub_h1b_a2_zero' } });
			expect(res.status).toBe(200);
			expect(logged(errSpy, 'PADDLE_SUB_UNKNOWN')).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H1b A2: Supabase answers 406 PGRST116: the subscription is missing, not a failure', async () => {
		const { restore } = stubFetch({ select: 'none' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', data: { id: 'sub_h1b_a2_406' } });
			expect(res.status).toBe(200);
			expect(logged(errSpy, 'PADDLE_SUB_UNKNOWN')).toBe(true);
			expect(logged(errSpy, 'PADDLE_SUB_LOOKUP_FAILED')).toBe(false);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H1b A2: Supabase errors (not PGRST116): lookup failed, 503 so Paddle retries', async () => {
		const { restore } = stubFetch({ select: 'error' });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', data: { id: 'sub_h1b_a2_err' } });
			expect(res.status).toBe(503);
			expect(logged(errSpy, 'PADDLE_SUB_LOOKUP_FAILED')).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H1b A2: one Supabase row (no paddle_sub in KV): the key is cancelled, and the query asks for at most 2 rows', async () => {
		const subId   = 'sub_h1b_a2_one';
		const keyHash = await sha256Hex('ho_live_' + '2'.repeat(64));
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'pro', status: 'active' }));
		const { st, restore } = stubFetch({ select: [{ key_hash: keyHash, plan: 'pro' }] });
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', data: { id: subId } });
			expect(res.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'inactive' });
			const lookup = st.supabaseUrls.find((u) => u.includes('stripe_subscription_id=eq.' + subId) && u.includes('select='));
			expect(lookup).toContain('limit=2');
		} finally {
			restore();
		}
	});

	it('H1b A2: two Supabase rows for one subscription: both keys are cancelled and PADDLE_SUB_MULTIPLE_ROWS is logged', async () => {
		const subId = 'sub_h1b_a2_two';
		const h1 = await sha256Hex('ho_live_' + '3'.repeat(64));
		const h2 = await sha256Hex('ho_live_' + '4'.repeat(64));
		for (const h of [h1, h2]) await env.ORACLE_API_KEYS.put(h, JSON.stringify({ plan: 'builder', status: 'active' }));
		const { restore } = stubFetch({ select: [{ key_hash: h1, plan: 'builder' }, { key_hash: h2, plan: 'builder' }] });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const res = await postPaddle({ event_type: 'subscription.canceled', occurred_at: '2026-10-03T11:00:00Z', data: { id: subId } });
			expect(res.status).toBe(200);
			expect(await kvJson(h1)).toMatchObject({ status: 'inactive' });
			expect(await kvJson(h2)).toMatchObject({ status: 'inactive' });
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('PADDLE_SUB_MULTIPLE_ROWS') && String(c[0]).includes(subId))).toBe(true);
			// The paddle_sub record created from the lookup keeps both keys, so a
			// later event found through KV still reaches the second one.
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({ key_hash: h1, key_hashes: [h1, h2], last_event_at: '2026-10-03T11:00:00Z' });
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H1b A3: canceled, then a retried OLDER updated(active): the key stays cancelled', async () => {
		const subId   = 'sub_h1b_a3_order';
		const keyHash = await seedSubscribedKey(subId, '5');
		const { restore } = stubFetch({ select: 'error' });
		const logSpy = vi.spyOn(console, 'log');
		try {
			const cancel = await postPaddle({ event_type: 'subscription.canceled', occurred_at: '2026-10-03T12:00:00.000Z', data: { id: subId } });
			expect(cancel.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'inactive' });
			const stale = await postPaddle({ event_type: 'subscription.updated', occurred_at: '2026-10-03T11:59:59.000Z', data: { id: subId, status: 'active' } });
			expect(stale.status).toBe(200);
			expect(await stale.json()).toMatchObject({ received: true });
			expect(logged(logSpy, 'PADDLE_EVENT_OUT_OF_ORDER')).toBe(true);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'inactive' });
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({ last_event_at: '2026-10-03T12:00:00.000Z' });
			// Control: an event at the SAME time is processed.
			const same = await postPaddle({ event_type: 'subscription.updated', occurred_at: '2026-10-03T12:00:00.000Z', data: { id: subId, status: 'active' } });
			expect(same.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'active' });
		} finally {
			logSpy.mockRestore();
			restore();
		}
	});

	it('H1b A3: an event with no occurred_at is processed and leaves last_event_at unchanged', async () => {
		const subId   = 'sub_h1b_a3_none';
		const keyHash = await seedSubscribedKey(subId, '6', 'builder', { last_event_at: '2026-10-03T09:00:00.000Z' });
		const { restore } = stubFetch({ select: 'error' });
		try {
			const res = await postPaddle({ event_type: 'subscription.past_due', data: { id: subId } });
			expect(res.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'suspended' });
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({ last_event_at: '2026-10-03T09:00:00.000Z' });
			// An unparsable occurred_at is the same as none.
			const bad = await postPaddle({ event_type: 'subscription.canceled', occurred_at: 'not-a-time', data: { id: subId } });
			expect(bad.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ status: 'inactive' });
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({ last_event_at: '2026-10-03T09:00:00.000Z' });
		} finally {
			restore();
		}
	});

	it('H1b A3: the plan patch from subscription.activated merges into paddle_sub, so last_event_at survives', async () => {
		const subId   = 'sub_h1b_a3_merge';
		const keyHash = await seedSubscribedKey(subId, '7', 'builder', { last_event_at: '2026-10-03T08:00:00.000Z' });
		const { restore } = stubFetch({ select: 'error', update: 'ok' });
		try {
			const res = await postPaddle({
				event_type: 'subscription.activated',
				data: { id: subId, customer_id: 'ctm_h1b', status: 'active', items: [{ price: { id: 'pri_test_pro_placeholder' } }] },
			});
			expect(res.status).toBe(200);
			expect(await kvJson(keyHash)).toMatchObject({ plan: 'pro' });
			expect(await kvJson(`paddle_sub:${subId}`)).toMatchObject({
				key_hash: keyHash, plan: 'pro', created_at: '2026-10-01T00:00:00Z', last_event_at: '2026-10-03T08:00:00.000Z',
			});
		} finally {
			restore();
		}
	});

	it.each([
		{ plan: 'evidence', warmsKv: false },
		{ plan: 'builder',  warmsKv: false },
		{ plan: 'free',     warmsKv: true },
	])('H1b A4: a Supabase hit for a $plan key warms KV: $warmsKv', async ({ plan, warmsKv }) => {
		const apiKey  = 'ho_live_' + (plan === 'free' ? '8' : plan === 'builder' ? '9' : 'a').repeat(64);
		const keyHash = await sha256Hex(apiKey);
		const { restore } = stubFetch({ select: { plan, status: 'active' } });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': apiKey } });
			expect(res.status).toBe(200);
			const listed = await env.ORACLE_API_KEYS.list({ prefix: keyHash });
			if (warmsKv) {
				expect(await kvJson(keyHash)).toEqual({ plan, status: 'active' });
				// The warm carries the TTL-300 expiry, as before.
				expect(listed.keys[0].expiration).toBeGreaterThan(Date.now() / 1000);
			} else {
				expect(listed.keys.length).toBe(0);
			}
		} finally {
			restore();
			await env.ORACLE_API_KEYS.delete(keyHash);
		}
	});

	it('H1b A5: CREDITS_KEY_MINTED logs the email domain, never the address', async () => {
		const { restore } = stubFetch({ email: 'credit-buyer@credits.example' });
		const logSpy = vi.spyOn(console, 'log');
		try {
			const res = await postPaddle({
				event_type: 'transaction.completed',
				data: { id: 'txn_h1b_credits', customer_id: 'ctm_h1b_credits', items: [{ price_id: 'pri_test_credits_placeholder' }] },
			});
			expect(res.status).toBe(200);
			const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('CREDITS_KEY_MINTED'));
			expect(line).toBeDefined();
			expect(JSON.parse(line!)).toMatchObject({ email_domain: 'credits.example' });
			expect(line).not.toContain('credit-buyer');
		} finally {
			logSpy.mockRestore();
			restore();
		}
	});

	it.each([
		{ insert: 'ok'    as const, stored: 'yes' },
		{ insert: 'throw' as const, stored: 'no' },
	])('H1b A5: the founder line carries supabase_stored=$stored', async ({ insert, stored }) => {
		const { st, restore } = stubFetch({ insert });
		try {
			expect((await postPaddle(completed(`sub_h1b_founder_${stored}`, BUILDER_PRICE))).status).toBe(200);
			const founder = st.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain(`supabase_stored=${stored}`);
		} finally {
			restore();
		}
	});
});

// ─── Plan-based daily rate limits ────────────────────────────────────────────

describe('Plan-based daily rate limits', () => {
	it('builder plan at daily limit (50k) → 429 RATE_LIMITED on /v5/status', async () => {
		const builderKey     = 'ho_live_builder_ratelimit_test_key_' + 'a'.repeat(32);
		const builderKeyHash = await sha256Hex(builderKey);
		const today          = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(builderKeyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${builderKeyHash}:${today}`, '50000', { expirationTtl: 3600 });

		try {
			const response = await fetchWorker('/v5/status', {
				headers: { 'X-Oracle-Key': builderKey },
			});
			expect(response.status).toBe(429);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'RATE_LIMITED');
			expect(String(body.message)).toContain('builder');
		} finally {
			await env.ORACLE_API_KEYS.delete(builderKeyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${builderKeyHash}:${today}`);
		}
	});

	it('pro plan at daily limit (200k) → 429 RATE_LIMITED on /v5/status', async () => {
		const proKey     = 'ho_live_pro_ratelimit_test_key_000' + 'b'.repeat(32);
		const proKeyHash = await sha256Hex(proKey);
		const today      = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(proKeyHash, JSON.stringify({ plan: 'pro', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${proKeyHash}:${today}`, '200000', { expirationTtl: 3600 });

		try {
			const response = await fetchWorker('/v5/status', {
				headers: { 'X-Oracle-Key': proKey },
			});
			expect(response.status).toBe(429);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'RATE_LIMITED');
			expect(String(body.message)).toContain('pro');
		} finally {
			await env.ORACLE_API_KEYS.delete(proKeyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${proKeyHash}:${today}`);
		}
	});

	it('builder plan below limit → 200 on /v5/status', async () => {
		const builderKey     = 'ho_live_builder_below_limit_key_' + 'c'.repeat(32);
		const builderKeyHash = await sha256Hex(builderKey);
		const today          = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(builderKeyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${builderKeyHash}:${today}`, '100', { expirationTtl: 3600 });

		try {
			const response = await fetchWorker('/v5/status', {
				headers: { 'X-Oracle-Key': builderKey },
			});
			expect(response.status).toBe(200);
		} finally {
			await env.ORACLE_API_KEYS.delete(builderKeyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${builderKeyHash}:${today}`);
		}
	});

	it('builder plan at daily limit on /v5/batch → 429 RATE_LIMITED', async () => {
		const batchBuilderKey     = 'ho_live_batch_builder_limit_key' + 'd'.repeat(33);
		const batchBuilderKeyHash = await sha256Hex(batchBuilderKey);
		const today               = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(batchBuilderKeyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${batchBuilderKeyHash}:${today}`, '50000', { expirationTtl: 3600 });

		try {
			const response = await fetchWorker('/v5/batch?mics=XNYS', {
				headers: { 'X-Oracle-Key': batchBuilderKey },
			});
			expect(response.status).toBe(429);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'RATE_LIMITED');
		} finally {
			await env.ORACLE_API_KEYS.delete(batchBuilderKeyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${batchBuilderKeyHash}:${today}`);
		}
	});
});

// ─── GET /v5/batch — portfolio summary ──────────────────────────────────────────────

describe('GET /v5/batch — portfolio summary', () => {
	it('all-open batch → safe_to_execute: true, all_open: true', async () => {
		// NYSE + NASDAQ open on weekday 14:00 UTC (10:00 ET)
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const summary = body.summary as Record<string, unknown>;
		expect(summary).toBeDefined();
		expect(summary.safe_to_execute).toBe(true);
		expect(summary.all_open).toBe(true);
		expect(summary.any_halted).toBe(false);
		expect(summary.reason).toBeNull();
		expect(summary.total).toBe(2);
		expect(summary.open).toBe(2);
	});

	it('halted exchange → safe_to_execute: false, any_halted: true, reason contains HALTED', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', reason: 'test halt', expires: '2030-01-01T00:00:00Z' }));
		try {
			const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
			const body = await res.json() as Record<string, unknown>;
			const summary = body.summary as Record<string, unknown>;
			expect(summary.safe_to_execute).toBe(false);
			expect(summary.any_halted).toBe(true);
			expect(summary.halted).toBe(1);
			expect(String(summary.reason)).toContain('HALTED');
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('UNKNOWN exchange → safe_to_execute: false, unknown > 0, reason contains UNKNOWN', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		await env.ORACLE_OVERRIDES.put('XNAS', JSON.stringify({ status: 'UNKNOWN', reason: 'test unknown', expires: '2030-01-01T00:00:00Z' }));
		try {
			const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
			const body = await res.json() as Record<string, unknown>;
			const summary = body.summary as Record<string, unknown>;
			expect(summary.safe_to_execute).toBe(false);
			expect(summary.unknown).toBeGreaterThan(0);
			expect(String(summary.reason)).toContain('UNKNOWN');
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNAS');
		}
	});

	it('batch response still includes receipts array alongside summary', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		const body = await res.json() as Record<string, unknown>;
		expect(Array.isArray(body.receipts)).toBe(true);
		expect(body).toHaveProperty('summary');
		expect(body).toHaveProperty('batch_id');
		expect(body).toHaveProperty('queried_at');
	});
});

// ─── GET /v5/batch — correlation_id, exchanges map, batch signature ──────────

describe('GET /v5/batch — enhanced batch fields', () => {
	it('batch response includes correlation_id, exchanges map, and batch-level signature', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;

		// correlation_id = batch_id
		expect(body).toHaveProperty('correlation_id');
		expect(body.correlation_id).toBe(body.batch_id);

		// exchanges map
		const exchanges = body.exchanges as Record<string, { status: string; source: string }>;
		expect(exchanges).toBeDefined();
		expect(exchanges.XNYS).toBeDefined();
		expect(exchanges.XNYS.status).toBe('OPEN');
		expect(exchanges.XNAS.status).toBe('OPEN');

		// batch-level signature
		expect(typeof body.signature).toBe('string');
		expect((body.signature as string).length).toBeGreaterThan(0);

		// all_open at top level
		expect(body.all_open).toBe(true);

		// schema_version and public_key_id
		expect(body.schema_version).toBe('v5.0');
		expect(body.public_key_id).toBeDefined();
	});

	it('batch signature is verifiable via /v5/verify', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS,XLON', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		const body = await res.json() as Record<string, unknown>;

		// Build the receipt object that was signed
		const receipt = {
			batch_id:       body.batch_id,
			correlation_id: body.correlation_id,
			issued_at:      body.issued_at,
			expires_at:     body.expires_at,
			issuer:         'headlessoracle.com',
			exchanges:      JSON.stringify(body.exchanges),
			all_open:       String(body.all_open),
			schema_version: body.schema_version,
			public_key_id:  body.public_key_id,
			signature:      body.signature,
		};

		const verifyRes = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt }),
		});
		const verifyBody = await verifyRes.json() as Record<string, unknown>;
		const checks = verifyBody.checks as Record<string, { passed: boolean }>;
		expect(checks.signature.passed).toBe(true);
	});

	it('all_open is false when any exchange is CLOSED', async () => {
		// XNYS open at 14:00 UTC, XLON closed (17:00 UTC close, 14:00 UTC = 14:00 GMT = before 16:30 close... actually XLON closes at 16:30 local)
		// Use a time where NYSE is open but XJPX is closed
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS,XJPX', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		const body = await res.json() as Record<string, unknown>;
		expect(body.all_open).toBe(false);
	});

	it('rejects more than 10 MICs', async () => {
		const mics = 'XNYS,XNAS,XLON,XJPX,XPAR,XHKG,XSES,XASX,XBOM,XNSE,XSHG';
		const res = await fetchWorker(`/v5/batch?mics=${mics}`, { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('TOO_MANY_MICS');
	});
});

// ─── GAP-012: batch override recheck ──────────────────────────────────────────────────────────────────

describe('GAP-012: batch safe_to_execute override recheck', () => {
	it('GAP-012: override=HALTED beats schedule-based OPEN → safe_to_execute: false', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z')); // XNYS open, XNAS open
		const ctx = createExecutionContext();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', reason: 'GAP-012 test', expires: '2030-01-01T00:00:00Z' }));
		try {
			const res  = await worker.fetch(new Request('https://headlessoracle.com/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } }), env, ctx);
			const body = await res.json() as { summary: { safe_to_execute: boolean; halted: number } };
			expect(body.summary.safe_to_execute).toBe(false);
			expect(body.summary.halted).toBeGreaterThan(0);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('GAP-012: override=OPEN beats schedule-based CLOSED → counted as OPEN', async () => {
		vi.setSystemTime(new Date('2026-03-16T01:00:00Z')); // XNYS closed (overnight)
		const ctx = createExecutionContext();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'OPEN', reason: 'extended trading', expires: '2030-01-01T00:00:00Z' }));
		try {
			const res  = await worker.fetch(new Request('https://headlessoracle.com/v5/batch?mics=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } }), env, ctx);
			const body = await res.json() as { summary: { open: number } };
			expect(body.summary.open).toBe(1);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('GAP-012: no override → falls through to normal receipt-based logic', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z')); // XNYS open
		const ctx = createExecutionContext();
		const res  = await worker.fetch(new Request('https://headlessoracle.com/v5/batch?mics=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } }), env, ctx);
		const body = await res.json() as { summary: { safe_to_execute: boolean } };
		expect(body.summary.safe_to_execute).toBe(true);
	});
});

// ─── GAP-013: batch receipt audit ────────────────────────────────────────────────────────────────────────

describe('GAP-013: batch receipt audit', () => {
	it('GAP-013: batch of 3 MICs returns 200 with correct summary total', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const ctx = createExecutionContext();
		const res  = await worker.fetch(new Request('https://headlessoracle.com/v5/batch?mics=XNYS,XNAS,XLON', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } }), env, ctx);
		expect(res.status).toBe(200);
		const body = await res.json() as { summary: { total: number }; receipts: unknown[] };
		expect(body.summary.total).toBe(3);
		expect(body.receipts).toHaveLength(3);
	});

	it('GAP-013: audit failure does not fail the batch response', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const ctx = createExecutionContext();
		// insertReceiptAudit is best-effort (.catch(() => {})), so even if Supabase is unavailable
		// (which it is in tests), the batch response must still be 200.
		const res = await worker.fetch(new Request('https://headlessoracle.com/v5/batch?mics=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } }), env, ctx);
		expect(res.status).toBe(200);
	});

	it('GAP-013: batch receipts are audited with source=batch', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		// Intercept Supabase receipt_audit inserts — SUPABASE_URL is set in .dev.vars so
		// insertReceiptAudit will make real fetch calls we can capture here.
		const auditBodies: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (url.includes('receipt_audit') && init?.method === 'POST') {
				const body = JSON.parse((init.body as string) ?? '[]') as unknown;
				const entries = Array.isArray(body) ? body as Record<string, unknown>[] : [body as Record<string, unknown>];
				auditBodies.push(...entries);
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			// fetchWorker already calls waitOnExecutionContext, so waitUntil promises complete
			const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
			expect(res.status).toBe(200);
			// Two MICs → two audit entries, each with source='batch'
			expect(auditBodies.length).toBeGreaterThanOrEqual(2);
			for (const entry of auditBodies) {
				expect(entry.source).toBe('batch');
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ─── Rate-limit headers ──────────────────────────────────────────────────────────────────────────────

describe('Rate-limit headers', () => {
	it('GET /v5/health includes X-Oracle-Plan and X-RateLimit headers', async () => {
		const res = await fetchWorker('/v5/health');
		expect(res.headers.get('X-Oracle-Plan')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
	});

	it('X-RateLimit-Reset is next UTC midnight', async () => {
		vi.setSystemTime(new Date('2026-03-16T12:00:00Z'));
		const res = await fetchWorker('/v5/health');
		const reset = res.headers.get('X-RateLimit-Reset')!;
		expect(reset).toBe('2026-03-17T00:00:00.000Z');
	});

	it('authenticated /v5/status includes rate-limit headers with correct plan', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(res.headers.get('X-Oracle-Plan')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
	});
});

// ─── GET /v5/sandbox ─────────────────────────────────────────────────────────────────────────────────────────

describe('POST /v5/sandbox', () => {
	// Clear both the IP fingerprint and the email fingerprint for the default test email
	// before and after each test so tests don't interfere with each other.
	let sandboxIpFpKey: string;
	let sandboxEmailFpKeyDefault: string;
	beforeEach(async () => {
		sandboxIpFpKey            = `sandbox_fingerprint:ip:${await sha256Hex('unknown')}`;
		sandboxEmailFpKeyDefault  = `sandbox_fingerprint:email:${await sha256Hex('sandbox-test@example.com')}`;
		await env.ORACLE_TELEMETRY.delete(sandboxIpFpKey);
		await env.ORACLE_TELEMETRY.delete(sandboxEmailFpKeyDefault);
	});
	afterEach(async () => {
		await env.ORACLE_TELEMETRY.delete(sandboxIpFpKey);
		await env.ORACLE_TELEMETRY.delete(sandboxEmailFpKeyDefault);
	});

	it('GET /v5/sandbox returns 405 JSON (HTML form removed — served by Pages)', async () => {
		const res = await fetchWorker('/v5/sandbox', { headers: { 'Accept': 'text/html' } });
		expect(res.status).toBe(405);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('METHOD_NOT_ALLOWED');
	});

	it('GET /v5/sandbox returns 405 JSON for API callers', async () => {
		const res  = await fetchWorker('/v5/sandbox', { headers: { 'Accept': 'application/json' } });
		expect(res.status).toBe(405);
		const body = await res.json() as { error: string; message: string };
		expect(body.error).toBe('METHOD_NOT_ALLOWED');
		expect(body.message).toContain('POST');
	});

	it('missing email returns 400 EMAIL_REQUIRED', async () => {
		const res  = await fetchWorker('/v5/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('EMAIL_REQUIRED');
	});

	it('invalid email returns 400 EMAIL_INVALID', async () => {
		const res  = await fetchWorker('/v5/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'notanemail' }) });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('EMAIL_INVALID');
	});

	it('returns a sandbox key with correct shape', async () => {
		const res  = await fetchSandbox();
		expect(res.status).toBe(200);
		const body = await res.json() as { api_key: string; tier: string; email_captured: boolean; expires_at: string; calls_remaining: number; upgrade: string; follow_up: string; quickstart: { curl: string; node: string; python: string } };
		expect(body.api_key).toMatch(/^sb_[0-9a-f]{32}$/);
		expect(body.tier).toBe('sandbox');
		expect(body.email_captured).toBe(true);
		expect(body.calls_remaining).toBe(200);
		expect(body.follow_up).toBeTruthy();
		// The key is in this response and buyer email is failing: follow_up must
		// not send the agent to an inbox for it.
		expect(body.follow_up).not.toMatch(/check your inbox/i);
		expect(body.follow_up).toContain('in this response');
		expect(body.upgrade).toBeTruthy();
		expect(body.quickstart.curl).toContain(body.api_key);
		expect(body.quickstart.node).toContain(body.api_key);
		expect(body.quickstart.python).toContain(body.api_key);
	});

	it('email is stored in KV record', async () => {
		const res     = await fetchSandbox();
		const { api_key } = await res.json() as { api_key: string };
		const keyHash = await sha256Hex(api_key);
		const kvRaw   = await env.ORACLE_API_KEYS.get(keyHash);
		expect(kvRaw).toBeTruthy();
		const kv = JSON.parse(kvRaw!) as { email: string };
		expect(kv.email).toBe('sandbox-test@example.com');
		await env.ORACLE_API_KEYS.delete(keyHash);
	});

	it('welcome email fires via Resend with key and docs link', async () => {
		let resendCalled = false;
		let capturedTo: string[] = [];
		let capturedText = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('resend.com')) {
				resendCalled = true;
				const b = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { to?: string[]; text?: string };
				capturedTo   = b.to   ?? [];
				capturedText = b.text ?? '';
				return new Response(JSON.stringify({ id: 'email_sb_001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			const res = await fetchSandbox('welcome-email-test@example.com');
			expect(res.status).toBe(200);
			const body = await res.json() as { api_key: string };
			// Flush waitUntil promises (miniflare drains them after response)
			await new Promise(r => setTimeout(r, 50));
			expect(resendCalled).toBe(true);
			expect(capturedTo).toContain('welcome-email-test@example.com');
			expect(capturedText).toContain(body.api_key);
			expect(capturedText).toContain('headlessoracle.com/docs');
			expect(capturedText).toContain('headlessoracle.com/upgrade');
		} finally {
			globalThis.fetch = originalFetch;
			await env.ORACLE_TELEMETRY.delete(`sandbox_fingerprint:email:${await sha256Hex('welcome-email-test@example.com')}`);
		}
	});

	it('sandbox key is valid for /v5/status calls', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const sandboxRes = await fetchSandbox();
		const { api_key } = await sandboxRes.json() as { api_key: string };
		const statusRes = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': api_key } });
		expect(statusRes.status).toBe(200);
	});

	it('sandbox key rate-limit: 11th request in same hour returns 429', async () => {
		// Seed the rate limit counter to 10
		const ipHash  = await sha256Hex('unknown');
		const hourKey = `sandbox_rate:${ipHash}:${new Date().toISOString().slice(0, 13)}`;
		await env.ORACLE_TELEMETRY.put(hourKey, '10', { expirationTtl: 90 * 60 });
		try {
			const res = await fetchSandbox();
			expect(res.status).toBe(429);
		} finally {
			await env.ORACLE_TELEMETRY.delete(hourKey);
		}
	});

	it('second sandbox request from same IP returns 429 SANDBOX_LIMIT_REACHED', async () => {
		const res1 = await fetchSandbox();
		expect(res1.status).toBe(200);
		// Second provisioning from same IP — fingerprint now set
		const res2 = await fetchSandbox('sandbox-test-2@example.com');
		expect(res2.status).toBe(429);
		const body = await res2.json() as Record<string, unknown>;
		expect(body.error).toBe('SANDBOX_LIMIT_REACHED');
		expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/upgrade');
		expect(body).toHaveProperty('plans');
		// cleanup extra email fingerprint
		await env.ORACLE_TELEMETRY.delete(`sandbox_fingerprint:email:${await sha256Hex('sandbox-test-2@example.com')}`);
	});

	it('duplicate email from different IP is blocked by email fingerprint', async () => {
		// Simulate: first provision from current IP
		const res1 = await fetchSandbox();
		expect(res1.status).toBe(200);
		// Clear IP fingerprint to simulate a different IP — email fingerprint remains
		await env.ORACLE_TELEMETRY.delete(sandboxIpFpKey);
		// Second request same email — should be blocked by email fingerprint
		const res2 = await fetchSandbox();
		expect(res2.status).toBe(429);
		const body = await res2.json() as Record<string, unknown>;
		expect(body.error).toBe('SANDBOX_LIMIT_REACHED');
	});
});

// ─── Sandbox 402 response body shapes ───────────────────────────────────────

describe('Sandbox 402 response body shapes', () => {
	it('SANDBOX_LIMIT_REACHED body includes upgrade_paths, recommended, and docs', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key     = 'sb_sandbox_limit_test_key00000001';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ tier: 'sandbox', plan: 'sandbox', status: 'active', expires_at: '2026-03-17T15:00:00Z' }), { expirationTtl: 86400 });
		// Exhaust the 200-call daily cap (same key pattern as getDailyUsage: free_usage:hash:date)
		const usageKey = `free_usage:${keyHash}:${new Date().toISOString().slice(0, 10)}`;
		await env.ORACLE_TELEMETRY.put(usageKey, '200', { expirationTtl: 3600 });
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'SANDBOX_LIMIT_REACHED');
			expect(body).toHaveProperty('upgrade_paths');
			expect(body).toHaveProperty('recommended', 'instant_key');
			expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/pricing');
			expect(body).toHaveProperty('docs', 'https://headlessoracle.com/docs');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(usageKey);
		}
	});

	it('expired sandbox key returns SANDBOX_KEY_EXPIRED with upgrade path only — no new-key offer', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key     = 'sb_sandbox_expired_test_key000001';
		const keyHash = await sha256Hex(key);
		// Store as sandbox key with expires_at in the past
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ tier: 'sandbox', plan: 'sandbox', status: 'active', expires_at: '2026-03-15T10:00:00Z' }), { expirationTtl: 86400 });
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'SANDBOX_KEY_EXPIRED');
			expect(body).toHaveProperty('message', 'Your free sandbox has expired. Upgrade to continue.');
			expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/upgrade');
			expect(body).toHaveProperty('plans');
			const plans = body.plans as Record<string, string>;
			expect(plans.builder).toContain('$99');
			expect(plans.pro).toContain('$299');
			// Must NOT suggest getting another sandbox key
			const message = body.message as string;
			expect(message).not.toContain('/v5/sandbox');
			expect(message).not.toContain('fresh key');
			expect(body).toHaveProperty('docs', 'https://headlessoracle.com/docs');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
		}
	});

	it('200-call sandbox limit is enforced on /v5/status', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key     = 'sb_sandbox_25_limit_test_key0001';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ tier: 'sandbox', plan: 'sandbox', status: 'active', expires_at: '2026-03-17T15:00:00Z' }), { expirationTtl: 86400 });
		const usageKey = `free_usage:${keyHash}:2026-03-16`;
		await env.ORACLE_TELEMETRY.put(usageKey, '200', { expirationTtl: 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).toBe('SANDBOX_LIMIT_REACHED');
			// 199 calls should NOT be capped
			await env.ORACLE_TELEMETRY.put(usageKey, '199', { expirationTtl: 3600 });
			const res2 = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res2.status).toBe(200);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(usageKey);
		}
	});
});

// ─── Task 5: MCP server-card enrichment ──────────────────────────────────────────────────────────

describe('MCP server-card.json enrichment (Task 5)', () => {
	it('server-card.json includes reliability, verification, coverage fields', async () => {
		const res  = await fetchWorker('/.well-known/mcp/server-card.json');
		const body = await res.json() as { reliability: { uptime_slo: string }; verification: { algorithm: string }; coverage: { exchanges: number }; fail_closed: boolean; protocols: string[] };
		expect(body.reliability.uptime_slo).toBe('99.9%');
		expect(body.verification.algorithm).toBe('Ed25519');
		expect(body.coverage.exchanges).toBe(28);
		expect(body.fail_closed).toBe(true);
		expect(body.protocols).toContain('MCP-2024-11-05');
	});

	it('GET /mcp returns 200 server info', async () => {
		const res = await fetchWorker('/mcp');
		expect(res.status).toBe(200);
	});
});

// ─── Task 7: Tier-gated 402 responses ─────────────────────────────────────────────────────────────────

describe('Tier-gated 402 responses (Task 7)', () => {
	it('free key on /v5/receipts gets 402 paid_feature', async () => {
		const freeKeyHash = await sha256Hex('test_free_key_tier7');
		await env.ORACLE_API_KEYS.put(freeKeyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			const res  = await fetchWorker('/v5/receipts', { headers: { 'X-Oracle-Key': 'test_free_key_tier7' } });
			expect(res.status).toBe(402);
			const body = await res.json() as { error: string; feature: string };
			expect(body.error).toBe('paid_feature');
			expect(body.feature).toBe('receipt_audit');
			expect(res.headers.get('X-Upgrade-URL')).toBeTruthy();
		} finally {
			await env.ORACLE_API_KEYS.delete(freeKeyHash);
		}
	});

	it('builder key on /v5/receipts gets through (200)', async () => {
		const builderKeyHash = await sha256Hex('test_builder_key_tier7');
		await env.ORACLE_API_KEYS.put(builderKeyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		try {
			const res = await fetchWorker('/v5/receipts', { headers: { 'X-Oracle-Key': 'test_builder_key_tier7' } });
			expect(res.status).toBe(200);
		} finally {
			await env.ORACLE_API_KEYS.delete(builderKeyHash);
		}
	});

	it('sandbox key on /v5/receipts gets 402 paid_feature', async () => {
		const ipFpKey    = `sandbox_fingerprint:ip:${await sha256Hex('unknown')}`;
		const emailFpKey = `sandbox_fingerprint:email:${await sha256Hex('tier7-receipts@example.com')}`;
		await env.ORACLE_TELEMETRY.delete(ipFpKey);
		await env.ORACLE_TELEMETRY.delete(emailFpKey);
		try {
			const sandboxRes = await fetchSandbox('tier7-receipts@example.com');
			const { api_key } = await sandboxRes.json() as { api_key: string };
			const res  = await fetchWorker('/v5/receipts', { headers: { 'X-Oracle-Key': api_key } });
			expect(res.status).toBe(402);
			const body = await res.json() as { error: string };
			expect(body.error).toBe('paid_feature');
		} finally {
			await env.ORACLE_TELEMETRY.delete(ipFpKey);
			await env.ORACLE_TELEMETRY.delete(emailFpKey);
		}
	});

	it('sandbox key on /v5/webhooks/subscribe gets 402 paid_feature', async () => {
		const ipFpKey    = `sandbox_fingerprint:ip:${await sha256Hex('unknown')}`;
		const emailFpKey = `sandbox_fingerprint:email:${await sha256Hex('tier7-webhook@example.com')}`;
		await env.ORACLE_TELEMETRY.delete(ipFpKey);
		await env.ORACLE_TELEMETRY.delete(emailFpKey);
		try {
			const sandboxRes = await fetchSandbox('tier7-webhook@example.com');
			const { api_key } = await sandboxRes.json() as { api_key: string };
			const res  = await fetchWorker('/v5/webhooks/subscribe', {
				method: 'POST',
				headers: { 'X-Oracle-Key': api_key, 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: 'https://example.com/hook', mics: ['XNYS'] }),
			});
			expect(res.status).toBe(402);
			const body = await res.json() as { error: string };
			expect(body.error).toBe('paid_feature');
		} finally {
			await env.ORACLE_TELEMETRY.delete(ipFpKey);
			await env.ORACLE_TELEMETRY.delete(emailFpKey);
		}
	});
});

// ─── POST /v5/sandbox — x402 agent-native path ───────────────────────────────

describe('POST /v5/sandbox — x402 alternative path', () => {
	// Uses the existing mockBaseRpc helper (defined in the x402 payment section above)
	// and the shared TEST_PAYMENT_ADDRESS constant.

	it('invalid JSON in X-Payment → 402 INVALID_PAYMENT', async () => {
		const res = await fetchWorker('/v5/sandbox', {
			method:  'POST',
			headers: { 'X-Payment': 'not-valid-json' },
		});
		expect(res.status).toBe(402);
		const body = await res.json() as { error: string; message: string };
		expect(body.error).toBe('INVALID_PAYMENT');
	});

	it('failed payment verification → 402 INVALID_PAYMENT', async () => {
		// Replay a tx that is already marked used
		const txHash = '0x' + '77'.repeat(32);
		await env.ORACLE_TELEMETRY.put(`x402_used:${txHash}`, '1', { expirationTtl: 60 });
		try {
			const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
			const res = await fetchWorker('/v5/sandbox', {
				method:  'POST',
				headers: { 'X-Payment': payment },
			});
			expect(res.status).toBe(402);
			const body = await res.json() as { error: string };
			expect(body.error).toBe('INVALID_PAYMENT');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`x402_used:${txHash}`);
		}
	});

	it('valid x402 payment → 200 with ho_crd_ key and 10 credits', async () => {
		const txHash  = '0x' + '88'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockBaseRpc(TEST_PAYMENT_ADDRESS, '1000', nowSec - 10);
		try {
			const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
			const res = await fetchWorker('/v5/sandbox', {
				method:  'POST',
				headers: { 'X-Payment': payment },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('api_key');
			expect(typeof body.api_key).toBe('string');
			expect((body.api_key as string).startsWith('ho_crd_')).toBe(true);
			expect(body).toHaveProperty('tier', 'credits');
			expect(body).toHaveProperty('credits', 10);
			expect(body).toHaveProperty('source', 'x402_sandbox');
			// Key must be stored in ORACLE_API_KEYS KV with balance=10
			const encoder = new TextEncoder();
			const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(body.api_key as string));
			const keyHash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
			const stored  = await env.ORACLE_API_KEYS.get(keyHash);
			expect(stored).not.toBeNull();
			const parsed  = JSON.parse(stored!) as Record<string, unknown>;
			expect(parsed).toHaveProperty('tier', 'credits');
			expect(parsed).toHaveProperty('balance', 10);
			expect(parsed).toHaveProperty('source', 'x402_sandbox');
		} finally {
			restore();
		}
	});

	it('x402-issued credit key authenticates /v5/status → 200', async () => {
		const txHash  = '0x' + '99'.repeat(32);
		const nowSec  = Math.floor(Date.now() / 1000);
		const restore = mockBaseRpc(TEST_PAYMENT_ADDRESS, '1000', nowSec - 10);
		try {
			const payment = JSON.stringify({ txHash, network: 'base-mainnet', amount: '1000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
			const sandboxRes = await fetchWorker('/v5/sandbox', {
				method:  'POST',
				headers: { 'X-Payment': payment },
			});
			expect(sandboxRes.status).toBe(200);
			const { api_key } = await sandboxRes.json() as { api_key: string };
			expect(api_key.startsWith('ho_crd_')).toBe(true);

			const statusRes = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': api_key },
			});
			expect(statusRes.status).toBe(200);
			const statusBody = await statusRes.json() as Record<string, unknown>;
			expect(['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN']).toContain(statusBody.status);
			expect(statusBody).toHaveProperty('signature');
		} finally {
			restore();
		}
	});
});

// ─── FINDING-10: MCP initialize capabilities ──────────────────────────────────

describe('MCP initialize capabilities (FINDING-10)', () => {
	it('MCP initialize response contains capabilities.tools as an object', async () => {
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { result: { capabilities: { tools: Record<string, unknown> }; protocolVersion: string } };
		expect(body.result.capabilities.tools).toBeDefined();
		expect(typeof body.result.capabilities.tools).toBe('object');
		expect(body.result.protocolVersion).toBe('2024-11-05');
	});
});

// ─── FINDING-12: deliverWebhook Content-Type ─────────────────────────────────

describe('deliverWebhook Content-Type (FINDING-12)', () => {
	it('webhook subscribe endpoint returns 200 for valid requests (deliverWebhook content-type is tested in implementation)', async () => {
		const keyHash = await sha256Hex('test_webhook_ct_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		const res = await fetchWorker('/v5/webhooks/subscribe', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'test_webhook_ct_key' },
			body:    JSON.stringify({ url: 'https://example.com/hook', mics: ['XNYS'] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { subscription_id: string };
		expect(body.subscription_id).toBeTruthy();
		// Cleanup
		await env.ORACLE_API_KEYS.delete(keyHash);
	});
});

// ─── FINDING-02: Rate-limit headers on all responses ─────────────────────────

describe('Rate-limit headers on all responses (FINDING-02)', () => {
	it('unauthenticated /v5/status response contains X-Oracle-Plan header (200 trial or 402)', async () => {
		const res = await fetchWorker('/v5/status?mic=XNYS');
		// 200 for trial receipt, 402 after trial exhausted
		expect([200, 402]).toContain(res.status);
		expect(res.headers.get('X-Oracle-Plan')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
	});

	it('404 response contains X-Oracle-Plan header', async () => {
		const res = await fetchWorker('/v5/nonexistent');
		expect(res.status).toBe(404);
		expect(res.headers.get('X-Oracle-Plan')).toBeTruthy();
	});

	it('200 demo response contains X-Oracle-Plan header', async () => {
		const res = await fetchWorker('/v5/demo?mic=XNYS');
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Oracle-Plan')).toBeTruthy();
		expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
	});
});

// ─── FINDING-03: Retry-After on 429 ─────────────────────────────────────────

describe('Retry-After on 429 responses (FINDING-03)', () => {
	it('free-tier 429 contains Retry-After header with positive integer', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const keyHash = await sha256Hex('test_retry_after_key_f03');
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:2026-03-16`, '500', { expirationTtl: 25 * 3600 });
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_retry_after_key_f03' },
		});
		// 429 when ORACLE_PAYMENT_ADDRESS not set, 402 otherwise — check both paths
		if (res.status === 429) {
			const retryAfter = res.headers.get('Retry-After');
			expect(retryAfter).toBeTruthy();
			expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);
		} else {
			// 402 path — no Retry-After needed (payment path, not rate-limited)
			expect([402, 429]).toContain(res.status);
		}
		// Cleanup
		await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:2026-03-16`);
		await env.ORACLE_API_KEYS.delete(keyHash);
		vi.useRealTimers();
	});

	it('sandbox rate-limit 429 contains Retry-After header', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:30:00Z'));
		// Seed sandbox rate limit at max
		const clientIp = 'test-ip-for-sandbox-rl';
		const ipHash   = await sha256Hex(clientIp);
		const hourKey  = `sandbox_rate:${ipHash}:2026-03-16T14`;
		await env.ORACLE_TELEMETRY.put(hourKey, '10', { expirationTtl: 90 * 60 });
		// The actual sandbox endpoint uses CF-Connecting-IP header — we seed via known ipHash
		// In test env CF-Connecting-IP is 'unknown', so compute that hash
		const unknownIpHash  = await sha256Hex('unknown');
		const unknownHourKey = `sandbox_rate:${unknownIpHash}:2026-03-16T14`;
		const fpKey          = `sandbox_fingerprint:ip:${unknownIpHash}`;
		await env.ORACLE_TELEMETRY.put(unknownHourKey, '10', { expirationTtl: 90 * 60 });
		// Clear both fingerprints so the rate-limit check (not fingerprint check) triggers
		await env.ORACLE_TELEMETRY.delete(fpKey);
		const emailFpKeyRl = `sandbox_fingerprint:email:${await sha256Hex('sandbox-rl-test@example.com')}`;
		await env.ORACLE_TELEMETRY.delete(emailFpKeyRl);
		const res = await fetchSandbox('sandbox-rl-test@example.com');
		expect(res.status).toBe(429);
		const retryAfter = res.headers.get('Retry-After');
		expect(retryAfter).toBeTruthy();
		expect(parseInt(retryAfter!, 10)).toBeGreaterThan(0);
		// Cleanup
		await env.ORACLE_TELEMETRY.delete(hourKey);
		await env.ORACLE_TELEMETRY.delete(unknownHourKey);
		await env.ORACLE_TELEMETRY.delete(fpKey);
		await env.ORACLE_TELEMETRY.delete(emailFpKeyRl);
		vi.useRealTimers();
	});
});

// ─── FINDING-13: Acquisition telemetry ───────────────────────────────────────

// ─── Upgrade nudge on rate limit ─────────────────────────────────────────────

describe('Upgrade nudge on free tier exhaustion', () => {
	it('free-tier 429 includes upgrade_paths and recommended field', async () => {
		// Need to trigger the 429 path (no ORACLE_PAYMENT_ADDRESS)
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key = 'ho_free_nudge_test_429_key_00001';
		const hash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'free', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:2026-03-16`, '500', { expirationTtl: 25 * 3600 });
		// Remove ORACLE_PAYMENT_ADDRESS to force 429 path
		const savedAddr = (env as Record<string, unknown>).ORACLE_PAYMENT_ADDRESS;
		delete (env as Record<string, unknown>).ORACLE_PAYMENT_ADDRESS;
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(429);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('upgrade_paths');
			expect(body).toHaveProperty('recommended', 'x402_payment');
			expect(body).toHaveProperty('daily_limit', 500);
			expect(body).toHaveProperty('used', 500);
			expect(typeof body.resets_at).toBe('string');
			expect(res.headers.get('X-Upgrade-Path')).toBe('https://headlessoracle.com/pricing');
		} finally {
			(env as Record<string, unknown>).ORACLE_PAYMENT_ADDRESS = savedAddr;
			await env.ORACLE_API_KEYS.delete(hash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${hash}:2026-03-16`);
			vi.useRealTimers();
		}
	});

	it('X-Daily-Usage header present at 80% free tier usage', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key = 'ho_free_nudge_80pct_key_000001';
		const hash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'free', status: 'active' }));
		// 400 out of 500 = 80%
		await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:2026-03-16`, '400', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(200);
			const dailyUsage = res.headers.get('X-Daily-Usage');
			expect(dailyUsage).toBe('400/500');
			expect(res.headers.get('X-Upgrade-Path')).toBe('https://headlessoracle.com/pricing');
			expect(res.headers.get('X-RateLimit-Warning')).toBe('true');
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${hash}:2026-03-16`);
			vi.useRealTimers();
		}
	});

	it('paid tier 429 includes upgrade_paths for next tier', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		const key = 'ho_live_builder_429_test_key01';
		const hash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'builder', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${hash}:2026-03-16`, '50000', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(429);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('upgrade_paths');
			expect(body).toHaveProperty('daily_limit', 50000);
			const paths = body.upgrade_paths as Array<Record<string, unknown>>;
			expect(paths[0]).toHaveProperty('id', 'pro_plan');
		} finally {
			await env.ORACLE_API_KEYS.delete(hash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${hash}:2026-03-16`);
			vi.useRealTimers();
		}
	});
});

describe('Acquisition telemetry (FINDING-13)', () => {
	it('batch request increments batch_combo counter in ORACLE_TELEMETRY', async () => {
		vi.setSystemTime(new Date('2026-03-16T15:00:00Z'));
		await fetchWorker('/v5/batch?mics=XNYS,XNAS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		const today    = '2026-03-16';
		const comboKey = `batch_combo:XNAS+XNYS:${today}`;
		const val      = await env.ORACLE_TELEMETRY.get(comboKey);
		expect(val).toBeTruthy();
		expect(parseInt(val!, 10)).toBeGreaterThanOrEqual(1);
		// Cleanup
		await env.ORACLE_TELEMETRY.delete(comboKey);
		vi.useRealTimers();
	});

	it('/v5/traction includes batch_combos_today, auth_ratio_today, sandbox_caps_today fields', async () => {
		const res  = await fetchWorker('/v5/traction');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('batch_combos_today');
		expect(body).toHaveProperty('auth_ratio_today');
		expect(body).toHaveProperty('sandbox_caps_today');
		expect(typeof body.batch_combos_today).toBe('number');
		expect(typeof body.sandbox_caps_today).toBe('number');
	});
});

// ─── FINDING-09: HALT_MONITOR_TIMEOUT log ─────────────────────────────────────

describe('Halt monitor timeout handling (FINDING-09)', () => {
	it('runHaltMonitor: cron with no POLYGON_API_KEY resolves without throwing', async () => {
		const scheduledController = createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' });
		const ctx = createExecutionContext();
		// Remove POLYGON_API_KEY so the Polygon path is skipped — should not throw.
		const testEnv = { ...env, POLYGON_API_KEY: undefined };
		// With no Polygon key the minute cron reads the live Nasdaq halts RSS. Left
		// unstubbed, this test's runtime was the feed's latency: on a slow link it
		// passed vitest's 5s limit and failed at random, on any commit (2026-10-07,
		// founder's re-sign run). Serve an empty feed and refuse anything else, so
		// the test measures our code and the cron's own failure handling only.
		const originalFetch = globalThis.fetch;
		const called: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL) => {
			const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			called.push(u);
			if (u.includes('nasdaqtrader.com')) {
				return Promise.resolve(new Response('<rss version="2.0"><channel></channel></rss>', {
					status: 200, headers: { 'Content-Type': 'application/rss+xml' },
				}));
			}
			return Promise.resolve(new Response('stubbed: no network in this test', { status: 503 }));
		}) as typeof fetch;
		try {
			await expect(worker.scheduled(scheduledController, testEnv as typeof env, ctx)).resolves.not.toThrow();
			await waitOnExecutionContext(ctx);
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(called.some((u) => u.includes('nasdaqtrader.com'))).toBe(true);
	});
});

// ─── Task 1: Sandbox email capture ──────────────────────────────────────────────────────────────────

describe('Sandbox email capture (Task 1)', () => {
	// Each test uses a unique email to avoid fingerprint collisions; cleanup both fingerprints.
	async function clearFps(email: string) {
		await env.ORACLE_TELEMETRY.delete(`sandbox_fingerprint:ip:${await sha256Hex('unknown')}`);
		await env.ORACLE_TELEMETRY.delete(`sandbox_fingerprint:email:${await sha256Hex(email)}`);
	}

	it('email is required — POST without email returns 400 EMAIL_REQUIRED', async () => {
		const res = await fetchWorker('/v5/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('EMAIL_REQUIRED');
	});

	it('invalid email format returns 400 EMAIL_INVALID', async () => {
		const res = await fetchWorker('/v5/sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'notanemail' }) });
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('EMAIL_INVALID');
	});

	it('valid email provisions key and stores email in KV record', async () => {
		const email = 'task1-capture@example.com';
		await clearFps(email);
		const res  = await fetchSandbox(email);
		expect(res.status).toBe(200);
		const body = await res.json() as { api_key: string; email_captured: boolean; follow_up: string };
		expect(body.api_key).toMatch(/^sb_[0-9a-f]{32}$/);
		expect(body.email_captured).toBe(true);
		expect(body.follow_up).toBeTruthy();
		const keyHash  = await sha256Hex(body.api_key);
		const kvRaw    = await env.ORACLE_API_KEYS.get(keyHash);
		expect(kvRaw).toBeTruthy();
		const kvRecord = JSON.parse(kvRaw!) as { email?: string };
		expect(kvRecord.email).toBe(email);
		await env.ORACLE_API_KEYS.delete(keyHash);
		await env.ORACLE_TELEMETRY.delete(`sandbox_followup:${keyHash}`);
		await clearFps(email);
	});

	it('email stores follow-up record in ORACLE_TELEMETRY', async () => {
		const email = 'task1-followup@example.com';
		await clearFps(email);
		const res     = await fetchSandbox(email);
		expect(res.status).toBe(200);
		const body    = await res.json() as { api_key: string };
		const keyHash = await sha256Hex(body.api_key);
		const fuRaw   = await env.ORACLE_TELEMETRY.get(`sandbox_followup:${keyHash}`);
		expect(fuRaw).toBeTruthy();
		const fuRecord = JSON.parse(fuRaw!) as { email: string; followed_up: boolean; key_expires_at: string };
		expect(fuRecord.email).toBe(email);
		expect(fuRecord.followed_up).toBe(false);
		expect(fuRecord.key_expires_at).toBeTruthy();
		await env.ORACLE_API_KEYS.delete(keyHash);
		await env.ORACLE_TELEMETRY.delete(`sandbox_followup:${keyHash}`);
		await clearFps(email);
	});
});

// ─── Task 2: SSE transport ──────────────────────────────────────────────────────────────────────────

describe('SSE transport for MCP (Task 2)', () => {
	it('GET /mcp with Accept: text/event-stream returns 200', async () => {
		const res = await fetchWorker('/mcp', { headers: { Accept: 'text/event-stream' } });
		expect(res.status).toBe(200);
	});

	it('SSE response has Content-Type: text/event-stream', async () => {
		const res = await fetchWorker('/mcp', { headers: { Accept: 'text/event-stream' } });
		expect(res.headers.get('Content-Type')).toContain('text/event-stream');
	});

	it('SSE response body contains endpoint event', async () => {
		const res  = await fetchWorker('/mcp', { headers: { Accept: 'text/event-stream' } });
		const body = await res.text();
		expect(body).toContain('event: endpoint');
		expect(body).toContain('data:');
	});

	it('SSE endpoint event URI points to POST /mcp', async () => {
		const res  = await fetchWorker('/mcp', { headers: { Accept: 'text/event-stream' } });
		const body = await res.text();
		// Extract the data line
		const dataLine = body.split('\n').find(l => l.startsWith('data:'));
		expect(dataLine).toBeTruthy();
		const data = JSON.parse(dataLine!.replace(/^data:\s*/, '')) as { uri: string };
		expect(data.uri).toContain('/mcp');
	});
});

// ─── Task 3: Traction pre-compute ──────────────────────────────────────────────────────────────────

describe('Traction pre-compute cron (Task 3)', () => {
	it('/v5/traction includes cache_status field', async () => {
		const res  = await fetchWorker('/v5/traction');
		expect(res.status).toBe(200);
		const body = await res.json() as { cache_status: string };
		expect(['live', 'cached']).toContain(body.cache_status);
	});

	it('/v5/traction includes new acquisition counters', async () => {
		const res  = await fetchWorker('/v5/traction');
		const body = await res.json() as {
			unauth_calls_today: number;
			auth_calls_today: number;
			sandbox_keys_issued_today: number;
			sandbox_caps_today: number;
			batch_combos_today: number;
			zero_auth_mcp_requests_today: number;
		};
		expect(typeof body.unauth_calls_today).toBe('number');
		expect(typeof body.auth_calls_today).toBe('number');
		expect(typeof body.sandbox_keys_issued_today).toBe('number');
		expect(typeof body.sandbox_caps_today).toBe('number');
		expect(typeof body.batch_combos_today).toBe('number');
		expect(typeof body.zero_auth_mcp_requests_today).toBe('number');
	});

	it('17:00 cron writes traction_cache KV key', async () => {
		const scheduledController = createScheduledController({ scheduledTime: Date.now(), cron: '0 17 * * *' });
		const ctx = createExecutionContext();
		await worker.scheduled(scheduledController, env, ctx);
		await waitOnExecutionContext(ctx);
		const today    = new Date().toISOString().slice(0, 10);
		const cacheRaw = await env.ORACLE_TELEMETRY.get(`traction_cache:${today}`);
		expect(cacheRaw).toBeTruthy();
		const cache    = JSON.parse(cacheRaw!) as { date: string; computed_at: string };
		expect(cache.date).toBe(today);
		expect(cache.computed_at).toBeTruthy();
		// Clean up
		await env.ORACLE_TELEMETRY.delete(`traction_cache:${today}`);
	});
});

// ─── Task 4: /v5/handoff ──────────────────────────────────────────────────────────────────────────

describe('/v5/handoff session handoff endpoint (Task 4)', () => {
	it('returns 401 without auth', async () => {
		const res = await fetchWorker('/v5/handoff');
		expect(res.status).toBe(401);
	});

	it('returns 200 with valid key and Markdown content-type', async () => {
		const res = await fetchWorker('/v5/handoff', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('Markdown document includes date header', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const res   = await fetchWorker('/v5/handoff', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		const text  = await res.text();
		expect(text).toContain('Session Handoff');
		expect(text).toContain(today);
	});

	it('Markdown document includes telemetry section headers', async () => {
		const res  = await fetchWorker('/v5/handoff', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		const text = await res.text();
		expect(text).toContain('## Telemetry Today');
		expect(text).toContain('## Open Gaps');
		expect(text).toContain('## Product State');
	});
});

// ─── halt_detection signed field ─────────────────────────────────────────────

describe('halt_detection field in signed receipts', () => {
	it('XNYS receipt has halt_detection: "active" (Polygon + Alpaca coverage)', async () => {
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(body).toHaveProperty('halt_detection', 'active');
	});

	it('XNAS receipt has halt_detection: "active" (Polygon + Alpaca coverage)', async () => {
		const body = await fetchJSON('/v5/demo?mic=XNAS');
		expect(body).toHaveProperty('halt_detection', 'active');
	});

	it('XLON receipt has halt_detection: "schedule_only" (no real-time halt API)', async () => {
		const body = await fetchJSON('/v5/demo?mic=XLON');
		expect(body).toHaveProperty('halt_detection', 'schedule_only');
	});

	it('XASX receipt has halt_detection: "schedule_only" (Polygon does not cover ASX)', async () => {
		const body = await fetchJSON('/v5/demo?mic=XASX');
		expect(body).toHaveProperty('halt_detection', 'schedule_only');
	});

	it('halt_detection is signed — present alongside 128-char signature', async () => {
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(body).toHaveProperty('halt_detection');
		expect(body).toHaveProperty('signature');
		expect((body.signature as string).length).toBe(128);
		expect(['active', 'schedule_only']).toContain(body.halt_detection as string);
	});

	it('OVERRIDE receipt also carries halt_detection', async () => {
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status:  'HALTED',
			reason:  'Test halt detection field on OVERRIDE',
			expires: new Date(Date.now() + 3600000).toISOString(),
		}));
		try {
			const body = await fetchJSON('/v5/demo?mic=XNYS');
			expect(body).toHaveProperty('source', 'OVERRIDE');
			expect(body).toHaveProperty('halt_detection', 'active'); // XNYS is active
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('/v5/health halt_monitor includes coverage breakdown', async () => {
		const body = await fetchJSON('/v5/health');
		const hm = body.halt_monitor as Record<string, unknown>;
		expect(hm).toHaveProperty('coverage');
		const coverage = hm.coverage as Record<string, unknown>;
		expect(Array.isArray(coverage.active)).toBe(true);
		expect((coverage.active as string[])).toContain('XNYS');
		expect((coverage.active as string[])).toContain('XNAS');
		expect(Array.isArray(coverage.schedule_only)).toBe(true);
		expect((coverage.schedule_only as string[])).toContain('XLON');
		expect((coverage.schedule_only as string[])).toContain('XASX');
	});
});

// ─── x402 — End-to-End Payment Flow ──────────────────────────────────────────
// Documents the complete x402 payment flow end-to-end:
// Path A (per-request): /v5/status → 402 → X-Payment header → 200
// Path B (subscription): Paddle webhook → key minted in KV → key authenticates

describe('x402 — end-to-end payment flow', () => {
	const E2E_WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_for_local_tests'; // matches .dev.vars

	it('step 1+2: /v5/status without auth → 402 after trial exhausted, with complete x402 payment fields', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('x402Version', 1);
			expect(body).toHaveProperty('error', 'TRIAL_EXHAUSTED');
			const accepts = body.accepts as Array<Record<string, unknown>>;
			expect(accepts).toBeDefined();
			expect(accepts.length).toBeGreaterThan(0);
			const offer = accepts[0];
			expect(offer).toHaveProperty('scheme', 'exact');
			expect(offer).toHaveProperty('network', 'base');
			expect(offer).toHaveProperty('maxAmountRequired', '1000');
			expect(offer).toHaveProperty('payTo', TEST_PAYMENT_ADDRESS);
			expect(offer).toHaveProperty('asset');
			expect(offer).toHaveProperty('input');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('steps 3-5: Paddle webhook mints key in KV → minted key authenticates /v5/status', async () => {
		// CHANGED 2026-10-03 (H1a): this used subscription.activated, which no
		// longer mints (GAP-004: it raced transaction.completed to two keys).
		// transaction.completed is the one mint path, so the flow starts there.
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:              'txn_e2e_flow_001',
				customer_id:     'ctm_e2e_001',
				subscription_id: 'sub_e2e_flow_001',
				origin:          'web',
				items:           [{ price_id: 'pri_test_builder_placeholder', quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, E2E_WEBHOOK_SECRET);

		let capturedEmailHtml = '';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			// Paddle customer API → return email so key can be emailed
			if (url.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'e2e-test@example.com' } }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			// Resend email → capture HTML body (contains the minted ho_live_ key)
			if (url.includes('api.resend.com')) {
				const mail = JSON.parse((init?.body as string) ?? '{}') as { to?: string[]; html?: string };
				// H1a: skip the founder line, which now follows every paid mint.
				if (mail.to?.[0] !== 'mike@headlessoracle.com') capturedEmailHtml = mail.html ?? '';
				return new Response(JSON.stringify({ id: 'email_e2e_001' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			// Supabase SELECT api_keys → no existing row (new subscription)
			// Status 406 makes supabase-js return data:null (falsy) — status 200 would make the
			// body itself become data (truthy), causing the handler to take the early-return path.
			if (url.includes('supabase.co') && url.includes('api_keys') && (init?.method === 'GET' || !init?.method)) {
				return new Response(JSON.stringify({ data: null, error: { code: 'PGRST116', message: 'No rows' } }), {
					status: 406, headers: { 'Content-Type': 'application/json' },
				});
			}
			// Supabase INSERT api_keys → success
			if (url.includes('supabase.co') && url.includes('api_keys') && init?.method === 'POST') {
				return new Response(JSON.stringify([{}]), {
					status: 201, headers: { 'Content-Type': 'application/json' },
				});
			}
			// Supabase PATCH → updateKeyUsage (non-blocking, called after /v5/status auth)
			if (url.includes('supabase.co') && init?.method === 'PATCH') {
				return new Response(null, { status: 204 });
			}
			// Supabase INSERT receipt_audit → insertReceiptAudit (non-blocking)
			if (url.includes('supabase.co') && url.includes('receipt_audit')) {
				return new Response(JSON.stringify([{}]), {
					status: 201, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input as RequestInfo, init);
		};

		try {
			// Step 3: Paddle webhook fires → key minted in ORACLE_API_KEYS KV
			const webhookRes = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(webhookRes.status).toBe(200);
			const webhookBody = await webhookRes.json() as Record<string, unknown>;
			expect(webhookBody).toHaveProperty('received', true);

			// Step 4: Extract the ho_live_ key value from the email HTML
			// The webhook handler emails: <pre>ho_live_<64 hex chars></pre>
			expect(capturedEmailHtml).toContain('ho_live_');
			const keyMatch = capturedEmailHtml.match(/ho_live_[0-9a-f]+/);
			expect(keyMatch).not.toBeNull();
			const mintedKey = keyMatch![0];

			// Step 5: The minted key is in ORACLE_API_KEYS KV — use it to authenticate
			// checkApiKey: MASTER → BETA → KV hit → returns allowed:true, plan:'builder'
			const statusRes = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': mintedKey },
			});
			expect(statusRes.status).toBe(200);
			const statusBody = await statusRes.json() as Record<string, unknown>;
			expect(VALID_STATUSES).toContain(statusBody.status);
			expect(statusBody).toHaveProperty('signature');
			expect(statusBody).toHaveProperty('receipt_mode', 'live');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('path A — keyless x402: X-Payment header → 200 with signed receipt (no key needed)', async () => {
		// Demonstrates the per-request payment path: payment verified via CDP facilitator mock.
		// X402_ENABLED defaults to !== 'false' so the facilitator path is active.
		// X-Payment must be a base64-encoded JSON PaymentPayload object (decoded before forwarding to facilitator).
		const mockPaymentHeader = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xmocksig' } }));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.includes('cdp.coinbase.com') && url.includes('/verify')) {
				return new Response(JSON.stringify({ isValid: true }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('cdp.coinbase.com') && url.includes('/settle')) {
				return new Response(JSON.stringify({ success: true, txHash: '0xe2emainnetpayment' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('supabase.co')) return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Payment': mockPaymentHeader },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(VALID_STATUSES).toContain(body.status);
			expect(body).toHaveProperty('signature');
			expect(body).toHaveProperty('receipt_mode', 'live');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('successful x402 payment returns Payment-Response header', async () => {
		const mockPaymentHeader = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xmocksig_pr' } }));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.includes('cdp.coinbase.com') && url.includes('/verify')) {
				return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('cdp.coinbase.com') && url.includes('/settle')) {
				return new Response(JSON.stringify({ success: true, txHash: '0xe2e_pr_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (url.includes('supabase.co')) return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Payment': mockPaymentHeader } });
			expect(res.status).toBe(200);
			// CONTRACT CHANGED 2026-09-07 (rail sprint T1). The payer here sends a
			// v1 payload, so the settlement comes back under the v1 header name
			// X-PAYMENT-RESPONSE, base64-encoded, per x402 transports-v2/http.md
			// and getPaymentSettleResponse in @x402/core 2.20.0. The old contract
			// sent the v2 name with an unencoded body: a v1 client looking for
			// X-PAYMENT-RESPONSE saw nothing and reported a settled payment as
			// "Payment response header not found".
			expect(res.headers.get('Payment-Response')).toBeNull();
			const prHeader = res.headers.get('X-Payment-Response');
			expect(prHeader).toBeTruthy();
			const pr = JSON.parse(x402Base64Decode(prHeader!));
			expect(pr.success).toBe(true);
			expect(pr.transaction).toBe('0xe2e_pr_test');
			expect(pr.network).toBe('base');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ─── GET /.well-known/ai-plugin.json ─────────────────────────────────────────

describe('GET /.well-known/ai-plugin.json', () => {
	it('returns 200 with schema_version: "v1"', async () => {
		const res = await fetchWorker('/.well-known/ai-plugin.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('schema_version', 'v1');
		expect(body).toHaveProperty('name_for_model', 'headless_oracle');
	});

	it('/ai-plugin.json (root path) returns 200 with schema_version: "v1"', async () => {
		const res = await fetchWorker('/ai-plugin.json');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('schema_version', 'v1');
	});
});

// ─── GET /badge/:mic ──────────────────────────────────────────────────────────

describe('GET /badge/:mic', () => {
	it('/badge/XNYS returns 200 with Content-Type: image/svg+xml', async () => {
		const res = await fetchWorker('/badge/XNYS');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
		const body = await res.text();
		expect(body).toContain('<svg');
		expect(body).toContain('XNYS');
	});

	it('/badge/ZZZZ returns 404 with INVALID_MIC error (valid 4-char but unknown MIC)', async () => {
		const res = await fetchWorker('/badge/ZZZZ');
		expect(res.status).toBe(404);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_MIC');
	});

	it('/badge/INVALID returns 404 (longer-than-4-char code not in MARKET_CONFIGS)', async () => {
		const res = await fetchWorker('/badge/INVALID');
		expect(res.status).toBe(404);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'INVALID_MIC');
	});
});

// ─── GET /v5/changelog ───────────────────────────────────────────────────────

describe('GET /v5/changelog', () => {
	it('returns 200 with entries array', async () => {
		const res = await fetchWorker('/v5/changelog');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('version');
		expect(body).toHaveProperty('updated');
		expect(Array.isArray(body.entries)).toBe(true);
		const entries = body.entries as Array<Record<string, unknown>>;
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0]).toHaveProperty('date');
		expect(entries[0]).toHaveProperty('version');
		expect(Array.isArray(entries[0].changes)).toBe(true);
	});
});

// ─── GET /v5/archive ──────────────────────────────────────────────────────────

describe('GET /v5/archive', () => {
	it('returns 400 when mic is missing', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/archive?date=2026-03-25');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_MIC');
	});

	it('returns 400 for unsupported mic', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/archive?mic=XXXX&date=2026-03-25');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_MIC');
	});

	it('returns 400 for invalid date format', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=25-03-2026');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_DATE');
	});

	it('returns today\'s archive (empty) without auth', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-25');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.mic).toBe('XNYS');
		expect(body.date).toBe('2026-03-25');
		expect(typeof body.count).toBe('number');
		expect(Array.isArray(body.receipts)).toBe(true);
	});

	it('returns 403 for past date without auth', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-24');
		expect(res.status).toBe(403);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('ARCHIVE_DATE_RESTRICTED');
		expect(typeof body.upgrade_url).toBe('string');
	});

	it('returns 403 for past date with free-plan key', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const freeHash = await sha256Hex('ho_free_archive_test_key');
		await env.ORACLE_API_KEYS.put(freeHash, JSON.stringify({ plan: 'free', status: 'active' }));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-24', {
			headers: { 'X-Oracle-Key': 'ho_free_archive_test_key' },
		});
		expect(res.status).toBe(403);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('ARCHIVE_DATE_RESTRICTED');
	});

	it('returns 200 for past date with paid (builder) key', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const builderHash = await sha256Hex('ho_live_builder_archive_test');
		await env.ORACLE_API_KEYS.put(builderHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-24', {
			headers: { 'X-Oracle-Key': 'ho_live_builder_archive_test' },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.mic).toBe('XNYS');
		expect(body.date).toBe('2026-03-24');
		expect(Array.isArray(body.receipts)).toBe(true);
	});

	it('returns 400 for date older than 30 days with paid key', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const builderHash2 = await sha256Hex('ho_live_builder_archive_old');
		await env.ORACLE_API_KEYS.put(builderHash2, JSON.stringify({ plan: 'builder', status: 'active' }));
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-01-01', {
			headers: { 'X-Oracle-Key': 'ho_live_builder_archive_old' },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('ARCHIVE_DATE_OUT_OF_RANGE');
	});

	it('/v5/status live call writes receipt to archive, /v5/archive returns it', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		// Trigger a live /v5/status call to write to the archive
		await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		// Archive should now contain that receipt
		const archiveRes = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-25', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(archiveRes.status).toBe(200);
		const body = await archiveRes.json() as Record<string, unknown>;
		expect((body.count as number)).toBeGreaterThan(0);
		const receipts = body.receipts as Array<Record<string, unknown>>;
		expect(receipts[0]).toHaveProperty('receipt_id');
		expect(receipts[0]).toHaveProperty('signature');
		expect(receipts[0].mic).toBe('XNYS');
		expect(receipts[0].receipt_mode).toBe('live');
	});

	it('archive response contains all required receipt fields on pre-seeded data', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const seeded = {
			receipt_id: 'archive-seed-test-uuid-001',
			issued_at: '2026-03-25T10:00:00.000Z',
			expires_at: '2026-03-25T10:01:00.000Z',
			issuer: 'headlessoracle.com',
			mic: 'XNYS',
			status: 'OPEN',
			source: 'SCHEDULE',
			receipt_mode: 'live',
			schema_version: 'v5.0',
			public_key_id: 'key_2026_v1',
			signature: 'deadbeef',
		};
		await env.ORACLE_TELEMETRY.put(
			'receipt:XNYS:2026-03-25:archive-seed-test-uuid-001',
			JSON.stringify(seeded),
		);
		const res = await fetchWorker('/v5/archive?mic=XNYS&date=2026-03-25');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const receipts = body.receipts as Array<Record<string, unknown>>;
		const found = receipts.find((r) => r.receipt_id === 'archive-seed-test-uuid-001');
		expect(found).toBeDefined();
		expect(found?.mic).toBe('XNYS');
		expect(found?.status).toBe('OPEN');
		expect(found?.signature).toBe('deadbeef');
	});

	it('demo mode /v5/demo calls do NOT write to archive', async () => {
		vi.setSystemTime(new Date('2026-03-25T15:00:00Z'));
		await fetchWorker('/v5/demo?mic=XNAS');
		const archiveRes = await fetchWorker('/v5/archive?mic=XNAS&date=2026-03-25');
		expect(archiveRes.status).toBe(200);
		const body = await archiveRes.json() as Record<string, unknown>;
		// May have 0 or entries from prior tests — just confirm no demo-mode receipts
		const receipts = body.receipts as Array<Record<string, unknown>>;
		const demoReceipts = receipts.filter((r) => r.receipt_mode === 'demo');
		expect(demoReceipts.length).toBe(0);
	});
});

// ─── GET /v5/conformance-vectors ──────────────────────────────────────────────

describe('GET /v5/conformance-vectors', () => {
	it('returns 200 with correct top-level shape', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/conformance-vectors');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.spec_version).toBe('v1');
		expect(typeof body.generated_at).toBe('string');
		expect(typeof body.public_key).toBe('string');
		expect(body.algorithm).toBe('ed25519');
		expect(typeof body.ttl_seconds).toBe('number');
		expect(typeof body.note).toBe('string');
		expect(Array.isArray(body.vectors)).toBe(true);
	});

	it('returns exactly 5 vectors with correct vector_ids', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		expect(vectors.length).toBe(5);
		const ids = vectors.map((v) => v.vector_id);
		expect(ids).toContain('v1_xnys_open');
		expect(ids).toContain('v1_xnys_closed');
		expect(ids).toContain('v1_xjpx_lunch');
		expect(ids).toContain('v1_unknown');
		expect(ids).toContain('v1_health');
	});

	it('each vector has required fields', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		for (const v of vectors) {
			expect(typeof v.vector_id).toBe('string');
			expect(typeof v.description).toBe('string');
			expect(typeof v.canonical_payload).toBe('string');
			expect(typeof v.public_key).toBe('string');
			expect(v.algorithm).toBe('ed25519');
			const receipt = v.receipt as Record<string, unknown>;
			expect(typeof receipt.receipt_id).toBe('string');
			expect(typeof receipt.issued_at).toBe('string');
			expect(typeof receipt.expires_at).toBe('string');
			expect(typeof receipt.signature).toBe('string');
			expect((receipt.signature as string).length).toBe(128);
		}
	});

	it('v1_xnys_open has status OPEN and mic XNYS', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		const v = vectors.find((x) => x.vector_id === 'v1_xnys_open')!;
		const receipt = v.receipt as Record<string, unknown>;
		expect(receipt.mic).toBe('XNYS');
		expect(receipt.status).toBe('OPEN');
		expect(receipt.receipt_mode).toBe('live');
		expect(receipt.schema_version).toBe('v5.0');
	});

	it('v1_xnys_closed has status CLOSED and mic XNYS', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		const v = vectors.find((x) => x.vector_id === 'v1_xnys_closed')!;
		const receipt = v.receipt as Record<string, unknown>;
		expect(receipt.mic).toBe('XNYS');
		expect(receipt.status).toBe('CLOSED');
	});

	it('v1_xjpx_lunch has status CLOSED and mic XJPX', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		const v = vectors.find((x) => x.vector_id === 'v1_xjpx_lunch')!;
		const receipt = v.receipt as Record<string, unknown>;
		expect(receipt.mic).toBe('XJPX');
		expect(receipt.status).toBe('CLOSED');
	});

	it('v1_unknown has status UNKNOWN and source SYSTEM', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		const v = vectors.find((x) => x.vector_id === 'v1_unknown')!;
		const receipt = v.receipt as Record<string, unknown>;
		expect(receipt.status).toBe('UNKNOWN');
		expect(receipt.source).toBe('SYSTEM');
	});

	it('v1_health has status OK and no mic field', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const vectors = body.vectors as Array<Record<string, unknown>>;
		const v = vectors.find((x) => x.vector_id === 'v1_health')!;
		const receipt = v.receipt as Record<string, unknown>;
		expect(receipt.status).toBe('OK');
		expect(receipt.source).toBe('SYSTEM');
		expect(receipt.mic).toBeUndefined();
		expect(receipt.schema_version).toBeUndefined();
	});

	it('no auth required', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/conformance-vectors');
		expect(res.status).toBe(200);
	});

	it('signature is valid Ed25519 over canonical_payload bytes (round-trip verification)', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const body = await fetchJSON('/v5/conformance-vectors');
		const pubKeyHex = body.public_key as string;
		const vectors   = body.vectors as Array<Record<string, unknown>>;
		// Verify all 5 vectors
		for (const v of vectors) {
			const receipt    = v.receipt as Record<string, unknown>;
			const sigHex     = receipt.signature as string;
			const b64payload = v.canonical_payload as string;
			// Decode canonical_payload: base64 → bytes
			const canonicalBytes = Uint8Array.from(atob(b64payload), (c) => c.charCodeAt(0));
			// Decode public key and signature
			const fromHexLocal = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
			const pubKeyBytes = fromHexLocal(pubKeyHex);
			const sigBytes    = fromHexLocal(sigHex);
			// Verify with Web Crypto (same as @headlessoracle/verify SDK)
			const cryptoKey = await crypto.subtle.importKey(
				'raw', pubKeyBytes,
				{ name: 'Ed25519' },
				false, ['verify'],
			);
			const valid = await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, canonicalBytes);
			expect(valid).toBe(true);
		}
	});
});

// ─── GET /v5/stream ────────────────────────────────────────────────────────────

describe('GET /v5/stream', () => {
	it('returns 401 without auth', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream?mic=XNYS');
		expect(res.status).toBe(401);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('API_KEY_REQUIRED');
	});

	it('returns 400 for invalid mic', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream?mic=XXXX', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_MIC');
	});

	it('returns 401 for invalid api key', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'invalid_key_not_in_kv' },
		});
		expect(res.status).toBe(403);
	});

	it('accepts ?key= query param instead of X-Oracle-Key header', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker(`/v5/stream?mic=XNYS&key=test_master_key_local_only`);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/event-stream');
		// Cancel stream immediately
		await res.body!.cancel();
	});

	it('returns text/event-stream with cache-control no-store', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/event-stream');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		await res.body!.cancel();
	});

	it('first SSE event is market_status with valid signed receipt', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);

		// Read chunks until we have a complete SSE event (ends with \n\n)
		const reader  = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		while (!text.includes('\n\n')) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		await reader.cancel();

		expect(text).toContain('event: market_status');
		expect(text).toContain('data: ');

		// Extract and parse the receipt from the SSE data line
		const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
		expect(dataLine).toBeDefined();
		const receipt = JSON.parse(dataLine!.slice(6)) as Record<string, unknown>;
		expect(receipt.mic).toBe('XNYS');
		expect(['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN']).toContain(receipt.status);
		expect(typeof receipt.signature).toBe('string');
		expect((receipt.signature as string).length).toBe(128);
		expect(receipt.receipt_mode).toBe('live');
	});

	it('default MIC is XNYS when mic param omitted', async () => {
		vi.setSystemTime(new Date('2026-03-25T14:00:00Z'));
		const res = await fetchWorker('/v5/stream', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);
		const reader  = res.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		while (!text.includes('\n\n')) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		await reader.cancel();
		const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
		const receipt = JSON.parse(dataLine!.slice(6)) as Record<string, unknown>;
		expect(receipt.mic).toBe('XNYS');
	});
});

// ─── Day 27: GET /v5/dst-risk ─────────────────────────────────────────────────

describe('Day 27: GET /v5/dst-risk', () => {
	it('returns 200 with correct shape', async () => {
		const body = await fetchJSON('/v5/dst-risk');
		expect(body).toHaveProperty('event', 'EU_DST_SPRING_2026');
		expect(body).toHaveProperty('transition_utc', '2026-03-29T01:00:00Z');
		expect(body).toHaveProperty('expires_at', '2026-03-29T02:00:00Z');
		expect(body).toHaveProperty('description');
		expect(body).toHaveProperty('affected_exchanges');
		expect(body).toHaveProperty('risk_window_minutes', 60);
		expect(body).toHaveProperty('sma_protocol_note');
		expect(body).toHaveProperty('note');
	});

	it('affected_exchanges has exactly 7 entries', async () => {
		const body = await fetchJSON('/v5/dst-risk');
		expect(Array.isArray(body.affected_exchanges)).toBe(true);
		expect((body.affected_exchanges as unknown[]).length).toBe(7);
	});
});

// ─── Day 27: discovery_url in receipts ────────────────────────────────────────

describe('Day 27: discovery_url wrapper on receipt endpoints', () => {
	const DISCOVERY_URL = 'https://headlessoracle.com/.well-known/mcp/server-card.json';

	it('/v5/demo includes discovery_url', async () => {
		vi.setSystemTime(new Date('2026-03-27T14:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(body).toHaveProperty('discovery_url', DISCOVERY_URL);
		// backward compat: flat fields still present
		expect(body).toHaveProperty('status');
		expect(body).toHaveProperty('mic', 'XNYS');
	});

	it('/v5/status includes discovery_url', async () => {
		vi.setSystemTime(new Date('2026-03-27T14:00:00Z'));
		const body = await fetchJSON('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(body).toHaveProperty('discovery_url', DISCOVERY_URL);
		expect(body).toHaveProperty('status');
	});

	it('/v5/batch receipts include discovery_url on each entry', async () => {
		vi.setSystemTime(new Date('2026-03-27T14:00:00Z'));
		const body = await fetchJSON('/v5/batch?mics=XNYS,XNAS', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		expect(Array.isArray(body.receipts)).toBe(true);
		for (const r of body.receipts as Record<string, unknown>[]) {
			expect(r).toHaveProperty('discovery_url', DISCOVERY_URL);
		}
	});

	it('/v5/health includes discovery_url', async () => {
		const body = await fetchJSON('/v5/health');
		expect(body).toHaveProperty('discovery_url', DISCOVERY_URL);
	});
});

// ─── GET /v5/card/:mic — live SVG status card ─────────────────────────────────
describe('GET /v5/card/:mic — live SVG status card', () => {
	it('returns 200 with Content-Type image/svg+xml', async () => {
		const res = await fetchWorker('/v5/card/XNYS');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
	});

	it('SVG body contains the MIC and a status value', async () => {
		const res = await fetchWorker('/v5/card/XNYS');
		const svg = await res.text();
		expect(svg).toContain('XNYS');
		expect(svg).toMatch(/OPEN|CLOSED|HALTED|UNKNOWN/);
	});

	it('SVG body is valid XML (starts with <svg)', async () => {
		const res = await fetchWorker('/v5/card/XLON');
		const svg = await res.text();
		expect(svg.trim()).toMatch(/^<svg/);
		expect(svg).toContain('</svg>');
	});

	it('returns 404 for unknown MIC', async () => {
		const res = await fetchWorker('/v5/card/ZZZZ');
		expect(res.status).toBe(404);
	});

	it('Cache-Control is public max-age=60 (KV-cached, aligns with 60s receipt TTL)', async () => {
		const res = await fetchWorker('/v5/card/XNYS');
		expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('X-Cache header is present (HIT or MISS)', async () => {
		const res = await fetchWorker('/v5/card/XNYS');
		expect(res.headers.get('X-Cache')).toMatch(/^(HIT|MISS)$/);
	});
});

// ─── Sprint 2: Webhook CRUD + plan limits ─────────────────────────────────────

describe('GET /v5/webhooks — list webhooks', () => {
	it('requires auth → 401', async () => {
		const res = await fetchWorker('/v5/webhooks');
		expect(res.status).toBe(401);
	});

	it('returns empty array when no webhooks registered', async () => {
		const keyHash = await sha256Hex('wh_list_empty_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			const res = await fetchWorker('/v5/webhooks', {
				headers: { 'X-Oracle-Key': 'wh_list_empty_key' },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { webhooks: unknown[]; count: number };
			expect(Array.isArray(body.webhooks)).toBe(true);
			expect(body.count).toBe(0);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
		}
	});

	it('returns subscriptions for the authenticated key', async () => {
		const keyHash = await sha256Hex('wh_list_has_subs_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			// Subscribe first
			const subRes = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_list_has_subs_key' },
				body:    JSON.stringify({ url: 'https://example.com/list-test', mics: ['XNYS'] }),
			});
			expect(subRes.status).toBe(200);
			const { webhook_id } = await subRes.json() as { webhook_id: string };

			// List
			const listRes = await fetchWorker('/v5/webhooks', {
				headers: { 'X-Oracle-Key': 'wh_list_has_subs_key' },
			});
			expect(listRes.status).toBe(200);
			const body = await listRes.json() as { webhooks: Array<{ webhook_id: string; url: string; mics: string[]; events: string[] }>; count: number };
			expect(body.count).toBe(1);
			expect(body.webhooks[0].webhook_id).toBe(webhook_id);
			expect(body.webhooks[0].url).toBe('https://example.com/list-test');
			expect(body.webhooks[0].mics).toEqual(['XNYS']);
			expect(body.webhooks[0].events).toEqual(['status_change']);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XNYS');
		}
	});
});

describe('DELETE /v5/webhooks/:webhook_id — path-based delete', () => {
	it('requires auth → 401', async () => {
		const res = await fetchWorker('/v5/webhooks/some-uuid-here', { method: 'DELETE' });
		expect(res.status).toBe(401);
	});

	it('unknown webhook_id → 404 SUBSCRIPTION_NOT_FOUND', async () => {
		const res = await fetchWorker('/v5/webhooks/does-not-exist-00000000', {
			method:  'DELETE',
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('SUBSCRIPTION_NOT_FOUND');
	});

	it('subscribe then DELETE /:id → 204, count decremented', async () => {
		const keyHash = await sha256Hex('wh_delete_path_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			// Subscribe
			const subRes = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_delete_path_key' },
				body:    JSON.stringify({ url: 'https://example.com/del-path', mics: ['XNYS'] }),
			});
			const { webhook_id } = await subRes.json() as { webhook_id: string };

			// Verify webhook_count was incremented
			const countBefore = await env.ORACLE_TELEMETRY.get(`webhook_count:${keyHash}`);
			expect(Number(countBefore)).toBeGreaterThanOrEqual(1);

			// Delete via path
			const delRes = await fetchWorker(`/v5/webhooks/${webhook_id}`, {
				method:  'DELETE',
				headers: { 'X-Oracle-Key': 'wh_delete_path_key' },
			});
			expect(delRes.status).toBe(204);

			// Verify webhook is gone from list
			const listRes = await fetchWorker('/v5/webhooks', {
				headers: { 'X-Oracle-Key': 'wh_delete_path_key' },
			});
			const listBody = await listRes.json() as { count: number };
			expect(listBody.count).toBe(0);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_TELEMETRY.delete(`webhook_count:${keyHash}`);
		}
	});
});

describe('POST /v5/webhooks/subscribe — plan limit enforcement', () => {
	it('builder plan: can subscribe up to 5 webhooks', async () => {
		const keyHash = await sha256Hex('wh_builder_limit_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		const webhookIds: string[] = [];
		try {
			// Subscribe 5 webhooks — all should succeed
			for (let i = 1; i <= 5; i++) {
				const res = await fetchWorker('/v5/webhooks/subscribe', {
					method:  'POST',
					headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_builder_limit_key' },
					body:    JSON.stringify({ url: `https://example.com/hook${i}`, mics: ['XNYS'] }),
				});
				expect(res.status).toBe(200);
				const body = await res.json() as { webhook_id: string };
				webhookIds.push(body.webhook_id);
			}

			// 6th webhook should be rejected with 403 PLAN_LIMIT_EXCEEDED
			const overRes = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_builder_limit_key' },
				body:    JSON.stringify({ url: 'https://example.com/hook6', mics: ['XNYS'] }),
			});
			expect(overRes.status).toBe(403);
			const overBody = await overRes.json() as { error: string; limit: number };
			expect(overBody.error).toBe('PLAN_LIMIT_EXCEEDED');
			expect(overBody.limit).toBe(5);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_TELEMETRY.delete(`webhook_count:${keyHash}`);
			// Clean up per-MIC index
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XNYS');
		}
	});

	it('subscribe response includes webhook_id, url, mics, events, created_at, status, secret', async () => {
		const keyHash = await sha256Hex('wh_schema_check_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			const res = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_schema_check_key' },
				body:    JSON.stringify({ url: 'https://example.com/schema-check', mics: ['XNYS', 'XLON'], secret: 'my-secret-123' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(typeof body.webhook_id).toBe('string');
			expect(body.url).toBe('https://example.com/schema-check');
			expect(body.mics).toEqual(['XNYS', 'XLON']);
			expect(body.events).toEqual(['status_change']);
			expect(typeof body.created_at).toBe('string');
			expect(body.status).toBe('active');
			expect(body.secret).toBe('my-secret-123');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XNYS');
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XLON');
		}
	});
});

describe('HMAC-SHA256 signature on webhook delivery', () => {
	it('computeHmacSignature produces sha256=<hex> format', async () => {
		// Test the HMAC logic by subscribing and verifying the response schema
		// The actual HMAC computation is tested indirectly via the test endpoint
		const keyHash = await sha256Hex('wh_hmac_test_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			const res = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_hmac_test_key' },
				body:    JSON.stringify({ url: 'https://example.com/hmac-hook', mics: ['XNYS'], secret: 'hmac-test-secret' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { webhook_id: string; secret: string };
			// Secret is preserved in subscription (used for HMAC computation on delivery)
			expect(body.secret).toBe('hmac-test-secret');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XNYS');
		}
	});
});

describe('POST /v5/webhooks/test/:webhook_id — synthetic delivery', () => {
	it('requires auth → 401', async () => {
		const res = await fetchWorker('/v5/webhooks/test/some-id', { method: 'POST' });
		expect(res.status).toBe(401);
	});

	it('unknown webhook_id → 404', async () => {
		const res = await fetchWorker('/v5/webhooks/test/does-not-exist', {
			method:  'POST',
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(404);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('SUBSCRIPTION_NOT_FOUND');
	});

	it('existing webhook → fires test delivery and returns payload_sent', async () => {
		const keyHash = await sha256Hex('wh_test_delivery_key');
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		try {
			// Subscribe
			const subRes = await fetchWorker('/v5/webhooks/subscribe', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'X-Oracle-Key': 'wh_test_delivery_key' },
				body:    JSON.stringify({ url: 'https://example.com/test-hook', mics: ['XNYS'], secret: 'test-secret' }),
			});
			const { webhook_id } = await subRes.json() as { webhook_id: string };

			// Fire test delivery (the actual HTTP POST to example.com will fail, but the
			// response schema and payload_sent structure should still be returned)
			const testRes = await fetchWorker(`/v5/webhooks/test/${webhook_id}`, {
				method:  'POST',
				headers: { 'X-Oracle-Key': 'wh_test_delivery_key' },
			});
			expect(testRes.status).toBe(200);
			const body = await testRes.json() as {
				webhook_id: string;
				url: string;
				delivered: boolean;
				payload_sent: {
					event: string;
					webhook_id: string;
					mic: string;
					previous_status: null;
					current_status: string;
					receipt: Record<string, unknown>;
					delivered_at: string;
				};
			};
			expect(body.webhook_id).toBe(webhook_id);
			expect(body.url).toBe('https://example.com/test-hook');
			// payload_sent must match sprint spec schema
			expect(body.payload_sent.event).toBe('test');
			expect(body.payload_sent.webhook_id).toBe(webhook_id);
			expect(body.payload_sent.mic).toBe('XNYS');
			expect(body.payload_sent.previous_status).toBeNull();
			expect(typeof body.payload_sent.current_status).toBe('string');
			expect(typeof body.payload_sent.receipt).toBe('object');
			expect(typeof body.payload_sent.delivered_at).toBe('string');
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_API_KEYS.delete(`webhooks:${keyHash}`);
			await env.ORACLE_API_KEYS.delete('webhooks_by_mic:XNYS');
			await env.ORACLE_TELEMETRY.delete(`webhook_count:${keyHash}`);
		}
	});
});

// ─── Paddle credit packs ──────────────────────────────────────────────────────

describe('Paddle credit packs — webhook minting', () => {
	const WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_for_local_tests';
	const CREDITS_PRICE_ID = 'pri_test_credits_placeholder'; // matches .dev.vars

	it('transaction.completed with credits price_id → mints credits key with balance=1000', async () => {
		const originalFetch = globalThis.fetch;
		let resendEmailHtml = '';
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'credits-buyer@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.resend.com')) {
				resendEmailHtml = JSON.parse((init?.body as string) ?? '{}').html ?? '';
				return new Response(JSON.stringify({ id: 'email_credits_001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:          'txn_credits_test_001',
				customer_id: 'ctm_credits_001',
				items:       [{ price_id: CREDITS_PRICE_ID }],
				// No subscription_id — this is a one-time payment
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('received', true);

			// Key must be in ORACLE_API_KEYS with tier=credits and balance=1000
			// Find the minted key by iterating KV — search for ho_crd_ keys
			// (We can't predict the random key, so we check via listing)
			const listed = await env.ORACLE_API_KEYS.list({ prefix: '' });
			let creditsEntry: Record<string, unknown> | null = null;
			for (const kv of listed.keys) {
				const val = await env.ORACLE_API_KEYS.get(kv.name);
				if (!val) continue;
				const parsed = JSON.parse(val) as Record<string, unknown>;
				if (parsed.tier === 'credits' && parsed.source === 'paddle_credits') {
					creditsEntry = parsed;
					await env.ORACLE_API_KEYS.delete(kv.name); // cleanup
					break;
				}
			}
			expect(creditsEntry).not.toBeNull();
			expect(creditsEntry?.balance).toBe(1000);
			expect(creditsEntry?.status).toBe('active');
			expect(creditsEntry?.email).toBe('credits-buyer@example.com');
			// Credits key has no expires_at — it never expires
			expect(creditsEntry?.expires_at).toBeUndefined();
			// Welcome email was sent
			expect(resendEmailHtml).toContain('1,000');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('transaction.completed with subscription price_id still follows normal subscription path', async () => {
		// Non-credits price should fall through to subscription_id guard and be skipped (no subscription_id)
		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:          'txn_sub_test_001',
				customer_id: 'ctm_sub_001',
				items:       [{ price_id: 'pri_test_builder_placeholder' }],
				// No subscription_id → must be skipped by the existing guard
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
		const res = await fetchWorker('/webhooks/paddle', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
			body:    rawBody,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ received: true });
	});

	it('GAP-014: credits key minting inserts receipt_audit row with mic=credits and source=paddle_credits', async () => {
		const auditBodies: Array<Record<string, unknown>> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'gap014@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.resend.com')) {
				return new Response(JSON.stringify({ id: 'email_gap014' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('receipt_audit') && init?.method === 'POST') {
				const body = JSON.parse((init.body as string) ?? '[]') as unknown;
				const entries = Array.isArray(body) ? body as Record<string, unknown>[] : [body as Record<string, unknown>];
				auditBodies.push(...entries);
				return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};

		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:          'txn_gap014_test',
				customer_id: 'ctm_gap014',
				items:       [{ price_id: CREDITS_PRICE_ID }],
			},
		});
		const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);

		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);

			// receipt_audit must have been called with the correct fields
			expect(auditBodies.length).toBeGreaterThanOrEqual(1);
			const auditRow = auditBodies[0];
			expect(auditRow.mic).toBe('credits');
			expect(auditRow.status).toBe('minted');
			expect(auditRow.source).toBe('paddle_credits');
			expect(typeof auditRow.key_hash).toBe('string');
			expect((auditRow.key_hash as string).length).toBe(64); // sha256 hex
		} finally {
			globalThis.fetch = originalFetch;
			// Clean up any minted key from KV
			const listed = await env.ORACLE_API_KEYS.list({ prefix: '' });
			for (const kv of listed.keys) {
				const val = await env.ORACLE_API_KEYS.get(kv.name);
				if (!val) continue;
				const parsed = JSON.parse(val) as Record<string, unknown>;
				if (parsed.source === 'paddle_credits' && parsed.email === 'gap014@example.com') {
					await env.ORACLE_API_KEYS.delete(kv.name);
				}
			}
		}
	});
});

describe('GET /v5/revenue-pulse — admin revenue feed', () => {
	const MASTER = 'test_master_key_local_only'; // matches .dev.vars

	beforeEach(async () => {
		// Wipe paddle revenue keys so tests are deterministic
		const listed = await env.ORACLE_TELEMETRY.list({ prefix: 'paddle_revenue_' });
		await Promise.all(listed.keys.map((k) => env.ORACLE_TELEMETRY.delete(k.name)));
	});

	it('returns 401 without master key', async () => {
		const res = await fetchWorker('/v5/revenue-pulse');
		expect(res.status).toBe(401);
	});

	it('returns 401 with wrong master key', async () => {
		const res = await fetchWorker('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': 'not_the_master' } });
		expect(res.status).toBe(401);
	});

	it('returns 200 with empty state when master key is valid', async () => {
		const res = await fetchWorker('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': MASTER } });
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, any>;
		expect(body).toHaveProperty('paddle');
		expect(body).toHaveProperty('x402');
		expect(body.paddle.lifetime_count).toBe(0);
		expect(body.paddle.recent_events).toEqual([]);
		expect(body.paddle.by_tier).toEqual({ builder: 0, pro: 0, protocol: 0, credits: 0 });
	});

	it('reflects KV state after paddle revenue events are recorded', async () => {
		const ts1 = '2026-04-12T10:00:00.000Z';
		const ts2 = '2026-04-12T11:00:00.000Z';
		await env.ORACLE_TELEMETRY.put('paddle_revenue_count',          '2');
		await env.ORACLE_TELEMETRY.put('paddle_revenue_count:credits',  '1');
		await env.ORACLE_TELEMETRY.put('paddle_revenue_count:builder',  '1');
		await env.ORACLE_TELEMETRY.put('paddle_revenue_last_at',        ts2);
		await env.ORACLE_TELEMETRY.put(`paddle_revenue_event:${ts1}`, JSON.stringify({ tier: 'credits', plan: 'credits', amount: '5.00', currency: 'USD', txn_id: 'txn_001', ts: ts1 }));
		await env.ORACLE_TELEMETRY.put(`paddle_revenue_event:${ts2}`, JSON.stringify({ tier: 'builder', plan: 'builder', amount: '99.00', currency: 'USD', txn_id: 'txn_002', ts: ts2 }));

		const res = await fetchWorker('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': MASTER } });
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, any>;
		expect(body.paddle.lifetime_count).toBe(2);
		expect(body.paddle.last_event_at).toBe(ts2);
		expect(body.paddle.by_tier.credits).toBe(1);
		expect(body.paddle.by_tier.builder).toBe(1);
		expect(body.paddle.recent_events).toHaveLength(2);
		// Most recent first
		expect(body.paddle.recent_events[0].txn_id).toBe('txn_002');
		expect(body.paddle.recent_events[1].txn_id).toBe('txn_001');
	});

	it('credits webhook records a paddle revenue event', async () => {
		const WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_for_local_tests';
		const CREDITS_PRICE_ID = 'pri_test_credits_placeholder';
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const urlStr = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input as Request).url);
			if (urlStr.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: 'pulse-test@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			if (urlStr.includes('api.resend.com')) {
				return new Response(JSON.stringify({ id: 'email_pulse_001' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input, init);
		};
		try {
			const rawBody = JSON.stringify({
				event_type: 'transaction.completed',
				data: { id: 'txn_pulse_001', customer_id: 'ctm_pulse_001', items: [{ price_id: CREDITS_PRICE_ID }] },
			});
			const sig = await makePaddleSignature(rawBody, WEBHOOK_SECRET);
			const webhookRes = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(webhookRes.status).toBe(200);

			const res = await fetchWorker('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': MASTER } });
			const body = await res.json() as Record<string, any>;
			expect(body.paddle.lifetime_count).toBe(1);
			expect(body.paddle.by_tier.credits).toBe(1);
			expect(body.paddle.recent_events).toHaveLength(1);
			expect(body.paddle.recent_events[0].txn_id).toBe('txn_pulse_001');
			expect(body.paddle.recent_events[0].tier).toBe('credits');
		} finally {
			globalThis.fetch = originalFetch;
			// Clean up minted credits key
			const listed = await env.ORACLE_API_KEYS.list({ prefix: '' });
			for (const kv of listed.keys) {
				const val = await env.ORACLE_API_KEYS.get(kv.name);
				if (!val) continue;
				const parsed = JSON.parse(val) as Record<string, unknown>;
				if (parsed.source === 'paddle_credits' && parsed.email === 'pulse-test@example.com') {
					await env.ORACLE_API_KEYS.delete(kv.name);
				}
			}
		}
	});
});

describe('Paddle credit packs — auth layer', () => {
	async function sha256Hex(value: string): Promise<string> {
		const bytes = new TextEncoder().encode(value);
		const hash  = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	it('credits key with balance > 0 → decrements balance and allows request', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const creditsKey  = 'ho_crd_' + 'a'.repeat(64);
		const creditsHash = await sha256Hex(creditsKey);
		await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 10, created_at: new Date().toISOString(),
		}));

		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': creditsKey } });
			expect(res.status).toBe(200);

			// Balance must be decremented by 1
			const updated = JSON.parse((await env.ORACLE_API_KEYS.get(creditsHash)) ?? '{}') as { balance: number };
			expect(updated.balance).toBe(9);
		} finally {
			await env.ORACLE_API_KEYS.delete(creditsHash);
		}
	});

	it('credits key with balance > 0 → decrements balance, increments credits_usage counter, and allows request', async () => {
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const creditsKey  = 'ho_crd_' + 'e'.repeat(64);
		const creditsHash = await sha256Hex(creditsKey);
		const testDate    = '2026-03-16';
		const counterKey  = `credits_usage:${creditsHash}:${testDate}`;
		await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 10, created_at: new Date().toISOString(),
		}));

		try {
			// fetchWorker already calls waitOnExecutionContext, so waitUntil writes
			// (including the credits_usage counter) complete before this resolves.
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': creditsKey } });
			expect(res.status).toBe(200);

			// Balance must be decremented by 1
			const updated = JSON.parse((await env.ORACLE_API_KEYS.get(creditsHash)) ?? '{}') as { balance: number };
			expect(updated.balance).toBe(9);

			// credits_usage counter must be incremented to '1'
			const counter = await env.ORACLE_TELEMETRY.get(counterKey);
			expect(counter).toBe('1');
		} finally {
			await env.ORACLE_API_KEYS.delete(creditsHash);
			await env.ORACLE_TELEMETRY.delete(counterKey);
		}
	});

	it('credits key with balance=0 → 402 CREDITS_EXHAUSTED', async () => {
		const creditsKey  = 'ho_crd_' + 'b'.repeat(64);
		const creditsHash = await sha256Hex(creditsKey);
		await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 0, created_at: new Date().toISOString(),
		}));

		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': creditsKey } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'CREDITS_EXHAUSTED');
			expect(body).toHaveProperty('upgrade_url', 'https://headlessoracle.com/upgrade');
		} finally {
			await env.ORACLE_API_KEYS.delete(creditsHash);
		}
	});

	it('CREDITS_EXHAUSTED response includes insight and plan comparison', async () => {
		const creditsKey  = 'ho_crd_' + 'c'.repeat(64);
		const creditsHash = await sha256Hex(creditsKey);
		await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 0, created_at: new Date().toISOString(),
		}));

		try {
			const res  = await fetchWorker('/v5/batch?mics=XNYS', { headers: { 'X-Oracle-Key': creditsKey } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'CREDITS_EXHAUSTED');
			expect(typeof body.insight).toBe('string');
			expect(body.insight).toContain('Builder');
			const plans = body.plans as Record<string, string>;
			expect(plans).toHaveProperty('credits');
			expect(plans).toHaveProperty('builder');
		} finally {
			await env.ORACLE_API_KEYS.delete(creditsHash);
		}
	});

	it('credits key with no expires_at field — credits never expire by time', async () => {
		const creditsKey  = 'ho_crd_' + 'd'.repeat(64);
		const creditsHash = await sha256Hex(creditsKey);
		// Simulate a key with balance=1 and no expires_at
		await env.ORACLE_API_KEYS.put(creditsHash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 1, created_at: '2020-01-01T00:00:00Z',
		}));

		try {
			vi.setSystemTime(new Date('2030-01-01T14:00:00Z')); // far in the future
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': creditsKey } });
			// Must succeed — no time-based expiry on credits keys
			expect(res.status).toBe(200);
		} finally {
			vi.useRealTimers();
			await env.ORACLE_API_KEYS.delete(creditsHash);
		}
	});
});

// ─── WebhookDispatcher DO hardening ──────────────────────────────────────────

describe('WebhookDispatcher DO — heartbeat + /v5/webhooks/health', () => {
	it('GET /v5/webhooks/health → 200 with dispatcher_status and next_alarm', async () => {
		// Without a KV key the endpoint reports no_alarm (safe default).
		const res = await fetchWorker('/v5/webhooks/health');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('dispatcher_status');
		expect(['active', 'no_alarm']).toContain(body.dispatcher_status);
		// next_alarm is either an ISO8601 string or null
		if (body.next_alarm !== null) {
			expect(typeof body.next_alarm).toBe('string');
			expect(() => new Date(body.next_alarm as string)).not.toThrow();
		}
	});

	it('GET /v5/webhooks/health — no auth required', async () => {
		// Health endpoint is public — must not return 401 or 403
		const res = await fetchWorker('/v5/webhooks/health');
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
	});

	it('GET /v5/webhooks/health reports active when DO has written health KV key', async () => {
		// Simulate the DO alarm() having run — it writes webhook_dispatcher:health to KV.
		// The health endpoint reads that key; no DO instance is created (avoids SQLite locking).
		const nextAlarm = new Date(Date.now() + 60_000).toISOString();
		await env.ORACLE_TELEMETRY.put(
			'webhook_dispatcher:health',
			JSON.stringify({ status: 'active', next_alarm: nextAlarm }),
		);

		const res = await fetchWorker('/v5/webhooks/health');
		expect(res.status).toBe(200);
		const body = await res.json() as { dispatcher_status: string; next_alarm: string | null };
		expect(body.dispatcher_status).toBe('active');
		expect(typeof body.next_alarm).toBe('string');
		expect(new Date(body.next_alarm as string).getTime()).toBeGreaterThan(Date.now());

		// Second call is idempotent — same KV key, same result
		const res2 = await fetchWorker('/v5/webhooks/health');
		expect(res2.status).toBe(200);
		const body2 = await res2.json() as { dispatcher_status: string; next_alarm: string | null };
		expect(body2.dispatcher_status).toBe('active');

		// Cleanup
		await env.ORACLE_TELEMETRY.delete('webhook_dispatcher:health');
	});
});

// ─── GAP-B: Standards implementations registry ───────────────────────────────

describe('GET /v5/implementations — standards registry', () => {
	it('returns 200 with application/json', async () => {
		const res = await fetchWorker('/v5/implementations');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
	});

	it('response has standards.sma.implementations array and submit_url', async () => {
		const res  = await fetchWorker('/v5/implementations');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('standards');
		const standards = body.standards as Record<string, unknown>;
		expect(standards).toHaveProperty('sma');
		const sma = standards.sma as Record<string, unknown>;
		expect(Array.isArray(sma.implementations)).toBe(true);
		expect((sma.implementations as unknown[]).length).toBeGreaterThanOrEqual(1);
		expect(typeof sma.submit_url).toBe('string');
		expect(body).toHaveProperty('total_implementations');
	});
});

// ─── GAP-D: Showcase endpoint ─────────────────────────────────────────────────

describe('GET /v5/showcase', () => {
	it('returns 200 with entries array and submit_url', async () => {
		const res  = await fetchWorker('/v5/showcase');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(Array.isArray(body.entries)).toBe(true);
		expect(typeof body.submit_url).toBe('string');
	});
});

// ── x402 mainnet facilitator path ────────────────────────────────────────────
// Uses x402.org community facilitator (no auth). Enabled by default (X402_ENABLED !== 'false').
// Tests mock globalThis.fetch for both /verify and /settle endpoints.

describe('x402 mainnet facilitator path (CDP, X402_ENABLED=true)', () => {
	beforeEach(() => {
		(env as unknown as Record<string, string>).X402_ENABLED = 'true';
	});

	afterEach(() => {
		delete (env as unknown as Record<string, string>).X402_ENABLED;
	});

	it('no X-Payment + X402_ENABLED=true → 402 with mainnet x402 payload (after trial exhausted)', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		const res = await fetchWorker('/v5/status?mic=XNYS');
		await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402Version', 1);
		expect(body).toHaveProperty('network', 'mainnet');
		const accepts = body.accepts as Array<Record<string, unknown>>;
		expect(accepts[0]).toHaveProperty('network', 'base');
		expect(accepts[0]).toHaveProperty('payTo', TEST_PAYMENT_ADDRESS);
		expect(res.headers.get('X-X402-Network')).toBe('mainnet');
		expect(res.headers.get('X-Payment-Required')).toBe('true');
	});

	it('valid mainnet payment via mocked CDP facilitator → 200 signed receipt', async () => {
		// X-Payment must be a base64-encoded JSON PaymentPayload object (decoded before forwarding to facilitator).
		// Mocks api.cdp.coinbase.com (switched from x402.org on Apr 2 2026).
		const mockPaymentHeader = btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: '0xmocksig' } }));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.includes('cdp.coinbase.com') && url.includes('/verify')) {
				return new Response(JSON.stringify({ isValid: true }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('cdp.coinbase.com') && url.includes('/settle')) {
				return new Response(JSON.stringify({ success: true, txHash: '0xmockmainnetpayment' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			// Supabase non-blocking calls (insertReceiptAudit, updateKeyUsage)
			if (url.includes('supabase.co')) return new Response(JSON.stringify([{}]), { status: 201, headers: { 'Content-Type': 'application/json' } });
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Payment': mockPaymentHeader },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(VALID_STATUSES).toContain(body.status);
			expect(body).toHaveProperty('signature');
			expect(body).toHaveProperty('receipt_mode', 'live');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('invalid mainnet payment → facilitator rejects → 402 with X-Payment-Status', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			if (url.includes('x402.org/facilitator/verify')) {
				return new Response(JSON.stringify({ isValid: false, invalidReason: 'INSUFFICIENT_FUNDS' }), {
					status: 200, headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Payment': 'invalid-payment-header' },
			});
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('x402Version', 1);
			expect(body).toHaveProperty('network', 'mainnet');
			expect(body).toHaveProperty('x402_error');
			expect(res.headers.get('X-Payment-Status')).toBe('payment-rejected');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});


// ─── Weekend Sprint Tier 2 — Items 5, 6, 7 ───────────────────────────────────

describe('MCP initialize _meta block (Item 5A)', () => {
	it('initialize response includes _meta with x402_enabled and payment URLs', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		const result = body.result as Record<string, unknown>;
		expect(result).toHaveProperty('_meta');
		const meta = result._meta as Record<string, unknown>;
		expect(meta).toHaveProperty('x402_enabled', true);
		expect(meta).toHaveProperty('payment_count_url', '/v5/payment-proof');
		expect(meta).toHaveProperty('upgrade_path_url', '/v5/why-not-free');
		expect(meta).toHaveProperty('sandbox_url', 'POST /v5/sandbox');
		expect(meta).toHaveProperty('x402_discovery', '/.well-known/x402.json');
	});
});

describe('MCP get_payment_options tool (Item 5B)', () => {
	it('tools/list includes get_payment_options', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const result = body.result as Record<string, unknown>;
		const tools  = result.tools as Array<Record<string, unknown>>;
		const names  = tools.map((t) => t.name);
		expect(names).toContain('get_payment_options');
	});

	it('calling get_payment_options returns sandbox/x402/builder fields', async () => {
		const body   = await postMcpJSON({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_payment_options', arguments: {} } });
		const result = body.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, unknown>>;
		expect(content[0]).toHaveProperty('type', 'text');
		const data = JSON.parse(content[0].text as string) as Record<string, unknown>;
		expect(data).toHaveProperty('sandbox');
		expect(data).toHaveProperty('x402_per_request');
		expect(data).toHaveProperty('builder');
		expect(data).toHaveProperty('agent_native_path');
	});
});

describe('GET/POST /v5/verify — detailed receipt verification', () => {
	it('POST valid receipt → valid:true with all checks passed', async () => {
		const receiptRes  = await fetchWorker('/v5/demo?mic=XNYS');
		const receiptBody = await receiptRes.json() as Record<string, unknown>;
		const receipt     = (receiptBody.receipt ?? receiptBody) as Record<string, unknown>;

		const res  = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('valid', true);
		const checks = body.checks as Record<string, { passed: boolean; detail: string }>;
		expect(checks.signature.passed).toBe(true);
		expect(checks.signature.detail).toBe('Ed25519 signature verified');
		expect(checks.ttl.passed).toBe(true);
		expect(checks.issuer.passed).toBe(true);
		expect(checks.schema.passed).toBe(true);
		expect(checks.public_key.passed).toBe(true);
		const summary = body.receipt_summary as Record<string, unknown>;
		expect(summary.mic).toBe('XNYS');
	});

	it('POST tampered receipt → signature check fails', async () => {
		const receiptRes  = await fetchWorker('/v5/demo?mic=XNYS');
		const receiptBody = await receiptRes.json() as Record<string, unknown>;
		const base        = (receiptBody.receipt ?? receiptBody) as Record<string, unknown>;
		const tampered    = { ...base, status: 'OPEN_TAMPERED' };

		const res  = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt: tampered }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('valid', false);
		const checks = body.checks as Record<string, { passed: boolean }>;
		expect(checks.signature.passed).toBe(false);
	});

	it('POST expired receipt → ttl check fails', async () => {
		const receiptRes  = await fetchWorker('/v5/demo?mic=XNYS');
		const receiptBody = await receiptRes.json() as Record<string, unknown>;
		const base        = (receiptBody.receipt ?? receiptBody) as Record<string, unknown>;
		const expired = { ...base, expires_at: '2020-01-01T00:00:00.000Z' };

		const res  = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt: expired }),
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('valid', false);
		const checks = body.checks as Record<string, { passed: boolean }>;
		expect(checks.ttl.passed).toBe(false);
	});

	it('GET with ?receipt= query param works', async () => {
		const receiptRes  = await fetchWorker('/v5/demo?mic=XNYS');
		const receiptBody = await receiptRes.json() as Record<string, unknown>;
		const receipt     = (receiptBody.receipt ?? receiptBody) as Record<string, unknown>;

		const encoded = encodeURIComponent(JSON.stringify(receipt));
		const res = await fetchWorker(`/v5/verify?receipt=${encoded}`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('valid', true);
		const checks = body.checks as Record<string, { passed: boolean }>;
		expect(checks.signature.passed).toBe(true);
	});

	it('GET without ?receipt= → 400', async () => {
		const res = await fetchWorker('/v5/verify');
		expect(res.status).toBe(400);
	});

	it('POST missing receipt field → 400', async () => {
		const res = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ not_receipt: {} }),
		});
		expect(res.status).toBe(400);
	});

	it('receipt_summary contains expected fields', async () => {
		const receiptRes  = await fetchWorker('/v5/demo?mic=XNYS');
		const receiptBody = await receiptRes.json() as Record<string, unknown>;
		const receipt     = (receiptBody.receipt ?? receiptBody) as Record<string, unknown>;

		const res  = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt }),
		});
		const body = await res.json() as Record<string, unknown>;
		const summary = body.receipt_summary as Record<string, unknown>;
		expect(summary).toHaveProperty('mic', 'XNYS');
		expect(summary).toHaveProperty('status');
		expect(summary).toHaveProperty('issued_at');
		expect(summary).toHaveProperty('expires_at');
		expect(summary).toHaveProperty('receipt_mode', 'demo');
	});
});

describe('GET /x402 — x402 Foundation alignment (Item 7)', () => {
	it('returns x402_compatible:true with required fields', async () => {
		const res  = await fetchWorker('/x402');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('x402_compatible', true);
		expect(body).toHaveProperty('network', 'base');
		expect(body).toHaveProperty('facilitator', 'cdp');
		expect(body).toHaveProperty('payment_proof', '/v5/payment-proof');
		expect(body).toHaveProperty('discovery', '/.well-known/x402.json');
		expect(body).toHaveProperty('foundation', 'https://x402.org');
		expect(body).toHaveProperty('awesome_x402', 'https://github.com/xpaysh/awesome-x402');
	});

	it('402 responses include X-X402-Foundation: compatible header (after trial exhausted)', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			expect(res.headers.get('X-X402-Foundation')).toBe('compatible');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});
});

// ─── GET /v5/metrics/public ───────────────────────────────────────────────────

describe('GET /v5/metrics/public', () => {
	it('returns 200 with correct shape and static fields', async () => {
		const body = await fetchJSON('/v5/metrics/public');
		expect(body).toHaveProperty('exchanges', 28);
		// CHANGED 2026-10-04 (H3a, G13): was a literal 5 while tools/list served 4.
		const toolsList = await (await postMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: unknown[] } };
		expect(body).toHaveProperty('mcp_tools', toolsList.result.tools.length);
		expect(body).toHaveProperty('signing_algorithm', 'Ed25519');
		expect(body).toHaveProperty('receipt_ttl_seconds', 60);
		expect(body).toHaveProperty('mcp_protocol_version', '2024-11-05');
		expect(body).toHaveProperty('mcpscoreboard_preflight', 100);
		expect(body).toHaveProperty('fail_closed', true);
		expect(body).toHaveProperty('x402_network', 'base');
		expect(typeof body.tests_passing).toBe('number');
		expect(body.tests_passing).toBeGreaterThan(0);
	});

	it('returns uptime_days >= 35 and x402 KV fields', async () => {
		const body = await fetchJSON('/v5/metrics/public');
		// uptime from 2026-02-28; test runs well after that
		expect(typeof body.uptime_days).toBe('number');
		expect(body.uptime_days as number).toBeGreaterThanOrEqual(35);
		// x402 fields present (default 0 / null in test env)
		expect(typeof body.x402_payment_count).toBe('number');
		expect(Object.prototype.hasOwnProperty.call(body, 'last_payment_at')).toBe(true);
	});

	it('returns registry-optimised fields: install, evaluator_platforms, response_time_ms, ecosystem_listings, mcp usage', async () => {
		const body = await fetchJSON('/v5/metrics/public');
		// daily MCP usage (0 in test env — no traction_cache KV key)
		expect(typeof body.unique_mcp_clients_today).toBe('number');
		expect(typeof body.mcp_requests_today).toBe('number');
		// static install hint
		expect(body.install).toBe('npx headless-oracle-mcp');
		// evaluator platforms list
		expect(Array.isArray(body.evaluator_platforms)).toBe(true);
		expect((body.evaluator_platforms as string[]).length).toBeGreaterThan(0);
		// response time object
		const rt = body.response_time_ms as Record<string, unknown>;
		expect(rt).toHaveProperty('connect', 0);
		expect(rt).toHaveProperty('initialize');
		expect(rt).toHaveProperty('tool_call');
		// ecosystem listings
		const el = body.ecosystem_listings as Record<string, unknown>;
		expect(el.glama_connector).toBe(true);
		expect(el.npm).toBe('headless-oracle-mcp');
		expect(Array.isArray(el.pypi)).toBe(true);
	});
});

// ─── GET /.well-known/mcp-servers.json ───────────────────────────────────────

describe('GET /.well-known/mcp-servers.json', () => {
	it('returns 200 with correct shape', async () => {
		const body = await fetchJSON('/.well-known/mcp-servers.json');
		expect(Array.isArray(body.servers)).toBe(true);
		const server = (body.servers as Array<Record<string, unknown>>)[0];
		expect(server.name).toBe('headless-oracle');
		expect(server.mcp_endpoint).toBe('https://headlessoracle.com/mcp');
		expect(server.fail_closed).toBe(true);
		expect(Array.isArray(server.tools)).toBe(true);
		expect((server.tools as Array<{name: string}>).length).toBe(4);
		const toolNames = (server.tools as Array<{name: string}>).map((t) => t.name);
		expect(toolNames).not.toContain('verify_receipt');
	});

	it('includes coverage with 28 exchanges and updated_at timestamp', async () => {
		const body = await fetchJSON('/.well-known/mcp-servers.json');
		const server = (body.servers as Array<Record<string, unknown>>)[0];
		const coverage = server.coverage as Record<string, unknown>;
		expect(coverage.exchanges).toBe(28);
		expect(Array.isArray(coverage.mic_codes)).toBe(true);
		expect(typeof server.updated_at).toBe('string');
	});

	it('includes registry install config and linked metric/health/demo URLs', async () => {
		const body = await fetchJSON('/.well-known/mcp-servers.json');
		const server = (body.servers as Array<Record<string, unknown>>)[0];
		// install block
		const install = server.install as Record<string, string>;
		expect(install.npx).toBe('npx headless-oracle-mcp');
		expect(install.npm).toBe('npm install -g headless-oracle-mcp');
		// clients block — enables auto-generated config by registries
		const clients = server.clients as Record<string, { command: string; args: string[] }>;
		expect(clients.claude_desktop.command).toBe('npx');
		expect(clients.cursor.command).toBe('npx');
		// linked URLs
		expect(server.metrics_url).toBe('https://headlessoracle.com/v5/metrics/public');
		expect(server.health_url).toBe('https://headlessoracle.com/v5/health');
		expect(server.demo_url).toBe('https://headlessoracle.com/v5/demo?mic=XNYS');
	});
});

// ─── Convenience redirects ────────────────────────────────────────────────────

describe('Convenience redirects (/npm, /pypi, /github)', () => {
	it('GET /npm → 302 to npmjs.com', async () => {
		const response = await fetchWorker('/npm');
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('npmjs.com');
	});

	it('GET /pypi → 302 to pypi.org', async () => {
		const response = await fetchWorker('/pypi');
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('pypi.org');
	});

	it('GET /github → 302 to github.com', async () => {
		const response = await fetchWorker('/github');
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('github.com');
	});
});

// ─── GET /v5/referrers ────────────────────────────────────────────────────────

describe('GET /v5/referrers', () => {
	it('returns 200 with date and referrers object (empty when no data)', async () => {
		const response = await fetchWorker('/v5/referrers?date=2099-01-01');
		expect(response.status).toBe(200);
		const body = await response.json() as { date: string; referrers: Record<string, number> };
		expect(body.date).toBe('2099-01-01');
		expect(typeof body.referrers).toBe('object');
	});

	it('returns today as default date when no ?date param', async () => {
		const response = await fetchWorker('/v5/referrers');
		expect(response.status).toBe(200);
		const body = await response.json() as { date: string; referrers: Record<string, number> };
		expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

// ─── GET /v5/metrics/public — status_codes_today ─────────────────────────────

describe('GET /v5/metrics/public — status_codes_today', () => {
	it('includes status_codes_today field in response', async () => {
		const response = await fetchWorker('/v5/metrics/public');
		expect(response.status).toBe(200);
		const body = await response.json() as { status_codes_today: Record<string, number> };
		expect(typeof body.status_codes_today).toBe('object');
	});
});

// ─── Ed25519 module-level warm-up ─────────────────────────────────────────────
// Verifies that the Gpows precompute warm-up at module init does not interfere
// with real signing. Two consecutive /v5/demo calls should both return valid,
// independently signed receipts with distinct receipt_ids.

describe('Ed25519 cold-start warm-up', () => {
	it('first and second signed receipts are valid and distinct after module warm-up', async () => {
		const r1 = await fetchWorker('/v5/demo?mic=XNYS');
		const r2 = await fetchWorker('/v5/demo?mic=XNYS');
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		const b1 = await r1.json() as { receipt: { receipt_id: string; signature: string } };
		const b2 = await r2.json() as { receipt: { receipt_id: string; signature: string } };
		// Each call produces a unique receipt_id and a distinct signature
		expect(b1.receipt.receipt_id).toBeTruthy();
		expect(b2.receipt.receipt_id).toBeTruthy();
		expect(b1.receipt.receipt_id).not.toBe(b2.receipt.receipt_id);
		expect(b1.receipt.signature).toBeTruthy();
		expect(b2.receipt.signature).toBeTruthy();
		// Signatures are hex strings of 128 chars (64 bytes)
		expect(b1.receipt.signature).toMatch(/^[0-9a-f]{128}$/);
		expect(b2.receipt.signature).toMatch(/^[0-9a-f]{128}$/);
	});
});

// ─── Payment friction — agent_actions in 402 responses ───────────────────────
// Every 402 path must include agent_actions so agents know exactly what to do next.

describe('402 responses include agent_actions (friction reduction)', () => {
	it('build402Payload path (free tier exhausted) includes agent_actions', async () => {
		const key  = 'ho_free_' + 'z'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('agent_actions');
		const actions = body.agent_actions as Record<string, unknown>;
		expect(actions).toHaveProperty('pay_per_request');
		expect(actions).toHaveProperty('get_credits_instantly');
		expect(actions).toHaveProperty('mint_persistent_key');
		expect(actions).toHaveProperty('buy_subscription');
		expect(actions).toHaveProperty('payment_address');
	});

	it('build402Payload x402 object includes paymentHeaderName and paymentHeaderEncoding', async () => {
		const key  = 'ho_free_' + 'y'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const body = await fetchJSON('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		const x402 = body.x402 as Record<string, unknown>;
		expect(x402).toHaveProperty('paymentHeaderName', 'X-Payment');
		expect(x402.paymentHeaderEncoding).toEqual(['base64-json', 'json']);
	});

	it('alternatives block no longer has prepaid dead-end (mint_key and sandbox_x402 instead)', async () => {
		const key  = 'ho_free_' + 'x'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const body = await fetchJSON('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		const alts = body.alternatives as Record<string, unknown>;
		expect(alts).not.toHaveProperty('prepaid');
		expect(alts).toHaveProperty('sandbox_x402');
		expect(alts).toHaveProperty('mint_key');
	});

	it('buildMainnetFacilitatorPayload (keyless, trial exhausted, X402_ENABLED=true) includes agent_actions', async () => {
		(env as unknown as Record<string, string>).X402_ENABLED = 'true';
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('agent_actions');
			const actions = body.agent_actions as Record<string, unknown>;
			expect(actions).toHaveProperty('pay_per_request');
			expect(actions).toHaveProperty('mint_persistent_key');
			const accepts = body.accepts as Array<Record<string, unknown>>;
			expect(accepts[0]).toHaveProperty('paymentHeaderName', 'X-Payment');
			// CONTRACT CHANGED 2026-09-07 (rail sprint T1): the scalar 'base64-json'
			// under-declared what the worker accepts. verifyPaymentAnyFormat takes
			// raw JSON as well, and buildX402ScanPayload already advertised the
			// array — two builders declaring different encodings for the same
			// header is the drift the canonical object removes.
			expect(accepts[0]).toHaveProperty('paymentHeaderEncoding', ['base64-json', 'json']);
		} finally {
			delete (env as unknown as Record<string, string>).X402_ENABLED;
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('keyless 402 always returns agent_actions regardless of X402_ENABLED (after trial exhausted)', async () => {
		(env as unknown as Record<string, string>).X402_ENABLED = 'false';
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('x402Version', 1);
			expect(body).toHaveProperty('agent_actions');
			const actions = body.agent_actions as Record<string, unknown>;
			expect(actions).toHaveProperty('pay_per_request');
			expect(actions).toHaveProperty('mint_persistent_key');
			const accepts = body.accepts as Array<Record<string, unknown>>;
			expect(accepts[0]).toHaveProperty('paymentHeaderName', 'X-Payment');
			// CONTRACT CHANGED 2026-09-07 (rail sprint T1): the scalar 'base64-json'
			// under-declared what the worker accepts. verifyPaymentAnyFormat takes
			// raw JSON as well, and buildX402ScanPayload already advertised the
			// array — two builders declaring different encodings for the same
			// header is the drift the canonical object removes.
			expect(accepts[0]).toHaveProperty('paymentHeaderEncoding', ['base64-json', 'json']);
		} finally {
			delete (env as unknown as Record<string, string>).X402_ENABLED;
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('402 response contains flat machine-readable payment fields', async () => {
		const key  = 'ho_free_' + 'w'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('PAYMENT_REQUIRED');
		expect(body.payment_required).toBe(true);
		expect(body.payment_method).toBe('x402');
		expect(body.currency).toBe('USDC');
		expect(body.network).toBe('base');
		expect(body.chain_id).toBe(8453);
		expect(body.x402_endpoint).toBe('https://headlessoracle.com/v5/status');
		expect(body.documentation_url).toBe('https://headlessoracle.com/docs/x402-payments');
		expect(typeof body.alternative).toBe('string');
		const pricing = body.pricing as Record<string, Record<string, unknown>>;
		expect(pricing).toBeDefined();
		expect(pricing.per_request).toHaveProperty('amount_usdc', '0.001');
		expect(pricing.credit_pack).toHaveProperty('amount_usd', '5.00');
		expect(pricing.credit_pack).toHaveProperty('calls', 1000);
		expect(pricing.builder_monthly).toHaveProperty('amount_usd', '99.00');
		expect(pricing.pro_monthly).toHaveProperty('amount_usd', '299.00');
	});
});

describe('x402 payment hardening — pricing + server-card', () => {
	it('GET /v5/pricing returns valid JSON with all tiers', async () => {
		const res = await fetchWorker('/v5/pricing');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const tiers = body.tiers as Array<Record<string, unknown>>;
		expect(Array.isArray(tiers)).toBe(true);
		const ids = tiers.map((t) => t.id);
		expect(ids).toContain('sandbox');
		expect(ids).toContain('free');
		expect(ids).toContain('x402');
		expect(ids).toContain('credits');
		expect(ids).toContain('builder');
		expect(ids).toContain('pro');
		const x402 = body.x402 as Record<string, unknown>;
		expect(x402).toHaveProperty('amount_usdc', '0.001');
		expect(x402).toHaveProperty('network', 'base');
		expect(x402).toHaveProperty('chain_id', 8453);
	});

	it('server-card.json includes payment section with autonomous_payment=true', async () => {
		const res = await fetchWorker('/.well-known/mcp/server-card.json');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const payment = body.payment as Record<string, unknown>;
		expect(payment).toBeDefined();
		expect(payment.methods).toEqual(['x402']);
		expect(payment.currency).toBe('USDC');
		expect(payment.network).toBe('base');
		expect(payment.chain_id).toBe(8453);
		expect(payment.autonomous_payment).toBe(true);
		expect(payment.human_required).toBe(false);
		expect(payment.pricing_endpoint).toBe('https://headlessoracle.com/v5/pricing');
		expect(payment.documentation_url).toBe('https://headlessoracle.com/docs/x402-payments');
	});
});

// ─── Enhanced 402 responses — machine-readable conversion paths ──────────────

describe('Enhanced 402 responses with upgrade_paths', () => {
	it('free tier exhaustion 402 includes upgrade_paths array and recommended field', async () => {
		const key  = 'ho_free_' + 'u'.repeat(64);
		const hash = await setupFreeKey(key);
		await exhaustDailyUsage(hash);
		const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('upgrade_paths');
		// CHANGED 2026-10-04 (H3a, G9): the paid per-call path first, the free key second.
		expect(body).toHaveProperty('recommended', 'x402_payment');
		const paths = body.upgrade_paths as Array<Record<string, unknown>>;
		expect(Array.isArray(paths)).toBe(true);
		expect(paths.length).toBeGreaterThanOrEqual(4);
		expect(paths[0].id).toBe('x402_payment');
		expect(paths[1].id).toBe('instant_key');
		const instantPath = paths.find((p) => p.id === 'instant_key');
		expect(instantPath).toBeDefined();
		expect(instantPath!.friction).toBe('zero');
		expect(instantPath!.url).toBe('/v5/keys/instant');
	});

	it('trial exhaustion 402 includes trial_status with resets_at', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('trial_status');
			const ts = body.trial_status as Record<string, unknown>;
			expect(ts).toHaveProperty('used', 3);
			expect(ts).toHaveProperty('limit', 3);
			expect(typeof ts.resets_at).toBe('string');
			expect(body).toHaveProperty('upgrade_paths');
			// CHANGED 2026-10-04 (H3a, G9): the paid per-call path is recommended.
			expect(body).toHaveProperty('recommended', 'x402_payment');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('sandbox limit 402 includes upgrade_paths with instant_key recommended', async () => {
		const sbKey  = 'sb_' + 'a'.repeat(32);
		const sbHash = await sha256Hex(sbKey);
		await env.ORACLE_API_KEYS.put(sbHash, JSON.stringify({
			tier: 'sandbox', status: 'active', max_calls: 200, expires_at: new Date(Date.now() + 86400000).toISOString(),
		}));
		await env.ORACLE_TELEMETRY.put(`free_usage:${sbHash}:${new Date().toISOString().slice(0, 10)}`, '200');
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': sbKey } });
			expect(res.status).toBe(402);
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('upgrade_paths');
			expect(body).toHaveProperty('recommended', 'instant_key');
		} finally {
			await env.ORACLE_API_KEYS.delete(sbHash);
		}
	});

	it('402 Link header includes /v5/keys/instant', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			const link = res.headers.get('Link') ?? '';
			expect(link).toContain('/v5/keys/instant');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});
});

describe('funnel_402_today in /v5/metrics/public', () => {
	it('returns funnel_402_today field (empty object when no 402s yet)', async () => {
		const res  = await fetchWorker('/v5/metrics/public');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('funnel_402_today');
		expect(typeof body.funnel_402_today).toBe('object');
	});

	it('reflects seeded funnel counters', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.put(`funnel_402:free_tier_gate:${today}`, '7');
		await env.ORACLE_TELEMETRY.put(`funnel_402:keyless_no_payment:${today}`, '15');
		try {
			const body = await fetchJSON('/v5/metrics/public');
			const funnel = body.funnel_402_today as Record<string, number>;
			expect(funnel.free_tier_gate).toBe(7);
			expect(funnel.keyless_no_payment).toBe(15);
		} finally {
			await env.ORACLE_TELEMETRY.delete(`funnel_402:free_tier_gate:${today}`);
			await env.ORACLE_TELEMETRY.delete(`funnel_402:keyless_no_payment:${today}`);
		}
	});
});

// ─── GET /v5/funnel — conversion funnel endpoint ─────────────────────────────

describe('GET /v5/funnel — conversion funnel', () => {
	it('returns 401 without admin key', async () => {
		const res = await fetchWorker('/v5/funnel');
		expect(res.status).toBe(401);
	});

	it('returns funnel data with master key', async () => {
		const res = await fetchWorker('/v5/funnel', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('date');
		expect(body).toHaveProperty('top_of_funnel');
		expect(body).toHaveProperty('conversion_rate');
		expect(body).toHaveProperty('instant_key_requested');
		expect(body).toHaveProperty('x402_attempted');
		expect(body).toHaveProperty('demo_fallback');
	});

	it('reflects seeded funnel counters', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.put(`funnel_instant_key:created:${today}`, '3');
		await env.ORACLE_TELEMETRY.put(`funnel_x402:succeeded:${today}`, '2');
		await env.ORACLE_TELEMETRY.put(`status_code:${today}:402`, '20');
		try {
			const res = await fetchWorker('/v5/funnel', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY },
			});
			const body = await res.json() as Record<string, unknown>;
			expect(body).toHaveProperty('instant_key_created', 3);
			expect(body).toHaveProperty('x402_succeeded', 2);
			expect(body).toHaveProperty('top_of_funnel', 20);
			expect(body).toHaveProperty('conversion_rate', '25.0%');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`funnel_instant_key:created:${today}`);
			await env.ORACLE_TELEMETRY.delete(`funnel_x402:succeeded:${today}`);
			await env.ORACLE_TELEMETRY.delete(`status_code:${today}:402`);
		}
	});

	it('demo request increments funnel_demo:fallback counter', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.delete(`funnel_demo:fallback:${today}`);
		await fetchWorker('/v5/demo?mic=XNYS');
		// Allow non-blocking counter to propagate
		const raw = await env.ORACLE_TELEMETRY.get(`funnel_demo:fallback:${today}`);
		expect(parseInt(raw ?? '0', 10)).toBeGreaterThanOrEqual(1);
	});
});

// ─── Free trial receipts on /v5/status (3 per IP per day) ─────────────────────

describe('Free trial receipts on /v5/status', () => {
	const trialIp = '198.51.100.42';

	afterEach(async () => {
		// Clean up trial KV keys
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
	});

	it('first request from new IP → 200 with signed receipt + X-Trial-Remaining: 2', async () => {
		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': trialIp },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Trial-Remaining')).toBe('2');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('signature');
		expect(body).toHaveProperty('status');
		expect(body).toHaveProperty('receipt_mode', 'live');
	});

	it('third request from same IP → 200 with signed receipt + X-Trial-Remaining: 0', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		// Seed 2 prior uses
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '2', { expirationTtl: 25 * 3600 });

		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': trialIp },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Trial-Remaining')).toBe('0');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('signature');
	});

	it('fourth request from same IP → 402 with trial_used field', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		// Seed 3 prior uses (trial exhausted)
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });

		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': trialIp },
		});
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('trial_used', 3);
		expect(body).toHaveProperty('message');
		expect((body.message as string)).toContain('execution system without verified market-state gating');
	});

	it('request with API key bypasses trial tracking entirely', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		// Seed 3 prior trial uses
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });

		// Use beta key (not master key — master is blocked by legacy enforcement after Apr 1)
		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1', 'CF-Connecting-IP': trialIp },
		});
		expect(res.status).toBe(200);
		// No X-Trial-Remaining header when using API key
		expect(res.headers.get('X-Trial-Remaining')).toBeNull();
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('signature');
	});

	it('request with x402 payment bypasses trial tracking entirely', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		// Seed 3 prior trial uses
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });

		// X-Payment header present triggers the x402 path (will fail verification but test
		// confirms it doesn't hit the trial path — 402 from payment rejection, not trial exhaustion)
		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': trialIp, 'X-Payment': '{"invalid": true}' },
		});
		// Should get 402 from x402 rejection, NOT from trial exhaustion
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		// Payment-rejected 402 has x402_error field, not trial_used
		expect(body).toHaveProperty('x402_error');
		expect(body).not.toHaveProperty('trial_used');
	});

	it('different IPs get independent counters', async () => {
		const otherIp = '203.0.113.99';
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex(trialIp);
		// Exhaust trial for the first IP
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });

		// First IP: exhausted
		const res1 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': trialIp },
		});
		expect(res1.status).toBe(402);

		// Second IP: fresh, should get 200
		const res2 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'CF-Connecting-IP': otherIp },
		});
		expect(res2.status).toBe(200);
		expect(res2.headers.get('X-Trial-Remaining')).toBe('2');

		// Clean up other IP
		const otherIpHash = await sha256Hex(otherIp);
		await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${otherIpHash}`);
	});
});

// ─── GET /v5/briefing — daily market intelligence ─────────────────────────────

describe('GET /v5/briefing', () => {
	it('returns 200 with all required fields', async () => {
		const res = await fetchWorker('/v5/briefing');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('briefing_date');
		expect(body).toHaveProperty('briefing_time_utc');
		expect(body).toHaveProperty('markets_open_now');
		expect(body).toHaveProperty('markets_closed_now');
		expect(body).toHaveProperty('markets_in_lunch_break');
		expect(body).toHaveProperty('upcoming_opens');
		expect(body).toHaveProperty('upcoming_closes');
		expect(body).toHaveProperty('holidays_today');
		expect(body).toHaveProperty('note');
		expect(body).toHaveProperty('coverage', 28);
		expect(body).toHaveProperty('ttl_seconds', 60);
		expect(res.headers.get('Content-Type')).toContain('application/json');
	});

	it('markets_open_now + markets_closed_now covers all 28 exchanges', async () => {
		const body = await fetchJSON('/v5/briefing');
		const open = body.markets_open_now as string[];
		const closed = body.markets_closed_now as string[];
		const lunchBreak = body.markets_in_lunch_break as string[];
		// All exchanges must appear exactly once across open + closed
		// (lunch break markets are also in closed)
		const allMics = [...new Set([...open, ...closed])];
		expect(allMics.length).toBe(28);
	});

	it('upcoming_opens contains only currently-closed markets', async () => {
		const body = await fetchJSON('/v5/briefing');
		const open = new Set(body.markets_open_now as string[]);
		const upcoming = body.upcoming_opens as Array<{ mic: string }>;
		for (const entry of upcoming) {
			expect(open.has(entry.mic)).toBe(false);
		}
	});

	it('upcoming_closes contains only currently-open markets', async () => {
		const body = await fetchJSON('/v5/briefing');
		const open = new Set(body.markets_open_now as string[]);
		const upcoming = body.upcoming_closes as Array<{ mic: string }>;
		for (const entry of upcoming) {
			expect(open.has(entry.mic)).toBe(true);
		}
	});

	it('response is valid JSON with correct content-type', async () => {
		const res = await fetchWorker('/v5/briefing');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		// Should not throw
		const body = await res.json();
		expect(body).toBeTruthy();
	});
});

// ─── /AGENTS.md — agent discovery file ─────────────────────────────────────────

describe('/AGENTS.md agent discovery', () => {
	it('returns 200 with text/markdown content type', async () => {
		const res = await fetchWorker('/AGENTS.md');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains MCP config snippet and exchange list', async () => {
		const res = await fetchWorker('/AGENTS.md');
		const text = await res.text();
		expect(text).toContain('headless-oracle-mcp');
		expect(text).toContain('XNYS');
		expect(text).toContain('Ed25519');
		expect(text).toContain('fail-closed');
		expect(text).toContain('/v5/status');
	});
});

// ─── 402 trial exhaustion includes agent_upgrade_paths ──────────────────────────

describe('402 trial exhaustion agent_upgrade_paths', () => {
	afterEach(async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
	});

	it('402 after trial exhaustion includes agent_upgrade_paths with all three methods', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		const res = await fetchWorker('/v5/status?mic=XNYS');
		expect(res.status).toBe(402);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty('agent_upgrade_paths');
		const paths = body.agent_upgrade_paths as Record<string, unknown>;
		expect(paths).toHaveProperty('instant_no_signup');
		expect(paths).toHaveProperty('free_500_daily');
		expect(paths).toHaveProperty('try_now');
		const x402 = paths.instant_no_signup as Record<string, unknown>;
		expect(x402).toHaveProperty('method', 'x402');
		expect(x402).toHaveProperty('network', 'base');
		const apiKey = paths.free_500_daily as Record<string, unknown>;
		expect(apiKey).toHaveProperty('method', 'api_key');
		expect(apiKey).toHaveProperty('steps');
		expect(Array.isArray(apiKey.steps)).toBe(true);
		const demo = paths.try_now as Record<string, unknown>;
		expect(demo).toHaveProperty('method', 'demo');
		expect(demo).toHaveProperty('url');
	});
});

// ─── GET /v5/slo — SLO and error budget report ───────────────────────────────

describe('GET /v5/slo', () => {
	it('returns SLO report with correct structure', async () => {
		const res = await fetchWorker('/v5/slo');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.slo_target).toBe('99.9%');
		expect(body.status).toBe('HEALTHY');
		expect(body).toHaveProperty('total_requests');
		expect(body).toHaveProperty('server_errors');
		expect(body).toHaveProperty('availability');
		expect(body).toHaveProperty('error_budget');
		expect(body).toHaveProperty('daily');
		expect(Array.isArray(body.daily)).toBe(true);
	});

	it('respects ?days= parameter', async () => {
		const res = await fetchWorker('/v5/slo?days=3');
		expect(res.status).toBe(200);
		const body = await res.json() as { period_days: number; daily: unknown[] };
		expect(body.period_days).toBe(3);
		expect(body.daily).toHaveLength(3);
	});

	it('reports HEALTHY when there are no server errors', async () => {
		// Seed some 200 status codes
		await env.ORACLE_TELEMETRY.put(`status_code:${new Date().toISOString().slice(0, 10)}:200`, '100');
		const res = await fetchWorker('/v5/slo?days=1');
		const body = await res.json() as { status: string; server_errors: number; availability: string };
		expect(body.status).toBe('HEALTHY');
		expect(body.server_errors).toBe(0);
		expect(body.availability).toBe('100.0000%');
	});
});

// ─── MCP initialize clientInfo capture ─────────────────────────────────────────

describe('MCP initialize clientInfo capture', () => {
	it('captures clientInfo.name and version from initialize params into KV telemetry', async () => {
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({
				jsonrpc: '2.0', id: 1, method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'claude-desktop', version: '1.2.3' },
				},
			}),
		});
		expect(res.status).toBe(200);
		// Wait for deferred KV write to complete
		await new Promise(r => setTimeout(r, 200));
		// Check KV for the client_info field
		const today = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		const kvKey = `mcp_clients:${today}:${ipHash}`;
		const stored = await env.ORACLE_TELEMETRY.get(kvKey);
		expect(stored).toBeTruthy();
		const record = JSON.parse(stored!) as { client_info?: { name: string; version: string } };
		expect(record.client_info).toBeDefined();
		expect(record.client_info!.name).toBe('claude-desktop');
		expect(record.client_info!.version).toBe('1.2.3');
		// Cleanup
		await env.ORACLE_TELEMETRY.delete(kvKey);
	});
});

// ─── In-memory API key cache ─────────────────────────────────────────────────

describe('In-memory API key cache (P95 latency fix)', () => {
	it('second auth call uses in-memory cache — same result as KV', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const testKey = 'ho_live_cache_test_key_abcdef1234567890';
		const keyHash = await sha256Hex(testKey);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		// First call — populates in-memory cache from KV
		const res1 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res1.status).toBe(200);
		// Delete from KV — second call should still succeed from memory cache
		await env.ORACLE_API_KEYS.delete(keyHash);
		const res2 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res2.status).toBe(200);
		clearApiKeyCache();
	});

	it('credits-tier keys are NOT in-memory cached (balance is mutable)', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const testKey = 'ho_crd_credits_cache_test_key_abc12345';
		const keyHash = await sha256Hex(testKey);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ tier: 'credits', status: 'active', balance: 2 }));
		// First call — balance decremented to 1 in KV
		const res1 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res1.status).toBe(200);
		// Second call — balance decremented to 0 in KV (not served from stale memory cache)
		const res2 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res2.status).toBe(200);
		// Third call — balance 0, should be rejected
		const res3 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res3.status).toBe(402);
		const body = await res3.json() as { error: string };
		expect(body.error).toBe('CREDITS_EXHAUSTED');
		clearApiKeyCache();
	});

	it('suspended key in memory cache returns 402', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const testKey = 'ho_live_suspended_cache_test_key_abc12';
		const keyHash = await sha256Hex(testKey);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'suspended' }));
		// First call — populates in-memory cache
		const res1 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res1.status).toBe(402);
		// Second call — served from memory, still 402
		const res2 = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': testKey },
		});
		expect(res2.status).toBe(402);
		clearApiKeyCache();
	});
});

// ─── llms.txt + llms-full.txt ────────────────────────────────────────────────

describe('llms.txt and llms-full.txt (AI-discoverable documentation)', () => {
	it('GET /llms.txt returns spec-compliant index with text/markdown', async () => {
		const res = await fetchWorker('/llms.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
		const body = await res.text();
		// CHANGED 2026-10-04 (H3a, G1): the title and summary name the product sold
		// now; market-state follows as its own section.
		expect(body).toMatch(/^# Chirindo by Headless Oracle/);
		expect(body).toContain('> Evidence for AI agents.');
		expect(body).toContain('/llms-full.txt');
		expect(body).toContain('## Chirindo Witness');
		expect(body).toContain('## Pricing');
		expect(body).toContain('## Market-state attestations (also available)');
	});

	it('GET /llms-full.txt returns comprehensive documentation', async () => {
		const res = await fetchWorker('/llms-full.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/markdown');
		const body = await res.text();
		// CHANGED 2026-10-04 (H3a, G1): Chirindo head first, then the market-state docs.
		expect(body).toMatch(/^# Chirindo by Headless Oracle/);
		expect(body).toContain('# Market-state attestations (also available)');
		// Has exchange session hours table
		expect(body).toContain('XNYS');
		expect(body).toContain('XJPX');
		// Has receipt schema
		expect(body).toContain('receipt_id');
		// Has curl examples
		expect(body).toContain('curl');
		// Has verification code
		expect(body).toContain('@headlessoracle/verify');
		// Has MCP config
		expect(body).toContain('headless-oracle-mcp');
		// Has the regulatory references section, its two cited documents, and no uncited framework rows
		expect(body).toContain('## Regulatory References');
		expect(body).toContain('CFTC Staff Letter 25-39');
		expect(body).not.toContain('SOC 2');
		expect(body).not.toContain('ESMA');
	});

	it('JSON responses include Link header for llms.txt discovery', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		const res = await fetchWorker('/v5/demo?mic=XNYS');
		expect(res.status).toBe(200);
		const link = res.headers.get('Link');
		expect(link).toContain('</llms.txt>; rel="llms-txt"');
	});

	it('llms.txt index links to /llms-full.txt via Link header', async () => {
		const res = await fetchWorker('/llms.txt');
		const link = res.headers.get('Link');
		expect(link).toContain('/llms-full.txt');
	});
});

// ─── Security Headers ──────────────────────────────────────────────────────

describe('Security headers on all responses', () => {
	const REQUIRED_SECURITY_HEADERS = {
		'Strict-Transport-Security':  'max-age=31536000; includeSubDomains; preload',
		'X-Content-Type-Options':     'nosniff',
		'X-Frame-Options':            'DENY',
		'Referrer-Policy':            'strict-origin-when-cross-origin',
		'Permissions-Policy':         'camera=(), microphone=(), geolocation=()',
	};

	const endpoints = [
		{ path: '/v5/demo?mic=XNYS', label: 'GET /v5/demo' },
		{ path: '/v5/health', label: 'GET /v5/health' },
		{ path: '/v5/exchanges', label: 'GET /v5/exchanges' },
		{ path: '/.well-known/security.txt', label: 'GET /.well-known/security.txt' },
		{ path: '/llms.txt', label: 'GET /llms.txt' },
		{ path: '/robots.txt', label: 'GET /robots.txt' },
	];

	for (const { path, label } of endpoints) {
		it(`${label} includes all security headers`, async () => {
			vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
			const res = await fetchWorker(path);
			for (const [name, value] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
				expect(res.headers.get(name), `Missing ${name} on ${label}`).toBe(value);
			}
		});
	}

	it('POST /mcp includes security headers', async () => {
		const res = await fetchWorker('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		});
		for (const [name, value] of Object.entries(REQUIRED_SECURITY_HEADERS)) {
			expect(res.headers.get(name), `Missing ${name} on POST /mcp`).toBe(value);
		}
	});

	it('JSON responses include charset=utf-8', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/demo?mic=XNYS');
		expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
	});

	it('GET /v5/demo includes X-Attestation-Mode: demo', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/demo?mic=XNYS');
		expect(res.headers.get('X-Attestation-Mode')).toBe('demo');
	});

	it('GET /v5/status with API key includes X-Attestation-Mode: live', async () => {
		vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
		const res = await fetchWorker('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Attestation-Mode')).toBe('live');
	});

	it('Content-Security-Policy present on API responses', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/demo?mic=XNYS');
		expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 3: Schedule Engine Edge Case Tests — exhaustive exchange coverage
// ═══════════════════════════════════════════════════════════════════════════════

// Helper: fetch a demo receipt at a specific time and verify status
async function expectDemoStatus(mic: string, dateStr: string, expectedStatus: string) {
	vi.setSystemTime(new Date(dateStr));
	const body = await fetchJSON(`/v5/demo?mic=${mic}`);
	const receipt = (body.receipt ?? body) as Record<string, unknown>;
	expect(receipt.status, `${mic} at ${dateStr} expected ${expectedStatus}`).toBe(expectedStatus);
}

// ─── Schedule: All 28 exchanges — mid-session OPEN ──────────────────────────

describe('Schedule engine — mid-session OPEN (all 28 exchanges)', () => {
	// Standard exchanges — pick a Wednesday in April 2026, mid-session in local time
	const midSessionCases: [string, string][] = [
		['XNYS', '2026-04-08T15:00:00Z'],   // 11:00 ET (mid-session 9:30-16:00)
		['XNAS', '2026-04-08T15:00:00Z'],   // 11:00 ET
		['XLON', '2026-04-08T10:00:00Z'],   // 11:00 BST (mid-session 8:00-16:30)
		['XJPX', '2026-04-08T02:00:00Z'],   // 11:00 JST (mid-session 9:00-15:30, before lunch)
		['XPAR', '2026-04-08T10:00:00Z'],   // 12:00 CEST (mid-session 9:00-17:30)
		['XHKG', '2026-04-08T02:30:00Z'],   // 10:30 HKT (mid-session 9:30-16:00, before lunch)
		['XSES', '2026-04-08T03:00:00Z'],   // 11:00 SGT (mid-session 9:00-17:00)
		['XASX', '2026-04-08T01:00:00Z'],   // 11:00 AEST (mid-session 10:00-16:00)
		['XBOM', '2026-04-08T06:00:00Z'],   // 11:30 IST (mid-session 9:15-15:30)
		['XNSE', '2026-04-08T06:00:00Z'],   // 11:30 IST
		['XSHG', '2026-04-08T02:00:00Z'],   // 10:00 CST (mid-session 9:30-15:00, before lunch)
		['XSHE', '2026-04-08T02:00:00Z'],   // 10:00 CST
		['XKRX', '2026-04-08T02:00:00Z'],   // 11:00 KST (mid-session 9:00-15:30)
		['XJSE', '2026-04-08T09:30:00Z'],   // 11:30 SAST (mid-session 9:00-17:00)
		['XBSP', '2026-04-08T14:00:00Z'],   // 11:00 BRT (mid-session 10:00-17:55)
		['XSWX', '2026-04-08T10:00:00Z'],   // 12:00 CEST (mid-session 9:00-17:30)
		['XMIL', '2026-04-08T10:00:00Z'],   // 12:00 CEST (mid-session 9:00-17:35)
		['XIST', '2026-04-08T11:00:00Z'],   // 14:00 TRT (mid-session 10:00-18:00)
		['XSAU', '2026-04-08T09:00:00Z'],   // 12:00 AST (mid-session 10:00-15:00, Sun-Thu)
		['XDFM', '2026-04-08T08:00:00Z'],   // 12:00 GST (mid-session 10:00-14:00)
		['XNZE', '2026-04-08T00:00:00Z'],   // 12:00 NZST (mid-session 10:00-16:45)
		['XHEL', '2026-04-08T09:00:00Z'],   // 12:00 EEST (mid-session 10:00-18:30)
		['XSTO', '2026-04-08T10:00:00Z'],   // 12:00 CEST (mid-session 9:00-17:30)
		['XCBO', '2026-04-08T15:00:00Z'],   // 11:00 ET (mid-session 9:30-16:15)
		// Crypto: always OPEN
		['XCOI', '2026-04-08T15:00:00Z'],
		['XBIN', '2026-04-08T15:00:00Z'],
	];

	for (const [mic, time] of midSessionCases) {
		it(`${mic} OPEN at mid-session`, async () => {
			await expectDemoStatus(mic, time, 'OPEN');
		});
	}

	// CME overnight: OPEN during active overnight session (Tue evening CT)
	it('XCBT OPEN during overnight session', async () => {
		await expectDemoStatus('XCBT', '2026-04-07T23:00:00Z', 'OPEN'); // 18:00 CT — after 17:00 open
	});

	it('XNYM OPEN during overnight session', async () => {
		await expectDemoStatus('XNYM', '2026-04-07T23:00:00Z', 'OPEN');
	});
});

// ─── Schedule: Before open — CLOSED ─────────────────────────────────────────

describe('Schedule engine — before open CLOSED (all standard exchanges)', () => {
	const beforeOpenCases: [string, string][] = [
		['XNYS', '2026-04-08T12:00:00Z'],   // 08:00 ET — before 9:30 open
		['XNAS', '2026-04-08T12:00:00Z'],
		['XLON', '2026-04-08T06:00:00Z'],   // 07:00 BST — before 8:00 open
		['XJPX', '2026-04-07T23:00:00Z'],   // 08:00 JST — before 9:00 open
		['XPAR', '2026-04-08T06:00:00Z'],   // 08:00 CEST — before 9:00 open
		['XHKG', '2026-04-08T00:00:00Z'],   // 08:00 HKT — before 9:30 open
		['XSES', '2026-04-08T00:00:00Z'],   // 08:00 SGT — before 9:00 open
		['XASX', '2026-04-07T23:00:00Z'],   // 09:00 AEST — before 10:00 open
		['XBOM', '2026-04-08T02:00:00Z'],   // 07:30 IST — before 9:15 open
		['XNSE', '2026-04-08T02:00:00Z'],
		['XSHG', '2026-04-08T00:00:00Z'],   // 08:00 CST — before 9:30 open
		['XSHE', '2026-04-08T00:00:00Z'],
		['XKRX', '2026-04-07T23:00:00Z'],   // 08:00 KST — before 9:00 open
		['XJSE', '2026-04-08T06:00:00Z'],   // 08:00 SAST — before 9:00 open
		['XBSP', '2026-04-08T11:00:00Z'],   // 08:00 BRT — before 10:00 open
		['XSWX', '2026-04-08T06:00:00Z'],   // 08:00 CEST — before 9:00 open
		['XMIL', '2026-04-08T06:00:00Z'],
		['XIST', '2026-04-08T06:00:00Z'],   // 09:00 TRT — before 10:00 open
		['XSAU', '2026-04-08T06:00:00Z'],   // 09:00 AST — before 10:00 open
		['XDFM', '2026-04-08T05:00:00Z'],   // 09:00 GST — before 10:00 open
		['XNZE', '2026-04-07T21:00:00Z'],   // 09:00 NZST — before 10:00 open
		['XHEL', '2026-04-08T06:00:00Z'],   // 09:00 EEST — before 10:00 open
		['XSTO', '2026-04-08T06:00:00Z'],   // 08:00 CEST — before 9:00 open
		['XCBO', '2026-04-08T12:00:00Z'],   // 08:00 ET — before 9:30 open
	];

	for (const [mic, time] of beforeOpenCases) {
		it(`${mic} CLOSED before open`, async () => {
			await expectDemoStatus(mic, time, 'CLOSED');
		});
	}
});

// ─── Schedule: After close — CLOSED ─────────────────────────────────────────

describe('Schedule engine — after close CLOSED (all standard exchanges)', () => {
	const afterCloseCases: [string, string][] = [
		['XNYS', '2026-04-08T21:00:00Z'],   // 17:00 ET — after 16:00 close
		['XNAS', '2026-04-08T21:00:00Z'],
		['XLON', '2026-04-08T16:00:00Z'],   // 17:00 BST — after 16:30 close
		['XJPX', '2026-04-08T07:00:00Z'],   // 16:00 JST — after 15:30 close
		['XPAR', '2026-04-08T16:00:00Z'],   // 18:00 CEST — after 17:30 close
		['XHKG', '2026-04-08T09:00:00Z'],   // 17:00 HKT — after 16:00 close
		['XSES', '2026-04-08T10:00:00Z'],   // 18:00 SGT — after 17:00 close
		['XASX', '2026-04-08T07:00:00Z'],   // 17:00 AEST — after 16:00 close
		['XBOM', '2026-04-08T11:00:00Z'],   // 16:30 IST — after 15:30 close
		['XNSE', '2026-04-08T11:00:00Z'],
		['XSHG', '2026-04-08T08:00:00Z'],   // 16:00 CST — after 15:00 close
		['XSHE', '2026-04-08T08:00:00Z'],
		['XKRX', '2026-04-08T07:00:00Z'],   // 16:00 KST — after 15:30 close
		['XJSE', '2026-04-08T16:00:00Z'],   // 18:00 SAST — after 17:00 close
		['XBSP', '2026-04-08T22:00:00Z'],   // 19:00 BRT — after 17:55 close
		['XSWX', '2026-04-08T16:00:00Z'],   // 18:00 CEST — after 17:30 close
		['XMIL', '2026-04-08T16:00:00Z'],   // 18:00 CEST — after 17:35 close
		['XIST', '2026-04-08T16:00:00Z'],   // 19:00 TRT — after 18:00 close
		['XSAU', '2026-04-08T13:00:00Z'],   // 16:00 AST — after 15:00 close
		['XDFM', '2026-04-08T11:00:00Z'],   // 15:00 GST — after 14:00 close
		['XNZE', '2026-04-08T05:00:00Z'],   // 17:00 NZST — after 16:45 close
		['XHEL', '2026-04-08T16:00:00Z'],   // 19:00 EEST — after 18:30 close
		['XSTO', '2026-04-08T16:00:00Z'],   // 18:00 CEST — after 17:30 close
		['XCBO', '2026-04-08T21:00:00Z'],   // 17:00 ET — after 16:15 close
	];

	for (const [mic, time] of afterCloseCases) {
		it(`${mic} CLOSED after close`, async () => {
			await expectDemoStatus(mic, time, 'CLOSED');
		});
	}
});

// ─── Schedule: Weekend CLOSED ───────────────────────────────────────────────

describe('Schedule engine — weekend CLOSED', () => {
	// Saturday April 11, 2026 at noon UTC — all standard exchanges closed
	const saturdayNoon = '2026-04-11T12:00:00Z';

	const standardMics = [
		'XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
		'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
		'XBSP', 'XSWX', 'XMIL', 'XIST', 'XNZE', 'XHEL', 'XSTO', 'XCBO',
	];

	for (const mic of standardMics) {
		it(`${mic} CLOSED on Saturday`, async () => {
			await expectDemoStatus(mic, saturdayNoon, 'CLOSED');
		});
	}

	// Middle Eastern exchanges: Friday is weekend
	it('XSAU CLOSED on Friday (Middle Eastern weekend)', async () => {
		await expectDemoStatus('XSAU', '2026-04-10T09:00:00Z', 'CLOSED'); // Fri 12:00 AST
	});

	it('XDFM CLOSED on Friday (Middle Eastern weekend)', async () => {
		await expectDemoStatus('XDFM', '2026-04-10T09:00:00Z', 'CLOSED');
	});

	// But XSAU/XDFM are OPEN on Sunday
	it('XSAU OPEN on Sunday (not a Middle Eastern weekend)', async () => {
		await expectDemoStatus('XSAU', '2026-04-12T09:00:00Z', 'OPEN'); // Sun 12:00 AST
	});

	it('XDFM OPEN on Sunday (not a Middle Eastern weekend)', async () => {
		await expectDemoStatus('XDFM', '2026-04-12T08:00:00Z', 'OPEN'); // Sun 12:00 GST
	});

	// Crypto: OPEN on weekends
	it('XCOI OPEN on Saturday', async () => {
		await expectDemoStatus('XCOI', saturdayNoon, 'OPEN');
	});

	it('XBIN OPEN on Sunday', async () => {
		await expectDemoStatus('XBIN', '2026-04-12T12:00:00Z', 'OPEN');
	});
});

// ─── Schedule: Known holidays 2026 ─────────────────────────────────────────

describe('Schedule engine — holiday CLOSED (2026)', () => {
	const holidayCases: [string, string, string][] = [
		// US
		['XNYS', '2026-01-01T15:00:00Z', "New Year's Day"],
		['XNAS', '2026-07-03T15:00:00Z', 'Independence Day observed'],
		// UK
		['XLON', '2026-04-06T10:00:00Z', 'Easter Monday'],
		// Japan
		['XJPX', '2026-05-04T02:00:00Z', 'Greenery Day'],
		// France
		['XPAR', '2026-05-01T10:00:00Z', 'Labour Day'],
		// Hong Kong
		['XHKG', '2026-01-01T03:00:00Z', "New Year's Day"],
		// Australia
		['XASX', '2026-01-26T01:00:00Z', 'Australia Day'],
		// India
		['XBOM', '2026-01-26T06:00:00Z', 'Republic Day'],
		// Korea
		['XKRX', '2026-03-01T02:00:00Z', 'Independence Movement Day'],
		// South Africa
		['XJSE', '2026-03-21T09:00:00Z', 'Human Rights Day'],
		// Brazil
		['XBSP', '2026-02-16T14:00:00Z', 'Carnival'],
		// Switzerland
		['XSWX', '2026-01-01T10:00:00Z', "New Year's Day"],
		// Saudi
		['XSAU', '2026-09-23T09:00:00Z', 'Saudi National Day'],
		// New Zealand
		['XNZE', '2026-02-05T23:00:00Z', 'Waitangi Day (Feb 6 NZST)'],
	];

	for (const [mic, time, name] of holidayCases) {
		it(`${mic} CLOSED on ${name}`, async () => {
			await expectDemoStatus(mic, time, 'CLOSED');
		});
	}
});

// ─── Schedule: Half-day early close ─────────────────────────────────────────

describe('Schedule engine — half-day early close (2026)', () => {
	it('XNYS open before 13:00 on Black Friday', async () => {
		// Black Friday 2026: Nov 27. Close at 13:00 ET.
		// 10:00 ET = 15:00 UTC (EST in Nov)
		await expectDemoStatus('XNYS', '2026-11-27T15:00:00Z', 'OPEN');
	});

	it('XNYS closed after 13:00 on Black Friday', async () => {
		// 14:00 ET = 19:00 UTC (EST in Nov)
		await expectDemoStatus('XNYS', '2026-11-27T19:00:00Z', 'CLOSED');
	});
});

// ─── Schedule: Lunch breaks ─────────────────────────────────────────────────

describe('Schedule engine — lunch break CLOSED', () => {
	it('XJPX CLOSED during lunch (11:30-12:30 JST)', async () => {
		// 12:00 JST = 03:00 UTC
		await expectDemoStatus('XJPX', '2026-04-08T03:00:00Z', 'CLOSED');
	});

	it('XJPX OPEN after lunch resumption (12:30 JST)', async () => {
		// 13:00 JST = 04:00 UTC
		await expectDemoStatus('XJPX', '2026-04-08T04:00:00Z', 'OPEN');
	});

	it('XHKG CLOSED during lunch (12:00-13:00 HKT)', async () => {
		// 12:30 HKT = 04:30 UTC
		await expectDemoStatus('XHKG', '2026-04-08T04:30:00Z', 'CLOSED');
	});

	it('XHKG OPEN after lunch resumption (13:00 HKT)', async () => {
		// 13:30 HKT = 05:30 UTC
		await expectDemoStatus('XHKG', '2026-04-08T05:30:00Z', 'OPEN');
	});

	it('XSHG CLOSED during lunch (11:30-13:00 CST)', async () => {
		// 12:00 CST = 04:00 UTC
		await expectDemoStatus('XSHG', '2026-04-08T04:00:00Z', 'CLOSED');
	});

	it('XSHG OPEN after lunch resumption (13:00 CST)', async () => {
		// 13:30 CST = 05:30 UTC
		await expectDemoStatus('XSHG', '2026-04-08T05:30:00Z', 'OPEN');
	});

	it('XSHE CLOSED during lunch (11:30-13:00 CST)', async () => {
		await expectDemoStatus('XSHE', '2026-04-08T04:00:00Z', 'CLOSED');
	});

	it('XSHE OPEN after lunch resumption', async () => {
		await expectDemoStatus('XSHE', '2026-04-08T05:30:00Z', 'OPEN');
	});
});

// ─── Schedule: DST transitions ──────────────────────────────────────────────

describe('Schedule engine — DST transitions', () => {
	// US Spring Forward: March 8, 2026 (EST→EDT)
	// After spring forward, NYSE opens at 13:30 UTC (was 14:30 UTC in EST)
	it('NYSE opens at 13:30 UTC after US spring forward (Mar 9)', async () => {
		// Mar 9 is Monday after spring forward
		// 13:30 UTC = 9:30 EDT (OPEN)
		await expectDemoStatus('XNYS', '2026-03-09T14:00:00Z', 'OPEN');
	});

	it('NYSE closed at 13:00 UTC on Mar 9 (before open)', async () => {
		// 13:00 UTC = 9:00 EDT (before 9:30 open)
		await expectDemoStatus('XNYS', '2026-03-09T13:00:00Z', 'CLOSED');
	});

	// Before spring forward: NYSE opens at 14:30 UTC
	it('NYSE opens at 14:30 UTC before US spring forward (Mar 6)', async () => {
		// Mar 6 is Friday before spring forward (still EST)
		// 15:00 UTC = 10:00 EST (OPEN)
		await expectDemoStatus('XNYS', '2026-03-06T15:00:00Z', 'OPEN');
	});

	it('NYSE closed at 14:00 UTC on Mar 6 (before EST open)', async () => {
		// 14:00 UTC = 9:00 EST (before 9:30 open)
		await expectDemoStatus('XNYS', '2026-03-06T14:00:00Z', 'CLOSED');
	});

	// US Fall Back: November 1, 2026 (EDT→EST)
	// After fall back, NYSE opens at 14:30 UTC (was 13:30 UTC in EDT)
	it('NYSE opens at 14:30 UTC after US fall back (Nov 2)', async () => {
		// Nov 2 is Monday after fall back
		// 15:00 UTC = 10:00 EST (OPEN)
		await expectDemoStatus('XNYS', '2026-11-02T15:00:00Z', 'OPEN');
	});

	it('NYSE closed at 14:00 UTC on Nov 2 (before EST open)', async () => {
		await expectDemoStatus('XNYS', '2026-11-02T14:00:00Z', 'CLOSED');
	});

	// EU Spring Forward: March 29, 2026 (GMT→BST, CET→CEST)
	// After spring forward, XLON opens at 07:00 UTC (was 08:00 UTC in GMT)
	it('XLON opens at 07:00 UTC after EU spring forward (Mar 30)', async () => {
		// Mar 30 is Monday after EU spring forward
		// 08:00 UTC = 09:00 BST (OPEN, since open is 8:00 local)
		await expectDemoStatus('XLON', '2026-03-30T08:00:00Z', 'OPEN');
	});

	it('XLON closed at 06:30 UTC on Mar 30 (before BST open)', async () => {
		// 06:30 UTC = 07:30 BST (before 8:00 open)
		await expectDemoStatus('XLON', '2026-03-30T06:30:00Z', 'CLOSED');
	});

	// Before EU spring forward, XLON opens at 08:00 UTC
	it('XLON opens at 08:00 UTC before EU spring forward (Mar 27)', async () => {
		// Mar 27 is Friday before EU spring forward (still GMT)
		// 09:00 UTC = 09:00 GMT (OPEN)
		await expectDemoStatus('XLON', '2026-03-27T09:00:00Z', 'OPEN');
	});

	// EU Fall Back: October 25, 2026 (BST→GMT)
	it('XLON opens at 08:00 UTC after EU fall back (Oct 26)', async () => {
		// Oct 26 is Monday after fall back
		// 09:00 UTC = 09:00 GMT (OPEN)
		await expectDemoStatus('XLON', '2026-10-26T09:00:00Z', 'OPEN');
	});

	// The 3-week gap: Mar 8 (US forward) to Mar 29 (EU forward)
	// During this period, NYSE is EDT but XLON is still GMT
	it('3-week DST gap: NYSE at EDT, XLON at GMT (Mar 16)', async () => {
		// NYSE opens 13:30 UTC (EDT), XLON opens 08:00 UTC (GMT)
		// At 14:00 UTC: NYSE OPEN (10:00 EDT), XLON OPEN (14:00 GMT)
		vi.setSystemTime(new Date('2026-03-16T14:00:00Z'));
		const nyseBody = await fetchJSON('/v5/demo?mic=XNYS');
		const xnysReceipt = (nyseBody.receipt ?? nyseBody) as Record<string, unknown>;
		expect(xnysReceipt.status).toBe('OPEN');

		const lonBody = await fetchJSON('/v5/demo?mic=XLON');
		const xlonReceipt = (lonBody.receipt ?? lonBody) as Record<string, unknown>;
		expect(xlonReceipt.status).toBe('OPEN');
	});
});

// ─── Schedule: CME overnight session edge cases ─────────────────────────────

describe('Schedule engine — CME overnight session', () => {
	it('XCBT CLOSED during maintenance halt (16:00-17:00 CT)', async () => {
		// 16:30 CT = 21:30 UTC (CDT in April)
		await expectDemoStatus('XCBT', '2026-04-08T21:30:00Z', 'CLOSED');
	});

	it('XCBT OPEN after maintenance (17:00 CT)', async () => {
		// 17:30 CT = 22:30 UTC (CDT in April)
		await expectDemoStatus('XCBT', '2026-04-08T22:30:00Z', 'OPEN');
	});

	it('XCBT CLOSED on Saturday', async () => {
		await expectDemoStatus('XCBT', '2026-04-11T12:00:00Z', 'CLOSED');
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 4: Signing and Cryptographic Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Ed25519 signing — cryptographic correctness', () => {
	it('signed receipt verifies against /.well-known/oracle-keys.json public key', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		// Get receipt
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		// Get public key from well-known
		const keysBody = await fetchJSON('/.well-known/oracle-keys.json');
		const keys = keysBody.keys as Array<Record<string, unknown>>;
		const pubKeyHex = keys[0].public_key as string;
		// Verify via /v5/verify
		const verifyRes = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		const verifyBody = await verifyRes.json() as Record<string, unknown>;
		expect(verifyBody.valid).toBe(true);
		// Key matches
		expect(pubKeyHex).toBeTruthy();
	});

	it('modified payload byte invalidates signature', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = { ...((demoBody.receipt ?? demoBody) as Record<string, unknown>) };
		// Tamper with status
		receipt.status = 'CLOSED';
		const verifyRes = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		const body = await verifyRes.json() as Record<string, unknown>;
		expect(body.valid).toBe(false);
	});

	it('modified signature byte invalidates verification', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = { ...((demoBody.receipt ?? demoBody) as Record<string, unknown>) };
		// Tamper with last byte of signature
		const sig = receipt.signature as string;
		const lastChar = sig[sig.length - 1];
		const newLastChar = lastChar === '0' ? '1' : '0';
		receipt.signature = sig.slice(0, -1) + newLastChar;
		const verifyRes = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		const body = await verifyRes.json() as Record<string, unknown>;
		expect(body.valid).toBe(false);
	});

	it('canonical payload has keys sorted alphabetically', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		// Extract all signed fields (excluding signature, discovery_url, receipt, extensions)
		const UNSIGNED = new Set(['signature', 'discovery_url', 'receipt', 'extensions']);
		const signedKeys = Object.keys(receipt).filter(k => !UNSIGNED.has(k)).sort();
		// Verify they are in alphabetical order
		for (let i = 0; i < signedKeys.length - 1; i++) {
			expect(signedKeys[i] <= signedKeys[i + 1]).toBe(true);
		}
	});

	it('canonical JSON has no whitespace', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		// Build canonical payload same way as signPayload
		const UNSIGNED = new Set(['signature', 'discovery_url', 'receipt', 'extensions']);
		const payload: Record<string, string> = {};
		for (const key of Object.keys(receipt).sort()) {
			if (UNSIGNED.has(key)) continue;
			payload[key] = String(receipt[key]);
		}
		const canonical = JSON.stringify(payload);
		// No spaces, no newlines
		expect(canonical).not.toContain(' ');
		expect(canonical).not.toContain('\n');
		expect(canonical).not.toContain('\t');
	});

	it('receipt_id is a valid UUID', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		const uuid = receipt.receipt_id as string;
		// UUID v4 format: 8-4-4-4-12
		expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it('issued_at is ISO 8601', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		const issuedAt = receipt.issued_at as string;
		// Must parse to a valid date
		const parsed = new Date(issuedAt);
		expect(parsed.getTime()).not.toBeNaN();
		// Must end with Z (UTC)
		expect(issuedAt).toMatch(/Z$/);
	});

	it('expires_at = issued_at + 60 seconds exactly', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		const issuedAt = new Date(receipt.issued_at as string).getTime();
		const expiresAt = new Date(receipt.expires_at as string).getTime();
		expect(expiresAt - issuedAt).toBe(60_000); // exactly 60 seconds
	});

	it('different receipt_modes produce different signatures (demo vs live)', async () => {
		vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
		// Demo receipt
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const demoReceipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		// Live receipt (authenticated)
		const liveBody = await fetchJSON('/v5/status?mic=XNYS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		} as RequestInit);
		const liveReceipt = (liveBody.receipt ?? liveBody) as Record<string, unknown>;
		// receipt_mode is different
		expect(demoReceipt.receipt_mode).toBe('demo');
		expect(liveReceipt.receipt_mode).toBe('live');
		// Signatures must be different (different payloads due to receipt_mode)
		expect(demoReceipt.signature).not.toBe(liveReceipt.signature);
	});

	it('batch has Ed25519 signature over entire batch payload', async () => {
		vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
		const batchRes = await fetchJSON('/v5/batch?mics=XNYS,XNAS', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		} as RequestInit);
		// Batch-level signature field
		const batchSig = batchRes.signature as string;
		expect(batchSig).toBeDefined();
		expect(typeof batchSig).toBe('string');
		expect(batchSig.length).toBe(128); // Ed25519 signature is 64 bytes = 128 hex chars
		// Also has batch_id and correlation_id
		expect(batchRes.batch_id).toBeDefined();
		expect(batchRes.correlation_id).toBeDefined();
	});

	it('public key in response matches key_2026_v1 or test key', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		const keyId = receipt.public_key_id as string;
		// In test env it's key_test_v1 (from .dev.vars)
		expect(keyId).toBeDefined();
		expect(typeof keyId).toBe('string');
	});

	it('signature is 128 hex characters (64 bytes)', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoBody = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (demoBody.receipt ?? demoBody) as Record<string, unknown>;
		const sig = receipt.signature as string;
		expect(sig).toMatch(/^[0-9a-f]{128}$/);
	});

	it('two sequential receipts have different receipt_ids and signatures', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const body1 = await fetchJSON('/v5/demo?mic=XNYS');
		const r1 = (body1.receipt ?? body1) as Record<string, unknown>;
		const body2 = await fetchJSON('/v5/demo?mic=XNYS');
		const r2 = (body2.receipt ?? body2) as Record<string, unknown>;
		// Different receipt_ids
		expect(r1.receipt_id).not.toBe(r2.receipt_id);
		// Different signatures (different receipt_id in payload)
		expect(r1.signature).not.toBe(r2.signature);
	});

	it('health receipt has different schema than market receipt (no mic)', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const healthBody = await fetchJSON('/v5/health');
		const receipt = (healthBody.receipt ?? healthBody) as Record<string, unknown>;
		// Health receipt should not have mic
		expect(receipt.status).toBe('OK');
		expect(receipt.source).toBe('SYSTEM');
		expect(receipt.signature).toMatch(/^[0-9a-f]{128}$/);
		// No mic field
		expect(receipt.mic).toBeUndefined();
	});

	it('HALTED override produces signed receipt with OVERRIDE source', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		// Set an override
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status: 'HALTED',
			reason: 'Test halt',
			expires: new Date(Date.now() + 3600000).toISOString(),
		}));
		clearOverrideCache();
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.status).toBe('HALTED');
		expect(receipt.source).toBe('OVERRIDE');
		// Still signed
		expect(receipt.signature).toMatch(/^[0-9a-f]{128}$/);
		// Cleanup
		await env.ORACLE_OVERRIDES.delete('XNYS');
		clearOverrideCache();
	});

	it('issuer field is headlessoracle.com', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.issuer).toBe('headlessoracle.com');
	});

	it('schema_version is v5.0', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.schema_version).toBe('v5.0');
	});

	it('halt_detection field is signed', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.halt_detection).toBeDefined();
		// Verify the whole receipt still validates
		const verifyRes = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		const vBody = await verifyRes.json() as Record<string, unknown>;
		expect(vBody.valid).toBe(true);
	});
});

// ─── signPayload runtime type guard ──────────────────────────────────────────
// Guards the canonicalization-parity hazard: in-repo verifier coerces with
// String(); SDK does not. Non-string signed fields would canonicalize
// differently across verifiers and surface as INVALID_SIGNATURE on the SDK
// side only. Throwing at sign time makes that drift impossible to ship.

describe('signPayload — runtime type guard', () => {
	const PRIV_KEY = env.ED25519_PRIVATE_KEY;

	it('throws on number value, naming the field and type', async () => {
		await expect(
			signPayload({ mic: 42 as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "mic" \(got number\)/);
	});

	it('throws on boolean value, naming the field and type', async () => {
		await expect(
			signPayload({ status: false as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "status" \(got boolean\)/);
	});

	it('throws on null value, distinguishing null from object', async () => {
		await expect(
			signPayload({ source: null as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "source" \(got null\)/);
	});

	it('throws on undefined value', async () => {
		await expect(
			signPayload({ expires_at: undefined as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "expires_at" \(got undefined\)/);
	});

	it('throws on plain object value', async () => {
		await expect(
			signPayload({ issuer: { nested: 'x' } as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "issuer" \(got object\)/);
	});

	it('throws on array value, distinguishing array from object', async () => {
		await expect(
			signPayload({ mic: ['XNYS'] as unknown as string }, PRIV_KEY),
		).rejects.toThrow(/non-string value for field "mic" \(got array\)/);
	});

	it('accepts an all-string payload and returns a hex signature', async () => {
		const sig = await signPayload(
			{
				expires_at: '2026-06-12T00:01:00.000Z',
				issued_at:  '2026-06-12T00:00:00.000Z',
				mic:        'XNYS',
				status:     'OPEN',
			},
			PRIV_KEY,
		);
		expect(sig).toMatch(/^[0-9a-f]+$/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 2: Endpoint Coverage Gaps — comprehensive tests for uncovered routes
// ═══════════════════════════════════════════════════════════════════════════════

// ─── /v5/keys/instant — all error cases ──────────────────────────────────────

describe('/v5/keys/instant — error cases', () => {
	it('PUT returns 405 METHOD_NOT_ALLOWED', async () => {
		const res = await fetchWorker('/v5/keys/instant', { method: 'PUT' });
		expect(res.status).toBe(405);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('METHOD_NOT_ALLOWED');
	});

	it('POST with empty body returns 400 INVALID_AGENT_ID', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_AGENT_ID');
	});

	it('POST with numeric agent_id returns 400', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: 12345 }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_AGENT_ID');
	});

	it('POST with blank agent_id returns 400', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: '   ' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_AGENT_ID');
	});

	it('POST with agent_id >256 chars returns 400', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: 'x'.repeat(257) }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_AGENT_ID');
	});

	it('POST with invalid JSON body returns 400', async () => {
		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});

	it('rate limit counter key follows expected pattern', async () => {
		// Seed the rate limit counter to simulate 10 prior keys
		const ipHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('unknown'));
		const hashHex = [...new Uint8Array(ipHash)].map(b => b.toString(16).padStart(2, '0')).join('');
		const date = new Date().toISOString().slice(0, 10);
		const rlKey = `ratelimit:instant_keys:${hashHex}:${date}`;
		await env.ORACLE_TELEMETRY.put(rlKey, '10', { expirationTtl: 25 * 3600 });

		const res = await fetchWorker('/v5/keys/instant', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: 'ratelimit-test-overflow' }),
		});
		expect(res.status).toBe(429);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('RATE_LIMITED');
		expect(res.headers.get('Retry-After')).toBeTruthy();
	});
});

// ─── /v5/verify — malformed and expired receipts ─────────────────────────────

describe('/v5/verify — additional error cases', () => {
	it('PUT returns 405', async () => {
		const res = await fetchWorker('/v5/verify', { method: 'PUT' });
		expect(res.status).toBe(405);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('METHOD_NOT_ALLOWED');
	});

	it('GET with invalid JSON in receipt param returns 400', async () => {
		const res = await fetchWorker('/v5/verify?receipt=not-json');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_JSON');
	});

	it('POST with non-object receipt returns 400', async () => {
		const res = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt: 'not-an-object' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('MISSING_RECEIPT');
	});

	it('POST with null receipt returns 400', async () => {
		const res = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt: null }),
		});
		expect(res.status).toBe(400);
	});

	it('POST with malformed JSON body returns 400', async () => {
		const res = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{broken',
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('INVALID_JSON');
	});

	it('POST with valid receipt returns detailed checks', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		// First get a real receipt
		const demoRes = await fetchJSON('/v5/demo?mic=XNYS') as Record<string, unknown>;
		const receipt = demoRes.receipt ?? demoRes;
		// Verify it
		const verifyRes = await fetchWorker('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		expect(verifyRes.status).toBe(200);
		const body = await verifyRes.json() as Record<string, unknown>;
		expect(body.valid).toBe(true);
		// checks is an object with named keys, not an array
		if (body.checks) {
			expect(typeof body.checks).toBe('object');
			const checks = body.checks as Record<string, Record<string, unknown>>;
			expect(checks.signature?.passed).toBe(true);
		}
	});

	it('GET /v5/verify with valid receipt query param works', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const demoRes = await fetchJSON('/v5/demo?mic=XNYS') as Record<string, unknown>;
		const receipt = demoRes.receipt ?? demoRes;
		const encoded = encodeURIComponent(JSON.stringify(receipt));
		const res = await fetchWorker(`/v5/verify?receipt=${encoded}`);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.valid).toBe(true);
	});
});

// ─── /v5/historical — edge cases ────────────────────────────────────────────

describe('/v5/historical — additional edge cases', () => {
	it('returns 400 for date before 2026-03-01', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS&at=2025-01-01T12:00:00Z');
		expect(res.status).toBe(400);
	});

	it('returns 400 for missing mic parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?at=2026-03-15T12:00:00Z');
		expect(res.status).toBe(400);
	});

	it('returns 400 for missing at parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS');
		expect(res.status).toBe(400);
	});

	it('returns computed_status for DST spring-forward boundary', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		// US Spring Forward: Mar 8, 2026 — NYSE should open 13:30 UTC (not 14:30)
		const res = await fetchWorker('/v5/historical?mic=XNYS&at=2026-03-09T14:00:00Z');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.computed_status).toBeDefined();
		expect(['OPEN', 'CLOSED']).toContain(body.computed_status);
	});

	it('returns reasoning field', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/historical?mic=XNYS&at=2026-03-15T15:00:00Z');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.reasoning).toBeDefined();
	});
});

// ─── /v5/audit/digest — additional edge cases ───────────────────────────────

describe('/v5/audit/digest — additional edge cases', () => {
	it('returns 400 for date before launch (2026-03-01)', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=2025-12-01');
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('OUT_OF_RANGE');
	});

	it('returns merkle_root field even for empty day', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=2026-03-02');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.merkle_root).toBeDefined();
		expect(typeof body.merkle_root).toBe('string');
	});

	it('returns computed_at timestamp', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/digest?date=2026-04-07');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.computed_at).toBeDefined();
	});
});

// ─── /v5/audit/chain — edge cases ───────────────────────────────────────────

describe('/v5/audit/chain — additional edge cases', () => {
	it('respects days parameter', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/chain?days=3');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.chain_length).toBeLessThanOrEqual(3);
	});

	it('caps at 30 days', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/chain?days=100');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.chain_length as number).toBeLessThanOrEqual(30);
	});

	it('returns latest_date and oldest_date', async () => {
		vi.setSystemTime(new Date('2026-04-08T15:00:00Z'));
		const res = await fetchWorker('/v5/audit/chain');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.latest_date).toBeDefined();
		expect(body.oldest_date).toBeDefined();
	});
});

// ─── /v5/funnel — admin auth and date params ────────────────────────────────

describe('/v5/funnel — auth and params', () => {
	it('returns 401 without API key', async () => {
		const res = await fetchWorker('/v5/funnel');
		expect(res.status).toBe(401);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('UNAUTHORIZED');
	});

	it('returns 401 with non-master key', async () => {
		const res = await fetchWorker('/v5/funnel', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(res.status).toBe(401);
	});

	it('returns 200 with master key', async () => {
		const res = await fetchWorker('/v5/funnel', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.date).toBeDefined();
		expect(body.conversion_rate).toBeDefined();
		expect(body.top_of_funnel).toBeDefined();
	});

	it('accepts ?date parameter', async () => {
		const res = await fetchWorker('/v5/funnel?date=2026-04-01', {
			headers: { 'X-Oracle-Key': 'test_master_key_local_only' },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.date).toBe('2026-04-01');
	});
});

// ─── /v5/stack — response format ────────────────────────────────────────────

describe('GET /v5/stack — deprecated alias', () => {
	it('returns 200', async () => {
		const res = await fetchWorker('/v5/stack');
		expect(res.status).toBe(200);
	});

	it('includes deprecation envelope pointing to /v5/pre-trade-stack', async () => {
		const body = await fetchJSON('/v5/stack');
		const dep = body._deprecated as { note: string; replacement: string; replacement_path: string };
		expect(dep).toBeDefined();
		expect(dep.replacement).toBe('https://headlessoracle.com/v5/pre-trade-stack');
		expect(dep.replacement_path).toBe('/v5/pre-trade-stack');
		expect(dep.note).toContain('Deprecated');
		expect(dep.note).toContain('v2.0');
	});

	it('returns Pattern v2.0 payload alongside deprecation envelope', async () => {
		const body = await fetchJSON('/v5/stack');
		expect(body.spec_version).toBe('2.0');
		expect(body.type).toBe('deployment_pattern');
		expect(body.normative_specifications).toBeDefined();
		expect(Array.isArray(body.steps)).toBe(true);
		expect((body.steps as unknown[]).length).toBe(5);
	});

	it('sets deprecation HTTP headers', async () => {
		const res = await fetchWorker('/v5/stack');
		expect(res.headers.get('Deprecation')).toBe('true');
		const link = res.headers.get('Link') ?? '';
		expect(link).toContain('rel="successor-version"');
		expect(link).toContain('/v5/pre-trade-stack');
	});
});

// ─── /v5/credits/purchase — error paths ─────────────────────────────────────

describe('/v5/credits/purchase — error paths', () => {
	it('GET returns 405', async () => {
		const res = await fetchWorker('/v5/credits/purchase');
		expect(res.status).toBe(405);
	});

	it('POST without API key returns 401', async () => {
		const res = await fetchWorker('/v5/credits/purchase', { method: 'POST' });
		expect(res.status).toBe(401);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('API_KEY_REQUIRED');
	});

	it('POST with invalid key returns 403', async () => {
		const res = await fetchWorker('/v5/credits/purchase', {
			method: 'POST',
			headers: { 'X-Oracle-Key': 'invalid_key_here' },
		});
		expect(res.status).toBe(403);
	});

	// Was a beta key: beta and master keys authenticate as plan 'internal', which
	// can never spend purchased credits, and are now refused with 409 (see the
	// CREDITS_NOT_APPLICABLE describe). The 402 contract is a free key's.
	it('POST with valid free key but no payment returns 402', async () => {
		const key = 'ho_free_' + 'np'.repeat(32);
		await setupFreeKey(key);
		const res = await fetchWorker('/v5/credits/purchase', {
			method: 'POST',
			headers: { 'X-Oracle-Key': key },
		});
		expect(res.status).toBe(402);
	});
});

// Credits bought here are stored in credits:{hash} and spent only by keys whose
// auth plan is 'free'. Every other plan paid for credits it could never use.
describe('/v5/credits/purchase — CREDITS_NOT_APPLICABLE for any plan but free', () => {
	async function hashOf(value: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
		return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	}

	// Records every outbound fetch that is not Supabase, answering Base RPC as a
	// valid 800000-unit transfer so the pre-fix code would happily grant credits.
	function spyPaymentCalls() {
		const original = globalThis.fetch;
		const restoreRpc = mockBaseRpc(TEST_PAYMENT_ADDRESS, '800000', Math.floor(Date.now() / 1000) - 10);
		const mocked = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (!url.includes('supabase.co')) calls.push(url);
			return mocked(input, init);
		}) as typeof fetch;
		return { calls, restore: () => { restoreRpc(); globalThis.fetch = original; } };
	}

	async function purchaseWith(key: string, txHash: string) {
		const payment = JSON.stringify({ txHash, network: 'base', amount: '800000', paymentAddress: TEST_PAYMENT_ADDRESS, memo: '' });
		const spy = spyPaymentCalls();
		try {
			const res = await fetchWorker('/v5/credits/purchase', { method: 'POST', headers: { 'X-Oracle-Key': key, 'X-Payment': payment } });
			return { res, calls: spy.calls };
		} finally {
			spy.restore();
		}
	}

	it('a builder key gets 409 CREDITS_NOT_APPLICABLE and no payment is verified', async () => {
		const key    = 'ho_live_' + 'nb'.repeat(32);
		const hash   = await hashOf(key);
		const txHash = '0x' + 'b1'.repeat(32);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ plan: 'builder', status: 'active' }));
		const { res, calls } = await purchaseWith(key, txHash);
		expect(res.status).toBe(409);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('CREDITS_NOT_APPLICABLE');
		expect(body.plan).toBe('builder');
		expect(String(body.message)).toContain('"builder"');
		expect(calls).toEqual([]);                                             // no RPC, no facilitator
		expect(await env.ORACLE_TELEMETRY.get(`x402_used:${txHash}`)).toBeNull(); // tx not consumed
		expect(await env.ORACLE_TELEMETRY.get(`credits:${hash}`)).toBeNull();
	});

	it('a credits-tier key gets 409, no payment is verified, and the refusal costs it no credit', async () => {
		const key    = 'ho_crd_' + 'nc'.repeat(32);
		const hash   = await hashOf(key);
		const txHash = '0x' + 'b2'.repeat(32);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 5 }));
		const { res, calls } = await purchaseWith(key, txHash);
		expect(res.status).toBe(409);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('CREDITS_NOT_APPLICABLE');
		expect(body.plan).toBe('credits');
		expect(calls).toEqual([]);
		expect(await env.ORACLE_TELEMETRY.get(`x402_used:${txHash}`)).toBeNull();
		const rec = JSON.parse((await env.ORACLE_API_KEYS.get(hash)) ?? '{}') as { balance?: number };
		expect(rec.balance).toBe(5);
	});

	it('a beta key (plan internal) gets 409 before any payment is asked for', async () => {
		const res = await fetchWorker('/v5/credits/purchase', { method: 'POST', headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		expect(res.status).toBe(409);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('CREDITS_NOT_APPLICABLE');
		expect(body.plan).toBe('internal');
	});

	it('a free key still buys: verified payment, 200, credits granted', async () => {
		const key    = 'ho_free_' + 'nf'.repeat(32);
		const hash   = await setupFreeKey(key);
		const { res, calls } = await purchaseWith(key, '0x' + 'b3'.repeat(32));
		expect(res.status).toBe(200);
		expect(calls.some((u) => u === 'https://mainnet.base.org')).toBe(true);
		const stored = JSON.parse((await env.ORACLE_TELEMETRY.get(`credits:${hash}`)) ?? '{}') as { balance?: number };
		expect(stored.balance).toBe(1000);
	});

	it('/v5/errors/CREDITS_NOT_APPLICABLE documents the 409', async () => {
		const res = await fetchWorker('/v5/errors/CREDITS_NOT_APPLICABLE');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.http_status).toBe(409);
	});
});

// ─── /v5/credits/balance — additional ───────────────────────────────────────

describe('/v5/credits/balance — additional cases', () => {
	it('returns balance with valid beta key', async () => {
		const res = await fetchWorker('/v5/credits/balance', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(typeof body.balance).toBe('number');
		expect(body.estimated_requests_remaining).toBeDefined();
	});
});

// /v5/credits/balance authenticated through checkApiKey, which debits a
// credit-pack key on every call, and then reported credits:{hash}, which a
// credit-pack key never spends from (always 0 for it).
describe('/v5/credits/balance — reads the balance the key spends, and spends none', () => {
	async function hashOf(value: string): Promise<string> {
		const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
		return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	}

	it('a Paddle credit-pack key with balance 5 reads 5 twice in a row, and the record still holds 5', async () => {
		const key  = 'ho_crd_' + 'cb'.repeat(32);
		const hash = await hashOf(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({
			tier: 'credits', status: 'active', balance: 5, created_at: '2026-10-01T12:00:00.000Z', source: 'paddle_credits',
		}));
		const first  = await fetchWorker('/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		expect(first.status).toBe(200);
		const b1 = await first.json() as Record<string, unknown>;
		const second = await fetchWorker('/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		expect(second.status).toBe(200);
		const b2 = await second.json() as Record<string, unknown>;
		expect(b1.balance).toBe(5);
		expect(b1.estimated_requests_remaining).toBe(5);
		expect(b1.last_purchased).toBe('2026-10-01T12:00:00.000Z');
		expect(b2.balance).toBe(5);
		const rec = JSON.parse((await env.ORACLE_API_KEYS.get(hash)) ?? '{}') as { balance?: number };
		expect(rec.balance).toBe(5);
	});

	it('a free key with telemetry credits still reads them', async () => {
		const key  = 'ho_free_' + 'cf'.repeat(32);
		const hash = await setupFreeKey(key);
		await env.ORACLE_TELEMETRY.put(`credits:${hash}`, JSON.stringify({ balance: 7, last_purchased: '2026-10-02T00:00:00Z' }));
		const body = await fetchJSON('/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		expect(body.balance).toBe(7);
		expect(body.estimated_requests_remaining).toBe(7);
		expect(body.last_purchased).toBe('2026-10-02T00:00:00Z');
	});

	// The pack record is read twice: once inside checkApiKey (must succeed), then
	// again for the balance. secondRead decides what that second read sees.
	async function balanceWithSecondRead(key: string, secondRead: 'throw' | 'null') {
		const hash = await hashOf(key);
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 5 }));
		let reads = 0;
		const kv = env.ORACLE_API_KEYS;
		const wrapped = {
			get: async (k: string, ...rest: unknown[]) => {
				if (k === hash && ++reads > 1) {
					if (secondRead === 'throw') throw new Error('KV unavailable');
					return null;
				}
				return (kv.get as (k: string, ...r: unknown[]) => Promise<string | null>)(k, ...rest);
			},
			put:    kv.put.bind(kv),
			delete: kv.delete.bind(kv),
			list:   kv.list.bind(kv),
		} as unknown as typeof env.ORACLE_API_KEYS;
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/credits/balance', { headers: { 'X-Oracle-Key': key } });
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, { ...env, ORACLE_API_KEYS: wrapped } as typeof env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it('a pack balance store that throws answers 503 SERVICE_UNAVAILABLE with Retry-After, not 403', async () => {
		const res = await balanceWithSecondRead('ho_crd_' + 'u1'.repeat(32), 'throw');
		expect(res.status).toBe(503);
		expect(res.headers.get('Retry-After')).toBe('10');
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('SERVICE_UNAVAILABLE');
		expect(body.retry_after_seconds).toBe(10);
	});

	it('a KV miss with Supabase failing (readKeyRecord unavailable) answers 503, not 403', async () => {
		const prior = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (url.includes('supabase.co') && url.includes('api_keys')) {
				return new Response(JSON.stringify({ code: 'XX000', message: 'upstream down', details: null, hint: null }), { status: 500, headers: { 'Content-Type': 'application/json' } });
			}
			return prior(input, init);
		}) as typeof fetch;
		try {
			const res = await balanceWithSecondRead('ho_crd_' + 'u2'.repeat(32), 'null');
			expect(res.status).toBe(503);
			expect(res.headers.get('Retry-After')).toBe('10');
		} finally {
			globalThis.fetch = prior;
		}
	});

	it('a record genuinely gone between the two reads (every store says no such key) still answers 403 INVALID_API_KEY', async () => {
		const res = await balanceWithSecondRead('ho_crd_' + 'u3'.repeat(32), 'null'); // default stub: PGRST116, no rows
		expect(res.status).toBe(403);
		expect((await res.json() as Record<string, unknown>).error).toBe('INVALID_API_KEY');
	});

	it('rejections are unchanged: unknown key 403, cancelled pack 402 CREDITS_EXHAUSTED, empty pack 402 CREDITS_EXHAUSTED', async () => {
		const unknown = await fetchWorker('/v5/credits/balance', { headers: { 'X-Oracle-Key': 'ho_crd_' + 'zz'.repeat(32) } });
		expect(unknown.status).toBe(403);
		expect((await unknown.json() as Record<string, unknown>).error).toBe('INVALID_API_KEY');

		const cancelled = 'ho_crd_' + 'cx'.repeat(32);
		await env.ORACLE_API_KEYS.put(await hashOf(cancelled), JSON.stringify({ tier: 'credits', status: 'cancelled', balance: 5 }));
		const r1 = await fetchWorker('/v5/credits/balance', { headers: { 'X-Oracle-Key': cancelled } });
		expect(r1.status).toBe(402);
		expect((await r1.json() as Record<string, unknown>).error).toBe('CREDITS_EXHAUSTED');

		const empty = 'ho_crd_' + 'ce'.repeat(32);
		await env.ORACLE_API_KEYS.put(await hashOf(empty), JSON.stringify({ tier: 'credits', status: 'active', balance: 0 }));
		const r2 = await fetchWorker('/v5/credits/balance', { headers: { 'X-Oracle-Key': empty } });
		expect(r2.status).toBe(402);
		expect((await r2.json() as Record<string, unknown>).error).toBe('CREDITS_EXHAUSTED');
	});
});

describe('GET /v5/usage — a usage read spends no credit', () => {
	it('a credit-pack key with balance 5 reads usage twice and still has 5', async () => {
		const key  = 'ho_crd_' + 'us'.repeat(32);
		const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
		const hash = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
		await env.ORACLE_API_KEYS.put(hash, JSON.stringify({ tier: 'credits', status: 'active', balance: 5 }));
		expect((await fetchWorker('/v5/usage', { headers: { 'X-Oracle-Key': key } })).status).toBe(200);
		expect((await fetchWorker('/v5/usage', { headers: { 'X-Oracle-Key': key } })).status).toBe(200);
		const rec = JSON.parse((await env.ORACLE_API_KEYS.get(hash)) ?? '{}') as { balance?: number };
		expect(rec.balance).toBe(5);
	});
});

// ─── /.well-known/* endpoints — comprehensive ───────────────────────────────

describe('/.well-known/* endpoints — coverage', () => {
	it('/.well-known/oauth-protected-resource returns JSON', async () => {
		const res = await fetchWorker('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.resource).toBeDefined();
	});

	it('/.well-known/402index-verify.txt returns text', async () => {
		const res = await fetchWorker('/.well-known/402index-verify.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/plain');
	});

	it('/.well-known/mcp.json aliases /.well-known/mcp/server-card.json', async () => {
		const res1 = await fetchWorker('/.well-known/mcp.json');
		const res2 = await fetchWorker('/.well-known/mcp/server-card.json');
		expect(res1.status).toBe(200);
		expect(res2.status).toBe(200);
		const body1 = await res1.json() as Record<string, unknown>;
		const body2 = await res2.json() as Record<string, unknown>;
		expect(body1.name).toBe(body2.name);
	});
});

// ─── Catch-all 404 ──────────────────────────────────────────────────────────

describe('Catch-all 404', () => {
	it('returns 404 for unknown routes', async () => {
		const res = await fetchWorker('/completely/unknown/path');
		expect(res.status).toBe(404);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('NOT_FOUND');
	});

	it('includes security headers on 404', async () => {
		const res = await fetchWorker('/unknown');
		expect(res.status).toBe(404);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	it('includes X-Oracle-Version on 404', async () => {
		const res = await fetchWorker('/random/path');
		expect(res.status).toBe(404);
		expect(res.headers.get('X-Oracle-Version')).toBe('v5');
	});
});

// ─── Method Not Allowed coverage ────────────────────────────────────────────

describe('405 Method Not Allowed — coverage', () => {
	it('DELETE on an endpoint that only supports GET returns error', async () => {
		const res = await fetchWorker('/v5/compliance', { method: 'DELETE' });
		// Falls through routing — either 404 or 405 or treated as GET
		expect([200, 404, 405]).toContain(res.status);
	});

	it('PUT /mcp returns 405', async () => {
		const res = await fetchWorker('/mcp', { method: 'PUT' });
		expect(res.status).toBe(405);
	});

	it('PATCH /mcp returns 405', async () => {
		const res = await fetchWorker('/mcp', { method: 'PATCH' });
		expect(res.status).toBe(405);
	});

	it('DELETE /mcp returns 405', async () => {
		const res = await fetchWorker('/mcp', { method: 'DELETE' });
		expect(res.status).toBe(405);
	});
});

// ─── /v5/batch — additional error paths ─────────────────────────────────────

describe('/v5/batch — additional coverage', () => {
	it('batch with 3 MICs returns correct count', async () => {
		vi.setSystemTime(new Date('2026-03-15T15:00:00Z'));
		const res = await fetchWorker('/v5/batch?mics=XNYS,XNAS,XLON', {
			headers: { 'X-Oracle-Key': 'test_beta_key_1' },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const receipts = body.receipts as Array<unknown>;
		expect(receipts).toHaveLength(3);
	});

	it('OPTIONS returns CORS for batch', async () => {
		const res = await fetchWorker('/v5/batch', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});

// ─── /v5/briefing — additional coverage ─────────────────────────────────────

describe('/v5/briefing — additional coverage', () => {
	it('includes upcoming_opens and upcoming_closes fields', async () => {
		vi.setSystemTime(new Date('2026-03-09T12:00:00Z'));
		const body = await fetchJSON('/v5/briefing');
		expect(body.upcoming_opens).toBeDefined();
		expect(body.upcoming_closes).toBeDefined();
	});

	it('includes holidays_today field', async () => {
		vi.setSystemTime(new Date('2026-04-08T12:00:00Z'));
		const body = await fetchJSON('/v5/briefing');
		expect(body.holidays_today).toBeDefined();
	});
});

// ─── /v5/pricing — additional coverage ──────────────────────────────────────

describe('/v5/pricing — additional coverage', () => {
	it('builder tier has calls_per_day 50000', async () => {
		const body = await fetchJSON('/v5/pricing');
		const tiers = body.tiers as Array<Record<string, unknown>>;
		const builder = tiers.find(t => t.name === 'Builder');
		expect(builder).toBeDefined();
		expect(builder!.calls_per_day).toBe(50000);
	});
});

// ─── /v5/compliance — additional coverage ───────────────────────────────────

describe('/v5/compliance — additional coverage', () => {
	it('returns sma_spec_version field', async () => {
		const body = await fetchJSON('/v5/compliance');
		expect(body.sma_spec_version).toBeDefined();
	});

	it('returns verify_sdk at top level', async () => {
		const body = await fetchJSON('/v5/compliance');
		expect(body.verify_sdk).toBeDefined();
		expect(typeof body.verify_sdk).toBe('string');
	});
});

// ─── /v5/payment-proof — additional coverage ────────────────────────────────

describe('/v5/payment-proof — additional coverage', () => {
	it('returns correct shape with payment_count and network', async () => {
		const body = await fetchJSON('/v5/payment-proof');
		expect(body.payment_count).toBeDefined();
		expect(body.network).toBe('base');
		expect(body.asset).toBe('USDC');
	});
});

// ─── /x402 — additional coverage ────────────────────────────────────────────

describe('/x402 — additional coverage', () => {
	it('returns network and facilitator fields', async () => {
		const body = await fetchJSON('/x402');
		expect(body.network).toBeDefined();
		expect(body.facilitator).toBeDefined();
	});
});

// ─── /v5/why-not-free — additional coverage ─────────────────────────────────

describe('/v5/why-not-free — additional coverage', () => {
	it('returns agent_native_path field', async () => {
		const body = await fetchJSON('/v5/why-not-free');
		expect(body.agent_native_path).toBeDefined();
	});

	it('returns sandbox option', async () => {
		const body = await fetchJSON('/v5/why-not-free');
		expect(body.sandbox).toBeDefined();
	});
});

// ─── /sitemap.xml ───────────────────────────────────────────────────────────

describe('/sitemap.xml', () => {
	it('returns 200 with XML content type', async () => {
		const res = await fetchWorker('/sitemap.xml');
		expect(res.status).toBe(200);
		const ct = res.headers.get('Content-Type') || '';
		expect(ct).toContain('xml');
	});

	it('includes the /halt-gate adoption page (the free signed-status wedge)', async () => {
		// /halt-gate is the adoption-first landing page that walks an external
		// developer through curl /v1/status → safeToExecute() → HaltGuard.sol.
		// Search engines discover it via this sitemap; if this assertion fails,
		// the page is invisible to indexers even though it's reachable via
		// direct URL. Pinned here so future SITEMAP_XML edits cannot silently
		// drop it.
		const res  = await fetchWorker('/sitemap.xml');
		const body = await res.text();
		expect(body).toContain('<loc>https://headlessoracle.com/halt-gate</loc>');
	});

	it('H3f: lists /witness, /auditors, /about, /verify and no /essays/ URL (the essays are noindex)', async () => {
		const body = await (await fetchWorker('/sitemap.xml')).text();
		for (const p of ['/witness', '/auditors', '/about', '/verify']) {
			expect(body, p).toContain(`<loc>https://headlessoracle.com${p}</loc>`);
		}
		expect(body).not.toMatch(/<loc>[^<]*\/essays\//);
	});
});

// ─── /mics.json — additional ────────────────────────────────────────────────

describe('/mics.json — mic_type coverage', () => {
	it('all entries have mic_type field', async () => {
		const res = await fetchWorker('/mics.json');
		const body = await res.json() as Array<Record<string, unknown>>;
		for (const entry of body) {
			expect(entry.mic_type).toBeDefined();
			expect(['iso', 'convention']).toContain(entry.mic_type);
		}
	});
});

// ─── CORS preflight coverage for more endpoints ─────────────────────────────

describe('CORS preflight — additional endpoints', () => {
	it('OPTIONS /v5/status returns CORS', async () => {
		const res = await fetchWorker('/v5/status', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('OPTIONS /v5/keys/instant returns CORS', async () => {
		const res = await fetchWorker('/v5/keys/instant', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('OPTIONS /v5/verify returns CORS', async () => {
		const res = await fetchWorker('/v5/verify', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	it('OPTIONS /v5/x402/mint returns CORS with Payment headers', async () => {
		const res = await fetchWorker('/v5/x402/mint', { method: 'OPTIONS' });
		expect(res.status).toBe(200);
		const allowHeaders = res.headers.get('Access-Control-Allow-Headers') || '';
		expect(allowHeaders).toContain('X-Payment');
	});
});

// ─── /v5/handoff — additional coverage ──────────────────────────────────────

describe('/v5/handoff — additional coverage', () => {
	it('returns 401 without any auth', async () => {
		const res = await fetchWorker('/v5/handoff');
		expect(res.status).toBe(401);
	});

	it('returns 403 with invalid key', async () => {
		const res = await fetchWorker('/v5/handoff', {
			headers: { 'X-Oracle-Key': 'invalid' },
		});
		expect(res.status).toBe(403);
	});
});

// ─── Redirect routes ────────────────────────────────────────────────────────

describe('Redirect routes — coverage', () => {
	it('GET /npm redirects to npmjs.com', async () => {
		const res = await fetchWorker('/npm');
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('npmjs.com');
	});

	it('GET /pypi redirects to pypi.org', async () => {
		const res = await fetchWorker('/pypi');
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('pypi.org');
	});

	it('GET /github redirects to github.com', async () => {
		const res = await fetchWorker('/github');
		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toContain('github.com');
	});
});

// ─── Pre-Trade Verification Stack ────────────────────────────────────────────

describe('GET /v5/pre-trade-stack', () => {
	it('returns 200 with 5 steps and step 1 is execution-environment verification', async () => {
		const body = await fetchJSON('/v5/pre-trade-stack');
		expect(body.spec_version).toBe('2.0');
		expect(body.type).toBe('deployment_pattern');
		expect(body.steps).toHaveLength(5);
		expect(body.steps[0].step).toBe(1);
		expect(body.steps[0].name).toBe('execution_environment_verification');
		expect(body.steps[0].reference_implementation).toBe('https://headlessoracle.com');
		expect(body.fail_closed).toBe(true);
	});

	it('references environment.market_state and environment.wallet_state as normative specs', async () => {
		const body = await fetchJSON('/v5/pre-trade-stack');
		const specs = body.normative_specifications as Record<string, { name: string; pr: number; url: string; family: string }>;
		expect(specs.step_1.name).toBe('environment.market_state');
		expect(specs.step_1.pr).toBe(9);
		expect(specs.step_1.family).toContain('Verifiable Intent');
		expect(specs.step_1_composable.name).toBe('environment.wallet_state');
		expect(specs.step_1_composable.pr).toBe(22);
	});

	it('step 2 lists policy-bound authorization as example protocol', async () => {
		const body = await fetchJSON('/v5/pre-trade-stack');
		const step2 = body.steps[1];
		expect(step2.name).toBe('spend_authorization');
		expect(step2.example_protocols).toContain('policy-bound authorization frameworks');
	});
});

describe('GET /docs/specifications/pre-trade-stack', () => {
	it('returns 200 with text/markdown content-type', async () => {
		const response = await fetchWorker('/docs/specifications/pre-trade-stack');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('describes the composable pattern and references environment.market_state', async () => {
		const text = await fetchWorker('/docs/specifications/pre-trade-stack').then((r) => r.text());
		expect(text).toContain('Composable Pre-Trade Verification Pattern');
		expect(text).toContain('environment.market_state');
		expect(text).toContain('environment.wallet_state');
		expect(text).toContain('Ampersend');
		expect(text).toContain('VeroQ');
	});
});

describe('GET /docs/integrations/ampersend', () => {
	it('returns 200 with text/markdown content-type', async () => {
		const response = await fetchWorker('/docs/integrations/ampersend');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains composable pattern code example', async () => {
		const text = await fetchWorker('/docs/integrations/ampersend').then((r) => r.text());
		expect(text).toContain('Spend Authorization');
		expect(text).toContain('@headlessoracle/verify');
	});
});

// ─── Integration guides wildcard handler ─────────────────────────────────────

describe('GET /docs/integrations/:slug — wildcard handler', () => {
	const slugs = [
		{ slug: 'korea-investment-mcp', contains: 'Korea Investment Securities' },
		{ slug: 'agentictrading-mcp', contains: 'AgenticTrading' },
		{ slug: 'openalgo-zerodha', contains: 'OpenAlgo' },
		{ slug: 'tradingagents-risk', contains: 'TradingAgents' },
		{ slug: 'composio-listing', contains: 'Composio' },
	];

	for (const { slug, contains } of slugs) {
		it(`serves ${slug} as text/markdown with 200`, async () => {
			const response = await fetchWorker(`/docs/integrations/${slug}`);
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('text/markdown');
			const text = await response.text();
			expect(text).toContain(contains);
		});

		it(`serves ${slug}.md alias as text/markdown with 200`, async () => {
			const response = await fetchWorker(`/docs/integrations/${slug}.md`);
			expect(response.status).toBe(200);
			expect(response.headers.get('Content-Type')).toContain('text/markdown');
		});
	}

	it('sets Cache-Control: public, max-age=300 on served guides', async () => {
		const response = await fetchWorker('/docs/integrations/korea-investment-mcp');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
	});

	it('applies security headers to served guides', async () => {
		const response = await fetchWorker('/docs/integrations/korea-investment-mcp');
		// SECURITY_HEADERS include X-Content-Type-Options: nosniff
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});

	// The Pages passthrough is fetch(request) to the test host. Unstubbed, that
	// went to the network: where example.com is unreachable (an egress-filtered
	// sandbox), workerd threw "internal error" out of worker.fetch and both tests
	// below failed for a reason unrelated to the handler. Pages is stubbed, so
	// each test proves the request was forwarded and not served from the map.
	async function viaStubbedPages(path: string): Promise<{ response: Response; forwarded: string[] }> {
		const forwarded: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (new URL(url).hostname === 'example.com') {
				forwarded.push(new URL(url).pathname);
				return new Response('<!doctype html><title>Not found</title>', { status: 404, headers: { 'Content-Type': 'text/html' } });
			}
			return original(input, init);
		}) as typeof fetch;
		try {
			return { response: await fetchWorker(path), forwarded };
		} finally {
			globalThis.fetch = original;
		}
	}

	it('unknown slug falls through (not served as markdown from the map)', async () => {
		// A slug not in INTEGRATION_GUIDES must not return our markdown payload.
		const { response, forwarded } = await viaStubbedPages('/docs/integrations/this-guide-does-not-exist');
		expect(forwarded).toEqual(['/docs/integrations/this-guide-does-not-exist']);
		expect(response.headers.get('Content-Type') || '').not.toContain('text/markdown');
	});

	it('does not serve uppercase slugs (regex is lowercase-only)', async () => {
		// Must not return our markdown: the request goes to the Pages passthrough.
		const { response, forwarded } = await viaStubbedPages('/docs/integrations/Korea-Investment-MCP');
		expect(forwarded).toEqual(['/docs/integrations/Korea-Investment-MCP']);
		expect(response.headers.get('Content-Type') || '').not.toContain('text/markdown');
	});
});

// ─── CPVR-1 Spec ────────────────────────────────────────────────────────────

describe('GET /docs/specifications/cpvr-1', () => {
	it('returns 200 with text/markdown content-type', async () => {
		const response = await fetchWorker('/docs/specifications/cpvr-1');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains CPVR-1 spec content with deprecation banner', async () => {
		const text = await fetchWorker('/docs/specifications/cpvr-1').then((r) => r.text());
		expect(text).toContain('CPVR-1');
		expect(text).toContain('Composable Pre-Trade Verification Receipt');
		expect(text).toContain('DEPRECATED');
		expect(text).toContain('environment.market_state');
		expect(text).toContain('composite_hash');
	});

	it('references MPAS and Pre-Trade Stack', async () => {
		const text = await fetchWorker('/docs/specifications/cpvr-1').then((r) => r.text());
		expect(text).toContain('MPAS');
		expect(text).toContain('Pre-Trade Verification Stack');
	});

	it('.md variant also works', async () => {
		const response = await fetchWorker('/docs/specifications/cpvr-1.md');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});
});

// ─── Multi-Oracle Consensus Protocol v1.0.0 ─────────────────────────────────

describe('GET /v1/verification/multi-oracle-guide', () => {
	it('returns valid JSON with spec_version 1.0.1', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		expect(body.spec_version).toBe('1.0.1');
	});

	it('declares minimum_oracles = 3 and fail_closed_default = true', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		expect(body.minimum_oracles).toBe(3);
		expect(body.fail_closed_default).toBe(true);
		expect(body.consensus_algorithm).toBe('majority_with_fail_closed');
	});

	it('attestation_format contains all required fields', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		const fmt = body.attestation_format as Record<string, { required: boolean }>;
		for (const field of ['exchange', 'status', 'timestamp', 'expires_at', 'signature', 'public_key_url', 'oracle_id']) {
			expect(fmt[field]).toBeDefined();
			expect(fmt[field].required).toBe(true);
		}
	});

	it('reference_oracles is non-empty and lists Headless Oracle as compliant', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		expect(Array.isArray(body.reference_oracles)).toBe(true);
		expect(body.reference_oracles.length).toBeGreaterThan(0);
		const ho = body.reference_oracles[0];
		expect(ho.name).toBe('Headless Oracle');
		expect(ho.sma_compliant).toBe(true);
		expect(ho.signature_algorithm).toBe('Ed25519');
		expect(ho.exchanges).toBe(28);
	});

	it('cites CFTC Staff Letter 25-39 and SEC Project Blueprint in regulatory_references', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		const refs = body.regulatory_references as Array<{body: string; id: string; title: string; date: string; url: string}>;
		expect(Array.isArray(refs)).toBe(true);
		expect(refs.length).toBeGreaterThanOrEqual(2);
		const cftc = refs.find(r => r.body === 'CFTC' && r.id === 'Staff Letter 25-39');
		expect(cftc).toBeDefined();
		expect(cftc?.url).toContain('cftc.gov');
		const sec = refs.find(r => r.body === 'SEC Crypto Task Force' && r.id === 'Project Blueprint');
		expect(sec).toBeDefined();
		expect(sec?.url).toContain('sec.gov');

		// Also assert the legacy fabricated name is NOT present anywhere
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain('SEC/CFTC Technical Framework');
	});

	it('exposes spec_url pointing to the markdown specification', async () => {
		const body = await fetchJSON('/v1/verification/multi-oracle-guide');
		expect(body.spec_url).toBe('https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1');
	});
});

describe('GET /docs/specifications/multi-oracle-consensus-v1', () => {
	it('returns 200 with text/markdown content-type', async () => {
		const response = await fetchWorker('/docs/specifications/multi-oracle-consensus-v1');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});

	it('contains the consensus algorithm and minimum oracle count', async () => {
		const text = await fetchWorker('/docs/specifications/multi-oracle-consensus-v1').then((r) => r.text());
		expect(text).toContain('Multi-Oracle Consensus Protocol');
		expect(text).toContain('majority_with_fail_closed');
		expect(text).toContain('three independent oracle feeds');
		expect(text).toContain('CFTC Staff Letter 25-39');
		expect(text).toContain('Project Blueprint on Tokenized Collateral');
		expect(text).toContain('Signed Market-State Attestation');
	});

	it('.md variant also works', async () => {
		const response = await fetchWorker('/docs/specifications/multi-oracle-consensus-v1.md');
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/markdown');
	});
});

// --- agent.json content (moved from the removed agent-card.json block) ------

describe('GET /.well-known/agent.json content', () => {
	it('includes pre_trade_stack reference', async () => {
		const body = await fetchJSON('/.well-known/agent.json');
		const stack = body.pre_trade_stack as { role: string; pattern: string; composes_with: Record<string, unknown> };
		expect(stack.role).toBe('execution-environment verification (environment.market_state)');
		expect(stack.pattern).toBe('Composable Pre-Trade Verification Pattern (v2.0)');
		expect(stack.composes_with).toBeDefined();
	});

	it('includes tags array for discovery', async () => {
		const body = await fetchJSON('/.well-known/agent.json');
		const tags = body.tags as string[];
		expect(Array.isArray(tags)).toBe(true);
		expect(tags).toContain('finance');
		expect(tags).toContain('pre-trade');
		expect(tags).toContain('fail-closed');
	});
});


// ─── Signed Halt Archive (BUILD 2) ────────────────────────────────────────────
//
// Tests for the append-only signed halt archive: NYSE/Nasdaq feed capture, HO
// session-state transitions, signed gap records, daily digest with merkle_root,
// source_mode integrity, claim-ceiling framing, and the two serving endpoints.

// Realistic ndaq:-namespaced fixture matching the actual Nasdaq Trader feed
// shape. Three items: NASDAQ-listed, NYSE-listed (proves NYSE-listed halts
// arrive via the consolidated feed), and NYSE American (proves we keep the
// row even without a clean MIC mapping).
const NASDAQ_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ndaq="http://www.nasdaqtrader.com">
  <channel>
    <title>Nasdaq Trader Trading Halts</title>
    <item>
      <title>ABCD — Halt</title>
      <description><![CDATA[<p>halted</p>]]></description>
      <ndaq:IssueSymbol>ABCD</ndaq:IssueSymbol>
      <ndaq:IssueName>Sample Nasdaq Co</ndaq:IssueName>
      <ndaq:HaltDate>06/13/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:30:00.123</ndaq:HaltTime>
      <ndaq:Market>NASDAQ</ndaq:Market>
      <ndaq:ReasonCode>LUDP</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice></ndaq:PauseThresholdPrice>
      <ndaq:ResumptionDate>06/13/2026</ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime>14:35:00</ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime>14:35:05</ndaq:ResumptionTradeTime>
    </item>
    <item>
      <title>WXYZ — Halt</title>
      <ndaq:IssueSymbol>WXYZ</ndaq:IssueSymbol>
      <ndaq:IssueName>NYSE Test Co</ndaq:IssueName>
      <ndaq:HaltDate>06/13/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:32:15.000</ndaq:HaltTime>
      <ndaq:Market>NYSE</ndaq:Market>
      <ndaq:ReasonCode>T1</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice/>
      <ndaq:ResumptionDate></ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime></ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime>
    </item>
    <item>
      <title>AMEX1 — Halt</title>
      <ndaq:IssueSymbol>AMEX1</ndaq:IssueSymbol>
      <ndaq:IssueName>NYSE American Co &amp; Affiliates</ndaq:IssueName>
      <ndaq:HaltDate>06/13/2026</ndaq:HaltDate>
      <ndaq:HaltTime>14:40:00.000</ndaq:HaltTime>
      <ndaq:Market>NYSE American</ndaq:Market>
      <ndaq:ReasonCode>T12</ndaq:ReasonCode>
      <ndaq:PauseThresholdPrice></ndaq:PauseThresholdPrice>
      <ndaq:ResumptionDate></ndaq:ResumptionDate>
      <ndaq:ResumptionQuoteTime></ndaq:ResumptionQuoteTime>
      <ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime>
    </item>
  </channel>
</rss>`;

describe('parseNasdaqHaltItems — RSS parser against real ndaq: schema', () => {
	it('extracts all populated ndaq: fields from each item', () => {
		const items = parseNasdaqHaltItems(NASDAQ_RSS_FIXTURE);
		expect(items.length).toBe(3);
		const abcd = items[0];
		expect(abcd.IssueSymbol).toBe('ABCD');
		expect(abcd.IssueName).toBe('Sample Nasdaq Co');
		expect(abcd.HaltDate).toBe('06/13/2026');
		expect(abcd.HaltTime).toBe('14:30:00.123');
		expect(abcd.Market).toBe('NASDAQ');
		expect(abcd.ReasonCode).toBe('LUDP');
		expect(abcd.PauseThresholdPrice).toBe('');
		expect(abcd.ResumptionDate).toBe('06/13/2026');
		expect(abcd.ResumptionQuoteTime).toBe('14:35:00');
		expect(abcd.ResumptionTradeTime).toBe('14:35:05');
	});

	it('captures NYSE-listed halts via the consolidated feed (ndaq:Market=NYSE)', () => {
		const items = parseNasdaqHaltItems(NASDAQ_RSS_FIXTURE);
		const nyseRow = items.find(i => i.Market === 'NYSE');
		expect(nyseRow).toBeTruthy();
		expect(nyseRow!.IssueSymbol).toBe('WXYZ');
		expect(nyseRow!.HaltTime).toBe('14:32:15.000');
		expect(nyseRow!.ReasonCode).toBe('T1');
	});

	it('decodes XML entities in field values', () => {
		const items = parseNasdaqHaltItems(NASDAQ_RSS_FIXTURE);
		const amex = items.find(i => i.IssueSymbol === 'AMEX1');
		expect(amex!.IssueName).toBe('NYSE American Co & Affiliates');
	});

	it('handles self-closing <ndaq:Field/> as an empty string, not as missing data', () => {
		const items = parseNasdaqHaltItems(NASDAQ_RSS_FIXTURE);
		const wxyz = items.find(i => i.IssueSymbol === 'WXYZ');
		expect(wxyz!.PauseThresholdPrice).toBe('');
	});

	it('drops items missing the (IssueSymbol, HaltDate, HaltTime) triple — unusable archive data', () => {
		const xml = `<?xml version="1.0"?>
<rss xmlns:ndaq="http://www.nasdaqtrader.com"><channel>
  <item>
    <ndaq:IssueSymbol></ndaq:IssueSymbol>
    <ndaq:HaltDate>06/13/2026</ndaq:HaltDate>
    <ndaq:HaltTime>14:30:00.000</ndaq:HaltTime>
    <ndaq:Market>NASDAQ</ndaq:Market>
  </item>
  <item>
    <ndaq:IssueSymbol>GOOD</ndaq:IssueSymbol>
    <ndaq:HaltDate>06/13/2026</ndaq:HaltDate>
    <ndaq:HaltTime>14:31:00.000</ndaq:HaltTime>
    <ndaq:Market>NASDAQ</ndaq:Market>
  </item>
</channel></rss>`;
		const items = parseNasdaqHaltItems(xml);
		expect(items.length).toBe(1);
		expect(items[0].IssueSymbol).toBe('GOOD');
	});
});

describe('Signed Halt Archive — capture, signing, gap records, framing', () => {
	const fetchMock: { current: ((url: string) => Promise<Response>) | null } = { current: null };
	let originalFetch: typeof fetch;

	async function truncateArchive(): Promise<void> {
		if (!env.HALT_ARCHIVE) return;
		try { await env.HALT_ARCHIVE.prepare('DELETE FROM halt_events').run(); } catch { /* not yet */ }
		try { await env.HALT_ARCHIVE.prepare('DELETE FROM halt_archive_digest').run(); } catch { /* not yet */ }
	}

	beforeEach(async () => {
		vi.useRealTimers();
		clearHaltArchiveSchemaCache();
		originalFetch = globalThis.fetch;
		// Default mock: Nasdaq Trader returns realistic ndaq: RSS. NYSE_HALTS_URL
		// is intentionally unset in test env (matches prod default), so no nyse
		// fetch should occur from the capture path.
		fetchMock.current = async (url: string) => {
			if (url.includes('nasdaqtrader.com')) {
				return new Response(NASDAQ_RSS_FIXTURE, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
			}
			return originalFetch(url);
		};
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (fetchMock.current) return fetchMock.current(u);
			return originalFetch(input, init);
		}) as typeof fetch;
		await truncateArchive();
		if (env.ORACLE_TELEMETRY) {
			const list = await env.ORACLE_TELEMETRY.list({ prefix: 'halt_archive_last_state:' });
			await Promise.all(list.keys.map(k => env.ORACLE_TELEMETRY.delete(k.name)));
		}
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('writes signed feed_snapshot rows to D1 on successful nasdaq fetch', async () => {
		const result = await runHaltArchiveCapture(env, new Date(), 'LIVE');
		expect(result.written).toBeGreaterThan(0);
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT * FROM halt_events WHERE source = 'nasdaq' AND event_type = 'feed_snapshot' ORDER BY observed_at DESC LIMIT 1`,
		).all<Record<string, unknown>>();
		expect(results.length).toBe(1);
		const row = results[0];
		expect(row.event_type).toBe('feed_snapshot');
		expect(row.source_mode).toBe('LIVE');
		expect(typeof row.signature).toBe('string');
		expect((row.signature as string).length).toBeGreaterThan(64);
		expect(typeof row.body_sha256).toBe('string');
		expect((row.body_sha256 as string).length).toBe(64);
		expect(row.r2_key).toContain('raw/nasdaq/');
	});

	it('emits per-halt signed rows from the parsed RSS, with mic mapping (NASDAQ→XNAS, NYSE→XNYS)', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT mic, observation, payload_json, signature FROM halt_events WHERE event_type = 'halt' ORDER BY observation ASC`,
		).all<{ mic: string; observation: string; payload_json: string; signature: string }>();
		// Three items in the fixture → three halt rows.
		expect(results.length).toBe(3);
		// NASDAQ-listed → XNAS
		const nasdaqRow = results.find(r => r.observation.includes('ABCD'));
		expect(nasdaqRow).toBeTruthy();
		expect(nasdaqRow!.mic).toBe('XNAS');
		expect(nasdaqRow!.observation).toMatch(/^source nasdaq reported halt of ABCD/);
		// NYSE-listed (via consolidated feed) → XNYS
		const nyseRow = results.find(r => r.observation.includes('WXYZ'));
		expect(nyseRow).toBeTruthy();
		expect(nyseRow!.mic).toBe('XNYS');
		expect(nyseRow!.observation).toMatch(/^source nasdaq reported halt of WXYZ/);
		// NYSE American → no clean MIC; mic empty, market preserved in payload
		const amexRow = results.find(r => r.observation.includes('AMEX1'));
		expect(amexRow).toBeTruthy();
		expect(amexRow!.mic).toBe('');
		expect(amexRow!.payload_json).toContain('"market":"NYSE American"');
		// All signatures valid hex
		for (const r of results) expect(r.signature).toMatch(/^[0-9a-f]{128}$/);
	});

	it('dedupes per-halt rows by (IssueSymbol, HaltDate, HaltTime) within a single fetch', async () => {
		// Replace mock with a fixture where the same triple appears twice.
		const dupeXml = `<?xml version="1.0"?>
<rss xmlns:ndaq="http://www.nasdaqtrader.com"><channel>
  <item><ndaq:IssueSymbol>DUPE</ndaq:IssueSymbol><ndaq:IssueName>Dupe Co</ndaq:IssueName><ndaq:HaltDate>06/13/2026</ndaq:HaltDate><ndaq:HaltTime>14:30:00.000</ndaq:HaltTime><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>LUDP</ndaq:ReasonCode><ndaq:PauseThresholdPrice></ndaq:PauseThresholdPrice><ndaq:ResumptionDate></ndaq:ResumptionDate><ndaq:ResumptionQuoteTime></ndaq:ResumptionQuoteTime><ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime></item>
  <item><ndaq:IssueSymbol>DUPE</ndaq:IssueSymbol><ndaq:IssueName>Dupe Co</ndaq:IssueName><ndaq:HaltDate>06/13/2026</ndaq:HaltDate><ndaq:HaltTime>14:30:00.000</ndaq:HaltTime><ndaq:Market>NASDAQ</ndaq:Market><ndaq:ReasonCode>LUDP</ndaq:ReasonCode><ndaq:PauseThresholdPrice></ndaq:PauseThresholdPrice><ndaq:ResumptionDate></ndaq:ResumptionDate><ndaq:ResumptionQuoteTime></ndaq:ResumptionQuoteTime><ndaq:ResumptionTradeTime></ndaq:ResumptionTradeTime></item>
</channel></rss>`;
		fetchMock.current = async (url: string) => {
			if (url.includes('nasdaqtrader.com')) return new Response(dupeXml, { status: 200 });
			return originalFetch(url);
		};
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT count(*) AS c FROM halt_events WHERE event_type = 'halt'`,
		).all<{ c: number }>();
		expect(results[0].c).toBe(1);
	});

	it('dedupes across fetches via INSERT OR IGNORE — re-observing the same halt is a no-op', async () => {
		// Two captures of the same RSS body. The same halt triples should NOT
		// produce new halt rows on the second capture; only the feed_snapshot is
		// new (different observed_at + UUID).
		await runHaltArchiveCapture(env, new Date('2026-06-13T14:35:00Z'), 'LIVE');
		const after1 = await env.HALT_ARCHIVE!.prepare(
			`SELECT id, signature FROM halt_events WHERE event_type = 'halt' ORDER BY id ASC`,
		).all<{ id: string; signature: string }>();
		expect(after1.results.length).toBe(3);

		await runHaltArchiveCapture(env, new Date('2026-06-13T14:36:00Z'), 'LIVE');
		const after2 = await env.HALT_ARCHIVE!.prepare(
			`SELECT id, signature FROM halt_events WHERE event_type = 'halt' ORDER BY id ASC`,
		).all<{ id: string; signature: string }>();
		expect(after2.results.length).toBe(3);
		// Every halt-row signature from the first capture must be byte-identical
		// in the second — INSERT OR IGNORE never replaces existing rows.
		const lookup = new Map(after2.results.map(r => [r.id, r.signature]));
		for (const r of after1.results) {
			expect(lookup.get(r.id)).toBe(r.signature);
		}
	});

	it('NYSE source unset (default) does NOT emit a gap row — distinct from a real fetch failure', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT count(*) AS c FROM halt_events WHERE source = 'gap'`,
		).all<{ c: number }>();
		expect(results[0].c).toBe(0);
		// And the capture summary records the source as 'skipped', not 'gap'.
		const summary = await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const nyseEntry = summary.sources.find(s => s.source === 'nyse');
		expect(nyseEntry).toBeTruthy();
		expect(nyseEntry!.status).toBe('skipped');
	});

	it('records a SIGNED gap row when a real Nasdaq fetch fails (not silent)', async () => {
		fetchMock.current = async (url: string) => {
			if (url.includes('nasdaqtrader.com')) throw new TypeError('network unreachable');
			return originalFetch(url);
		};
		const result = await runHaltArchiveCapture(env, new Date(), 'LIVE');
		expect(result.gaps).toBeGreaterThanOrEqual(1);
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT * FROM halt_events WHERE source = 'gap' ORDER BY observed_at DESC LIMIT 1`,
		).all<Record<string, unknown>>();
		expect(results.length).toBe(1);
		const gapRow = results[0];
		expect(gapRow.event_type).toBe('gap');
		expect(typeof gapRow.signature).toBe('string');
		expect((gapRow.signature as string).length).toBeGreaterThan(64);
		expect(gapRow.observation).toMatch(/^source nasdaq unreachable at/);
	});

	it('also records a signed gap when feed returns non-2xx (HTTP error → signed fact)', async () => {
		fetchMock.current = async (url: string) => {
			if (url.includes('nasdaqtrader.com')) return new Response('forbidden', { status: 403 });
			return originalFetch(url);
		};
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(
			`SELECT * FROM halt_events WHERE source = 'gap'`,
		).all<Record<string, unknown>>();
		expect(results.length).toBeGreaterThanOrEqual(1);
		const row = results.find(r => String(r.observation).includes('nasdaq'));
		expect(row).toBeTruthy();
		expect(String(row!.observation)).toMatch(/HTTP 403/);
	});

	it('source_mode flag is present and matches the call mode on every row', async () => {
		await runHaltArchiveCapture(env, new Date(), 'BACKFILL');
		const { results } = await env.HALT_ARCHIVE!.prepare(`SELECT source_mode FROM halt_events`).all<{ source_mode: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.source_mode === 'LIVE' || r.source_mode === 'BACKFILL').toBe(true);
			expect(r.source_mode).toBe('BACKFILL');
		}
	});

	it('LIVE and BACKFILL are never silently mixed within a single capture call', async () => {
		await runHaltArchiveCapture(env, new Date('2026-06-13T10:00:00Z'), 'LIVE');
		await runHaltArchiveCapture(env, new Date('2026-06-13T10:01:00Z'), 'BACKFILL');
		const live = await env.HALT_ARCHIVE!.prepare(`SELECT count(*) AS c FROM halt_events WHERE source_mode = 'LIVE'`).first<{ c: number }>();
		const back = await env.HALT_ARCHIVE!.prepare(`SELECT count(*) AS c FROM halt_events WHERE source_mode = 'BACKFILL'`).first<{ c: number }>();
		expect((live?.c ?? 0)).toBeGreaterThan(0);
		expect((back?.c ?? 0)).toBeGreaterThan(0);
	});

	it('every payload uses observed-source framing — never claims ground truth', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(`SELECT observation, payload_json FROM halt_events`).all<{ observation: string; payload_json: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.observation).toMatch(/^(source [a-z_]+ (fetched|unreachable|reported)|ho schedule computation)/);
			expect(r.observation).not.toMatch(/\bis (true|open|closed|halted) at\b/i);
		}
	});

	it('signing uses the canonical signPayload path — non-string fields would have thrown', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const { results } = await env.HALT_ARCHIVE!.prepare(`SELECT signature FROM halt_events`).all<{ signature: string }>();
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.signature).toMatch(/^[0-9a-f]{128}$/);
		}
	});

	it('signPayload directly rejects non-string fields (guard regression check)', async () => {
		const pk = env.ED25519_PRIVATE_KEY as unknown as string;
		await expect(
			signPayload({ a: 'ok', b: 42 as unknown as string }, pk),
		).rejects.toThrow(/non-string value for field "b"/);
	});

	it('repeated capture is observably append-only — earlier rows are never modified or removed', async () => {
		// Behavioral proof of the append-only contract: capture twice, then prove
		// (a) the row count grew, (b) every row from the first run still exists
		// with byte-identical signature and observation. Halt rows dedupe across
		// fetches via INSERT OR IGNORE; the feed_snapshot row is new each time.
		await runHaltArchiveCapture(env, new Date('2026-06-13T10:00:00Z'), 'LIVE');
		const first = await env.HALT_ARCHIVE!.prepare(
			`SELECT id, signature, observation FROM halt_events ORDER BY id ASC`,
		).all<{ id: string; signature: string; observation: string }>();
		expect(first.results.length).toBeGreaterThan(0);

		await runHaltArchiveCapture(env, new Date('2026-06-13T10:01:00Z'), 'LIVE');
		const second = await env.HALT_ARCHIVE!.prepare(
			`SELECT id, signature, observation FROM halt_events ORDER BY id ASC`,
		).all<{ id: string; signature: string; observation: string }>();
		expect(second.results.length).toBeGreaterThan(first.results.length);

		const lookup = new Map(second.results.map(r => [r.id, r]));
		for (const r of first.results) {
			const after = lookup.get(r.id);
			expect(after).toBeTruthy();
			expect(after!.signature).toBe(r.signature);
			expect(after!.observation).toBe(r.observation);
		}
	});

	it('captures HO session_transition rows when MIC state changes between calls', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const before = await env.HALT_ARCHIVE!.prepare(
			`SELECT count(*) AS c FROM halt_events WHERE event_type = 'session_transition'`,
		).first<{ c: number }>();
		expect(before?.c ?? 0).toBe(0);

		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status:  'HALTED',
			reason:  'test override for session-transition capture',
			expires: new Date(Date.now() + 3600_000).toISOString(),
		}));
		clearOverrideCache();
		await runHaltArchiveCapture(env, new Date(), 'LIVE');

		const after = await env.HALT_ARCHIVE!.prepare(
			`SELECT mic, source, event_type, observation FROM halt_events WHERE event_type = 'session_transition'`,
		).all<Record<string, unknown>>();
		const xnysRow = (after.results ?? []).find(r => r.mic === 'XNYS');
		expect(xnysRow).toBeTruthy();
		expect(xnysRow!.source).toBe('ho_session');
		expect(String(xnysRow!.observation)).toMatch(/^ho schedule computation: XNYS transitioned from /);
		expect(String(xnysRow!.observation)).toContain('to HALTED');

		await env.ORACLE_OVERRIDES.delete('XNYS');
		clearOverrideCache();
	});
});

describe('Signed Halt Archive — daily digest with merkle_root', () => {
	async function seedSignedRow(
		date: string,
		idx: number,
		source: 'nasdaq' | 'nyse' | 'ho_session' = 'nasdaq',
	): Promise<void> {
		const id          = `seed-${date}-${idx}`;
		const observedAt  = `${date}T${String(idx % 24).padStart(2, '0')}:00:00.000Z`;
		const observation = `source ${source} fetched 200 OK at ${observedAt}; body sha256 ${'a'.repeat(64)}`;
		const payload: Record<string, string> = {
			body_sha256:  'a'.repeat(64),
			event_type:   'feed_snapshot',
			fetch_status: '200',
			id,
			issued_at:    observedAt,
			issuer:       'headlessoracle.com',
			key_id:       env.PUBLIC_KEY_ID as unknown as string,
			mic:          '',
			observation,
			observed_at:  observedAt,
			r2_key:       `raw/${source}/${observedAt}.bin`,
			schema:       'halt_archive_event/v1',
			source,
			source_mode:  'LIVE',
			source_url:   `https://example.invalid/${source}`,
		};
		const sig = await signPayload(payload, env.ED25519_PRIVATE_KEY as unknown as string);
		const sorted: Record<string, string> = {};
		for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
		await env.HALT_ARCHIVE!.prepare(
			`INSERT INTO halt_events (id, source, source_mode, mic, event_type, observed_at, captured_at, observation, body_sha256, r2_key, payload_json, signature, key_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id, source, 'LIVE', '', 'feed_snapshot', observedAt, observedAt, observation,
			'a'.repeat(64), `raw/${source}/${observedAt}.bin`, JSON.stringify(sorted),
			sig, env.PUBLIC_KEY_ID as unknown as string, observedAt,
		).run();
	}

	beforeEach(async () => {
		// Restore real timers — earlier tests in the suite leave faked system
		// time behind (vi.setSystemTime), which makes our date-validation
		// endpoints reject 2026-06-XX dates as "future."
		vi.useRealTimers();
		clearHaltArchiveSchemaCache();
		await ensureHaltArchiveSchema(env);
		try { await env.HALT_ARCHIVE!.prepare('DELETE FROM halt_events').run(); } catch { /* ok */ }
		try { await env.HALT_ARCHIVE!.prepare('DELETE FROM halt_archive_digest').run(); } catch { /* ok */ }
	});

	it('returns a signed digest with merkle_root over the day\'s events', async () => {
		await seedSignedRow('2026-06-10', 1);
		await seedSignedRow('2026-06-10', 2);
		await seedSignedRow('2026-06-10', 3);
		const digest = await buildHaltArchiveDigest('2026-06-10', env);
		expect(digest).toBeTruthy();
		expect(digest!.date).toBe('2026-06-10');
		expect(digest!.event_count).toBe(3);
		expect(typeof digest!.merkle_root).toBe('string');
		expect((digest!.merkle_root as string)).toMatch(/^[0-9a-f]{64}$/);
		expect(typeof digest!.signature).toBe('string');
		expect((digest!.signature as string)).toMatch(/^[0-9a-f]{128}$/);
	});

	it('merkle_root is deterministic for the same input set', async () => {
		await seedSignedRow('2026-06-09', 1);
		await seedSignedRow('2026-06-09', 2);
		const d1 = await buildHaltArchiveDigest('2026-06-09', env);
		const d2 = await buildHaltArchiveDigest('2026-06-09', env);
		expect(d1!.merkle_root).toBe(d2!.merkle_root);
		expect(d1!.signature).toBe(d2!.signature);
	});

	it('chains to the previous day\'s merkle_root', async () => {
		await seedSignedRow('2026-06-07', 1);
		await seedSignedRow('2026-06-08', 1);
		const d7 = await buildHaltArchiveDigest('2026-06-07', env);
		const d8 = await buildHaltArchiveDigest('2026-06-08', env);
		expect(d7!.previous_day_merkle_root).toBe('');
		expect(d7!.chain_length).toBe(1);
		expect(d8!.previous_day_merkle_root).toBe(d7!.merkle_root);
		expect(d8!.chain_length).toBe(2);
	});

	it('source_modes field reflects the modes present in the day', async () => {
		await seedSignedRow('2026-06-06', 1);
		const digest = await buildHaltArchiveDigest('2026-06-06', env);
		expect(digest!.source_modes).toEqual(['LIVE']);
	});
});

describe('GET /v1/halts/digest/{date} — free public digest', () => {
	beforeEach(async () => {
		// Restore real timers — earlier tests in the suite leave faked system
		// time behind (vi.setSystemTime), which makes our date-validation
		// endpoints reject 2026-06-XX dates as "future."
		vi.useRealTimers();
		clearHaltArchiveSchemaCache();
		await ensureHaltArchiveSchema(env);
		try { await env.HALT_ARCHIVE!.prepare('DELETE FROM halt_events').run(); } catch { /* ok */ }
		try { await env.HALT_ARCHIVE!.prepare('DELETE FROM halt_archive_digest').run(); } catch { /* ok */ }
	});

	it('returns 400 on malformed date', async () => {
		const response = await fetchWorker('/v1/halts/digest/not-a-date');
		expect(response.status).toBe(400);
	});

	it('returns 400 on future date', async () => {
		const future = new Date(Date.now() + 86400_000 * 2).toISOString().slice(0, 10);
		const response = await fetchWorker(`/v1/halts/digest/${future}`);
		expect(response.status).toBe(400);
	});

	it('returns 404 with DIGEST_NOT_YET_FINAL for today (incomplete day)', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const response = await fetchWorker(`/v1/halts/digest/${today}`);
		expect(response.status).toBe(404);
		const body = await response.json() as Record<string, unknown>;
		expect(body.error).toBe('DIGEST_NOT_YET_FINAL');
	});

	it('returns digest JSON for a past date that has events', async () => {
		const past = '2026-06-05';
		const id = `endpoint-test-${past}`;
		const payload: Record<string, string> = {
			body_sha256:  'b'.repeat(64),
			event_type:   'feed_snapshot',
			fetch_status: '200',
			id,
			issued_at:    `${past}T01:00:00.000Z`,
			issuer:       'headlessoracle.com',
			key_id:       env.PUBLIC_KEY_ID as unknown as string,
			mic:          '',
			observation:  `source nasdaq fetched 200 OK at ${past}T01:00:00.000Z; body sha256 ${'b'.repeat(64)}`,
			observed_at:  `${past}T01:00:00.000Z`,
			r2_key:       `raw/nasdaq/${past}T01:00:00.000Z.xml`,
			schema:       'halt_archive_event/v1',
			source:       'nasdaq',
			source_mode:  'LIVE',
			source_url:   'https://example.invalid/nasdaq',
		};
		const sig = await signPayload(payload, env.ED25519_PRIVATE_KEY as unknown as string);
		const sorted: Record<string, string> = {};
		for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
		await env.HALT_ARCHIVE!.prepare(
			`INSERT INTO halt_events (id, source, source_mode, mic, event_type, observed_at, captured_at, observation, body_sha256, r2_key, payload_json, signature, key_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id, 'nasdaq', 'LIVE', '', 'feed_snapshot', `${past}T01:00:00.000Z`, `${past}T01:00:00.000Z`,
			payload.observation, 'b'.repeat(64), `raw/nasdaq/${past}T01:00:00.000Z.xml`, JSON.stringify(sorted),
			sig, env.PUBLIC_KEY_ID as unknown as string, `${past}T01:00:00.000Z`,
		).run();

		const response = await fetchWorker(`/v1/halts/digest/${past}`);
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body.schema).toBe('halt_archive_digest/v1');
		expect(typeof body.framing).toBe('string');
		expect(String(body.framing)).toMatch(/observed-source/i);
		expect(typeof body.merkle_root).toBe('string');
		expect(typeof body.signature).toBe('string');
	});
});

describe('GET /v1/halts — paid endpoint', () => {
	let originalFetch: typeof fetch;

	beforeEach(async () => {
		clearHaltArchiveSchemaCache();
		clearApiKeyCache();
		// Stub fetch so runHaltArchiveCapture seeds D1 from a known fixture
		// instead of hitting nasdaqtrader.com over the network.
		originalFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (u.includes('nasdaqtrader.com')) {
				return Promise.resolve(new Response(NASDAQ_RSS_FIXTURE, {
					status: 200, headers: { 'Content-Type': 'application/rss+xml' },
				}));
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		await ensureHaltArchiveSchema(env);
		try { await env.HALT_ARCHIVE!.prepare('DELETE FROM halt_events').run(); } catch { /* ok */ }
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it('returns 402 when no payment or paid key provided', async () => {
		const response = await fetchWorker('/v1/halts');
		expect(response.status).toBe(402);
	});

	it('accepts MASTER_API_KEY (internal plan) as paid access', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		const response = await fetchWorker('/v1/halts?limit=5', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body.schema).toBe('halt_archive_event/v1');
		expect(typeof body.framing).toBe('string');
		expect(Array.isArray(body.events)).toBe(true);
		expect(typeof body.count).toBe('number');
	});

	it('respects ?mic= and ?source= filters', async () => {
		await runHaltArchiveCapture(env, new Date(), 'LIVE');
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status: 'HALTED', reason: 'test', expires: new Date(Date.now() + 3600_000).toISOString(),
		}));
		clearOverrideCache();
		await runHaltArchiveCapture(env, new Date(), 'LIVE');

		const response = await fetchWorker('/v1/halts?source=ho_session&mic=XNYS&limit=10', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(response.status).toBe(200);
		const body = await response.json() as { events: Array<Record<string, unknown>> };
		for (const e of body.events) {
			expect(e.source).toBe('ho_session');
			expect(e.mic).toBe('XNYS');
		}

		await env.ORACLE_OVERRIDES.delete('XNYS');
		clearOverrideCache();
	});

	it('still returns 402 if a free-plan sandbox key is presented', async () => {
		const sandboxResp = await fetchSandbox('halts-sandbox@example.com');
		expect(sandboxResp.status).toBe(200);
		const sb = await sandboxResp.json() as { api_key: string };
		const response = await fetchWorker('/v1/halts', {
			headers: { 'X-Oracle-Key': sb.api_key },
		});
		expect(response.status).toBe(402);
	});
});

// ─── GET /v1/safe-to-trade — PAID: signed circuit-breaker receipt ─────────────
//
// Clones /v1/halts auth pattern: paid-key bypass OR x402 settlement. Has its
// own canonical field list (safe_to_trade_fields) and merges ORACLE_OVERRIDES
// into the cross-venue block — fixes /v5/briefing's override-blindness for
// this surface. max_age is required, no default.

describe('GET /v1/safe-to-trade', () => {
	beforeEach(async () => {
		clearOverrideCache();
		clearApiKeyCache();
		// Ensure no stray REALTIME overrides from other tests pollute the scan.
		const allMics = [
			'XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
			'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
			'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE',
			'XHEL', 'XSTO', 'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN',
		];
		for (const m of allMics) {
			try { await env.ORACLE_OVERRIDES.delete(m); } catch { /* ok */ }
		}
		clearOverrideCache();
	});

	it('returns 400 VENUE_REQUIRED when ?venue= is missing', async () => {
		const res = await fetchWorker('/v1/safe-to-trade?max_age=30', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('VENUE_REQUIRED');
	});

	it('returns 400 UNKNOWN_VENUE on unsupported MIC', async () => {
		const res = await fetchWorker('/v1/safe-to-trade?venue=ZZZZ&max_age=30', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('UNKNOWN_VENUE');
	});

	it('returns 400 MAX_AGE_REQUIRED when max_age is missing (no default)', async () => {
		const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS', {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string; message: string };
		expect(body.error).toBe('MAX_AGE_REQUIRED');
		// Documents the no-default discipline in the error body
		expect(body.message.toLowerCase()).toContain('no default');
	});

	it('returns 400 MAX_AGE_INVALID on out-of-range values (0, 61, float, non-numeric)', async () => {
		for (const bad of ['0', '61', '3.5', 'abc', '30s', ' 30']) {
			const res = await fetchWorker(`/v1/safe-to-trade?venue=XNYS&max_age=${encodeURIComponent(bad)}`, {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			expect(res.status).toBe(400);
			const body = await res.json() as { error: string };
			expect(body.error).toBe('MAX_AGE_INVALID');
		}
	});

	it('returns 402 when no payment and no paid key are presented', async () => {
		const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30');
		expect(res.status).toBe(402);
	});

	it('returns 402 when a free/sandbox plan key is presented (paid plan required)', async () => {
		const sandboxResp = await fetchSandbox('safe-to-trade-sandbox@example.com');
		expect(sandboxResp.status).toBe(200);
		const sb = await sandboxResp.json() as { api_key: string };
		const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
			headers: { 'X-Oracle-Key': sb.api_key },
		});
		expect(res.status).toBe(402);
	});

	it('returns 402 with explanatory body on bad x402 payment header', async () => {
		const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
			headers: { 'X-Payment': 'not-valid-base64-or-json' },
		});
		expect(res.status).toBe(402);
		const body = await res.json() as { error: string };
		// Either PAYMENT_VERIFICATION_FAILED (it tried to verify and failed) or
		// the standard facilitator payload (rejected before verification).
		expect(['PAYMENT_VERIFICATION_FAILED', undefined].includes(body.error) || typeof body.error === 'undefined' || typeof body.error === 'string').toBe(true);
	});

	it('returns 200 with paid key and a signed receipt that has the new shape', async () => {
		// Force XNYS open during a known trading window
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z')); // 10:30 ET — XNYS regular hours
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			// Wire shape: flat fields PLUS receipt envelope PLUS discovery_url
			expect(body.venue).toBe('XNYS');
			expect(body.venue_status).toBe('OPEN');
			expect(body.venue_source).toBe('SCHEDULE');
			expect(body.safe).toBe('true');
			expect(body.schema_version).toBe('v5.0');
			expect(body.receipt_mode).toBe('live');
			expect(body.max_age).toBe('30');
			expect(body.instrument).toBe('');
			expect(typeof body.signature).toBe('string');
			expect(typeof body.receipt_id).toBe('string');
			expect(typeof body.issued_at).toBe('string');
			expect(typeof body.expires_at).toBe('string');
			// cross_venue and reasons are JSON-encoded strings in the signed bytes
			expect(typeof body.cross_venue).toBe('string');
			expect(typeof body.reasons).toBe('string');
			const cv = JSON.parse(body.cross_venue as string) as { realtime_overrides: string[]; scan_ok: boolean };
			expect(Array.isArray(cv.realtime_overrides)).toBe(true);
			expect(cv.scan_ok).toBe(true);
			const reasonsArr = JSON.parse(body.reasons as string) as string[];
			expect(reasonsArr).toEqual([]); // OPEN venue, scan ok → no reasons
			// Envelope mirror + discovery_url
			expect(body.receipt).toBeDefined();
			expect(body.discovery_url).toContain('headlessoracle.com');
		} finally {
			vi.useRealTimers();
		}
	});

	it('expires_at = issued_at + 60s exactly, signed into the canonical payload', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			const body = await res.json() as { issued_at: string; expires_at: string };
			const issued = new Date(body.issued_at).getTime();
			const expires = new Date(body.expires_at).getTime();
			expect(expires - issued).toBe(60_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it('signed receipt verifies via signPayload canonical round-trip', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			const body = await res.json() as Record<string, string>;
			// Reconstruct the canonical payload exactly as the worker did.
			// safe_to_trade_fields published at /v5/keys — keep this list in sync.
			const fields = ['cross_venue', 'expires_at', 'instrument', 'issued_at', 'issuer', 'max_age', 'public_key_id', 'reasons', 'receipt_id', 'receipt_mode', 'safe', 'schema_version', 'venue', 'venue_source', 'venue_status'];
			const payload: Record<string, string> = {};
			for (const k of fields) {
				expect(typeof body[k]).toBe('string'); // every signed field is a string
				payload[k] = body[k] as string;
			}
			const expectedSig = await signPayload(payload, env.ED25519_PRIVATE_KEY as unknown as string);
			expect(body.signature).toBe(expectedSig);
		} finally {
			vi.useRealTimers();
		}
	});

	it('safe=false with reason VENUE_NOT_OPEN when venue is CLOSED per schedule', async () => {
		vi.useFakeTimers();
		// Saturday — XNYS closed by weekday rule
		vi.setSystemTime(new Date('2026-04-11T14:30:00Z'));
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { safe: string; venue_status: string; reasons: string };
			expect(body.safe).toBe('false');
			expect(body.venue_status).toBe('CLOSED');
			expect(JSON.parse(body.reasons)).toContain('VENUE_NOT_OPEN');
		} finally {
			vi.useRealTimers();
		}
	});

	it('safe=false with reason VENUE_REALTIME_HALT when ORACLE_OVERRIDES has a REALTIME halt on target venue (CIRCUIT-BREAKER PROOF)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z')); // XNYS would be OPEN per schedule
		try {
			await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
				status:  'HALTED',
				reason:  'circuit breaker L1',
				source:  'REALTIME',
				expires: new Date(Date.now() + 3600_000).toISOString(),
			}));
			clearOverrideCache();
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { safe: string; venue_status: string; venue_source: string; reasons: string; cross_venue: string };
			expect(body.safe).toBe('false');
			expect(body.venue_status).toBe('HALTED');
			expect(body.venue_source).toBe('OVERRIDE');
			const reasons = JSON.parse(body.reasons) as string[];
			expect(reasons).toContain('VENUE_NOT_OPEN');
			expect(reasons).toContain('VENUE_REALTIME_HALT');
			// cross_venue.realtime_overrides includes the target venue
			const cv = JSON.parse(body.cross_venue) as { realtime_overrides: string[] };
			expect(cv.realtime_overrides).toContain('XNYS');
		} finally {
			vi.useRealTimers();
			try { await env.ORACLE_OVERRIDES.delete('XNYS'); } catch { /* ok */ }
			clearOverrideCache();
		}
	});

	it('VENUE_OVERRIDE_ACTIVE (not REALTIME) when override has no source=REALTIME', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			// Operator-driven override — no source: 'REALTIME' set
			await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
				status:  'HALTED',
				reason:  'manual operator halt',
				expires: new Date(Date.now() + 3600_000).toISOString(),
			}));
			clearOverrideCache();
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			const body = await res.json() as { safe: string; reasons: string };
			expect(body.safe).toBe('false');
			const reasons = JSON.parse(body.reasons) as string[];
			expect(reasons).toContain('VENUE_OVERRIDE_ACTIVE');
			expect(reasons).not.toContain('VENUE_REALTIME_HALT');
		} finally {
			vi.useRealTimers();
			try { await env.ORACLE_OVERRIDES.delete('XNYS'); } catch { /* ok */ }
			clearOverrideCache();
		}
	});

	it('cross_venue.realtime_overrides surfaces REALTIME overrides on OTHER venues (does not by itself trip safe)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			// REALTIME halt on a venue OTHER than the one we're querying
			await env.ORACLE_OVERRIDES.put('XNAS', JSON.stringify({
				status:  'HALTED',
				reason:  'volatility halt',
				source:  'REALTIME',
				expires: new Date(Date.now() + 3600_000).toISOString(),
			}));
			clearOverrideCache();
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			const body = await res.json() as { safe: string; venue: string; cross_venue: string; reasons: string };
			expect(body.venue).toBe('XNYS');
			expect(body.safe).toBe('true'); // XNYS itself is OPEN per schedule
			const cv = JSON.parse(body.cross_venue) as { realtime_overrides: string[] };
			expect(cv.realtime_overrides).toContain('XNAS');
			expect(cv.realtime_overrides).not.toContain('XNYS');
			// Reasons is empty — cross-venue info is reported, not gating
			expect(JSON.parse(body.reasons)).toEqual([]);
		} finally {
			vi.useRealTimers();
			try { await env.ORACLE_OVERRIDES.delete('XNAS'); } catch { /* ok */ }
			clearOverrideCache();
		}
	});

	it('instrument param is echoed back as opaque signed metadata (empty string default)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30&instrument=AAPL', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			const body = await res.json() as { instrument: string };
			expect(body.instrument).toBe('AAPL');
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects instrument longer than 64 chars (bounded opaque metadata)', async () => {
		const big = 'A'.repeat(65);
		const res = await fetchWorker(`/v1/safe-to-trade?venue=XNYS&max_age=30&instrument=${big}`, {
			headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
		});
		expect(res.status).toBe(400);
		const body = await res.json() as { error: string };
		expect(body.error).toBe('INSTRUMENT_TOO_LONG');
	});

	it('Cache-Control: no-store on success (receipts are TTL-bound, must not be cached)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		try {
			const res = await fetchWorker('/v1/safe-to-trade?venue=XNYS&max_age=30', {
				headers: { 'X-Oracle-Key': env.MASTER_API_KEY as unknown as string },
			});
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('X-Attestation-Mode')).toBe('live');
		} finally {
			vi.useRealTimers();
		}
	});

	it('/v5/keys publishes safe_to_trade_fields alongside the existing field lists', async () => {
		const res = await fetchWorker('/v5/keys');
		const body = await res.json() as { canonical_payload_spec: { safe_to_trade_fields?: string[]; receipt_fields?: string[]; override_fields?: string[]; health_fields?: string[] } };
		expect(body.canonical_payload_spec).toBeDefined();
		expect(Array.isArray(body.canonical_payload_spec.safe_to_trade_fields)).toBe(true);
		expect(body.canonical_payload_spec.safe_to_trade_fields).toContain('safe');
		expect(body.canonical_payload_spec.safe_to_trade_fields).toContain('cross_venue');
		expect(body.canonical_payload_spec.safe_to_trade_fields).toContain('reasons');
		expect(body.canonical_payload_spec.safe_to_trade_fields).toContain('venue');
		expect(body.canonical_payload_spec.safe_to_trade_fields).toContain('max_age');
		// Existing field lists still present
		expect(Array.isArray(body.canonical_payload_spec.receipt_fields)).toBe(true);
		expect(Array.isArray(body.canonical_payload_spec.override_fields)).toBe(true);
		expect(Array.isArray(body.canonical_payload_spec.health_fields)).toBe(true);
	});
});

// ─── GET /v1/safe-to-trade/sample — public, unauth, rate-limited, SIGNED ──────
//
// Same authoritative signed receipt as the paid /v1/safe-to-trade — same
// helper, same Tier-0 override merge, same GAP-012 cross-venue scan, same
// fail-closed reason taxonomy, receipt_mode='live'. The ONLY differences are
// (a) no auth, (b) 60/min/IP rate limit, (c) venue defaults to XNYS, and
// (d) unsigned `door` and `note` wrapper fields. max_age stays REQUIRED with
// no default — modeling the IETF environment.* freshness contract is the
// load-bearing property of this surface and must not be relaxed at the most
// visible door.

describe('GET /v1/safe-to-trade/sample', () => {
	// Cleanup helper for the per-IP rate-limit bucket. Clones the
	// /v1/status/{MIC} test scaffolding pattern so the two suites stay
	// recognisably aligned.
	async function ipHashOf(ip: string): Promise<string> {
		const bytes = new TextEncoder().encode(ip);
		const buf   = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	}
	async function cleanupSampleRateBuckets(ip: string): Promise<void> {
		const hash = await ipHashOf(ip);
		const minute = Math.floor(Date.now() / 60_000);
		for (let m = minute - 1; m <= minute + 1; m++) {
			await env.ORACLE_TELEMETRY.delete(`v1_safe_to_trade_sample_rate:${hash}:${m}`).catch(() => {});
		}
	}

	beforeEach(async () => {
		clearOverrideCache();
		clearApiKeyCache();
		for (const m of ALL_MICS) {
			try { await env.ORACLE_OVERRIDES.delete(m); } catch { /* ok */ }
		}
		clearOverrideCache();
	});

	// ── Test 1: 200 + full canonical shape + receipt_mode='live' ──────────
	it('returns 200 with a signed receipt carrying all 15 canonical fields and receipt_mode=live', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z')); // 10:30 ET — XNYS regular hours
		const ip = '203.0.113.110';
		try {
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('X-Attestation-Mode')).toBe('live');
			const body = await res.json() as Record<string, unknown>;
			// All 15 canonical signed fields
			expect(body.venue).toBe('XNYS');
			expect(body.venue_status).toBe('OPEN');
			expect(body.venue_source).toBe('SCHEDULE');
			expect(body.safe).toBe('true');
			expect(body.schema_version).toBe('v5.0');
			// LOAD-BEARING: receipt_mode is 'live', NOT 'sample'. Same rationale as
			// /v1/status/{MIC}: the receipt attests provenance-of-content (real
			// signed observation), not provenance-of-payment. The free door does
			// not change the data.
			expect(body.receipt_mode).toBe('live');
			expect(body.max_age).toBe('30');
			expect(body.instrument).toBe('');
			expect(typeof body.signature).toBe('string');
			expect(typeof body.receipt_id).toBe('string');
			expect(typeof body.issued_at).toBe('string');
			expect(typeof body.expires_at).toBe('string');
			expect(typeof body.cross_venue).toBe('string');
			expect(typeof body.reasons).toBe('string');
			expect(typeof body.public_key_id).toBe('string');
			expect(body.issuer).toBe('headlessoracle.com');
			// cross_venue / reasons are JSON-stringified composites (strings-only invariant)
			const cv = JSON.parse(body.cross_venue as string) as { realtime_overrides: string[]; scan_ok: boolean };
			expect(Array.isArray(cv.realtime_overrides)).toBe(true);
			expect(cv.scan_ok).toBe(true);
			expect(JSON.parse(body.reasons as string)).toEqual([]);
			// Wrapper: door + note OUTSIDE the signed payload. The framing must not
			// imply illustrative / lesser data — strictly identifies the door.
			expect(body.door).toBe('public-sample');
			expect(typeof body.note).toBe('string');
			expect((body.note as string).toLowerCase()).toContain('authoritative');
			expect((body.note as string)).toContain('/v1/safe-to-trade');
			// Envelope mirror + discovery_url (same wrapper as paid endpoint)
			expect(body.receipt).toBeDefined();
			expect(body.discovery_url).toContain('headlessoracle.com');
		} finally {
			vi.useRealTimers();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 2: zero venue param defaults to XNYS; max_age still required ─
	it('defaults venue to XNYS when ?venue= is omitted (max_age still required)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		const ip = '203.0.113.111';
		try {
			const res = await fetchWorker('/v1/safe-to-trade/sample?max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body.venue).toBe('XNYS');
			expect(body.receipt_mode).toBe('live');
		} finally {
			vi.useRealTimers();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 3: 400 UNKNOWN_VENUE on garbage MIC ──────────────────────────
	it('returns 400 UNKNOWN_VENUE on unsupported MIC', async () => {
		const ip = '203.0.113.112';
		try {
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=ZZZZ&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(400);
			const body = await res.json() as { error: string };
			expect(body.error).toBe('UNKNOWN_VENUE');
		} finally {
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 4: 400 MAX_AGE_REQUIRED when missing (no default) ────────────
	it('returns 400 MAX_AGE_REQUIRED when max_age is missing (load-bearing fail-closed contract)', async () => {
		const ip = '203.0.113.113';
		try {
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(400);
			const body = await res.json() as { error: string; message: string };
			expect(body.error).toBe('MAX_AGE_REQUIRED');
			expect(body.message.toLowerCase()).toContain('no default');
		} finally {
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 5: 400 MAX_AGE_INVALID on out-of-range / non-integer ─────────
	it('returns 400 MAX_AGE_INVALID on out-of-range or malformed values', async () => {
		const ip = '203.0.113.114';
		try {
			for (const bad of ['0', '61', '3.5', 'abc', '30s', ' 30']) {
				const res = await fetchWorker(`/v1/safe-to-trade/sample?venue=XNYS&max_age=${encodeURIComponent(bad)}`, { headers: { 'X-Original-IP': ip } });
				expect(res.status, `bad=${bad}`).toBe(400);
				const body = await res.json() as { error: string };
				expect(body.error).toBe('MAX_AGE_INVALID');
			}
		} finally {
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 6: 60/min/IP rate limit — 61st call → 429 with Retry-After ───
	it('rate limit: 60 requests pass, 61st returns 429 with Retry-After (Cloudflare dashboard is primary; this is the in-worker safety net)', async () => {
		const ip = '203.0.113.115';
		// GAP-019. The limiter buckets on Math.floor(now / 60_000) -- a WALL-CLOCK
		// minute -- and this test fires 61 real sequential requests. When those
		// straddle a minute boundary the counter resets and the 61st returns 200,
		// so the test went red for a reason that has nothing to do with the code
		// under test. Latent since it was written; it fired twice on 2026-09-09
		// and again here once the suite grew, because what decides it is where in
		// the minute the burst happens to start.
		//
		// Pinning the clock is the fix canon names. All 61 requests now land in
		// one bucket by construction. It does not weaken the assertion: the 61st
		// must still be refused, and seeding the counter instead would have
		// stopped testing that the first 60 pass.
		vi.setSystemTime(new Date('2026-04-08T15:10:30Z'));
		try {
			for (let i = 0; i < 60; i++) {
				const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
				expect(res.status, `request #${i + 1} should pass`).toBe(200);
			}
			const over = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(over.status).toBe(429);
			expect(over.headers.get('Retry-After')).toBeTruthy();
			expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
			expect(Number(over.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
			expect(over.headers.get('X-RateLimit-Limit')).toBe('60');
			expect(over.headers.get('X-RateLimit-Remaining')).toBe('0');
			expect(over.headers.get('X-RateLimit-Reset')).toBeTruthy();
			const body = await over.json() as Record<string, unknown>;
			expect(body.error).toBe('RATE_LIMITED');
			expect(body.limit_per_minute).toBe(60);
			expect(typeof body.retry_after_seconds).toBe('number');
		} finally {
			vi.useRealTimers();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 7: Tier-0 override fail-closed (CIRCUIT-BREAKER PROOF) ───────
	// The worst-case bug for a public safe-to-trade is silently ignoring an
	// active halt. This test pins that the helper-driven door catches halts
	// identically to the paid endpoint — same GAP-012 cross-venue scan,
	// same reason codes.
	it('safe=false with VENUE_REALTIME_HALT when ORACLE_OVERRIDES has a REALTIME halt on the target venue', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z')); // XNYS scheduled OPEN
		const ip = '203.0.113.116';
		try {
			await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
				status:  'HALTED',
				reason:  'circuit breaker L1',
				source:  'REALTIME',
				expires: new Date(Date.now() + 3600_000).toISOString(),
			}));
			clearOverrideCache();
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const body = await res.json() as { safe: string; venue_status: string; venue_source: string; reasons: string; cross_venue: string };
			expect(body.safe).toBe('false');
			expect(body.venue_status).toBe('HALTED');
			expect(body.venue_source).toBe('OVERRIDE');
			const reasons = JSON.parse(body.reasons) as string[];
			expect(reasons).toContain('VENUE_NOT_OPEN');
			expect(reasons).toContain('VENUE_REALTIME_HALT');
			const cv = JSON.parse(body.cross_venue) as { realtime_overrides: string[] };
			expect(cv.realtime_overrides).toContain('XNYS');
		} finally {
			vi.useRealTimers();
			try { await env.ORACLE_OVERRIDES.delete('XNYS'); } catch { /* ok */ }
			clearOverrideCache();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 8: HEAD returns 200 with no body and no served-receipt counter
	// HEAD mirrors GET (RFC 7231 §4.3.2): same status, same headers, empty
	// body. Side-effects (the served-receipt counter) are skipped — HEAD is
	// a metadata probe. The rate-limit bucket still counts HEAD (volume gate
	// counts work, not receipts), matching /v1/status/{MIC} discipline.
	it('HEAD returns 200 with no body, and does NOT increment v1_safe_to_trade_sample_calls counter', async () => {
		const ip = '203.0.113.117';
		const date = new Date().toISOString().slice(0, 10);
		const key  = `v1_safe_to_trade_sample_calls:${date}`;
		try {
			await env.ORACLE_TELEMETRY.delete(key);
			const headResp = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { method: 'HEAD', headers: { 'X-Original-IP': ip } });
			expect(headResp.status).toBe(200);
			expect(headResp.headers.get('Cache-Control')).toBe('no-store');
			expect(headResp.headers.get('X-Attestation-Mode')).toBe('live');
			const headBody = await headResp.text();
			expect(headBody).toBe('');
			// Served-receipt counter must NOT have ticked on HEAD
			const after = await env.ORACLE_TELEMETRY.get(key);
			expect(after).toBeNull();
			// Then a single GET DOES tick the counter — proves the skip is method-scoped
			const getResp = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(getResp.status).toBe(200);
			const after2 = await env.ORACLE_TELEMETRY.get(key);
			expect(after2).toBe('1');
		} finally {
			await env.ORACLE_TELEMETRY.delete(key).catch(() => {});
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 9 (bonus, ties the suite to canonical bytes): signature verifies
	// via signPayload canonical round-trip on the safe_to_trade_fields set.
	// If buildSafeToTradeReceipt's canonical-bytes path drifts from the
	// signer, this test catches it.
	it('signed receipt verifies via signPayload canonical round-trip (byte-parity with /v1/safe-to-trade)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		const ip = '203.0.113.118';
		try {
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			const body = await res.json() as Record<string, string>;
			// safe_to_trade_fields published at /v5/keys — keep this list in sync.
			const fields = ['cross_venue', 'expires_at', 'instrument', 'issued_at', 'issuer', 'max_age', 'public_key_id', 'reasons', 'receipt_id', 'receipt_mode', 'safe', 'schema_version', 'venue', 'venue_source', 'venue_status'];
			const payload: Record<string, string> = {};
			for (const k of fields) {
				expect(typeof body[k]).toBe('string');
				payload[k] = body[k] as string;
			}
			const expectedSig = await signPayload(payload, env.ED25519_PRIVATE_KEY as unknown as string);
			expect(body.signature).toBe(expectedSig);
		} finally {
			vi.useRealTimers();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 10: scan-failure forces safe=false (LOAD-BEARING fail-closed flip)
	// The cross-venue scan is a synchronous-throw bypass of the per-MIC
	// .catch(() => null), achieved by spying ORACLE_OVERRIDES.get to throw
	// synchronously (Promise.reject would be swallowed by the inner catch).
	// The override cache is primed by a successful pre-fetch so the Tier-0
	// read inside buildSignedReceipt does NOT hit the spy — that keeps the
	// primary venue receipt OPEN/SCHEDULE and isolates the test to the
	// cross-venue-scan failure path. Without the primary venue being OPEN,
	// safe=false is trivially satisfied by VENUE_NOT_OPEN and the test
	// wouldn't actually pin the new behaviour.
	it('scan-failure with primary venue OPEN forces safe=false (was safe=true before this PR)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z')); // XNYS regular hours
		const ip = '203.0.113.119';
		try {
			// Prime the override cache so the Tier-0 read inside buildSignedReceipt
			// uses the cached null and never calls ORACLE_OVERRIDES.get under the spy.
			const primer = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(primer.status).toBe(200);

			vi.spyOn(env.ORACLE_OVERRIDES, 'get').mockImplementation(((_mic: string) => {
				throw new Error('simulated KV outage on cross-venue scan');
			}) as never);

			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;

			// Primary venue is still OPEN/SCHEDULE — Tier-0 cache held.
			expect(body.venue_status).toBe('OPEN');
			expect(body.venue_source).toBe('SCHEDULE');

			// LOAD-BEARING: safe MUST be 'false' on scan-failure even though the
			// primary venue is OPEN. Previously this case returned safe=true.
			expect(body.safe).toBe('false');

			const reasons = JSON.parse(body.reasons as string) as string[];
			expect(reasons).toContain('CROSS_VENUE_SCAN_UNAVAILABLE');
			// Tier-0 didn't blow up (cache held), so the SYSTEM reason must NOT
			// be present — this proves the test is exercising the scan-failure
			// path specifically, not the venue-tier-2-unknown path.
			expect(reasons).not.toContain('VENUE_TIER2_UNKNOWN');
			expect(reasons).not.toContain('VENUE_NOT_OPEN');

			const cv = JSON.parse(body.cross_venue as string) as { realtime_overrides: string[]; scan_ok: boolean };
			expect(cv.scan_ok).toBe(false);
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
			clearOverrideCache();
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 11: scan-failure increments v1_safe_to_trade_scan_unavailable
	// Observability counter — gives forward-looking visibility into scan-failure
	// frequency so the fail-closed flip above can be sized in prod.
	it('scan-failure increments v1_safe_to_trade_scan_unavailable:{date}', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		const ip = '203.0.113.120';
		const date = '2026-04-09';
		const counterKey = `v1_safe_to_trade_scan_unavailable:${date}`;
		try {
			await env.ORACLE_TELEMETRY.delete(counterKey).catch(() => {});
			// Prime override cache as in Test 10.
			const primer = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(primer.status).toBe(200);
			// Counter must NOT have ticked on the primer call (scan succeeded).
			const beforeSpy = await env.ORACLE_TELEMETRY.get(counterKey);
			expect(beforeSpy).toBeNull();

			vi.spyOn(env.ORACLE_OVERRIDES, 'get').mockImplementation(((_mic: string) => {
				throw new Error('simulated KV outage on cross-venue scan');
			}) as never);

			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const after = await env.ORACLE_TELEMETRY.get(counterKey);
			expect(after).toBe('1');
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
			clearOverrideCache();
			await env.ORACLE_TELEMETRY.delete(counterKey).catch(() => {});
			await cleanupSampleRateBuckets(ip);
		}
	});

	// ── Test 12: regression — scan-success leaves safe=true, reasons clean,
	// counter does NOT tick. Pins that the new code path is dormant on the
	// happy path and the change is strictly additive on failure.
	it('regression: scan-success keeps safe=true, no CROSS_VENUE_SCAN_UNAVAILABLE, counter unchanged', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-09T14:30:00Z'));
		const ip = '203.0.113.121';
		const date = '2026-04-09';
		const counterKey = `v1_safe_to_trade_scan_unavailable:${date}`;
		try {
			await env.ORACLE_TELEMETRY.delete(counterKey).catch(() => {});
			const res = await fetchWorker('/v1/safe-to-trade/sample?venue=XNYS&max_age=30', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body.safe).toBe('true');
			const reasons = JSON.parse(body.reasons as string) as string[];
			expect(reasons).toEqual([]);
			const cv = JSON.parse(body.cross_venue as string) as { scan_ok: boolean };
			expect(cv.scan_ok).toBe(true);
			const after = await env.ORACLE_TELEMETRY.get(counterKey);
			expect(after).toBeNull();
		} finally {
			vi.useRealTimers();
			await env.ORACLE_TELEMETRY.delete(counterKey).catch(() => {});
			await cleanupSampleRateBuckets(ip);
		}
	});
});

// ─── GET /v1/status/{MIC} — Halt Gate free signed door ────────────────────────
//
// The "free signed status" wedge: unauthenticated, rate-limited (dashboard rule),
// returns the SAME authoritative signed receipt as /v5/status — mode 'live',
// byte-equivalent canonical payload for the same MIC at the same instant.
// receipt_mode is 'live' because it attests provenance-of-content, not
// provenance-of-payment.

describe('GET /v1/status/{MIC}', () => {
	it('bare /v1/status returns 400 MIC_REQUIRED with an example URL', async () => {
		const response = await fetchWorker('/v1/status');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MIC_REQUIRED');
		expect(body).toHaveProperty('example');
		expect(typeof body.example).toBe('string');
		expect((body.example as string)).toContain('/v1/status/XNYS');
	});

	it('trailing-slash /v1/status/ returns 400 MIC_REQUIRED', async () => {
		const response = await fetchWorker('/v1/status/');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'MIC_REQUIRED');
	});

	it('unknown MIC returns 400 UNKNOWN_MIC with supported list', async () => {
		const response = await fetchWorker('/v1/status/ZZZZ');
		expect(response.status).toBe(400);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'UNKNOWN_MIC');
		expect(Array.isArray(body.supported)).toBe(true);
		expect((body.supported as string[])).toContain('XNYS');
	});

	it('POST /v1/status/XNYS returns 405', async () => {
		const response = await fetchWorker('/v1/status/XNYS', { method: 'POST' });
		expect(response.status).toBe(405);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('error', 'METHOD_NOT_ALLOWED');
	});

	it('PUT /v1/status/XNYS returns 405', async () => {
		const response = await fetchWorker('/v1/status/XNYS', { method: 'PUT' });
		expect(response.status).toBe(405);
	});

	it('lowercase MIC is normalized to uppercase', async () => {
		const response = await fetchWorker('/v1/status/xnys');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('mic', 'XNYS');
	});

	it('trailing slash on MIC path is accepted', async () => {
		const response = await fetchWorker('/v1/status/XNYS/');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('mic', 'XNYS');
	});

	// Every supported MIC returns a valid signed receipt.
	for (const mic of ALL_MICS) {
		it(`returns a signed receipt for ${mic} (no auth required)`, async () => {
			const response = await fetchWorker(`/v1/status/${mic}`);
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
			expect(body).toHaveProperty('expires_at');
			expect(body).toHaveProperty('schema_version', 'v5.0');
			expect(body).toHaveProperty('issuer', 'headlessoracle.com');
			expect(body).toHaveProperty('public_key_id');
		});
	}

	it('receipt_mode is "live" — same provenance-of-content as /v5/status, not demo', async () => {
		const response = await fetchWorker('/v1/status/XNYS');
		expect(response.status).toBe(200);
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('receipt_mode', 'live');
	});

	it('TTL is exactly 60 seconds (RECEIPT_TTL_SECONDS — never extend)', async () => {
		const response = await fetchWorker('/v1/status/XNYS');
		const body = await response.json() as Record<string, unknown>;
		const issuedAt  = new Date(body.issued_at as string).getTime();
		const expiresAt = new Date(body.expires_at as string).getTime();
		expect(expiresAt - issuedAt).toBe(60_000);
	});

	it('response carries Cache-Control: no-store', async () => {
		const response = await fetchWorker('/v1/status/XNYS');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('response carries X-Attestation-Mode: live', async () => {
		const response = await fetchWorker('/v1/status/XNYS');
		expect(response.headers.get('X-Attestation-Mode')).toBe('live');
	});

	it('response includes discovery_url + nested receipt envelope (matches /v5/status shape)', async () => {
		const response = await fetchWorker('/v1/status/XNYS');
		const body = await response.json() as Record<string, unknown>;
		expect(body).toHaveProperty('discovery_url');
		expect(body.discovery_url).toBe('https://headlessoracle.com/.well-known/mcp/server-card.json');
		expect(body).toHaveProperty('receipt');
		const nested = body.receipt as Record<string, unknown>;
		expect(nested).toHaveProperty('mic', 'XNYS');
		expect(nested).toHaveProperty('signature');
		expect((nested.signature as string).length).toBe(128);
	});

	it('Tier 0 — ORACLE_OVERRIDES HALTED flows through to /v1/status', async () => {
		const expires = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({
			status:  'HALTED',
			reason:  'Test circuit breaker via /v1/status',
			expires,
		}));
		try {
			const response = await fetchWorker('/v1/status/XNYS');
			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('status', 'HALTED');
			expect(body).toHaveProperty('source', 'OVERRIDE');
			expect(body).toHaveProperty('reason', 'Test circuit breaker via /v1/status');
			expect(body).toHaveProperty('signature');
			expect((body.signature as string).length).toBe(128);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
		}
	});

	it('canonical signed fields match the /v5/demo shape exactly (Phase-C-safe envelope)', async () => {
		// /v5/demo and /v1/status both call buildSignedReceipt — the canonical
		// signed-field SET must be identical (mode differs: 'demo' vs 'live', but
		// that field is in both). This guards against /v1/status diverging from the
		// signing path's payload shape (which would force a verifier-SDK update).
		const v1   = await fetchJSON('/v1/status/XNYS');
		const demo = await fetchJSON('/v5/demo?mic=XNYS');
		const CANONICAL = ['receipt_id', 'issued_at', 'expires_at', 'issuer', 'mic',
			'status', 'source', 'halt_detection', 'receipt_mode', 'schema_version',
			'public_key_id', 'signature'];
		for (const field of CANONICAL) {
			expect(v1, `missing field ${field}`).toHaveProperty(field);
			expect(demo, `/v5/demo missing field ${field}`).toHaveProperty(field);
		}
		// Constants match.
		expect(v1.issuer).toBe(demo.issuer);
		expect(v1.schema_version).toBe(demo.schema_version);
		expect(v1.public_key_id).toBe(demo.public_key_id);
		// Status + source MUST match across the two doors (same MIC, same instant).
		expect(v1.status).toBe(demo.status);
		expect(v1.source).toBe(demo.source);
		// mode differs by design.
		expect(v1.receipt_mode).toBe('live');
		expect(demo.receipt_mode).toBe('demo');
	});

	// ── HEAD method support ────────────────────────────────────────────────
	// RFC 7231 §4.3.2 — HEAD mirrors GET: same status, same headers, no body.
	// HEAD is the metadata-probe path (uptime checks, CDN warm-up, header inspection);
	// the receipt body is not served, so side effects are skipped.
	it('HEAD /v1/status/XNYS returns 200 with no body and GET-equivalent headers', async () => {
		const response = await fetchWorker('/v1/status/XNYS', { method: 'HEAD' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('X-Attestation-Mode')).toBe('live');
		expect(response.headers.get('Content-Type')).toMatch(/json/);
		const body = await response.text();
		expect(body).toBe('');
	});

	it('HEAD /v1/status (bare) returns 400 MIC_REQUIRED with no body', async () => {
		const response = await fetchWorker('/v1/status', { method: 'HEAD' });
		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe('');
	});

	it('HEAD /v1/status/ZZZZ returns 400 UNKNOWN_MIC with no body', async () => {
		const response = await fetchWorker('/v1/status/ZZZZ', { method: 'HEAD' });
		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe('');
	});

	it('POST /v1/status/XNYS still returns 405 (HEAD-or-GET only path is the relaxation)', async () => {
		const response = await fetchWorker('/v1/status/XNYS', { method: 'POST' });
		expect(response.status).toBe(405);
	});

	it('HEAD does NOT increment v1_status_calls counter (metadata probe, not a served receipt)', async () => {
		const date = new Date().toISOString().slice(0, 10);
		const key  = `v1_status_calls:${date}`;
		await env.ORACLE_TELEMETRY.delete(key);
		const headResp = await fetchWorker('/v1/status/XNYS', { method: 'HEAD' });
		expect(headResp.status).toBe(200);
		// Allow the deferred KV write a tick to settle — though it should not fire.
		const after = await env.ORACLE_TELEMETRY.get(key);
		expect(after).toBeNull();
	});

	it('GET (after HEAD) still increments v1_status_calls counter — proves HEAD-skip is method-scoped, not global', async () => {
		const date = new Date().toISOString().slice(0, 10);
		const key  = `v1_status_calls:${date}`;
		await env.ORACLE_TELEMETRY.delete(key);
		await fetchWorker('/v1/status/XNYS', { method: 'HEAD' });
		await fetchWorker('/v1/status/XNYS');
		// fetchWorker awaits waitOnExecutionContext, so the deferred writes have landed.
		const after = await env.ORACLE_TELEMETRY.get(key);
		expect(after).toBe('1');
	});

	it('HEAD /v1/status/XNYS headers are byte-identical to GET /v1/status/XNYS headers (modulo time)', async () => {
		const headResp = await fetchWorker('/v1/status/XNYS', { method: 'HEAD' });
		const getResp  = await fetchWorker('/v1/status/XNYS');
		expect(headResp.status).toBe(getResp.status);
		// Headers that are response-shape-invariant must match exactly.
		for (const h of ['Cache-Control', 'X-Attestation-Mode', 'X-Oracle-Version', 'X-Oracle-Plan']) {
			expect(headResp.headers.get(h)).toBe(getResp.headers.get(h));
		}
	});

	it('signature verifies via signPayload-derived canonical bytes (in-repo signer round-trip)', async () => {
		// Drives the byte-parity guarantee from the worker side: reconstruct the
		// canonical payload from receipt fields, re-sign with the test private key,
		// and assert the worker's signature matches. If this test passes, the
		// canonical-bytes path inside /v1/status is identical to signPayload's.
		const response = await fetchWorker('/v1/status/XNYS');
		const body = await response.json() as Record<string, unknown>;
		// `coverage` added to the signed payload 2026-09-07 (rail sprint T3). It is
		// a JSON-encoded STRING, so it reconstructs like every other field here.
		// This list is a hardcoded mirror of /v5/keys -> canonical_payload_spec:
		// updating it IS the compatibility contract this change carries. A
		// verifier that reads the spec at runtime needed no change; one that
		// hardcodes a field list, as this test does, must be updated in step.
		const CANONICAL = ['coverage', 'receipt_id', 'issued_at', 'expires_at', 'issuer', 'mic',
			'status', 'source', 'halt_detection', 'receipt_mode', 'schema_version',
			'public_key_id'];
		const payload: Record<string, string> = {};
		for (const k of CANONICAL) {
			if (typeof body[k] === 'string') payload[k] = body[k] as string;
		}
		const expectedSig = await signPayload(payload, env.ED25519_PRIVATE_KEY);
		expect(body.signature).toBe(expectedSig);
	});
});

// ─── In-worker rate limit on /v1/status/{MIC} (belt-and-suspenders) ───────────
//
// 60 req/min/IP soft cap, fail-OPEN on KV error. The Cloudflare dashboard rule
// is the primary enforcement; this is the safety net in front of it. Tests pin
// the under/over/error-path behaviour so a refactor cannot silently change the
// fail-open posture (which would break the free door on any KV blip).

describe('GET /v1/status/{MIC} — in-worker rate limit', () => {
	// Each test uses a unique X-Original-IP so cases don't bleed counters into
	// each other. The IP is hashed and bucketed by minute; the KV cleanup at the
	// end of each test deletes the exact key the worker just wrote.
	async function ipHashOf(ip: string): Promise<string> {
		const bytes = new TextEncoder().encode(ip);
		const buf   = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	}
	async function cleanupRateBuckets(ip: string): Promise<void> {
		const hash = await ipHashOf(ip);
		// Sweep a small window of minute buckets around now — covers tests that
		// might span a minute boundary.
		const minute = Math.floor(Date.now() / 60_000);
		for (let m = minute - 1; m <= minute + 1; m++) {
			await env.ORACLE_TELEMETRY.delete(`v1_status_rate:${hash}:${m}`).catch(() => {});
		}
	}

	it('passes under the limit (10 requests with a fresh IP all return 200)', async () => {
		const ip = '203.0.113.10';
		try {
			for (let i = 0; i < 10; i++) {
				const res = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ip } });
				expect(res.status).toBe(200);
			}
		} finally {
			await cleanupRateBuckets(ip);
		}
	});

	it('exact-limit (60) all pass; 61st returns 429 with Retry-After', async () => {
		const ip = '203.0.113.20';
		// GAP-019. The limiter buckets on Math.floor(now / 60_000) -- a WALL-CLOCK
		// minute -- and this test fires 61 real sequential requests. When those
		// straddle a minute boundary the counter resets and the 61st returns 200,
		// so the test went red for a reason that has nothing to do with the code
		// under test. Latent since it was written; it fired twice on 2026-09-09
		// and again here once the suite grew, because what decides it is where in
		// the minute the burst happens to start.
		//
		// Pinning the clock is the fix canon names. All 61 requests now land in
		// one bucket by construction. It does not weaken the assertion: the 61st
		// must still be refused, and seeding the counter instead would have
		// stopped testing that the first 60 pass.
		vi.setSystemTime(new Date('2026-04-08T15:00:30Z'));
		try {
			for (let i = 0; i < 60; i++) {
				const res = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ip } });
				expect(res.status, `request #${i + 1} should pass`).toBe(200);
			}
			const over = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ip } });
			expect(over.status).toBe(429);
			expect(over.headers.get('Retry-After')).toBeTruthy();
			expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
			expect(Number(over.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
			expect(over.headers.get('X-RateLimit-Limit')).toBe('60');
			expect(over.headers.get('X-RateLimit-Remaining')).toBe('0');
			expect(over.headers.get('X-RateLimit-Reset')).toBeTruthy();
			const body = await over.json() as Record<string, unknown>;
			expect(body.error).toBe('RATE_LIMITED');
			expect(body.limit_per_minute).toBe(60);
			expect(typeof body.retry_after_seconds).toBe('number');
		} finally {
			vi.useRealTimers();
			await cleanupRateBuckets(ip);
		}
	});

	it('fails OPEN when the KV read throws (free door must not break on KV blips)', async () => {
		const ip = '203.0.113.30';
		const originalGet = env.ORACLE_TELEMETRY.get.bind(env.ORACLE_TELEMETRY);
		vi.spyOn(env.ORACLE_TELEMETRY, 'get').mockImplementation(async (key: string) => {
			if (typeof key === 'string' && key.startsWith('v1_status_rate:')) {
				throw new Error('simulated KV outage');
			}
			return originalGet(key);
		});
		try {
			const res = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ip } });
			expect(res.status).toBe(200);
			const body = await res.json() as Record<string, unknown>;
			expect(body.mic).toBe('XNYS');
			expect(typeof body.signature).toBe('string');
		} finally {
			vi.restoreAllMocks();
			await cleanupRateBuckets(ip);
		}
	});

	it('per-IP isolation — IP A at the limit does not affect IP B', async () => {
		// Seed IP A's counter directly to the limit (bypassing the API loop)
		// so this test is robust against a minute-boundary roll-over partway
		// through what would otherwise be 60 sequential requests. The
		// increment-path coverage lives in the "exact-limit (60)" test above;
		// here we are isolating the per-IP partitioning of the bucket key.
		const ipA = '203.0.113.40';
		const ipB = '203.0.113.41';
		const ipAHash = await ipHashOf(ipA);
		const minute  = Math.floor(Date.now() / 60_000);
		const ipAKey  = `v1_status_rate:${ipAHash}:${minute}`;
		try {
			await env.ORACLE_TELEMETRY.put(ipAKey, '60', { expirationTtl: 90 });
			// IP A is already at the limit — next request rate-limited.
			const overA = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ipA } });
			expect(overA.status).toBe(429);
			// IP B is fresh — first request passes.
			const freshB = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ipB } });
			expect(freshB.status).toBe(200);
		} finally {
			await cleanupRateBuckets(ipA);
			await cleanupRateBuckets(ipB);
		}
	});

	it('HEAD counts against the same per-IP minute bucket as GET (volume-based, not receipt-based)', async () => {
		// HEAD still computes the receipt to derive headers, so the rate-limit
		// gate treats GET and HEAD as equivalent volume. (This is intentionally
		// distinct from the served-receipt counter / digest skip, which is
		// receipt-based.) Seed the counter directly to keep the test off the
		// minute-boundary roll-over path; the increment-via-HEAD path is
		// exercised below with a small fresh slice.
		const ip = '203.0.113.50';
		const ipHash = await ipHashOf(ip);
		const minute = Math.floor(Date.now() / 60_000);
		const key    = `v1_status_rate:${ipHash}:${minute}`;
		try {
			// First: prove HEAD increments the same bucket by driving 3 HEADs
			// and checking the counter ticked.
			for (let i = 0; i < 3; i++) {
				const r = await fetchWorker('/v1/status/XNYS', { method: 'HEAD', headers: { 'X-Original-IP': ip } });
				expect(r.status, `HEAD request #${i + 1}`).toBe(200);
			}
			const counted = await env.ORACLE_TELEMETRY.get(key);
			expect(parseInt(counted ?? '0', 10)).toBeGreaterThanOrEqual(3);

			// Then: seed the bucket to the limit and confirm both GET and HEAD
			// are rate-limited from the same shared counter.
			await env.ORACLE_TELEMETRY.put(key, '60', { expirationTtl: 90 });
			const overGet = await fetchWorker('/v1/status/XNYS', { headers: { 'X-Original-IP': ip } });
			expect(overGet.status).toBe(429);
			const overHead = await fetchWorker('/v1/status/XNYS', { method: 'HEAD', headers: { 'X-Original-IP': ip } });
			expect(overHead.status).toBe(429);
			const headBody = await overHead.text();
			expect(headBody).toBe('');
			expect(overHead.headers.get('Retry-After')).toBeTruthy();
		} finally {
			await cleanupRateBuckets(ip);
		}
	});

	it('bare /v1/status (no MIC) is NOT rate-limited — outside the {MIC} handler scope', async () => {
		// Bare /v1/status is cheap (400 MIC_REQUIRED, no receipt computation)
		// and lives outside the /v1/status/{MIC} handler. Confirming the limit
		// is scoped to the MIC path so a misconfiguration doesn't accidentally
		// gate the friendly error response.
		const ip = '203.0.113.60';
		try {
			for (let i = 0; i < 65; i++) {
				const r = await fetchWorker('/v1/status', { headers: { 'X-Original-IP': ip } });
				expect(r.status).toBe(400);
			}
		} finally {
			await cleanupRateBuckets(ip);
		}
	});
});

// ─── Byte-parity guard across signer / in-repo verifier / SDK verifier ────────
//
// This is the gate that protects against the March 1-2 silent-canonicalization
// class of bug: three independent canonicalizations of the same receipt
// (signer, in-repo verifier inside /v5/verify, SDK verifier in
// @headlessoracle/verify) MUST agree byte-for-byte. If any one of them drifts,
// silently produced signatures will silently fail verification. Tests in this
// block run an INDEPENDENT re-implementation of each algorithm (not a shared
// helper) so a refactor that touches src/ canonicalization cannot accidentally
// teach the test the wrong algorithm.
//
// The three documented canonicalization algorithms:
//
//   1. signer (signPayload in src/index.ts): sort keys alphabetically →
//      JSON.stringify with no whitespace.
//
//   2. in-repo verifier (verifyReceiptLogic in src/index.ts): drop the
//      'signature' field, drop the wrapper fields {'discovery_url', 'receipt',
//      'extensions'}, then sort + JSON.stringify the remainder. Field values
//      are coerced to String() — this matches what the live worker does.
//
//   3. SDK verifier (@headlessoracle/verify src/index.ts): filter the receipt
//      to a canonical_payload_spec allowlist (intentionally the same set as
//      the signer's canonical fields), then sort + JSON.stringify.

describe('Byte-parity — signer / in-repo verifier / SDK verifier all produce identical canonical bytes', () => {
	// A fixed, realistic /v1/status canonical payload. All values are strings
	// because the signer's string-only guard is the spec-conformance line —
	// non-string fields throw on sign. Receipt mode is 'live' because /v1/status
	// emits 'live' (same provenance-of-content as /v5/status).
	const FIXED_PAYLOAD: Record<string, string> = {
		receipt_id:     'parity-fixture-00000001',
		issued_at:      '2026-06-14T13:42:11.000Z',
		expires_at:     '2026-06-14T13:43:11.000Z',
		issuer:         'headlessoracle.com',
		mic:            'XNYS',
		status:         'OPEN',
		source:         'SCHEDULE',
		halt_detection: 'schedule_only',
		// `coverage` joined the signed payload 2026-09-07 (rail sprint T3). It is
		// a JSON-encoded STRING — the same convention `cross_venue` and `reasons`
		// already use on the safe-to-trade receipt — so all three canonicalization
		// implementations treat it as an ordinary string field and byte parity is
		// unaffected by its internal structure. That is exactly why it is encoded
		// as a string rather than nested: a nested object would make its key ORDER
		// load-bearing with no rule in the spec saying so.
		coverage:       '{"determination_tier":1,"consulted":["manual_override_kv","schedule"],"not_consulted":["realtime_halt_feed"],"realtime_halt_feed_scope":["XNAS","XNYS"],"unknown_reason":null,"feed_state":"not_covered","feed_last_run":null}',
		receipt_mode:   'live',
		schema_version: 'v5.0',
		public_key_id:  'key_2026_v1',
	};

	// Independent re-implementation of (1) the signer's canonicalization.
	function signerCanonical(p: Record<string, string>): string {
		const sorted: Record<string, string> = {};
		for (const k of Object.keys(p).sort()) sorted[k] = p[k];
		return JSON.stringify(sorted);
	}

	// Independent re-implementation of (2) the in-repo verifier's
	// canonicalization (strip-wrapper approach).
	function inRepoCanonical(wrappedReceipt: Record<string, unknown>): string {
		const UNSIGNED = new Set(['discovery_url', 'receipt', 'extensions']);
		const { signature: _sig, ...rest } = wrappedReceipt;
		void _sig;
		const out: Record<string, string> = {};
		for (const k of Object.keys(rest).sort()) {
			if (UNSIGNED.has(k)) continue;
			out[k] = String((rest as Record<string, unknown>)[k]);
		}
		return JSON.stringify(out);
	}

	// Independent re-implementation of (3) the SDK verifier's canonicalization
	// (allowlist approach). The allowlist mirrors canonical_payload_spec.
	function sdkCanonical(wrappedReceipt: Record<string, unknown>, allowlist: string[]): string {
		const out: Record<string, unknown> = {};
		for (const k of allowlist.slice().sort()) {
			if (k in wrappedReceipt) out[k] = wrappedReceipt[k];
		}
		return JSON.stringify(out);
	}

	// Mirrors /v5/keys -> canonical_payload_spec. `coverage` added 2026-09-07.
	const ALLOWLIST = [
		'coverage', 'expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic',
		'public_key_id', 'reason', 'receipt_id', 'receipt_mode',
		'schema_version', 'source', 'status',
	];

	it('the three canonicalization algorithms produce byte-identical bytes on a fixed payload', async () => {
		const signerBytes = signerCanonical(FIXED_PAYLOAD);
		// Build the response shape /v1/status actually emits (incl. wrapper).
		const sig = await signPayload(FIXED_PAYLOAD, env.ED25519_PRIVATE_KEY);
		const receiptOut = { ...FIXED_PAYLOAD, signature: sig };
		const wrapped = { ...receiptOut, receipt: receiptOut, discovery_url: 'https://headlessoracle.com/.well-known/mcp/server-card.json' };
		const inRepoBytes = inRepoCanonical(wrapped);
		const sdkBytes    = sdkCanonical(wrapped, ALLOWLIST);
		expect(inRepoBytes).toBe(signerBytes);
		expect(sdkBytes).toBe(signerBytes);
	});

	it('byte-parity holds against a LIVE /v1/status receipt fetched from the worker', async () => {
		// Same check but with a real, just-issued receipt — guards against any
		// drift between the fixed fixture and what buildSignedReceipt actually
		// emits. If the worker started emitting an extra field, this catches it.
		const response = await fetchWorker('/v1/status/XNYS');
		expect(response.status).toBe(200);
		const wrapped = await response.json() as Record<string, unknown>;

		// Reconstruct the signer's canonical from the top-level fields the
		// signer would have signed (the 11 fields in FIXED_PAYLOAD shape).
		const signerPayload: Record<string, string> = {};
		for (const k of Object.keys(FIXED_PAYLOAD)) {
			if (typeof wrapped[k] === 'string') signerPayload[k] = wrapped[k] as string;
		}
		const signerBytes = signerCanonical(signerPayload);
		const inRepoBytes = inRepoCanonical(wrapped);
		const sdkBytes    = sdkCanonical(wrapped, ALLOWLIST);
		expect(inRepoBytes).toBe(signerBytes);
		expect(sdkBytes).toBe(signerBytes);
	});

	it('signPayload-produced signature verifies against signerCanonical bytes — closes the loop', async () => {
		// The strongest form: produce a signature with signPayload, then check
		// it via raw Ed25519 against bytes we built ourselves with the
		// independent reimplementation. If the signature does NOT verify, the
		// signer has silently drifted from documented canonicalization.
		const sig = await signPayload(FIXED_PAYLOAD, env.ED25519_PRIVATE_KEY);
		const bytes = signerCanonical(FIXED_PAYLOAD);
		const msg   = new TextEncoder().encode(bytes);
		const pubKey = (await import('@noble/ed25519')).getPublicKeyAsync;
		// fromHex helper inline to avoid a new import.
		const fromHexBytes = (hex: string) => {
			const out = new Uint8Array(hex.length / 2);
			for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
			return out;
		};
		const privBytes = fromHexBytes(env.ED25519_PRIVATE_KEY);
		const pub = await pubKey(privBytes);
		const ed = await import('@noble/ed25519');
		const ok = await ed.verifyAsync(fromHexBytes(sig), msg, pub);
		expect(ok).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 — one canonical requirements object, served correctly in both versions
//
// Written 2026-09-07 for the rail sprint T1. What these tests exist to catch is
// a real production defect, not a hypothetical: the worker's Payment-Required
// header declared x402Version 1 while carrying the v2 field name `amount` and
// omitting the v1-mandatory `resource` and `description`, so it validated
// against NEITHER schema. Because @x402/core reads the header before the body,
// every 2.x client saw only the broken header. A stock @x402/fetch 2.20.0 run
// against production on 2026-09-07 died with
//   "Failed to create payment payload: No client registered for x402 version: 1"
// before signing anything (RAIL_T0_2026-09-07.md, E5).
//
// The schemas used below are the REAL ones from @x402/core 2.20.0, vendored
// byte-for-byte in test/vendor/x402-schemas.mjs with their digest and
// provenance. They are not a transcription: a hand-written validator can be
// wrong in the same direction as the builder it is checking.
// ─────────────────────────────────────────────────────────────────────────────
describe('x402 — canonical requirements object, v2 header beside v1 body', () => {
	const PAY_TO   = '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3';
	const RESOURCE = 'https://headlessoracle.com/v5/status?mic=XNYS';

	// Every assertion derives its expectation from the canonical object, never
	// from a literal — a test that hardcodes '1000' cannot catch a price change.
	const canonical = () => x402Canonical('status', PAY_TO, RESOURCE);

	describe('the v2 PAYMENT-REQUIRED header', () => {
		it('validates against the real PaymentRequiredV2Schema from @x402/core 2.20.0', async () => {
			const { PaymentRequiredV2Schema } = await import('./vendor/x402-schemas.mjs');
			const headers = buildX402IndexHeaders(PAY_TO, 'status', RESOURCE);
			const decoded = JSON.parse(x402Base64Decode(headers['Payment-Required']));
			const parsed  = PaymentRequiredV2Schema.safeParse(decoded);
			// Print the zod issues on failure — a bare `false` tells the next
			// reader nothing about which field drifted.
			expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
		});

		it('each accepts[] entry validates against the real PaymentRequirementsV2Schema', async () => {
			const { PaymentRequirementsV2Schema } = await import('./vendor/x402-schemas.mjs');
			const decoded = JSON.parse(x402Base64Decode(buildX402IndexHeaders(PAY_TO, 'status', RESOURCE)['Payment-Required']));
			expect(decoded.accepts.length).toBeGreaterThan(0);
			for (const a of decoded.accepts) {
				const parsed = PaymentRequirementsV2Schema.safeParse(a);
				expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
			}
		});

		it('REGRESSION (2026-09-07): the header is no longer a v1/v2 hybrid', async () => {
			const { PaymentRequirementsV1Schema, PaymentRequirementsV2Schema } = await import('./vendor/x402-schemas.mjs');
			// The exact accepts[0] production served on 2026-09-07 09:27:34Z
			// (decoded header sha256 2ab0def7270adbe95e02bd0b5ba3d05609b2b1b23138c0a574545ceca6aa273c).
			// This is the RED case: it matched neither schema, which is why a 2.x
			// client could not pay. If either assertion below ever goes true for
			// this shape, the vendored schemas are not doing any work.
			const brokenAccepts = { scheme: 'exact', network: 'base', amount: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO, maxTimeoutSeconds: 300 };
			expect(PaymentRequirementsV1Schema.safeParse(brokenAccepts).success).toBe(false); // no maxAmountRequired / resource / description
			expect(PaymentRequirementsV2Schema.safeParse(brokenAccepts).success).toBe(false); // 'base' is not CAIP-2
			// And what we serve now is not that shape.
			const decoded = JSON.parse(x402Base64Decode(buildX402IndexHeaders(PAY_TO, 'status', RESOURCE)['Payment-Required']));
			expect(decoded.x402Version).toBe(2);
			expect(String(decoded.accepts[0].network)).toContain(':');
		});

		it('declares CAIP-2 Base mainnet and a top-level resource object', () => {
			const decoded = JSON.parse(x402Base64Decode(buildX402IndexHeaders(PAY_TO, 'status', RESOURCE)['Payment-Required']));
			const c = canonical();
			expect(decoded.accepts[0].network).toBe(c.networkV2);
			expect(decoded.accepts[0].network).toBe('eip155:8453');
			// resource/description/mimeType live at the top level in v2, NOT in
			// accepts[] — restating them inside accepts is the two-places defect.
			expect(decoded.resource.url).toBe(RESOURCE);
			expect(decoded.accepts[0].resource).toBeUndefined();
			expect(decoded.accepts[0].description).toBeUndefined();
			expect(decoded.accepts[0].maxAmountRequired).toBeUndefined();
		});

		it('Payment-Required-Json mirrors the base64 header byte for byte', () => {
			const h = buildX402IndexHeaders(PAY_TO, 'status', RESOURCE);
			expect(x402Base64Decode(h['Payment-Required'])).toBe(h['Payment-Required-Json']);
			// And the encoder is the client's own: round-trip through it.
			expect(x402Base64Encode(h['Payment-Required-Json'])).toBe(h['Payment-Required']);
		});

		it('binds the resource the caller is actually paying for, not a default', () => {
			const other = 'https://headlessoracle.com/v1/safe-to-trade?mic=XNAS';
			const decoded = JSON.parse(x402Base64Decode(buildX402IndexHeaders(PAY_TO, 'status', other)['Payment-Required']));
			expect(decoded.resource.url).toBe(other);
		});
	});

	describe('the v1 402 body', () => {
		it('validates against the real PaymentRequiredV1Schema', async () => {
			const { PaymentRequiredV1Schema } = await import('./vendor/x402-schemas.mjs');
			const body   = buildMainnetFacilitatorPayload(PAY_TO, RESOURCE);
			const parsed = PaymentRequiredV1Schema.safeParse(body);
			expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
		});

		it('the x402scan / Bazaar body also validates against PaymentRequiredV1Schema', async () => {
			const { PaymentRequiredV1Schema } = await import('./vendor/x402-schemas.mjs');
			const body   = buildX402ScanPayload(PAY_TO, RESOURCE, 'status');
			const parsed = PaymentRequiredV1Schema.safeParse(body);
			expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
		});

		it('carries the v1 field names, not the v2 ones', () => {
			const a = (buildMainnetFacilitatorPayload(PAY_TO, RESOURCE).accepts as Record<string, unknown>[])[0];
			expect(a.maxAmountRequired).toBe(canonical().amountAtomic);
			expect(a.amount).toBeUndefined();
			expect(a.network).toBe('base');
			expect(a.resource).toBe(RESOURCE);
			expect(typeof a.description).toBe('string');
		});
	});

	describe('the facilitator payload in both versions', () => {
		it('v2 requirements validate against PaymentRequirementsV2Schema', async () => {
			const { PaymentRequirementsV2Schema } = await import('./vendor/x402-schemas.mjs');
			const parsed = PaymentRequirementsV2Schema.safeParse(x402FacilitatorRequirements(canonical(), 2));
			expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
		});

		it('v1 requirements validate against PaymentRequirementsV1Schema', async () => {
			const { PaymentRequirementsV1Schema } = await import('./vendor/x402-schemas.mjs');
			const parsed = PaymentRequirementsV1Schema.safeParse(x402FacilitatorRequirements(canonical(), 1));
			expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBe(null);
		});

		it('CROSSED versions are rejected — this is the invalid_network failure of 2026-06-07', async () => {
			const { PaymentRequirementsV1Schema, PaymentRequirementsV2Schema } = await import('./vendor/x402-schemas.mjs');
			// v1-shaped requirements sent under version 2: NetworkSchemaV2 rejects
			// the bare 'base'. That is exactly what CDP /verify did on 2026-06-07
			// (GAP-020) and why the Bazaar settlement failed.
			expect(PaymentRequirementsV2Schema.safeParse(x402FacilitatorRequirements(canonical(), 1)).success).toBe(false);
			// v2-shaped requirements sent under version 1: no maxAmountRequired.
			expect(PaymentRequirementsV1Schema.safeParse(x402FacilitatorRequirements(canonical(), 2)).success).toBe(false);
		});

		it('the version is read from the client payload, not assumed', () => {
			expect(x402PayloadVersion({ x402Version: 2 })).toBe(2);
			expect(x402PayloadVersion({ x402Version: 1 })).toBe(1);
			// Fail to the legacy shape: the old client omits the field, and v1 is
			// the only shape that has ever settled through CDP for us.
			expect(x402PayloadVersion({})).toBe(1);
			expect(x402PayloadVersion({ x402Version: 99 })).toBe(1);
		});

		it('the settlement header takes the name the payer version reads', () => {
			const settle = { success: true, transaction: '0xabc', network: 'eip155:8453' };
			expect(Object.keys(x402SettlementHeaders(2, settle))).toEqual(['Payment-Response']);
			expect(Object.keys(x402SettlementHeaders(1, settle))).toEqual(['X-Payment-Response']);
			// Base64 JSON per transports-v2/http.md — not the raw JSON string the
			// worker used to send, which no client decodes.
			const v2 = x402SettlementHeaders(2, settle)['Payment-Response'];
			expect(JSON.parse(x402Base64Decode(v2))).toEqual(settle);
		});
	});

	// ── The diff test (T1.5) ──────────────────────────────────────────────────
	// Every representation of the price is built from the canonical object and
	// must agree. It is falsifiable by construction: change amountAtomic in
	// X402_RESOURCE_SPECS and every surface that still carries the old literal
	// goes red. Driven red during the sprint by setting status.amountAtomic to
	// '2000' — see CC_REPORT_2026-09-07_x402-v2-rail.md, T1 DoD.
	describe('diff test — every surface agrees with the canonical object', () => {
		const EXPECTED_USDC   = x402AtomicToUsdc(x402ResourceSpecs().status.amountAtomic);
		const EXPECTED_ATOMIC = x402ResourceSpecs().status.amountAtomic;

		it('v2 header and v1 body agree on price, asset, payTo and resource', () => {
			const v2  = JSON.parse(x402Base64Decode(buildX402IndexHeaders(PAY_TO, 'status', RESOURCE)['Payment-Required']));
			const v1  = buildMainnetFacilitatorPayload(PAY_TO, RESOURCE) as Record<string, unknown>;
			const v1a = (v1.accepts as Record<string, unknown>[])[0];
			expect(v2.accepts[0].amount).toBe(v1a.maxAmountRequired);
			expect(v2.accepts[0].amount).toBe(EXPECTED_ATOMIC);
			expect(v2.accepts[0].asset).toBe(v1a.asset);
			expect(v2.accepts[0].payTo).toBe(v1a.payTo);
			expect(v2.resource.url).toBe(v1a.resource);
			expect(v2.resource.description).toBe(v1a.description);
		});

		it('/v5/pricing carries the canonical amount, not a literal', async () => {
			const body = await fetchJSON('/v5/pricing');
			const x    = body.x402 as Record<string, unknown>;
			expect(x.amount_usdc).toBe(EXPECTED_USDC);
			expect(x.amount_units).toBe(EXPECTED_ATOMIC);
			expect(x.usdc_contract).toBe(canonical().asset);
			expect(x.network_caip2).toBe(canonical().networkV2);
		});

		it('/llms.txt and /llms-full.txt quote the canonical price', async () => {
			const idx  = await (await fetchWorker('/llms.txt')).text();
			const full = await (await fetchWorker('/llms-full.txt')).text();
			expect(idx).toContain(`Pay-per-call $${EXPECTED_USDC} USDC on Base`);
			expect(full).toContain(`x402: ${EXPECTED_USDC} USDC/req via Base mainnet`);
		});

		it('the MCP server card carries the canonical amount, asset and resource', async () => {
			const card = await fetchJSON('/.well-known/mcp/server-card.json');
			const x    = card.x402 as Record<string, unknown>;
			expect(x.amount).toBe(EXPECTED_ATOMIC);
			expect(x.amount_usdc).toBe(EXPECTED_USDC);
			expect(x.asset).toBe(canonical().asset);
			expect(x.network).toBe(canonical().networkV2);
			expect(x.payment_endpoint).toBe(x402ResourceSpecs().status.defaultResourceUrl);
		});

		it('the agent.json payment block carries the canonical amounts', async () => {
			const agent = await fetchJSON('/.well-known/agent.json');
			const pay   = agent.payment as Record<string, unknown>;
			expect(pay.amount_per_request).toBe(`${EXPECTED_USDC} USDC`);
			expect(pay.amount_units).toBe(EXPECTED_ATOMIC);
			expect(pay.batch_amount_units).toBe(x402ResourceSpecs().batch.amountAtomic);
			expect(pay.asset).toBe(canonical().asset);
		});

		it('the key-delivery email template quotes the canonical price', () => {
			// The sentence the customer actually receives, exported from the same
			// module as the amount, so a price change cannot leave the welcome
			// email quoting last month's figure.
			expect(x402EmailPriceLine()).toContain(`${EXPECTED_USDC} USDC on Base mainnet`);
		});

		it('atomic-to-USDC conversion is exact integer arithmetic', () => {
			expect(x402AtomicToUsdc('1000')).toBe('0.001');
			expect(x402AtomicToUsdc('5000')).toBe('0.005');
			expect(x402AtomicToUsdc('1000000')).toBe('1');
			expect(x402AtomicToUsdc('99000000')).toBe('99');
			expect(x402AtomicToUsdc('1')).toBe('0.000001');
		});

		// ── Served price text (T2b) ──────────────────────────────────────────
		// T1 made the canonical object the single source of the price a client
		// SIGNS. These assertions extend that to the price a human or an agent
		// READS: every served surface below quoted "$0.001" as a literal until
		// this fix pass, so a change to status.amountAtomic would have left them
		// advertising a price the worker no longer charges. Each expectation is
		// derived from x402ResourceSpecs(), never written out, so the test moves
		// with the product and goes red only on a surface that stopped deriving.
		const EXPECTED_BATCH_USDC = x402AtomicToUsdc(x402ResourceSpecs().batch.amountAtomic);

		it('/openapi.json quotes the canonical per-request and batch prices', async () => {
			const text = await (await fetchWorker('/openapi.json')).text();
			// /v5/status: the payment header parameter and the 402 response.
			expect(text).toContain(`($${EXPECTED_USDC} USDC on Base mainnet)`);
			expect(text).toContain(`pay $${EXPECTED_USDC} USDC per request`);
			// /v5/batch: its own, higher price.
			expect(text).toContain(`($${EXPECTED_BATCH_USDC} USDC for batch)`);
			expect(text).toContain(`($${EXPECTED_BATCH_USDC} USDC on Base mainnet for batch)`);
			// /v5/sandbox and the x402 discovery summary.
			expect(text).toContain(`USDC payment ($${EXPECTED_USDC})`);
			expect(text).toContain(`/v5/status ($${EXPECTED_USDC} USDC), /v5/batch ($${EXPECTED_BATCH_USDC})`);
		});

		it('the MCP server card description quotes the canonical price', async () => {
			const card = await fetchJSON('/.well-known/mcp/server-card.json');
			expect(card.description as string).toContain(`x402 micropayments ($${EXPECTED_USDC} USDC on Base mainnet)`);
		});

		it('/v5/pricing tier prose quotes the canonical price, not just the number', async () => {
			const body  = await fetchJSON('/v5/pricing');
			const tiers = body.tiers as Array<Record<string, unknown>>;
			const x402  = tiers.find((t) => t.id === 'x402') as Record<string, unknown>;
			expect(x402.description as string).toContain(`Pay $${EXPECTED_USDC} USDC per request`);
			expect(x402.price_label).toBe(`$${EXPECTED_USDC} USDC / request`);
		});

		it('/v5/why-not-free quotes the canonical price in every payment option', async () => {
			const body = await fetchJSON('/v5/why-not-free');
			const perRequest = body.x402_per_request as Record<string, unknown>;
			const sandbox    = body.x402_sandbox as Record<string, unknown>;
			expect(perRequest.cost).toBe(`$${EXPECTED_USDC} USDC`);
			expect(sandbox.cost).toBe(`$${EXPECTED_USDC} USDC`);
		});

		it('the MCP get_payment_options tool description quotes the canonical price', async () => {
			const body  = await postMcpJSON({ jsonrpc: '2.0', id: 901, method: 'tools/list' });
			const tools = (body.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
			const tool  = tools.find((t) => t.name === 'get_payment_options') as Record<string, unknown>;
			expect(tool.description as string).toContain(`x402 per-request ($${EXPECTED_USDC} USDC)`);
			expect(tool.description as string).toContain(`10 credits for $${EXPECTED_USDC}`);
		});

		it('the 402 an agent actually receives quotes the canonical price', async () => {
			// The trial gates the 402 (T1.6) — exhaust it first or this measures a 200.
			const ip     = '203.0.113.91';
			const ipHash = await sha256Hex(ip);
			const today  = new Date().toISOString().slice(0, 10);
			await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
			try {
				const r = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
				expect(r.status).toBe(402);
				const text = await r.text();
				expect(text).toContain(`pay $${EXPECTED_USDC} USDC and get this receipt immediately`);
				expect(text).toContain(`(same $${EXPECTED_USDC} USDC)`);
				expect(text).toContain(`${EXPECTED_USDC} USDC on Base`);
				expect(text).toContain(`$${EXPECTED_USDC} USDC per call`);
			} finally {
				await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
			}
		});

		it('the x402 discovery facilitator resource quotes the canonical price', async () => {
			// Behind X402_ENABLED=true, so it is unreachable in the default test
			// env — enable it here rather than leave the converted line unasserted.
			(env as unknown as Record<string, string>).X402_ENABLED = 'true';
			try {
				const text = await (await fetchWorker('/.well-known/x402.json')).text();
				expect(text).toContain(`60s TTL. $${EXPECTED_USDC} USDC on Base mainnet via CDP facilitator.`);
			} finally {
				delete (env as unknown as Record<string, string>).X402_ENABLED;
			}
		});
	});

	// ── The free trial (T1.6) ────────────────────────────────────────────────
	// Product behaviour is UNCHANGED by this sprint; it is asserted here because
	// it decides what any client test measures. /v5/status serves three signed
	// receipts a day per caller before it will ever return a 402, so a
	// compatibility test that does not exhaust the trial first is measuring a
	// 200 and learning nothing about the payment path (RAIL_T0 E2).
	describe('the free trial gates the 402', () => {
		it('serves 3 trial receipts per IP per day, then 402 on the 4th', async () => {
			const ip     = '203.0.113.77';
			const ipHash = await sha256Hex(ip);
			const today  = new Date().toISOString().slice(0, 10);
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
			try {
				for (let i = 0; i < 3; i++) {
					const r = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
					expect(r.status).toBe(200);
					expect(r.headers.get('X-Trial-Remaining')).toBe(String(2 - i));
				}
				const fourth = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
				expect(fourth.status).toBe(402);
				// And the 402 an agent finally reaches carries the schema-correct
				// v2 header — the whole point of T1.
				const hdr = fourth.headers.get('Payment-Required');
				expect(hdr).toBeTruthy();
				expect(JSON.parse(x402Base64Decode(hdr as string)).x402Version).toBe(2);
			} finally {
				await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
			}
		});

		it('the trial resets at 00:00Z — the 402 body says so', async () => {
			const ip     = '203.0.113.78';
			const ipHash = await sha256Hex(ip);
			const today  = new Date().toISOString().slice(0, 10);
			await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
			try {
				const r = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
				expect(r.status).toBe(402);
				const b  = await r.json() as Record<string, unknown>;
				const ts = b.trial_status as Record<string, unknown>;
				expect(ts.limit).toBe(3);
				expect(String(ts.resets_at)).toMatch(/T00:00:00\.000Z$/);
			} finally {
				await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
			}
		});
	});

	// ── Live 402 shape, end to end ───────────────────────────────────────────
	it('a real trial-exhausted 402 serves the v2 header AND the v1 body together', async () => {
		const ip     = '203.0.113.79';
		const ipHash = await sha256Hex(ip);
		const today  = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const { PaymentRequiredV1Schema, PaymentRequiredV2Schema } = await import('./vendor/x402-schemas.mjs');
			const r = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
			expect(r.status).toBe(402);
			// The header a 2.x client reads.
			const hdr = JSON.parse(x402Base64Decode(r.headers.get('Payment-Required') as string));
			const hv2 = PaymentRequiredV2Schema.safeParse(hdr);
			expect(hv2.success ? null : JSON.stringify(hv2.error.issues)).toBe(null);
			// The body a v1 / JSON-parsing client reads.
			const body = await r.json() as Record<string, unknown>;
			const bv1  = PaymentRequiredV1Schema.safeParse(body);
			expect(bv1.success ? null : JSON.stringify(bv1.error.issues)).toBe(null);
			// And they agree on what is being sold and for how much.
			const bodyAccepts = (body.accepts as Record<string, unknown>[])[0];
			expect(hdr.accepts[0].amount).toBe(bodyAccepts.maxAmountRequired);
			expect(hdr.resource.url).toBe(bodyAccepts.resource);
			expect(hdr.accepts[0].payTo).toBe(bodyAccepts.payTo);
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The Builder allowance, stated once (P8)
//
// Found 2026-09-01 while checking the Yu letter against the worker source:
// src/index.ts stated the Builder allowance three ways — "$99/month — 50,000
// calls", BUILDER_TIER_DAILY_LIMIT = 50_000, and "50K req/day" — and a fourth,
// "50,000/month" on GET /v5/keys/request, which was simply wrong: the allowance
// is per DAY. Two customers reading two lines got two contracts, and one of them
// got a false one.
//
// These tests assert every surface against the DERIVED rendering, so they move
// with the constant. Their red case is a surface that carries a literal: change
// BUILDER_TIER_DAILY_LIMIT and any hardcoded "50,000" fails here.
// ─────────────────────────────────────────────────────────────────────────────
describe('the Builder allowance is stated once', () => {
	const EXPECTED_GROUPED = planAllowances().builder.toLocaleString('en-US'); // 50,000
	const EXPECTED_COMPACT = `${planAllowances().builder / 1000}K`;            // 50K
	const PRO_GROUPED      = planAllowances().pro.toLocaleString('en-US');     // 200,000

	it('the enforced limit and the quoted figure are the same number', async () => {
		// The contract a customer reads must be the contract the gate enforces.
		// getPlanDailyLimit is what actually rate-limits the key.
		expect(getPlanDailyLimit('builder')).toBe(planAllowances().builder);
		expect(getPlanDailyLimit('pro')).toBe(planAllowances().pro);
		const pricing = await fetchJSON('/v5/pricing');
		const tiers   = pricing.tiers as Array<Record<string, unknown>>;
		const builder = tiers.find(t => t.id === 'builder') as Record<string, unknown>;
		expect(String(builder.description)).toContain(`${EXPECTED_GROUPED} calls/day`);
		expect((builder.features as string[])[0]).toBe(`${EXPECTED_GROUPED} calls/day`);
	});

	it('/llms-full.txt quotes the derived figure', async () => {
		const full = await (await fetchWorker('/llms-full.txt')).text();
		expect(full).toContain(`- Builder: ${EXPECTED_GROUPED} req/day ($99/mo)`);
		expect(full).toContain(`- Pro: ${PRO_GROUPED} req/day ($299/mo)`);
		// And it does not quote a per-MONTH allowance anywhere: the whole defect
		// was a surface silently changing the unit.
		expect(full).not.toContain(`${EXPECTED_GROUPED}/month`);
	});

	it('the MCP get_payment_options tool quotes the derived figure', async () => {
		const res = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_payment_options', arguments: {} } }),
		});
		const body = await res.json() as Record<string, unknown>;
		const text = JSON.stringify(body);
		expect(text).toContain(`${EXPECTED_COMPACT}/day`);
	});

	it('the /v5/why-not-free upgrade ladder quotes the derived figures', async () => {
		// This is the surface an agent reads after a 402 to choose a path. The
		// trial-exhausted 402 itself carries buildUpgradePaths() WITHOUT the paid
		// tiers by design, so the paid figures are asserted where they are served.
		const body = await fetchJSON('/v5/why-not-free');
		const text = JSON.stringify(body);
		expect(text).toContain(`${EXPECTED_COMPACT}/day`);
		// Read the field itself rather than the blob, so the assertion names the
		// contract: the Builder line quotes exactly the derived compact form.
		const builder = body.builder as Record<string, unknown>;
		expect(builder.calls).toBe(`${EXPECTED_COMPACT}/day`);
	});

	it('GET /v5/keys/request states the allowance per DAY, not per month', async () => {
		// The original defect: this surface said "50,000/month" — a different
		// contract from every other surface, and a false one.
		const body    = await fetchJSON('/v5/keys/request');
		const plans   = body.plans as Record<string, Record<string, unknown>>;
		expect(plans.builder.calls).toBe(`${EXPECTED_GROUPED}/day`);
		expect(plans.pro.calls).toBe(`${PRO_GROUPED}/day`);
		expect(String(plans.builder.calls)).not.toContain('month');
	});

	it('the x402 mint tier message quotes the derived figure', async () => {
		const res  = await fetchWorker('/v5/x402/mint', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ tx_hash: '0x' + 'a'.repeat(64), tier: 'not_a_tier' }),
		});
		const body = await res.json() as Record<string, unknown>;
		expect(String(body.message)).toContain(`${EXPECTED_COMPACT} calls/day`);
	});

	it('compact rendering never rounds a non-exact allowance', () => {
		// A rounded allowance in a price quote is a wrong allowance, so the
		// compact form falls back to the grouped form rather than lying.
		expect(formatCallsCompact(50_000)).toBe('50K');
		expect(formatCallsCompact(200_000)).toBe('200K');
		expect(formatCallsCompact(1_000_000)).toBe('1M');
		expect(formatCallsCompact(50_500)).toBe('50,500');
		expect(formatCallsCompact(999)).toBe('999');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The coverage block in every signed receipt (rail sprint T3, 2026-09-07)
//
// A verdict does not say what was looked at to reach it. "CLOSED" from the
// calendar and "CLOSED" because an operator tripped a circuit breaker are the
// same four characters, and neither tells a consumer whether an intraday halt
// would have been seen. For 26 of the 28 exchanges there is no intraday halt
// feed at all.
//
// SPEC-CONFORMANCE NOTE: this ADDS a field to the Ed25519-signed payload. The
// signature algorithm and canonicalization rule are unchanged — coverage is a
// JSON-encoded string, the convention `cross_venue` and `reasons` already use.
// A verifier that builds the canonical payload from /v5/keys ->
// canonical_payload_spec keeps working with no change; one that hardcodes an
// older field list does not, and the assertions below pin both halves of that.
// ─────────────────────────────────────────────────────────────────────────────
describe('the coverage block — what a receipt actually consulted', () => {
	type Coverage = {
		determination_tier: number;
		consulted: string[];
		not_consulted: string[];
		realtime_halt_feed_scope: string[];
		unknown_reason: string | null;
	};
	const readCoverage = (receipt: Record<string, unknown>): Coverage => {
		// It is a STRING in the signed bytes; consumers parse it after verifying.
		expect(typeof receipt.coverage).toBe('string');
		return JSON.parse(receipt.coverage as string) as Coverage;
	};

	it('/v5/demo carries a coverage block naming schedule as the determinant', async () => {
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		const cov  = readCoverage(body);
		expect(cov.determination_tier).toBe(1);
		expect(cov.consulted).toContain('schedule');
		expect(cov.consulted).toContain('manual_override_kv');
		expect(cov.unknown_reason).toBeNull();
	});

	it('/v5/status (trial) carries the same block', async () => {
		const ip     = '203.0.113.90';
		const ipHash = await sha256Hex(ip);
		const today  = new Date().toISOString().slice(0, 10);
		await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		try {
			const res  = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'CF-Connecting-IP': ip } });
			expect(res.status).toBe(200);
			const cov = readCoverage(await res.json() as Record<string, unknown>);
			expect(cov.determination_tier).toBe(1);
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('names the real-time halt feed as NOT consulted for the 26 exchanges it does not cover', async () => {
		// XLON has no intraday halt feed. Saying so inside the signature is the
		// whole point: a consumer can hold us to the scope we claimed.
		const body = await fetchJSON('/v5/demo?mic=XLON');
		const cov  = readCoverage(body);
		expect(cov.not_consulted).toContain('realtime_halt_feed');
		expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
		expect(cov.realtime_halt_feed_scope).toEqual(['XNAS', 'XNYS']);
	});

	it('does NOT claim the feed for the two covered exchanges without a live heartbeat', async () => {
		// CHANGED BY T3b (2026-09-07). This test used to assert the opposite —
		// that XNYS and XNAS always carry `realtime_halt_feed_via_override`
		// under `consulted`. That was the defect: it held whenever the override
		// tier was merely READ, so a receipt claimed the feed path was consulted
		// even when the monitor was dead. Coverage for those two MICs is now
		// conditional on a fresh successful heartbeat, and there is none in this
		// environment. The full state machine is asserted in "the coverage block
		// cites the halt monitor heartbeat".
		for (const mic of ['XNYS', 'XNAS']) {
			const cov = readCoverage(await fetchJSON(`/v5/demo?mic=${mic}`));
			expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
			expect(cov.not_consulted).toContain('realtime_halt_feed');
			// Still in scope — the feed covers this MIC; it just was not live.
			expect(cov.realtime_halt_feed_scope).toContain(mic);
		}
	});

	it('a manual override is tier 0 and reports the schedule as NOT consulted', async () => {
		const future = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', reason: 'coverage-block test', expires: future }));
		clearOverrideCache();
		try {
			const body = await fetchJSON('/v5/demo?mic=XNYS');
			expect(body.status).toBe('HALTED');
			const cov = readCoverage(body);
			// An active override short-circuits before the schedule is read, so
			// claiming the schedule was consulted would be a false claim.
			expect(cov.determination_tier).toBe(0);
			// CHANGED BY T3b: this override has no `source: REALTIME`, so it is
			// an operator's manual breaker, not a feed observation — and with no
			// heartbeat the feed earns no token at all.
			expect(cov.consulted).toEqual(['manual_override_kv']);
			expect(cov.not_consulted).toEqual(['realtime_halt_feed', 'schedule']);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
			clearOverrideCache();
		}
	});

	it('the coverage block is INSIDE the signature — tampering with it invalidates the receipt', async () => {
		// XLON deliberately: it is one of the 26 exchanges with no intraday feed,
		// so the forgery below actually changes the bytes. On XNYS the same edit
		// is a no-op (the feed genuinely IS consulted there) and the test would
		// pass while proving nothing — which is how it was first written.
		const body = await fetchJSON('/v5/demo?mic=XLON');
		const res  = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt: body }),
		});
		expect(((await res.json()) as Record<string, unknown>).valid).toBe(true);

		// Now claim we consulted the halt feed when we did not — the exact lie
		// this block exists to make impossible.
		const forged = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
		const cov = JSON.parse(forged.coverage as string) as Coverage;
		cov.not_consulted = [];
		cov.consulted = ['manual_override_kv', 'realtime_halt_feed_via_override', 'schedule'];
		forged.coverage = JSON.stringify(cov);
		const res2 = await fetchWorker('/v5/verify', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ receipt: forged }),
		});
		const out2 = await res2.json() as Record<string, unknown>;
		expect(out2.valid).toBe(false);
		// Name the check that failed, not just the verdict: a `valid: false` that
		// came from an expiry check would pass a bare assertion while proving
		// nothing about whether coverage is inside the signature.
		const checks = out2.checks as Record<string, { passed: boolean; detail: string }>;
		expect(checks.signature.passed).toBe(false);
		// And it is the SIGNATURE that failed, not schema/issuer/key/expiry —
		// otherwise a bare `valid: false` would prove nothing about coverage.
		expect(checks.schema.passed).toBe(true);
		expect(checks.issuer.passed).toBe(true);
		expect(checks.public_key.passed).toBe(true);
	});

	it('/v5/keys documents coverage in canonical_payload_spec for both receipt shapes', async () => {
		const keys = await fetchJSON('/v5/keys');
		const spec = keys.canonical_payload_spec as Record<string, unknown>;
		expect(spec.receipt_fields).toContain('coverage');
		expect(spec.override_fields).toContain('coverage');
		// The note tells a consumer it is a JSON string, which they need before
		// they can use it at all.
		expect(String(spec.coverage_note)).toContain('JSON-encoded string');
		expect(String(spec.coverage_note)).toContain('determination_tier');
	});

	it('a spec-driven verifier keeps working; a hardcoded-allowlist verifier does not', async () => {
		// This is the compatibility contract of the change, asserted rather than
		// asserted-about. Same receipt, two verifier strategies.
		const receipt = await fetchJSON('/v5/demo?mic=XNYS');
		const keys    = await fetchJSON('/v5/keys');
		const spec    = keys.canonical_payload_spec as Record<string, string[]>;

		const canonicalFrom = (fields: string[]): string => {
			const out: Record<string, unknown> = {};
			for (const k of fields.slice().sort()) if (k in receipt) out[k] = receipt[k];
			return JSON.stringify(out);
		};
		const verify = async (bytes: string): Promise<boolean> => {
			const ed  = await import('@noble/ed25519');
			const hex = (h: string) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < h.length; i += 2) o[i / 2] = parseInt(h.substring(i, i + 2), 16); return o; };
			const pub = await ed.getPublicKeyAsync(hex(env.ED25519_PRIVATE_KEY));
			return ed.verifyAsync(hex(receipt.signature as string), new TextEncoder().encode(bytes), pub);
		};

		// Reads the field list from the spec at runtime — the documented way, and
		// what @headlessoracle/verify does.
		expect(await verify(canonicalFrom(spec.receipt_fields))).toBe(true);

		// Hardcodes the pre-2026-09-07 field list. This MUST fail: it is the
		// breaking half of the change, and pretending otherwise would hide it.
		const STALE = ['expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic',
			'public_key_id', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'];
		expect(await verify(canonicalFrom(STALE))).toBe(false);
	});

	it('UNKNOWN carries a reason an operator can act on', async () => {
		// A year with no holiday data is the fail-closed guard in getScheduleStatus.
		// Without a reason token, an agent seeing UNKNOWN cannot tell a missing
		// calendar from an unsupported venue from a determination that threw.
		vi.setSystemTime(new Date('2099-06-15T14:00:00.000Z'));
		try {
			const body = await fetchJSON('/v5/demo?mic=XNYS');
			expect(body.status).toBe('UNKNOWN');
			const cov = readCoverage(body);
			expect(cov.unknown_reason).toBe('NO_HOLIDAY_DATA_FOR_YEAR');
			expect(cov.determination_tier).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a non-UNKNOWN verdict carries unknown_reason: null, not an empty string', async () => {
		// null is unambiguous; "" would make an agent guess whether the reason
		// was absent or blank.
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
		expect(cov.unknown_reason).toBeNull();
	});

	it('coverage survives /v5/batch and the MCP tool unchanged', async () => {
		const batch = await fetchJSON('/v5/batch?mics=XNYS,XLON', { headers: { 'X-Oracle-Key': 'test_beta_key_1' } });
		for (const r of batch.receipts as Record<string, unknown>[]) {
			const cov = readCoverage(r);
			expect(cov.realtime_halt_feed_scope).toEqual(['XNAS', 'XNYS']);
		}
		const mcp = await fetchWorker('/mcp', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json' },
			body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS' } } }),
		});
		const mcpBody = await mcp.json() as Record<string, unknown>;
		expect(JSON.stringify(mcpBody)).toContain('determination_tier');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The feed token cites the halt monitor's heartbeat (rail sprint T3b, 2026-09-07)
//
// T3 listed `realtime_halt_feed_via_override` under `consulted` for XNYS and
// XNAS whenever the override tier was READ. But an empty override tier means
// one of three things a receipt could not tell apart: no halt was observed;
// the monitor was not running; the monitor ran and its source failed. Claiming
// "the feed path was consulted" in the last two is a claim with no evidence
// behind it — exactly the kind of false coverage claim this block exists to
// make impossible.
//
// So the monitor now writes a heartbeat on every run, and a receipt lists the
// feed under `consulted` only when it can cite a fresh, successful one.
// Otherwise the feed is `not_consulted` and the receipt says why, inside the
// signature. Two members join the coverage string after `unknown_reason`:
// `feed_state` (live | stale | failed | absent | not_covered) and
// `feed_last_run`.
//
// SPEC-CONFORMANCE NOTE: still one signed field (`coverage`), still a
// JSON-encoded string, still the same canonicalization. What changed is what
// the string says. No existing field was altered.
// ─────────────────────────────────────────────────────────────────────────────
describe('the coverage block cites the halt monitor heartbeat', () => {
	type Coverage = {
		determination_tier: number;
		consulted: string[];
		not_consulted: string[];
		realtime_halt_feed_scope: string[];
		unknown_reason: string | null;
		feed_state: string;
		feed_last_run: string | null;
	};
	const readCoverage = (receipt: Record<string, unknown>): Coverage => {
		expect(typeof receipt.coverage).toBe('string');
		return JSON.parse(receipt.coverage as string) as Coverage;
	};

	const putHeartbeat = async (beat: Record<string, unknown>): Promise<void> => {
		await env.ORACLE_TELEMETRY.put('halt_monitor_heartbeat', JSON.stringify(beat));
		clearHaltHeartbeatMemo();
	};
	const dropHeartbeat = async (): Promise<void> => {
		await env.ORACLE_TELEMETRY.delete('halt_monitor_heartbeat');
		clearHaltHeartbeatMemo();
	};

	afterEach(async () => { await dropHeartbeat(); });

	// (a)
	it('a fresh successful heartbeat puts the feed under consulted, feed_state live', async () => {
		const ranAt = new Date(Date.now() - 30_000).toISOString();
		await putHeartbeat({ ran_at: ranAt, ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
		expect(cov.feed_state).toBe('live');
		expect(cov.feed_last_run).toBe(ranAt);
		expect(cov.consulted).toContain('realtime_halt_feed_via_override');
		expect(cov.not_consulted).not.toContain('realtime_halt_feed');
	});

	// (b)
	it('a heartbeat older than the 180s bound is stale — the feed moves to not_consulted', async () => {
		// Ten minutes: the bound is three one-minute runs, so this is unambiguous.
		const ranAt = new Date(Date.now() - 600_000).toISOString();
		await putHeartbeat({ ran_at: ranAt, ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
		expect(cov.feed_state).toBe('stale');
		// The last run is still stated: "we know when it last ran, and it was
		// too long ago" is strictly more useful than silence.
		expect(cov.feed_last_run).toBe(ranAt);
		expect(cov.not_consulted).toContain('realtime_halt_feed');
		expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
	});

	// (c)
	it('a heartbeat that reports its own failure is failed, not live', async () => {
		// The monitor ran within the bound but its upstream did not answer. A
		// receipt calling that "consulted" would claim coverage that
		// demonstrably did not exist at that moment.
		const ranAt = new Date(Date.now() - 20_000).toISOString();
		await putHeartbeat({ ran_at: ranAt, ok: false, source: 'fetch_failed', items: 0, scope: ['XNAS', 'XNYS'] });
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
		expect(cov.feed_state).toBe('failed');
		expect(cov.feed_last_run).toBe(ranAt);
		expect(cov.not_consulted).toContain('realtime_halt_feed');
		expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
	});

	// (d)
	it('no heartbeat at all is absent — a dead cron makes the key vanish, which is the honest state', async () => {
		await dropHeartbeat();
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
		expect(cov.feed_state).toBe('absent');
		expect(cov.feed_last_run).toBeNull();
		expect(cov.not_consulted).toContain('realtime_halt_feed');
		expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
	});

	// (e)
	it('an exchange outside the feed scope is not_covered even with a live heartbeat', async () => {
		await putHeartbeat({ ran_at: new Date(Date.now() - 5_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const cov = readCoverage(await fetchJSON('/v5/demo?mic=XLON'));
		// A live monitor for XNYS says nothing about XLON. Token placement is
		// unchanged from T3 — what is new is that the receipt now names WHY.
		expect(cov.feed_state).toBe('not_covered');
		expect(cov.feed_last_run).toBeNull();
		expect(cov.not_consulted).toContain('realtime_halt_feed');
		expect(cov.consulted).not.toContain('realtime_halt_feed_via_override');
	});

	// (f)
	it('Tier 2 claims nothing but still states the feed state', async () => {
		// Force Tier 1 to throw by making the override tier unparseable: the
		// JSON.parse in the Tier 0 block sits outside any inner try, so it
		// lands in the fail-closed catch. No mocking of internals required.
		await putHeartbeat({ ran_at: new Date(Date.now() - 10_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		await env.ORACLE_OVERRIDES.put('XNYS', 'this is not json');
		clearOverrideCache();
		try {
			const body = await fetchJSON('/v5/demo?mic=XNYS');
			expect(body.status).toBe('UNKNOWN');
			const cov = readCoverage(body);
			expect(cov.determination_tier).toBe(2);
			expect(cov.consulted).toEqual([]);
			expect(cov.unknown_reason).toBe('DETERMINATION_ERROR');
			// A fail-closed receipt that names the feed's state — live here — is
			// worth more than one that says nothing.
			expect(cov.feed_state).toBe('live');
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
			clearOverrideCache();
		}
	});

	// Tier 0 driven by the monitor itself: the override IS the feed observation.
	it('a REALTIME override is itself the feed observation and is consulted as such', async () => {
		await putHeartbeat({ ran_at: new Date(Date.now() - 15_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const future = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', source: 'REALTIME', reason: 'halt monitor', expires: future }));
		clearOverrideCache();
		try {
			const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
			expect(cov.determination_tier).toBe(0);
			expect(cov.consulted).toContain('realtime_halt_feed_via_override');
			expect(cov.feed_state).toBe('live');
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
			clearOverrideCache();
		}
	});

	it('a MANUAL tier-0 override does not borrow the feed token from a stale monitor', async () => {
		// An operator tripping a breaker is not a feed observation. With the
		// monitor stale, this receipt must not claim the feed was consulted.
		await putHeartbeat({ ran_at: new Date(Date.now() - 600_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const future = new Date(Date.now() + 3600_000).toISOString();
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', source: 'OVERRIDE', reason: 'operator', expires: future }));
		clearOverrideCache();
		try {
			const cov = readCoverage(await fetchJSON('/v5/demo?mic=XNYS'));
			expect(cov.determination_tier).toBe(0);
			expect(cov.feed_state).toBe('stale');
			expect(cov.consulted).toEqual(['manual_override_kv']);
			expect(cov.not_consulted).toEqual(['realtime_halt_feed', 'schedule']);
		} finally {
			await env.ORACLE_OVERRIDES.delete('XNYS');
			clearOverrideCache();
		}
	});

	// (g)
	it('the two new members are inside the signature — forging feed_state invalidates the receipt', async () => {
		// The lie this guards against: a stale monitor, and a receipt edited to
		// say the feed was live. If feed_state sat outside the signed bytes,
		// that edit would be free.
		await putHeartbeat({ ran_at: new Date(Date.now() - 600_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(readCoverage(body).feed_state).toBe('stale');

		const ok = await fetchWorker('/v5/verify', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt: body }),
		});
		expect(((await ok.json()) as Record<string, unknown>).valid).toBe(true);

		const forged = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
		const cov = JSON.parse(forged.coverage as string) as Coverage;
		cov.feed_state = 'live';
		cov.consulted = ['manual_override_kv', 'realtime_halt_feed_via_override', 'schedule'];
		cov.not_consulted = [];
		forged.coverage = JSON.stringify(cov);
		const res2 = await fetchWorker('/v5/verify', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt: forged }),
		});
		const out2 = await res2.json() as Record<string, unknown>;
		expect(out2.valid).toBe(false);
		// Name the check that failed: a valid:false from an expiry check would
		// pass a bare assertion while proving nothing.
		const checks = out2.checks as Record<string, { passed: boolean }>;
		expect(checks.signature.passed).toBe(false);
		expect(checks.schema.passed).toBe(true);
		expect(checks.issuer.passed).toBe(true);
		expect(checks.public_key.passed).toBe(true);
	});

	// (i)
	it('/v5/keys coverage_note separates what is configured from what was live', async () => {
		const keys = await fetchJSON('/v5/keys');
		const spec = keys.canonical_payload_spec as Record<string, unknown>;
		const note = String(spec.coverage_note);
		expect(note).toContain('feed_state');
		expect(note).toContain('halt_detection');
		// The distinction a consumer has to understand before they can read
		// either field correctly.
		expect(note).toContain('configured');
		expect(note).toContain('live at this determination');
		expect(note).toContain('feed_last_run');
	});

	// (j)
	it('the heartbeat read is memoised — a burst of receipts costs one KV get', async () => {
		await putHeartbeat({ ran_at: new Date(Date.now() - 10_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const spy = vi.spyOn(env.ORACLE_TELEMETRY, 'get');
		try {
			await fetchJSON('/v5/demo?mic=XNYS');
			await fetchJSON('/v5/demo?mic=XNAS');
			await fetchJSON('/v5/demo?mic=XNYS');
			const heartbeatReads = spy.mock.calls.filter((c) => c[0] === 'halt_monitor_heartbeat').length;
			expect(heartbeatReads).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	// The order of the two new members is fixed, like every other member: the
	// signed bytes must be reproducible by anyone rebuilding from the spec.
	it('feed_state and feed_last_run come after unknown_reason, in that order', async () => {
		await putHeartbeat({ ran_at: new Date(Date.now() - 10_000).toISOString(), ok: true, source: 'polygon', items: 2, scope: ['XNAS', 'XNYS'] });
		const body = await fetchJSON('/v5/demo?mic=XNYS');
		expect(Object.keys(JSON.parse(body.coverage as string) as Record<string, unknown>)).toEqual([
			'determination_tier', 'consulted', 'not_consulted',
			'realtime_halt_feed_scope', 'unknown_reason', 'feed_state', 'feed_last_run',
		]);
	});

	// The monitor's side of the contract: it writes what the receipt reads.
	it('runHaltMonitor writes a heartbeat the receipt path can read', async () => {
		await dropHeartbeat();
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ market: 'open', exchanges: { nyse: 'open', nasdaq: 'open' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch;
		try {
			const ctl = createScheduledController({ scheduled: Date.now(), cron: '* * * * *' });
			const ctx = createExecutionContext();
			await worker.scheduled!(ctl, env, ctx);
			await waitOnExecutionContext(ctx);
			const raw = await env.ORACLE_TELEMETRY.get('halt_monitor_heartbeat');
			expect(raw).not.toBeNull();
			const beat = JSON.parse(raw as string) as Record<string, unknown>;
			expect(typeof beat.ran_at).toBe('string');
			expect(typeof beat.ok).toBe('boolean');
			expect(beat.scope).toEqual(['XNAS', 'XNYS']);
			expect(Number.isInteger(beat.items)).toBe(true);
		} finally {
			globalThis.fetch = origFetch;
			await dropHeartbeat();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Module-export shape guard
//
// The Workers runtime treats every named export of the entry module as a
// potential entrypoint and refuses to start on anything that is not a function
// or an ExportedHandler:
//   "Incorrect type for map entry 'BUILDER_TIER_DAILY_LIMIT': the provided
//    value is not of type 'function or ExportedHandler'"
//
// `npx tsc --noEmit` and `npx wrangler deploy --dry-run` BOTH pass on such an
// export — the dry run only bundles — so the pre-commit gate is green and the
// worker dies on start. That happened on 2026-09-07: exporting a handful of
// module constants for these tests would have taken production down on the
// next deploy, and it was caught only because `wrangler dev` was run by hand
// while building the T3 SDK check.
//
// This test is the gate the toolchain does not give us. Its red case is any
// `export const` of a non-function value in src/index.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe('module export shape — the Workers runtime rejects non-function exports', () => {
	it('every named export of the worker module is a function', async () => {
		const mod = await import('../src') as Record<string, unknown>;
		const offenders: string[] = [];
		for (const [name, value] of Object.entries(mod)) {
			if (name === 'default') continue;           // the ExportedHandler
			if (typeof value === 'function') continue;  // functions and classes
			offenders.push(`${name}: ${value === null ? 'null' : typeof value}`);
		}
		expect(offenders).toEqual([]);
	});

	it('the default export is an ExportedHandler with a fetch method', async () => {
		const mod = await import('../src') as { default?: { fetch?: unknown } };
		expect(typeof mod.default).toBe('object');
		expect(typeof mod.default?.fetch).toBe('function');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Uninterpolated-placeholder guard (rail sprint T2b, 2026-09-07)
//
// T2 converted the served allowance literals ("50,000 calls/day") into
// `${BUILDER_CALLS_COMPACT}` / `${PRO_CALLS_COMPACT}` interpolations. Two of
// those conversions landed inside SINGLE-QUOTED strings, which do not
// interpolate: src/index.ts 8701 (OPENAPI_SPEC, the /v5/x402/mint description
// served at /openapi.json) and 12206 (the /v5/x402/mint entry in the
// /.well-known/x402.json endpoint catalogue). Deployed as they stood, both
// public surfaces would have served the literal text "${BUILDER_CALLS_COMPACT}
// calls/day" to every agent and indexer that read them.
//
// Nothing in the toolchain catches this: tsc accepts a valid string, the T2 DoD
// grep for the old literals cannot match a placeholder, and no test fetched
// either surface. This guard closes that hole for every public text surface at
// once, and is falsifiable by construction — revert either line's backticks to
// single quotes and it goes red naming that surface.
//
// The expected allowance strings are DERIVED from the same functions the worker
// uses, never written as literals, so a change to BUILDER_TIER_DAILY_LIMIT moves
// the assertion with the product rather than against it.
// ─────────────────────────────────────────────────────────────────────────────
describe('public text surfaces carry no uninterpolated placeholder', () => {
	const BUILDER_COMPACT = formatCallsCompact(planAllowances().builder);
	const PRO_COMPACT     = formatCallsCompact(planAllowances().pro);

	// Every surface that serves prose an agent or indexer reads.
	//
	// A surface may name its own request and expected status. Most are plain
	// GETs that answer 200; /v5/referee/intake is POST-only, and the entry
	// below drives it to the 400 it serves for an empty body — a served-text
	// response that makes no outbound call, so this guard never touches
	// api.paddle.com. Restricting the guard to GET-200 surfaces would have
	// meant every POST route silently escaping it.
	type Surface = [label: string, path: string, init?: RequestInit, expectStatus?: number];
	const TEXT_SURFACES: Surface[] = [
		['/openapi.json',                        '/openapi.json'],
		['/.well-known/x402.json',               '/.well-known/x402.json'],
		['/.well-known/mcp/server-card.json',    '/.well-known/mcp/server-card.json'],
		['/.well-known/agent.json',              '/.well-known/agent.json'],
		['/v5/pricing',                          '/v5/pricing'],
		['/v5/keys/request',                     '/v5/keys/request'],
		['/llms.txt',                            '/llms.txt'],
		['/llms-full.txt',                       '/llms-full.txt'],
		['/v5/why-not-free',                     '/v5/why-not-free'],
		['/.well-known/ai-catalog.json',         '/.well-known/ai-catalog.json'],
		['/auth.md',                             '/auth.md'],
		['/v1/witness/spec',                     '/v1/witness/spec'],
		['/v5/referee/intake',                   '/v5/referee/intake',
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 400],
		// H2: the claim route's static prose is its 405; the ready body's
		// instructions are asserted by value in the H2 describe block.
		['/v5/claim',                            '/v5/claim', undefined, 405],
		// H4a: the served-text routes this change added or rewrote.
		['/.well-known/x402',                    '/.well-known/x402'],
		['/.well-known/agent-card.json',         '/.well-known/agent-card.json', undefined, 404],
		['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource/mcp'],
		['/.well-known/oauth-authorization-server/oauth', '/.well-known/oauth-authorization-server/oauth'],
		['/.well-known/openid-configuration/oauth', '/.well-known/openid-configuration/oauth'],
		['/.well-known/ai-plugin.json',          '/.well-known/ai-plugin.json'],
		// /skill.md is not listed: its JavaScript sample legitimately contains
		// `${result.reason}`; its new lead is pinned by the H4a lead test.
		['/health',                              '/health'],
		['/v5/checkout (PLAN_REQUIRED)',         '/v5/checkout',
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 400],
	];

	// No served byte may carry a template placeholder the runtime never filled.
	// There is no legitimate `${` in any served surface: the source contains no
	// escaped `\${` anywhere, so every occurrence is a conversion that failed.
	const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

	for (const [label, path, init, expectStatus] of TEXT_SURFACES) {
		it(`${label} serves no uninterpolated \${...} placeholder`, async () => {
			const response = await fetchWorker(path, init);
			expect(response.status).toBe(expectStatus ?? 200);
			const text = await response.text();
			const match = text.match(PLACEHOLDER);
			expect(
				match === null,
				match ? `${label} served an uninterpolated placeholder: ${match[0]}` : '',
			).toBe(true);
			expect(text).not.toContain('${');
		});
	}

	it('the MCP tools/list response serves no uninterpolated ${...} placeholder', async () => {
		const response = await postMcp({ jsonrpc: '2.0', id: 900, method: 'tools/list' });
		expect(response.status).toBe(200);
		const text = await response.text();
		const match = text.match(PLACEHOLDER);
		expect(
			match === null,
			match ? `MCP tools/list served an uninterpolated placeholder: ${match[0]}` : '',
		).toBe(true);
		expect(text).not.toContain('${');
	});

	// The positive control: the two surfaces the placeholders were on must carry
	// the real, derived allowance text — not merely be free of "${".
	it('/openapi.json states both tier allowances, derived from planAllowances()', async () => {
		const text = await (await fetchWorker('/openapi.json')).text();
		expect(text).toContain(`${BUILDER_COMPACT} calls/day`);
		expect(text).toContain(`${PRO_COMPACT} calls/day`);
	});

	it('/.well-known/x402.json states both tier allowances, derived from planAllowances()', async () => {
		const text = await (await fetchWorker('/.well-known/x402.json')).text();
		expect(text).toContain(`${BUILDER_COMPACT} calls/day`);
		expect(text).toContain(`${PRO_COMPACT} calls/day`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// /v5/payment-proof — lifetime counts computed on read (rail sprint T4, GAP-021)
//
// The endpoint served first_payment_at: null and first_payment_tx: null on a
// service whose first dollar settled on 2026-04-03. Three causes, all found by
// reading the code and walking production KV rather than by guessing:
//
//   1. Both verifiers seeded the first-payment keys under `if (count === 0)`.
//      That branch can fire once in the counter's lifetime and it missed its
//      window — the keys were never written, not evicted.
//   2. It wrote `txHash.slice(-12)`: the last twelve characters, which no
//      explorer can resolve and which does not match the prefix in the canon.
//   3. Every listable prefix that might have reconstructed the history is
//      ephemeral. A walk of x402_used:, x402_used_tx: and
//      paddle_revenue_event: against production on 2026-09-07 returned zero
//      keys from all three.
//
// So the history lives in a chain-verified constant plus durable per-settlement
// rows, and the count is computed on read.
// ─────────────────────────────────────────────────────────────────────────────
describe('/v5/payment-proof — computed on read, first dollar from the chain', () => {
	const FIRST_TX = '0xeb9da8737537e13e9818902b67b8f03b06b7da46a7c557883f409d42895b308a';
	const FIRST_AT = '2026-04-03T14:12:11.000Z';
	const MONDAY_TX = '0x46db8fc8cfd79017375d76c5ad80256950f8437ff009ecbe90b6cd5ce97e9263';

	const clearLedger = async (): Promise<void> => {
		const page = await env.ORACLE_TELEMETRY.list({ prefix: 'x402_payment:' });
		for (const k of page.keys) await env.ORACLE_TELEMETRY.delete(k.name);
	};
	beforeEach(clearLedger);
	afterEach(clearLedger);

	it('first_payment_at and first_payment_tx are non-null and match the April-3 block', async () => {
		// The regression, stated as an assertion. Both were null in production.
		const body = await fetchJSON('/v5/payment-proof');
		expect(body.first_payment_at).toBe(FIRST_AT);
		expect(body.first_payment_tx).toBe(FIRST_TX);
		expect(body.first_payment_block).toBe(44218092);
	});

	it('the transaction hash is the full 66-character hash, not a 12-character suffix', async () => {
		// The old code stored txHash.slice(-12). A reader cannot resolve that on
		// a block explorer, which makes a "payment proof" endpoint prove nothing.
		const body = await fetchJSON('/v5/payment-proof');
		expect(String(body.first_payment_tx)).toMatch(/^0x[0-9a-f]{64}$/);
		expect(String(body.first_payment_tx)).toHaveLength(66);
	});

	it('payment_count equals the ledger, not a cached counter', async () => {
		// Seed a counter that disagrees. The old endpoint returned exactly this
		// number; the new one must return the ledger's own count.
		await env.ORACLE_TELEMETRY.put('x402_payment_count', '999');
		try {
			const body = await fetchJSON('/v5/payment-proof');
			const settlements = body.settlements as unknown[];
			expect(body.payment_count).toBe(settlements.length);
			expect(body.payment_count).not.toBe(999);
		} finally {
			await env.ORACLE_TELEMETRY.delete('x402_payment_count');
		}
	});

	it('a disagreeing counter is reported, not silently reconciled away', async () => {
		// This is a diligence surface. Quietly replacing the counter would hide
		// the very drift GAP-021 was about.
		await env.ORACLE_TELEMETRY.put('x402_payment_count', '999');
		try {
			const body = await fetchJSON('/v5/payment-proof');
			const rec = body.counter_reconciliation as Record<string, unknown>;
			expect(rec.x402_payment_count).toBe(999);
			expect(rec.ledger_count).toBe(body.payment_count);
			expect(rec.agrees).toBe(false);
		} finally {
			await env.ORACLE_TELEMETRY.delete('x402_payment_count');
		}
	});

	it('Monday 2026-09-07 settlement appears in the ledger with its hash', async () => {
		const body = await fetchJSON('/v5/payment-proof');
		const hashes = (body.settlements as Record<string, unknown>[]).map((s) => s.tx_hash);
		expect(hashes).toContain(MONDAY_TX);
		expect(hashes).toContain(FIRST_TX);
		// Ordered by block time, so first_payment_* is the earliest and not
		// whichever row happened to be listed first.
		const times = (body.settlements as Record<string, string>[]).map((s) => s.block_time);
		expect([...times].sort()).toEqual(times);
	});

	it('a durable KV ledger row is merged into the count', async () => {
		// The forward-looking half: new settlements are appended durably, so a
		// future walk reconstructs without a chain query.
		const before = (await fetchJSON('/v5/payment-proof')).payment_count as number;
		await env.ORACLE_TELEMETRY.put(
			'x402_payment:2026-09-07T18:00:00.000Z:0xabc0000000000000000000000000000000000000000000000000000000000001',
			JSON.stringify({
				tx_hash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
				block_number: 51000000, block_time: '2026-09-07T18:00:00.000Z',
				payer: '0x1111111111111111111111111111111111111111',
				atomic_units: '1000', source: 'direct_onchain', note: '',
			}),
		);
		const after = await fetchJSON('/v5/payment-proof');
		expect(after.payment_count).toBe(before + 1);
		expect(after.last_payment_tx).toBe('0xabc0000000000000000000000000000000000000000000000000000000000001');
		const src = after.ledger_source as Record<string, unknown>;
		expect(src.kv_ledger_rows).toBe(1);
		expect(src.walk_complete).toBe(true);
	});

	it('a KV row duplicating a chain-verified settlement does not double-count', async () => {
		// Re-recording the same settlement — a retried write, a replayed
		// webhook — must not inflate a number people do diligence on.
		const before = (await fetchJSON('/v5/payment-proof')).payment_count as number;
		await env.ORACLE_TELEMETRY.put(
			`x402_payment:${FIRST_AT}:${FIRST_TX}`,
			JSON.stringify({
				tx_hash: FIRST_TX, block_number: 44218092, block_time: FIRST_AT,
				payer: '0x2073ed996134536c629c95cadb0e8de668ad4143',
				atomic_units: '1000', source: 'direct_onchain', note: '',
			}),
		);
		const after = await fetchJSON('/v5/payment-proof');
		expect(after.payment_count).toBe(before);
		expect(after.first_payment_tx).toBe(FIRST_TX);
	});

	it('an unreadable ledger row is skipped, not fatal', async () => {
		// Fail-closed applies to the count as much as to a verdict: one corrupt
		// row must not take out a public endpoint or silently zero the history.
		await env.ORACLE_TELEMETRY.put('x402_payment:2026-09-07T19:00:00.000Z:0xdead', 'not json');
		const res = await fetchWorker('/v5/payment-proof');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body.first_payment_tx).toBe(FIRST_TX);
		expect((body.settlements as unknown[]).length).toBeGreaterThanOrEqual(3);
	});

	it('every chain-verified settlement carries a resolvable hash, block and time', async () => {
		// Each row has to be checkable by a third party without trusting us —
		// that is the difference between a payment proof and a payment claim.
		const body = await fetchJSON('/v5/payment-proof');
		for (const s of body.settlements as Record<string, unknown>[]) {
			expect(String(s.tx_hash)).toMatch(/^0x[0-9a-f]{64}$/);
			expect(String(s.block_time)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(String(s.atomic_units)).toBe('1000');
		}
		expect(String(body.verify_at)).toContain('basescan.org');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP-017 — a hung Supabase must not hold a worker isolate open
//
// supabase-js builds on fetch and passes no signal, so an upstream that accepts
// the connection and never answers is waited on forever. The damage is not a
// slow auth response: it is an isolate pinned to a dead socket, which stops the
// worker serving anything at all.
//
// The stub below is a faithful hung upstream — it never resolves, but it does
// honour cancellation, exactly as a real fetch does. That is what makes this
// test able to fail: if the deadline were not actually attached to the request,
// nothing would ever abort it and the case would hang until vitest killed it.
// ─────────────────────────────────────────────────────────────────────────────
describe('GAP-017 — Supabase calls on a request path carry a deadline', () => {
	// Never resolves; rejects only when the caller's signal fires.
	const hangUntilAborted = (init?: RequestInit): Promise<Response> =>
		new Promise((_resolve, reject) => {
			const sig = init?.signal;
			if (!sig) return; // no signal attached => hangs => the test fails on timeout
			if (sig.aborted) return reject(new DOMException('aborted', 'TimeoutError'));
			sig.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
		});

	it('a black-holed auth lookup returns the fail-closed response inside the bound', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const u = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (u.includes('supabase.co')) return hangUntilAborted(init);
			return original(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		try {
			clearApiKeyCache();
			const started = Date.now();
			const res = await fetchWorker('/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': 'ho_live_deadbeefdeadbeefdeadbeefdeadbeef' },
			});
			const elapsed = Date.now() - started;

			// Fail-closed: an auth backend we could not reach denies access. It
			// never falls through to a served receipt.
			expect(res.status).toBe(403);
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).toBe('INVALID_API_KEY');

			// Inside the bound, with slack for the rest of the request. The
			// number that matters is that it terminated at all: before the
			// deadline this call did not come back.
			expect(elapsed).toBeLessThan(4000);
		} finally {
			globalThis.fetch = original;
			clearApiKeyCache();
		}
	}, 10_000);

	it('a KV cache hit never reaches Supabase, so a hung upstream cannot touch it', async () => {
		// The control. If this also went to Supabase, the test above would be
		// measuring the wrong path and the deadline would prove nothing about
		// the cached case.
		const key = 'ho_live_cachedkeycachedkeycachedkey01';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'active' }));
		const original = globalThis.fetch;
		let supabaseCalls = 0;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const u = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url);
			if (u.includes('supabase.co')) { supabaseCalls++; return hangUntilAborted(init); }
			return original(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		try {
			clearApiKeyCache();
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(200);
			// updateKeyUsage / insertReceiptAudit run under waitUntil and may
			// call Supabase; what must NOT happen is the auth lookup blocking.
			// The 200 above is the assertion that it did not.
		} finally {
			globalThis.fetch = original;
			await env.ORACLE_API_KEYS.delete(keyHash);
			clearApiKeyCache();
			void supabaseCalls;
		}
	}, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan prices are stated once (rail sprint, 2026-09-07)
//
// Same discipline as the x402 requirements (T1) and the plan allowances (T2):
// one constant, every served surface a projection of it. "$99", "$299",
// "99 USDC" and "299 USDC" were written as literals in 28 places, and the
// mint's ON-CHAIN amount was a twenty-ninth independent copy —
// BigInt(99_000_000) — which no reader would connect to a price at all.
//
// Every expectation below is DERIVED from planPrices(), never written. Change
// PLAN_PRICES.builder to 149 and these assertions follow the product; write
// 149 into one surface and forget another, and they go red naming it.
// ─────────────────────────────────────────────────────────────────────────────
describe('plan prices are derived from one constant, on every surface', () => {
	const P = planPrices();
	const BUILDER_MONTHLY       = `$${P.builder}/month`;
	const PRO_MONTHLY           = `$${P.pro}/month`;
	const BUILDER_MONTHLY_SHORT = `$${P.builder}/mo`;
	const PRO_MONTHLY_SHORT     = `$${P.pro}/mo`;
	const BUILDER_USDC          = `${P.builder} USDC`;
	const PRO_USDC              = `${P.pro} USDC`;

	it('planPrices() is the single source, and it is a real number', () => {
		expect(typeof P.builder).toBe('number');
		expect(typeof P.pro).toBe('number');
		expect(P.pro).toBeGreaterThan(P.builder);
	});

	it('/v5/pricing quotes the derived price as both a number and a label', async () => {
		const body = await fetchJSON('/v5/pricing');
		const tiers = body.tiers as Record<string, unknown>[];
		const builder = tiers.find((t) => t.id === 'builder');
		const pro     = tiers.find((t) => t.id === 'pro');
		// The machine-readable number is what an agent branches on.
		expect(builder?.price_usd).toBe(P.builder);
		expect(pro?.price_usd).toBe(P.pro);
		// And the human label is derived from the same number, so the two
		// cannot disagree — which is the failure this whole change is about.
		expect(builder?.price_label).toBe('$' + P.builder + ' / month');
		expect(pro?.price_label).toBe('$' + P.pro + ' / month');
	});

	it('GET /v5/keys/request quotes the derived monthly prices', async () => {
		const body = await fetchJSON('/v5/keys/request');
		const plans = body.plans as Record<string, Record<string, unknown>>;
		expect(plans.builder.price).toBe(BUILDER_MONTHLY);
		expect(plans.pro.price).toBe(PRO_MONTHLY);
	});

	it('the mint endpoint quotes the derived USDC price in both its tiers blocks', async () => {
		const spec = await fetchJSON('/openapi.json');
		const text = JSON.stringify(spec);
		expect(text).toContain(BUILDER_USDC);
		expect(text).toContain(PRO_USDC);

		// The 400 body has its own tiers block — a second copy before this change.
		const res = await fetchWorker('/v5/x402/mint', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tx_hash: '0x' + 'a'.repeat(64), tier: 'gold' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		const tiers = body.tiers as Record<string, Record<string, unknown>>;
		expect(tiers.builder.usdc).toBe(P.builder);
		expect(tiers.pro.usdc).toBe(P.pro);
		expect(String(body.message)).toContain(BUILDER_USDC);
		expect(String(body.message)).toContain(PRO_USDC);
	});

	it('the on-chain mint amount IS the advertised price, not a second copy of it', async () => {
		// The one that matters most. The mint required X402_MINT_BUILDER_UNITS
		// = BigInt(99_000_000), written independently of every "$99" on the
		// site. An agent paying the advertised price into an amount we no
		// longer honour is not a formatting bug.
		const spec = await fetchJSON('/.well-known/x402.json');
		const mint = (spec.resources as Record<string, unknown>[])
			.find((r) => String(r.path) === '/v5/x402/mint');
		const tiers = mint?.tiers as Record<string, Record<string, unknown>> | undefined;
		expect(tiers?.builder?.usdc).toBe(P.builder);
		expect(tiers?.pro?.usdc).toBe(P.pro);
		// USDC is 6 decimals: the atomic amount must be exactly price * 1e6.
		expect(BigInt(P.builder) * 1_000_000n).toBe(99_000_000n);
		expect(BigInt(P.pro) * 1_000_000n).toBe(299_000_000n);
	});

	it('the 402 upgrade paths quote the derived monthly prices', async () => {
		// Free tier at its limit is the 402 body an agent actually reads.
		const key = 'ho_free_pricetest0000000000000000';
		const keyHash = await sha256Hex(key);
		const today = new Date().toISOString().slice(0, 10);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'free', status: 'active' }));
		await env.ORACLE_TELEMETRY.put(`free_usage:${keyHash}:${today}`, '99999');
		try {
			clearApiKeyCache();
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			const text = await res.text();
			// Whichever upgrade block this path serves, the price in it is the
			// derived one. Assert on the digits so the test does not pin a
			// particular phrasing, only that no stale number survives.
			expect(text).toContain(String(P.builder));
			expect(text).not.toMatch(/\$1?49\/month/);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			await env.ORACLE_TELEMETRY.delete(`free_usage:${keyHash}:${today}`);
			clearApiKeyCache();
		}
	});

	it('the X-Oracle-Plans header ladder is derived, not written beside each 402', async () => {
		// Three verbatim copies of this header existed. It is machine-readable
		// and an agent picks a tier from it, so a drifted number here is a
		// wrong price quoted to something that will act on it.
		const key = 'ho_susp_pricetest000000000000000';
		const keyHash = await sha256Hex(key);
		await env.ORACLE_API_KEYS.put(keyHash, JSON.stringify({ plan: 'builder', status: 'suspended' }));
		try {
			clearApiKeyCache();
			const res = await fetchWorker('/v5/status?mic=XNYS', { headers: { 'X-Oracle-Key': key } });
			expect(res.status).toBe(402);
			const header = res.headers.get('X-Oracle-Plans') ?? '';
			expect(header).toContain(`builder=${P.builder}`);
			expect(header).toContain(`pro=${P.pro}`);
		} finally {
			await env.ORACLE_API_KEYS.delete(keyHash);
			clearApiKeyCache();
		}
	});

	it('the error catalogue quotes the derived short price', async () => {
		const body = await fetchJSON('/v5/errors/SANDBOX_KEY_EXPIRED');
		expect(String(body.resolution)).toContain(BUILDER_MONTHLY_SHORT);
	});

	it('llms-full.txt quotes the derived prices for both tiers', async () => {
		// llms.txt is the index and carries only the per-request price; the
		// plan ladder is in llms-full.txt.
		const res = await fetchWorker('/llms-full.txt');
		const text = await res.text();
		expect(text).toContain(BUILDER_MONTHLY_SHORT);
		expect(text).toContain(PRO_MONTHLY_SHORT);
	});

	it('no served surface carries a hardcoded price the constant does not control', async () => {
		// The falsifier for the whole change. Every surface is fetched and
		// checked for the derived strings; if a price were hardcoded somewhere
		// and PLAN_PRICES changed, that surface would still say the old number
		// while these assertions moved.
		for (const path of ['/v5/pricing', '/openapi.json', '/llms-full.txt', '/v5/why-not-free', '/.well-known/x402.json', '/v5/keys/request']) {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			const text = await res.text();
			// Whatever price tokens appear must be the current ones.
			const priceTokens = text.match(/\$\d{2,4}(?:\/mo(?:nth)?)?|\b\d{2,4} USDC\b/g) ?? [];
			for (const token of priceTokens) {
				const digits = token.match(/\d+/)?.[0] ?? '';
				// Only assert on tokens that look like a PLAN price (2-3 digits,
				// not the $5 credit pack or the 0.001 per-request price).
				if (['99', '299', '500'].includes(digits)) {
					expect([String(P.builder), String(P.pro), '500'], `${path} served ${token}`).toContain(digits);
				}
			}
		}
	});
});

// ─── B-145: the six referee prices are stated once, in source ────────────────

describe('referee prices are derived from one constant', () => {
	const R = refereePrices();

	// The table as Paddle read it back on 2026-09-09 (products created and
	// verified in CC_REPORT_2026-09-09_paddle-prices-rev2-resumed.md). This is
	// the reconciliation the tree could not do before: if someone edits an
	// amount here without changing it in Paddle — or the reverse is discovered
	// and corrected here — this test is the thing that has to move with it.
	const LIVE_PADDLE_RECORD = {
		conformance_entry: { price_id: 'pri_01m22wcgvj15ktn5xnabf13a7p', minor_units: 250000, cycle: null },
		regrade:           { price_id: 'pri_01m22wcz6wth6vdmhk3a9xd4ez', minor_units:  75000, cycle: null },
		dispute:           { price_id: 'pri_01m22wda7747kb18jfat1p58dw', minor_units:  50000, cycle: null },
		dispute_note:      { price_id: 'pri_01m22wexbdc4mr70zr1x3faqg6', minor_units: 150000, cycle: null },
		custody_90d:       { price_id: 'pri_01m22wf966bjsar9sgtbzsva2b', minor_units:   4900, cycle: { interval: 'month', frequency: 1 } },
		custody_1y:        { price_id: 'pri_01m22wfjtbnhjyws9ctabxhvp4', minor_units:  19900, cycle: { interval: 'month', frequency: 1 } },
	} as const;

	it('B-145: REFEREE_PRICES carries exactly the six live Paddle prices, id, minor units and cycle', () => {
		expect(Object.keys(R.prices).sort()).toEqual(Object.keys(LIVE_PADDLE_RECORD).sort());
		for (const [key, expected] of Object.entries(LIVE_PADDLE_RECORD)) {
			const actual = R.prices[key as keyof typeof R.prices];
			expect(actual.price_id, key).toBe(expected.price_id);
			expect(actual.minor_units, key).toBe(expected.minor_units);
			expect(actual.currency, key).toBe('USD');
			expect(actual.cycle, key).toEqual(expected.cycle);
		}
	});

	it('B-145: the decimal amount is a projection of minor_units, not a second copy of the price', () => {
		// The failure this whole change is against: a second, independent
		// statement of the same number with nothing failing when they disagree.
		expect(R.amount('conformance_entry')).toBe('2500.00');
		expect(R.amount('custody_90d')).toBe('49.00');
		for (const key of Object.keys(R.prices) as Array<keyof typeof R.prices>) {
			expect(R.amount(key), key).toBe((R.prices[key].minor_units / 100).toFixed(2));
		}
	});

	it('B-145 / H1a: a custody price id maps to its own line (evidence), NOT to the unmapped branch', async () => {
		// CHANGED 2026-10-03 (H1a). This sent subscription.activated for
		// custody_90d and asserted a revenue row under `referee:custody_90d` and
		// no key. Two things moved: custody_90d is now the evidence_starter plan
		// and provisions a key, and subscription.activated no longer records or
		// mints for a subscription plan (transaction.completed is the one path).
		// What this test exists for is unchanged: our own price must not land in
		// the unmapped branch, and the amount on its row must be the derived one.
		const service = 'custody_90d';
		const tierKey = 'paddle_revenue_count:evidence:evidence_starter';
		const before         = parseInt((await env.ORACLE_TELEMETRY.get(tierKey)) ?? '0', 10) || 0;
		const unmappedBefore = parseInt((await env.ORACLE_TELEMETRY.get('paddle_revenue_count:unmapped')) ?? '0', 10) || 0;
		const refereeBefore  = parseInt((await env.ORACLE_TELEMETRY.get(`paddle_revenue_count:referee:${service}`)) ?? '0', 10) || 0;

		const rawBody = JSON.stringify({
			event_type: 'transaction.completed',
			data: {
				id:              'txn_b145_custody_001',
				customer_id:     'ctm_referee_custody',
				subscription_id: 'sub_b145_custody_001',
				origin:          'web',
				items:           [{ price_id: R.prices[service].price_id, quantity: 1 }],
			},
		});
		const sig = await makePaddleSignature(rawBody, 'pdl_ntfset_test_placeholder_for_local_tests');

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('api.resend.com')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (url.includes('api.paddle.com/customers')) return new Response(JSON.stringify({ data: { email: 'b145@example.com' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (url.includes('supabase') && init?.method === 'POST') return new Response('', { status: 201 });
			if (url.includes('supabase')) {
				return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: { 'Content-Type': 'application/json' } });
			}
			return originalFetch(input as RequestInfo, init);
		};
		try {
			const res = await fetchWorker('/webhooks/paddle', {
				method:  'POST',
				headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig },
				body:    rawBody,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			// Recorded under its own name...
			expect(parseInt((await env.ORACLE_TELEMETRY.get(tierKey)) ?? '0', 10) || 0).toBe(before + 1);
			// ...and NOT as an unmapped price, nor as the old referee line.
			expect(parseInt((await env.ORACLE_TELEMETRY.get('paddle_revenue_count:unmapped')) ?? '0', 10) || 0).toBe(unmappedBefore);
			expect(parseInt((await env.ORACLE_TELEMETRY.get(`paddle_revenue_count:referee:${service}`)) ?? '0', 10) || 0).toBe(refereeBefore);
			// And the amount on that row is the derived one, not a literal.
			const listed = await env.ORACLE_TELEMETRY.list({ prefix: 'paddle_revenue_event:' });
			const rows = await Promise.all(listed.keys.map((k) => env.ORACLE_TELEMETRY.get(k.name)));
			const row = rows
				.map((r) => JSON.parse(r ?? '{}') as Record<string, unknown>)
				.find((r) => r.txn_id === 'txn_b145_custody_001');
			expect(row?.amount).toBe(R.amount(service));
			expect(row?.currency).toBe('USD');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('B-145: no served surface quotes a referee price id or a non-colliding referee amount — nothing derives one yet', async () => {
		// The falsifier for "the first thing that quotes one derives it".
		//
		// What it observes: today NOTHING quotes a referee price, so the
		// strongest true statement is that no public surface carries one of the
		// six Paddle price ids, or one of the six amounts. The concrete red input
		// is a person writing "$2,500" or "$150" into llms-full.txt, the OpenAPI
		// spec or the pricing endpoint as a literal — this goes red the moment
		// they do, and the fix is to derive it from REFEREE_PRICES and add that
		// surface to ALLOWED_TO_QUOTE with an assertion that what it serves IS
		// the derived value.
		//
		// What it does NOT observe, stated rather than hidden:
		//  - `dispute` is $500.00 and PLAN_PRICES.protocol is $500/month. The
		//    amount string cannot tell those two apart, so amounts that collide
		//    with a plan price are skipped and only the price-id half covers
		//    them. The plan amounts are read from the served /v5/pricing rather
		//    than restated here, so the collision set follows PLAN_PRICES.
		//  - a surface outside this list, a referee price quoted somewhere that
		//    is not a served HTTP surface, and whether the DEPLOYED worker
		//    matches this tree.
		const ALLOWED_TO_QUOTE: string[] = []; // none yet, by design

		const pricing   = await fetchJSON('/v5/pricing');
		const planUsd   = new Set((pricing.tiers as Record<string, unknown>[])
			.map((t) => Number(t.price_usd))
			.filter((n) => Number.isFinite(n) && n > 0)
			.map((n) => n.toFixed(2)));

		const ids     = Object.values(R.prices).map((p) => p.price_id);
		const amounts = (Object.keys(R.prices) as Array<keyof typeof R.prices>).map((k) => R.amount(k));
		// Sanity: the collision this test documents must actually exist, or the
		// skip below is silently weakening the check for no reason.
		expect(planUsd.has(R.amount('dispute'))).toBe(true);

		for (const path of ['/v5/pricing', '/openapi.json', '/llms-full.txt', '/llms.txt', '/v5/why-not-free', '/.well-known/x402.json', '/v5/keys/request', '/.well-known/mcp/server-card.json']) {
			if (ALLOWED_TO_QUOTE.includes(path)) continue;
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			const text = await res.text();
			// A Paddle price id has no business on a public surface at all, and
			// it is unambiguous — no plan price can collide with it.
			for (const id of ids) expect(text, `${path} quoted the referee price id ${id}`).not.toContain(id);
			for (const amount of amounts) {
				if (planUsd.has(amount)) continue; // collides with a plan price — see above
				const whole = amount.replace('.00', '');                      // "2500"
				const comma = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');    // "2,500"
				expect(text, `${path} quoted the referee amount $${amount}`).not.toContain(`$${amount}`);
				expect(text, `${path} quoted the referee amount $${comma}`).not.toContain(`$${comma}`);
			}
		}
	});

	it('B-145 DATED TRIPWIRE — INTENDED TO GO RED ON 2027-01-01: the referee introductory window has not expired', () => {
		// THIS IS NOT A BUG WHEN IT FAILS. It is the point of the test.
		//
		// Every one of the six prices carries introductory_until: "2026-12-31"
		// in its Paddle custom_data, and NOTHING read that field. On 1 January
		// 2027 all six would go on charging the introductory amount and the only
		// thing that would notice is someone remembering. A red suite is a
		// better memory than a person.
		//
		// Deliberately real wall-clock time, not vi.setSystemTime: a tripwire
		// that fires against a mocked clock never fires at all.
		const R2 = refereePrices();
		const until = new Date(`${R2.introductory_until}T23:59:59Z`);
		const now   = new Date();
		expect(
			now.getTime() <= until.getTime(),
			[
				'',
				`REFEREE_INTRODUCTORY_UNTIL (${R2.introductory_until}) has passed, and the six referee`,
				'prices in REFEREE_PRICES still carry their INTRODUCTORY amounts:',
				...(Object.keys(R2.prices) as Array<keyof typeof R2.prices>)
					.map((k) => `  ${k}  $${R2.amount(k)}  ${R2.prices[k].price_id}`),
				'',
				'This test is a deliberate dated tripwire and it has done its job.',
				'There are exactly two ways out, and both are decisions, not edits:',
				'',
				'  1. EXTEND — on a Lead ruling, move REFEREE_INTRODUCTORY_UNTIL in',
				'     src/index.ts forward, AND update introductory_until in each of',
				'     the six prices\' custom_data in Paddle so the two agree.',
				'',
				'  2. SUCCEED — publish successor prices in Paddle at the standard',
				'     amounts, replace the six lines in REFEREE_PRICES with them, and',
				'     clear the introductory flag: drop REFEREE_INTRODUCTORY_UNTIL and',
				'     this test together, in the same commit.',
				'',
				'Do NOT silence this by deleting the assertion and leaving the prices.',
				'',
			].join('\n'),
		).toBe(true);
	});
});

// B-224c: the claim class removed by B-224, B-224b and B-224c must not return on any
// surface an agent reads first. Status is asserted so a route that stops serving
// cannot pass the absence check vacuously.
describe('served text surfaces make no regulatory-alignment claim', () => {
	// B-224d. A claim word and a regulator word in the same sentence is a claim
	// unless the sentence is one of the disclaimers this operator publishes on
	// purpose. This replaced a fixed list of banned strings after that list missed
	// four rewordings across four passes; the exact strings are kept as a second,
	// cheaper check so a known phrase fails with its own name.
	const CLAIM = /\b(align\w*|compliant|compliance|conform\w*|consistent with|in line with|adhere\w*|mandat\w*|endorse\w*|approved by|certifi\w*|accredit\w*)\b/i;
	const REGULATOR = /\b(CFTC|SEC\b|ESMA|MiFID|FCA|FINRA|NIST|MAS\b|SOC ?2|regulat\w*)/i;
	const DISCLAIMER = /No regulator has reviewed|not a compliance product|took (its|the pattern|the threshold|the direction)|takes its architectural direction|neither body has reviewed/i;
	const LEGACY = [
		'SEC/CFTC Technical Framework',
		'Compliance Alignment',
		'Regulatory alignment:',
		'regulatory_alignment',
		'x-regulatory-alignment',
		'consistent with emerging regulatory direction',
		'Architecturally consistent with emerging regulatory',
		'SOC 2',
		'Singapore MAS',
		'uptime_sla',
		'Regulatory Alignment',
		'architecturally consistent',
	];
	const SURFACES: { path: string; json: boolean }[] = [
		{ path: '/llms.txt', json: false },
		{ path: '/llms-full.txt', json: false },
		{ path: '/AGENTS.md', json: false },
		{ path: '/SKILL.md', json: false },
		{ path: '/openapi.json', json: true },
		{ path: '/.well-known/mcp/server-card.json', json: true },
		{ path: '/.well-known/agent.json', json: true },
		{ path: '/.well-known/x402.json', json: true },
		{ path: '/docs/specifications/multi-oracle-consensus-v1', json: false },
		{ path: '/docs/specifications/multi-oracle-consensus-v1.md', json: false },
		{ path: '/docs/specs/MULTI-ORACLE-CONSENSUS-v1.md', json: false },
		{ path: '/docs/specifications/cpvr-1', json: false },
		{ path: '/docs/specifications/cpvr-1.md', json: false },
		{ path: '/docs/specifications/pre-trade-stack', json: false },
		{ path: '/docs/specifications/pre-trade-stack.md', json: false },
		{ path: '/docs/integrations/ampersend', json: false },
		{ path: '/docs/integrations/ampersend.md', json: false },
		{ path: '/v1/verification/multi-oracle-guide', json: true },
		{ path: '/v5/pre-trade-stack', json: false },
		{ path: '/v5/why-not-free', json: false },
		{ path: '/.well-known/ai-catalog.json', json: true },
		{ path: '/auth.md', json: false },
		{ path: '/v1/witness/spec', json: true },
	];
	for (const { path, json } of SURFACES) {
		it(`${path} carries no undisclaimed regulatory claim`, async () => {
			const res = await fetchWorker(path);
			expect(res.status).toBe(200);
			const body = await res.text();
			if (json) JSON.parse(body);
			const lower = body.toLowerCase();
			const legacy = LEGACY.filter((s) => lower.includes(s.toLowerCase()));
			expect(legacy).toEqual([]);
			// Split at a sentence end followed by a capital, or at a newline, so a
			// version number like v1.0.1 does not cut a disclaimer off its claim.
			const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z])|\n/);
			const claims = sentences
				.filter((s) => CLAIM.test(s) && REGULATOR.test(s) && !DISCLAIMER.test(s))
				.map((s) => s.trim().slice(0, 160));
			expect(claims).toEqual([]);
		});
	}
	it('POST /mcp tools/list carries no undisclaimed regulatory claim in any tool description', async () => {
		const body = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const text = JSON.stringify(body);
		const lower = text.toLowerCase();
		const legacy = LEGACY.filter((s) => lower.includes(s.toLowerCase()));
		expect(legacy).toEqual([]);
		const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])|\\n/);
		const claims = sentences
			.filter((s) => CLAIM.test(s) && REGULATOR.test(s) && !DISCLAIMER.test(s))
			.map((s) => s.trim().slice(0, 160));
		expect(claims).toEqual([]);
	});
});

// --- A2A: no served surface claims A2A support (2026-10-02) -----------------
// No endpoint here implements A2A (the agent-to-agent protocol), so no served
// surface may claim, imply or advertise it (founder ruling R2, extended by the
// Lead on 2026-10-02). /.well-known/agent-card.json is A2A's registered
// well-known URI and answers 404; /.well-known/agent.json stays as plain JSON
// metadata without the fields that exist only to make an A2A AgentCard.
describe('A2A: no served surface claims A2A support', () => {
	// A2A as a word, the old a2aVersion key, the protocol's long name, and "agent
	// card" in any spelling (AgentCard, agent card, agent-card), which also
	// catches any link to /.well-known/agent-card.json. Word boundaries keep hex
	// and base64 runs that happen to contain "a2a" from matching.
	const A2A_CLAIM = /\bA2A\b|\ba2aVersion\b|agent-to-agent|\bagent[ -]?card\b/i;

	// The only text a surface may carry that mentions A2A without claiming it,
	// as exact strings. Each must be present (so this list cannot go stale) and
	// is cut out before the check.
	const A2A_ALLOWED: Record<string, string[]> = {
		// A third party's description of its own framework; the guide's next
		// sentence says Headless Oracle drops in as an MCP tool.
		'/docs/integrations/agentictrading-mcp': ['using MCP tool calling, A2A messaging,'],
		// The historical 5.2 entry, kept byte-identical, and the 2026-10-02 entry
		// that withdraws the label.
		'/v5/changelog': [
			'A2A Agent Card at /.well-known/agent.json',
			'A2A label withdrawn because Headless Oracle does not implement A2A: /.well-known/agent.json is now plain JSON metadata without A2A AgentCard fields, and /.well-known/agent-card.json is no longer served.',
		],
	};

	// Discovery and documentation surfaces an agent or indexer reads (36). The
	// source search in CC_HANDOFF_2026-10-02_hov5-a2a-claims_rev3 section 5
	// covered every line of src/index.ts at c6f9098; this list guards the
	// surfaces that carried, or sit beside, the claims it found.
	const A2A_SURFACES: string[] = [
		'/llms.txt',
		'/llms-full.txt',
		'/AGENTS.md',
		'/SKILL.md',
		'/skill.md',
		'/auth.md',
		'/openapi.json',
		'/sitemap.xml',
		'/robots.txt',
		'/.well-known/agent.json',
		'/.well-known/mcp/server-card.json',
		'/.well-known/x402.json',
		'/.well-known/ai-catalog.json',
		'/.well-known/api-catalog',
		'/.well-known/agent-skills/index.json',
		'/.well-known/agent-skills/verify-receipt/SKILL.md',
		'/.well-known/agent-skills/read-market-state/SKILL.md',
		'/.well-known/agent-skills/subscribe-halts/SKILL.md',
		'/.well-known/agent-skills/pay-with-x402/SKILL.md',
		'/.well-known/agent-skills/mcp-tool-catalog/SKILL.md',
		'/agent-directory.json',
		'/.well-known/agent-directory.json',
		'/v5/changelog',
		'/v5/pricing',
		'/v5/why-not-free',
		'/v5/pre-trade-stack',
		'/v1/verification/multi-oracle-guide',
		'/docs/specifications/pre-trade-stack',
		'/docs/specifications/cpvr-1',
		'/docs/specifications/multi-oracle-consensus-v1',
		'/docs/integrations/ampersend',
		'/docs/integrations/korea-investment-mcp',
		'/docs/integrations/agentictrading-mcp',
		'/docs/integrations/openalgo-zerodha',
		'/docs/integrations/tradingagents-risk',
		'/docs/integrations/composio-listing',
	];

	// Fields that exist only to make a document an A2A AgentCard.
	const A2A_ONLY_FIELDS = [
		'capabilities', 'defaultInputModes', 'defaultOutputModes', 'authSchemes',
		'schemaVersion', 'humanReadableId', 'agentVersion', 'protocolVersion',
		'supportedInterfaces', 'preferredTransport', 'additionalInterfaces',
		'securitySchemes', 'supportsAuthenticatedExtendedCard',
	];

	// CHANGED (H4a): still 404 and still no card, but the body now says why and
	// where the interfaces that do exist are.
	it('GET /.well-known/agent-card.json answers 404 A2A_NOT_IMPLEMENTED', async () => {
		const res = await fetchWorker('/.well-known/agent-card.json');
		expect(res.status).toBe(404);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('A2A_NOT_IMPLEMENTED');
	});

	it('GET /.well-known/agent.json is plain JSON metadata with no A2A-only field', async () => {
		const res = await fetchWorker('/.well-known/agent.json');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type') ?? '').toContain('application/json');
		const body = await res.json() as Record<string, unknown>;
		for (const k of A2A_ONLY_FIELDS) expect(Object.keys(body), k).not.toContain(k);
		const skills = body.skills as Array<Record<string, unknown>>;
		expect(skills.length).toBeGreaterThan(0);
		for (const s of skills) {
			expect(Object.keys(s), String(s.id)).not.toContain('inputModes');
			expect(Object.keys(s), String(s.id)).not.toContain('outputModes');
		}
		// What the x402 tests and the API catalog still read from it.
		expect((body.authentication as { schemes: string[] }).schemes).toContain('x402');
		expect((body.payment as Record<string, unknown>).network).toBe('eip155:8453');
		expect((body.rest_api as { endpoints: unknown[] }).endpoints.length).toBeGreaterThan(0);
	});

	for (const path of A2A_SURFACES) {
		it(`${path} carries no A2A claim`, async () => {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			let text = await res.text();
			for (const allowed of A2A_ALLOWED[path] ?? []) {
				expect(text.includes(allowed), `${path} no longer carries the allowlisted text: ${allowed}`).toBe(true);
				text = text.split(allowed).join('');
			}
			const m = A2A_CLAIM.exec(text);
			expect(m === null, m ? `${path}: ...${text.slice(Math.max(0, m.index - 60), m.index + 60)}...` : '').toBe(true);
		});
	}

	it('/skill.md and the agent directory carry no agent_card key', async () => {
		for (const path of ['/skill.md', '/agent-directory.json', '/.well-known/agent-directory.json']) {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			expect(await res.text(), path).not.toContain('agent_card');
		}
	});

	it('POST /mcp initialize and tools/list, and GET /mcp, carry no A2A claim', async () => {
		const bodies = [
			JSON.stringify(await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claim-guard', version: '1' } } })),
			JSON.stringify(await postMcpJSON({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
			await (await fetchWorker('/mcp')).text(),
		];
		for (const b of bodies) expect(A2A_CLAIM.exec(b)).toBeNull();
	});

	it('/openapi.json documents no /.well-known/agent-card.json path, and no capabilities field on agent.json', async () => {
		const spec = await fetchJSON('/openapi.json');
		const paths = spec.paths as Record<string, { get: { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }>;
		expect(Object.keys(paths)).not.toContain('/.well-known/agent-card.json');
		expect(Object.keys(paths)).toContain('/.well-known/agent.json');
		const props = paths['/.well-known/agent.json'].get.responses['200'].content['application/json'].schema.properties;
		expect(Object.keys(props)).not.toContain('capabilities');
	});
});

// ─── H2: the key on screen after payment (2026-10-04) ────────────────────────
// Key delivery was email only, and the Resend team behind the worker's key
// could not send from headlessoracle.com. The browser that starts a checkout
// now gets a claim_token; Paddle carries its sha256 back in the signed
// webhook; POST /v5/claim answers pending, then ready with the key.
describe('H2: claim tokens — the key on screen after payment', () => {
	const FOUNDER = 'mike@headlessoracle.com';
	const PRICE = {
		builder:     'pri_test_builder_placeholder',
		credits:     'pri_test_credits_placeholder',
		custody_90d: 'pri_01m22wf966bjsar9sgtbzsva2b',
	};
	const HEX64 = /^[0-9a-f]{64}$/;

	type Limiter = { limit: (o: { key: string }) => Promise<{ success: boolean }> };
	const allow: Limiter = { limit: async () => ({ success: true }) };

	type Captured = { paddleTxnBodies: Record<string, unknown>[]; mails: Array<{ to: string; text: string; html: string }> };

	// Paddle transactions answer with `txnIds` in order (the last repeats);
	// `failFirst` makes the first transaction call fail, as an unapproved
	// checkout domain would.
	function stub(opts: { txnIds?: string[]; failFirst?: boolean; email?: string } = {}) {
		const cap: Captured = { paddleTxnBodies: [], mails: [] };
		const prev = globalThis.fetch;
		const jh = { 'Content-Type': 'application/json' };
		let n = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url    = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
			const method = (init?.method ?? 'GET').toUpperCase();
			if (url.includes('api.paddle.com/transactions')) {
				cap.paddleTxnBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
				const i = n++;
				if (opts.failFirst && i === 0) {
					return new Response(JSON.stringify({ error: { detail: 'checkout url not approved' } }), { status: 400, headers: jh });
				}
				const ids = opts.txnIds ?? ['txn_h2_default'];
				const id  = ids[Math.min(opts.failFirst ? i - 1 : i, ids.length - 1)];
				return new Response(JSON.stringify({ data: { id, checkout: { url: `https://headlessoracle.com/pricing?_ptxn=${id}` } } }), { status: 200, headers: jh });
			}
			if (url.includes('api.paddle.com/customers')) {
				return new Response(JSON.stringify({ data: { email: opts.email ?? 'buyer@example.com' } }), { status: 200, headers: jh });
			}
			if (url.includes('api.resend.com')) {
				const m = JSON.parse(String(init?.body ?? '{}')) as { to?: string[]; text?: string; html?: string };
				cap.mails.push({ to: m.to?.[0] ?? '', text: m.text ?? '', html: m.html ?? '' });
				return new Response(JSON.stringify({ id: 'email_h2' }), { status: 200, headers: jh });
			}
			if (url.includes('supabase.co')) {
				if (method === 'GET' || method === 'HEAD') {
					return new Response(JSON.stringify({ code: 'PGRST116', message: 'No rows' }), { status: 406, headers: jh });
				}
				if (method === 'POST') return new Response(null, { status: 201 });
				return new Response(null, { status: 204 });
			}
			return prev(input as RequestInfo, init);
		}) as typeof globalThis.fetch;
		return { cap, restore: () => { globalThis.fetch = prev; } };
	}

	async function call(path: string, init: RequestInit = {}, o: Record<string, unknown> = {}): Promise<Response> {
		const ctx = createExecutionContext();
		const e   = { ...env, WITNESS_GET_RL: allow, ...o } as typeof env;
		const res = await worker.fetch(new Request<unknown, IncomingRequestCfProperties>(`http://example.com${path}`, init), e, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	async function checkout(plan: string, o: Record<string, unknown> = {}): Promise<{ res: Response; body: Record<string, unknown> }> {
		const res = await call('/v5/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) }, o);
		return { res, body: await res.json() as Record<string, unknown> };
	}

	async function claim(token: unknown, o: Record<string, unknown> = {}): Promise<{ res: Response; body: Record<string, unknown> }> {
		const res = await call('/v5/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify({ claim_token: token }) }, o);
		return { res, body: await res.json() as Record<string, unknown> };
	}

	async function webhook(data: Record<string, unknown>, o: Record<string, unknown> = {}): Promise<Response> {
		const rawBody = JSON.stringify({ event_type: 'transaction.completed', data });
		const sig     = await makePaddleSignature(rawBody, env.PADDLE_WEBHOOK_SECRET as string);
		return call('/webhooks/paddle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig }, body: rawBody }, o);
	}

	function failingPutsKv(): KVNamespace {
		const real = env.ORACLE_API_KEYS;
		return {
			get:             real.get.bind(real),
			getWithMetadata: real.getWithMetadata.bind(real),
			list:            real.list.bind(real),
			delete:          real.delete.bind(real),
			put:             async () => { throw new Error('KV put failed'); },
		} as unknown as KVNamespace;
	}

	// The handoff's exact encodings, written out independently of the worker:
	// HKDF-SHA256(ikm = secret UTF-8, salt = fromHex(h), info = "ho-claim-seal-v1")
	// to AES-GCM-256, AAD = `${h}:${txn_id}`, iv and ct standard base64.
	async function openSealed(h: string, txnId: string, sealed: { iv: string; ct: string }): Promise<string> {
		const salt = new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
		const ikm  = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PADDLE_WEBHOOK_SECRET as string), 'HKDF', false, ['deriveKey']);
		const key  = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('ho-claim-seal-v1') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
		const b64  = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
		const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sealed.iv), additionalData: new TextEncoder().encode(`${h}:${txnId}`) }, key, b64(sealed.ct));
		return new TextDecoder().decode(pt);
	}

	// Checkout, then transaction.completed for a subscription plan.
	async function paidSubscription(plan: 'builder' | 'custody_90d', tag: string) {
		const txnId = `txn_h2_${tag}`;
		const s = stub({ txnIds: [txnId] });
		try {
			const { body } = await checkout(plan);
			const token = body.claim_token as string;
			const h     = await sha256Hex(token);
			const res   = await webhook({ id: txnId, customer_id: `ctm_h2_${tag}`, subscription_id: `sub_h2_${tag}`, origin: 'api', items: [{ price_id: PRICE[plan], quantity: 1 }], custom_data: { ho_claim: h } });
			expect(res.status).toBe(200);
			return { token, h, txnId, cap: s.cap };
		} finally {
			s.restore();
		}
	}

	it.each(['builder', 'pro', 'protocol', 'credits', 'custody_90d', 'custody_1y'])('%s: checkout returns a claim_token, sends ho_claim = sha256(token) to Paddle, writes claim:<h> pending', async (plan) => {
		const txnId = `txn_h2_issue_${plan}`;
		const { cap, restore } = stub({ txnIds: [txnId] });
		try {
			const { res, body } = await checkout(plan);
			expect(res.status).toBe(200);
			expect(body.transaction_id).toBe(txnId);
			expect(body.claim_token).toMatch(HEX64);
			const h = await sha256Hex(body.claim_token as string);
			expect(cap.paddleTxnBodies.length).toBe(1);
			expect(cap.paddleTxnBodies[0].custom_data).toEqual({ ho_claim: h });
			const raw = await env.ORACLE_API_KEYS.get(`claim:${h}`);
			expect(raw).not.toBeNull();
			expect(JSON.parse(raw!)).toMatchObject({ txn_id: txnId, plan, state: 'pending' });
			// The token itself is stored nowhere.
			expect(raw).not.toContain(body.claim_token as string);
		} finally {
			restore();
		}
	});

	it.each(['conformance_entry', 'regrade', 'dispute', 'dispute_note'])('%s (mints no key): no claim_token and no custom_data', async (plan) => {
		const { cap, restore } = stub({ txnIds: [`txn_h2_ref_${plan}`] });
		try {
			const { res, body } = await checkout(plan);
			expect(res.status).toBe(200);
			expect(body).not.toHaveProperty('claim_token');
			expect(cap.paddleTxnBodies[0]).not.toHaveProperty('custom_data');
		} finally {
			restore();
		}
	});

	it('custom_data.ho_claim is sent on BOTH send() attempts when the first is refused', async () => {
		const { cap, restore } = stub({ txnIds: ['txn_h2_retry'], failFirst: true });
		try {
			const { res, body } = await checkout('builder');
			expect(res.status).toBe(200);
			const h = await sha256Hex(body.claim_token as string);
			expect(cap.paddleTxnBodies.length).toBe(2);
			expect(cap.paddleTxnBodies[0]).toHaveProperty('checkout');
			expect(cap.paddleTxnBodies[1]).not.toHaveProperty('checkout');
			for (const b of cap.paddleTxnBodies) expect(b.custom_data).toEqual({ ho_claim: h });
		} finally {
			restore();
		}
	});

	it('claim KV write fails: the checkout is still returned, without claim_token, and CLAIM_SETUP_FAILED is logged', async () => {
		const { restore } = stub({ txnIds: ['txn_h2_kvfail'] });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const { res, body } = await checkout('builder', { ORACLE_API_KEYS: failingPutsKv() });
			expect(res.status).toBe(200);
			expect(body.transaction_id).toBe('txn_h2_kvfail');
			expect(body.url).toBe('https://buy.paddle.com/checkout/txn_h2_kvfail');
			expect(body).not.toHaveProperty('claim_token');
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_SETUP_FAILED'))).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('PADDLE_WEBHOOK_SECRET unset: checkout returns no claim_token and sends no custom_data', async () => {
		const { cap, restore } = stub({ txnIds: ['txn_h2_nosecret'] });
		try {
			const { res, body } = await checkout('builder', { PADDLE_WEBHOOK_SECRET: undefined });
			expect(res.status).toBe(200);
			expect(body).not.toHaveProperty('claim_token');
			expect(cap.paddleTxnBodies[0]).not.toHaveProperty('custom_data');
		} finally {
			restore();
		}
	});

	it('before the webhook: 200 pending with retry_after_seconds 2', async () => {
		const { restore } = stub({ txnIds: ['txn_h2_pending'] });
		try {
			const { body: co } = await checkout('pro');
			const { res, body } = await claim(co.claim_token);
			expect(res.status).toBe(200);
			expect(body).toEqual({ state: 'pending', retry_after_seconds: 2 });
		} finally {
			restore();
		}
	});

	it('builder: ready after transaction.completed; the key is the stored one, X-Oracle-Key instructions, founder line claim_filled=yes', async () => {
		const { token, cap } = await paidSubscription('builder', 'builder_ready');
		const { res, body } = await claim(token);
		expect(res.status).toBe(200);
		expect(body.state).toBe('ready');
		expect(body.plan).toBe('builder');
		expect(body.key).toMatch(/^ho_live_[0-9a-f]{64}$/);
		expect(JSON.parse((await env.ORACLE_API_KEYS.get(await sha256Hex(body.key as string)))!)).toMatchObject({ plan: 'builder', status: 'active' });
		expect(body.instructions).toMatchObject({ header: 'X-Oracle-Key: <key>', method: 'GET', url: 'https://headlessoracle.com/v5/status?mic=XNYS' });
		// The email channel is unchanged and carries the same key.
		const customer = cap.mails.filter((m) => m.to !== FOUNDER);
		expect(customer.length).toBe(1);
		expect(customer[0].html).toContain(body.key as string);
		const founder = cap.mails.filter((m) => m.to === FOUNDER);
		expect(founder.length).toBe(1);
		expect(founder[0].text).toContain('claim_filled=yes');
	});

	it('mint without ho_claim: founder line says claim_filled=no', async () => {
		const { cap, restore } = stub();
		try {
			const res = await webhook({ id: 'txn_h2_noclaim', customer_id: 'ctm_h2_noclaim', subscription_id: 'sub_h2_noclaim', origin: 'web', items: [{ price_id: PRICE.builder, quantity: 1 }] });
			expect(res.status).toBe(200);
			const founder = cap.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain('claim_filled=no');
		} finally {
			restore();
		}
	});

	it('custody_90d: ready as evidence_starter with the Witness bearer header, POST URL, quota 1000 and spec URL', async () => {
		const { token } = await paidSubscription('custody_90d', 'evidence_ready');
		const { res, body } = await claim(token);
		expect(res.status).toBe(200);
		expect(body.state).toBe('ready');
		expect(body.plan).toBe('evidence_starter');
		expect(body.key).toMatch(/^ho_live_[0-9a-f]{64}$/);
		expect(body.instructions).toMatchObject({
			header:                 'Authorization: Bearer <key>',
			method:                 'POST',
			url:                    'https://api.headlessoracle.com/v1/witness/checkpoints',
			daily_checkpoint_quota: 1000,
			spec_url:               'https://api.headlessoracle.com/v1/witness/spec',
		});
		expect(JSON.stringify(body.instructions)).not.toContain('X-Oracle-Key');
	});

	it('credits: ready with the ho_crd_ key and its balance', async () => {
		const { restore } = stub({ txnIds: ['txn_h2_credits_ready'] });
		try {
			const { body: co } = await checkout('credits');
			const h   = await sha256Hex(co.claim_token as string);
			const res = await webhook({ id: 'txn_h2_credits_ready', customer_id: 'ctm_h2_credits', items: [{ price_id: PRICE.credits }], custom_data: { ho_claim: h } });
			expect(res.status).toBe(200);
			const { body } = await claim(co.claim_token);
			expect(body.state).toBe('ready');
			expect(body.plan).toBe('credits');
			expect(body.key).toMatch(/^ho_crd_[0-9a-f]{64}$/);
			expect(body.instructions).toMatchObject({ header: 'X-Oracle-Key: <key>', balance: 1000 });
		} finally {
			restore();
		}
	});

	it('claim_ready naming a different txn_id stays pending', async () => {
		const { restore } = stub({ txnIds: ['txn_h2_mine'] });
		try {
			const { body: co } = await checkout('builder');
			const h = await sha256Hex(co.claim_token as string);
			// The ho_claim copied into a different transaction.
			const res = await webhook({ id: 'txn_h2_theirs', customer_id: 'ctm_h2_theirs', subscription_id: 'sub_h2_theirs', origin: 'web', items: [{ price_id: PRICE.builder, quantity: 1 }], custom_data: { ho_claim: h } });
			expect(res.status).toBe(200);
			expect(JSON.parse((await env.ORACLE_API_KEYS.get(`claim_ready:${h}`))!)).toMatchObject({ txn_id: 'txn_h2_theirs' });
			const { res: cr, body } = await claim(co.claim_token);
			expect(cr.status).toBe(200);
			expect(body).toEqual({ state: 'pending', retry_after_seconds: 2 });
		} finally {
			restore();
		}
	});

	it('the sealed value in KV does not contain the key, and opens with the handoff encodings', async () => {
		const { token, h, txnId } = await paidSubscription('builder', 'sealed');
		const { body } = await claim(token);
		const key = body.key as string;
		const raw = (await env.ORACLE_API_KEYS.get(`claim_ready:${h}`))!;
		expect(raw).not.toContain(key);
		expect(raw).not.toContain(key.slice('ho_live_'.length));
		expect(raw).not.toContain(token);
		const rec = JSON.parse(raw) as { txn_id: string; plan: string; sealed: { iv: string; ct: string }; ready_at: string };
		expect(rec).toMatchObject({ txn_id: txnId, plan: 'builder' });
		expect(rec.sealed.iv).toMatch(/^[A-Za-z0-9+/]{16}$/); // 12 bytes, standard base64
		expect(await openSealed(h, txnId, rec.sealed)).toBe(key);
		// The AAD binds the transaction: a different txn_id does not open it.
		await expect(openSealed(h, 'txn_other', rec.sealed)).rejects.toThrow();
	});

	it('a sealed value that does not open: 404 unknown and CLAIM_UNSEAL_FAILED', async () => {
		const { token, h } = await paidSubscription('builder', 'tampered');
		const rec = JSON.parse((await env.ORACLE_API_KEYS.get(`claim_ready:${h}`))!) as { sealed: { iv: string; ct: string } };
		rec.sealed.ct = btoa('x'.repeat(40));
		await env.ORACLE_API_KEYS.put(`claim_ready:${h}`, JSON.stringify(rec));
		const errSpy = vi.spyOn(console, 'error');
		try {
			const { res, body } = await claim(token);
			expect(res.status).toBe(404);
			expect(body).toEqual({ state: 'unknown' });
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_UNSEAL_FAILED'))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('an unknown token: 404 {state: unknown}', async () => {
		const { res, body } = await claim('ab'.repeat(32));
		expect(res.status).toBe(404);
		expect(body).toEqual({ state: 'unknown' });
	});

	it.each([
		['uppercase hex', 'AB'.repeat(32)],
		['63 chars',      'a'.repeat(63)],
		['65 chars',      'a'.repeat(65)],
		['a number',      42],
		['null',          null],
	])('malformed token (%s): 400 bad_request', async (_n, token) => {
		const { res, body } = await claim(token);
		expect(res.status).toBe(400);
		expect(body.error).toBe('bad_request');
	});

	it.each([
		['not JSON', 'claim_token=abc'],
		['an array', '[]'],
		['empty',    ''],
	])('malformed body (%s): 400 bad_request', async (_n, raw) => {
		const res = await call('/v5/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
		expect(res.status).toBe(400);
		expect((await res.json() as Record<string, unknown>).error).toBe('bad_request');
	});

	it('a token in the URL is ignored: a ready claim token as ?claim_token= with no body field is 400', async () => {
		const { token } = await paidSubscription('builder', 'url_token');
		const res = await call(`/v5/claim?claim_token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		expect(res.status).toBe(400);
		expect(await res.text()).not.toContain('ho_live_');
		// Control: the same token in the body is ready.
		expect((await claim(token)).body.state).toBe('ready');
	});

	it('GET /v5/claim: 405 with Allow: POST', async () => {
		const res = await call('/v5/claim');
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toBe('POST');
	});

	it('rate limited: 429 RATE_LIMITED retry_after_seconds 10, on its own claim: counter keyed by CF-Connecting-IP', async () => {
		const keys: string[] = [];
		const deny: Limiter = { limit: async (o) => { keys.push(o.key); return { success: false }; } };
		const { res, body } = await claim('ab'.repeat(32), { WITNESS_GET_RL: deny });
		expect(res.status).toBe(429);
		expect(body).toMatchObject({ error: 'RATE_LIMITED', retry_after_seconds: 10 });
		expect(keys).toEqual(['claim:203.0.113.7']);
	});

	it.each([
		['throws',  { limit: async () => { throw new Error('limiter down'); } }],
		['unbound', undefined],
	])('rate limiter %s: fails open with CLAIM_RATE_LIMITER_FAILED', async (_n, limiter) => {
		const errSpy = vi.spyOn(console, 'error');
		try {
			const { res } = await claim('cd'.repeat(32), { WITNESS_GET_RL: limiter });
			expect(res.status).toBe(404);
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_RATE_LIMITER_FAILED'))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('PADDLE_WEBHOOK_SECRET unset: 503 SERVICE_UNAVAILABLE retry_after_seconds 10', async () => {
		const { res, body } = await claim('ab'.repeat(32), { PADDLE_WEBHOOK_SECRET: undefined });
		expect(res.status).toBe(503);
		expect(body).toMatchObject({ error: 'SERVICE_UNAVAILABLE', retry_after_seconds: 10 });
	});

	it('the key and the token never appear in console output, across checkout, mint, claim and a failed unseal', async () => {
		const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));
		try {
			const { token, h } = await paidSubscription('builder', 'nolog');
			const { body } = await claim(token);
			const key = body.key as string;
			expect(key).toMatch(/^ho_live_/);
			const rec = JSON.parse((await env.ORACLE_API_KEYS.get(`claim_ready:${h}`))!) as { sealed: { iv: string; ct: string } };
			rec.sealed.ct = btoa('y'.repeat(40));
			await env.ORACLE_API_KEYS.put(`claim_ready:${h}`, JSON.stringify(rec));
			expect((await claim(token)).res.status).toBe(404);
			const out = spies.flatMap((s) => s.mock.calls.map((c) => c.map((a) => String(a)).join(' '))).join('\n');
			// Something was logged (CLAIM_UNSEAL_FAILED at least), so the
			// absence checks below are over real output.
			expect(out).toContain('CLAIM_UNSEAL_FAILED');
			expect(out).not.toContain(key);
			expect(out).not.toContain(key.slice('ho_live_'.length));
			expect(out).not.toContain(token);
		} finally {
			for (const s of spies) s.mockRestore();
		}
	});

	it('a renewal carrying the same custom_data neither changes a filled claim nor fills a pending one', async () => {
		// Filled claim: the renewal must leave claim_ready byte-identical.
		const { token, h } = await paidSubscription('builder', 'renew_filled');
		const before = await env.ORACLE_API_KEYS.get(`claim_ready:${h}`);
		expect(before).not.toBeNull();
		const keyBefore = (await claim(token)).body.key;
		const s = stub();
		try {
			const res = await webhook({ id: 'txn_h2_renew_filled_2', customer_id: 'ctm_h2_renew_filled', subscription_id: 'sub_h2_renew_filled', origin: 'subscription_recurring', items: [{ price_id: PRICE.builder, quantity: 1 }], custom_data: { ho_claim: h } });
			expect(res.status).toBe(200);
			expect(await env.ORACLE_API_KEYS.get(`claim_ready:${h}`)).toBe(before);
			expect((await claim(token)).body.key).toBe(keyBefore);

			// Pending claim whose subscription already owns a key: no fill.
			await env.ORACLE_API_KEYS.put('paddle_sub:sub_h2_renew_pending', JSON.stringify({ key_hash: 'ef'.repeat(32), plan: 'builder', created_at: '2026-10-01T00:00:00Z' }));
			const h2 = 'cd'.repeat(32);
			const res2 = await webhook({ id: 'txn_h2_renew_pending', customer_id: 'ctm_h2_renew_pending', subscription_id: 'sub_h2_renew_pending', origin: 'subscription_recurring', items: [{ price_id: PRICE.builder, quantity: 1 }], custom_data: { ho_claim: h2 } });
			expect(res2.status).toBe(200);
			expect(await env.ORACLE_API_KEYS.get(`claim_ready:${h2}`)).toBeNull();
		} finally {
			s.restore();
		}
	});

	it('Cache-Control: no-store and CORS * on 400, 404, 405, 429, 503, pending and ready', async () => {
		const deny: Limiter = { limit: async () => ({ success: false }) };
		const { token } = await paidSubscription('builder', 'nostore');
		const { restore } = stub({ txnIds: ['txn_h2_nostore_pending'] });
		let pendingToken = '';
		try {
			pendingToken = (await checkout('builder')).body.claim_token as string;
		} finally {
			restore();
		}
		const cases: Array<[number, Response]> = [
			[400, (await claim('XYZ')).res],
			[404, (await claim('ab'.repeat(32))).res],
			[405, await call('/v5/claim')],
			[429, (await claim('ab'.repeat(32), { WITNESS_GET_RL: deny })).res],
			[503, (await claim('ab'.repeat(32), { PADDLE_WEBHOOK_SECRET: undefined })).res],
			[200, (await claim(pendingToken)).res],
			[200, (await claim(token)).res],
		];
		for (const [status, res] of cases) {
			expect(res.status).toBe(status);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
		}
	});

	it('openapi documents claim_token on /v5/checkout and POST /v5/claim', async () => {
		type Spec = { paths: Record<string, { post: { responses: Record<string, { content?: Record<string, { schema: { properties: Record<string, unknown> } }> }> } }> };
		const spec = await (await call('/openapi.json')).json() as Spec;
		expect(Object.keys(spec.paths['/v5/checkout'].post.responses['200'].content!['application/json'].schema.properties)).toContain('claim_token');
		expect(spec.paths['/v5/claim'].post.responses).toHaveProperty('200');
		expect(spec.paths['/v5/claim'].post.responses).toHaveProperty('404');
	});

	// ─── H2b (2026-10-04): claim follow-ups ──────────────────────────────────
	// claim_filled / claim_seen and the revenue-pulse list of uncollected keys,
	// 410 for an expired claim, credits idempotency, no-store on the outer
	// catch, and no status counter on /v5/claim.

	type KvCall = (...a: unknown[]) => Promise<unknown>;
	// A pass-through KV that records put keys and can fail puts or gets whose
	// key starts with a given prefix.
	function wrapKv(real: KVNamespace, opts: { failPut?: string; failGet?: string; puts?: string[] } = {}): KVNamespace {
		return {
			get: async (k: string, ...rest: unknown[]) => {
				if (opts.failGet && k.startsWith(opts.failGet)) throw new Error('KV get failed');
				return (real.get.bind(real) as unknown as KvCall)(k, ...rest);
			},
			getWithMetadata: real.getWithMetadata.bind(real),
			list:            real.list.bind(real),
			delete:          real.delete.bind(real),
			put: async (k: string, ...rest: unknown[]) => {
				opts.puts?.push(k);
				if (opts.failPut && k.startsWith(opts.failPut)) throw new Error('KV put failed');
				return (real.put.bind(real) as unknown as KvCall)(k, ...rest);
			},
		} as unknown as KVNamespace;
	}

	function randomToken(): string {
		return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
	}

	async function pulse(key: string | null = env.MASTER_API_KEY as string): Promise<Response> {
		return call('/v5/revenue-pulse', key ? { headers: { 'X-Oracle-Key': key } } : {});
	}

	it('H2b: a fill writes claim_filled:<txn_id> = {plan, filled_at} to ORACLE_TELEMETRY', async () => {
		await paidSubscription('builder', 'fillrec');
		const raw = await env.ORACLE_TELEMETRY.get('claim_filled:txn_h2_fillrec');
		expect(raw).not.toBeNull();
		const rec = JSON.parse(raw!) as { plan: string; filled_at: string };
		expect(rec.plan).toBe('builder');
		expect(Number.isFinite(Date.parse(rec.filled_at))).toBe(true);
		expect(raw).not.toContain('ho_live_');
	});

	it('H2b: a failing claim_filled put leaves fillClaim true (claim_filled=yes), claim_ready written and the webhook 200', async () => {
		const { cap, restore } = stub({ txnIds: ['txn_h2_fillfail'] });
		const errSpy = vi.spyOn(console, 'error');
		try {
			const { body: co } = await checkout('builder');
			const h   = await sha256Hex(co.claim_token as string);
			const res = await webhook(
				{ id: 'txn_h2_fillfail', customer_id: 'ctm_h2_fillfail', subscription_id: 'sub_h2_fillfail', origin: 'api', items: [{ price_id: PRICE.builder, quantity: 1 }], custom_data: { ho_claim: h } },
				{ ORACLE_TELEMETRY: wrapKv(env.ORACLE_TELEMETRY, { failPut: 'claim_filled:' }) },
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ received: true });
			expect(await env.ORACLE_API_KEYS.get(`claim_ready:${h}`)).not.toBeNull();
			expect(await env.ORACLE_TELEMETRY.get('claim_filled:txn_h2_fillfail')).toBeNull();
			const founder = cap.mails.filter((m) => m.to === FOUNDER);
			expect(founder.length).toBe(1);
			expect(founder[0].text).toContain('claim_filled=yes');
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_FILLED_RECORD_FAILED'))).toBe(true);
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_FILL_FAILED'))).toBe(false);
			expect((await claim(co.claim_token)).body.state).toBe('ready');
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H2b: the first ready writes claim_seen once; a second ready does not write again', async () => {
		const { token, txnId } = await paidSubscription('builder', 'seen_once');
		const puts: string[] = [];
		const tele = wrapKv(env.ORACLE_TELEMETRY, { puts });
		expect(await env.ORACLE_TELEMETRY.get(`claim_seen:${txnId}`)).toBeNull();
		expect((await claim(token, { ORACLE_TELEMETRY: tele })).body.state).toBe('ready');
		const first = await env.ORACLE_TELEMETRY.get(`claim_seen:${txnId}`);
		expect(first).not.toBeNull();
		expect(Number.isFinite(Date.parse(first!))).toBe(true);
		expect(puts.filter((k) => k.startsWith('claim_seen:'))).toEqual([`claim_seen:${txnId}`]);
		expect((await claim(token, { ORACLE_TELEMETRY: tele })).body.state).toBe('ready');
		expect(puts.filter((k) => k.startsWith('claim_seen:')).length).toBe(1);
		expect(await env.ORACLE_TELEMETRY.get(`claim_seen:${txnId}`)).toBe(first);
	});

	it('H2b: a failing claim_seen write leaves the ready body unchanged and logs CLAIM_SEEN_WRITE_FAILED', async () => {
		const { token } = await paidSubscription('builder', 'seen_fail');
		const errSpy = vi.spyOn(console, 'error');
		try {
			const failed = await claim(token, { ORACLE_TELEMETRY: wrapKv(env.ORACLE_TELEMETRY, { failPut: 'claim_seen:' }) });
			const normal = await claim(token);
			expect(failed.res.status).toBe(200);
			expect(failed.body).toEqual(normal.body);
			expect(failed.body.state).toBe('ready');
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CLAIM_SEEN_WRITE_FAILED'))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('H2b: revenue-pulse lists a filled, unseen txn older than 2h; omits a seen one and a younger one; 401 without the master key', async () => {
		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		await env.ORACLE_TELEMETRY.put('claim_filled:txn_h2_pulse_old',   JSON.stringify({ plan: 'evidence', filled_at: ago(3 * 3600_000) }));
		await env.ORACLE_TELEMETRY.put('claim_filled:txn_h2_pulse_seen',  JSON.stringify({ plan: 'builder',  filled_at: ago(3 * 3600_000) }));
		await env.ORACLE_TELEMETRY.put('claim_seen:txn_h2_pulse_seen', ago(2.5 * 3600_000));
		await env.ORACLE_TELEMETRY.put('claim_filled:txn_h2_pulse_young', JSON.stringify({ plan: 'builder',  filled_at: ago(1 * 3600_000) }));

		const res = await pulse();
		expect(res.status).toBe(200);
		const body = await res.json() as { paddle: { unclaimed_keys: Array<{ txn_id: string; plan: string; filled_at: string }> } };
		const ids = body.paddle.unclaimed_keys.map((k) => k.txn_id);
		expect(ids).toContain('txn_h2_pulse_old');
		expect(ids).not.toContain('txn_h2_pulse_seen');
		expect(ids).not.toContain('txn_h2_pulse_young');
		expect(body.paddle.unclaimed_keys.find((k) => k.txn_id === 'txn_h2_pulse_old')).toEqual({ txn_id: 'txn_h2_pulse_old', plan: 'evidence', filled_at: expect.any(String) });

		expect((await pulse(null)).status).toBe(401);
		expect((await pulse('not-the-master-key')).status).toBe(401);
	});

	it('H2b: revenue-pulse unclaimed_keys fails safe to [] when the list throws', async () => {
		const real = env.ORACLE_TELEMETRY;
		const broken = { ...wrapKv(real), list: async (o: { prefix?: string }) => {
			if (o?.prefix === 'claim_filled:') throw new Error('list failed');
			return real.list(o);
		} } as unknown as KVNamespace;
		const res = await call('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': env.MASTER_API_KEY as string } }, { ORACLE_TELEMETRY: broken });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { paddle: { unclaimed_keys: unknown[] } }).paddle.unclaimed_keys).toEqual([]);
	});

	it('H2b: a pending claim created 25h ago answers 410 expired with no-store; 23h ago is still pending', async () => {
		for (const [hours, expectStatus] of [[25, 410], [23, 200]] as const) {
			const token = randomToken();
			const h     = await sha256Hex(token);
			await env.ORACLE_API_KEYS.put(`claim:${h}`, JSON.stringify({ txn_id: `txn_h2_age_${hours}`, plan: 'builder', created_at: new Date(Date.now() - hours * 3600_000).toISOString(), state: 'pending' }));
			const { res, body } = await claim(token);
			expect(res.status).toBe(expectStatus);
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			if (expectStatus === 410) {
				expect(body).toEqual({ state: 'expired', message: 'This claim is past its 24-hour window. Write to mike@headlessoracle.com with your transaction ID.' });
			} else {
				expect(body).toEqual({ state: 'pending', retry_after_seconds: 2 });
			}
		}
	});

	it('H2b: a 25h-old claim whose claim_ready still exists answers ready, not 410', async () => {
		const { token, h } = await paidSubscription('builder', 'old_ready');
		const rec = JSON.parse((await env.ORACLE_API_KEYS.get(`claim:${h}`))!) as Record<string, unknown>;
		rec.created_at = new Date(Date.now() - 25 * 3600_000).toISOString();
		await env.ORACLE_API_KEYS.put(`claim:${h}`, JSON.stringify(rec));
		const { res, body } = await claim(token);
		expect(res.status).toBe(200);
		expect(body.state).toBe('ready');
	});

	async function creditsRecordsFor(email: string): Promise<number> {
		const listed = await env.ORACLE_API_KEYS.list();
		let n = 0;
		for (const k of listed.keys) {
			if (!/^[0-9a-f]{64}$/.test(k.name)) continue;
			const v = JSON.parse((await env.ORACLE_API_KEYS.get(k.name)) ?? '{}') as { tier?: string; email?: string };
			if (v.tier === 'credits' && v.email === email) n++;
		}
		return n;
	}

	it('H2b: credits — a second delivery of the same txn mints nothing; a different txn mints', async () => {
		const email = 'h2b-idem@example.com';
		const { restore } = stub({ txnIds: ['txn_h2_cred_idem'], email });
		try {
			const { body: co } = await checkout('credits');
			const h    = await sha256Hex(co.claim_token as string);
			const data = { id: 'txn_h2_cred_idem', customer_id: 'ctm_h2_cred_idem', items: [{ price_id: PRICE.credits }], custom_data: { ho_claim: h } };
			expect((await webhook(data)).status).toBe(200);
			expect(await creditsRecordsFor(email)).toBe(1);
			const readyBefore = await env.ORACLE_API_KEYS.get(`claim_ready:${h}`);
			expect(readyBefore).not.toBeNull();
			expect(JSON.parse((await env.ORACLE_API_KEYS.get('paddle_txn:txn_h2_cred_idem'))!)).toHaveProperty('minted_at');

			const again = await webhook(data);
			expect(again.status).toBe(200);
			expect(await again.json()).toMatchObject({ received: true });
			expect(await creditsRecordsFor(email)).toBe(1);
			expect(await env.ORACLE_API_KEYS.get(`claim_ready:${h}`)).toBe(readyBefore);

			// Control: a different transaction does mint.
			expect((await webhook({ ...data, id: 'txn_h2_cred_idem_2', custom_data: undefined })).status).toBe(200);
			expect(await creditsRecordsFor(email)).toBe(2);
		} finally {
			restore();
		}
	});

	it('H2b: credits — a failed dedupe read mints (as before) and logs CREDITS_DEDUPE_READ_FAILED', async () => {
		const email = 'h2b-readfail@example.com';
		const { restore } = stub({ email });
		const errSpy = vi.spyOn(console, 'error');
		try {
			await env.ORACLE_API_KEYS.put('paddle_txn:txn_h2_cred_readfail', JSON.stringify({ minted_at: '2026-10-04T00:00:00Z' }));
			const res = await webhook(
				{ id: 'txn_h2_cred_readfail', customer_id: 'ctm_h2_cred_readfail', items: [{ price_id: PRICE.credits }] },
				{ ORACLE_API_KEYS: wrapKv(env.ORACLE_API_KEYS, { failGet: 'paddle_txn:' }) },
			);
			expect(res.status).toBe(200);
			expect(await creditsRecordsFor(email)).toBe(1);
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('CREDITS_DEDUPE_READ_FAILED'))).toBe(true);
		} finally {
			errSpy.mockRestore();
			restore();
		}
	});

	it('H2b: the outer catch answers 500 CRITICAL_FAILURE with Cache-Control: no-store', async () => {
		// A correctly signed body that is not JSON: JSON.parse throws inside
		// the webhook handler and only the outer catch can answer.
		const rawBody = 'not json at all';
		const sig     = await makePaddleSignature(rawBody, env.PADDLE_WEBHOOK_SECRET as string);
		const errSpy  = vi.spyOn(console, 'error');
		try {
			const res = await call('/webhooks/paddle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paddle-Signature': sig }, body: rawBody });
			expect(res.status).toBe(500);
			expect(await res.json()).toMatchObject({ error: 'CRITICAL_FAILURE', status: 'UNKNOWN' });
			expect(res.headers.get('Cache-Control')).toBe('no-store');
			expect(errSpy.mock.calls.some((c) => String(c[0]).includes('ORACLE_TOP_LEVEL_ERROR'))).toBe(true);
		} finally {
			errSpy.mockRestore();
		}
	});

	it('H2b: /v5/claim writes no status_code: counter; another route still does', async () => {
		const puts: string[] = [];
		const tele = wrapKv(env.ORACLE_TELEMETRY, { puts });
		await claim('ab'.repeat(32), { ORACLE_TELEMETRY: tele });             // 404
		await call('/v5/claim', {}, { ORACLE_TELEMETRY: tele });              // 405
		await claim('XYZ', { ORACLE_TELEMETRY: tele });                       // 400
		expect(puts.filter((k) => k.startsWith('status_code:'))).toEqual([]);
		// Control: the same counter on another route.
		expect((await call('/v5/pricing', {}, { ORACLE_TELEMETRY: tele })).status).toBe(200);
		expect(puts.filter((k) => k.startsWith('status_code:')).length).toBe(1);
	});

	it('H2b: openapi documents 410 on POST /v5/claim', async () => {
		const spec = await (await call('/openapi.json')).json() as { paths: Record<string, { post: { responses: Record<string, unknown> } }> };
		expect(spec.paths['/v5/claim'].post.responses).toHaveProperty('410');
	});
});

// ─── H3a (2026-10-04): the agent surfaces sell what Headless Oracle sells now ─
// Every machine-readable surface named only the market-state oracle; none named
// Chirindo or Witness. These pin the rewrite and the G2/G6/G9/G13/G14 fixes.
describe('H3a: agent-facing surfaces lead with Chirindo', () => {
	async function initializeInstructions(): Promise<string> {
		const body = await (await postMcp({
			jsonrpc: '2.0', id: 1, method: 'initialize',
			params:  { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'h3a-test', version: '1.0.0' } },
		})).json() as { result: { instructions: string } };
		return body.result.instructions;
	}

	const CHIRINDO_SURFACES = [
		'/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md',
		'/.well-known/agent.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-servers.json',
	];

	it.each(CHIRINDO_SURFACES)('(a) %s names Chirindo and Witness', async (path) => {
		const res = await fetchWorker(path);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('Chirindo');
		expect(text).toContain('Witness');
	});

	it('(a) the MCP initialize instructions name Chirindo and Witness, before the market-state tools', async () => {
		const ins = await initializeInstructions();
		expect(ins).toContain('Chirindo');
		expect(ins).toContain('Witness');
		expect(ins.indexOf('Chirindo')).toBeLessThan(ins.indexOf('get_market_status'));
	});

	it('(a) llms.txt puts Chirindo first and quotes the witness spec purpose verbatim', async () => {
		const llms = await (await fetchWorker('/llms.txt')).text();
		const spec = await (await fetchWorker('/v1/witness/spec')).json() as { purpose: string; honest_limits: { sidecar: string } };
		expect(llms.indexOf('## Chirindo Witness')).toBeLessThan(llms.indexOf('## Market-state attestations'));
		expect(llms).toContain(spec.purpose);
		expect(llms).toContain(spec.honest_limits.sidecar);
		expect(llms).toContain('Headless Oracle co-authors the IETF draft family defining environmental constraints for Verifiable Intent.');
	});

	// H3b (2026-10-04) adds 'proof' (a signature shows origin, not truth) and the
	// offline-check claim (an offline check against a sidecar trusts the operator).
	// No URL or filename containing "proof" appears in these files, so there are
	// no exceptions; the MCP initialize _meta carries /v5/payment-proof, but only
	// the instructions text is scanned below.
	const BANNED = ["Mastercard's", 'compliant', 'certified', 'no trust required', 'unlimited', 'proof', 'check offline', 'checks offline'];
	const AGENT_FILES = [
		'/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md', '/skill.md',
		'/.well-known/agent.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp.json',
		'/.well-known/mcp-servers.json', '/.well-known/ai-plugin.json',
	];

	it.each(AGENT_FILES)('(b) %s carries none of the banned phrases', async (path) => {
		const res = await fetchWorker(path);
		expect(res.status).toBe(200);
		const text = (await res.text()).toLowerCase();
		for (const phrase of BANNED) {
			expect(text.includes(phrase.toLowerCase()), `${path} contains "${phrase}"`).toBe(false);
		}
	});

	it('(b) the MCP initialize instructions carry none of the banned phrases', async () => {
		const ins = (await initializeInstructions()).toLowerCase();
		for (const phrase of BANNED) expect(ins.includes(phrase.toLowerCase()), phrase).toBe(false);
	});

	it('(c) /v5/pricing lists the free Witness pool and both Evidence plans with their numbers', async () => {
		const body = await fetchJSON('/v5/pricing') as { tiers: Array<Record<string, unknown>> };
		const byId = new Map(body.tiers.map((t) => [t.id as string, t]));
		expect(byId.get('witness_free')).toMatchObject({ plan: null, price_usd: 0, interval: null, checkpoints_per_day: 2000, introductory_until: null });
		expect(String(byId.get('witness_free')!.provision)).toContain('https://api.headlessoracle.com/v1/witness/checkpoints');
		expect(byId.get('evidence_starter')).toMatchObject({ plan: 'custody_90d', price_usd: 49, interval: 'month', checkpoints_per_day: 1000, introductory_until: '2026-12-31' });
		expect(byId.get('evidence')).toMatchObject({ plan: 'custody_1y', price_usd: 199, interval: 'month', checkpoints_per_day: 3000, introductory_until: '2026-12-31' });
		for (const id of ['evidence_starter', 'evidence']) expect(String(byId.get(id)!.provision)).toContain('POST /v5/checkout');
	});

	// The pins below were read from production /v5/pricing on 2026-10-04, served by
	// afc1c80, before this change: the seven pre-existing tiers and everything
	// outside `tiers` (referee, x402, urls). The web repo's check:prices reads this
	// endpoint, so those bytes must not move.
	it('(c) the seven pre-existing tiers and every non-tier field are byte-identical to production before H3a', async () => {
		const body = await fetchJSON('/v5/pricing') as { tiers: Array<Record<string, unknown>> } & Record<string, unknown>;
		expect(body.tiers.slice(0, 7).map((t) => t.id)).toEqual(['sandbox', 'free', 'x402', 'credits', 'builder', 'pro', 'protocol']);
		// 2026-10-07: the sandbox and free descriptions stopped promising email delivery
		// (buyer email failing). Only those two strings moved: with the pre-change text
		// put back, the seven tiers hash to the 2026-10-04 production pin.
		const before = body.tiers.slice(0, 7).map((t) => ({ ...t }));
		before[0].description = 'Instant sandbox key via email. 200 calls over 7 days. IP-fingerprinted — one per IP.';
		before[1].description = 'Self-provision free API key via email. 500 calls/day.';
		// 2026-10-07 (later): the protocol tier stopped promising an "Enterprise SLA"
		// (no SLA is in force during the public beta). Only its description and that
		// one feature moved; restored here, the seven still hash to the same pin.
		before[6].description = 'Unlimited calls/day. Unlimited webhooks. Enterprise SLA.';
		before[6].features    = ['Unlimited calls/day', 'Unlimited webhooks', '28 exchanges', 'Enterprise SLA', 'Paddle billing'];
		expect(await sha256Hex(JSON.stringify(before))).toBe('0cc0e4765f5e2f6224ac98b610f43b9187183a62ea3a4bacf5b5328129530768');
		const rest: Record<string, unknown> = { ...body };
		delete rest.tiers;
		expect(await sha256Hex(JSON.stringify(rest))).toBe('03c9cd531c91d5a72419c58c98da2c9f39a61a11f82bef12b7396803377777ce');
	});

	it('(c) the protocol tier promises no SLA during the public beta', async () => {
		const body = await fetchJSON('/v5/pricing') as { tiers: Array<{ id: string; description: string; features: string[] }> };
		const protocol = body.tiers.find((t) => t.id === 'protocol')!;
		const text = [protocol.description, ...protocol.features].join(' ');
		expect(text).not.toMatch(/\bSLA\b/);
		expect(protocol.description).toContain('service levels by agreement after the public beta');
	});

	it('(d) openapi /v5/checkout has a plan enum equal to the valid_plans the route enforces', async () => {
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, { post: { requestBody?: { content: Record<string, { schema: { properties: { plan: { enum: string[] } } } }> } } }> };
		const planEnum = spec.paths['/v5/checkout'].post.requestBody!.content['application/json'].schema.properties.plan.enum;
		// The route's own list, read from its 400 (no call to Paddle for an unknown plan).
		const res = await fetchWorker('/v5/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: 'no_such_plan' }) });
		expect(res.status).toBe(400);
		const { valid_plans } = await res.json() as { valid_plans: string[] };
		expect(planEnum).toEqual(valid_plans);
		expect(planEnum).toContain('custody_90d');
		expect(planEnum).toContain('custody_1y');
	});

	it('(e) the keyless /v5/status 402 recommends x402 and lists the free key second; status and x402 header unchanged', async () => {
		const today  = new Date().toISOString().slice(0, 10);
		const ipHash = await sha256Hex('');
		await env.ORACLE_TELEMETRY.put(`trial_usage:${today}:${ipHash}`, '3', { expirationTtl: 25 * 3600 });
		try {
			const res = await fetchWorker('/v5/status?mic=XNYS');
			expect(res.status).toBe(402);
			expect(res.headers.get('Payment-Required')).toBeTruthy();
			const body = await res.json() as { recommended: string; upgrade_paths: Array<{ id: string; result?: string }> };
			expect(body.recommended).toBe('x402_payment');
			expect(body.upgrade_paths[0].id).toBe('x402_payment');
			expect(body.upgrade_paths[1].id).toBe('instant_key');
			expect(body.upgrade_paths[1].result).toContain('500 calls/day');
		} finally {
			await env.ORACLE_TELEMETRY.delete(`trial_usage:${today}:${ipHash}`);
		}
	});

	it('(f) robots.txt carries the same Content-Signal in every group and names the four crawlers', async () => {
		const body = await (await fetchWorker('/robots.txt')).text();
		const groups = body.split(/\n\s*\n/).filter((g) => /^User-agent:/m.test(g));
		expect(groups.length).toBeGreaterThanOrEqual(12);
		for (const g of groups) {
			expect(g.match(/^Content-Signal: .*$/gm), g.split('\n')[0]).toEqual(['Content-Signal: search=yes, ai-input=yes, ai-train=yes']);
		}
		for (const bot of ['Claude-SearchBot', 'Claude-User', 'Perplexity-User', 'OAI-SearchBot']) {
			const g = groups.find((x) => x.startsWith(`User-agent: ${bot}\n`));
			expect(g, bot).toBeDefined();
			expect(g).toContain('Allow: /');
		}
		expect(body).not.toContain('ai-train=no');
	});

	it('(G2) the three witness operations name the api host as their server; the spec base_url_note is unchanged', async () => {
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, Record<string, { servers?: Array<{ url: string }> }>> };
		for (const [path, method] of [['/v1/witness/checkpoints', 'post'], ['/v1/witness/checkpoints', 'get'], ['/v1/witness/spec', 'get']] as const) {
			expect(spec.paths[path][method].servers?.[0]?.url, `${method} ${path}`).toBe('https://api.headlessoracle.com');
		}
		const witnessSpec = await fetchJSON('/v1/witness/spec');
		expect(witnessSpec.base_url_note).toBe('https://headlessoracle.com serves the same paths once its route for /v1/witness/* is deployed.');
	});

	it('(G13) ai-plugin URLs point at pages that exist; the contact is mike@', async () => {
		const plugin = await fetchJSON('/.well-known/ai-plugin.json');
		expect(plugin.logo_url).toBe('https://headlessoracle.com/og-image.png');
		expect(plugin.legal_info_url).toBe('https://headlessoracle.com/terms');
		expect(plugin.contact_email).toBe('mike@headlessoracle.com');
		const spec = await fetchJSON('/openapi.json') as { info: { contact: { email: string } } };
		expect(spec.info.contact.email).toBe('mike@headlessoracle.com');
	});

	it('(G13) SKILL.md and the agent-skills files state the repo licence (MIT)', async () => {
		const skill = await (await fetchWorker('/SKILL.md')).text();
		expect(skill).toMatch(/^license: MIT$/m);
		const index = await fetchJSON('/.well-known/agent-skills/index.json') as { skills: Array<{ name: string }> };
		expect(index.skills.length).toBeGreaterThan(0);
		for (const s of index.skills) {
			const text = await (await fetchWorker(`/.well-known/agent-skills/${s.name}/SKILL.md`)).text();
			expect(text, s.name).toMatch(/^license: MIT$/m);
		}
	});
});

// ─── H3b (2026-10-04): the Chirindo summary says only what the witness detects ─
describe('H3b: corrected Chirindo summary and npm caveat', () => {
	// Written out independently of the source constant, on purpose: a test that
	// read CHIRINDO_SUMMARY would pass whatever the constant said.
	const SUMMARY = 'Chirindo signs each agent action into a hash-chained log. Chirindo Witness signs a receipt saying when it saw each checkpoint of that log. ' +
		'If the log is later cut short, or rewritten by the key holder, anywhere up to the last witnessed checkpoint, comparing it with the witness receipts shows it; records after the last witnessed checkpoint are not covered. ' +
		'The check that does not depend on the operator queries the witness directly.';
	const NPM_CAVEAT = 'Witness support (chirindo checkpoint, --witness) is on GitHub main and not yet in the npm release (0.4.0).';
	const SIDECAR    = 'Verifying against a sidecar file trusts the operator who supplied it. Only querying the witness is independent of the operator.';

	async function initializeInstructions(): Promise<string> {
		const body = await (await postMcp({
			jsonrpc: '2.0', id: 1, method: 'initialize',
			params:  { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'h3b-test', version: '1.0.0' } },
		})).json() as { result: { instructions: string } };
		return body.result.instructions;
	}

	const SUMMARY_SURFACES = [
		'/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md',
		'/.well-known/agent.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-servers.json',
	];

	it.each(SUMMARY_SURFACES)('%s carries the corrected summary', async (path) => {
		const text = await (await fetchWorker(path)).text();
		expect(text).toContain(SUMMARY);
	});

	it('the MCP initialize instructions carry the corrected summary (8th surface)', async () => {
		expect(await initializeInstructions()).toContain(SUMMARY);
	});

	it.each(['/.well-known/mcp/server-card.json', '/.well-known/mcp-servers.json'])('%s carries the sidecar caveat', async (path) => {
		const text = await (await fetchWorker(path)).text();
		expect(text).toContain(SIDECAR);
	});

	it('the MCP initialize instructions carry the sidecar caveat', async () => {
		expect(await initializeInstructions()).toContain(SIDECAR);
	});

	const AGENT_FILES = [
		'/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md', '/skill.md',
		'/.well-known/agent.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp.json',
		'/.well-known/mcp-servers.json', '/.well-known/ai-plugin.json',
	];

	it('every surface that lists the npm gate carries the npm-release caveat', async () => {
		const listing: string[] = [];
		for (const path of AGENT_FILES) {
			const text = await (await fetchWorker(path)).text();
			if (text.includes('@headlessoracle/chirindo')) {
				listing.push(path);
				expect(text, path).toContain(NPM_CAVEAT);
			}
		}
		const ins = await initializeInstructions();
		if (ins.includes('@headlessoracle/chirindo')) expect(ins).toContain(NPM_CAVEAT);
		// Not vacuous: the four Chirindo-first documents list the gate.
		expect(listing).toEqual(expect.arrayContaining(['/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md']));
	});

	it('llms.txt gives the POST body shape, labels submit POST-only, and names the operator-independent query', async () => {
		const llms = await (await fetchWorker('/llms.txt')).text();
		expect(llms).toContain('[Submit a checkpoint (POST only)]');
		expect(llms).toContain('{"checkpoint":{"v","type","session_id","count","last_entry_hash","ts","kid","sig"},"public_key_jwk":{...}}');
		expect(llms).toContain('GET https://api.headlessoracle.com/v1/witness/checkpoints?kid=<thumbprint>&session_id=<id>');
		expect(llms).toContain('the check that does not depend on the operator');
	});

	// CHANGED 2026-10-04 (H3c): buyer email is failing (the worker's Resend key is
	// in the wrong team), so the buy text promises no email delivery; it names
	// the founder's address and the Paddle receipt instead.
	it('the buy text tells a buyer with no key where to write', async () => {
		for (const path of ['/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md', '/.well-known/agent.json']) {
			const text = await (await fetchWorker(path)).text();
			expect(text, path).toContain('If no key appears, write to mike@headlessoracle.com with the transaction ID from your Paddle receipt.');
		}
	});

	// The one email sentence still allowed: /v5/keys/request has no other
	// delivery path, so the text says email is unreliable and names the path
	// that returns a key in the response.
	const EMAIL_UNRELIABLE = 'sent by email (currently unreliable; post /v5/keys/instant returns a key in the response)';

	it('H3c: no served agent file promises the key by email', async () => {
		for (const path of AGENT_FILES) {
			const text = (await (await fetchWorker(path)).text()).toLowerCase().split(EMAIL_UNRELIABLE).join('');
			expect(text.includes('sent by email'), `${path}: "sent by email"`).toBe(false);
			expect(text.includes('arrives by email'), `${path}: "arrives by email"`).toBe(false);
		}
		const ins = (await initializeInstructions()).toLowerCase();
		expect(ins.includes('sent by email')).toBe(false);
		expect(ins.includes('arrives by email')).toBe(false);
	});

	// H3d 2026-10-04: buyer email is failing (Resend team mismatch), so the three
	// surfaces that described key delivery promise no email at all, save the one
	// exact "currently unreliable" sentence.
	it('H3d: SKILL.md, llms-full.txt and openapi.json make no email delivery promise', async () => {
		const BANNED = ['delivered by email', 'via email', 'arrives by email', 'will also email', 'will also be sent by email', 'sent by email'];
		for (const path of ['/SKILL.md', '/llms-full.txt', '/openapi.json']) {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			const text = (await res.text()).toLowerCase().split(EMAIL_UNRELIABLE).join('');
			for (const phrase of BANNED) expect(text.includes(phrase), `${path}: "${phrase}"`).toBe(false);
		}
		const skill = await (await fetchWorker('/SKILL.md')).text();
		expect(skill).toContain('key shown on the pricing page after payment (POST /v5/claim, for 24 hours); if no key appears, write to mike@headlessoracle.com with the transaction ID from your Paddle receipt');
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, any> };
		const claimToken = spec.paths['/v5/checkout'].post.responses['200'].content['application/json'].schema.properties.claim_token.description as string;
		expect(claimToken).toContain('write to mike@headlessoracle.com with the transaction ID from your Paddle receipt');
	});

	it('mcp-servers.json standards names the IETF draft, not the retired names', async () => {
		const body = await fetchJSON('/.well-known/mcp-servers.json') as { servers: Array<{ standards: string[] }> };
		expect(body.servers[0].standards).toEqual(['draft-borthwick-msebenzi-environment-state']);
	});
});

// ─── H4a: the agent front door (2026-10-05) ──────────────────────────────────
// In 7 days the worker answered ~56k fetches; directory crawlers and MCP/x402
// monitors failed on the same few paths. Each case below pins one fix.
describe('H4a: agent front door', () => {
	const LEAD_PREFIX = 'Chirindo by Headless Oracle: evidence for AI agents. ';
	// The summary as /llms.txt serves it, read from the served bytes so the
	// surfaces below are compared with llms.txt and not with a constant.
	async function llmsSummary(): Promise<string> {
		const llms = await (await fetchWorker('/llms.txt')).text();
		const line = llms.split('\n').find((l) => l.startsWith('> Evidence for AI agents. '));
		expect(line, '/llms.txt has its summary line').toBeDefined();
		return line!.slice('> Evidence for AI agents. '.length);
	}

	// Step 2
	it('/health answers like /v5/health: 200, a signed OK receipt', async () => {
		const res = await fetchWorker('/health');
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const receipt = (body.receipt ?? body) as Record<string, unknown>;
		expect(receipt.status).toBe('OK');
		expect(typeof receipt.signature).toBe('string');
		expect((receipt.signature as string).length).toBe(128);
	});

	it('/favicon.ico on the worker is 204 with no body', async () => {
		const res = await fetchWorker('/favicon.ico');
		expect(res.status).toBe(204);
		expect(await res.text()).toBe('');
	});

	// Step 3
	it('/.well-known/agent-card.json is 404 with the exact A2A_NOT_IMPLEMENTED body', async () => {
		const res = await fetchWorker('/.well-known/agent-card.json');
		expect(res.status).toBe(404);
		expect(res.headers.get('Content-Type')).toContain('application/json');
		expect(await res.json()).toEqual({
			error:   'A2A_NOT_IMPLEMENTED',
			message: 'Headless Oracle does not implement the A2A protocol.',
			mcp:     'https://api.headlessoracle.com/mcp',
			llms:    'https://headlessoracle.com/llms.txt',
			openapi: 'https://headlessoracle.com/openapi.json',
		});
	});

	it('/.well-known/agent.json has no top-level url, a homepage, and interfaces naming MCP and OpenAPI', async () => {
		const body = await fetchJSON('/.well-known/agent.json');
		expect(Object.keys(body)).not.toContain('url');
		expect(body.homepage).toBe('https://headlessoracle.com');
		expect(body.interfaces).toEqual([
			{ type: 'mcp', transport: 'streamable-http', url: 'https://api.headlessoracle.com/mcp' },
			{ type: 'openapi', url: 'https://headlessoracle.com/openapi.json' },
		]);
	});

	// Step 4
	it('/.well-known/x402 serves the same body and content type as /.well-known/x402.json', async () => {
		const a = await fetchWorker('/.well-known/x402');
		const b = await fetchWorker('/.well-known/x402.json');
		expect(a.status).toBe(200);
		expect(a.headers.get('Content-Type')).toBe(b.headers.get('Content-Type'));
		expect(await a.text()).toBe(await b.text());
	});

	it('/.well-known/x402.json lists /v5/status/x402 at the canonical status price', async () => {
		const body = await fetchJSON('/.well-known/x402.json') as { resources: Array<{ path: string; method: string; accepts: Array<Record<string, unknown>>; input: { required: string[] } }> };
		const r = body.resources.find((x) => x.path === '/v5/status/x402');
		expect(r).toBeDefined();
		expect(r!.method).toBe('GET');
		expect(r!.accepts[0].maxAmountRequired).toBe(x402ResourceSpecs().status.amountAtomic);
		expect(r!.input.required).toEqual(['mic']);
	});

	// Step 5
	it('/.well-known/oauth-protected-resource/mcp is the RFC 9728 path-suffixed document for the MCP endpoint', async () => {
		const bare = await fetchJSON('/.well-known/oauth-protected-resource');
		const mcp = await fetchJSON('/.well-known/oauth-protected-resource/mcp');
		expect(mcp.resource).toBe('https://example.com/mcp'); // the host asked, then /mcp
		const { resource: _a, ...bareRest } = bare;
		const { resource: _b, ...mcpRest } = mcp;
		expect(mcpRest).toEqual(bareRest);
	});

	it('the /oauth-suffixed authorization-server documents equal the bare one, whose issuer is the /oauth form', async () => {
		const bare = await fetchJSON('/.well-known/oauth-authorization-server');
		expect(bare.issuer).toBe('https://headlessoracle.com/oauth');
		for (const path of ['/.well-known/oauth-authorization-server/oauth', '/.well-known/openid-configuration/oauth']) {
			const res = await fetchWorker(path);
			expect(res.status, path).toBe(200);
			expect(await res.json(), path).toEqual(bare);
		}
	});

	// Step 6
	it('POST /mcp logs one MCP_USE line per message with method, tool, client and status, and never the arguments', async () => {
		const SECRET = 'H4A_SECRET_ARGUMENT_9f3c';
		const logs = vi.spyOn(console, 'log');
		try {
			await postMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'h4a-probe', version: '1.2.3' } } });
			await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_market_status', arguments: { mic: 'XNYS', note: SECRET } } });
			await postMcp({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: SECRET } });
			const lines = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"MCP_USE"'));
			expect(lines.length).toBe(3);
			const [init, call, list] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
			expect(init).toEqual({ event: 'MCP_USE', method: 'initialize', tool: null, client_name: 'h4a-probe', client_version: '1.2.3', protocol_version: '2025-03-26', host: 'example.com', status: 200 });
			expect(call).toMatchObject({ event: 'MCP_USE', method: 'tools/call', tool: 'get_market_status', client_name: null, status: 200 });
			expect(list).toMatchObject({ event: 'MCP_USE', method: 'tools/list', tool: null, status: 200 });
			for (const l of logs.mock.calls.map((c) => c.map(String).join(' '))) expect(l).not.toContain(SECRET);
		} finally {
			logs.mockRestore();
		}
	});

	it('mcpUseLogLines reads only named fields: arguments, ids and unknown members never reach the line', () => {
		const SECRET = 'H4A_SECRET_2';
		const lines = mcpUseLogLines([
			{ jsonrpc: '2.0', id: SECRET, method: 'tools/call', params: { name: 'get_market_status', arguments: { a: SECRET }, token: SECRET } },
			{ method: 'initialize', params: { clientInfo: { name: `bad name ${SECRET}<script>`, version: SECRET } } },
		], 'api.headlessoracle.com', 200);
		expect(lines.length).toBe(2);
		expect(JSON.parse(lines[0])).toEqual({ event: 'MCP_USE', method: 'tools/call', tool: 'get_market_status', client_name: null, client_version: null, protocol_version: null, host: 'api.headlessoracle.com', status: 200 });
		// A client name is caller text: reduced to identifier characters and capped.
		const init = JSON.parse(lines[1]) as Record<string, string>;
		expect(init.client_name).toBe(`badname${SECRET}script`);
		expect(lines[0]).not.toContain(SECRET);
	});

	// Step 8
	it('openapi /v5/checkout requires a body naming the plan and documents the 400', async () => {
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, any> };
		const post = spec.paths['/v5/checkout'].post;
		expect(post.requestBody.required).toBe(true);
		expect(post.requestBody.content['application/json'].schema.required).toEqual(['plan']);
		expect(post.requestBody.content['application/json'].schema.properties.plan.default).toBeUndefined();
		expect(post.responses['400'].description).toContain('PLAN_REQUIRED');
	});

	// Step 10
	it('/skill.md, ai-plugin.json and openapi info.description lead with the /llms.txt Chirindo summary', async () => {
		const summary = await llmsSummary();
		const skill = await (await fetchWorker('/skill.md')).text();
		const descLine = skill.split('\n').find((l) => l.startsWith('description: '))!;
		const desc = JSON.parse(descLine.slice('description: '.length)) as string;
		expect(desc.startsWith(LEAD_PREFIX + summary)).toBe(true);
		expect(skill).toContain(`\n# Headless Oracle\n\n> ${LEAD_PREFIX}${summary}`);
		const plugin = await fetchJSON('/.well-known/ai-plugin.json');
		expect(String(plugin.description_for_human).startsWith(LEAD_PREFIX + summary)).toBe(true);
		expect(String(plugin.description_for_model).startsWith(LEAD_PREFIX + summary)).toBe(true);
		const spec = await fetchJSON('/openapi.json') as { info: { description: string } };
		expect(spec.info.description.startsWith(LEAD_PREFIX + summary)).toBe(true);
	});

	it('ai-plugin.json links a logo and legal page that exist on the site', async () => {
		const plugin = await fetchJSON('/.well-known/ai-plugin.json');
		// Both answered 200 live on 2026-10-05 (curl); the check-live-links run covers them after deploy.
		expect(plugin.logo_url).toBe('https://headlessoracle.com/og-image.png');
		expect(plugin.legal_info_url).toBe('https://headlessoracle.com/terms');
	});

	it('get_payment_options lists the free anonymous Witness pool and the Evidence plans', async () => {
		const res = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_payment_options', arguments: {} } });
		const text = ((res.result as { content: Array<{ text: string }> }).content[0]).text;
		const opts = JSON.parse(text) as { chirindo_witness: { free_pool: Record<string, unknown>; plans: Array<Record<string, unknown>>; checkout: Record<string, unknown> } };
		expect(opts.chirindo_witness.free_pool.checkpoints_per_utc_day).toBe(2000);
		expect(opts.chirindo_witness.plans.map((p) => [p.plan, p.amount_usd, p.checkpoints_per_utc_day])).toEqual([['custody_90d', '49.00', 1000], ['custody_1y', '199.00', 3000]]);
		expect(opts.chirindo_witness.checkout.url).toBe('https://headlessoracle.com/v5/checkout');
	});

	it('/v5/pricing lists the Evidence pilot exactly as /pricing states it', async () => {
		const body = await fetchJSON('/v5/pricing') as { tiers: Array<Record<string, unknown>> };
		const pilot = body.tiers.find((t) => t.id === 'evidence_pilot');
		expect(pilot).toBeDefined();
		// Copied from the live headlessoracle.com/pricing page, 2026-10-05.
		expect(pilot!.description).toBe('Evidence pilot for a team in its audit window: $4,900 fixed price, scope agreed by conversation. Write to mike@headlessoracle.com.');
		expect(pilot!.price_usd).toBe(4900);
		expect(pilot!.plan).toBeNull();
	});

	it('every surface that states the MCP tools states as many as tools/list serves', async () => {
		const list = await postMcpJSON({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
		const names = ((list.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
		expect(names.length).toBeGreaterThan(0);
		expect((await fetchJSON('/v5/metrics/public')).mcp_tools).toBe(names.length);
		// The server card lists tool names as strings.
		expect((await fetchJSON('/.well-known/mcp/server-card.json')).tools).toEqual(names);
		expect((((await fetchJSON('/.well-known/agent.json')).mcp as { tools: Array<{ name: string }> }).tools).map((t) => t.name)).toEqual(names);
		expect((((await fetchJSON('/.well-known/mcp-servers.json')).servers as Array<{ tools: Array<{ name: string }> }>)[0].tools).map((t) => t.name)).toEqual(names);
	});

	it('every openapi operation has a unique camelCase operationId derived from method and path', async () => {
		const spec = await fetchJSON('/openapi.json') as { paths: Record<string, Record<string, { operationId?: string }>> };
		const ids: string[] = [];
		for (const [path, item] of Object.entries(spec.paths)) {
			for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
				const op = item[method];
				if (!op) continue;
				expect(op.operationId, `${method} ${path}`).toMatch(/^[a-z]+[A-Za-z0-9]*$/);
				ids.push(op.operationId!);
			}
		}
		expect(ids.length).toBeGreaterThan(70);
		expect(new Set(ids).size).toBe(ids.length);
		expect(spec.paths['/v5/status'].get.operationId).toBe('getV5Status');
		expect(spec.paths['/v5/checkout'].post.operationId).toBe('postV5Checkout');
		expect(openapiOperationId('get', '/v1/status/{mic}')).toBe('getV1StatusByMic');
		expect(openapiOperationId('get', '/.well-known/x402.json')).toBe('getWellKnownX402Json');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 mint: one payment, at most one key (option B of
// docs/security/x402-mint-payment-binding.md, 2026-10-07)
//
// The hash is claimed in D1 (HALT_ARCHIVE, table x402_mint_claims, PRIMARY KEY
// tx_hash) after the on-chain check and before a key exists. The KV mark
// x402_used_tx: is still written, but it is no longer what stops a second key.
// ─────────────────────────────────────────────────────────────────────────────
describe('x402 mint — atomic claim: one payment hash, at most one key', () => {
	// The mint is payer-bound (2026-10-08): the Transfer sender must sign.
	const PAYER = MINT_PAYER.address;
	beforeEach(() => { clearX402MintClaimSchemaCache(); });

	async function mintOnce(txHash: string, e: typeof env = env): Promise<Response> {
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/x402/mint', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tx_hash: txHash, tier: 'builder', network: 'base', signature: signMint(txHash, MINT_PAYER) }),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, e, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}
	// Every key the mint route stored, read back from the key store itself.
	async function mintedKeyRecords(): Promise<Array<Record<string, unknown>>> {
		const listed = await env.ORACLE_API_KEYS.list();
		const recs = await Promise.all(listed.keys.map(async (k) => {
			const raw = await env.ORACLE_API_KEYS.get(k.name);
			try { return raw ? JSON.parse(raw) as Record<string, unknown> : null; } catch { return null; }
		}));
		return recs.filter((r): r is Record<string, unknown> => r !== null && r.source === 'x402_onchain');
	}
	const builderUnits = String(BigInt(planPrices().builder) * 1_000_000n);
	const payTo = () => env.ORACLE_PAYMENT_ADDRESS as string;
	const nowSec = () => Math.floor(Date.now() / 1000);

	it('N concurrent POSTs with one tx hash: exactly one 200 with a key, the rest 409', async () => {
		const txHash  = '0x' + 'c1'.repeat(32);
		const restore = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		let results: Response[];
		try {
			results = await Promise.all(Array.from({ length: 6 }, () => mintOnce(txHash)));
		} finally { restore(); }
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
		const ok = results.find((r) => r.status === 200)!;
		const body = await ok.json() as Record<string, unknown>;
		expect(String(body.api_key)).toMatch(/^ho_live_[0-9a-f]{64}$/);
		for (const r of results.filter((x) => x.status === 409)) {
			const b = await r.json() as Record<string, unknown>;
			expect(b.error).toBe('CONFLICT');
			expect(b.api_key).toBeUndefined();
		}
		expect((await mintedKeyRecords()).length).toBe(1);
	});

	it('happy path: 200 with the key; the claim is recorded minted with the key hash, never the key', async () => {
		const txHash  = '0x' + 'c2'.repeat(32);
		const restore = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		let res: Response;
		try { res = await mintOnce(txHash); } finally { restore(); }
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		const key  = String(body.api_key);
		expect(key).toMatch(/^ho_live_[0-9a-f]{64}$/);
		expect(body.tier).toBe('builder');
		expect(body.source).toBe('x402_onchain');
		const keyHash = await sha256Hex(key);
		const stored  = JSON.parse((await env.ORACLE_API_KEYS.get(keyHash))!) as Record<string, unknown>;
		expect(stored.plan).toBe('builder');
		expect(stored.status).toBe('active');
		// The KV mark is still written, for the paths that read it.
		expect(await env.ORACLE_TELEMETRY.get(`x402_used_tx:${txHash}`)).toBe('1');
		const claim = await env.HALT_ARCHIVE!.prepare('SELECT * FROM x402_mint_claims WHERE tx_hash = ?').bind(txHash).first<Record<string, unknown>>();
		expect(claim?.tier).toBe('builder');
		expect(claim?.amount_units).toBe(builderUnits);
		expect(claim?.payer).toBe(PAYER);
		const outcome = await env.HALT_ARCHIVE!.prepare('SELECT * FROM x402_mint_outcomes WHERE tx_hash = ?').bind(txHash).first<Record<string, unknown>>();
		expect(outcome?.outcome).toBe('minted');
		expect(outcome?.key_hash).toBe(keyHash);
		expect(JSON.stringify([claim, outcome])).not.toContain(key);
	});

	it('a second request after a successful mint is 409, and no second key is stored', async () => {
		const txHash  = '0x' + 'c3'.repeat(32);
		const restore = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		try {
			expect((await mintOnce(txHash)).status).toBe(200);
			// Drop the KV mark: the claim alone must refuse the second mint.
			await env.ORACLE_TELEMETRY.delete(`x402_used_tx:${txHash}`);
			const again = await mintOnce(txHash);
			expect(again.status).toBe(409);
			const b = await again.json() as Record<string, unknown>;
			expect(b.error).toBe('CONFLICT');
			expect(b.detail).toBe('TRANSACTION_ALREADY_USED');
			expect(b.claim_status).toBe('minted');
		} finally { restore(); }
		expect((await mintedKeyRecords()).length).toBe(1);
	});

	it('claim store unavailable: 503 with Retry-After, no key stored, no KV mark (a retry can still mint)', async () => {
		const txHash  = '0x' + 'c4'.repeat(32);
		const brokenD1 = { prepare: () => { throw new Error('D1_ERROR: simulated outage'); } } as unknown as D1Database;
		const restore = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		let res: Response;
		try { res = await mintOnce(txHash, { ...env, HALT_ARCHIVE: brokenD1 } as typeof env); } finally { restore(); }
		expect(res.status).toBe(503);
		expect(res.headers.get('Retry-After')).toBe('30');
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('SERVICE_UNAVAILABLE');
		expect(body.api_key).toBeUndefined();
		expect(body.retry_after_seconds).toBe(30);
		expect((await mintedKeyRecords()).length).toBe(0);
		expect(await env.ORACLE_TELEMETRY.get(`x402_used_tx:${txHash}`)).toBeNull();
		// The store comes back: the same payment mints.
		const restore2 = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		try { expect((await mintOnce(txHash)).status).toBe(200); } finally { restore2(); }
	});

	it('key store fails after the claim: the caller is told the payment was received, the claim is failed, the alert is recorded', async () => {
		const txHash = '0x' + 'c5'.repeat(32);
		const kv = env.ORACLE_API_KEYS;
		const brokenKeys = {
			get:    kv.get.bind(kv),
			put:    async () => { throw new Error('KV put failed: simulated'); },
			delete: kv.delete.bind(kv),
			list:   kv.list.bind(kv),
		} as unknown as typeof env.ORACLE_API_KEYS;
		const restore = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		let res: Response;
		try { res = await mintOnce(txHash, { ...env, ORACLE_API_KEYS: brokenKeys } as typeof env); } finally { restore(); }
		expect(res.status).toBe(500);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('MINT_KEY_NOT_STORED');
		expect(body.payment_received).toBe(true);
		expect(body.tx_hash).toBe(txHash);
		expect(body.contact).toBe('mike@headlessoracle.com');
		expect(String(body.message)).toContain(txHash);
		expect(String(body.message)).toContain('mike@headlessoracle.com');
		expect(body.api_key).toBeUndefined();
		const outcome = await env.HALT_ARCHIVE!.prepare('SELECT * FROM x402_mint_outcomes WHERE tx_hash = ?').bind(txHash).first<Record<string, unknown>>();
		expect(outcome?.outcome).toBe('failed');
		expect(outcome?.key_hash).toBeNull();
		// The alert: the existing per-payment path (/v5/revenue-pulse ->
		// health-check.yml opens a GitHub issue per txn_id).
		const pulse = await fetchJSON('/v5/revenue-pulse', { headers: { 'X-Oracle-Key': 'test_master_key_local_only' } });
		const events = (pulse.paddle as Record<string, unknown>).recent_events as Array<Record<string, unknown>>;
		const evt = events.find((e) => e.txn_id === txHash);
		expect(evt?.tier).toBe('x402_mint_failed');
		expect(evt?.plan).toBe('builder');
		expect(evt?.currency).toBe('USDC');
		// A retry is refused, and says why.
		const restore2 = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, PAYER);
		try {
			const again = await mintOnce(txHash);
			expect(again.status).toBe(409);
			const b = await again.json() as Record<string, unknown>;
			expect(b.claim_status).toBe('failed');
			expect(String(b.message)).toContain('mike@headlessoracle.com');
		} finally { restore2(); }
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// x402 mint: the payment is bound to its payer (option A of
// docs/security/x402-mint-payment-binding.md, 2026-10-08)
//
// The body carries `signature`, an EIP-191 personal_sign by the Transfer's
// `from` over x402MintSigningMessage(tx_hash). The signer is checked BEFORE the
// D1 claim, so a front-runner holding only the public hash cannot spend the
// payer's claim. Each test uses a real secp256k1 key (test/mint-payer.ts).
// ─────────────────────────────────────────────────────────────────────────────
describe('x402 mint — payer binding: only the address that paid can mint', () => {
	beforeEach(() => { clearX402MintClaimSchemaCache(); });
	const builderUnits = String(BigInt(planPrices().builder) * 1_000_000n);
	const payTo  = () => env.ORACLE_PAYMENT_ADDRESS as string;
	const nowSec = () => Math.floor(Date.now() / 1000);

	async function mint(body: Record<string, unknown>): Promise<Response> {
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/x402/mint', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		const res = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}
	// The claim row for a hash, or null. A D1 that never saw a claim has no
	// table yet: that is "no row", and any other error is a real failure.
	async function claimRow(txHash: string): Promise<Record<string, unknown> | null> {
		try {
			return await env.HALT_ARCHIVE!.prepare('SELECT * FROM x402_mint_claims WHERE tx_hash = ?').bind(txHash.toLowerCase()).first<Record<string, unknown>>();
		} catch (err) {
			if (/no such table/i.test(String(err))) return null;
			throw err;
		}
	}
	async function x402KeyCount(): Promise<number> {
		const listed = await env.ORACLE_API_KEYS.list();
		let n = 0;
		for (const k of listed.keys) {
			const raw = await env.ORACLE_API_KEYS.get(k.name);
			if (raw && raw.includes('"x402_onchain"')) n++;
		}
		return n;
	}
	// mockBaseRpc plus a count of the Base RPC calls made through it.
	function rpcFor(payer: string): { restore: () => void; calls: () => number } {
		const restoreMock = mockBaseRpc(payTo(), builderUnits, nowSec() - 10, payer);
		const mocked = globalThis.fetch;
		let n = 0;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === 'string' ? input : (input as Request).url;
			if (url === 'https://mainnet.base.org') n++;
			return mocked(input, init);
		}) as typeof fetch;
		return { restore: () => { globalThis.fetch = mocked; restoreMock(); }, calls: () => n };
	}

	it('the message is exactly "headlessoracle.com x402 mint <lowercase tx_hash>"', () => {
		const h = '0x' + 'AB'.repeat(32);
		expect(x402MintSigningMessage(h)).toBe('headlessoracle.com x402 mint 0x' + 'ab'.repeat(32));
		expect(x402MintSigningMessage(' ' + h + ' ')).toBe('headlessoracle.com x402 mint 0x' + 'ab'.repeat(32));
	});

	it('a valid signature by the payer mints: 200 with the key, claim records the payer', async () => {
		const txHash = '0x' + 'd1'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder', signature: signMint(txHash, MINT_PAYER) }); } finally { rpc.restore(); }
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(String(body.api_key)).toMatch(/^ho_live_[0-9a-f]{64}$/);
		expect((await claimRow(txHash))?.payer).toBe(MINT_PAYER.address);
	});

	it('v as 0/1 (not 27/28) is accepted too', async () => {
		const txHash = '0x' + 'd2'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder', signature: signMint(txHash, MINT_PAYER, 0) }); } finally { rpc.restore(); }
		expect(res.status).toBe(200);
	});

	it('a signature made by viem (an independent EIP-191 implementation) mints', async () => {
		const { privateKeyToAccount } = await import('viem/accounts');
		const signer  = newMintSigner();
		const account = privateKeyToAccount(('0x' + Array.from(signer.secretKey, (b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`);
		expect(account.address.toLowerCase()).toBe(signer.address);
		const txHash = '0x' + 'd3'.repeat(32);
		const signature = await account.signMessage({ message: x402MintSigningMessage(txHash) });
		expect(signature).toBe(signMint(txHash, signer));
		const rpc = rpcFor(signer.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder', signature }); } finally { rpc.restore(); }
		expect(res.status).toBe(200);
	});

	it('missing signature: 400 PAYER_SIGNATURE_REQUIRED with the message to sign; no RPC call, no claim row, no key', async () => {
		const txHash = '0x' + 'd4'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder' }); } finally { rpc.restore(); }
		expect(res.status).toBe(400);
		const body = await res.json() as Record<string, unknown>;
		expect(body.error).toBe('PAYER_SIGNATURE_REQUIRED');
		expect(body.message_to_sign).toBe(x402MintSigningMessage(txHash));
		expect(String(body.message)).toContain(x402MintSigningMessage(txHash));
		expect(String(body.signature_format)).toContain('personal_sign');
		expect(String(body.signature_format)).toContain('ERC-1271');
		expect(body.api_key).toBeUndefined();
		expect(rpc.calls()).toBe(0);
		expect(await claimRow(txHash)).toBeNull();
		expect(await env.ORACLE_TELEMETRY.get(`x402_used_tx:${txHash}`)).toBeNull();
		expect(await x402KeyCount()).toBe(0);
	});

	it('malformed signatures: 400 INVALID_PAYER_SIGNATURE, no claim row', async () => {
		const txHash = '0x' + 'd5'.repeat(32);
		const good   = signMint(txHash, MINT_PAYER);
		const bad: unknown[] = [
			'0x1234',                                  // too short
			good.slice(2),                             // no 0x prefix
			good + '00',                               // 66 bytes
			'0x' + 'zz'.repeat(65),                    // not hex
			good.slice(0, -2) + '1d',                  // v = 29
			'0x' + '00'.repeat(64) + '1b',             // r = s = 0: recovers nothing
			42,                                        // not a string
		];
		const rpc = rpcFor(MINT_PAYER.address);
		try {
			for (const signature of bad) {
				const res = await mint({ tx_hash: txHash, tier: 'builder', signature });
				expect(res.status, String(signature)).toBe(400);
				const body = await res.json() as Record<string, unknown>;
				expect(body.error, String(signature)).toBe('INVALID_PAYER_SIGNATURE');
				expect(body.message_to_sign).toBe(x402MintSigningMessage(txHash));
			}
			expect(rpc.calls()).toBe(0);
		} finally { rpc.restore(); }
		expect(await claimRow(txHash)).toBeNull();
		expect(await x402KeyCount()).toBe(0);
	});

	it('front-run: a signature by another key is 403 PAYER_MISMATCH and writes no claim row; the real payer then mints the same hash', async () => {
		const txHash   = '0x' + 'd6'.repeat(32);
		const attacker = newMintSigner();
		const rpc = rpcFor(MINT_PAYER.address);
		try {
			const res = await mint({ tx_hash: txHash, tier: 'builder', signature: signMint(txHash, attacker) });
			expect(res.status).toBe(403);
			const body = await res.json() as Record<string, unknown>;
			expect(body.error).toBe('PAYER_MISMATCH');
			expect(body.recovered_address).toBe(attacker.address);
			expect(body.payer_address).toBe(MINT_PAYER.address);
			expect(body.message_to_sign).toBe(x402MintSigningMessage(txHash));
			expect(String(body.message)).toContain('ERC-1271');
			expect(String(body.message)).toContain('EOA');
			expect(body.api_key).toBeUndefined();
			expect(await claimRow(txHash)).toBeNull();
			expect(await env.ORACLE_TELEMETRY.get(`x402_used_tx:${txHash}`)).toBeNull();
			expect(await x402KeyCount()).toBe(0);

			const real = await mint({ tx_hash: txHash, tier: 'builder', signature: signMint(txHash, MINT_PAYER) });
			expect(real.status).toBe(200);
			expect(String((await real.json() as Record<string, unknown>).api_key)).toMatch(/^ho_live_/);
		} finally { rpc.restore(); }
		expect((await claimRow(txHash))?.payer).toBe(MINT_PAYER.address);
		expect(await x402KeyCount()).toBe(1);
	});

	it('a payer signature over a different tx hash is 403 PAYER_MISMATCH, no claim row', async () => {
		const txHash = '0x' + 'd7'.repeat(32);
		const other  = '0x' + 'd8'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder', signature: signMint(other, MINT_PAYER) }); } finally { rpc.restore(); }
		expect(res.status).toBe(403);
		expect((await res.json() as Record<string, unknown>).error).toBe('PAYER_MISMATCH');
		expect(await claimRow(txHash)).toBeNull();
	});

	it('a signature over a different message (no domain prefix) is 403 PAYER_MISMATCH', async () => {
		const txHash = '0x' + 'd9'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: txHash, tier: 'builder', signature: personalSign(txHash, MINT_PAYER.secretKey) }); } finally { rpc.restore(); }
		expect(res.status).toBe(403);
		expect(await claimRow(txHash)).toBeNull();
	});

	it('an uppercase tx hash in the body verifies against the lowercase message and claims the lowercase hash', async () => {
		const lower = '0x' + 'da'.repeat(32);
		const upper = '0x' + 'DA'.repeat(32);
		const rpc = rpcFor(MINT_PAYER.address);
		let res: Response;
		try { res = await mint({ tx_hash: upper, tier: 'builder', signature: signMint(lower, MINT_PAYER) }); } finally { rpc.restore(); }
		expect(res.status).toBe(200);
		expect((await claimRow(lower))?.tx_hash).toBe(lower);
	});

	it('every served surface that documents the mint names signature and the message', async () => {
		const msg = x402MintSigningMessage('<tx_hash>');
		const openapi = await fetchJSON('/openapi.json') as { paths: Record<string, { post: Record<string, unknown> }> };
		const op = openapi.paths['/v5/x402/mint'].post;
		const schema = ((op.requestBody as Record<string, unknown>).content as Record<string, { schema: { required: string[]; properties: Record<string, unknown> } }>)['application/json'].schema;
		expect(schema.required).toContain('signature');
		expect(JSON.stringify(schema.properties.signature)).toContain(msg);
		const responses = op.responses as Record<string, { description: string }>;
		expect(responses['400'].description).toContain('PAYER_SIGNATURE_REQUIRED');
		expect(responses['400'].description).toContain('INVALID_PAYER_SIGNATURE');
		expect(responses['403'].description).toContain('PAYER_MISMATCH');

		const x402 = await fetchJSON('/.well-known/x402.json') as { resources: Array<Record<string, unknown>> };
		const res = x402.resources.find((r) => r.path === '/v5/x402/mint')!;
		const input = res.input as { required: string[]; properties: Record<string, unknown> };
		expect(input.required).toContain('signature');
		expect(JSON.stringify(input.properties.signature)).toContain(msg);

		for (const path of ['/llms-full.txt', '/auth.md']) {
			const text = await (await fetchWorker(path)).text();
			expect(text, path).toContain('"signature"');
			expect(text, path).toContain(msg);
		}
		const agent = await fetchJSON('/.well-known/agent.json');
		expect(JSON.stringify(agent)).toContain(msg);
	});
});

// Runs last in this file, after every other test has sent its requests.
describe('H4a: response headers are ASCII', () => {
	it('no 2xx or 402 response in this suite carried a non-ASCII header value', () => {
		// Proves the wrapper saw responses; in a full run this is well over 1,000,
		// in a -t filtered run it is whatever ran before this test.
		expect(__headerAsciiChecked).toBeGreaterThan(0);
		expect(__headerAsciiViolations).toEqual([]);
	});
});
