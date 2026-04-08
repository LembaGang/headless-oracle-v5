# Deployment Guide

Last updated: 2026-04-08

## Overview

Headless Oracle deploys to Cloudflare Workers. Deployments are atomic — zero downtime. The worker runs on 300+ edge locations globally.

## Pre-Deployment Checklist

- [ ] All tests pass: `npm test` (725+ tests)
- [ ] Smoke tests pass: `npm run test:smoke` (11 tests against live production)
- [ ] No npm audit high/critical vulnerabilities in production deps: `npm audit --omit=dev`
- [ ] Changes committed and pushed to main
- [ ] Living documents updated (CLAUDE.md, .claude/rules/90_active_priorities.md)
- [ ] If new routes added: `wrangler.toml` routes updated
- [ ] If new secrets needed: `wrangler secret put {NAME}` completed

## Deploy Command

```bash
npm run deploy
# Equivalent to: wrangler deploy
```

Typical deploy time: 10–30 seconds.

## Post-Deployment Verification

Run these checks immediately after deploy:

```bash
# Health check (signed receipt)
curl -s https://headlessoracle.com/v5/health | jq '.status, .signature'

# Demo receipt (full 4-tier path)
curl -s https://headlessoracle.com/v5/demo?mic=XNYS | jq '.status, .receipt_mode'

# MCP endpoint
curl -s -X POST https://headlessoracle.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'

# Discovery files
curl -s https://headlessoracle.com/llms.txt | head -1
curl -s https://headlessoracle.com/.well-known/oracle-keys.json | jq '.keys[0].key_id'

# Full smoke suite
npm run test:smoke
```

## Deployment History

All deployments are tracked in Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Deployments.

Cloudflare retains recent deployment versions for instant rollback.

## Environment Variables

Set in `wrangler.toml` `[vars]` section (non-secret):
- `TEST_COUNT`, `PUBLIC_KEY_VALID_FROM`, `ED25519_PUBLIC_KEY` (public key, not secret)

## Secrets

Set via `wrangler secret put {NAME}` (encrypted, never in code):
- `ED25519_PRIVATE_KEY` — Production signing key
- `MASTER_API_KEY` — Primary API key
- `BETA_API_KEYS` — Comma-separated beta keys
- `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID_*`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `ORACLE_PAYMENT_ADDRESS` — Base mainnet wallet
- `CDP_API_KEY_NAME`, `CDP_API_KEY_PRIVATE_KEY`

## Cron Triggers

Cron triggers deploy with the worker. Current schedule:
- `* * * * *` — Halt monitor (every minute)
- `0 9 * * *` — Daily metrics
- `0 17 * * *` — MCP analytics aggregation
- `0 9 * * 1` — Weekly digest

## Related

- [Rollback](rollback.md) — How to revert a bad deploy
- [Monitoring](monitoring.md) — Post-deploy monitoring
- [SLA](sla.md) — Uptime commitments
