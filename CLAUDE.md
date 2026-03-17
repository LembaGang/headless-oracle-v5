# Headless Oracle V5

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

## Tech Stack
- **Runtime**: Cloudflare Workers (TypeScript)
- **Build/Deploy**: Wrangler (`wrangler.toml`)
- **Crypto**: Ed25519 signing via `@noble/ed25519` + `@noble/hashes`
- **Testing**: Vitest 112-test suite with `@cloudflare/vitest-pool-workers`
- **KV**: Three Cloudflare KV namespaces — `ORACLE_OVERRIDES` (circuit-breaker halts), `ORACLE_API_KEYS` (paid key cache), `ORACLE_TELEMETRY` (MCP client analytics)

## Project Structure
- `src/index.ts` — Main worker (all routes, 7-exchange config, signing, fail-closed logic)
- `test/index.spec.ts` — 184 Vitest unit tests covering all routes, all MICs, KV overrides, holiday guard, lunch breaks, health endpoint, MCP tools, billing, MCP client telemetry
- `vitest.config.mts` — Points to `wrangler.toml` (NOT wrangler.jsonc — that file is deleted)
- `wrangler.toml` — Worker config + KV namespace bindings (`ORACLE_OVERRIDES`, `ORACLE_API_KEYS`, `ORACLE_TELEMETRY`)
- `.dev.vars` — Local dev/test secrets (test-only keypair, NOT production keys)

## Supported Exchanges (23 total)
| MIC   | Exchange                         | Timezone            |
|-------|----------------------------------|---------------------|
| XNYS  | New York Stock Exchange          | America/New_York    |
| XNAS  | NASDAQ                           | America/New_York    |
| XLON  | London Stock Exchange            | Europe/London       |
| XJPX  | Japan Exchange Group (Tokyo)     | Asia/Tokyo          |
| XPAR  | Euronext Paris                   | Europe/Paris        |
| XHKG  | Hong Kong Exchanges and Clearing | Asia/Hong_Kong      |
| XSES  | Singapore Exchange               | Asia/Singapore      |
| XASX  | Australian Securities Exchange   | Australia/Sydney    |
| XBOM  | BSE India (Bombay Stock Exchange) | Asia/Kolkata       |
| XNSE  | NSE India (National Stock Exchange) | Asia/Kolkata     |
| XSHG  | Shanghai Stock Exchange (lunch break) | Asia/Shanghai  |
| XSHE  | Shenzhen Stock Exchange (lunch break) | Asia/Shanghai  |
| XKRX  | Korea Exchange                   | Asia/Seoul          |
| XJSE  | Johannesburg Stock Exchange      | Africa/Johannesburg |
| XBSP  | B3 Brazil                        | America/Sao_Paulo   |
| XSWX  | SIX Swiss Exchange               | Europe/Zurich       |
| XMIL  | Borsa Italiana                   | Europe/Rome         |
| XIST  | Borsa Istanbul                   | Europe/Istanbul     |
| XSAU  | Saudi Exchange (Tadawul) — Fri/Sat weekends | Asia/Riyadh |
| XDFM  | Dubai Financial Market — Fri/Sat weekends | Asia/Dubai   |
| XNZE  | New Zealand Exchange             | Pacific/Auckland    |
| XHEL  | Nasdaq Helsinki                  | Europe/Helsinki     |
| XSTO  | Nasdaq Stockholm                 | Europe/Stockholm    |

DST is handled automatically via IANA timezone names in `Intl.DateTimeFormat`. No hardcoded UTC offsets anywhere.

Middle Eastern exchanges (XSAU, XDFM) use `weekends: ['Fri', 'Sat']` — Sunday is a trading day. The `weekends` field in MarketConfig controls per-exchange weekend detection.

