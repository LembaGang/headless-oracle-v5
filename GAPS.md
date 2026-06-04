# Known Gaps — Headless Oracle V5

Identified gaps that are not yet closed, in priority order.
Updated: 2026-03-21

---

## GAP-001 — MCP traffic not metered against plan limits
**Priority**: HIGH — revenue leak
**Status**: CLOSED — 2026-03-21

`_mcpKeyHash` is computed in `handleMcp` when a valid OAuth Bearer token is
present, but `getPlanDailyLimit()` is never applied to MCP calls. An authenticated
MCP client can make unlimited requests regardless of plan.

**Fix**: After soft-auth resolves `_mcpKeyHash`, call `getPlanDailyLimit(plan)` and
check the KV counter (`free_usage:{keyHash}:{date}` for free tier, `paid_usage:...`
for paid) the same way `/v5/status` and `/v5/batch` do today.

**Implementation notes**:
- Reuse the existing `getFreeUsageCount` / increment pattern from the REST auth gate
- MCP requests authenticated via OAuth should count against the key's daily limit
- Unauthenticated MCP requests remain unlimited (no keyHash, no metering possible)
- Return JSON-RPC error `{ code: -32000, message: 'RATE_LIMITED' }` on limit hit,
  not a 429 HTTP response (MCP always returns HTTP 200)
- Add tests: metered MCP at limit returns -32000, metered MCP below limit succeeds,
  unauthenticated MCP at any volume succeeds

---

## GAP-002 — `/.well-known/x402.json` returns empty `payTo` when `ORACLE_PAYMENT_ADDRESS` unset
**Priority**: MEDIUM — correctness
**Status**: CLOSED — 2026-03-21

When `env.ORACLE_PAYMENT_ADDRESS` is not set (e.g. staging environments, local dev
without the secret), `/.well-known/x402.json` returns `payTo: ""` for both resources.
x402scan and payment-aware clients may reject or cache the malformed response.

**Fix**: When `ORACLE_PAYMENT_ADDRESS` is unset, omit the entire `resources` array
(or return an empty array) rather than including resources with `payTo: ""`. This is
consistent with how the 402 gate itself behaves — it falls back to 401 when the
payment address is absent.

**Implementation notes**:
- Change the `/.well-known/x402.json` handler to check `env.ORACLE_PAYMENT_ADDRESS`
  before building the resources array
- If unset: `return json({ version: 1, resources: [] })`
- Update the 3 existing x402.json tests to assert non-empty payTo when set
- No new routes or KV changes required

---

## GAP-003 — No OAuth token introspection endpoint (RFC 7662)
**Priority**: MEDIUM — ecosystem completeness
**Status**: CLOSED — 2026-03-21

`POST /oauth/introspect` does not exist. Third-party tools and agents that receive an
Oracle OAuth token cannot verify its validity or metadata (plan, expiry) without
making a live MCP call. This limits token portability between agents.

**Fix**: Implement `POST /oauth/introspect` per RFC 7662. Accepts `token` parameter
(form-encoded), returns `{ active: true, scope, client_id, exp }` for valid tokens
and `{ active: false }` for invalid/expired ones.

**Implementation notes**:
- Token lookup: `oauth:{sha256(token)}` in `ORACLE_API_KEYS` KV — same as MCP soft auth
- `exp` field = current time + remaining TTL (KV does not expose TTL directly; store
  `expires_at` in the KV value at issuance time to avoid a second KV call)
- Add `headlessoracle.com/oauth/introspect` to wrangler.toml routes
- Add `introspection_endpoint` to `/.well-known/oauth-authorization-server` response
- 3 new tests: valid token → active:true with correct fields, invalid token → active:false,
  missing token → 400

**Prerequisite**: The token KV record must include `expires_at`. Currently it stores
`{ keyHash, plan, status }` only. `handleOAuthToken` needs a one-line change to add
`expires_at: Date.now() + 3600000` at issuance.

---

## GAP-004 — `subscription.activated` + `transaction.completed` race condition
**Priority**: MEDIUM — billing correctness
**Status**: CLOSED — 2026-03-21

Both `transaction.completed` and `subscription.activated` can fire for the same
subscription within milliseconds of each other. The unique constraint on
`stripe_subscription_id` in Supabase prevents duplicate key generation, but the
application-layer idempotency guard (select → check → insert) has a TOCTOU window
under concurrent webhook delivery.

