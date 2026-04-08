# Service Level Agreement

Last updated: 2026-04-08

## Service Level Objectives (SLOs)

| Metric | Target | Measurement |
|---|---|---|
| **Availability** | 99.9% (43 min downtime/month) | UptimeRobot /v5/health checks every 5 min |
| **Latency P50** | < 50ms | Cloudflare Workers analytics |
| **Latency P95** | < 200ms | Cloudflare Workers analytics |
| **Latency P99** | < 500ms | Cloudflare Workers analytics |
| **Signing coverage** | 100% | Every OPEN/CLOSED response carries Ed25519 signature |
| **Receipt TTL** | 100% within 60s | Signed `expires_at` = `issued_at` + 60s |
| **Fail-closed** | 100% | UNKNOWN status always treated as CLOSED |

## Historical Performance

| Period | Uptime | Incidents | Rollbacks |
|---|---|---|---|
| Day 1–43 (Feb 25 – Apr 8, 2026) | 100% | 0 | 0 |

## Infrastructure

- **Runtime**: Cloudflare Workers — 300+ Points of Presence globally
- **Deployment**: Atomic (zero-downtime). New version replaces old instantly.
- **Edge compute**: Requests served from nearest PoP. No origin server.
- **KV replication**: Cloudflare KV is eventually consistent, globally replicated

## SLA Applicability

| Plan | SLA Credits |
|---|---|
| Free / Trial / Sandbox | No SLA |
| Credits | No SLA |
| Builder ($99/mo) | SLA applies |
| Pro ($299/mo) | SLA applies |
| Protocol (custom) | Custom SLA |

## SLA Credits

For Builder and Pro plans, if monthly availability falls below the SLO:

| Availability | Credit |
|---|---|
| 99.0% – 99.9% | 10% of monthly fee |
| 95.0% – 99.0% | 25% of monthly fee |
| < 95.0% | 50% of monthly fee |

Maximum credit per month: 50% of that month's fee. Credits applied to next billing cycle. Must be requested within 30 days of the incident.

## Exclusions

The following are excluded from SLA calculations:
- Cloudflare platform-wide outages (outside our control)
- Planned maintenance with 48 hours' notice
- Force majeure events
- Customer-side network issues
- Abuse or violation of [Acceptable Use Policy](../legal/acceptable-use.md)

## Planned Maintenance

- Maintenance windows communicated 48 hours in advance
- Zero planned maintenance to date (Workers deploy atomically)
- Secret rotation performed without downtime

## Monitoring

See [Monitoring](monitoring.md) for the systems that track these SLOs.

## Contact

SLA inquiries: support@headlessoracle.com
Incident reports: security@headlessoracle.com
