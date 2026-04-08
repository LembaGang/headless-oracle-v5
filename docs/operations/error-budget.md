# Error Budget Report

## Period: 2026-04-01 to 2026-04-08 (8 days)

## SLO: 99.9% availability

| Metric | Value |
|--------|-------|
| Total requests | 9,037 |
| Successful (200 + 402) | 9,028 (99.90%) |
| Server errors (5xx) | 0 |
| **Availability** | **100.0000%** |

## Error Budget

| Metric | Value |
|--------|-------|
| Budget (0.1% of 9,037) | 9 requests |
| Budget consumed | 0 requests (0.0%) |
| Budget remaining | 9 requests (100.0%) |

## Status: HEALTHY

Error budget is well within limits. No action needed.

## Definitions

- **Successful**: HTTP 200 (normal) + HTTP 402 (intentional payment gate) — both are correct behavior
- **Server errors**: HTTP 5xx only — these indicate system failures
- **Error budget**: At 99.9% SLO, 0.1% of total requests are the allowed failure threshold
- **Status thresholds**: HEALTHY (<50% consumed), WARNING (50-80%), CRITICAL (>80%)

## How to Update

```bash
# Pull fresh data from production KV
node scripts/error-budget.js --fetch

# Or manually populate docs/operations/error-budget-data.json
# from Cloudflare Dashboard > Workers > Analytics
node scripts/error-budget.js
```

Last updated: 2026-04-08T13:46:37.297Z