**Fix**: Replace the select-then-insert pattern with an upsert on `stripe_subscription_id`.
Postgres `INSERT ... ON CONFLICT (stripe_subscription_id) DO NOTHING` eliminates the
race at the database layer without application-layer locking.

**Implementation notes**:
- Supabase: use `.upsert({ ...row }, { onConflict: 'stripe_subscription_id', ignoreDuplicates: true })`
- This requires `stripe_subscription_id` to have a unique index (already exists per ADR-019)
- Low-urgency: Paddle webhook delivery is sequential per subscription in practice;
  race is theoretical at current volume. Address before scale.

---

## GAP-005 — www.headlessoracle.com HTTP redirect verification
**Priority**: LOW — ops hygiene
**Status**: CLOSED — 2026-03-21 (confirmed externally: http://www.headlessoracle.com returns 301)

HTTP (non-HTTPS) requests to `www.headlessoracle.com` appear in logs. It is unconfirmed
whether these are correctly redirected to `https://headlessoracle.com` or are hitting
the Worker as HTTP and being served without a TLS upgrade.

**Fix**: Verify the Cloudflare zone setting "Always Use HTTPS" is enabled for
`headlessoracle.com`. This is a Cloudflare Dashboard setting, not a Worker code change.

**Verification steps**:
1. Dashboard → headlessoracle.com → SSL/TLS → Edge Certificates → "Always Use HTTPS" = On
2. `curl -v http://www.headlessoracle.com/v5/health` — confirm 301 to `https://headlessoracle.com/v5/health`
3. If still serving HTTP: add explicit redirect in Worker fetch handler before all routes

**Implementation notes** (if Dashboard toggle is insufficient):
```typescript
// At the very top of the fetch handler, before url is parsed:
if (request.url.startsWith('http://')) {
  return Response.redirect(request.url.replace('http://', 'https://'), 301);
}
```

---

## GAP-006 — x402scan full server listing pending manual approval
**Priority**: LOW — distribution
**Status**: Blocked on external action

`/v5/status` and `/v5/batch` return correct 402 responses. `/.well-known/x402.json`
discovery document is live. x402scan has crawled and partially registered the resources.
Full server listing in the x402scan directory is blocked pending manual approval by
Sam Ragsdale.

**Fix**: Human task — contact Sam Ragsdale to complete the x402scan listing.

**Implementation notes**:
- No code changes required
- Resubmit via x402scan registration flow after contacting Sam
- The technical blockers (input schema, discovery document) are resolved
- Reference: x402scan errors were "Missing input schema" (fixed: input field in buildX402ScanPayload)
  and "No valid x402 response on free endpoints" (fixed: /.well-known/x402.json discovery doc)

---

## GAP-007 — OAuth soft-auth doesn't check token expiry
**Priority**: LOW — correctness
**Status**: CLOSED — 2026-03-22

`handleMcp` soft-auth accepts tokens that have logically expired but haven't yet been
evicted from KV. KV TTL is the authoritative expiry but eventual consistency means a
small window exists where `expires_at` has passed but the key is still retrievable.
The introspection endpoint (`handleOAuthIntrospect`) already handles this correctly.

**Fix** (one line in `handleMcp` Bearer validation block):
```typescript
if (parsed.expires_at && Math.floor(Date.now() / 1000) > parsed.expires_at) {
  // fall through as anonymous — token logically expired
}
```

**Implementation notes**:
- Add after `if (parsed.status === 'active')` check in the soft-auth try block
- No KV changes, no new routes, no wrangler.toml changes
- Add one test: pre-seed a token record with `expires_at` in the past, verify MCP
  call with that token proceeds as anonymous (returns 200 with `result`, not blocked)
- Effort: ~5 minutes

---

## GAP-008 — `verify_receipt` skill declared but no MCP tool implementation
**Priority**: MEDIUM — A2A routing correctness
**Status**: CLOSED — 2026-03-22

The Agent Card (`/.well-known/agent.json`) declares a `verify_receipt` skill but
`POST /mcp` has no corresponding tool method. A2A orchestrators routing by skill id
will get a `-32601 Method Not Found` response.

**Fix**: Implement `verify_receipt` as an MCP tool that accepts a receipt JSON object
and returns `{ valid: boolean, reason: string }`.

**Implementation notes**:
- Add `verify_receipt` to the `tools/list` response in `handleMcp`
- Tool input: `{ receipt: object }` — the full signed receipt payload
- Verification: reconstruct canonical payload (alphabetical key sort, compact JSON),
  verify Ed25519 signature against the public key from env, check `expires_at`
- Return `{ valid: true, reason: "signature_valid" }` or `{ valid: false, reason: "<MISSING_FIELDS|EXPIRED|INVALID_SIGNATURE>" }`
- Use `@noble/ed25519` (already a dependency) for verification — same lib as signing
- Add 3 tests: valid receipt → true, expired receipt → false, tampered receipt → false
- Effort: ~1 hour. Blocked on nothing.

---

## GAP-009 — `/.well-known/mcp/server-card.json` stale / incomplete
**Priority**: LOW — discoverability
**Status**: CLOSED — 2026-03-22

The server-card returned `url` (should be `mcp_endpoint`), `version: '1.0.0'` (should
match worker version), and `authentication: 'none'` (wrong — bearer, apiKey, x402 all
accepted). Also missing `verify_receipt` from the `tools` list after GAP-008 was closed.

**Fix**: Updated handler to return canonical fields: `mcp_endpoint`, `version: 'v5.0'`,
`tools: ['get_market_status', 'get_market_schedule', 'list_exchanges', 'verify_receipt']`,
`authentication: ['bearer', 'apiKey', 'x402']`, plus `homepage`, `docs`, `key_request`,
`openapi`, `protocol` fields.

---

## GAP-010 — No market-state webhook push (agents must poll)
**Priority**: MEDIUM — agent efficiency
**Status**: CLOSED — 2026-03-22

Agents consuming Oracle receipts must poll `/v5/status` repeatedly to detect state
changes. At scale this is wasteful and creates rate-limit pressure. No push mechanism
exists to notify subscribers when a market transitions OPEN→CLOSED, CLOSED→OPEN, or
enters HALT.

**Fix**: Implemented `POST /v5/webhooks/subscribe` and `DELETE /v5/webhooks/unsubscribe`.
State-change detection runs inside `runHaltMonitor()` cron (every minute). On change,
fan-out delivers a signed receipt payload to all registered URLs for that MIC via
`deliverWebhook()` with 1-retry.

**KV design**:
- `webhooks:{keyHash}` — subscription list for a key (JSON array of `WebhookSubscription`)
- `webhooks_by_mic:{mic}` — delivery index per MIC (JSON array of `WebhookDeliveryTarget`)
- `last_state:{mic}` — previous state string for change detection (in `ORACLE_API_KEYS` KV)

**Known limitation**: Two concurrent cron invocations could both detect the same transition
and double-deliver. Accepted at current scale. Hardening path: Cloudflare Durable Objects
for atomic state compare-and-swap. Subscribers should treat webhooks as advisory and
re-verify via `/v5/status`.

---

## GAP-011 — No receipt audit trail
**Priority**: MEDIUM — billing / compliance
**Status**: CLOSED — 2026-03-22

No server-side record of which key fetched which receipt at what time. Design partners
and enterprise customers will ask for usage audit logs. Currently only KV counters exist
(totals), not individual request records.

**Fix**: `insertReceiptAudit()` helper inserts `{ key_hash, mic, status, source, issued_at,
schema_version }` into a `receipt_audit` Supabase table via non-blocking `ctx.waitUntil()`
on every `/v5/status` live call. `GET /v5/receipts` (auth required) exposes filtered query
with `limit`, `mic`, and `from` params.

**Human task**: Run Supabase migration:
```sql
CREATE TABLE receipt_audit (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  key_hash       text NOT NULL,
  mic            text NOT NULL,
  status         text NOT NULL,
  source         text NOT NULL,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  schema_version text NOT NULL DEFAULT 'v5.0'
);
CREATE INDEX ON receipt_audit(key_hash, issued_at DESC);
```

---

## GAP-012 — `/v5/batch` `safe_to_execute` ignores REALTIME overrides
**Priority**: LOW — correctness at scale
**Status**: CLOSED — 2026-03-22

`safe_to_execute` in the `/v5/batch` summary is computed from static schedule-based
status at the time the batch runs. The halt monitor writes REALTIME overrides to
`ORACLE_API_KEYS` KV asynchronously. A batch call issued milliseconds after a halt
monitor write may read stale status and return `safe_to_execute: true` even though
a REALTIME override is active.

**Fix**: Before computing the summary, re-read `ORACLE_OVERRIDES` for each MIC after
`buildSignedReceipt` returns (or rely on the already-built receipts' `source` field —
`source === 'REALTIME'` means a halt-monitor override is active). If any receipt has
`source: 'REALTIME'` and `status !== 'OPEN'`, force `safe_to_execute: false`.

**Note**: This is a correctness gap for multi-agent workflows that rely on
`safe_to_execute` as a single-call execution gate. At current volume it is a
theoretical race. Fix before advertising `safe_to_execute` as a compliance primitive.

---

## GAP-013 — `/v5/batch` calls not included in receipt audit log
**Priority**: LOW — audit completeness
**Status**: CLOSED — 2026-03-22

`insertReceiptAudit()` is called only from the `/v5/status` handler. Batch calls
that produce N receipts generate zero audit rows. A key making all its queries via
`/v5/batch` will have an empty audit log.

**Fix**: Call `insertReceiptAudit()` for each receipt inside the `results.map()` loop
in the `/v5/batch` handler, wrapped in `ctx.waitUntil(Promise.all([...audits]))`.

---

## GAP-014 — Credit pack keys (`ho_crd_`) have no Supabase record
**Priority**: MEDIUM — audit completeness / billing disputes
**Status**: OPEN

When a credit pack is purchased via Paddle (`POST /v5/checkout?type=credits`), the
resulting `ho_crd_` key is written only to `ORACLE_API_KEYS` KV. Unlike subscription
keys (`ho_live_`), no row is inserted into Supabase `api_keys`. This means:
- `/v5/receipts` audit log is blind to credit-tier usage (audit rows only record `key_hash`)
- `updateKeyUsage()` (`last_used_at` PATCH) fails silently for credit keys (no DB row to update)
- Usage disputes cannot be resolved from Supabase — only KV is authoritative

**Fix**: In the `transaction.completed` Paddle webhook handler, insert a Supabase row for
`ho_crd_` keys using the same schema as subscription keys. Set `plan: 'credits'`,
`status: 'active'`, no `paddle_subscription_id`. The `key_hash` is already computed — add
a `ctx.waitUntil(supabaseInsertCreditsKey(...))` call parallel to the KV write.

**Implementation notes**:
- Supabase insert is non-blocking (`ctx.waitUntil`) — does not affect key delivery latency
- Use `INSERT ... ON CONFLICT (key_hash) DO NOTHING` for idempotency
- No schema change needed — existing `api_keys` table columns cover all required fields
- Add 1 test: `transaction.completed` with credits price_id → Supabase insert called

---

## GAP-015 — No upgrade path from credits tier to subscription without a new key
**Priority**: LOW — UX / agent friction
**Status**: OPEN

A user who bought a credit pack (`ho_crd_` key) and wants to upgrade to a Builder
subscription receives a new `ho_live_` key with a different key hash. They cannot
re-use their existing `ho_crd_` key with upgraded limits. This creates:
- Key rotation friction for agents that have cached the credit key
- No bridge between x402-purchased credits and Paddle subscription billing
- Support burden when users ask "how do I keep my key and upgrade?"

**Fix** (two options):
1. **(Simple)** Document the "two-key" reality explicitly in pricing and at credits exhaustion:
   when `CREDITS_EXHAUSTED` is returned, the `upgrade_url` and `plans` body already point
   to Paddle — add `"key_continuity": "upgrade mints a new key; update your ORACLE_API_KEY env var"`.
2. **(Full fix)** Link credit keys to Paddle: allow `POST /v5/checkout` with
   `{ plan: "builder", existing_key_hash: "..." }` — on `subscription.activated`, upgrade
   the existing KV record to `tier: 'builder'` instead of minting a new key.

Option 1 is the correct immediate fix. Option 2 requires careful idempotency handling.

---

## GAP-017 — Supabase fetches lack `AbortSignal.timeout` + workerd-Windows async-io bug breaks local gate
**Priority**: HIGH (blocks local pre-commit gate on Windows; production unaffected)
**Status**: OPEN — identified 2026-06-02

**Symptom set.** Locally on Windows on 2026-06-02, four tests in `test/index.spec.ts` time out at 5000ms even when run individually, on `main` HEAD `59c975b` with no working-tree changes, on both Node 24.13.0 and Node 22.14.0, after a fresh `npm ci`:
- `In-memory API key cache > second auth call uses in-memory cache — same result as KV`
- `Security headers on all responses > GET /v5/status with API key includes X-Attestation-Mode: live`
- `Ed25519 signing — cryptographic correctness > different receipt_modes produce different signatures (demo vs live)`
- `/v5/batch — additional coverage > batch with 3 MICs returns correct count` (`test/index.spec.ts:11101`)

The vitest reporter mislabels the timeout line as `test/index.spec.ts:9499:31` — a separate vitest source-map / pool-workers reporter bug.

**Genuine production gate (CI) is GREEN.** GitHub Actions CI run `26397564284` on `main` HEAD `59c975b` (re-run 2026-06-02 11:25 UTC): **1064 tests passed, duration 20.38s**, on Linux + Node 22 + npm ci from lockfile. The CI "actual test count (2)" annotation is a flawed `grep -oP '\d+(?= passed)' | head -1` in `.github/workflows/ci.yml:52` that captures the FIRST `N passed` (test FILES) rather than the actual tests count. The summary in the same log is `1050 + 14 = 1064 tests, all green`. **The local-Windows failure is not a code regression.**

**Root cause — two layers.**

**(1) Code-level latent defect (production).** Supabase fetches in `insertReceiptAudit` (`src/index.ts:1781`), `updateKeyUsage`, the `checkApiKey` step-5 Supabase fallback, and other Supabase-touching paths do NOT have `AbortSignal.timeout()`. This is the same discipline gap a43bb6b ("fix(routing,rpc): api.headlessoracle.com passthrough + Base RPC timeouts", 2026-05-25) closed for four Base RPC fetches at `src/index.ts:2222, 2258, 2599, 2628`. Without timeouts, a hung Supabase upstream can stall any request that triggers an audit/key-update path. Latent in production because Supabase is healthy.

**(2) Local environment trigger — workerd Windows async-io bug.** Local `.dev.vars` `SUPABASE_URL` points at the real project hostname `https://sahqfuyneoeqczupmysu.supabase.co`. Local network state on 2026-06-02 has the configured DNS server `103.86.96.100` (VPN) unreachable; `nslookup sahqfuyneoeqczupmysu.supabase.co` times out. CLAUDE.md noted on 2026-05-25 the same hostname fast-failed `#11001 No such host is known`, so the gate was green that day. **Swapping `.dev.vars` `SUPABASE_URL` to CI's placeholder `https://test-placeholder.supabase.co` (verified locally as fast-NXDOMAIN) does NOT fix the gate** — workerd then logs `kj/async-io-win32.c++:805: failed: getaddrinfo(): #11001 No such host is known.; params.host = test-placeholder.supabase.co` immediately, followed by `workerd/io/io-context.c++:435: info: uncaught exception; exception = workerd/jsg/...value.h:1480: failed: jsg.Error: internal error`. The DNS error is fast, but the subsequent jsg.Error breaks the request pathway in a way `insertReceiptAudit`'s `try/catch` does not catch. **CI is unaffected because Linux workerd (`kj/async-io-unix.c++`) handles the same NXDOMAIN cleanly.** The bug is in workerd's Windows-specific async-io error propagation.

**Why this matters for `main`.** The production worker is unaffected — production hits a real, reachable Supabase. The local Windows pre-commit gate is broken until either workerd's Windows bug is fixed upstream, or local tests are run in a Linux environment — see GAP-019.

**Fixes — separate PRs, do NOT bundle with calibration commits.**

1. **Code hardening (production-correct):** add `AbortSignal.timeout(2000)` to every Supabase fetch the worker makes (`insertReceiptAudit`, `updateKeyUsage`, `recordPaddleRevenueEvent` if relevant, `checkApiKey` step-5). The Supabase JS client uses `globalThis.fetch`; either pass `global: { fetch: timeoutFetch }` to `createClient`, or replace `await supabase.from(...).insert(...)` with a hand-rolled `fetch` to the REST endpoint with `signal: AbortSignal.timeout(...)`. Match the discipline a43bb6b set for Base RPC.

2. **Test-stability fix:** mock the Supabase client globally in `test/index.spec.ts` setup so no real HTTPS goes out. Closes the long-standing flake-class CLAUDE.md → Documented bypass class (2026-05-13) named ("vitest-pool-workers making real DNS calls instead of mocking Supabase").

3. **Local dev env fix:** GAP-019 — run the gate in WSL/Linux to match CI.

**Decision logged 2026-06-02:** the prose-only calibration commit (correcting "reference implementation" → "proposed reference implementation" across worker string constants and `docs/investor-one-pager.md`) was deferred from this session rather than bypassed. CI is the trusted gate; calibration ships through a green Linux/CI gate, not a Windows-broken local gate. Calibration preserved in working tree on `main`, `stash@{1}: v5-calibration-for-main`, and `C:/Users/User/AppData/Local/Temp/v5-calibration-backup.patch` (170 lines).

---

## GAP-019 — Set up WSL/Linux dev env so local test gate matches CI environment
**Priority**: MEDIUM — unblocks local pre-commit gate; foundation for shipping commits past GAP-017
**Status**: OPEN — identified 2026-06-02

**Why.** The local Windows pre-commit gate is broken by GAP-017 (workerd Windows async-io bug raises `jsg.Error: internal error` after DNS NXDOMAIN that Linux workerd handles cleanly). CI on Linux (`actions/setup-node@v5` with `node-version-file: '.nvmrc'` → Node 22 → npm ci from lockfile) genuinely passes 1064/1064 in ~20s. Future commits should land through a Linux test runtime that mirrors CI exactly, not through a broken Windows gate that pressures bypasses.

**Setup target.** WSL2 (Ubuntu) on this Windows machine, configured with:
1. fnm (or any Node version manager) reading `.nvmrc` → Node 22.x
2. Git configured with the same SSH signing key (`~/.ssh/id_ed25519_signing`) for commit signing
3. `git config core.hooksPath .githooks` (matches the repo's existing pre-commit gate convention)
4. Repo cloned at `~/headless-oracle-v5` with `.dev.vars` populated from the Windows version (sensitive — copy by hand, not via cross-FS mount)

**Acceptance test.** Inside WSL on `main` HEAD `59c975b` with no changes:

```
npx tsc --noEmit && npx vitest run && npx wrangler deploy --dry-run
```

All three exit 0, vitest summary reports 1064 tests passing.

**Carry-over from 2026-06-02 session.** The prose-only calibration commit deferred from this session is preserved in three durable forms: working tree on `main` (modified-unstaged on `src/index.ts` + `docs/investor-one-pager.md`), `stash@{1}: v5-calibration-for-main`, and a 170-line patch at `C:/Users/User/AppData/Local/Temp/v5-calibration-backup.patch`. Next session, with WSL gate green, the calibration ships through a clean local gate, then through CI on push.

---

## Closed Gaps (reference)

| Gap | Resolution | Date |
|---|---|---|
| MCP not metered (REST) | REST auth gate applies plan limits to /v5/status, /v5/batch | Mar 20 |
| KV billing desync | subscription.updated/past_due now sync KV immediately | Mar 20 |
| x402scan 401 on keyless /v5/status | Auth gate restructured: no-key → 402 with x402scan body | Mar 20 |
| x402scan "Missing input schema" | input field added to buildX402ScanPayload() | Mar 20 |
| x402scan "No valid x402 response" on free endpoints | /.well-known/x402.json discovery document | Mar 20 |
| /mcp OAuth discoverability dead-end | OAuth AS implemented; /.well-known/* endpoints live | Mar 21 |
| Unauthenticated MCP blocks OAuth clients | Soft auth: invalid token falls through as anonymous | Mar 21 |
| GAP-001: MCP metering | handleMcp applies getPlanDailyLimit(); -32000 on limit hit | Mar 21 |
| GAP-002: x402.json empty payTo | Returns resources:[] when ORACLE_PAYMENT_ADDRESS unset | Mar 21 |
| GAP-003: No OAuth introspect | POST /oauth/introspect (RFC 7662) live | Mar 21 |
| GAP-004: webhook race condition | unique_violation 23505 catch replaces TOCTOU select-then-insert | Mar 21 |
| GAP-005: www HTTP redirect | Confirmed 301 externally; no code change needed | Mar 21 |
| GAP-007: Soft-auth no expiry check | expires_at guard added to handleMcp Bearer validation | Mar 22 |
| GAP-008: verify_receipt not in MCP | verify_receipt tool added; Ed25519 verification in-worker | Mar 22 |
| GAP-009: server-card.json stale | mcp_endpoint, version, tools, authentication all corrected | Mar 22 |
| GAP-010: No webhook push | POST/DELETE /v5/webhooks/*, cron state-change fan-out delivery | Mar 22 |
| GAP-011: No receipt audit trail | insertReceiptAudit() + GET /v5/receipts (auth required) | Mar 22 |
| GAP-012: safe_to_execute ignores REALTIME overrides | Override re-check after buildSignedReceipt; effectiveStatuses used for summary | Mar 22 |
| GAP-013: batch calls not audited | insertReceiptAudit() called for each batch receipt via ctx.waitUntil | Mar 22 |
