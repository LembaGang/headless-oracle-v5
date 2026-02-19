# Headless Oracle V5

## Tech Stack
- **Runtime**: Cloudflare Workers (TypeScript)
- **Build/Deploy**: Wrangler (`wrangler.toml`)
- **Crypto**: Ed25519 signing via `@noble/ed25519` + `@noble/hashes`
- **Testing**: Vitest 66-test suite with `@cloudflare/vitest-pool-workers`
- **KV**: Cloudflare KV (`ORACLE_OVERRIDES`) for manual circuit-breaker halts

## Project Structure
- `src/index.ts` — Main worker (all routes, 7-exchange config, signing, fail-closed logic)
- `test/index.spec.ts` — 66 Vitest unit tests covering all routes, all MICs, KV overrides
- `vitest.config.mts` — Points to `wrangler.toml` (NOT wrangler.jsonc — that file is deleted)
- `wrangler.toml` — Worker config + KV namespace binding (`ORACLE_OVERRIDES`)
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
- `GET /v5/keys` — Public key registry in hex format (no auth).
- All other paths → 404. Note: `/v5/status/*` paths hit auth guard first → 401.

## Architecture: Fail-Closed Safety Tiers
- **Tier 0**: KV override check — if `ORACLE_OVERRIDES[mic]` exists and not expired → return HALTED/OVERRIDE
- **Tier 1**: Schedule-based status — compute OPEN/CLOSED from market calendar
- **Tier 2**: If Tier 1 throws — sign and return UNKNOWN/SYSTEM receipt (fail-closed)
- **Tier 3**: If signing itself fails — return unsigned CRITICAL_FAILURE 500 with UNKNOWN status
- Consumers MUST treat UNKNOWN as CLOSED and halt all execution

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
- `npm test` — Run 66-test suite with Vitest (requires `.dev.vars` to be populated)
- `npm run dev` — Local development server
- `npm run deploy` — Deploy to Cloudflare Workers (`wrangler deploy`)

## Key DST Dates 2026
- March 8: US clocks spring forward (EST→EDT) — affects XNYS, XNAS
- March 29: UK/EU clocks spring forward (GMT→BST / CET→CEST) — affects XLON, XPAR
- October 25: UK/EU fall back — affects XLON, XPAR
- November 1: US fall back — affects XNYS, XNAS

## Workflow & Session Context
This project uses `.claude/rules/` for persistent engineering context. Read these at session start:
- `.claude/rules/90_active_priorities.md` — current sprint state and next actions
- `.claude/rules/10_decisions.md` — architectural decisions and their rationale
- `.claude/rules/00_engineering_standards.md` — hard rules for this codebase

Update `90_active_priorities.md` after any significant change.
