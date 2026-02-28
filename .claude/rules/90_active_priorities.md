# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Production-ready. Billing implemented. Pre-launch (March 10 HN launch).
**Test suite**: 154/154 tests passing (worker) + 24/24 tests passing (SDK)
**Live endpoints**: All 200 — /v5/demo, /v5/health, /v5/exchanges, /v5/schedule, /v5/keys, /v5/batch, /robots.txt, /llms.txt, /SKILL.md, /.well-known/oracle-keys.json, /.well-known/agent.json, /openapi.json
**www redirect**: www.headlessoracle.com/* → 301 → headlessoracle.com/* (Worker-level, permanent)
**@headlessoracle/verify**: Published — npmjs.com/package/@headlessoracle/verify v1.0.0 (published 4 days ago, auth token in ~/.npmrc)
**Last significant work**: Feb 28 2026 (evening) — content + computed edge-case utility:
  - **llms.txt**: Added `## Edge Cases This API Handles` section (7 bullet points covering DST, holidays, early closes, lunch breaks, circuit breakers, weekends, UNKNOWN handling; closes with ~1,300/year figure)
  - **SKILL.md**: Added `## When to Use Headless Oracle vs a Timezone Library` comparison table (8-row two-column with rule-of-thumb)
  - **edgeCaseCount(year)**: Exported utility function that computes schedule edge cases directly from MARKET_CONFIGS — holidays, halfDays, DST transitions (detected via Intl UTC-offset Jan vs Jul), lunchBreakSessions (weekdays minus weekday holidays per lunch-break exchange), weekendDays. Replaces hardcoded ~1,311 comment.
  - **6 new tests**: Assert 2026 values component-by-component; total = 1,319 (81 + 9 + 8 + 493 + 728). Drift is now test-caught.
  - **npm publish status confirmed**: @headlessoracle/verify@1.0.0 live on npm, published by mbeenz. Auth token in ~/.npmrc.
  - **Deployed**: Worker (commit d917197) live and verified. 154/154 tests passing.
**Previous significant work**: Feb 28 2026 — legal fixes, SEO, www redirect, llms.txt single source of truth:
  - **Legal**: 4 playbook fixes in terms.html + api-disclaimer-draft.md (12-month cap, no retroactive voiding, third-party data disclaimer, signature scope clarification)
  - **llms.txt**: Deleted orphaned copies from web repo; LLMS_TXT constant in src/index.ts is sole source of truth — no manual sync ever needed again
  - **www redirect**: Worker handles www.headlessoracle.com/* with 301 → bare domain; prevents Pages cache divergence permanently
  - **SEO**: All 6 HTML pages have meta description, og:*, robots meta; index+docs have link rel alternate for openapi.json and llms.txt
  - **MCP auth prompts**: Suppressed via permissions.deny in ~/.claude/settings.json (8 legal plugin OAuth connectors blocked — skill still works)
  - **.gitignore**: MCP token files (.mcpregistry_*) and .claude/settings.local.json excluded
  - **legal-playbook.md**: Committed to worker repo
  - **Deployed**: Worker (commit 1414dc1) + Pages (commit a1b0d86) both live and verified
  - 148/148 tests passing
**Previous significant work**: Feb 26 2026 — error code standardisation + SEO audit + content creation:
  - **Error codes**: All 405 errors now `METHOD_NOT_ALLOWED` (SCREAMING_SNAKE_CASE); all auth errors include `message` field
  - **OpenAPI**: Server URL corrected (`headlessoracle.com`); new paths added (`/robots.txt`, `/llms.txt`, `/SKILL.md`, `/.well-known/agent.json`); error response schemas completed for all routes
  - **wrangler.toml**: Rate limiting comments expanded to all 10 public routes with notes on what NOT to rate-limit
  - **docs/hn-launch-post.md**: Three Show HN variants for March 10 launch
  - **docs/dst-risk-article.md**: ~1100-word technical article on DST risks for trading agents
  - **Web SEO**: All 6 HTML pages now have `<meta description>`, `og:title`, `og:description`, `og:type`, `og:url`, `<meta name="robots">`. index.html and docs.html have `link rel="alternate"` for openapi.json and llms.txt. Fixed stale `workers.dev` URL in status.html.
  - **Deployed**: Worker (commit 2b24036) + Pages (commit a294d19) both live
  - 148/148 tests passing
**Previous significant work**: Feb 25 2026 — full website audit + LLMS_TXT expansion + deploy:
  - **LLMS_TXT**: Added `## Code Examples` (Python PyNaCl, JS Web Crypto, fail-closed bot pattern, key fetching), `## Known Schedule Risk Events` (DST table 2026), and full docs for /v5/batch, /v5/keys, /v5/health, /v5/account, POST /v5/checkout — every public route now covered
  - **docs.html**: Added `#mcp` section (MCP setup for Claude Desktop, 3 tools documented), `/v5/batch` docs, `#billing` section (/v5/account, /v5/checkout, error codes 401/402/403), sidebar updated with new anchors
  - **index.html**: Added MCP server mention with link to docs.html#mcp and llms.txt
  - **Website audit**: terms.html ✅ #fail-closed + #no-liability, privacy.html ✅ consistent, verify.html ✅ correct key, ed25519-public-key.txt ✅ correct key (03dc...), no stale terms_hash or wrong fingerprint in live codebase
  - **llms.txt synced**: headless-oracle-v5/public/, headless-oracle-web/llms.txt, headless-oracle-web/public/llms.txt all match LLMS_TXT constant
  - **Deployed**: Worker (headless-oracle-v5) + Pages (headless-oracle-web) both live
  - 141/141 tests passing
  - `GET /robots.txt` — live; permits AI crawlers to all public endpoints
  - `GET /llms.txt` — live; full structured coverage for LLM crawlers
**Previous significant work**: Feb 24 2026 — Paddle billing (Stripe → Paddle swap):
  - `POST /v5/checkout` — creates Paddle transaction (`POST https://api.paddle.com/transactions`), returns `{ url }`, no auth
  - `POST /webhooks/paddle` — verifies `Paddle-Signature` header (format: `ts=<ts>;h1=<hex>`, signed content: `<ts>:<body>`, HMAC-SHA256, 5-min replay protection), handles 4 events:
    - `transaction.completed` → idempotency guard (skip if `stripe_subscription_id` already exists in Supabase) + skip if no `subscription_id` (one-time payment guard) → generate `ok_live_<32 random hex bytes>` key, fetch email via Paddle customer API, hash + store in Supabase `api_keys` table, warm `ORACLE_API_KEYS` KV cache (TTL 300s), send key via Resend (shown once)
    - `subscription.updated` → update `status` in Supabase (active→active, else suspended)
    - `subscription.past_due` → set `status = 'suspended'` in Supabase
    - `subscription.canceled` → set `status = 'cancelled'` in Supabase
  - `GET /v5/account` — requires `X-Oracle-Key`, returns `{ plan, status, key_prefix }`
  - `checkApiKey` (async, 5-step hot path) — unchanged
  - New status code: 402 PAYMENT_REQUIRED for suspended/cancelled (distinguishable from 403 by agents)
  - New KV namespace: `ORACLE_API_KEYS` (id: real ID needed before deploy)
  - Secrets needed: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID`, `RESEND_API_KEY`
    (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` already in .dev.vars)
  - All 112 existing tests pass unchanged; 25 new billing tests added (137 total — 2 more than Stripe version for idempotency + non-subscription guards)
  - OpenAPI spec updated: `/webhooks/stripe` → `/webhooks/paddle`, event names updated
  - ADR-019 updated in 10_decisions.md
**Previous significant work**: Feb 24 2026 — gap 10 fully resolved (@headlessoracle/verify SDK published):
  - `@headlessoracle/verify` live at npmjs.com/package/@headlessoracle/verify
  - Zero production dependencies — uses Web Crypto API (crypto.subtle)
  - Single `verify(receipt, options?)` function: fields check → TTL check → Ed25519 verification
  - Handles all receipt types: SCHEDULE, OVERRIDE (with reason), HEALTH (no mic/schema_version)
  - `publicKey` option skips key registry fetch — essential for high-throughput agent use
  - `keysUrl` option supports staging/self-hosted instances
  - `now` option supports time-override in consumer tests
  - 6 machine-readable failure reasons: MISSING_FIELDS, EXPIRED, UNKNOWN_KEY, INVALID_SIGNATURE, KEY_FETCH_FAILED, INVALID_KEY_FORMAT
  - Dual ESM + CJS build via tsup; TypeScript declarations included
  - 24/24 tests passing; tests sign with noble/ed25519, verify with Web Crypto — true round-trip integration test
  - ADR-018 added to 10_decisions.md
  - GitHub: github.com/LembaGang/headless-oracle-verify
**Previous significant work**: Feb 23 2026 — gap 8 resolved (/v5/batch) + /.well-known/oracle-keys.json added:
  - `GET /v5/batch?mics=XNYS,XNAS,XLON` live: authenticated, parallel, independently signed receipts
  - Full 4-tier fail-closed applies per-MIC; Tier 3 failure fails the whole batch
  - Deduplicates MICs, validates all up front, preserves request order
  - `GET /.well-known/oracle-keys.json` live: RFC 8615 standard key-discovery URI
  - Returns active key data (without canonical_payload_spec) for web-standard discoverability
  - OpenAPI spec updated for both new routes
  - 22 new tests added (112 total); all 112 pass
  - ADR-016 (batch) and ADR-017 (well-known) added to 10_decisions.md
**Previous significant work**: Feb 22 2026 — gap 9 resolved (MCP server):
  - `POST /mcp` live: MCP Streamable HTTP, JSON-RPC 2.0, protocol version `2024-11-05`
  - Three tools: `get_market_status`, `get_market_schedule`, `list_exchanges`
  - No new npm dependencies — tools call the same internal functions as REST routes
  - `buildSignedReceipt` extracted as shared function: 4-tier fail-closed applies equally to MCP and REST
  - MCP handler outside main try/catch — returns JSON-RPC error format, never REST CRITICAL_FAILURE
  - CORS updated to allow POST; OpenAPI spec updated with `/mcp` path
  - 10 new MCP tests added (90 total); all 90 pass
  - ADR-015 added to 10_decisions.md
  - Oracle is now discoverable from Claude Desktop, Cursor, and MCP-compatible agents
**Previous significant work**: Feb 22 2026 — gaps 4 + 11 resolved (terms_hash rename, /v5/health):
  - `terms_hash` renamed to `schema_version`, value updated `'v5.0-beta'` → `'v5.0'`
  - Breaking change to signed payload schema — done pre-launch while zero consumers exist
  - `/v5/health` endpoint live: signed liveness probe, public, no auth
  - Health receipt: `{ receipt_id, issued_at, expires_at, status: 'OK', source: 'SYSTEM', public_key_id, signature }`
  - No `mic` field — health is system-level, not exchange-specific
  - On signing failure: 500 CRITICAL_FAILURE (same pattern as Tier 3)
  - `health_fields` added to canonical_payload_spec in `/v5/keys`
  - ADR-013 (health endpoint) and ADR-014 (schema_version) added to 10_decisions.md
  - 4 new health tests added (80 total)
**Previous significant work**: Feb 22 2026 — HIGH gaps 5 + 6 resolved:
  - `valid_until` added to `/v5/keys` response (null by default; set via `PUBLIC_KEY_VALID_UNTIL` env var)
  - Gap 5 now fully resolved: key rotation has `valid_from` + `valid_until`
  - `lunch_break: { start, end } | null` added to `/v5/schedule` response for all MICs
  - XJPX returns `{ start: '11:30', end: '12:30' }` (local JST), XHKG `{ start: '12:00', end: '13:00' }` (local HKT)
  - All other MICs return `lunch_break: null` — explicit signal, not absent field
  - lunch_break times are local exchange time (see `timezone` field); `note` field updated accordingly
  - OpenAPI spec updated for both changes
  - 4 new lunch_break tests + 1 valid_until assertion added (76 total)
**Previous significant work**: Feb 22 2026 — HIGH gap 7 resolved (holiday time bomb)
**Next session trigger**: User completes human tasks → HN launch March 10.
**npm publish**: @headlessoracle/verify@1.0.0 confirmed live on npmjs.com. Auth token already in ~/.npmrc. Human task marked DONE.

## Immediate Next Engineering Tasks (when user returns)
1. **Before deploy: Supabase schema** — create the `api_keys` table (human task):
   ```sql
   create table api_keys (
     id                       uuid primary key,
     key_hash                 text unique not null,
     key_prefix               text not null,
     plan                     text not null default 'pro',
     status                   text not null default 'active',
     stripe_customer_id       text,
     stripe_subscription_id   text,
     email                    text,
     created_at               timestamptz not null,
     last_used_at             timestamptz
   );
   create index on api_keys (key_hash);
   create index on api_keys (stripe_subscription_id);
   ```
2. **Before deploy: Cloudflare KV** — create `ORACLE_API_KEYS` namespace in Cloudflare Dashboard, replace placeholder ID `00000000000000000000000000000001` in `wrangler.toml` with the real namespace ID, then redeploy.
3. **Before deploy: set secrets** via `wrangler secret put`:
   - `PADDLE_API_KEY` (live API key from Paddle Dashboard → Developer → Authentication)
   - `PADDLE_WEBHOOK_SECRET` (from Paddle Dashboard → Notifications → endpoint secret)
   - `PADDLE_PRICE_ID` (from Paddle Dashboard → Catalog → Prices, format: `pri_*`)
   - `SUPABASE_URL` (already in .dev.vars — add production value)
   - `SUPABASE_SERVICE_ROLE_KEY` (already in .dev.vars — add production value)
   - `RESEND_API_KEY` (from Resend Dashboard)
4. **Before deploy: register Paddle webhook** — point `POST https://api.headlessoracle.com/webhooks/paddle` at the worker, select events: `transaction.completed`, `subscription.updated`, `subscription.past_due`, `subscription.canceled`
5. **Paddle billing** — DONE ✓

2. **Add rate limiting in Cloudflare Dashboard** — must be done before HN launch (March 10)
   - Dashboard: Workers & Pages → headless-oracle-v5 → Settings → Rate Limiting
   - Rules to add:
     - `/v5/demo*`     → 100 req/min per IP → Block (429)
     - `/v5/schedule*` → 60 req/min per IP  → Block (429)
     - `/v5/exchanges` → 60 req/min per IP  → Block (429)
     - `/v5/keys`      → 60 req/min per IP  → Block (429)
   - `/v5/status` is already protected by API key auth — no rate limit rule needed
   - **This is a human task** — must be done in the Cloudflare Dashboard

2. **Beta API key provisioning** — when first prospect wants to test /v5/status
   - Add their key to `BETA_API_KEYS` secret via:
     `wrangler secret put BETA_API_KEYS` (enter comma-separated list including new key)
   - Format: `existing_key,new_key_for_ondo`
   - Then redeploy: `wrangler deploy`

3. **Monitoring / alerting** — optional but recommended before scale
   - Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Metrics
   - Set up email alerts for Worker errors (4xx/5xx spikes)

## Sprint Goals (Pre-March 8)
- [x] 7 exchanges live and tested
- [x] /v5/schedule and /v5/exchanges endpoints live
- [x] KV circuit breaker override system live
- [x] status.html live dashboard
- [x] 66-test suite passing
- [x] CLAUDE.md files updated in both repos
- [x] Risk committee status update written
- [x] Financial model written
- [x] DST exploit demo repo published on GitHub (github.com/LembaGang/dst-exploit-demo)
- [x] All internal frontend links fixed (extensionless paths)
- [x] Operator runbook written (headless-oracle-v5/OPERATOR_RUNBOOK.md)
- [x] Business handover document written (C:/Users/User/Headless Oracle/Business/HANDOVER.md)
- [x] DST risk article written (headless-oracle-v5/docs/dst-risk-article.md)
- [x] HN launch post drafted (3 variants in headless-oracle-v5/docs/hn-launch-post.md)
- [x] All HTML pages have OG tags and robots meta
- [x] @headlessoracle/verify published to npm (v1.0.0 — confirmed live)
- [x] llms.txt ## Edge Cases This API Handles section added
- [x] SKILL.md timezone library comparison table added
- [x] edgeCaseCount() utility built — 6 tests, total 1,319 for 2026, drift is now test-caught
- [ ] Phantom Hour article published (human task — Gemini draft ready)
- [ ] Twitter/X thread posted (human task)
- [ ] 15 targeted DMs sent (human task — begins Feb 28)
- [ ] Rate limiting configured in Cloudflare Dashboard (human task — before March 10)

## Codebase Health
- **Worker**: headless-oracle-v5 | main branch | deployed to Cloudflare Workers (commit d917197)
- **Frontend**: headless-oracle-web | main branch | deployed to Cloudflare Pages via `npm run deploy`
- **DST Demo**: dst-exploit-demo | master branch | published on GitHub
- **SDK**: @headlessoracle/verify@1.0.0 | npmjs.com/package/@headlessoracle/verify | 24/24 tests passing
- **Tests**: 154/154 passing. `.dev.vars` populated with test-only keypair.
- **Public key**: `03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178` (production)
- **All live pages**: headlessoracle.com, /docs, /status, /verify, /terms, /privacy, /llms.txt, /openapi.json

## Known Issues / Blockers
- **No rate limiting on public routes yet**: Acceptable at zero-traffic stage. Must add before HN launch.
  See: OPERATOR_RUNBOOK.md → Section 5. Dashboard instructions are ready.

## DST Calendar — Critical Dates
- **March 8, 2026**: US clocks spring forward (EST→EDT). XNYS + XNAS affected. Phantom hour 2–3am ET.
- **March 10, 2026**: Hacker News "Show HN" launch. Tuesday 10am ET.
- **March 29, 2026**: UK/EU clocks spring forward (GMT→BST / CET→CEST). XLON + XPAR affected.
- **October 25, 2026**: UK/EU fall back. XLON + XPAR.
- **November 1, 2026**: US fall back. XNYS + XNAS.

## Architectural Gaps (identified Feb 21 2026 — post-code-review)
<!-- These are the gaps the current architecture does not solve that will matter at agent scale.
     Work through these in priority order after HN launch. -->

### CRITICAL — blocks agent adoption
1. ~~**No `expires_at` in signed receipts**~~ **RESOLVED Feb 22 2026**
   All signed receipts now include `expires_at: issued_at + 60s`. Signed in the canonical
   payload. Consumers must not act on receipts past their `expires_at`.

2. ~~**No OpenAPI / machine-readable schema**~~ **RESOLVED Feb 22 2026**
   `/openapi.json` is live. OpenAPI 3.1 spec covers all routes, schemas, auth, and error
   shapes. Agent-discoverable without reading documentation.

3. ~~**Canonical signing payload is implicit, not documented**~~ **RESOLVED Feb 22 2026**
   `signPayload` sorts keys alphabetically (deterministic regardless of insertion order).
   Field lists documented at `/v5/keys → canonical_payload_spec`. Consumer SDKs can now
   implement independent verification against a published spec.

### HIGH — needed before scale
4. ~~**`terms_hash` is a label, not a hash**~~ **RESOLVED Feb 22 2026**
   Field renamed to `schema_version`, value updated to `'v5.0'`. Accurately describes what
   the field is: a schema version identifier. Done pre-launch while zero consumers exist.
   If a true cryptographic commitment to a terms document is needed later, that is a new
   field (`terms_hash`) to add alongside `schema_version`, not a rename.

5. ~~**Key rotation has no lifecycle**~~ **RESOLVED Feb 22 2026**
   `/v5/keys` now returns `valid_from` (populated via `PUBLIC_KEY_VALID_FROM` env var, default
   `2026-01-01T00:00:00Z`) and `valid_until` (populated via `PUBLIC_KEY_VALID_UNTIL` env var,
   default `null`). Set `PUBLIC_KEY_VALID_UNTIL` before a scheduled key rotation to signal
   consumers before the key expires.

6. ~~**Lunch breaks missing from `/v5/schedule`**~~ **RESOLVED Feb 22 2026**
   `/v5/schedule` now returns `lunch_break: { start, end } | null` for all MICs.
   XJPX: `{ start: '11:30', end: '12:30' }` (local JST).
   XHKG: `{ start: '12:00', end: '13:00' }` (local HKT).
   All other MICs: `null` — explicit field, not absent. Times are local exchange time;
   timezone is already in the response. OpenAPI spec updated.

7. ~~**Holiday lists are 2026-only — time bomb**~~ **RESOLVED Feb 22 2026**
   `holidays` is now year-keyed (`Record<string, string[]>`). 2027 data added for all 7
   exchanges. Fail-closed guard returns UNKNOWN/SYSTEM if the current year has no data —
   converts a silent wrong answer into a detectable safe state.
   **ANNUAL MAINTENANCE**: Before Dec 31 each year, add the following year's holidays to
   all 7 configs in `src/index.ts` and run `npm test`. Lunar/Islamic/Hindu calendar dates
   (XHKG, XSES) need manual verification from official exchange calendars.

### MEDIUM — when consumer base grows
8. ~~**No batch query**~~ **RESOLVED Feb 23 2026**
   `GET /v5/batch?mics=XNYS,XNAS,XLON` is live. Authenticated, parallel, independently
   signed. Full 4-tier fail-closed applies per-MIC. Deduplicates, validates all MICs up
   front, preserves request order. 15 new tests added.

9. ~~**No MCP server**~~ **RESOLVED Feb 22 2026**
   `POST /mcp` is live. MCP Streamable HTTP, protocol `2024-11-05`. Three tools:
   `get_market_status` (signed receipt, same 4-tier safety), `get_market_schedule`,
   `list_exchanges`. Oracle is now discoverable from Claude Desktop, Cursor, and any
   MCP-compatible agent. No new npm dependencies. 10 tests added (90 total).
   **Next binding constraint**: polling pressure at scale — see gap 13 (push/webhook).

10. ~~**No consumer verification SDK**~~ **RESOLVED Feb 24 2026**
    `@headlessoracle/verify` package built at `C:\Users\User\headless-oracle-verify\`.
    3-line verification, zero prod deps, dual ESM+CJS build, 24 tests.
    **HUMAN TASK**: Publish to npm — `npm publish --access public` after creating npm org `@headlessoracle`.
    Full 3-line example in README: fetch receipt → `verify(receipt, { publicKey })` → check `receipt.status`.

11. ~~**No health endpoint**~~ **RESOLVED Feb 22 2026**
    `GET /v5/health` is live. Returns a signed receipt (`status: 'OK', source: 'SYSTEM'`).
    On signing failure returns 500 CRITICAL_FAILURE. Agents can now distinguish Oracle-down
    from market-UNKNOWN: a valid signed health receipt confirms the signing infrastructure works.

### LONG-TERM — when federation matters
12. **Single-operator trust model**
    "Trust Oracle" currently means "trust LembaGang." At root-server scale, this must
    become multi-party. Fix: threshold Ed25519 (e.g. 2-of-3 operators). Ed25519 was
    chosen to make this composable when needed.

13. **No push/webhook model**
    Agents polling at scale is wasteful and creates rate-limit pressure. The correct
    primitive is: subscribe to XNYS status changes, receive a signed push when state
    changes. Fix: Cloudflare Durable Objects or Queues for stateful subscriptions.

## Context for Next Session
Start by reading:
1. This file (done)
2. `.claude/rules/05_strategic_vision.md` for north star and decision filters
3. `.claude/rules/00_engineering_standards.md` for hard rules
4. `.claude/rules/10_decisions.md` for architectural context
5. `OPERATOR_RUNBOOK.md` for operational procedures
6. `src/index.ts` if touching core logic
