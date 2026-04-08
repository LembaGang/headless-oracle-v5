# Performance Testing — Headless Oracle V5

## Test Methodology

Load tests hit `GET /v5/demo?mic=XNYS` (public, unsigned demo endpoint) to
avoid consuming trial quota or authenticated API calls. The demo endpoint
exercises the full schedule engine and signing path — representative of
real-world latency for `/v5/status`.

Tests are run from a single client using `scripts/load-test.js` with
configurable concurrency (requests per second) and duration.

```bash
# Default: 10 req/s for 30 seconds
npm run test:load

# Custom rate and duration
node scripts/load-test.js --rps 100 --duration 60

# Against local dev server
node scripts/load-test.js --target http://localhost:8787
```

## Results

### Tier 1: Baseline (10 req/s, 30 seconds)

| Metric | Value |
|--------|-------|
| Total requests | 300 |
| Successful (200) | 300 (100%) |
| Failed | 0 |
| Actual RPS | 9.96 |
| **Latency P50** | **177 ms** |
| **Latency P95** | **257 ms** |
| **Latency P99** | **962 ms** |
| Latency Min | 129 ms |
| Latency Max | 1,278 ms |
| Latency Mean | 202 ms |

*Run: 2026-04-08 from Johannesburg, ZA to Cloudflare edge*

### Tier 2: Moderate (100 req/s, 30 seconds)

Not yet tested. Run with explicit permission:
```bash
node scripts/load-test.js --rps 100
```

### Tier 3: Stress (1000 req/s, 30 seconds)

Not yet tested. Run with explicit permission:
```bash
node scripts/load-test.js --rps 1000
```

## Notes

- Tests run against `/v5/demo` (public) to avoid consuming trial or
  authenticated quota
- The demo endpoint runs the same code path as `/v5/status` (schedule
  engine + Ed25519 signing) — latency is representative
- P99 spikes are expected on initial cold starts (Cloudflare Workers
  isolate spin-up) and resolve on warm paths
- Run higher tiers only with explicit founder approval to avoid
  triggering Cloudflare rate limits or DDoS protection
