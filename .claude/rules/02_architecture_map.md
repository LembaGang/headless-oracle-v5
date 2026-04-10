<!-- Living document. Update after every session that adds routes,
functions, or changes data flow. Last updated: 2026-04-10 Day 44
living doc refresh -->

# Architecture Map — src/index.ts

Single-file Cloudflare Worker (~12,100 lines post-cleanup). This document
maps the file so any model can navigate it without searching.

## Two-Repo Routing Architecture

**Worker** (`headless-oracle-v5`) = API only. Zero HTML templates or renderers.
**Pages** (`headless-oracle-web`) = All HTML pages (10 pages via Vite build).

The Worker has a catch-all route on `headlessoracle.com/*`. Routing logic:
1. Worker receives ALL requests to `headlessoracle.com`
2. For API paths → Worker handles directly (see API Routes below)
3. For HTML paths → Pages passthrough guard calls `fetch(request)` to forward to Cloudflare Pages

### Pages Passthrough Paths (forwarded to headless-oracle-web)
`/`, `/pricing`, `/status`, `/verify`, `/traction`, `/refund`, `/upgrade`,
`/terms`, `/privacy`, `/docs/*`, `/blog/*`

### Deploy Commands
| Repo | Command | What it does |
|---|---|---|
| `headless-oracle-v5` | `npm run deploy` | `wrangler deploy` → Cloudflare Workers |
| `headless-oracle-web` | `npm run deploy` | `wrangler pages deploy dist` → Cloudflare Pages |

### Pages (headless-oracle-web) — 10 HTML pages
`index.html`, `docs.html`, `status.html`, `pricing.html`, `verify.html`,
`traction.html`, `blog.html`, `terms.html`, `privacy.html`, `refund.html`
Plus `public/docs/` integration guides (quickstart, LangGraph, Bun, Anthropic Claude, DataCamp, x402)

### Worker API Routes (19 route handlers in fetch())
| Route | Auth | Purpose |
|---|---|---|
| `GET /v5/demo` | no | Signed demo receipt |
| `GET /v5/status` | yes/trial/x402 | Signed live receipt |
| `GET /v5/batch` | yes | Batch signed receipts |
| `GET /v5/schedule` | no | Next open/close times |
| `GET /v5/exchanges` | no | Directory of 28 exchanges |
| `GET /v5/keys` | no | Public key registry |
| `POST /v5/keys/instant` | no | Instant key provisioning |
| `GET /v5/health` | no | Signed liveness probe |
| `GET /v5/briefing` | no | Daily market intelligence |
| `POST /v5/sandbox` | no | Sandbox key via email or x402 |
| `GET /v5/usage` | yes | Per-key usage stats |
| `GET /v5/receipts` | yes | Audit log query (builder+) |
| `POST /v5/webhooks/subscribe` | yes | Register webhook |
| `GET /v5/audit/digest` | no | Daily attestation Merkle root |
| `GET /v5/audit/chain` | no | Hash chain of daily digests |
| `POST /v5/checkout` | no | Paddle transaction |
| `POST /webhooks/paddle` | no | Paddle webhook handler |
| `POST /v5/x402/mint` | no | Mint API key via USDC |
| `POST /mcp` | no | MCP Streamable HTTP (5 tools) |

Plus: discovery files (`/llms.txt`, `/AGENTS.md`, `/openapi.json`, `/.well-known/*`),
OAuth endpoints, utility routes (redirects, changelog, etc.).

## File Structure (top to bottom)