## Routes
- `GET /v5/demo?mic=<MIC>` — Public signed receipt (no auth). Default MIC: XNYS.
- `GET /v5/status?mic=<MIC>` — Authenticated signed receipt. Requires `X-Oracle-Key` header.
- `GET /v5/schedule?mic=<MIC>` — Next open/close times in UTC (no auth). Default MIC: XNYS.
- `GET /v5/exchanges` — Directory of all 7 supported exchanges (no auth).
- `GET /v5/keys` — Public key registry in hex format + canonical signing spec (no auth).
- `GET /v5/batch?mics=<MIC,MIC,...>` — Authenticated batch: signed receipts for multiple MICs in one request. Requires `X-Oracle-Key`. Deduplicates, validates all MICs up front, runs in parallel.
- `GET /v5/health` — Signed liveness probe (no auth). Distinguishes Oracle-down from market-UNKNOWN.
- `GET /.well-known/oracle-keys.json` — RFC 8615 key discovery URI (no auth). Active signing key + lifecycle metadata.
- `GET /openapi.json` — OpenAPI 3.1 machine-readable spec (no auth).
- `POST /mcp` — MCP Streamable HTTP (JSON-RPC 2.0, protocol `2024-11-05`, no auth). Tools: `get_market_status`, `get_market_schedule`, `list_exchanges`.
- All other paths → 404. Note: `/v5/status/*` paths hit auth guard first → 401.

## Architecture: Fail-Closed Safety Tiers
- **Tier 0**: KV override check — if `ORACLE_OVERRIDES[mic]` exists and not expired → return HALTED/OVERRIDE
- **Tier 1**: Schedule-based status — compute OPEN/CLOSED from market calendar
- **Tier 2**: If Tier 1 throws — sign and return UNKNOWN/SYSTEM receipt (fail-closed)
- **Tier 3**: If signing itself fails — return unsigned CRITICAL_FAILURE 500 with UNKNOWN status
- Consumers MUST treat UNKNOWN as CLOSED and halt all execution

## KV Namespaces

| Binding | Purpose | Key Pattern |
|---|---|---|
| `ORACLE_OVERRIDES` | Manual circuit-breaker market halts — **MIC codes only** | `XNYS`, `XNAS`, etc. |
| `ORACLE_API_KEYS` | Paid API key cache (sha256 → plan/status) | `{sha256(key)}` |
| `ORACLE_TELEMETRY` | MCP client analytics (privacy-safe, hashed IPs) | `mcp_clients:{YYYY-MM-DD}:{sha256(ip)}` |

**ORACLE_OVERRIDES must never contain telemetry data.** Operators scan it for active circuit breakers.

## Scaling Reminders
When ORACLE_TELEMETRY daily unique clients approaches 100/day, add cursor pagination to the 17:00 cron's KV list() call. Current implementation silently truncates at 1,000 keys. The fix is a list_complete cursor loop. Check metrics weekly via /v5/metrics endpoint or Cloudflare KV dashboard.

When daily unique MCP clients approaches 100, refactor /v5/metrics to read a pre-aggregated `metrics:{date}` key written by the 17:00 cron instead of fanning out list()+get() at request time. Current implementation reads all today's client keys on every request — acceptable at low volume, latency cliff at scale.

When paid x402 requests approach 100/day: cache verified Base mainnet tx receipts server-side to eliminate repeated RPC round-trips. Current implementation makes 2 sequential RPC calls per paid request (eth_getTransactionReceipt + eth_getBlockByNumber). At scale this adds latency tail. Fix: maintain a server-side cache of verified txHashes with 300s TTL in ORACLE_TELEMETRY KV.

When daily unique MCP clients approaches 100: add cursor pagination to the 17:00 cron KV list() call — current implementation silently truncates at 1,000 keys.

When daily unique MCP clients approaches 100: refactor /v5/metrics to read a pre-aggregated metrics:{date} key written by the 17:00 cron instead of fanning out list()+get() per request.

When telemetry integrity matters commercially (e.g. billing disputes, audit requirements): add X-Proxy-Token shared secret validation in the headlessoracle proxy Worker and verify it in headless-oracle-v5 handleMcp before trusting X-Original-* headers. Currently X-Original-* headers can be spoofed by any direct caller.

