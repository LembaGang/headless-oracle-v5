#!/usr/bin/env node
// scripts/health-check.mjs
//
// Production health check — runs on a 15-minute cron from
// .github/workflows/health-check.yml. Self-contained: no npm dependencies.
// Requires Node 22+ for Ed25519 in Web Crypto.
//
// What it verifies:
//   1. Five critical endpoints return 200 with the expected response shape
//      (field-presence checks, NOT full OpenAPI schema validation — see
//      .claude/rules/monitors.md for the rationale).
//   2. /v5/demo and /v5/health receipts have valid Ed25519 signatures, the
//      signing key matches /v5/keys, and TTL is exactly 60 seconds.
//   3. The Pages frontend at https://headlessoracle.com/ returns 200 in
//      under 3 seconds.
//   4. Pages-vs-Worker failure classification when something is broken.
//   5. New Paddle revenue events from /v5/revenue-pulse (if MASTER_API_KEY
//      is provided via env). Each new event becomes a GitHub issue via the
//      workflow. Sliding 20-min window matches the 15-min cron with
//      overlap; deduplication is by txn_id, handled in the workflow.
//
// Exit codes:
//   0 — all checks passed
//   1 — at least one check failed (workflow opens an issue)
//
// Output: structured JSON lines on stdout, human-readable failures on
// stderr. The workflow grep's stdout for `"event":"REVENUE_NEW"` lines.

const BASE = process.env.HEADLESS_ORACLE_BASE_URL ?? 'https://headlessoracle.com';
const MASTER_KEY = process.env.MASTER_API_KEY ?? null;
const TIMEOUT_MS = 10_000;
const FRONTEND_SLO_MS = 3_000;
const RECEIPT_TTL_SECONDS = 60;
const REVENUE_LOOKBACK_MS = 20 * 60 * 1000; // 20 min — matches 15-min cron + overlap

const failures = [];
function fail(check, detail) {
	failures.push({ check, detail });
	console.error(`FAIL ${check}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
function log(event, data) {
	console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

async function fetchJson(path, opts = {}) {
	const ctl = AbortSignal.timeout(TIMEOUT_MS);
	const t0 = performance.now();
	const res = await fetch(`${BASE}${path}`, { ...opts, signal: ctl });
	const ms = Math.round(performance.now() - t0);
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} on ${path} after ${ms}ms`);
	}
	const body = await res.json();
	return { body, ms, status: res.status };
}