| Line Range | Section |
|---|---|
| 1–5 | Imports (`@noble/ed25519`, `@noble/hashes`, `@supabase/supabase-js`) |
| 7–93 | Module-level caches (Ed25519 warm-up, override cache, API key cache, HMAC key cache) |
| 95–137 | `Env` interface (all env vars, KV bindings, DO bindings) |
| 139–157 | Hex helpers (`toHex`, `fromHex`, `sha256Hex`) |
| 159–1200 | `MARKET_CONFIGS` — all 28 exchange configs (timezone, hours, holidays, lunch breaks). PAGE_STYLES/wrapHtml/renderMarkdownToHtml/embedded markdown constants removed 2026-04-10 |
| 1206–1218 | `utcOffsetMinutes()` — DST detection via Intl |
| 1219–1308 | `edgeCaseCount(year)` — computes holidays, half-days, DST transitions, lunch breaks, weekends |
| 1310–1445 | Schedule engine: `getLocalTimeParts()`, `isInSession()`, `getScheduleStatus()` |
| 1447–1569 | `getNextSession()` — next open/close times calculator |
| 1571–1589 | `signPayload()` — canonical JSON sort + Ed25519 signing |
| 1591–1715 | `checkApiKey()` — 5-step auth hot path (master → beta → mem cache → KV → Supabase → 403) |
| 1717–1900 | Key usage tracking, receipt audit, Paddle signature verification |
| 1900–2000 | Constants (x402 amounts, tier limits, webhook limits) |
| 2000–2700 | Payment: `verifyX402Payment()`, CDP JWT, facilitator, `verifyPaymentAnyFormat()`, 402 builders |
| 2700–2800 | KV helpers: `getDailyUsage()`, `incrementKvCounter()`, `getCreditBalance()`, `addCredits()` |
| 2845–2940 | Merkle audit: `trackReceiptId()`, `computeMerkleRoot()`, `getOrBuildDigest()` |
| 2940–3600 | Weekly digest, MPAS spec, aggregation verification helpers |
| 3600–7800 | Large string constants (LLMS_TXT, SKILL_MD, AGENTS_MD, docs, integration guides, blog posts, OpenAPI spec) |
| 7821–7918 | **`buildSignedReceipt()`** — the 4-tier fail-closed core |
| 7920–8470 | MCP handler (`handleMcp()`), OAuth endpoints |
| 8470–8540 | Webhook helpers (`getWebhookSubscriptions`, `deliverWebhook`) |
| 8537–8750 | `runHaltMonitor()` — autonomous halt detection (Polygon.io → Alpaca fallback) |
| 8750–13600 | **Main `fetch()` handler** — all route dispatching |
| 13600–13840 | Utility routes (redirects, changelog, implementations, showcase) |
| 13840–13950 | `WebhookDispatcher` Durable Object class |
| 13950–14011 | `StreamCoordinator` Durable Object class |

## Key Functions

### Core Signing Path

**`buildSignedReceipt(mic, env, now, expiresAt, mode)`** — Line 7825
The heart of the system. Implements 4-tier fail-closed:
- Tier 0: Check `ORACLE_OVERRIDES` KV for manual halts
- Tier 1: `getScheduleStatus()` for schedule-based OPEN/CLOSED
- Tier 2: On Tier 1 error, sign UNKNOWN/SYSTEM receipt
- Tier 3: On signing error, return unsigned CRITICAL_FAILURE 500
Called by: `/v5/demo`, `/v5/status`, `/v5/batch`, MCP `get_market_status`, `/v5/health` (variant), SSE stream

**`signPayload(payload, privKeyHex)`** — Line 1571
Sorts keys alphabetically, JSON.stringify, Ed25519 sign. Caches decoded private key bytes.

**`getScheduleStatus(mic, now)`** — Line 1377
Returns `{ status: 'OPEN'|'CLOSED'|'UNKNOWN', source: 'SCHEDULE'|'SYSTEM' }`.
Handles: weekends (per-exchange), holidays (year-keyed, fail-closed on missing year),
half-days, lunch breaks, overnight sessions (CME Globex).

### Authentication

**`checkApiKey(key, env)`** — Line 1604
5-step hot path: `MASTER_API_KEY` → `BETA_API_KEYS` → in-memory cache → KV cache →
Supabase lookup → 403. Returns `AuthResult` with plan and keyHash.
Credits-tier keys bypass memory cache (balance mutates per request).

### MCP