## Circuit Breaker Overrides (KV)
Set via Cloudflare Dashboard → Workers & Pages → KV → ORACLE_OVERRIDES:
- Key: MIC code (e.g. `XNYS`)
- Value: `{"status":"HALTED","reason":"NYSE circuit breaker L1","expires":"2026-03-09T20:00:00Z"}`
- Delete the key to revert to schedule-based operation. Expired overrides are ignored automatically.

## API Key Gating
- `/v5/status` requires `X-Oracle-Key` header
- Validates against `MASTER_API_KEY` and comma-separated `BETA_API_KEYS`
- Missing key → 401 `API_KEY_REQUIRED`
- Invalid key → 403 `INVALID_API_KEY`
- All other routes are public (no auth)

## Secrets (Cloudflare — via `wrangler secret put`)
- `ED25519_PRIVATE_KEY` — Hex-encoded 32-byte Ed25519 private key (production signing key)
- `ED25519_PUBLIC_KEY` — Hex-encoded Ed25519 public key (served via /v5/keys)
- `MASTER_API_KEY` — Primary API key for /v5/status
- `BETA_API_KEYS` — Comma-separated beta user API keys

## .dev.vars (local test only — NOT production keys)
- `ED25519_PRIVATE_KEY` / `ED25519_PUBLIC_KEY` — Test-only keypair for miniflare signing
- `MASTER_API_KEY=test_master_key_local_only`
- `BETA_API_KEYS=test_beta_key_1,test_beta_key_2`

## Commands
- `npm test` — Run 184-test suite with Vitest (requires `.dev.vars` to be populated)
- `npm run dev` — Local development server
- `npm run deploy` — Deploy to Cloudflare Workers (`wrangler deploy`)

## Key DST Dates 2026
- March 8: US clocks spring forward (EST→EDT) — affects XNYS, XNAS
- March 29: UK/EU clocks spring forward (GMT→BST / CET→CEST) — affects XLON, XPAR
- October 25: UK/EU fall back — affects XLON, XPAR
- November 1: US fall back — affects XNYS, XNAS

## Strategic North Star
This project is building the signed market-state primitive for AI agent infrastructure.
The analogy is a DNS root server — not a product, a layer of the internet.
Primary consumer in 18 months: autonomous agents, not human developers.

**Decision filter for every interface, schema, and architecture choice:**
> "Can an agent consume this without asking a follow-up question?" If no, it's not done.

**Standing instruction:** At the end of any significant change, name one gap the current
architecture does not yet solve that will matter when agent consumption scales.

Full strategic context: `.claude/rules/05_strategic_vision.md`

## Ecosystem Artefacts (Mar 15 2026)

| Artefact | Location | Status |
|---|---|---|
| Halt Simulator | `github.com/LembaGang/halt-simulator` | Live — 31/31 tests passing |
| Agent Pre-Trade Safety Standard | `docs/agent-safety-standard/STANDARD.md` | Public draft v1.0.0 — Apache 2.0 |
| SMA Protocol Specification | `docs/sma-spec.md` | v1.0.0 — Apache 2.0 |
| ERC-8183 Evaluator Spec | `docs/erc-8183-evaluator-spec.md` | Draft — for Virtuals + EF dAI submission |
| Python SDK | PyPI: `headless-oracle` v0.1.0 (published Mar 2) | `pip install headless-oracle` — includes `OracleClient`, `verify()`, LangChain tool, CrewAI tool |

**Halt Simulator:** Streamlit app (`app.py`) — 4 scenarios (DST US/UK, circuit breaker L1, exchange holiday), 5 position parameters, side-by-side naive bot vs safe bot comparison, live oracle toggle, loss breakdown + annual exposure charts. Run: `streamlit run app.py`.

**Agent Pre-Trade Safety Standard:** Vendor-neutral 6-check checklist (fetch signed attestation → verify circuit breakers → verify settlement window → verify TTL → verify Ed25519 signature → halt on any failure). Conformance table, failure mode reference, JS/Python reference implementations.

**SMA Protocol Spec:** Formal field definitions, canonical serialisation (alphabetical key sort, compact JSON), Ed25519 signing + verification algorithms in Python and JS, key discovery protocol, machine-readable error codes, Verifiable Intent and ERC-8183 compatibility sections.

