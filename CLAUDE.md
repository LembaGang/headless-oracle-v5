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

- **Single TypeScript file**: `src/index.ts` (~14,000 lines)
- **Runtime**: Cloudflare Workers (edge, no origin server)
- **KV namespaces**: `ORACLE_TELEMETRY` (metrics/usage), `ORACLE_API_KEYS` (auth + billing state), `ORACLE_OVERRIDES` (manual halt overrides)
- **Signing**: Ed25519 via `@noble/ed25519` with CryptoKey cached in module scope
- **MCP server**: POST `/mcp` (protocol `2024-11-05`, streamable HTTP, 5 tools)
- **Payments**: x402 via Coinbase CDP facilitator on Base mainnet
- **Billing**: Paddle (subscriptions + credit packs), keys stored in Supabase + KV cache
- **Email**: Resend for key delivery
- **Durable Objects**: `StreamCoordinator` (SSE), `WebhookDispatcher` (state-change fan-out)
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
| `test/index.spec.ts` | Main test suite (753+ tests) |
| `test/x402_mint_telemetry.spec.ts` | x402 mint + per-tool telemetry tests |
| `wrangler.toml` | Worker config, KV bindings, env vars, cron triggers, routes |
| `.dev.vars` | Local dev/test secrets (test-only keypair, NOT production) |
| `vitest.config.mts` | Points to `wrangler.toml` (NOT wrangler.jsonc) |
| `.claude/rules/` | Persistent rules that survive context compaction |
| `docs/` | Organized: architecture/, api/, operations/, legal/, business/, security/, integrations/, distribution/, blog/ |
| `CHANGELOG.md` | Keep a Changelog format — major milestones |
| `.github/actions/market-gate/` | Reusable GitHub Action for CI/CD market checks |
| `scripts/` | Deployment helpers, test sync, payment testing |
| `packages/headless-oracle-mcp/` | npm stdio MCP package |

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
- `GET /openapi.json` — OpenAPI 3.1 spec
- `POST /mcp` — MCP Streamable HTTP (JSON-RPC 2.0, 5 tools)
- `GET /v5/sandbox` — Instant sandbox key (200 calls, 7-day TTL)
- `GET /v5/audit/digest` — Daily attestation digest with Merkle root
- `GET /v5/audit/chain` — Hash chain of last N daily digests

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
<!-- Last updated: 2026-04-08 by Day 43 Claude Managed Agents guide + upgrade nudge -->

- **Tests**: 1014/1014
- **Worker version**: 8b1008d9 (latest deployed)
- **Test payment**: 1 x402 payment settled (Day 41)
- **External revenue**: $0 (no stranger has paid yet)
- **Active PRs**: TradingAgents #523, ai-hedge-fund #564, a0-plugins #193, awesome-mcp-servers #343, ampersend #11
- **Evaluators**: DataCamp, Chiark, CacheFly/Glama, MCPScoreboard 100/100, YellowMCP, AgentDiscoveryIndex
- **npm users**: 4 independent (South Africa, Italy, Germany, Indiana University)
- **Auth calls**: recurring (Day 41: 9, Day 42: 4+)
- **Weekly unique MCP clients**: 65 (Week 14)
- **Infrastructure cost**: $15.50/month

## How to Work on This Project

1. Read `.claude/rules/00_engineering_standards.md` first
2. Read this file and `.claude/rules/90_active_priorities.md` for current state
3. Run tests: `npm test` (requires `.dev.vars` to be populated)
4. Make changes, run tests again
5. Commit with descriptive message including test count
6. Deploy: `npm run deploy`
7. Live-verify: curl the changed endpoints
8. Update this file's "Current State" section

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
| Python SDK | PyPI: `headless-oracle` |
| JS Verify SDK | npm: `@headlessoracle/verify` |
| Go SDK | github.com/LembaGang/headless-oracle-go |
| MCP stdio package | npm: `headless-oracle-mcp` |
| Setup tool | npm: `headless-oracle-setup` |
