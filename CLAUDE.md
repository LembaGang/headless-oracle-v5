# Headless Oracle V5

## Tech Stack
- **Runtime**: Cloudflare Workers (TypeScript)
- **Build/Deploy**: Wrangler (`wrangler.toml`)
- **Crypto**: Ed25519 signing via `@noble/ed25519` + `@noble/hashes`
- **Testing**: Vitest with `@cloudflare/vitest-pool-workers`

## Project Structure
- `src/index.ts` — Main worker entrypoint (all routes, signing, fail-closed logic)
- `test/index.spec.ts` — Vitest unit tests for all routes
- `wrangler.toml` — Worker config (name: `headless-oracle-v5`, vars: `PUBLIC_KEY_ID`, `CURRENT_TERMS_VERSION`)
- `public/` — Static assets (ed25519-public-key.txt, llms.txt)

## Routes
- `GET /v5/demo` — Public demo endpoint (no auth, returns signed receipt)
- `GET /v5/status?mic=<MIC_CODE>` — Market status query (requires `X-Oracle-Key` header)
- `GET /v5/keys` — Public key endpoint (no auth, returns key registry)
- All other paths return 404

## Architecture: 3-Tier Fail-Closed
- **Tier 1**: Normal operation — compute market status, sign receipt
- **Tier 2**: If Tier 1 fails — sign and return UNKNOWN/SYSTEM receipt (fail-closed)
- **Tier 3**: If signing itself fails — return unsigned CRITICAL_FAILURE with UNKNOWN status
- Consumers MUST treat UNKNOWN as CLOSED (halt execution)

## API Key Gating
- `/v5/status` requires `X-Oracle-Key` header
- Validates against `MASTER_API_KEY` (single key) and `BETA_API_KEYS` (comma-separated list)
- Missing key → 401 `API_KEY_REQUIRED`
- Invalid key → 403 `INVALID_API_KEY`
- `/v5/demo` and `/v5/keys` are ungated (public)

## Secrets (via `wrangler secret put`)
- `ED25519_PRIVATE_KEY` — Hex-encoded Ed25519 private key for receipt signing
- `ED25519_PUBLIC_KEY` — PEM-formatted public key (served via /v5/keys)
- `MASTER_API_KEY` — Primary API key for /v5/status
- `BETA_API_KEYS` — Comma-separated list of beta user API keys

## Commands
- `npm run dev` — Local development server
- `npm run deploy` — Deploy to Cloudflare Workers (`wrangler deploy`)
- `npm test` — Run tests with Vitest