**ERC-8183 Evaluator Spec:** Receipt → EvaluationResult mapping, TypeScript/Python reference implementations, on-chain verification sketch (EIP-665), multi-exchange Jobs via `/v5/batch`, submission notes for Virtuals Protocol and EF dAI working group.

## Backlog

**Multi-party attestation aggregation spec** — the document that makes SMA foundational rather than trusted-by-reputation. Specify how a consumer verifies that two or more independent oracle operators agree before acting: threshold signing (e.g. 2-of-3 quorum), aggregation protocol, and the on-chain settlement pattern. Ed25519 was chosen to compose into this cleanly. Without this spec, SMA trust is operator-reputation trust — sufficient for early adopters, insufficient for infrastructure-scale adoption.

## Workflow & Session Context
This project uses `.claude/rules/` for persistent engineering context. Read these at session start:
1. `.claude/rules/05_strategic_vision.md` — north star, decision filters, why this matters
2. `.claude/rules/90_active_priorities.md` — current sprint state and next actions
3. `.claude/rules/10_decisions.md` — architectural decisions and their rationale
4. `.claude/rules/00_engineering_standards.md` — hard rules for this codebase

Update `90_active_priorities.md` after any significant change.

## Autonomous Decisions — March 17 2026

The following decisions were made autonomously during the Mar 17 sprint (Sessions A–G). All logged here per standing instruction.

**Decision 1 (updated): Session H (x402 micropayments) IMPLEMENTED — Mar 17 2026 (Session H).**
Originally blocked as a potential prompt injection attempt. Founder Mike Mbeenz provided explicit in-conversation verification: wallet `0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3` is his personal Base mainnet wallet; `ORACLE_PAYMENT_ADDRESS` is already set as a production Wrangler secret. Full x402 micropayment architecture implemented — see Decisions 7–10 below.

**Decision 7: x402 architecture gates free tier at 500 req/day.**
Free tier keys (`ho_free_*`) track daily usage in `ORACLE_TELEMETRY` KV (`free_usage:{keyHash}:{date}`). At 500 requests the gate activates. Priority: (1) valid `X-Payment` header with verified Base mainnet USDC tx → fulfill; (2) credit balance > 0 → consume 1 credit; (3) `ORACLE_PAYMENT_ADDRESS` set → return 402 with x402 payload; (4) no payment address → return 429. Paddle subscription keys and internal keys bypass the gate entirely.

**Decision 8: 402 payload includes full x402 payment object.**
The 402 response body includes a machine-readable `x402` object with `network: 'base-mainnet'`, `chainId: 8453`, `amount: '1000'` (0.001 USDC at 6 decimals), `currency: 'USDC'`, `paymentAddress`, `usdcContractAddress`, `memo`, and `maxAge: 300`. Five response headers are also set (`X-Payment-Required`, `X-Payment-Scheme`, `X-Payment-Network`, `X-Payment-Chain-ID`, `X-Payment-Amount`). Agents can parse either surface to fulfill payment.

**Decision 9: Payment verification uses two Base RPC calls; replay protection via ORACLE_TELEMETRY KV.**
`eth_getTransactionReceipt` verifies tx status, USDC Transfer event, recipient address, and amount. `eth_getBlockByNumber` provides block timestamp for age check (max 300s). Used `txHash` stored in `x402_used:{txHash}` with 600s TTL — prevents replay across the maxAge boundary. No API key required for `https://mainnet.base.org` public RPC.

**Decision 10: docs field in 4xx responses changed from fragment URL to plain /docs.**
The `json()` helper was producing `docs: "https://headlessoracle.com/docs#${errorCode}"` but those anchors do not exist on the docs page. Changed to `"https://headlessoracle.com/docs"` which is a real working URL. The agent-friendly machine-readable endpoint approach (`GET /v5/errors/{code}`) was considered but deferred — the gap is noted. Test updated accordingly. Backward-compatible: consumers were not relying on the fragment value.

