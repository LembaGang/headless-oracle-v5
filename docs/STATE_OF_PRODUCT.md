# Headless Oracle V5 — State of Product
**Generated: April 5, 2026 (Day 38)**  
**Tests: 671/671 passing** | **Exchanges: 28** | **MCP tools: 5**

---

## 1. All Endpoints

### Public (no auth)

| Method | Path | Returns |
|--------|------|---------|
| GET | /v5/demo?mic=<MIC> | Signed receipt, receipt_mode='demo'. Default MIC: XNYS. |
| GET | /v5/schedule?mic=<MIC> | Next open/close times UTC, lunch_break, data_coverage_years, settlement_window. |
| GET | /v5/exchanges | Directory of all 28 exchanges (MIC, name, timezone, mic_type). |
| GET | /v5/keys | Ed25519 public key + canonical payload spec. |
| GET | /v5/health | Signed liveness probe. Includes halt_monitor active_realtime_overrides. |
| GET | /v5/conformance-vectors | 5 live-signed test vectors for SDK authors. |
| GET | /v5/compliance | APTS v1.0 compliance self-report (6 pre-trade safety checks). |
| GET | /v5/dst-risk | EU DST transition advisory. Current: March 29 affected. |
| GET | /v5/traction | Live metrics: exchanges, uptime, MCP clients, x402 status, halt monitor. |
| GET | /v5/metrics | MCP client telemetry (total_mcp_requests_today, unique_mcp_clients_today). |
| GET | /v5/metrics/public | Social proof: exchanges, uptime_days, tests_passing, status_codes_today, etc. |
| GET | /v5/referrers?date= | Referrer domain counts from KV (best-effort). |
| GET | /v5/why-not-free | Upgrade ladder JSON for agents hitting 402. |
| GET | /v5/payment-proof | On-chain payment stats from KV (x402_payment_count, first/last tx). |
| POST | /v5/verify | Ed25519 receipt verification. Body: { receipt: object }. Returns { valid, expired, reason, mic, status, expires_at }. |
| GET | /x402 | x402 Foundation compatibility declaration. |
| GET | /v5/errors/{code} | Machine-readable error code definitions (12 known codes). |
| GET | /v5/implementations | Standards registry (SMA/MPAS/APTS, 5 verified implementations). |
| GET | /v5/showcase | Seeded with Halt Simulator. |
| GET | /v5/stack | Autonomous finance stack positioning (3-layer). |
| GET | /v5/card/:mic | SVG status card, terminal-style, image/svg+xml, Cache-Control: no-cache. |
| GET | /v5/changelog | Versioned changelog feed (5 entries). |
| GET | /v5/dst-risk | EU DST advisory for affected exchanges. |
| GET | /v5/webhooks/health | Webhook dispatcher KV health key (no DO instantiation). |
| POST | /v5/x402/mint | Mint persistent API key via x402 USDC payment. builder=99 USDC, pro=299 USDC. |
| POST | /v5/sandbox | Provision sandbox key: email → sb_ key (200 calls, 7 days) OR X-Payment → ho_crd_ key (10 credits). |
| POST | /v5/keys/request | Self-provision free key (ho_free_). IP rate-limited: 3/day. |
| GET | /v5/pricing | **NEW (Day 38)** Pricing tiers as JSON. |
| GET | /mics.json | MIC codes for all 28 exchanges. |
| POST | /mcp | MCP Streamable HTTP. JSON-RPC 2.0. Protocol: 2024-11-05. Optional Bearer auth. |
| GET | /openapi.json | OpenAPI 3.1 spec. |
| GET | /status | HTML real-time market dashboard, all 28 exchanges, 60s auto-refresh. |
| GET | /badge/:mic | SVG status badge. Cache-Control: max-age=60. |
| GET | /upgrade | HTML plan selection page. KNOWN ISSUE: deadline countdown shows EXPIRED (March 31 passed). |
| GET | /pricing | HTML pricing page (served by Cloudflare Pages — pricing.html). **KNOWN: "Free Beta" label stale.** |
| GET | /sitemap.xml | XML sitemap. |
| GET | /robots.txt | Robots.txt (AI crawlers permitted). |
| GET | /llms.txt | LLM-readable API summary. |
| GET | /SKILL.md | Ampersend skill file. |
| GET | /skill.md | Skill file alias. |
| GET | /AGENTS.md | AAIF/Linux Foundation coordinator briefing. |
| GET | /blog/* | Blog posts (2 posts: pre-trade-gate, market-hours-vs-attestation). |
| GET | /npm | 302 → npmjs.com |
| GET | /pypi | 302 → pypi.org |
| GET | /github | 302 → github.com |
| GET | /.well-known/oracle-keys.json | RFC 8615 key discovery. |
| GET | /.well-known/agent.json | A2A Agent Card. |
| GET | /.well-known/mcp.json | MCP server card alias. |
| GET | /.well-known/mcp/server-card.json | MCP server card (capabilities, tools, auth). |
| GET | /.well-known/mcp-servers.json | MCP server registry feed. |
| GET | /.well-known/oauth-authorization-server | RFC 8414 AS metadata. |
| GET | /.well-known/oauth-protected-resource | RFC 7662 protected resource metadata. |
| GET | /.well-known/x402.json | x402 payment discovery document. |
| GET | /.well-known/security.txt | RFC 9116 security contact. |
| GET | /.well-known/ai-plugin.json | ChatGPT/OpenAI plugin manifest. |
| GET | /ai-plugin.json | Plugin manifest alias. |
| POST | /oauth/token | RFC 6749 client_credentials grant → opaque token (3600s TTL). |
| POST | /oauth/introspect | RFC 7662 token introspection. |
| GET | /docs/* | Various integration guides (served by Pages). |

### Authenticated (X-Oracle-Key header required)

| Method | Path | Auth Level | Returns |
|--------|------|-----------|---------|
| GET | /v5/status?mic=<MIC> | Any valid key | Signed receipt, receipt_mode='live'. x402 path available keyless. |
| GET | /v5/status/realtime?mic=<MIC> | Any valid key | Signed receipt + halt_monitor.active_realtime_override. |
| GET | /v5/batch?mics=<CSV> | Any valid key | Array of independently signed receipts + summary { safe_to_execute }. |
| GET | /v5/account | Any valid key | { plan, status, key_prefix }. |
| GET | /v5/usage | Any valid key | Daily/monthly usage, limits, rate_limit_resets_at, upgrade_url. |
| GET | /v5/archive?mic=&date= | Builder+ | Historical receipt archive (requires Supabase receipt_audit table). |
| GET | /v5/stream?mic= | Any valid key | SSE stream of signed receipts every 30s (Durable Object). |
| GET | /v5/handoff | Any valid key | Session handoff Markdown document. |
| GET | /v5/receipts?mic=&from=&limit= | Builder+ | Receipt audit log (requires Supabase receipt_audit table). |
| GET | /v5/credits/balance | Any valid key | { balance, estimated_requests_remaining, last_purchased }. |
| POST | /v5/credits/purchase | Any valid key + X-Payment | Add credits via x402 USDC payment. Tiered: 1/100/1000 credits. |
| POST | /v5/webhooks/subscribe | Any valid key (not sandbox) | Register webhook for MIC state-change events. |
| GET | /v5/webhooks | Any valid key | List all webhooks for this key. |
| DELETE | /v5/webhooks/:webhook_id | Any valid key | Delete webhook → 204. |
| POST | /v5/webhooks/test/:webhook_id | Any valid key | Fire synthetic test delivery. |
| POST | /v5/checkout | No auth (email required) | Paddle checkout URL for subscriptions. |
| POST | /webhooks/paddle | No auth (Paddle signature) | Paddle webhook: transaction.completed, subscription.updated/past_due/canceled. |

---

## 2. MCP Tools (POST /mcp)

Protocol: MCP Streamable HTTP, JSON-RPC 2.0, protocol version `2024-11-05`.  
Optional auth: Bearer token via POST /oauth/token, or unauthenticated (10 free calls/day per IP).

| Tool | Parameters | Returns |
|------|-----------|---------|
| `get_market_status` | `mic: string` (required) | Ed25519-signed receipt. OPEN/CLOSED/HALTED/UNKNOWN. Same 4-tier fail-closed as REST. |
| `get_market_schedule` | `mic: string` (required) | Next open/close UTC, lunch_break window, settlement_window. |
| `list_exchanges` | none | All 28 exchanges with MIC, name, timezone, mic_type. |
| `verify_receipt` | `receipt: object` (required) | { valid, expired, reason, mic, status, expires_at }. Ed25519 in-worker. |
| `get_payment_options` | none | Upgrade ladder: sandbox → x402 → credits → builder. agent_native_path included. |

---

## 3. Pricing Tiers (in code, as of Day 38)

| Tier | ID | Price | Calls | Key Prefix | Provision Path | Daily Limit |
|------|----|-------|-------|-----------|----------------|-------------|
| Sandbox | `sandbox` | Free | 200 lifetime (7-day key) | `sb_` | POST /v5/sandbox (email) | 200/7 days |
| Free | `free` | Free | Unlimited up to daily cap | `ho_free_` | POST /v5/keys/request (email) | 500/day |
| x402 Per-Request | `x402` | $0.001 USDC/req | Pay-per-call | None | X-Payment header | ∞ (per-tx) |
| x402 Sandbox | `x402_sandbox` | $0.001 USDC | 10 credits | `ho_crd_` | POST /v5/sandbox + X-Payment | Balance |
| Credits | `credits` | $5 one-time (1000 calls) | Balance-based | `ho_crd_` | POST /v5/x402/mint or Paddle | Balance |
| Builder | `builder` | $99/month | 50,000/day | `ho_live_` | POST /v5/checkout | 50,000/day |
| Pro | `pro` | $299/month | 200,000/day | `ho_live_` | POST /v5/checkout | 200,000/day |
| Protocol/Internal | `protocol` | $500/month | Unlimited | `ho_live_` | POST /v5/checkout | Unlimited |

**x402 Constants (in code):**
- Per-request amount: 1000 units (0.001 USDC at 6 decimals)
- x402 Sandbox key mint: $0.001 USDC → 10 credits (via POST /v5/sandbox + X-Payment)
- Builder mint: 99,000,000 units = $99 USDC → persistent ho_live_ key, 50K calls/day
- Pro mint: 299,000,000 units = $299 USDC → persistent ho_live_ key, 200K calls/day
- Network: Base mainnet (chain ID 8453)
- USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
- Payment wallet: ORACLE_PAYMENT_ADDRESS (Wrangler secret — 0x26D4...AD3)

**PRICE PROPOSAL (NOT YET CHANGED):**
Current per-request x402 price is $0.001 USDC. Research suggests $0.01 USDC is the right price point for the current product value. This is a 10x increase. To change: update `X402_MIN_AMOUNT_UNITS` from `BigInt(1000)` to `BigInt(10000)`, update all `maxAmountRequired: '1000'` to `'10000'`, update `'X-Payment-Amount': '0.001 USDC'` to `'0.01 USDC'`, and update all description strings. Requires founder approval before execution.

---

## 4. Payment Infrastructure

### Paddle (Subscriptions + Credit Packs)
- **Status:** Wired. Webhook handler live at POST /webhooks/paddle.
- **Checkout:** POST /v5/checkout → Paddle transaction → returns { url }.
- **Webhook events handled:** transaction.completed, subscription.updated, subscription.past_due, subscription.canceled.
- **Key generation:** On transaction.completed → generates ho_live_ key → Supabase insert → KV cache warm → Resend email.
- **Credit packs:** PADDLE_PRICE_ID_CREDITS → ho_crd_ key with balance: 1000 on transaction.completed.
- **Idempotency:** Guards on stripe_subscription_id duplicate in Supabase.
- **Required secrets (Wrangler):** PADDLE_API_KEY, PADDLE_WEBHOOK_SECRET, PADDLE_PRICE_ID_BUILDER, PADDLE_PRICE_ID_PRO, PADDLE_PRICE_ID_PROTOCOL, PADDLE_PRICE_ID_CREDITS.
- **KNOWN GAP:** PADDLE_PRICE_ID values are not verified as set in production. If unset, checkout returns 503.

### x402 (Per-Request Micropayments)
- **Status:** Production-ready on Base mainnet.
- **Verification path A (direct):** verifyX402Payment() — eth_getTransactionReceipt + eth_getBlockByNumber via mainnet.base.org public RPC. No API key required.
- **Verification path B (facilitator):** verifyX402ViaFacilitator() — CDP facilitator at api.cdp.coinbase.com/platform/v2/x402. Requires CDP_API_KEY_NAME + CDP_API_KEY_PRIVATE_KEY secrets.
- **Replay protection:** x402_used:{txHash} KV key (600s TTL for per-request), x402_used_tx:{txHash} (365-day TTL for key minting).
- **Payment stats:** KV keys: x402_payment_count, x402_first_payment_at, x402_last_payment_at.
- **Discovery:** /.well-known/x402.json lists /v5/status and /v5/batch as paid resources.
- **KNOWN GAP-016:** verifyX402ViaFacilitator() has no KV cache for verified txHashes — makes 2 RPC calls per request. Fix when daily unique clients > 100.

### Supabase (Source of Truth for Paid Keys)
- **Status:** Wired in code. Requires human setup.
- **Table:** api_keys (key_hash, key_prefix, plan, status, stripe_customer_id [Paddle ctm_*], stripe_subscription_id [Paddle sub_*], email, created_at, last_used_at).
- **KV cache:** ORACLE_API_KEYS namespace caches sha256(key) → {plan, status} with 300s TTL.
- **KNOWN GAP:** request_count increment requires DB migration (ALTER TABLE + Supabase RPC function). Code has comments noting this. Currently only last_used_at is updated.
- **KNOWN GAP:** receipt_audit table must be manually created. Required by /v5/archive and /v5/receipts.

### Resend (Email Delivery)
- **Status:** Wired. Used for key delivery emails after Paddle payment.
- **Required secret:** RESEND_API_KEY.
- **KNOWN GAP:** If Resend fails, key was still created — response includes { warning, resend_error }.

---

## 5. Auth System

**Check order (src/index.ts:checkApiKey):**
1. MASTER_API_KEY → plan: 'internal', unlimited
2. BETA_API_KEYS (comma-separated) → plan: 'internal', unlimited
3. ORACLE_API_KEYS KV cache (sha256(key) lookup) → varies by plan/tier field
4. Supabase api_keys table (on KV miss)
5. Not found → 403 INVALID_API_KEY

**Key prefixes and their KV tier values:**
- `sb_` → tier: 'sandbox', expires_at, 200-call lifetime
- `ho_free_` → tier: 'free', daily counter in ORACLE_TELEMETRY
- `ho_crd_` → tier: 'credits', balance field (decremented on each use)
- `ho_live_` → plan: 'builder'|'pro'|'protocol', status: 'active'|'suspended'|'cancelled'

**x402 keyless path:**
- No X-Oracle-Key present on /v5/status → check ORACLE_PAYMENT_ADDRESS → return 402 with x402 payload
- With X-Payment header → verify USDC tx → return signed receipt directly

**Free tier daily counter:**
- KV key: `free_usage:{sha256(key)}:{YYYY-MM-DD}` in ORACLE_TELEMETRY, 25h TTL
- Limit: 500 req/day. At 80%: soft warning headers. At 100%: 402/429 gate.

---

## 6. What's Wired vs. Stubbed

### Fully Wired (working end-to-end)
- Ed25519 signing + verification (4-tier fail-closed)
- Schedule engine (28 exchanges, DST via IANA, lunch breaks, holidays 2026–2027)
- KV circuit-breaker overrides (ORACLE_OVERRIDES)
- MCP server (5 tools, JSON-RPC 2.0, optional OAuth Bearer)
- x402 per-request payment verification (both direct RPC and CDP facilitator paths)
- Paddle webhook handling (4 events)
- Sandbox provisioning (email + x402 payment paths)
- Free key self-provisioning (POST /v5/keys/request)
- OAuth 2.0 (client_credentials grant, token introspection)
- Webhook subscriptions + fan-out (Durable Object, HMAC-SHA256 signed delivery)
- SSE stream (Durable Object per MIC)
- Halt monitor cron (every minute, Polygon.io + Alpaca fallback)
- Telemetry (MCP client analytics, referrer tracking, status code counters)
- Rate-limit warning headers (80%/95% soft warnings, Retry-After)
- Design partner detection (>200 req/day per free key → DESIGN_PARTNER_CANDIDATE log)
- Weekly digest cron (Monday 09:00 UTC)

### Partially Wired (code exists, requires human setup)
- **Supabase receipt_audit table** — insertReceiptAudit() calls succeed only if the table exists. Required by /v5/archive and /v5/receipts. SQL migration documented in GAPS.md.
- **Paddle price IDs** — PADDLE_PRICE_ID_BUILDER/PRO/PROTOCOL/CREDITS must be set as Wrangler secrets. If unset, POST /v5/checkout returns 503.
- **request_count increment** — updateKeyUsage() only updates last_used_at. request_count requires DB migration + Supabase RPC function. Noted in code comments.
- **CDP facilitator auth** — CDP_API_KEY_NAME + CDP_API_KEY_PRIVATE_KEY enable the facilitator path. If absent, direct on-chain verification is used (still works).

### Known Issues / Expired State
- **GET /upgrade:** Deadline countdown hardcodes March 31, 2026 expiry. Since that date has passed, the page now renders the "EXPIRED" state on every visit. The page is still functional (shows plan options) but the migration context is stale.
- **GET /pricing:** Served by Cloudflare Pages (pricing.html). The "Current" badge labels "Free Beta" — terminology that predates the current multi-tier model. The /v5/pricing JSON endpoint (added Day 38) is the canonical machine-readable source.
- **Unauthenticated MCP rate limit:** 10 calls/day per IP for get_market_status. IPs are tracked via hashed X-Original-IP headers — these can be spoofed by direct callers bypassing the headlessoracle proxy. Fix: X-Proxy-Token validation (noted in CLAUDE.md scaling section).

---

## 7. Infrastructure

### Cloudflare Workers
- Runtime: TypeScript, compatibility_date: 2024-01-01
- File: src/index.ts (~13,100 lines)
- Deployed: Worker version 6e73cd5d (Apr 5 2026)

### KV Namespaces
| Binding | ID | Purpose | Key Patterns |
|---------|-----|---------|--------------|
| ORACLE_OVERRIDES | 1c741530... | Circuit-breaker halts | `{MIC}` → { status, reason, expires } |
| ORACLE_API_KEYS | aaf52e9a... | Key cache + subscription state + webhook subs | `{sha256(key)}`, `webhooks:{keyHash}`, `webhooks_by_mic:{mic}` |
| ORACLE_TELEMETRY | 6fcde4c9... | Analytics + rate limiting + cron state | `mcp_clients:{date}:{hash}`, `free_usage:{hash}:{date}`, `referrer:{date}:{domain}`, `status_code:{date}:{code}`, `x402_payment_count`, etc. |

### Durable Objects
| Class | Binding | Purpose |
|-------|---------|---------|
| StreamCoordinator | STREAM_COORDINATOR | SSE stream per MIC, signed receipts every 30s |
| WebhookDispatcher | WEBHOOK_DISPATCHER | Alarm-based state-change detection, HMAC-signed fan-out delivery |

### Cron Triggers
| Schedule | Purpose |
|----------|---------|
| `* * * * *` | Real-time halt monitor (Polygon.io primary, Alpaca fallback) |
| `0 9 * * *` | npm download tracking + EU DST date-check reminders |
| `0 17 * * *` | MCP client daily summary (high-engagement detection) |
| `0 9 * * 1` | Weekly digest (Monday, MCP client analytics → KV) |

### Supabase (External)
- **Table: api_keys** — paid key source of truth
- **Table: receipt_audit** — REQUIRES MIGRATION (not yet created)
- Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

---

## 8. npm Package State

| Package | Version | Location | Status |
|---------|---------|----------|--------|
| headless-oracle-mcp | 1.0.3 | packages/headless-oracle-mcp/ | Live on npm. stdio MCP server. Zero deps. Proxies to headlessoracle.com/mcp. |
| @headlessoracle/verify | 1.0.0 | github.com/LembaGang/headless-oracle-verify | Live. Zero prod deps. Web Crypto only. |
| headless-oracle | 0.1.0 (PyPI) | github.com/LembaGang/headless-oracle-python | Live. OracleClient, verify(), LangChain + CrewAI tools. |
| headless-oracle-langchain | 1.0.1 | github.com/LembaGang/headless-oracle-langchain | Live on PyPI. |
| headless-oracle-crewai | 1.0.1 | github.com/LembaGang/headless-oracle-crewai | Live on PyPI. |
| headless-oracle-strands | 1.0.0 | github.com/LembaGang/headless-oracle-strands | Live on PyPI. |
| headless-oracle-setup | 1.0.1 | github.com/LembaGang/headless-oracle-setup | Live on npm. npx headless-oracle-setup for Claude Desktop/Cursor/Windsurf. |
| headless-oracle-go (Go SDK) | — | github.com/LembaGang/headless-oracle-go | Live. crypto/ed25519 verify, 9 tests. |

---

## 9. Test Coverage

**Total: 671 tests in test/index.spec.ts** (+ 24 SDK + 26 LangGraph template + 16 payer-agent in separate repos)

**Coverage by area:**
- Schedule engine: All 28 exchanges, OPEN/CLOSED, holiday, half-day, lunch break, weekend, DST boundary, year boundary (UNKNOWN for missing data)
- Auth: MASTER_KEY, beta keys, KV cache hit/miss, Supabase fallback, sandbox expiry, credits exhausted, suspended/cancelled
- Routes: All major routes have happy path + error + auth state tests
- MCP: initialize, tools/list, tools/call (all 5 tools), invalid JSON, missing params, unknown method, resources/list, prompts/list
- x402: 402 response shape, on-chain mock verify, replay protection, CDP facilitator mock
- Webhooks: subscribe, list, delete, test delivery, HMAC signature, plan limits
- Cron: halt monitor, daily summary, weekly digest
- Telemetry: MCP client tracking, referrer tracking, status code counters

**Known coverage gaps:**
- /v5/archive — requires live Supabase receipt_audit table; tested with mock
- /v5/stream — SSE Durable Object tested for route existence; full stream event sequence not covered
- /v5/pricing — **added Day 38, needs test** (currently 0 tests)
- Paddle production webhook — tested with mock signature; production key rotation not tested

---

## 10. Standing Gap (agent-consumption scale)

The current trust model is **operator-reputation trust**: consumers trust the oracle because LembaGang signs the receipts. At agent-consumption scale, this needs to become **verifiable multi-party trust** where 2+ independent operators must agree on market state before a receipt is considered valid.

The architecture (Ed25519) was chosen to compose into this cleanly. The MPAS spec (docs/multi-party-attestation-spec.md) defines the protocol. The gap is the second operator: without a second independent signing party, MPAS is a specification without a network.

**The thing that matters at scale that this sprint does not solve:** a second signing party willing to independently attest to market state and aggregate receipts per the MPAS protocol. This converts oracle infrastructure from "trust one company" to "verify a quorum" — the threshold that unlocks institutional and DeFi adoption.
