# Headless Oracle V5 — Operator Runbook

**For**: Anyone operating, maintaining, or taking over the Headless Oracle system.
**Last updated**: February 2026
**Owner**: See business handover document for contact details.

---

## Table of Contents
1. [System Overview](#1-system-overview)
2. [Deploying the Worker (API)](#2-deploying-the-worker-api)
3. [Deploying the Frontend](#3-deploying-the-frontend)
4. [Managing API Keys](#4-managing-api-keys)
5. [Configuring Rate Limiting](#5-configuring-rate-limiting)
6. [Circuit Breaker — Emergency Market Halts](#6-circuit-breaker--emergency-market-halts)
7. [Ed25519 Key Rotation](#7-ed25519-key-rotation)
8. [Running Tests](#8-running-tests)
9. [Monitoring and Alerts](#9-monitoring-and-alerts)
10. [Common Incidents and Fixes](#10-common-incidents-and-fixes)
11. [Credentials Reference](#11-credentials-reference)

---

## 1. System Overview

Headless Oracle is a **Cloudflare Workers** edge API that provides cryptographically signed market
status attestations for 7 global exchanges. Consumers (DeFi bots, RWA protocols) call the API before
executing trades to verify whether markets are open or closed.

### Architecture
```
Client → Cloudflare WAF (rate limiting) → Worker (headless-oracle-v5)
                                               │
                              ┌────────────────┼────────────────┐
                              ▼                ▼                ▼
                         KV Override     Schedule Logic    Ed25519 Signer
                        (ORACLE_OVERRIDES)  (IANA tz)     (noble/ed25519)
```

### The 4-Tier Fail-Closed Logic (in order):
1. **KV Override** — operator-set halt (e.g. circuit breaker) → returns HALTED
2. **Schedule Computation** — IANA timezone schedule → returns OPEN or CLOSED
3. **UNKNOWN fallback** — if schedule computation fails → returns UNKNOWN (treat as CLOSED)
4. **CRITICAL_FAILURE** — if signing fails → returns unsigned 500 error

**Consumers MUST treat UNKNOWN as CLOSED. This is enforced by contract in the Terms of Service.**

### Supported Exchanges (ISO 10383 MIC codes)
| MIC   | Exchange              | Timezone                  |
|-------|-----------------------|---------------------------|
| XNYS  | NYSE                  | America/New_York          |
| XNAS  | NASDAQ                | America/New_York          |
| XLON  | London Stock Exchange | Europe/London             |
| XJPX  | Tokyo Stock Exchange  | Asia/Tokyo                |
| XPAR  | Euronext Paris        | Europe/Paris              |
| XHKG  | Hong Kong Exchange    | Asia/Hong_Kong            |
| XSES  | Singapore Exchange    | Asia/Singapore            |

### Live URLs
- **API**: `https://headless-oracle-v5.mmsebenzi-oracle.workers.dev`
- **Frontend**: `https://headlessoracle.com`
- **GitHub (Worker)**: `https://github.com/LembaGang/headless-oracle-v5`
- **GitHub (Frontend)**: `https://github.com/LembaGang/headless-oracle-web`

---

## 2. Deploying the Worker (API)

### Prerequisites
- Node.js 18+ installed
- Wrangler CLI installed (`npm install -g wrangler`)
- Cloudflare account access (see credentials reference)

### One-command deploy
```bash
cd C:/Users/User/headless-oracle-v5
npm run deploy
# This runs: wrangler deploy
```

### What gets deployed
- `src/index.ts` — the entire Worker logic (compiled by wrangler)
- Environment variables from `wrangler.toml` (non-secret vars only)
- KV namespace binding (`ORACLE_OVERRIDES`)
- Secrets are already stored in Cloudflare — they persist across deployments

### After deploying, verify it works
```bash
curl https://headless-oracle-v5.mmsebenzi-oracle.workers.dev/v5/demo
# Should return a JSON receipt with status, signature, receipt_id
```

### Important: Secrets are separate from deployment
Secrets (API keys, private key) are stored in Cloudflare and DO NOT live in the repo.
If you add a new secret, use `wrangler secret put SECRET_NAME`.
If you're on a new machine, you'll need to run `wrangler login` first.

---

## 3. Deploying the Frontend

**CRITICAL**: The frontend does NOT use Cloudflare Pages' automatic git integration.
**Pushing to GitHub DOES NOT update the live site.**
You MUST run the deploy command manually.

```bash
cd C:/Users/User/headless-oracle-web
npm run deploy
# This runs: npm run build && npx wrangler pages deploy dist --project-name headless-oracle-web
```

### Pages structure
| File            | URL path            | Purpose                              |
|-----------------|---------------------|--------------------------------------|
| `index.html`    | `/`                 | Homepage + live demo                 |
| `docs.html`     | `/docs`             | Full API documentation               |
| `status.html`   | `/status`           | Live status dashboard (all 7 MICs)   |
| `verify.html`   | `/verify`           | Client-side Ed25519 receipt verifier |
| `terms.html`    | `/terms`            | Terms of Service                     |
| `privacy.html`  | `/privacy`          | Privacy Policy                       |
| `public/llms.txt` | `/llms.txt`       | AI agent terms                       |

### llms.txt sync rule
`llms.txt` in the repo root and `public/llms.txt` must always be identical.
If you edit one, copy to the other before deploying:
```bash
cp llms.txt public/llms.txt
```

### Adding a new page
1. Create `.html` file in the project root
2. Register it in `vite.config.js` under `build.rollupOptions.input`
3. Run `npm run deploy`

---

## 4. Managing API Keys

### Key types
| Key                | Purpose                              | Where stored                    |
|--------------------|--------------------------------------|---------------------------------|
| `MASTER_API_KEY`   | Full access to `/v5/status`          | Cloudflare Secrets              |
| `BETA_API_KEYS`    | Beta user access to `/v5/status`     | Cloudflare Secrets (CSV string) |
| `ED25519_PRIVATE_KEY` | Signs all receipts              | Cloudflare Secrets              |

### Adding a new beta user
```bash
cd C:/Users/User/headless-oracle-v5

# 1. Get current beta keys (you'll need to know what they are — keep a record)
# 2. Run this command and enter the new comma-separated list:
wrangler secret put BETA_API_KEYS
# When prompted, enter: existing_key_1,existing_key_2,new_user_key
# Press Enter, then Ctrl+D (Mac/Linux) or Ctrl+Z then Enter (Windows)

# 3. Redeploy to pick up the new secret
wrangler deploy
```

**Note**: Wrangler does not support reading existing secrets — always maintain your own record of
active beta keys. See the credentials reference (Section 11).

### Revoking a beta user
Same process — run `wrangler secret put BETA_API_KEYS` and omit the key you want to revoke.

### Rotating the master API key
```bash
wrangler secret put MASTER_API_KEY
# Enter the new key
wrangler deploy
```
Then notify any clients using the master key of the new value.

---

## 5. Configuring Rate Limiting

Rate limiting is configured in the **Cloudflare Dashboard**, NOT in `wrangler.toml`.

### Dashboard path
```
Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Settings → Rate Limiting
```

### Recommended rules (add before HN launch — March 10)

| Route          | Limit             | Action      | Notes                        |
|----------------|-------------------|-------------|------------------------------|
| `/v5/demo*`    | 100 req/min per IP | Block (429) | Public demo endpoint         |
| `/v5/schedule*`| 60 req/min per IP  | Block (429) | Market calendar              |
| `/v5/exchanges`| 60 req/min per IP  | Block (429) | Exchange listing             |
| `/v5/keys`     | 60 req/min per IP  | Block (429) | Public key discovery         |

**Do NOT add a rate limit rule for `/v5/status`** — it is already protected by API key auth.

### How to add a rule
1. Go to the Dashboard path above
2. Click **Add Rule**
3. Set: **Path** matches `/v5/demo*` (use wildcard for prefix match)
4. Set: **Rate** = 100 requests per 60 seconds
5. Set: **Action** = Block (returns 429 Too Many Requests)
6. Set: **Characteristic** = IP Address
7. Click **Save**
8. Repeat for other routes

---

## 6. Circuit Breaker — Emergency Market Halts

The KV namespace `ORACLE_OVERRIDES` allows you to manually halt a market signal without
redeploying code. Use this during NYSE circuit breakers, exchange outages, or any situation
where you need to override the schedule.

### Setting a halt

```
Cloudflare Dashboard → Workers & Pages → KV → ORACLE_OVERRIDES
```

**Key**: The MIC code, e.g. `XNYS`
**Value** (JSON):
```json
{
  "status": "HALTED",
  "reason": "NYSE circuit breaker L1 triggered",
  "expires": "2026-03-09T20:00:00Z"
}
```

The `expires` field is optional but strongly recommended. Without it, the halt persists indefinitely
until you delete the key.

### Clearing a halt
Delete the key in the KV namespace. The Worker will revert to schedule-based status immediately.

### Via Wrangler CLI (alternative)
```bash
# Set halt
wrangler kv key put --binding ORACLE_OVERRIDES XNYS '{"status":"HALTED","reason":"Circuit breaker","expires":"2026-03-09T20:00:00Z"}'

# Clear halt
wrangler kv key delete --binding ORACLE_OVERRIDES XNYS
```

### Valid MIC codes: XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES

---

## 7. Ed25519 Key Rotation

Keys should be rotated if:
- The private key is compromised
- Annually for good security hygiene
- On sale/transfer of the business

### Step 1: Generate a new keypair
```bash
cd C:/Users/User/headless-oracle-v5
node gen_keys.js
# Outputs: new private key (hex) and public key (hex)
```

### Step 2: Choose a new key ID
Format: `key_YYYY_vN`, e.g. `key_2027_v1`

### Step 3: Update the Worker secret
```bash
wrangler secret put ED25519_PRIVATE_KEY
# Enter the new private key hex
```

### Step 4: Update wrangler.toml
```toml
[vars]
PUBLIC_KEY_ID = "key_2027_v1"   # increment version
```

### Step 5: Update the public key files
- `headless-oracle-web/public/ed25519-public-key.txt` — update with new public key hex
- `headlessoracle.com/llms.txt` — update `public_key` field

### Step 6: Deploy both projects
```bash
cd C:/Users/User/headless-oracle-v5 && wrangler deploy
cd C:/Users/User/headless-oracle-web && npm run deploy
```

### Step 7: Archive old key
Store the old private key in a secure offline location for receipt audit purposes.
Old receipts signed with the old key remain verifiable as long as the old public key is preserved.

---

## 8. Running Tests

```bash
cd C:/Users/User/headless-oracle-v5
npm test
# Runs 66 tests in Miniflare (real Cloudflare Workers runtime)
# All 66 must pass before deploying
```

### Test environment setup
Tests require `.dev.vars` in the project root with a **test-only** Ed25519 keypair:
```
ED25519_PRIVATE_KEY=ae0bbb58025719e317bc2eb6e0a31d59f8cd61bcbf011132750a61a1ecd1b872
ED25519_PUBLIC_KEY=f8af78f563e8aa698b35b0b2511cd430a8c4aa6f7960534bb2b7e22d9b4a3fb8
PUBLIC_KEY_ID=key_test_v1
MASTER_API_KEY=test_master_key_local_only
BETA_API_KEYS=test_beta_key_1,test_beta_key_2
```

**These are test-only keys. The production private key is in Cloudflare Secrets and never in the repo.**

### What the tests cover
- All 7 MIC codes return valid receipts with correct structure
- `/v5/demo` returns signed receipt without auth
- `/v5/status` returns 401 without valid API key
- `/v5/status` returns 200 with valid master or beta key
- `/v5/schedule` and `/v5/exchanges` return correct data
- `/v5/keys` returns correct public key
- KV circuit breaker overrides work correctly
- UNKNOWN_MIC returns 400 with correct error
- UUID uniqueness and timestamp freshness

---

## 9. Monitoring and Alerts

### Cloudflare Dashboard
```
Workers & Pages → headless-oracle-v5 → Metrics
```
Shows: requests/sec, error rates, CPU time, response times.

### Setting up email alerts
```
Cloudflare Dashboard → Notifications → Create Notification
Type: Workers Usage (set threshold for 4xx/5xx rate)
```

### Manual health check
```bash
# Should return 200 with signed JSON receipt
curl https://headless-oracle-v5.mmsebenzi-oracle.workers.dev/v5/demo

# Should return 401 (no key)
curl https://headless-oracle-v5.mmsebenzi-oracle.workers.dev/v5/status/XNYS

# Should return list of exchanges
curl https://headless-oracle-v5.mmsebenzi-oracle.workers.dev/v5/exchanges
```

---

## 10. Common Incidents and Fixes

### Incident: Site not updating after code change
**Symptom**: Changes pushed to GitHub but headlessoracle.com shows old version.
**Cause**: Cloudflare Pages uses MANUAL deploy, not git CI.
**Fix**: `cd C:/Users/User/headless-oracle-web && npm run deploy`

### Incident: Worker returning 500 errors
**Symptom**: `/v5/demo` or `/v5/status` returns 500 CRITICAL_FAILURE.
**Cause**: Ed25519 signing failed — likely the `ED25519_PRIVATE_KEY` secret is missing or corrupted.
**Fix**:
```bash
wrangler secret put ED25519_PRIVATE_KEY
# Re-enter the production private key
wrangler deploy
```

### Incident: All tests failing with ORACLE_TIER_1_FAILURE
**Symptom**: Tests crash with "Cannot read properties of undefined (reading 'length')".
**Cause**: `.dev.vars` file is missing or missing the Ed25519 test key.
**Fix**: Ensure `.dev.vars` exists with the test-only keypair (see Section 8).

### Incident: Need to emergency-halt an exchange
**Fix**: Use the KV circuit breaker (Section 6). No redeployment required.

### Incident: A beta user reports their API key stopped working
**Cause**: A `wrangler secret put BETA_API_KEYS` update may have omitted their key.
**Fix**: Re-add their key to the BETA_API_KEYS secret (Section 4).

### Incident: Wrangler CLI not authenticated
**Symptom**: `wrangler deploy` fails with auth error.
**Fix**: `wrangler login` — opens browser for Cloudflare OAuth.

---

## 11. Credentials Reference

**IMPORTANT**: This section lists WHERE credentials are stored, not the credentials themselves.
Actual secret values are stored in Cloudflare Secrets and in a secure offline record.

| Credential            | Location                                        | Notes                              |
|-----------------------|-------------------------------------------------|------------------------------------|
| `ED25519_PRIVATE_KEY` | Cloudflare Secrets (headless-oracle-v5)         | Production signing key — never in repo |
| `MASTER_API_KEY`      | Cloudflare Secrets (headless-oracle-v5)         | Full /v5/status access             |
| `BETA_API_KEYS`       | Cloudflare Secrets (headless-oracle-v5)         | Comma-separated list of beta keys  |
| Cloudflare account    | cloudflare.com — login via email                | See handover document              |
| GitHub repos          | github.com/LembaGang                           | Two repos: v5 and web              |
| Domain (headlessoracle.com) | Cloudflare Domains (same account)        | DNS + Pages routing managed here   |
| Production keypair PEM | `C:/Users/User/headless-oracle-v5/oracle_private_key_v1.pem` | KEEP SECURE — offline backup |

### Quick production key reference
- **Public key (hex)**: `03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178`
- **Key ID**: `key_2026_v1`
- **Algorithm**: Ed25519 (PKCS#8 PEM on disk, hex in Cloudflare Secret)