**Decision 2: GET /mcp returns server info (200), not 405.**
The original `GET /mcp → 405` test was updated to `GET /mcp → 200 server info`. Rationale: MCP clients use GET to discover server capabilities before POSTing. A 405 on GET is a discoverability failure. The server info response (`name`, `version`, `protocol`, `sma_compliant`, `tools`, `authentication`) gives agents everything they need to decide whether to integrate — zero ambiguity.

**Decision 3: `docs` field auto-appended to all 4xx errors via the `json()` helper.**
Rather than adding `docs` manually to each error response, the `json()` helper auto-appends it to any response with `status >= 400 && < 500` that has a string `error` field. The docs URL format is `https://headlessoracle.com/docs#{errorCode}`. This is a silent backward-compatible additive change — no existing consumers break. Agents can now recover from any 4xx error by following the docs link.

**Decision 4: SMA Protocol RFC uses 60s TTL for market receipts specifically.**
The RFC (Section 3.4) specifies that `expires_at = issued_at + 60s` for market state, but allows domain-specific TTLs subject to constraints. This preserves flexibility for future domains (e.g. regulatory status might warrant 5-minute TTLs) without weakening the market state guarantee.

**Decision 5: Integration guides created for 7 frameworks (Sessions D).**
LangGraph, AutoGen, CrewAI, Vercel AI SDK, OpenAI Agents SDK, Bun, and Anthropic Claude. Each guide uses the actual Oracle REST API + `@headlessoracle/verify` for JS, or `headless-oracle` Python SDK. No mock patterns — real working code templates. Guides are in `docs/integrations/`.

**Decision 6: Multi-exchange monitor template uses state-change events only.**
`docs/multi-exchange-monitor.ts` fires handlers only when status changes, not on every poll. This avoids downstream noise (every 30s "XNYS is still OPEN" logs) and makes the template usable in production without modification. TTL-awareness (`isConfirmedOpen()` checks `expires_at`) is built in.

## Autonomous Decisions — Sessions I–K (Mar 17–18 2026)

**Decision I-1: DataCamp integration guide created from scratch at `/docs/integrations/datacamp-workspace`.**
No source markdown existed. Content created: `!pip install headless-oracle`, environment variable setup, `safe_market_check()` pattern with `pd.DataFrame`, full notebook cell sequence for safe analysis. URL was sent to Filip Schouwenaars at DataCamp — the page must remain live and correct.

**Decision I-2: x402 Pay-per-use tier added to pricing page as 4th column (between Free Beta and Builder).**
Grid changed from `lg:grid-cols-4` to `lg:grid-cols-5`. Indigo theme to visually distinguish from subscription tiers. "For agents that pay themselves" label. Links to `/docs/x402-payments`. Both the pricing card and the hero badge link to the same docs page for consistency.

**Decision I-3: Hero copy updated: "The only market oracle autonomous agents can pay for themselves."**
Previous copy was generic. The new copy is differentiated and agent-first — it names the x402 capability as the primary differentiator. This is the positioning for the x402 micropayment launch.

**Decision J-1: Cloudflare route pattern `headlessoracle.com/docs/*.md` was rejected (error 10022).**
Cloudflare Workers only allow wildcards at start of hostname or end of path — not mid-path extension matching. Fixed by using 4 specific route entries for the exact `.md` files in use: `/docs/sma-protocol-repo/SPEC.md`, `/docs/agent-safety-standard/STANDARD.md`, `/docs/agent-safety-standard-repo/STANDARD.md`, `/docs/x402-payments.md`. Pages HTML routes (`/docs/*/index.html`) are served by Cloudflare Pages and do not conflict.

**Decision J-2: `/v5/errors/{code}` endpoint added with 12 machine-readable error code definitions.**
Each entry contains `message`, `resolution`, `http_status`, `docs_url`, and `openapi`. Unknown codes return 404 with `available` list. Agents that receive a 4xx error can follow `GET /v5/errors/{ERROR_CODE}` to get a structured recovery path without reading documentation. This closes the agent-recovery loop for all known error codes.

