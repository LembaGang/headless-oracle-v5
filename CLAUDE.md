# Headless Oracle V5

Headless Oracle is a Cloudflare Worker that returns Ed25519-signed market-state
attestations for 28 global exchanges. It answers one question: **"Is this
exchange open right now?"** Every response is cryptographically signed.
UNKNOWN = CLOSED (fail-closed). Revenue: x402 micropayments ($0.001 USDC on
Base), API keys (free 500/day, paid tiers via Paddle), free trial (3 signed
receipts/day/IP).

## Operational Defaults (Solo Founder Repo)

Auto-approved — no confirmation needed:
- Auto-deploy after all tests pass
- Push directly to main — no PR required
- File edits, test runs, npm installs
- Cloudflare deployments when tests pass
- New endpoint additions
- Documentation updates

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

## File Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | The entire worker: routing, signing, billing, MCP, telemetry, schedule engine |
| `test/index.spec.ts` | Main test suite (973 tests) |
| `test/x402_mint_telemetry.spec.ts` | x402 mint + per-tool telemetry tests |
| `wrangler.toml` | Worker config, KV bindings, env vars, cron triggers, routes |
| `.dev.vars` | Local dev/test secrets (test-only keypair, NOT production) |
| `vitest.config.mts` | Points to `wrangler.toml` (NOT wrangler.jsonc) |
| `.claude/rules/` | Persistent rules that survive context compaction |
| `.claude/website-inventory.md` | Historical website-state inventory dated 2026-05-04. Reconciled against live site state 2026-05-13 — every item it listed has been addressed. Kept as a reference artefact, not an action list. |
| `docs/` | Organized: architecture/, api/, operations/, legal/, business/, security/, integrations/, distribution/, blog/ |
| `CHANGELOG.md` | Keep a Changelog format — major milestones |
| `.github/actions/market-gate/` | Reusable GitHub Action for CI/CD market checks |
| `scripts/` | Deployment helpers, test sync, payment testing |
| `packages/headless-oracle-mcp/` | npm stdio MCP package |
| `packages/sdk-typescript/` | @headlessoracle/sdk TypeScript SDK (not published) |
| `packages/sdk-python/` | headless-oracle-sdk Python SDK (not published) |

## Supported Exchanges (28 total)

23 traditional (XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES, XASX, XBOM, XNSE,
XSHG, XSHE, XKRX, XJSE, XBSP, XSWX, XMIL, XIST, XSAU, XDFM, XNZE, XHEL,
XSTO) + 5 extended (XCBT, XNYM overnight CME, XCBO Cboe options, XCOI Coinbase
24/7, XBIN Binance 24/7). `mic_type: "iso" | "convention"` on all entries.

Middle Eastern exchanges (XSAU, XDFM) use `weekends: ['Fri', 'Sat']`.
XSHG/XSHE have lunch break 11:30-13:00 CST. XJPX 11:30-12:30 JST. XHKG 12:00-13:00 HKT.
DST handled automatically via IANA timezone names in `Intl.DateTimeFormat`.

## 4-Tier Fail-Closed Architecture

- **Tier 0**: KV override check — if `ORACLE_OVERRIDES[mic]` exists and not expired → return HALTED/OVERRIDE
- **Tier 1**: Schedule-based status — compute OPEN/CLOSED from market calendar
- **Tier 2**: If Tier 1 throws — sign and return UNKNOWN/SYSTEM receipt (fail-closed)
- **Tier 3**: If signing itself fails — return unsigned CRITICAL_FAILURE 500 with UNKNOWN status
- Consumers MUST treat UNKNOWN as CLOSED and halt all execution

## Routes (key endpoints)

### Public (no auth)
- `GET /v5/demo?mic=<MIC>` — Signed receipt (receipt_mode: demo)
- `GET /v5/schedule?mic=<MIC>` — Next open/close times in UTC
- `GET /v5/exchanges` — Directory of all 28 exchanges
- `GET /v5/keys` — Public key registry + canonical signing spec
- `GET /v5/health` — Signed liveness probe
- `GET /v5/briefing` — Daily market intelligence snapshot
- `GET /v5/pricing` — Machine-readable pricing tiers (sandbox/x402/credits/builder/pro/protocol)
- `GET /openapi.json` — OpenAPI 3.1 spec (81 paths, `x-model-agnostic` + `x-regulatory-alignment` extensions)
- `POST /mcp` — MCP Streamable HTTP (JSON-RPC 2.0, 5 tools) — descriptions are model-agnostic + SEC/CFTC-aligned + regional exchange names
- `POST /v5/sandbox` — Sandbox key via email or x402 (200 calls, 7-day TTL)
- `GET /v5/audit/digest` — Daily attestation digest with Merkle root
- `GET /v5/audit/chain` — Hash chain of last N daily digests
- `GET /v1/verification/multi-oracle-guide` — JSON discovery doc for the Multi-Oracle Consensus standard (spec v1.0.0 — we authored it)
- `GET /docs/specifications/multi-oracle-consensus-v1` — Full markdown spec (MIT). Aliases: `.md`, `/docs/specs/MULTI-ORACLE-CONSENSUS-v1.md`

