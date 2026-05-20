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
<!-- Last updated: 2026-05-20 — Agent Readiness Stack ship -->

- **Tests**: 1056 main suite (authoritative — `wrangler.toml` TEST_COUNT) + 11 smoke + 24 SDK + 26 LangGraph + 17 ai-hedge-fund
- **Worker**: `src/index.ts` ~13,700 lines. API-only — zero HTML. Live version: `dde5c165` (deployed 2026-05-20 — Agent Readiness Stack).
- **Agent Readiness Stack (2026-05-20)**: static agent-discovery surface added (no signing / canonical-payload / x402-settlement changes — route additions only). New live well-known endpoints: `/.well-known/mcp` (extensionless alias to the MCP server card), `/.well-known/agent-skills/index.json` + 5 `SKILL.md` docs (`verify-receipt`, `read-market-state`, `subscribe-halts`, `pay-with-x402`, `mcp-tool-catalog`; agentskills.io discovery 0.2.0 — index digests computed at request time from served bytes so they cannot drift), `/.well-known/api-catalog` (RFC 9727 / RFC 9264 linkset harvested from `AGENT_JSON.rest_api.endpoints`), `/agent-directory.json` (+ worker route — fixes the prior 200 `text/html` Pages soft-404) and `/.well-known/agent-directory.json`. `robots.txt` now declares Cloudflare `Content-Signal: ai-train=no, ai-input=yes, search=yes` plus explicit `Allow` blocks for ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, ChatGPT-User, AgenstryBot, Open402DirectoryCrawler, YellowMCP-HealthChecker. **Audit log of record: `AGENT_READINESS.md`** (commits `54700a0` + `5639a23`). Deferred: root `/` `Link` headers (root is Pages-served — `headless-oracle-web` `_headers` follow-up).
- **IETF Internet-Draft (2026-05-11)**: `draft-borthwick-msebenzi-environment-state-00` filed on the Independent Submission / Informational track. 43 pages. Co-authored with Douglas Borthwick (InsumerAPI). Family-definition spec for the `environment.*` constraint family — the layer above `environment.market_state` (HO, PR #9) and `environment.wallet_state` (InsumerAPI, PR #22). Live at <https://datatracker.ietf.org/doc/draft-borthwick-msebenzi-environment-state/>. Citable, archived, expires 2026-11-11 (re-file or evolve before then). This is the load-bearing artefact making HO the named reference implementation for the family rather than one of many candidates.
- **Essay infrastructure (2026-05-13)**: `headlessoracle.com/essays/` index + two HTML-rendered essays live — `/essays/environment-internet-draft` (announcement of the I-D filing, v1.0.0, May 13) and `/essays/trust-primitive` (architectural argument for environment-state attestation, v1.6.4, April 28). Each page carries full OG/Twitter/canonical/article metadata. Canonical markdown sources live at `github.com/headlessoracle/essays`; tagged releases (`v1.0.0-environment-internet-draft-2026-05-13`, `v1.6.4-2026-04-28`) are SSH-signed. Served by Cloudflare Pages via `public/essays/<slug>/index.html` pass-through (no worker route). Sitemap + robots both list the paths.
- **Site-wide og-image.png (2026-05-13)**: `https://headlessoracle.com/og-image.png` now returns 200 image/png (1200×630, 28.85 KB) instead of the pre-existing text/html SPA fallback. Closes the broken-preview-card gap that affected every page advertising the URL. Type-only composition (HEADLESS ORACLE wordmark, signed-market-state tagline, Ed25519 / 28 exchanges / fail-closed / 60s TTL footer). Generated via PowerShell + System.Drawing (no new deps).
- **First Dollar**: achieved 2026-04-03 on Base mainnet — tx `0xeb9da873`, $0.001 USDC, settled via x402 on `/v5/status`. This is the load-bearing proof that an autonomous agent can discover, pay, and verify without human mediation.
- **Daily operational rhythm**: 308–365 signed receipts/day, 6–16 authenticated calls/day. Traffic is steady, not episodic.
- **Sustained agent discovery**: Chiark, glama, MCPRegistry, Smithery Connect, codex-mcp-client, AgentSEO, AgentPulse, nothumansearch.ai all probe on their own cadence. No outreach required to keep them warm.
- **AI crawler coverage**: Meta-ExternalAgent, ClaudeBot, Amazonbot, Googlebot, GPTBot, Applebot all active. Recent 24h window showed a 588% increase in crawl volume — the training-data-as-distribution thesis is working.
- **MCP prompts**: `pre_trade_check(mic)` and `market_briefing` — structured fail-closed guidance messages via `prompts/list` + `prompts/get`
- **MCP resources**: `oracle://exchanges/directory` — static 28-exchange directory via `resources/list` + `resources/read`
- **OpenAPI**: 81 paths, 11 semantic tags, `x-model-agnostic: true` + `x-regulatory-alignment` extensions on the `info` block
- **Exchange count**: 28 (23 traditional + XCBT, XNYM, XCBO, XCOI, XBIN). Every surface says 28.
- **x402 hardening**: 402 responses carry flat top-level machine-readable fields (`payment_required`, `payment_method`, `currency`, `network`, `chain_id`, `pricing`, `x402_endpoint`, `pricing_endpoint`, `documentation_url`, `alternative`) so lowest-capability models can parse without walking nested objects. `server-card.json` has a top-level `payment` section with `autonomous_payment: true`.
- **Multi-Oracle Consensus spec v1.0.0**: we authored it. Served at `/docs/specifications/multi-oracle-consensus-v1` (markdown, MIT) and `/v1/verification/multi-oracle-guide` (JSON). Versioned `/v1/` so other oracles can adopt the same path. HO is `reference_oracles[0]`.
- **Standards hub (web)**: `headless-oracle-web/standards.html` is live.
- **Monitoring**: GitHub Actions health-check every 15 min — `.github/workflows/health-check.yml` + `scripts/health-check.mjs`. Verifies 5 endpoints, Ed25519 signatures, TTL window, Pages-vs-Worker classifier, and Paddle revenue events → GH issues. Full design in `.claude/rules/monitors.md`.
- **Infrastructure cost**: ~$15.50/month
- **Competitive landscape**: See `.claude/rules/95_competitive_landscape.md`. No direct competitor ships signed market-state. 12–24 month window before Chainlink/Pyth could.
- **Verification SDKs (republished 2026-05-04)**: `@headlessoracle/verify@1.0.2` on npm and `headless-oracle@0.1.1` on PyPI. Both ship the canonicalization fix that aligns the consumer-side payload reconstruction with `/v5/keys → canonical_payload_spec`. Prior versions (1.0.1 / 0.1.0) silently produced `INVALID_SIGNATURE` on every real receipt for ~2 months and must not be recommended. Tags `v1.0.2` (commit `542762f`) and `v0.1.1` (commit `7e5e159`) are SSH-signed and pushed. Three sibling framework packages on PyPI (`headless-oracle-strands`, `headless-oracle-crewai`, `headless-oracle-langchain`) are thin REST wrappers, do not depend on `headless_oracle`, and are unaffected.

## Active standards work

Three coordinated artefacts define the environment-constraint contract for autonomous agents: an IETF Internet-Draft for the family/vocabulary layer, and two sibling PRs at `agent-intent/verifiable-intent` for the individual constraint types. HO is the named reference implementation for the market-state member.

- **IETF I-D (filed 2026-05-11)** — `draft-borthwick-msebenzi-environment-state-00`. Family-definition specification: membership criterion (failure mode must be gating), family-wide vocabulary (`attestation_url`, `max_attestation_age`, field-scope taxonomy), composition discipline (conjunction-with-completeness), register discipline, security considerations, IANA registry mechanics. Independent Submission / Informational. Expires 2026-11-11 — re-file or evolve before then.
- **PR #9 (ours)** — `environment.market_state` constraint type. Current revision `v0.5.10-draft` (May 2026). Agents declare acceptable market-state conditions up front; the runtime enforces them against signed HO attestations before executing.
- **PR #22 (Douglas Borthwick, InsumerAPI)** — sibling `environment.wallet_state` constraint type. Current revision `v0.6.5-draft`. Same structural pattern applied to on-chain payment-source state across 33 chains.
- **Shared architecture** — all three artefacts use a common `max_attestation_age` freshness field, the RFC 8725 §3.1 algorithm-agility framework for signing, JWKS-discovered trust roots, and a fail-closed posture (unknown or expired attestation → refuse to proceed). Family-wide prose is byte-identical across PR #9 and PR #22 on the shared sections.

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
6. Deploy: `npm run deploy`
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
  One-time setup per clone or worktree: `git config core.hooksPath .githooks`. Tests require `.dev.vars`; copy it into any new worktree before the first commit. Do not reach for `--no-verify` — if you believe an exception is warranted, surface it in the conversation first.
- **Documented bypass class (2026-05-13).** On 2026-05-13 the worker pre-commit hook hung 40+ min on `getaddrinfo(): #11001 No such host is known.` for `sahqfuyneoeqczupmysu.supabase.co` — vitest-pool-workers making real DNS calls instead of mocking Supabase. This is the same flake-class as the "65 pre-existing Windows EBUSY failures" already documented in this file. Two commits used `--no-verify` after explicit MBeenzi approval: `59d9099` (sitemap/robots constants) and the documentation commit that landed this note. The exception class is: **pure string-constant or markdown-only edits with zero logic, route, or test surface, when the hook is failing on documented environment-flake symptoms.** Bypass requires (a) explicit approval per change, (b) the commit message stating the change is docs/data-only, naming the change, and naming the bypass reason. The next worker commit that touches logic or routes must wait for the test env to be fixed — the bypass class does not extend to those.
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