**Decision J-3: EU DST cron triggers added to wrangler.toml and scheduled() handler.**
`0 9 28 3 *` fires March 28 at 09:00 UTC (day before EU spring forward). `0 9 25 10 *` fires October 25 (day before EU fall back). Both log a structured `DST_REMINDER` JSON event to Workers Logs. US DST already had equivalent reminders from a prior session.

**Decision K-1: SMA Protocol and APTS published as standalone Apache 2.0 GitHub repos.**
- `github.com/LembaGang/sma-protocol` — SPEC.md, CONFORMANCE.md, FAQ.md, IMPLEMENTATIONS.md, README.md, LICENSE
- `github.com/LembaGang/agent-pretrade-safety-standard` — STANDARD.md, CHECKLIST.yaml, BADGE.md, CI-INTEGRATION.md, README.md, LICENSE
These are the canonical sources for both standards. agent.json `standards` object, `/v5/compliance` response, and LLMS_TXT all updated to reference GitHub URLs. The old `headlessoracle.com/docs/...` URLs remain functional (served by Worker as embedded markdown) but GitHub is the authoritative canonical URL.

**MCP Directory submission content (human task — founder submits manually):**
For Smithery (smithery.ai/new): use `smithery.yaml` at repo root — already complete.
For mcp.so: use `docs/mcp-listing.md` YAML block — already complete.
Both files reference `https://headlessoracle.com/mcp` as the endpoint, protocol `2024-11-05`, 3 tools.
Update `standards` section to reference: sma_spec `github.com/LembaGang/sma-protocol`, apts `github.com/LembaGang/agent-pretrade-safety-standard`.

## Autonomous Decisions — Sessions L+M (Mar 18 2026)

**Decision L-1: weekends?: string[] field added to MarketConfig interface.**
Middle Eastern exchanges (XSAU, XDFM) use `weekends: ['Fri', 'Sat']` — Sunday is a regular trading day. The field uses `Intl.DateTimeFormat` weekday 'short' abbreviations ('Mon'–'Sun'). Default remains ['Sat', 'Sun'] for all other exchanges. `getScheduleStatus`, `getNextSession`, and `edgeCaseCount` all updated to use per-exchange weekend config.

**Decision L-2: 16 new exchanges added (7 → 23 total).**
XASX (Sydney), XBOM (Mumbai BSE), XNSE (Mumbai NSE), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Seoul), XJSE (Johannesburg), XBSP (São Paulo), XSWX (Zurich), XMIL (Milan), XIST (Istanbul), XSAU (Riyadh), XDFM (Dubai), XNZE (Auckland), XHEL (Helsinki), XSTO (Stockholm). All with 2026+2027 holiday data. XSHG/XSHE have lunchBreak 11:30–13:00 CST.

**Decision L-3: edgeCaseCount refactored for per-exchange weekend computation.**
Old code used `weekendDaysInYear * exchangeCount` (assumed all Sat/Sun). New code computes per-exchange weekend counts using pre-computed `dowCountInYear` map. lunchBreakSessions also updated to use per-exchange trading day count.

**Decision M-1: Autonomous halt monitor runs every minute via cron.**
`runHaltMonitor()` checks exchanges scheduled OPEN against Polygon.io (primary) then Alpaca paper-api (fallback, US-only). Writes REALTIME override to ORACLE_OVERRIDES KV with 2h TTL when discrepancy detected. Fail-open: no false halts on API errors. Auto-clears REALTIME overrides when exchange resumes (does not touch manual operator overrides).

**Decision M-2: 'REALTIME' added to SourceValue type.**
Signed receipts can now carry `source: 'REALTIME'` to distinguish halt-monitor-triggered halts from manual operator overrides (`source: 'OVERRIDE'`). The OpenAPI Source schema enum is updated accordingly.

**Decision M-3: GET /v5/status/realtime added (auth required).**
Returns full signed receipt for the requested MIC plus `halt_monitor.active_realtime_override` (null if no active REALTIME override, populated if halt monitor wrote one). Auth already covered by the `/v5/status` prefix guard.