**`handleMcp(request, env, ctx)`** — Line 8030
JSON-RPC 2.0 dispatcher. Methods: `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `prompts/list`. Tools: `get_market_status`, `get_market_schedule`,
`list_exchanges`, `verify_receipt`, `get_payment_options`.
Has its own error handling — never returns REST format.

### Payment Verification

**`verifyX402Payment(request, env, paymentHeader)`** — Line 2028
Verifies on-chain USDC transfer on Base mainnet. Two RPC calls: `eth_getTransactionReceipt`
(verify Transfer event) + `eth_getBlockByNumber` (verify block timestamp age < 300s).
Replay protection via `x402_used:{txHash}` KV key (600s TTL).

**`verifyX402ViaFacilitator(request, env, paymentHeader, resourceUrl)`** — Line 2194
CDP facilitator path. Generates JWT via `generateCdpJwt()`, POSTs to CDP x402 endpoint.

**`verifyPaymentAnyFormat(request, env, paymentHeader)`** — Line 2319
Accepts BOTH raw JSON and base64-encoded JSON payment headers.

**`build402Payload(paymentAddress, keyHash)`** — Line 2482
Builds the 402 response body with x402 payment instructions.

**`buildX402ScanPayload(paymentAddress, resourceUrl)`** — Line 2614
Builds x402scan-compatible format (x402Version:1, accepts[], payTo).

### KV Helpers

**`incrementKvCounter(key, env, ctx, ttlSeconds)`** — Line 2722
Non-blocking KV read-modify-write via `ctx.waitUntil`. Used for all telemetry counters.

**`getDailyUsage(keyHash, env)`** — Line 2707
Reads `free_usage:{keyHash}:{date}` from KV.

**`getCreditBalance(keyHash, env)`** — Line 2733
Reads credit record from `ORACLE_API_KEYS` KV.

**`getMcpUsageToday(today, env)`** — Line 2741
Cache-first (traction_cache KV), live fallback (KV list scan).

### Schedule Helpers

**`getNextSession(mic, now)`** — Line 1488
Scans forward up to 14 days to find next open/close. Returns `{ next_open, next_close }` in UTC ISO 8601.

**`edgeCaseCount(year)`** — Line 1219
Computes total schedule edge cases from live config: holidays, half-days, DST transitions,
lunch break sessions, weekend days. Used by `/v5/health` and content.

### Other Important Functions

**`verifyPaddleSignature(body, sigHeader, secret)`** — Line 1771
HMAC-SHA256 verification of Paddle webhook signatures. 5-min replay protection.

**`runHaltMonitor(env)`** — Line 8537
Cron-triggered (every minute). Checks Polygon.io (primary) / Alpaca (fallback, US-only)
for exchanges scheduled OPEN. Writes REALTIME overrides to KV with 2h TTL.

**`deliverWebhook(target, payload, maxAttempts)`** — Line 8488
HMAC-SHA256 signed delivery with exponential backoff (1s/4s/16s).

## Data Flow — Three Common Request Paths

### 1. Free Trial Receipt (`GET /v5/status?mic=XNYS`, no API key)

```
Request → main fetch() (line 8751)
  → No X-Oracle-Key header → enters keyless path (line 9040+)
  → Check X-Payment header → none
  → Hash client IP → read trial_usage:{date}:{hash} from KV
  → trialCount < 3 → proceed
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
    → Tier 0: getCachedOverride(mic) → null
    → Tier 1: getScheduleStatus(mic, now) → { status: 'OPEN', source: 'SCHEDULE' }
    → signPayload(payload, privKey) → hex signature
  → Response 200 with receipt + X-Trial-Remaining header
  → Deferred: increment trial_usage KV counter
```

### 2. Authenticated Receipt (`GET /v5/status?mic=XNYS`, with API key)

```
Request → main fetch() (line 8751)
  → X-Oracle-Key present → checkApiKey(key, env) (line 1604)
    → Not master/beta → sha256(key) → check in-memory cache
    → Cache hit: { plan: 'builder', status: 'active' } → allowed
  → getDailyUsage(keyHash, env) → check against getPlanDailyLimit(plan)
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
  → Response 200 with receipt + X-Oracle-Plan + X-RateLimit-* headers
  → Deferred: incrementDailyUsage, updateKeyUsage, insertReceiptAudit, incrementKvCounter