function hexToBytes(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// Canonical signing payload: take ONLY the fields named in
// canonical_payload_spec (published at /v5/keys → see ADR-009, ADR-014).
// Alphabetical sort, JSON.stringify with no whitespace. Anything else in the
// response is unsigned wrapper metadata and must be excluded.
function canonicalize(receipt, fieldList) {
	const sorted = {};
	for (const key of [...fieldList].sort()) {
		if (key in receipt) sorted[key] = receipt[key];
	}
	return JSON.stringify(sorted);
}

let _keysCache = null;
let _specCache = null;
async function getPublicKeys() {
	if (_keysCache) return _keysCache;
	const { body } = await fetchJson('/v5/keys');
	_keysCache = body;
	_specCache = body.canonical_payload_spec ?? null;
	return body;
}

function pickFieldList(receipt) {
	// Prefer the live spec (fetched from /v5/keys). Fall back to hard-coded
	// field lists matching ADR-009/014/016 if the spec is missing.
	const FALLBACK = {
		receipt_fields:  ['expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic', 'public_key_id', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
		override_fields: ['expires_at', 'halt_detection', 'issued_at', 'issuer', 'mic', 'public_key_id', 'reason', 'receipt_id', 'receipt_mode', 'schema_version', 'source', 'status'],
		health_fields:   ['expires_at', 'issued_at', 'issuer', 'public_key_id', 'receipt_id', 'source', 'status'],
	};
	const spec = _specCache ?? FALLBACK;
	if (!('mic' in receipt) && receipt.source === 'SYSTEM') return spec.health_fields ?? FALLBACK.health_fields;
	if ('reason' in receipt) return spec.override_fields ?? FALLBACK.override_fields;
	return spec.receipt_fields ?? FALLBACK.receipt_fields;
}

async function verifyReceiptSignature(checkName, receipt) {
	if (!receipt || typeof receipt !== 'object') {
		fail(checkName, 'receipt is not an object');
		return false;
	}
	// Some endpoints wrap the receipt under .receipt with a discovery_url sibling
	const r = receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt : receipt;
	const required = ['signature', 'public_key_id', 'issued_at', 'expires_at'];
	for (const f of required) {
		if (!(f in r)) { fail(checkName, `missing field: ${f}`); return false; }
	}

	// TTL window check
	const issuedMs  = Date.parse(r.issued_at);
	const expiresMs = Date.parse(r.expires_at);
	if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs)) {
		fail(checkName, 'unparseable issued_at/expires_at');
		return false;
	}
	const ttlSec = (expiresMs - issuedMs) / 1000;
	if (ttlSec !== RECEIPT_TTL_SECONDS) {
		fail(checkName, `TTL is ${ttlSec}s, expected ${RECEIPT_TTL_SECONDS}s`);
		return false;
	}
	if (expiresMs < Date.now()) {
		fail(checkName, `receipt already expired (expires_at=${r.expires_at})`);
		return false;
	}

	// Find the matching key
	const keys = await getPublicKeys();
	const match = (keys.keys ?? []).find((k) => k.key_id === r.public_key_id);
	if (!match) {
		fail(checkName, `no key in /v5/keys matches public_key_id=${r.public_key_id}`);
		return false;
	}

	// Verify Ed25519 signature
	const pubBytes  = hexToBytes(match.public_key);
	const sigBytes  = hexToBytes(r.signature);
	const fieldList = pickFieldList(r);
	const msgBytes  = new TextEncoder().encode(canonicalize(r, fieldList));
	let cryptoKey;
	try {
		cryptoKey = await crypto.subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']);
	} catch (err) {
		fail(checkName, `importKey failed: ${err.message}`);
		return false;
	}
	const ok = await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, msgBytes);
	if (!ok) {
		fail(checkName, 'Ed25519 signature verification failed');
		return false;
	}
	return true;
}

// ── Worker API checks ────────────────────────────────────────────────────────
async function checkWorkerEndpoints() {
	// 1. /v5/health — signed liveness
	try {
		const { body, ms } = await fetchJson('/v5/health');
		log('CHECK_OK', { endpoint: '/v5/health', ms });
		if (body.status !== 'OK') fail('health.status', `expected OK, got ${body.status}`);
		await verifyReceiptSignature('health.signature', body);
	} catch (err) { fail('health.fetch', err.message); }

	// 2. /v5/demo?mic=XNYS — signed market receipt
	try {
		const { body, ms } = await fetchJson('/v5/demo?mic=XNYS');
		log('CHECK_OK', { endpoint: '/v5/demo?mic=XNYS', ms });
		const r = body.receipt ?? body;
		if (!['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'].includes(r.status)) {
			fail('demo.status', `unexpected status: ${r.status}`);
		}
		if (r.mic !== 'XNYS') fail('demo.mic', `expected XNYS, got ${r.mic}`);
		await verifyReceiptSignature('demo.signature', body);
	} catch (err) { fail('demo.fetch', err.message); }

	// 3. /v5/exchanges — directory shape
	try {
		const { body, ms } = await fetchJson('/v5/exchanges');
		log('CHECK_OK', { endpoint: '/v5/exchanges', ms });
		if (!Array.isArray(body.exchanges) || body.exchanges.length < 28) {
			fail('exchanges.shape', `expected ≥28 exchanges, got ${body.exchanges?.length}`);
		}
	} catch (err) { fail('exchanges.fetch', err.message); }

	// 4. /v5/schedule?mic=XNYS — next session shape
	try {
		const { body, ms } = await fetchJson('/v5/schedule?mic=XNYS');
		log('CHECK_OK', { endpoint: '/v5/schedule?mic=XNYS', ms });
		if (!('next_open' in body) || !('next_close' in body)) {
			fail('schedule.shape', 'missing next_open/next_close');
		}
		if (body.timezone !== 'America/New_York') {
			fail('schedule.timezone', `expected America/New_York, got ${body.timezone}`);
		}
	} catch (err) { fail('schedule.fetch', err.message); }

	// 5. /openapi.json — spec sanity
	try {
		const { body, ms } = await fetchJson('/openapi.json');
		log('CHECK_OK', { endpoint: '/openapi.json', ms });
		const pathCount = Object.keys(body.paths ?? {}).length;
		if (pathCount < 70) fail('openapi.paths', `expected ≥70 paths, got ${pathCount}`);
		if (body.openapi !== '3.1.0') fail('openapi.version', `expected 3.1.0, got ${body.openapi}`);
	} catch (err) { fail('openapi.fetch', err.message); }
}

