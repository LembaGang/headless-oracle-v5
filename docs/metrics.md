# Weekly Metrics to Track

## Leading Indicators — check every Monday

- [ ] npm weekly downloads: https://www.npmjs.com/package/@headlessoracle/verify
      (check "Weekly Downloads" on the package page)
- [ ] /v5/demo hit count
      (Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Metrics → filter by path)
- [ ] /mcp hit count
      (same dashboard, filter POST /mcp)
- [ ] /v5/health hit count
      (a rising health check count means someone is polling before each batch — real usage signal)
- [ ] GitHub stars: github.com/LembaGang/dst-exploit-demo
- [ ] GitHub stars: github.com/LembaGang/headless-oracle-v5 (if public)
- [ ] HN post points and comments (after March 10 launch)
- [ ] X/Twitter thread impressions and engagement

## Lagging Indicators — check monthly

- [ ] API keys created
      `SELECT COUNT(*) FROM api_keys;` (Supabase SQL editor)
- [ ] Active API keys (used in last 30 days)
      `SELECT COUNT(*) FROM api_keys WHERE last_used_at > now() - interval '30 days';`
- [ ] Revenue (Paddle Dashboard → Reports)
- [ ] Protocol conversations started (manual — note in CRM or a Notion doc)

## Automated Tracking

The worker includes a daily cron trigger (09:00 UTC) that fetches npm download stats for
`@headlessoracle/verify` and logs them to Workers Logs as `NPM_DOWNLOADS` structured events.

To query: Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Logs → filter `NPM_DOWNLOADS`.

## Alert Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| npm downloads | > 100/week | Investigate who's downloading — reach out |
| /v5/demo requests | > 1,000/day | Viral moment — prepare conversion path |
| /mcp requests | > 500/day | Someone is using it in production — reach out |
| API keys created | > 10 total | Begin structured onboarding conversations |
| Protocol conversation | Any | Highest priority — drop everything |
| 5xx error rate | > 1% | Investigate immediately — signing system may be degraded |

## Benchmarks (at HN launch, March 10 2026)

Record baseline values here after launch:

| Metric | Day 1 | Week 1 | Month 1 |
|--------|-------|--------|---------|
| npm downloads/week | — | — | — |
| /v5/demo req/day | — | — | — |
| /mcp req/day | — | — | — |
| API keys | — | — | — |
| Revenue | — | — | — |