**Decision M-4: /v5/health includes halt_monitor section.**
`halt_monitor.active_realtime_overrides` lists all MICs with active REALTIME overrides. Populated by checking all MICs in ORACLE_OVERRIDES KV at health check time. Agents can use this to see if the halt monitor has detected any real-time halts before sending a batch query.

## Accuracy Audit — March 17 2026

Full audit performed to update all "7 exchanges" references to "23 exchanges" across both repos and standalone repos.

### Files Changed

**headless-oracle-v5 (worker repo):**
- `src/index.ts` — MCP `initialize` instructions (7→23), OpenAPI health endpoint `exchange_count` example (7→23) + `supported_mics` example expanded to all 23 MICs, compliance `settlement_window` evidence updated to mention all 4 lunch-break exchanges (XJPX/XHKG/XSHG/XSHE), Eid Al-Fitr holidays (XSAU/XDFM), and "all 23 exchanges across 6 regions"
- `smithery.yaml` — complete rewrite: description, all tool descriptions, tool `mic` parameter enums, `supported_exchanges` expanded from 7 to all 23 MICs
- `OPERATOR_RUNBOOK.md` — system overview count + valid MIC list
- `docs/halt-monitor.md` — added coverage note: real-time detection is US-focused (Polygon.io/Alpaca); 22 non-US exchanges use schedule-based detection
- `docs/custom-gpt-action.yaml` — MIC enum lists in 3 operations
- `docs/integrations/autogen.md`, `crewai.md`, `openai-agents.md` — MIC lists in tool descriptions
- `docs/registry-server.json` — description, list_exchanges description
- `docs/mcp-listing.md` — description, list_exchanges description
- `docs/multi-exchange-monitor.ts` — console.log monitoring count
- `docs/rfc-external-state-attestation.md` — exchange count and MIC list
- `docs/sma-protocol-repo/IMPLEMENTATIONS.md` — Headless Oracle implementation row
- `docs/sma-protocol-repo/README.md` — reference implementation description
- `docs/algotrading-community-posts.md`, `algotrading-community-posts-v2.md` — community post copy
- `docs/hn-launch-post.md` — HN launch post copy
- `docs/faq.md` — FAQ answers (including "Why only 7 exchanges?" → "Why 23 exchanges? Why not more?")
- `docs/faq-prepared-answers.md` — prepared technical Q&A answers
- `docs/cursor-setup.md`, `windsurf-config.md` — IDE integration guides
- `llms-install.md` — MCP install guide
- `.cursor-plugin/plugin.json` — plugin description

**headless-oracle-web (web repo):**
- `index.html` — meta description, og:description, JSON-LD (description, featureList, about with 23 orgs, potentialAction), hero paragraph, exchange pill badges expanded from 7 to all 23, edge case section heading, weekend days label, free tier footnote
- `docs.html` — section heading, exchange table expanded from 7 to 23 full rows with hours/timezone/DST, MCP tool descriptions (7→23), /v5/status query hint
- `pricing.html` — 5 occurrences of "7 exchanges" updated
- `status.html` — meta description + footer text
- `public/docs/integrations/datacamp-workspace/index.html` — free tier footnote

**sma-protocol (standalone repo):**
- `IMPLEMENTATIONS.md` — Headless Oracle row exchange list
- `README.md` — reference implementation description

### Updated Smithery Tool Description Text (for manual paste at smithery.ai)

**get_market_status:**
> Returns a cryptographically signed receipt for one exchange indicating whether the market is OPEN, CLOSED, HALTED, or UNKNOWN. Receipt includes Ed25519 signature, 60-second TTL, and receipt_mode. MANDATORY: treat UNKNOWN and HALTED as CLOSED — halt all execution. Covers 23 global exchanges across Americas, Europe, Middle East, Africa, Asia, and Pacific.

**get_market_schedule:**
> Returns next open and close times in UTC for a given exchange. Includes lunch break windows for XJPX (11:30-12:30 JST), XHKG (12:00-13:00 HKT), XSHG and XSHE (11:30-13:00 CST). Not signed — use get_market_status for authoritative signed receipts.

