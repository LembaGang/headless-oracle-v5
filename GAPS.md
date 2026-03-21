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