### Authenticated (X-Oracle-Key header)
- `GET /v5/status?mic=<MIC>` — Signed receipt (receipt_mode: live). Also supports free trial (3/day/IP) and x402 payment.
- `GET /v5/batch?mics=<MIC,MIC,...>` — Batch signed receipts
- `GET /v5/usage` — Per-key usage stats
- `GET /v5/receipts` — Audit log query (builder+ only)
- `POST /v5/webhooks/subscribe` — Register webhook

### Billing
- `POST /v5/checkout` — Paddle transaction (subscription or credits)
- `POST /webhooks/paddle` — Paddle webhook handler
- `POST /v5/x402/mint` — Mint API key via on-chain USDC payment
- `POST /v5/credits/purchase` — Buy credits via x402
- `GET /v5/revenue-pulse` — Admin-only Paddle + x402 revenue feed (master-key gated). Consumed by `.github/workflows/health-check.yml` to surface new payments as GitHub issues.

### Discovery files
- `/llms.txt`, `/llms-full.txt`, `/AGENTS.md`, `/SKILL.md`
- `/.well-known/agent.json`, `/.well-known/mcp/server-card.json`, `/.well-known/x402.json`
- `/.well-known/oracle-keys.json`, `/.well-known/oauth-authorization-server`

## KV Namespaces

| Binding | Purpose | Key Pattern |
|---|---|---|
| `ORACLE_OVERRIDES` | Manual circuit-breaker halts — **MIC codes only** | `XNYS`, `XNAS`, etc. |
| `ORACLE_API_KEYS` | API key state (sha256 → plan/status/balance) | `{sha256(key)}` |
| `ORACLE_TELEMETRY` | Usage metrics, MCP analytics, telemetry | See `04_telemetry_guide.md` |

**ORACLE_OVERRIDES must never contain telemetry data.** Operators scan it for active circuit breakers.

## Secrets (Cloudflare — via `wrangler secret put`)
- `ED25519_PRIVATE_KEY` / `ED25519_PUBLIC_KEY` — Production signing keypair (hex)
- `MASTER_API_KEY` — Primary API key
- `BETA_API_KEYS` — Comma-separated beta keys
- `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID_*` — Billing
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Key management DB
- `RESEND_API_KEY` — Email delivery
- `ORACLE_PAYMENT_ADDRESS` — Base mainnet wallet for USDC micropayments
- `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY` — CDP facilitator auth

## Current State (update this section after every significant session)
<!-- Last updated: 2026-09-10 — B-149 the till opens, B-146 history verification, B-122 README -->

Every version, count and transaction below cites the run that produced it. Nothing
here is carried forward from an earlier stamp unverified.

- **Tests**: 1337 main suite (authoritative — `wrangler.toml` `TEST_COUNT`, kept in
  step by `scripts/vitest-count.sh` and enforced by CI) + 11 smoke + 24 SDK + 26
  LangGraph + 17 ai-hedge-fund. 1264 → 1298 across the rail sprint's day two;
  1298 → 1308 on 2026-09-09 (B-144 +6 and 1 replaced, B-145 +4, tripwire +1);
  **1308 → 1337 on 2026-09-10** (B-149 checkout +8, webhook +3, pricing +3,
  intake +14, placeholder guard +1).