**list_exchanges:**
> Returns all 23 supported exchanges with MIC codes, names, and timezones. Use to discover supported markets before calling get_market_status.

**Supported MIC codes (all 23):**
XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE

## Sprint Log — Sessions Q+R+S (March 17 2026 Evening)

### New Endpoints
- **GET /v5/usage** (auth required) — per-key usage stats: requests today/month, daily/monthly limits, percent used, rate_limit_resets_at, upgrade_url, x402_available, credit_balance. Free keys get real counts; paid keys get null limits and 0 counts.
- **GET /v5/traction** (public) — live metrics snapshot: exchanges_covered, edge_cases_per_year, uptime_since, days_live, mcp_requests_today, unique_mcp_clients_today, sma_spec_version, verifiable_intent_rfc, x402_enabled, halt_monitor.

### Conversion Infrastructure
- **Soft rate-limit warning headers** — at 80% free tier usage: X-RateLimit-Warning + X-RateLimit-Warning-Message + X-RateLimit-Upgrade-URL headers added to /v5/status responses. At 95%: more urgent message.
- **Design partner detection** — when free tier key exceeds 200 req/day, logs DESIGN_PARTNER_CANDIDATE event to Workers Logs once per key per day (KV dedup: `design_partner:{keyHash}:{date}`).
- **Key request email updated** — from `keys@headlessoracle.com` → `mike@headlessoracle.com`. Subject updated. HTML rewritten with founder-personal tone, 4 starting point links, x402 instructions, direct reply CTA.
- **402 response humanised** — `founder_note` field added to all 402 PAYMENT_REQUIRED responses: "You're hitting our limits — that means you're building something real. Reply to hello@headlessoracle.com..."

### Weekly Digest Cron
- Added `0 9 * * 1` (Monday 09:00 UTC) weekly digest cron. Summarises past 7 days of MCP client activity, writes `weekly_digest:{YYYY-WW}` to ORACLE_TELEMETRY KV (90-day TTL).
- **Note**: Cloudflare free plan has 5-cron limit. Merged EU DST reminders (formerly `0 9 28 3 *` and `0 9 25 10 *`) into the `0 9 * * *` daily cron via date-check. Net crons: 4 (`* * * * *`, `0 9 * * *`, `0 17 * * *`, `0 9 * * 1`).

### Outreach Assets
- `docs/outreach/blackskyorg-followup.md` — Wednesday follow-up email for BlackSky.org
- `docs/outreach/cryptosignal-followup.md` — GitHub comment reply to Johnson
- `docs/outreach/google-cloud-operator-post.md` — X/Twitter post for Google Cloud cluster operator
- `docs/investor-one-pager.md` — one-page investor summary
- `docs/design-partner-pitch.md` — 10-slide deck outline for design partner conversations

### URL Audit Results (Task S1)
- `/docs/integrations/datacamp-workspace` — 200 ✓ (content served by Pages)
- `/docs/integrations/bun` — 200 ✓ (content served by Pages)
- `/docs/x402-payments` — 200 ✓ (content served by Pages)
- `/v5/compliance` — 200 ✓ (JSON, correct content)
- `/v5/stack` — 200 ✓ (JSON, correct content)
- `/v5/traction` — 200 ✓ (live, just deployed)
- `/v5/usage` — 401 ✓ (correct — auth required)
- `/docs/rfc` — serves index.html (no dedicated route; the RFC is at /docs/rfc-external-state-attestation)

### Verifiable Intent PR Check (Task S2)
- **PR visible** at github.com/agent-intent/verifiable-intent/pulls — "RFC: Add External State Attestation constraint type for autonomous execution" is live in the PR list.

### Tests
- **357/357 tests passing**
- New tests added: GET /v5/usage (401/403/200/shape), GET /v5/traction (shape/no-auth), soft warning headers (80%/95%/below-80%), 402 founder_note, weekly digest cron KV write.

### Deploy
- Worker Version: 79a18a2f-09ff-4953-841d-52775024c8e7
