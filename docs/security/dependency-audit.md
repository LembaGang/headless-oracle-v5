# Dependency Audit

Last updated: 2026-04-08

## Production Dependencies (3 packages)

All production dependencies use permissive licenses (MIT, 0BSD).

| Package | Version | License | Purpose |
|---------|---------|---------|---------|
| @noble/ed25519 | 3.0.0 | MIT | Ed25519 signing |
| @noble/hashes | 2.0.1 | MIT | SHA-512 for Ed25519 |
| @supabase/supabase-js | 2.95.3 | MIT | Database client |

## npm audit Results

### Resolved
- picomatch (high) — fixed via `npm audit fix`
- rollup (high) — fixed via `npm audit fix`
- vite (high) — fixed via `npm audit fix`

### Remaining (devDependencies only — not in production)

| Package | Severity | Impact | Notes |
|---------|----------|--------|-------|
| undici 7.x | high | WebSocket overflow, request smuggling | Transitive dep of miniflare/wrangler. Dev-only — used by test runner. Not deployed to Cloudflare Workers. |
| miniflare | high | Depends on vulnerable undici | Dev-only test runtime. Not in production bundle. |
| wrangler | high | Depends on vulnerable miniflare | CLI deployment tool. Not in production bundle. |
| @cloudflare/vitest-pool-workers | high | Depends on vulnerable miniflare+wrangler | Test framework adapter. Not in production bundle. |

**Risk assessment:** All remaining vulnerabilities are in devDependencies
used only for local testing and CI. The production Cloudflare Worker
bundle contains zero vulnerable packages. Fix requires a breaking
version upgrade of `@cloudflare/vitest-pool-workers` — will resolve when
Cloudflare publishes a patched version.

## Production Bundle Analysis

The deployed Worker bundle (228 KB gzip) contains only:
- Application code (src/index.ts)
- @noble/ed25519 (pure JS, audited)
- @noble/hashes (pure JS, audited)
- @supabase/supabase-js (network client)

No native modules. No filesystem access. No child process spawning.
The Cloudflare Workers runtime provides its own HTTP stack (not undici).
