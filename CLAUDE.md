# Headless Oracle V5

## Tech Stack
- **Runtime**: Cloudflare Workers (TypeScript)
- **Build/Deploy**: Wrangler (`wrangler.toml`)
- **Database**: Supabase (via `@supabase/supabase-js`)
- **Crypto**: Ed25519 signing (Web Crypto API) for liability receipts
- **Testing**: Vitest with `@cloudflare/vitest-pool-workers`

## Project Structure
- `src/index.ts` — Main worker entrypoint (fetch handler with routes)
- `src/v5_crypto.ts` — Ed25519 receipt signing logic (`signReceipt`, `LiabilityReceipt`)
- `wrangler.toml` — Worker config (name: `headless-oracle-v5`, vars: `PUBLIC_KEY_ID`, `CURRENT_TERMS_VERSION`)

## Routes
- `GET /v5/demo` — Health/demo endpoint (no auth)
- `GET /v5/status?mic=<MIC_CODE>` — Market status query (requires `X-Oracle-Key` header)
- All other paths return 404

## Secrets (via `wrangler secret`)
- `ED25519_PRIVATE_KEY` — PEM-encoded Ed25519 private key for receipt signing
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_KEY` — Supabase service/anon key

## Commands
- `npm run dev` — Local development server
- `npm run deploy` — Deploy to Cloudflare Workers (`wrangler deploy`)
- `npm test` — Run tests with Vitest
