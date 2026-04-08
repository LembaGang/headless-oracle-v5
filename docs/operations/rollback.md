# Rollback Procedure

Last updated: 2026-04-08

## When to Rollback

- Smoke tests fail after deploy
- Error rate spikes (500s in Cloudflare dashboard)
- Signing errors (health endpoint returns CRITICAL_FAILURE)
- Payment flow broken (402/x402 responses malformed)
- MCP endpoint returning errors to evaluators

## Rollback Command

```bash
wrangler rollback
```

This reverts to the previous deployment version. Cloudflare Workers retains recent versions for instant rollback.

## Verification After Rollback

Same checks as post-deployment:

```bash
curl -s https://headlessoracle.com/v5/health | jq '.status'
curl -s https://headlessoracle.com/v5/demo?mic=XNYS | jq '.status'
npm run test:smoke
```

## What Rollback Does NOT Revert

- KV data changes (telemetry counters, API keys, overrides)
- Supabase schema changes
- Wrangler secrets (these are independent of deployments)
- DNS or route configuration changes in `wrangler.toml`

If a deployment included KV schema changes (new key patterns), rollback may leave orphaned data. This is generally harmless — expired TTLs clean up automatically.

## Rollback History

| Date | Reason | Duration |
|---|---|---|
| (none) | Zero production rollbacks in 43 days of operation | — |

## Escalation

If rollback does not resolve the issue:

1. Check Cloudflare Workers dashboard for runtime errors
2. Check KV namespace for corrupt data
3. If signing is broken: verify `ED25519_PRIVATE_KEY` secret is still set (`wrangler secret list`)
4. If all else fails: redeploy a known-good commit manually (`git checkout {hash} && npm run deploy`)

## Related

- [Deployment](deployment.md) — Standard deploy process
- [Incident Response](incident-response.md) — Full incident handling
