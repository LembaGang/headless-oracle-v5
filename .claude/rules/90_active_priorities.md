# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Production-ready. Pre-launch marketing phase. Critical agent-adoption gaps being closed.
**Test suite**: 76/76 tests passing
**Last significant work**: Feb 22 2026 — HIGH gaps 5 + 6 resolved:
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

## Immediate Next Engineering Tasks (when user returns)
1. **Add rate limiting in Cloudflare Dashboard** — must be done before HN launch (March 10)
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
- [ ] Phantom Hour article published (human task — Gemini draft ready)
- [ ] Twitter/X thread posted (human task)
- [ ] 15 targeted DMs sent (human task — begins Feb 28)
- [ ] Rate limiting configured in Cloudflare Dashboard (human task — before March 10)

## Codebase Health
- **Worker**: headless-oracle-v5 | main branch | deployed to Cloudflare Workers
- **Frontend**: headless-oracle-web | main branch | deployed to Cloudflare Pages via `npm run deploy`
- **DST Demo**: dst-exploit-demo | master branch | published on GitHub
- **Tests**: 72/72 passing. `.dev.vars` populated with test-only keypair.
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
4. **`terms_hash` is a label, not a hash**
   Currently hardcoded to `'v5.0-beta'` — it's a version string, not a cryptographic
   commitment to a terms document. An agent can't verify what it's agreeing to.
   Fix: hash the actual terms document and serve the real hash, or rename to `schema_version`.

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
8. **No batch query**
   Multi-exchange consumers (portfolio managers, risk engines) must make 7 sequential
   requests. Fix: `GET /v5/status?mic=XNYS,XNAS,XLON` returning array of signed receipts.

9. **No MCP server**
   MCP is becoming the standard agent tool protocol. Without it, Oracle is invisible
   to the Claude, Cursor, and growing MCP-compatible ecosystem.
   Fix: publish an MCP server that wraps the Oracle API. Near-zero logic, high discoverability.

10. **No consumer verification SDK**
    To verify a receipt today: fetch /v5/keys, match key_id, reconstruct canonical payload,
    verify Ed25519 sig. Non-trivial. Blocks organic adoption.
    Fix: publish `@headlessoracle/verify` on npm. 3-line verification. Gets Oracle into
    training data with a clear integration pattern.

11. **No health endpoint**
    Agents with automated circuit breakers can't distinguish "Oracle is down" from "market
    is genuinely UNKNOWN." Fix: `GET /v5/health` returning a signed liveness receipt.

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
