# Headless Oracle V5

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

## Supported Exchanges (7 total)
| MIC   | Exchange                         | Timezone            |
|-------|----------------------------------|---------------------|
| XNYS  | New York Stock Exchange          | America/New_York    |
| XNAS  | NASDAQ                           | America/New_York    |
| XLON  | London Stock Exchange            | Europe/London       |
| XJPX  | Japan Exchange Group (Tokyo)     | Asia/Tokyo          |
| XPAR  | Euronext Paris                   | Europe/Paris        |
| XHKG  | Hong Kong Exchanges and Clearing | Asia/Hong_Kong      |
| XSES  | Singapore Exchange               | Asia/Singapore      |

DST is handled automatically via IANA timezone names in `Intl.DateTimeFormat`. No hardcoded UTC offsets anywhere.

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

## Scaling Reminder
When ORACLE_TELEMETRY daily unique clients approaches 100/day, add cursor pagination to the 17:00 cron's KV list() call. Current implementation silently truncates at 1,000 keys. The fix is a list_complete cursor loop. Check metrics weekly via /v5/metrics endpoint (to be built) or Cloudflare KV dashboard.

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

## Workflow & Session Context
This project uses `.claude/rules/` for persistent engineering context. Read these at session start:
1. `.claude/rules/05_strategic_vision.md` — north star, decision filters, why this matters
2. `.claude/rules/90_active_priorities.md` — current sprint state and next actions
3. `.claude/rules/10_decisions.md` — architectural decisions and their rationale
4. `.claude/rules/00_engineering_standards.md` — hard rules for this codebase

Update `90_active_priorities.md` after any significant change.