// ── Pages frontend + failure classifier ─────────────────────────────────────
async function checkFrontend() {
	let pagesOk = false;
	let workerOk = false;
	let pagesMs = null;

	try {
		const t0 = performance.now();
		const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		pagesMs = Math.round(performance.now() - t0);
		pagesOk = res.status === 200;
		if (!pagesOk) fail('frontend.status', `GET / returned ${res.status}`);
		else if (pagesMs > FRONTEND_SLO_MS) fail('frontend.slo', `GET / took ${pagesMs}ms (SLO: ${FRONTEND_SLO_MS}ms)`);
		else log('CHECK_OK', { endpoint: '/', ms: pagesMs });
	} catch (err) { fail('frontend.fetch', err.message); }

	try {
		const res = await fetch(`${BASE}/v5/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		workerOk = res.status === 200;
	} catch { workerOk = false; }

	// Failure classifier — only when something is wrong
	if (!pagesOk || !workerOk) {
		let suspect;
		if (!pagesOk && !workerOk)      suspect = 'WORKER (catch-all routing is down — both API and Pages passthrough fail)';
		else if (!pagesOk &&  workerOk) suspect = 'PAGES (Worker API is up, but the Pages passthrough on / is failing — investigate headless-oracle-web deployment)';
		else if ( pagesOk && !workerOk) suspect = 'WORKER (Pages passthrough works, but the Worker /v5 API is failing — investigate headless-oracle-v5)';
		log('FAILURE_CLASSIFIED', { pages_ok: pagesOk, worker_ok: workerOk, suspect });
	}
}

// ── Revenue pulse — surface new Paddle events ───────────────────────────────
async function checkRevenue() {
	if (!MASTER_KEY) {
		log('REVENUE_SKIPPED', { reason: 'MASTER_API_KEY env var not provided' });
		return;
	}
	try {
		const res = await fetch(`${BASE}/v5/revenue-pulse`, {
			headers: { 'X-Oracle-Key': MASTER_KEY },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) {
			fail('revenue.fetch', `HTTP ${res.status} on /v5/revenue-pulse`);
			return;
		}
		const body = await res.json();
		const cutoff = Date.now() - REVENUE_LOOKBACK_MS;
		const recent = (body.paddle?.recent_events ?? []).filter((e) => Date.parse(e.ts) >= cutoff);
		log('REVENUE_PULSE', {
			lifetime: body.paddle?.lifetime_count ?? 0,
			by_tier:  body.paddle?.by_tier ?? {},
			x402_lifetime: body.x402?.lifetime_count ?? 0,
			new_in_window: recent.length,
		});
		// Each new event gets a structured log line. The GH workflow greps for
		// REVENUE_NEW and creates a GitHub issue per txn_id.
		for (const evt of recent) {
			log('REVENUE_NEW', {
				tier:     evt.tier,
				plan:     evt.plan,
				amount:   evt.amount,
				currency: evt.currency,
				txn_id:   evt.txn_id,
				event_ts: evt.ts,
			});
		}
	} catch (err) { fail('revenue.fetch', err.message); }
}

// ── main ────────────────────────────────────────────────────────────────────
log('HEALTH_CHECK_START', { base: BASE });
await checkWorkerEndpoints();
await checkFrontend();
await checkRevenue();

if (failures.length > 0) {
	log('HEALTH_CHECK_FAILED', { failures });
	process.exit(1);
}
log('HEALTH_CHECK_PASSED', {});
process.exit(0);
