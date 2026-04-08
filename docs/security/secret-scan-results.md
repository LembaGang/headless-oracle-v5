# Secret Scan Results

Last updated: 2026-04-08

## Methodology

`gitleaks` was not available in this environment. A manual scan was
performed using:

1. `git log --all` search for committed secret file patterns
   (`.env`, `.pem`, `.key`, `.dev.vars`)
2. `git log -S` search for `PRIVATE_KEY=` patterns in non-source files
3. Manual review of `.gitignore` for secret file exclusions

## Results

### .dev.vars

Never committed to git history. `.gitignore` contains `.dev.vars*`
exclusion. The file contains test-only Ed25519 keypair (not production).

### CI Workflow (.github/workflows/)

Both `test.yml` and `ci.yml` contain test-only Ed25519 keypair values
hardcoded in the workflow. These are:
- `ED25519_PRIVATE_KEY=ae0bbb58...` — **test-only key, NOT production**
- `ED25519_PUBLIC_KEY=f8af78f5...` — **test-only key, NOT production**
- `MASTER_API_KEY=test_master_key_local_only` — **test-only placeholder**

**Assessment:** Safe. These are intentionally non-secret values used
only by the test suite in CI. The production signing key is stored
exclusively in Cloudflare Secrets and never appears in source code.

### Production Secrets Inventory

| Secret | Storage | Rotation Status |
|--------|---------|-----------------|
| ED25519_PRIVATE_KEY | Cloudflare Secrets | Active |
| ED25519_PUBLIC_KEY | Cloudflare Secrets | Active |
| MASTER_API_KEY | Cloudflare Secrets | Active |
| PADDLE_API_KEY | Cloudflare Secrets | Active |
| PADDLE_WEBHOOK_SECRET | Cloudflare Secrets | Active |
| SUPABASE_SERVICE_ROLE_KEY | Cloudflare Secrets | Active |
| RESEND_API_KEY | Cloudflare Secrets | Active |
| CDP_API_KEY_PRIVATE_KEY | Cloudflare Secrets | Active |

### .gitignore Coverage

The `.gitignore` correctly excludes:
- `.dev.vars*` and `.env*`
- `*.pem`, `*.key`, `*.secret`, `*.credentials`
- `Master Key.txt`
- `.mcpregistry_*` tokens
- `.wrangler/` (contains cached credentials)

## Recommendations

1. Install `gitleaks` in CI for automated scanning on every push
2. Consider adding a pre-commit hook to prevent accidental secret commits
3. Rotate the Cloudflare API token shared in conversation on 2026-04-08