- **Worker**: `src/index.ts` **17,729 lines** (`wc -l`, 2026-09-10 — the previous
  "~17,300" was already low, and the README's "~14,000" was three passes stale).
  API-only — zero HTML. **Live version:
  `a83fa8bf-b77f-4fe9-97b7-bf9553fa6477`** (deployed 2026-09-07T12:41:23Z — the
  x402 v2 rail; read from `npx wrangler deployments list` on 2026-09-07). The
  live worker does NOT serve T3b, T4, GAP-017, the start smoke, the derived plan
  prices, the fail-closed billing path, or anything from 2026-09-10 — so the six
  referee services are still unbuyable in production. **Push state, read from git
  on 2026-09-10: `origin/main` is at `eb2f567` — the four commits of 2026-09-09
  HAVE been pushed since the last stamp, which said `7a0bafe`. Unpushed: only
  this session's six.**
  **Whether the deployed worker matches this tree has not been checked.**
- **Local gate**: four steps, all enforced by `.githooks/pre-commit` — `npx tsc
  --noEmit`, `npm test`, `npx wrangler deploy --dry-run`, and `bash
  scripts/start-smoke.sh`. Every commit of 2026-09-07 passed all four with no
  `--no-verify`.

### GAP-019 — the local test gate: NOT REPRODUCING (2026-09-07)

The canon recorded local `npm test` as blocked by non-deterministic workerd
timeouts, with CI as the authoritative gate and `--no-verify` reserved for
prose-only commits. It did not reproduce on any commit of 2026-09-07: seven
commits ran the full hook clean (tsc 0, suite green, dry-run 0, and from
`b4c4fb4` onward the start smoke too). Full-suite wall time 120–130s.

Two flakes were observed and are recorded rather than swept up, because a gate
that goes red for the wrong reason erodes trust in the gate:

- `GET /v1/status/{MIC} — in-worker rate limit > exact-limit (60) all pass; 61st
  returns 429` failed once in a full-suite run and passed 3/3 in isolation. The
  mechanism is identified: the limiter buckets on `Math.floor(now/60_000)`, a
  wall-clock minute, and the test fires 61 real sequential requests. If those
  straddle a minute boundary the counter resets and the 61st returns 200. Latent
  since the test was written; surfaced by the extra milliseconds T3b adds per
  receipt. One-line fix: pin the clock with `vi.setSystemTime` for that test.
  **Flagged, not fixed** — it is outside this sprint's scope.
- One further single-test failure during the first attempt at the `b4c4fb4`
  commit, which passed on re-run and on retry. Not identified; the output was not
  captured. If a third flake appears, capture the full run before retrying.

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
SDKs. **Not closed**: `receipt-verify`'s `ho.receipt` adapter still does not exist
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
  all**. An **absent** plan still means Builder — absent and unrecognised are
  different cases and only the second was a defect.
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

### GAP-019 — CLOSED 2026-09-10

The two 61-request rate-limit tests (`/v1/status/{MIC}` and
`/v1/safe-to-trade/sample`) pin the clock with `vi.setSystemTime`, so all 61
requests land in one wall-clock-minute bucket by construction. The flake fired
in four of eight full runs on 2026-09-10 once the suite grew — what decides it
is where in the minute the burst starts. Proved it still fails for the right
reason: with the two limit constants temporarily at 9999 both tests went red
with "expected 200 to be 429".

### FLAGGED, NOT FIXED — `verify_receipt` is not an MCP tool

`MCP_TOOLS` has **four** entries — `get_market_status`, `get_market_schedule`,
`list_exchanges`, `get_payment_options` — and `tools/list` serves `MCP_TOOLS`.
But `src/index.ts` contradicts itself about it: one served surface says "Do not
expect a `verify_receipt` MCP tool" while `/SKILL.md` and the agent-skills text
list it among the MCP tools. **This file's own "5 tools" claims are wrong too.**
Verification is REST-only (`POST /v5/verify`) or offline. Not fixed here — it
touches several served agent-facing surfaces and is its own row.

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

The four, from an `eth_getLogs` walk of USDC `Transfer(_, payTo, _)` over blocks
44,192,527 → 51,000,755 (692 RPC calls, 0 failures, 2026-09-07):

| tx | block | block time | note |
|---|---|---|---|
| `0xeb9da873…b308a` | 44,218,092 | 2026-04-03T14:12:11Z | the first dollar |
| `0xb4b93483…5cf2`  | 44,382,001 | 2026-04-07T09:15:49Z | **was undocumented anywhere** |
| `0xa6bc45dc…ee41`  | 47,022,787 | 2026-06-07T12:22:01Z | first CDP-facilitated settlement |
| `0x46db8fc8…9263`  | 50,998,385 | 2026-09-07T13:01:57Z | the v2 rail run |

Three causes, and the canon's earlier diagnosis was wrong on two of them. The
first-payment keys were **never written**, not evicted: both verifiers seeded them
under `if (count === 0)`, a branch that fires at most once in a counter's lifetime
and had missed its window. The value would have been unusable anyway — it stored
`txHash.slice(-12)`, a twelve-character suffix no explorer can resolve. And the
suggested fix, computing counts on read from the listable prefixes, **cannot work**:
a walk of production `ORACLE_TELEMETRY` on 2026-09-07 returned **zero keys** from all
three of `x402_used:` (600s TTL), `x402_used_tx:` (365d) and
`paddle_revenue_event:` (30d). Also corrected: `payment_count: 3` on 2026-06-07 was
**not** an undercount — exactly three settlements had occurred by then.

Production `x402_payment_count` reads 4 and the chain walk finds 4 — two sources that
could have disagreed, agreeing. What that does **not** establish is the absence of a
settlement before 2026-04-03: the walk starts at that day's first block, so an earlier
one would have to have escaped both the walk's start bound and the counter. The
endpoint reports the counter beside the ledger with an `agrees` flag rather than
replacing it silently.

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

### CI test-count annotation — closed 2026-09-07 (`61db54c`)

The detector was the bug, not the count. `grep -oP '\d+(?= passed)' | head -1` reads
the `Test Files  2 passed` line, so CI annotated "actual test count (2)" for as long
as the check existed. Extraction now lives in `scripts/vitest-count.sh`, shared by
`scripts/sync-test-count.sh` and CI so they cannot drift apart: it anchors on the
`Tests` summary line, strips ANSI first, uses `sed` rather than `grep -P` (which the
Git Bash running the local hook refuses outright, so the old detector returned an
empty string locally and `npm run test:sync-count` could never have worked on this
machine), and refuses to report a count from a run that had failures. **The CI step
now fails on a mismatch instead of warning** — `TEST_COUNT` is served at
`/v5/metrics/public`, so a mismatch is a number we publish and cannot support. CI also
no longer runs the suite twice.

### Deploy procedure (amended 2026-09-07, B-115)

1. Open a new shell. Confirm the identity the deploy will use: `npx wrangler whoami`.
   It must show the account and the Workers Routes permission before you deploy.
2. `npm run deploy` (`npx wrangler deploy`). Expect an uploaded version id and the
   trigger list, with no red.
3. Live-verify the changed endpoints by fetching them; record the version id.

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
  the conversation before committing rather than invoking this paragraph. Kept
  below for the history of why it existed. Original text: On 2026-05-13 the worker pre-commit hook hung 40+ min on `getaddrinfo(): #11001 No such host is known.` for `sahqfuyneoeqczupmysu.supabase.co` — vitest-pool-workers making real DNS calls instead of mocking Supabase. This is the same flake-class as the "65 pre-existing Windows EBUSY failures" already documented in this file. Two commits used `--no-verify` after explicit MBeenzi approval: `59d9099` (sitemap/robots constants) and the documentation commit that landed this note. The exception class is: **pure string-constant or markdown-only edits with zero logic, route, or test surface, when the hook is failing on documented environment-flake symptoms.** Bypass requires (a) explicit approval per change, (b) the commit message stating the change is docs/data-only, naming the change, and naming the bypass reason. The next worker commit that touches logic or routes must wait for the test env to be fixed — the bypass class does not extend to those.
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

## Commands
- `npm test` — Run full test suite (requires `.dev.vars`)
- `npm run dev` — Local development server
- `npm run deploy` — Deploy to Cloudflare Workers
- `npm run test:smoke` — Run smoke tests against live production

## Context Files (read at session start)

| File | Purpose |
|---|---|
| `.claude/rules/00_engineering_standards.md` | Hard rules for this codebase |
| `.claude/rules/01_business_context.md` | Market position, revenue model, metrics |
| `.claude/rules/02_architecture_map.md` | Route map, key functions, data flows |
| `.claude/rules/03_sprint_playbook.md` | Sprint patterns, failure modes, checklists |
| `.claude/rules/04_telemetry_guide.md` | KV key patterns, evaluator fingerprints |
| `.claude/rules/05_strategic_vision.md` | North star, decision filters |
| `.claude/rules/10_decisions.md` | Architecture Decision Records |
| `.claude/rules/90_active_priorities.md` | Current sprint state and next actions |

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

## DST Calendar — Critical Dates 2026
- **March 8**: US spring forward (EST→EDT) — XNYS, XNAS
- **March 29**: UK/EU spring forward (GMT→BST / CET→CEST) — XLON, XPAR, XSWX, XMIL, XHEL, XSTO
- **October 25**: UK/EU fall back — same exchanges
- **November 1**: US fall back — XNYS, XNAS

## Ecosystem

| Artefact | Location |
|---|---|
| SMA Protocol Spec | github.com/LembaGang/sma-protocol |
| Agent Pre-Trade Safety Standard | github.com/LembaGang/agent-pretrade-safety-standard |
| MPAS Spec | github.com/LembaGang/mpas-spec |
| Halt Simulator | github.com/LembaGang/halt-simulator |
| Python SDK | PyPI: `headless-oracle` (0.1.1) |
| JS Verify SDK | npm: `@headlessoracle/verify` (1.0.2) |
| Go SDK | github.com/LembaGang/headless-oracle-go |
| MCP stdio package | npm: `headless-oracle-mcp` |
| Setup tool | npm: `headless-oracle-setup` |
