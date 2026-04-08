# Monitoring

Last updated: 2026-04-08

## Monitoring Infrastructure

| System | What It Monitors | Access |
|---|---|---|
| Cloudflare Workers Observability | Real-time request logs, errors, CPU time | Cloudflare Dashboard |
| Cloudflare Analytics | Request volume, bandwidth, cache | Cloudflare Dashboard |
| Cloudflare AI Crawl Control | AI crawler activity | Cloudflare Dashboard |
| KV Telemetry (ORACLE_TELEMETRY) | Usage counters, MCP clients, funnel metrics | `/v5/metrics/public`, `/v5/traction` |
| UptimeRobot | /v5/health every 5 min | uptimerobot.com |

## Key Metrics and Normal Ranges

### Request Volume
| Metric | Normal Range | Source |
|---|---|---|
| Total 200s/day | 600–800 | `status_code:{date}:200` KV |
| Total 402s/day | 15–60 | `status_code:{date}:402` KV |
| Total 500s/day | 0 | `status_code:{date}:500` KV |
| Auth calls/day | 4–9 (emerging) | `auth_calls:{date}` KV |
| Trial receipts/day | 4–9 | `trial_usage_served:{date}` KV |

### MCP Traffic
| Metric | Normal Range | Source |
|---|---|---|
| Weekly unique MCP clients | 55–75 | Weekly digest KV |
| Daily MCP requests | 200–400 | `mcp_tool:*:{date}` KV |
| Evaluator probes | 5–7 platforms daily | MCP client records |

### Conversion Funnel
| Metric | What It Means | Source |
|---|---|---|
| `funnel_402:keyless_no_payment` | Agents that could convert | KV counter |
| `funnel_402:trial_exhausted` | High-intent (used all 3 free) | KV counter |
| `funnel_402:free_limit_reached` | Free tier at capacity | KV counter |
| `design_partner:*` | Keys exceeding 200 req/day | KV flag |

## Alert Thresholds

### P1 (Immediate)
- Health check fails 3 consecutive times (UptimeRobot)
- Zero 200 responses in 15 minutes
- `status_code:{date}:500` > 0 within 5 minutes

### P2 (15 min response)
- 500 error count > 5 in 1 hour
- MCP evaluator probes returning errors (Glama, MCPScoreboard)
- Auth calls returning 403 for known-good keys

### P3 (1 hour response)
- Telemetry KV writes failing (visible in Workers Logs)
- Weekly unique MCP clients drops >50% week-over-week
- Sandbox provisioning errors

## Public Metrics Endpoints

| Endpoint | Auth | Content |
|---|---|---|
| `GET /v5/metrics/public` | No | Exchanges, uptime, tests, status codes, MCP clients |
| `GET /v5/traction` | No | Live snapshot: exchanges, days live, MCP stats, x402 |
| `GET /v5/referrers` | No | Referrer domain counts (supports `?date=`) |
| `GET /v5/payment-proof` | No | x402 lifetime payment stats |

## Weekly Review Checklist

- [ ] Check week-over-week MCP client count (weekly_digest KV)
- [ ] Review new evaluator fingerprints in MCP client records
- [ ] Check 402 funnel metrics for conversion opportunities
- [ ] Review Cloudflare Analytics for traffic anomalies
- [ ] Check npm download stats (logged daily at 09:00 UTC)
- [ ] Review AI Crawl Control for new crawler activity

## Related

- [Incident Response](incident-response.md) — What to do when alerts fire
- [SLA](sla.md) — Uptime targets these metrics support
- [Telemetry Guide](../../.claude/rules/04_telemetry_guide.md) — Full KV key pattern reference
