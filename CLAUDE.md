# Headless Oracle V5

Headless Oracle is a Cloudflare Worker that returns Ed25519-signed market-state
attestations for 28 global exchanges. It answers one question: **"Is this
exchange open right now?"** Every response is cryptographically signed.
UNKNOWN = CLOSED (fail-closed). Revenue: x402 micropayments ($0.001 USDC on
Base), API keys (free 500/day, paid tiers via Paddle), free trial (3 signed
receipts/day/IP).

## Operational Defaults (Solo Founder Repo)

Auto-approved, no confirmation needed:
- File edits, test runs, npm installs
- New endpoint additions
- Documentation updates
- Signed local commits that pass the pre-commit gate

The founder's alone; an agent never does these, even when tests pass
(Orchestration Directive v2.0, 2026-07-15, in `~/.claude/CLAUDE.md`):
- Deploys: `npm run deploy`, `wrangler deploy`, or any other write to Cloudflare
- `git push`, of any kind
- npm or PyPI publishes, payments, public posts

Still requires explicit confirmation in the message:
- `git push --force`
- `rm -rf` operations
- Secret rotation or credential changes
- Anything that permanently deletes existing data

## Architecture in 30 Seconds

- **Single TypeScript file**: `src/index.ts` (~12,400 lines)
- **Runtime**: Cloudflare Workers (edge, no origin server) — API only, zero HTML
- **HTML**: Served by Cloudflare Pages via `headless-oracle-web` repo
- **Routing**: Worker catch-all on `headlessoracle.com/*`; API paths handled directly, HTML paths forwarded to Pages via `fetch(request)`
<!-- FIXME (flagged 2026-05-20, see AGENT_READINESS.md §8): the "catch-all" claim above is INACCURATE. wrangler.toml routes are path-specific; only www.*/api.* carry /*. New apex top-level paths do NOT auto-reach the worker — they fall through to the Pages SPA. Correct this line (and 02_architecture_map.md) in a dedicated follow-up. -->
- **KV namespaces**: `ORACLE_TELEMETRY` (metrics/usage), `ORACLE_API_KEYS` (auth + billing state), `ORACLE_OVERRIDES` (manual halt overrides)
- **Signing**: Ed25519 via `@noble/ed25519` with CryptoKey cached in module scope
- **MCP server**: POST `/mcp` (protocol `2024-11-05`, streamable HTTP, 5 tools)
- **Payments**: x402 via Coinbase CDP facilitator on Base mainnet
- **Billing**: Paddle (subscriptions + credit packs), keys stored in Supabase + KV cache
- **Conversion**: `/v5/keys/instant` instant key provisioning, enhanced 402/429 with `agent_upgrade_paths`, funnel telemetry
- **Email**: Resend for key delivery
- **Durable Objects**: `StreamCoordinator` (SSE), `WebhookDispatcher` (state-change fan-out)
- **OpenAPI**: 78 paths in `/openapi.json` (11 semantic tags, 2 server URLs, MIT license)
- **SDKs**: `packages/sdk-typescript/` (@headlessoracle/sdk), `packages/sdk-python/` (headless-oracle-sdk) — not yet published
- **Published packages**: `headless-oracle-mcp` (npm), `headless-oracle` (PyPI), framework SDKs (LangChain, CrewAI, Strands)

## Critical Invariants (NEVER violate these)

1. UNKNOWN status MUST be treated as CLOSED — this is the fail-closed contract
2. Receipt TTL is 60 seconds — NEVER extend this
3. Ed25519 signatures must be verified before acting on receipt contents
4. Tests must pass before AND after every change
5. Live output must match external spec, not just pass tests
6. PRs to external repos must compile against the target repo's build system
7. No hardcoded UTC offsets — DST handled exclusively via IANA timezone names

## 4-Tier Fail-Closed Architecture

- **Tier 0**: KV override check — if `ORACLE_OVERRIDES[mic]` exists and not expired → return HALTED/OVERRIDE
- **Tier 1**: Schedule-based status — compute OPEN/CLOSED from market calendar
- **Tier 2**: If Tier 1 throws — sign and return UNKNOWN/SYSTEM receipt (fail-closed)
- **Tier 3**: If signing itself fails — return unsigned CRITICAL_FAILURE 500 with UNKNOWN status
- Consumers MUST treat UNKNOWN as CLOSED and halt all execution

## KV Namespaces

| Binding | Purpose | Key Pattern |
|---|---|---|
| `ORACLE_OVERRIDES` | Manual circuit-breaker halts — **MIC codes only** | `XNYS`, `XNAS`, etc. |
| `ORACLE_API_KEYS` | API key state (sha256 → plan/status/balance) | `{sha256(key)}` |
| `ORACLE_TELEMETRY` | Usage metrics, MCP analytics, telemetry | See `04_telemetry_guide.md` |

**ORACLE_OVERRIDES must never contain telemetry data.** Operators scan it for active circuit breakers.

## Current State (update this section after every significant session)
<!-- Last updated: 2026-10-05 — H4a agent front door; TEST_COUNT 1667 -->
<!-- Before: 2026-10-04T13Z — H2/H2b key on screen deployed (63974cb5) and pushed (afc1c80); TEST_COUNT 1589 -->
<!-- Previous: 2026-10-04 — Witness W1-W3, H1a, H1b deployed (32f367e6) and pushed (3d4b723); TEST_COUNT 1535 -->

Every version, count and transaction below cites the run that produced it. Nothing
here is carried forward from an earlier stamp unverified.

- **2026-10-07 (latest, NOT deployed): mint claim + MCP keys.** Suite **1693 → 1714**.
  `/v5/x402/mint` claims each tx hash once in D1 `HALT_ARCHIVE` (`x402_mint_claims` /
  `x402_mint_outcomes`, auto-created); store down → 503, key-store failure after claim →
  500 `MINT_KEY_NOT_STORED` + revenue-pulse alert. Payer binding still open. `/mcp`
  reads an API key as Bearer or `X-Oracle-Key`; an HO-issued credential that is not
  accepted → JSON-RPC error; foreign Bearer values stay anonymous
  (`HO_ISSUED_CREDENTIAL_SHAPES`).
- **2026-10-07 (later): credits and x402 audit fixes.** Live **`a32322b5-41f5-43a4-93f4-d6aa4e8ef4e1`**
  (20:04Z, from `f258e67`; B-115 exit 1, routes unchanged; smoke 11/11). Suite 1671 → 1693.
  Credits grant sized from the on-chain amount; non-free plans 409 `CREDITS_NOT_APPLICABLE`;
  balance/usage reads spend no credit; MCP pack tokens debited per call. **Signing
  exception (founder-approved)**: the eight commits were re-signed with `--no-verify`
  (signatures only, trees identical, `git diff` empty); the gate had passed on each tree
  and CI Tests/CI passed on `f258e67`. **Since then**: the unit suite cannot reach the
  network (`vitest.config.mts` `outboundService` → 503; it had been sending real Resend
  calls), and `scripts/land.ps1` re-signs, gates once, pushes, deploys.
- **2026-10-07: served text stops promising email and a fifth MCP tool.** Live
  **`2e68085f-a934-4869-9731-efc85b20f59b`** (08:34Z, from `c19824b`; B-115 exit 1,
  routes unchanged). Suite **1667 → 1671**. `/v5/pricing` sandbox ("returned in the
  response") and free ("email currently unreliable; `/v5/keys/instant`") descriptions,
  `/auth.md` §2, `buildUpgradePaths` `email_key`, and `/v5/errors/ACCOUNT_NOT_FOUND`
  (now `/v5/claim`, else write to mike@). The H3a pricing pin proves only those two
  descriptions moved. `verify_receipt` row below is closed.
- **2026-10-05: H4a, the agent front door.** Live **`7b3bbfe5-93a9-4466-a0a6-e2cf0d466dd0`** (10:21:06Z, from `f2078ca`; B-115 exit 1 after the upload, routes unchanged). Suite
  **1635 → 1667**. From the Lead's 7-day traffic analysis.
  - **`/.well-known/agent-card.json`** is still 404 and still no card; the body is
    now `A2A_NOT_IMPLEMENTED` with the MCP, llms.txt and openapi URLs.
    **`/.well-known/agent.json`** has no top-level `url` (A2A clients POSTed JSON-RPC
    to it: 5,115 x 405 on `POST /`); `homepage` and an `interfaces` array (MCP
    streamable-http at api.headlessoracle.com/mcp, OpenAPI) replace it. Its
    `mcp.tools` now derives from `MCP_TOOLS` (it said 3 while `tools/list` served 4).
  - **Aliases**: `/.well-known/x402` = `/.well-known/x402.json`, which now lists
    `/v5/status/x402`; `/health` = `/v5/health` and `/favicon.ico` = 204 on api. only.
  - **OAuth**: `/.well-known/oauth-protected-resource/mcp` (RFC 9728, `resource` is
    `https://<host>/mcp`); `/.well-known/oauth-authorization-server/oauth` and
    `/.well-known/openid-configuration/oauth` serve the RFC 8414 document (issuer is
    the `/oauth` form). `/mcp` needs no auth and never answers 401.
  - **`MCP_USE`** log line per JSON-RPC message (`mcpUseLogLines`): method, tool name
    on `tools/call`, client name/version on `initialize`, offered protocolVersion,
    host, status. Never arguments, ids, tokens or IPs.
  - **`POST /v5/checkout` must name a plan**: absent is **400 `PLAN_REQUIRED`** (it
    used to mean Builder), and every checkout 400 carries `plans` with prices. The
    legacy `?type=` query still names a plan. This supersedes the B-144/B-169
    "absent means Builder" rule below.
  - **Witness**: every 4xx carries `docs` = the witness spec; the anonymous-cap 503
    and a key's 429 `quota_exceeded` carry an `upgrade` object (both Evidence plans,
    prices, daily limits, the exact checkout call). Spec text says so (still
    `witness-spec/0.5`: additive members).
  - **Leads**: `/skill.md`, `ai-plugin.json` and openapi `info.description` open with
    `CHIRINDO_LEAD` (the `/llms.txt` summary plus the spec's limits);
    `get_payment_options` returns `chirindo_witness`; `/v5/pricing` has an
    `evidence_pilot` tier with the `/pricing` sentence verbatim; every openapi
    operation has a derived `operationId` (`openapiOperationId`).
  - **Test guard**: the suite fails on a non-ASCII header in any 2xx or 402. None
    found; the em-dash warnings were Miniflare's `MF-Vitest-Source` header.
  - **Open (B-115, route changes)**: the empty-UA monitor's `HEAD /mcp` 404s are
    `https://headlessoracle.com/mcp?<query>` (zone analytics, 157 in 3h, HTML 404
    from Pages): the route `headlessoracle.com/mcp` is exact-path, so any query
    string misses the worker. It needs `headlessoracle.com/mcp*` in the zone routes;
    so do apex `/health` and `POST /`. The 2 Oct flip from 200 to 404 was the web
    repo's E4 real 404 page, not a worker change.
- **2026-10-04 (evening): H3a–H3d.** Live **`259a8bdb-d718-408a-88b9-7ccc3b3562bb`**
  (20:21:16Z, from `acaf3aa`, read from `npx wrangler deployments list`; B-115 exit 1
  after the upload, routes unchanged), replacing `306e1bfe…` (17:22:53Z: H3a `36788a2`,
  H3b `a4f3abd`, H3c `660a241`). Suite **1589 → 1634**; `tests_passing` 1634 live.
  - H3a: llms.txt, llms-full.txt, AGENTS.md, SKILL.md, agent.json, both MCP cards and
    initialize lead with Chirindo/Witness; `/v5/pricing` gains `witness_free`,
    `evidence_starter`, `evidence`; the three openapi witness operations carry a
    `servers` override to api.headlessoracle.com because the apex `/v1/witness/*` route
    was never created (B-115); the trial/free-limit 402 recommends x402 first; robots.txt
    has `Content-Signal` in every group. H3b corrected the Chirindo summary.
  - H3c/H3d: SKILL.md, llms-full.txt, openapi.json and the buy text promise no email.
    Paid keys: `/v5/claim`, else write to mike@ with the Paddle txn ID.
    `/v5/keys/request` only emails and says "currently unreliable"; `/v5/keys/instant`,
    `/v5/sandbox` and `/v5/x402/mint` return the key in the response. Still saying
    "via email", outside H3d: `/auth.md`, `/v5/pricing` sandbox/free descriptions,
    `buildUpgradePaths`.
  - **Open**: buyer email failing (Resend team mismatch, below); apex witness route; the
    402 `Link rel="payment"` still points at `/v5/keys/instant` (founder decision); npm
    chirindo 0.4.0 lacks the witness commands.
- **2026-10-04 (later): the key on screen after payment.** Deployed as `63974cb5…`
  (13:13:02Z, from `afc1c80`): H2 `a0f3c75`, H2b `afc1c80`. Suite **1535 → 1589**.
  - Buyers of builder, pro, protocol, credits, custody_90d and custody_1y see their key
    on the pricing page after payment (web W2 `67865d3` + W2b `21036c9`, deployed after
    this worker). `/v5/checkout` returns `claim_token`; Paddle carries
    `custom_data.ho_claim` = sha256(token); the mint seals the key (AES-GCM, HKDF of
    `PADDLE_WEBHOOK_SECRET`) into `claim_ready:<h>` (24h); `POST /v5/claim` answers
    pending, ready, or 410 after 24h. ORACLE_API_KEYS: `claim:` (7d), `claim_ready:`,
    `paddle_txn:` (credits dedupe, 30d). ORACLE_TELEMETRY: `claim_filled:`/`claim_seen:` (7d).
  - **Email to buyers is failing**: the worker's `RESEND_API_KEY` belongs to the Resend
    team where headlessoracle.com is not verified. Until that key is replaced, the claim
    page is the delivery, and the alarm is a GitHub issue `Key not collected: <txn_id>
    (<plan>)` opened by the health check from `/v5/revenue-pulse` `paddle.unclaimed_keys`
    (filled over 2h ago, never fetched).
  - **Do not rotate `PADDLE_WEBHOOK_SECRET`** while any `claim_ready` is under 24h old:
    the seal is derived from it and those keys become unreadable.
  - Log events `CLAIM_SETUP_FAILED`, `CLAIM_FILL_FAILED`, `CLAIM_FILLED_RECORD_FAILED`,
    `CLAIM_UNSEAL_FAILED`, `CLAIM_SEEN_WRITE_FAILED`, `CLAIM_READ_FAILED`,
    `CLAIM_RATE_LIMITER_FAILED` (the `/v5/claim` limit on `WITNESS_GET_RL` fails open),
    `CREDITS_DEDUPE_READ_FAILED`, `CREDITS_DEDUPE_WRITE_FAILED`.
  - **Open**: Paddle echoing `custom_data` into `transaction.completed` is unverified
    against a real payload; no script recovers an uncollected key for the founder;
    `monitors.md`, `04_telemetry_guide.md` not updated for the claim pipeline.
- **2026-10-04: Witness and paid-plan delivery live**, deployed as `32f367e6…`
  (08:02:06Z, from `3d4b723`). W1 `c43e17a`, W2 `96bbaee`, W3 `afa5338` (first deployed
  3 Oct as `28f81845…`), H1a `ede783b`, H1b `826fa59` + `3d4b723`. Suite **1432 → 1535**.
  - **Witness** on `api.headlessoracle.com/v1/witness/*`, spec `witness-spec/0.5`. The
    apex route `headlessoracle.com/v1/witness/*` is NOT added (B-115). Storage is D1
    `chirindo_witness`; `ensureWitnessSchema` applies `migrations-witness/0002` on first
    use. Rate limits `WITNESS_POST_RL`/`WITNESS_GET_RL` 60/min, `WITNESS_ACCT_RL` 600/min,
    per Cloudflare location, and **fail open** (the only fail-open path in the witness;
    the spec says so; daily cap and store stay fail-closed). The limits are constants
    in source mirrored in `wrangler.toml`: change both. `status_code:`/referrer KV
    counters still write on every witness response.
  - **Evidence plans.** `custody_90d` = `evidence_starter` (1,000 new checkpoints/UTC
    day), `custody_1y` = `evidence` (3,000/day). A purchase delivers a Witness key
    (`Authorization: Bearer ho_live_…` on POST checkpoints); `checkApiKey` maps them to
    `free` for `/v5/*`. Every paid plan delivers its key; `subscription.activated` never
    mints. Provisioning is KV-first (`paddle_sub:` in ORACLE_API_KEYS, no TTL) with
    Supabase best effort. Fail-closed calls ratified: status event with a KV miss AND a
    failed Supabase lookup → 503 (D2); lost `last_event_at` write → 503. New log events
    `PADDLE_SUPABASE_WRITE_FAILED`, `PADDLE_KV_WRITE_FAILED`, `PADDLE_DEDUPE_UNAVAILABLE`,
    `PADDLE_SUB_UNKNOWN`, `PADDLE_ACTIVATED_NO_MINT`, `PADDLE_EVENT_OUT_OF_ORDER`,
    `SUPABASE_KEEPALIVE`; revenue tier `evidence:<plan>`.
  - **Supabase** `sahqfuyneoeqczupmysu` was paused 3 Oct and restored; `supabaseKeepalive`
    runs in the 09:00 cron. Production `api_keys` has a UNIQUE index on
    `stripe_subscription_id` (applied 4 Oct, in no repo schema file).
  - **Account on Workers FREE**: D1 500 MB, 100k rows written/day account-wide.
  - **Open**: Paddle `origin` values unverified against a real payload; credits mint
    has no founder line (D3; dedupe added by H2b); `/llms.txt`, `/AGENTS.md`, web `/pricing` and
    the Paddle product names not checked against Witness v0.5; no production POST to
    the witness has succeeded yet.
- **2026-10-02 (A2A claims removed) and 2026-10-01 (agent readiness)**: moved verbatim to
  `docs/history/claude-md-moved-2026-10-05.md` on 2026-10-05 (memory-size gate).
- **Tests**: 1714 main suite (authoritative — `wrangler.toml` `TEST_COUNT`, kept in
  step by `scripts/vitest-count.sh`) + 11 smoke + 24 SDK + 26 LangGraph + 17
  ai-hedge-fund. Earlier steps (1264 → 1369, 2026-09-07 to 09-24) are in the commit
  subjects; each count was read from `npm run test:sync-count` and the hook.
- **Worker**: see the 2026-10-07 entry above for the live version. Previous live
  versions: `2e68085f…` (10-07 08:34Z), `7b3bbfe5…` (10-05, H4a), `dfdeb3b7…` (10-05 09:05Z, H3f), `259a8bdb…` (10-04 20:21Z), `306e1bfe…` (10-04 17:22Z), `63974cb5…` (10-04 13:13Z), `32f367e6…` (2026-10-04 08:02Z), `28f81845…` (2026-10-03, W1-W3), `04c3ff8b…`
  (2026-10-02), `f20ba28c…` (2026-09-24, B-224d/f). The deploys of 09-24, 10-03 and all four of 10-04 each exited 1
  on the B-115 route-listing step after a good upload; benign only while routes are unchanged.
- **Local gate**: four steps, all enforced by `.githooks/pre-commit` — `npx tsc
  --noEmit`, `npm test`, `npx wrangler deploy --dry-run`, and `bash
  scripts/start-smoke.sh`. Every commit of 2026-09-07 passed all four with no
  `--no-verify`.

### The receipt `coverage` block — signed payload, T3 + T3b (2026-09-07)

**SPEC-CONFORMANCE FLAG (PR #9 in review).** Every receipt from
`buildSignedReceipt` — `/v5/demo`, `/v5/status`, `/v5/status/x402`, `/v5/batch`,
`/v1/status/{MIC}`, MCP `get_market_status` — carries a `coverage` field **inside**
the Ed25519 signature. Unchanged by both passes: the signature algorithm, the
canonicalization rule (alphabetical sort of top-level keys, `JSON.stringify` with
no whitespace), the 60s TTL, the fail-closed tiers, and every pre-existing field's
name, type and meaning.

`coverage` is a JSON-encoded **string** — the convention `cross_venue` and
`reasons` already use. It is a string and not a nested object because
`signPayload` enforces string-only values and a nested object would make its
internal key order load-bearing with no published rule saying so. Members, in this
fixed order:

```
determination_tier        0 = manual override (KV), 1 = schedule, 2 = fail-closed fallback
consulted[] / not_consulted[]
realtime_halt_feed_scope  ["XNAS","XNYS"] — the only MICs with intraday halt detection
unknown_reason            null unless UNKNOWN
feed_state                live | stale | failed | absent | not_covered   (T3b)
feed_last_run             the monitor's ran_at, or null                  (T3b)
```

**What T3b corrected.** T3 listed `realtime_halt_feed_via_override` under
`consulted` whenever the override tier was *read*. But an empty override tier means
one of three things a receipt could not tell apart: no halt was observed; the
monitor was not running; the monitor ran and its source failed. Claiming the feed
path was consulted in the last two is a claim with no evidence behind it — the exact
class of false coverage claim the block exists to prevent.

**The rule now.** `runHaltMonitor` writes `halt_monitor_heartbeat` to
`ORACLE_TELEMETRY` on every run (600s TTL; `{ran_at, ok, source, items, scope}`;
written after the fetch and parse whether or not they succeeded, so `ok: false` is
recorded rather than swallowed; a dead cron makes the key vanish, which is the
honest state). A receipt lists the feed under `consulted` only when it can cite a
heartbeat that is present, `ok`, and no older than 180s. Otherwise the feed is
`not_consulted` and the receipt says why. Read once per isolate per 15s; freshness
is still computed against the request's own clock, so the memo cannot make a stale
heartbeat look live. A Tier 0 receipt driven by a **REALTIME** override lists the
feed as consulted — that override *is* the feed observation; an operator's manual
breaker is not, and does not earn the token. Tier 2 claims nothing but still states
`feed_state`.

`halt_detection` is unchanged and means something different: it says what is
**configured** for a MIC, while `coverage.feed_state` says what was **live at this
determination**. A receipt may honestly read `halt_detection: active` with
`feed_state: stale`. `/v5/keys → canonical_payload_spec.coverage_note` states the
distinction.

**Compatibility.** A verifier that builds the canonical payload from `/v5/keys →
canonical_payload_spec` at runtime is unaffected. One that hardcodes a field list
gets `INVALID_SIGNATURE`. Both halves were run, not asserted, against a
`wrangler dev` receipt carrying both new members, spec- and key-driven from the local
`/v5/keys` with no override: `@headlessoracle/verify@1.0.2` and
`headless-oracle==0.1.1` both returned valid on XNYS (`feed_state: live`) and XLON
(`not_covered`), and `INVALID_SIGNATURE` on a rewritten `feed_state`, on the T3
tamper claiming the feed was consulted on XLON, and on a pre-T3 hardcoded field list.
Production receipts carrying the T3 block were verified live on 2026-09-07 by both
SDKs. The npm `latest` is now `@headlessoracle/verify@1.1.0` (2026-06-14); its
`dist/index.js` lines 1–75, which hold `verifyReceipt`, are byte-identical to
1.0.2's (1.1.0 only appends `safeToExecute`), read from both registry tarballs on
2026-10-02. The runs above were made with 1.0.2 and were not repeated. **Not closed**: `receipt-verify`'s `ho.receipt` adapter still does not exist
(0.1.2 ships four formats, none of them HO's).

### GAP-020 — x402 v2 served correctly beside v1: CLOSED 2026-09-07

Closed exactly as Monday's report left it. Served by `6e2f0da`, deployed as
`261c48a` (live version `a83fa8bf…`), settled by tx
`0x46db8fc8cfd79017375d76c5ad80256950f8437ff009ecbe90b6cd5ce97e9263` at block
50,998,385 (2026-09-07T13:01:57Z) — a stock `@x402/fetch` 2.20.0 client, no
`registerV1`, spend guard 1000 atomic units, free trial exhausted first.

**The rule that stands.** Every representation of a price — the v2
`Payment-Required` header, the v1 body, the CDP `/verify` and `/settle`
requirements, `/v5/pricing`, `/llms.txt`, the MCP server card, the A2A agent card
and the key-delivery email — is serialised from **one canonical requirements
object** (`X402_RESOURCE_SPECS` + `x402Canonical()`), with a diff test that fails if
any surface carries a literal. **Do not write a price, asset, `payTo`, network or
resource URL as a literal anywhere else.** Both versions are served; which one a
client uses is read off its own payload, never assumed. The old rule — "do not bump
to v2 until Coinbase publishes a v2-capable client" — is withdrawn: it was wrong in
both directions (a v2 client had been on npm since 2025-12-11, and the June revert
did not leave us serving a valid v1 402 either).

**The free trial gates any client test.** `/v5/status` serves three signed receipts
per caller per day (reset 00:00Z) before it will ever return a 402. A compatibility
test that does not exhaust the trial first is measuring a 200.

### The plan prices stated once (2026-09-07, `f47df73`)

`PLAN_PRICES` (`builder: 99`, `pro: 299`, `protocol: 500`) is the single source, with
display projections beside it (`BUILDER_MONTHLY`, `PRO_MONTHLY_SHORT`,
`BUILDER_PRICE_USDC`, …). 35 sites converted. The load-bearing one is not a display
string: `X402_MINT_BUILDER_UNITS` was `BigInt(99_000_000)`, written independently of
every "$99" on the site, and now derives as `BigInt(PLAN_PRICES.builder) *
USDC_DECIMALS_MULTIPLIER`. An agent paying the advertised price into an amount we no
longer honour is not a formatting bug.

**Do not write a plan price as a literal.** The check is
`grep -nE '\b(99|299)\b.*(USDC|/month|\$)' src/index.ts`, which must return only the
constant, its comments, and one SVG `cy="299"` geometry coordinate in the status
card. Note that this grep is **not sufficient on its own** — it requires the digits
to precede the currency marker, so it cannot see the `$99/mo` form, a bare
`usdc: 99`, `required_usdc: '99'`, or the `X-Oracle-Plans` header ladder. Eleven
literals were found beyond it by widening the pattern to any `99`/`299` token. Widen
the pattern when checking, not just this grep.

### B-144 — the billing path fails closed (2026-09-09, `f5d3ac9`)

Three sites decided what to sell, or what to grant, by falling through to a
default. All three are now explicit.

- **`POST /v5/checkout`** compared `plan` against `pro`, `protocol` and `credits`
  and let everything else land on `PADDLE_PRICE_ID_BUILDER`. `{"plan":
  "conformance_entry"}` returned a 200 carrying a $99/month Builder checkout; so
  did a typo. Now `CHECKOUT_PLAN_PRICE_ENV`, an explicit map: an unrecognised plan
  is **400 `UNKNOWN_PLAN`** carrying `valid_plans`, and **no call to Paddle at
  all**. An **absent** plan meant Builder until H4a (2026-10-05); it is now 400
  `PLAN_REQUIRED`, also with no call to Paddle.
- **`transaction.completed`** and **`subscription.activated`** both opened with
  `let plan = 'pro'` under a comment calling it "fail-safe to 'pro' if
  unrecognised". It was fail-**open**: an unrecognised `price_id` minted a
  `ho_live_` key on the second-highest plan. `resolvePaddlePlan` now returns
  `null` and both branches provision **nothing** — no key, no Supabase row, no
  email, not even the customer lookup — log `PADDLE_UNMAPPED_PRICE_ID` and return
  `{received:true}` so Paddle stops retrying a delivery no retry can fix. The
  transaction stays in the Paddle dashboard; a human maps it.

The unmapped case routes into the alerting path that **already existed**:
`recordPaddleRevenueEvent` → `paddle_revenue_event:{ISO}` → `/v5/revenue-pulse`
→ `.github/workflows/health-check.yml` opens a GitHub issue per `txn_id`.
Nothing new was invented for it. `tier` and `plan` are `unmapped`, `amount` is
`unknown` — not knowing what the price charges is why we are in that branch.

**Four sibling tests could not fail** and were corrected in the same commit,
because this change moved them from silently-passing to actively misleading.
Two mechanisms, both worth remembering: (a) a Supabase SELECT mock returning
**HTTP 200** with `{data:null,error:{...}}` — supabase-js on a 2xx parses the
whole body **as the row**, so `existing` came back truthy and the handler
returned at the idempotency guard; use **406**. (b) a 23505 mock wrapping the
error as `{data,error}` — supabase-js on a non-2xx assigns the parsed body
**itself** to `error`, so `dbError.code` read `undefined`; the body must **be**
the error object, as PostgREST sends it. Both "INSERT race (23505)" tests now
assert `insertAttempted`.

**Not closed, named deliberately**: no checkout, transaction or webhook has been
exercised end to end against the live Paddle account from this tree.

### `REFEREE_PRICES` — the six referee prices stated once (2026-09-09, `0c00040`)

Six prices created in the live Paddle account on 2026-09-09 existed **nowhere
else**. `REFEREE_PRICES` sits beside `PLAN_PRICES`, one line per price carrying
the key, the Paddle price id, the amount in **minor units**, the currency and
the billing cycle. `refereePriceAmount()` is the only projection to a decimal
string.

**Ruling (Lead, 2026-09-09): the price ids go in SOURCE, not in Cloudflare
secrets.** A price id is an identifier, not a credential; the existing four
`PADDLE_PRICE_ID_*` are secrets and that is exactly why nothing in this tree
could reconcile what the worker charges against what the record says it charges.
The four live plan ids are recorded as a comment beside `REFEREE_PRICES`. **They
are not migrated out of secrets** — that touches deploy configuration and is its
own row.

`resolvePaddlePlan` returns three outcomes, not two: `{kind:'api_plan'}`
provisions a key as before; `{kind:'referee'}` is recognised, recorded under its
own name, and mints **no API key** — evidence custody is not API access, and
before B-144 a `custody_90d` subscription minted a Pro key; `null` is unmapped.
**Superseded for the two custody prices by H1a (`ede783b`)**: they resolve to
`{kind:'evidence_plan'}` and deliver a Witness key (see 2026-10-04 above).

**Do not write a referee price id or amount as a literal anywhere else.** The
check is `git grep -cE 'pri_01m22w[a-z0-9]+' -- src test`. **As of 2026-09-10 it
returns `src/index.ts:6` and `test/index.spec.ts:16`, and the sixteen are
accounted for**: six in the B-145 reconciliation table, six in
`REFEREE_CHECKOUT_CASES` (the B-149 checkout table, written out independently on
purpose so the per-service tests have something to disagree with), and four
single uses inside webhook and intake tests. Six in source is still the number
that matters: it must be `REFEREE_PRICES` and nothing else. A seventh line in
`src/index.ts` is the failure this rule exists to catch.

Scope the grep to `src test`, or match on the full-id pattern as above: an
unscoped `git grep 'pri_01m22w'` also hits **this paragraph**, because the rule
quotes its own pattern. Note what the served-surface test does **not** cover: `dispute` is $500.00 and
`PLAN_PRICES.protocol` is $500/month, so amounts colliding with a plan price are
skipped there and only the price-id half covers them.

### The referee introductory tripwire — fires 2027-01-01 (2026-09-09, `2c89d71`)

`REFEREE_INTRODUCTORY_UNTIL = '2026-12-31'` mirrors the `introductory_until`
each of the six prices carries in its Paddle `custom_data`, which **nothing
read**. The test named `B-145 DATED TRIPWIRE — INTENDED TO GO RED ON 2027-01-01`
runs against real wall-clock time, not `vi.setSystemTime` — a tripwire that
fires against a mocked clock never fires at all.

**A red suite on 1 January 2027 is the intended behaviour, not a bug.** The
failure message names the constant, the date, all six prices, and the two ways
out: extend the date on a Lead ruling (in source **and** in Paddle, so the two
agree), or publish successor prices and drop the flag and the test together.
Silencing it by deleting the assertion and leaving the prices is the one
response that removes the thing that found the problem.

### B-169 — an unreadable body sells nothing (2026-09-10)

`POST /v5/checkout` read its body with `await request.json().catch(() => ({}))`,
which gave the same answer to three different requests: no body, a JSON object,
and bytes it could not parse. On 2026-09-10 a `{"plan":"nope"}` sent from
PowerShell 5.1 — which does not pass `\"` through to a native executable
reliably — arrived mangled, parsed to `{}`, took the **absent**-plan default and
created a live Builder transaction (`txn_01m25kztpkvt2hh64qdw509n97`) for a
request whose plan the worker never read. B-144 closed this family for a plan we
can read and do not sell; a body we cannot read at all was still open.

**The rule.** The body is read as text first. Empty (or whitespace) means absent,
which since H4a is 400 `PLAN_REQUIRED` (it defaulted to Builder before). Anything else must parse to a **JSON object**: a parse failure, or a value
that is not an object (`null` and arrays included — `typeof null === 'object'`),
is **400 `INVALID_BODY`** carrying `valid_plans`, with **no call to Paddle**. A
`plan` that is present but not a string is the same refusal: it used to reach
`safeIdent()`, whose `.replace()` is not a method on a number, so `{"plan":42}`
returned **500** — a fault of ours reported for a fault of the call. `INVALID_BODY`
and `UNKNOWN_PLAN` stay distinct on purpose: "I could not read what you sent"
and "I read it and do not sell that" are different recoveries for an agent.

**No site button takes this path.** Every button in `headless-oracle-web/pricing.html`
sends `JSON.stringify({plan})`. The Builder default survives for the legacy
`?type=` callers and for anyone posting an empty body, not for the site.

### B-168 — `overlay_url` never carries another venture's domain (2026-09-10)

The same production call returned
`overlay_url: "https://texasentitlement.com?_ptxn=txn_01m25kzt…"`. That is
Paddle's `data.checkout.url`, which Paddle builds from the **account's default
payment link** when the transaction does not name one — and this Paddle account
is shared with Austin Dev Watch, whose default link is that domain. Nothing on
headlessoracle.com follows the field (Paddle.js takes `transaction_id`, the
hosted `buy.paddle.com` URL is the fallback), but an agent that follows it is
sent to the wrong business.

Two halves, and the second does not depend on the first. `createPaddleCheckout`
now sends `checkout: { url: PADDLE_CHECKOUT_URL }` — one field added to the ONE
request shape all ten plans share; **do not invent a second shape**. And whatever
Paddle returns, `ownHostOverlayUrl()` serves it only when its host is exactly
`PADDLE_OVERLAY_HOST`, otherwise `null` plus a `PADDLE_OVERLAY_URL_FOREIGN_HOST`
warning. Withholding the link is safe: the transaction is still completable by
the other two paths.

**Paddle requires the checkout domain to be approved in the account's settings,
and that approval has not been verified from this tree.** So a failed create is
retried **once** without the field — keyed on the failure itself, never on
parsing Paddle's error text — and only then becomes a 502. A checkout that
worked must not start failing because we asked for a nicer overlay URL. Exactly
two attempts, asserted; the second failure is the answer.

### B-224 — served text claims no regulatory alignment (2026-09-24; `3b2a2c0`, `4347051`, `5f0ec3a`, `20404e4`, `78fa1cd`)

The MCP tool descriptions, the `pre_trade_check` prompt, the openapi `info`
block, the server card, `/llms.txt`, `/llms-full.txt` and §10 of the consensus
spec told agents the service was "SEC/CFTC … compliant", "aligned", or that a
regulator required the check. None of that is a claim this operator can make:
our own spec says only that the design takes its architectural direction from
CFTC Staff Letter 25-39 and the SEC Project Blueprint on Tokenized Collateral.

- **The rule.** Cite, never claim. `regulatory_references` (the documents plus
  their source URLs) stays everywhere; `regulatory_alignment` and
  `x-regulatory-alignment` are gone. Where a regulator is named, the text says
  the spec is this operator's and that no regulator has reviewed or endorsed the
  service. The multi-oracle guide's field is `standards_alignment` (ISO 10383 is
  a format standard, not a regulation).
- **Also removed**: the `uptime_sla` field (it contradicted the beta disclaimer
  in terms.html — now `uptime_slo` / `p95_latency_slo_ms` beside a public-beta
  caveat); the ESMA MiFID II and SOC 2 rows in `/llms-full.txt` (uncited, and
  SOC 2 is an attestation this operator does not hold); the `/llms.txt` link that
  described `/docs/compliance` by content the page does not have.
- **`sma_compliant: true` stays** — SMA is this operator's own protocol.
- **B-224d and B-224f** (`20404e4`, `78fa1cd`) removed the last two claim
  sentences: §3 of the consensus spec ("consistent with the architectural
  direction in the SEC …", found by the Lead's proximity sweep of production GET
  routes) and the `get_market_status` description (the same phrase, attributed
  and disclaimed, served only by `POST /mcp tools/list`, which the GET sweep could
  not see). Both now use the "took / takes its architectural direction from"
  idiom. Each was the third sentence of a line whose other sentences were fine:
  **judge sentences, not lines.**
- **The guard.** `served text surfaces make no regulatory-alignment claim`, rebuilt
  by B-224d. Two checks on each surface: twelve legacy strings (a known phrase fails
  by name), and a sentence-level rule — any sentence carrying a claim word
  (`CLAIM`) and a regulator word (`REGULATOR`) fails unless it matches a published
  disclaimer (`DISCLAIMER`). Sentences split at a sentence end followed by a
  capital, or at a newline, so `v1.0.1` does not cut a disclaimer off its claim
  (B-224f; the first splitter broke at every full stop). It covers **twenty GET
  surfaces** (each asserted 200) **plus `POST /mcp tools/list`**. A new surface
  still escapes it unless added to the list, the same limit as the placeholder
  guard; a new disclaimer wording must be added to `DISCLAIMER` or it fails.
- **Not in scope**: `headless-oracle-web` was not swept, and this repo's internal
  docs (e.g. `.claude/rules/01_business_context.md` "Regulatory Tailwinds",
  `docs/business/compliance.md`) were not changed.

### B-149 — the till opens: the six referee services are buyable (2026-09-10)

Six prices existed in the live Paddle account and in `REFEREE_PRICES` and
**nothing could reach them**. `POST /v5/checkout` answered every one of the six
names with 400 `UNKNOWN_PLAN`, and `/v5/pricing` did not mention them.

- **`POST /v5/checkout` sells ten things**, from two sources of price id: the
  four API plans from a Cloudflare secret, the six referee services from
  `REFEREE_PRICES` in source. `valid_plans` is now `builder, pro, protocol,
  credits, conformance_entry, regrade, dispute, dispute_note, custody_90d,
  custody_1y`. **There is ONE Paddle request shape** —
  `{items:[{price_id, quantity:1}]}` — for every plan: Paddle, not us, decides
  one-time versus subscription from the price's own billing cycle. Do not invent
  a second shape for the two custody subscriptions. `createPaddleCheckout()` is
  the only place that call is made.
- **A defect found and fixed.** B-145 put the referee branch in
  `transaction.completed` **after** `if (!txn['subscription_id']) return`, and
  four of the six referee prices are **one-time** — they carry no
  `subscription_id`. So `conformance_entry`, `regrade`, `dispute` and
  `dispute_note` never reached it: the webhook returned `received:true` at that
  guard and wrote nothing at all — no purchase row, no revenue row, no alert,
  no mail. A $2,500 conformance entry would have landed leaving no trace outside
  the Paddle dashboard. The branch now sits **beside the credits branch, before
  the guard**. Keep it there.
- **New KV keys, all in `ORACLE_TELEMETRY`, all durable (no TTL) except the rate
  counter**: `referee_purchase:{paddle_transaction_id}` (`{service, price_id,
  amount_minor, currency, customer_email, occurred_at, raw_event_digest}`, the
  digest being SHA-256 over the raw signed webhook bytes),
  `referee_intake:{uuid}`, and `referee_intake_rate:{ipHash}:{YYYY-MM-DDTHH}`
  (90-minute TTL, 10/hour, the mechanism `/v5/sandbox` uses on its own counter).
  These are business records, not telemetry: the revenue-event row beside them
  expires in 30 days, which is right for "alert a human this week" and useless
  for "what did this customer buy".
- **`/v5/pricing` carries a `referee` object**, every figure a projection of
  `REFEREE_PRICES`. The neutrality rule is verbatim from
  `LEAD_PLAN_2026-09-07_M5-prices-live.md` §5 — 434 characters, sha256
  `576fa9366bdb3ab438229ada26a0e3758fedda6a9a16518f796e0f4041de793b`. It is a
  commitment about what money does and does not buy; **do not paraphrase it**,
  and the web surface must quote the same bytes.
- **`POST /v5/referee/intake`** takes `{implementation, repository_or_url,
  format, version, contact_email, consent_to_be_named, methodology_version_read}`,
  returns `{intake_id, checkout_url}`. Every rejection **names the field**.
  `consent_to_be_named` must be a real JSON boolean — `"true"` is a 400, and
  `false` is accepted, because rejecting it would make consent unrefusable. The
  Paddle checkout is created **before** the KV row is written, so a Paddle
  failure leaves no half-state a retrying agent would duplicate. It needs no
  `wrangler.toml` route: `headlessoracle.com/v5/*` already covers it.
- **Also fixed**: `plan` is caller-supplied and was used to index a plain object
  literal, so `{"plan":"constructor"}` reached `env[Object]` and returned 503
  "billing plan is not configured" — a name we do not sell, reported as a
  configuration fault of ours. Own-property checks only.

**Not closed, named deliberately**: no referee checkout, transaction or webhook
has been exercised against the live Paddle account from this tree; the intake's
mail path has only ever run against a mock; and no web surface carries a referee
section.

### B-146 — the repository verifies its own history (2026-09-10)

`SIGNING_KEYS` and `tools/verify-history.sh`, ported from `receipt-verify`. CI
verifies the **pushed range**, so every commit that lands from here on must
carry a good SSH signature or the build is red.

**The whole history does not verify, and the script does not pretend it does.**
188 commits before 2026-04-02 are unsigned; 13 between 2026-04-17 and 2026-06-17
are GitHub web-UI merge commits **PGP**-signed by GitHub's own web-flow key,
which `ssh-keygen -Y verify` cannot check. So the default range starts after the
last of those (`82cec16`), where every commit is SSH-signed, and the script
prints how many commits it is **not** covering. `sh tools/verify-history.sh
--full` walks everything, prints the census, and **exits 1 on purpose**.

`SIGNING_KEYS` lists **two principals and one key**: all 209 SSH-signed commits
carry the same key, 134 committed under `info@bytecraftresults.com` and 75 under
the GitHub noreply address, and `ssh-keygen` matches on the principal it is
given. With one principal listed the census reported 134 good signatures as
`BAD`, which reads exactly like tampering.

### GAP-019 — CLOSED 2026-09-10: moved verbatim to `docs/history/claude-md-moved-2026-10-07.md`

The rule that stands: if a flake appears, capture the full run before retrying.

### `verify_receipt` is not an MCP tool — CLOSED 2026-10-07 (live `2e68085f`)

`tools/list` serves the four `MCP_TOOLS`. The `mcp-tool-catalog` and `verify-receipt`
agent skills no longer list `verify_receipt`; the index says "four";
a test pins its `## Tools` list to `tools/list`. Verification is REST
(`POST /v5/verify`) or offline. Not swept: `packages/headless-oracle-mcp/README.md`,
`docs/` (not served).

### The placeholder guard (2026-09-07, T2b)

No served byte may carry a template placeholder the runtime never filled. The guard
in `test/index.spec.ts` fetches a **hand-maintained list** of public text
surfaces and asserts none matches `${...}`. Since 2026-09-10 an entry may name
its own request and expected status, so a POST-only route is covered too — the
list was GET-200 only, which would have let every POST route escape it. **Rule: any new served-text route is
added to that list in the same commit that adds the route.** A list-based guard only
covers what someone remembered; `scripts/start-smoke.sh` checks `/openapi.json`
against the real served bytes as a second, list-free net.

### `/v5/payment-proof` — GAP-021 closed 2026-09-07 (`bba936b`)

Computed on read from a chain-verified ledger, never from a cached counter.
`X402_HISTORICAL_SETTLEMENTS` holds the four lifetime x402 settlements, each naming a
transaction hash, block number and block time anyone can resolve on Basescan; new
settlements append a durable `x402_payment:` KV row with **no TTL**.

The four-settlement chain walk and the diagnosis behind it: moved verbatim to
`docs/history/claude-md-moved-2026-10-07.md`.

### GAP-017 — closed 2026-09-07 (`cfb4d9a`)

`supabaseHotPath()` injects a 2000ms `AbortSignal.timeout` into every Supabase call on
a request's own path: `checkApiKey` step 4 (blocking), `updateKeyUsage` and
`insertReceiptAudit` (per authenticated request under `ctx.waitUntil`). Webhook and
admin handlers build their own clients and are deliberately out of scope.

The severity is worth recording: the RED run against the unfixed code did not fail,
it **hung** — vitest's own 10s per-test timeout could not recover the isolate, and the
run had to be killed with workerd still holding the port. Fail-closed is unchanged (a
timed-out lookup denies access) and now logs `AUTH_BACKEND_LOOKUP_FAILED` so a
degrading auth backend no longer reads as a wave of bad keys.

**Not closed, named deliberately**: a timeout still returns `403 INVALID_API_KEY`,
which tells an agent to rotate a key that is probably fine. The right answer is a 503
with `Retry-After`, so the agent retries. That changes `AuthResult` (its failure
status is typed `402 | 403`) and an established public status code, so it is flagged
rather than smuggled into a timeout fix.

### CI test-count annotation — closed 2026-09-07: moved verbatim to `docs/history/claude-md-moved-2026-10-05.md`

### Deploy procedure (amended 2026-09-07, B-115)

1. Open a new shell. Confirm the identity the deploy will use: `npx wrangler whoami`.
   It must show the account and the Workers Routes permission before you deploy.
2. `npm run deploy` (`npx wrangler deploy`). Expect an uploaded version id and the
   trigger list, with no red.
3. Live-verify the changed endpoints by fetching them; record the version id.
4. Run `npm run test:smoke` (the eleven production checks in
   `test/integration/smoke.test.ts`) after **every** `npm run deploy`, whatever the
   deploy's exit code, and paste its result into the session's RUNS file. A failure
   is reported there, not retried away. The pre-commit hook never runs this suite,
   which is how H3a changed the `/llms.txt` heading and CI's "Smoke Tests
   (production)" went red on `660a241` and `7027ecd` unnoticed (fixed by H3e). It is
   a manual step and not an npm `postdeploy` hook on purpose: npm runs `postdeploy`
   only when `deploy` exits 0, and every deploy since 2026-09-24 has exited 1 on the
   B-115 route-listing step, so the hook would never have fired. Once B-115 is
   closed, a `postdeploy` hook is the better home for it.

**Known benign failure, with a hard limit.** The 2026-09-07T12:41Z deploy uploaded
successfully but failed while listing zone routes
(`/zones/…/workers/routes`, auth code 10000) and could not read the user's email.
That failure is benign **only while routes are unchanged** — a deploy that adds or
changes a route will fail at that step and the route will not exist. The root cause
(which token the deploy ran on, and which permissions it carries) is tracked
separately as B-115 and is being corrected outside this commit; do not treat the
symptom above as the whole diagnosis. Confirm with `whoami` before every deploy.

### Steady state (unchanged, last confirmed 2026-06)
- **Daily operational rhythm**: 308–365 signed receipts/day, 6–16 authenticated
  calls/day. Steady, not episodic.
- **Sustained agent discovery**: Chiark, glama, MCPRegistry, Smithery Connect,
  codex-mcp-client, AgentSEO, AgentPulse, nothumansearch.ai all probe on their own
  cadence. No outreach required.
- **AI crawler coverage**: Meta-ExternalAgent, ClaudeBot, Amazonbot, Googlebot,
  GPTBot, Applebot all active.
- **Exchange count**: 28 (23 traditional + XCBT, XNYM, XCBO, XCOI, XBIN). Every
  surface says 28.
- **Infrastructure cost**: ~$15.50/month.
- **Monitoring**: GitHub Actions health-check every 15 min. See
  `.claude/rules/monitors.md`.

### Open follow-ups
- **Web calibration pending**: `headless-oracle-web/index.html` + `standards.html`
  still need the "proposed, open PR #9" language. Calibration lives on the
  `didit-7day-reframe` branch in the web repo and has not landed on the deployable
  branch.
- **`ho.receipt` adapter** in `receipt-verify` does not exist — the coverage block's
  "0 unaddressed coverage items" DoD line cannot be run until it is written, in a
  repository this sprint does not own.
- **Coverage-history endpoint** — not built.
- **Rate-limit test flake** — see GAP-019 above; one-line fix, deliberately not taken
  here.
- **403-vs-503 on an auth-backend timeout** — see GAP-017 above.

## Active standards work

Coordinated artefacts define the environment-constraint contract for autonomous
agents: an IETF Internet-Draft for the family/vocabulary layer, two sibling PRs at
`agent-intent/verifiable-intent` for the individual constraint types, and a
composition draft in preparation. HO is the named reference implementation for the
market-state member.

- **IETF I-D — `draft-borthwick-msebenzi-environment-state-02`, filed 2026-08-27.**
  "Verifiable Intent — environment.* Constraint Family". Independent Submission /
  Informational, 46 pages. Co-authored with Douglas Borthwick (InsumerAPI).
  **Expires 28 February 2027.** Archive bytes pinned 2026-09-02:
  `https://www.ietf.org/archive/id/draft-borthwick-msebenzi-environment-state-02.txt`,
  sha256 `d78fc31fdaafb9e3fbe22a4c97af5c485d8714bbb91b10b1c19b969026e5d922`,
  116,519 B, 2,576 lines. Family-definition specification: membership criterion
  (the failure mode must be gating), family-wide vocabulary (`attestation_url`,
  `max_attestation_age`, field-scope taxonomy), composition discipline
  (conjunction-with-completeness), register discipline, security considerations,
  IANA registry mechanics. **Supersedes -00** (filed 2026-05-11, 43 pages, expired
  2026-11-11) — cite -02 and its section numbers, never -00.
- **`draft-msebenzi-evidence-action-00`** (28 July 2026, Informational, 40 pages,
  expires 29 January 2027) — "The evidence.* Family: Post-Hoc, Independently
  Recomputable Evidence Records for AI Agent Actions". The post-hoc sibling to the
  pre-authorisation `environment.*` family.
- **Composition draft — in preparation, not filed.** The registry / annex / envelope
  text, negotiated three-way with Douglas Borthwick and Joe Krausz. The envelope
  text is normative there rather than in the family draft. Status lives outside this
  repo in the founder's `cc-output` folder; do not describe it as filed.
- **PR #9 (ours)** — `environment.market_state` constraint type. Revision
  `v0.5.10-draft` (May 2026), still in review. Agents declare acceptable
  market-state conditions up front; the runtime enforces them against signed HO
  attestations before executing.
- **PR #22 (Douglas Borthwick, InsumerAPI)** — sibling `environment.wallet_state`
  constraint type, `v0.6.5-draft`. The same structural pattern applied to on-chain
  payment-source state across 33 chains.
- **Shared architecture** — a common `max_attestation_age` freshness field, the RFC
  8725 §3.1 algorithm-agility framework for signing, JWKS-discovered trust roots,
  and a fail-closed posture (unknown or expired attestation → refuse to proceed).
  Family-wide prose is byte-identical across PR #9 and PR #22 on the shared
  sections.

### Spec-conformance guardrails (LOAD-BEARING)

Any code change that affects **any of the following must be flagged before committing**:

- The SMA receipt format (field names, types, ordering)
- Signature canonicalization (alphabetical sort, JSON.stringify with no whitespace)
- Ed25519 signing primitives (`@noble/ed25519`, CryptoKey caching, canonical payload construction)
- `/v5/demo` or `/v5/status` response shape or semantics

Breaking spec conformance while PR #9 is in review destroys the reference-implementation argument. If you believe a change is required, surface it explicitly with a rationale and the conformance impact — do not commit silently.

## How to Work on This Project

1. Read `.claude/rules/00_engineering_standards.md` first
2. Read this file and `.claude/rules/90_active_priorities.md` for current state
3. Run tests: `npm test` (requires `.dev.vars` to be populated)
4. Make changes, run tests again
5. Commit with descriptive message including test count
6. Deploy: `npm run deploy` — but read **Current State → Deploy procedure** first;
   it carries the `wrangler whoami` precondition and the one known benign failure
7. Live-verify: curl the changed endpoints
8. Update this file's "Current State" section

## Working style (Opus 4.7)

How Mike and I collaborate on this codebase now:

- **Brief with full context at task start.** Relevant files, latest test output, recent commit history, and success criteria — up front. Don't make me discover context progressively through tool calls when you could have handed it over in one message.
- **Expect 1–2 session completion for non-trivial work.** Spec revisions, protocol implementations, multi-file refactors — plan for that horizon. Don't split arbitrarily across more sessions.
- **Pre-commit gate (enforced automatically via `.githooks/pre-commit`, no exceptions — including docs-only commits):**
  1. `npx tsc --noEmit` — zero TypeScript errors
  2. `npm test` — full suite must pass
  3. `npx wrangler deploy --dry-run` — bundle + config must validate
  4. `bash scripts/start-smoke.sh` — the worker actually boots and serves
     `/v5/health` and `/openapi.json` (added 2026-09-07). The first three never
     start the worker: a bundle can clear all of them and still be one workerd
     refuses to run. ~12s; if it grows past 30s, move it to CI only and say so in
     the hook rather than dropping it.
  One-time setup per clone or worktree: `git config core.hooksPath .githooks`. Tests require `.dev.vars`; copy it into any new worktree before the first commit. Do not reach for `--no-verify` — if you believe an exception is warranted, surface it in the conversation first.
- **Documented bypass class (2026-05-13) — SUPERSEDED 2026-09-07.** The
  environment flake this class existed for did not reproduce on any commit of
  2026-09-07; the full four-step gate ran clean on all seven, including logic
  commits. Treat `--no-verify` as unavailable, and surface a proposed exception in
  the conversation before committing rather than invoking this paragraph. Its original text
  is in `docs/history/claude-md-moved-2026-10-07.md`.
- **Fail-closed posture is load-bearing.** It is the product's defining invariant and it is threaded through the codebase. Any change that introduces a permissive default, silent fallback, "temporary" bypass, or optimistic assumption in an error path must be flagged explicitly before committing. Don't reason it away — surface it.
- **Commit signing.** Sign commits with the SSH signing key at `~/.ssh/id_ed25519_signing`. Already configured globally — no per-commit setup needed.

## What NOT to Do

- Don't extend the 60-second receipt TTL
- Don't make UNKNOWN mean anything other than CLOSED
- Don't submit PRs to external repos without verifying they compile
- Don't use marketing language in GitHub issues/PRs — write as a contributor
- Don't cache telemetry writes — only cache reads
- Don't break the x402 payment flow (it took 27 days to debug)
- Don't hardcode UTC offsets — use IANA timezone names exclusively
- Don't add exchange configs without 2026+2027 holiday data

## Update Protocol (MANDATORY at end of every session)

These files are LIVING DOCUMENTS. Stale context docs are worse than no docs.
If you don't update them, the next session starts with wrong assumptions.

1. **CLAUDE.md** "Current State" section — test count, worker version, PRs, metrics
2. **90_active_priorities.md** — what was done, what's pending
3. **01_business_context.md** — if metrics changed (new evaluators, revenue, clients)
4. **02_architecture_map.md** — if routes or functions were added/changed
5. **04_telemetry_guide.md** — if new evaluator fingerprints appeared

## Scaling Reminders

- **>100 unique MCP clients/day**: Add cursor pagination to 17:00 cron KV list()
- **>100 unique MCP clients/day**: Refactor /v5/metrics to read pre-aggregated key
- **>100 x402 requests/day**: Cache verified Base tx receipts (2 RPC calls per request currently)
- **>10K unique keys/isolate**: Add LRU eviction to in-memory API key cache
- **Commercially important telemetry**: Add X-Proxy-Token validation for X-Original-* headers

## Strategic North Star

This project builds the signed market-state primitive for AI agent infrastructure.
The analogy is a DNS root server — not a product, a layer of the internet.
Primary consumer: autonomous agents, not human developers.

**Decision filter**: "Can an agent consume this without asking a follow-up question?"
If no, the interface is not done.

Full strategic context: `.claude/rules/05_strategic_vision.md`

## Strategic context

- **Reference-implementation positioning.** HO is positioning as *the* reference implementation for `environment.market_state` in the Verifiable Intent standard (Mastercard/Google initiative). Every architectural choice should strengthen that claim.
- **Acquisition target priority (in order).** Cloudflare → Coinbase → Mastercard. Each has a distinct story: Cloudflare owns the edge layer we already live on, Coinbase owns the x402 rails the payment path depends on, Mastercard owns the standard the market-state constraint sits inside.
- **Standards adoption > feature velocity.** A shipped feature moves the product one step. A standard we're cited in moves the category around us. When the two conflict, standards adoption wins — because acquisition positioning follows standard adoption, not feature count.
- **Long-term thesis.** HO is the trust layer for autonomous financial agents. Fail-closed signed attestations, verifiable by any consumer, issued by an operator whose economic incentives are aligned with correctness rather than coverage.

## Ecosystem

| Artefact | Location |
|---|---|
| SMA Protocol Spec | github.com/LembaGang/sma-protocol |
| Agent Pre-Trade Safety Standard | github.com/LembaGang/agent-pretrade-safety-standard |
| MPAS Spec | github.com/LembaGang/mpas-spec |
| Halt Simulator | github.com/LembaGang/halt-simulator |
| Python SDK | PyPI: `headless-oracle` (0.1.1) |
| JS Verify SDK | npm: `@headlessoracle/verify` (1.1.0) |
| Go SDK | github.com/LembaGang/headless-oracle-go |
| MCP stdio package | npm: `headless-oracle-mcp` |
| Setup tool | npm: `headless-oracle-setup` |