```

### 3. x402 Payment (`GET /v5/status?mic=XNYS`, no key, trial exhausted)

```
Request → main fetch() (line 8751)
  → No X-Oracle-Key → enters keyless path
  → Check X-Payment header → present (base64 or raw JSON)
  → verifyPaymentAnyFormat(request, env, paymentHeader) (line 2319)
    → Try verifyX402Payment (direct on-chain) (line 2028)
      → eth_getTransactionReceipt → verify USDC Transfer event
      → eth_getBlockByNumber → verify block age < 300s
      → Check replay: x402_used:{txHash} KV → not found → valid
    → Payment verified
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
  → Response 200 with receipt + Payment-Response header
  → Deferred: store x402_used:{txHash}, increment x402_payment_count
```

### 3b. x402 Payment Rejected (402 path)

```
Request → No key, no payment, trial exhausted
  → ORACLE_PAYMENT_ADDRESS set?
    → Yes → build402Payload() + buildX402ScanPayload()
    → Response 402 with x402 payment instructions + agent_upgrade_paths
  → ORACLE_PAYMENT_ADDRESS not set?
    → Response 429 RATE_LIMITED
```

## Constants Reference

| Constant | Value | Purpose |
|---|---|---|
| `RECEIPT_TTL_SECONDS` | 60 | Receipt expiry — NEVER change |
| `FREE_TRIAL_DAILY_LIMIT` | 3 | Keyless trial receipts per IP per day |
| `FREE_TIER_DAILY_LIMIT` | 500 | Free API key calls per day |
| `SANDBOX_DAILY_LIMIT` | 200 | Sandbox key total lifetime calls |
| `BUILDER_TIER_DAILY_LIMIT` | 50,000 | Builder plan daily limit |
| `PRO_TIER_DAILY_LIMIT` | 200,000 | Pro plan daily limit |
| `X402_MIN_AMOUNT_UNITS` | 1000 (BigInt) | $0.001 USDC (6 decimals) |
| `X402_MINT_BUILDER_UNITS` | 99,000,000 | 99 USDC for builder key mint |
| `X402_MINT_PRO_UNITS` | 299,000,000 | 299 USDC for pro key mint |
| `X402_MINT_MAX_AGE_SECONDS` | 600 | 10-min max age for mint payments |
| `OVERRIDE_CACHE_TTL_MS` | 10,000 | Override KV cache: 10s |
| `API_KEY_CACHE_TTL_MS` | 60,000 | API key in-memory cache: 60s |
| `BUILDER_WEBHOOK_LIMIT` | 5 | Max webhooks per builder key |
| `PRO_WEBHOOK_LIMIT` | 25 | Max webhooks per pro key |
| `ORACLE_ISSUER` | "headlessoracle.com" | Issuer field in all receipts |

## Durable Objects

**`WebhookDispatcher`** (line 13840) — alarm-based state-change detector.
Every 60s, reads KV subscriptions, compares per-MIC state, fans out
`deliverWebhook()` calls on state change. Writes health status to
`webhook_dispatcher:health` KV key.

**`StreamCoordinator`** (line 13953) — SSE stream for `/v5/stream`.
Polls `buildSignedReceipt()` every 30s, writes `event: market_status`
to connected clients. Sends `event: halted` and closes on HALTED status.

## Cron Triggers (wrangler.toml)

| Schedule | Handler |
|---|---|
| `* * * * *` | `runHaltMonitor()` — real-time halt detection |
| `0 9 * * *` | Daily: npm download stats + DST reminders (date-checked) |
| `0 17 * * *` | Daily: MCP client analytics aggregation |
| `0 9 * * 1` | Monday: weekly digest summary |
