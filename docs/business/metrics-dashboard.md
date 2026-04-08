# Metrics Dashboard

Last updated: 2026-04-08

## Where to Find Metrics

| System | URL / Access | What It Shows |
|---|---|---|
| Cloudflare Workers Observability | Cloudflare Dashboard → Workers | Real-time request logs, errors, CPU time |
| Cloudflare Analytics | Cloudflare Dashboard → Analytics | Request volume, bandwidth, cache rates |
| Cloudflare DNS Analytics | Cloudflare Dashboard → DNS | Query volume by datacenter |
| Cloudflare AI Crawl Control | Cloudflare Dashboard → AI | Crawler activity by bot |
| KV Telemetry | `GET /v5/traction` | Live snapshot of all key metrics |
| Public Metrics | `GET /v5/metrics/public` | Social proof metrics |
| Referrers | `GET /v5/referrers` | Traffic sources by domain |
| Payment Proof | `GET /v5/payment-proof` | x402 payment history |

## Key Metrics (Update Weekly)

### Revenue
| Metric | Value | As Of |
|---|---|---|
| MRR | $0 | Day 43 (Apr 8, 2026) |
| Lifetime x402 revenue | $0.001 (1 payment) | Day 41 |
| First payment date | Apr 7, 2026 | Day 41 |

### Adoption
| Metric | Value | As Of |
|---|---|---|
| Weekly unique MCP clients | 65 | Week 14 |
| Auth calls/day | 4–9 | Day 42 |
| Trial receipts/day | 4–9 | Day 42 |
| npm package users (independent) | 4 (ZA, IT, DE, US) | Day 42 |
| AI crawlers indexing | 6 (Anthropic, OpenAI, Google, MS, Apple, Meta) | Day 42 |

### Conversion Funnel
| Metric | Value | As Of |
|---|---|---|
| 402 bounces/day | 14–55 | Day 41–42 |
| Trial exhausted/day | — | Tracked via `funnel_402:trial_exhausted` |
| Sandbox keys issued | — | Tracked via `sandbox_fingerprint:ip:*` |

### Evaluator Presence
| Platform | Status | Score |
|---|---|---|
| MCPScoreboard | Active | 100/100 |
| Glama | Active | Tracked |
| DataCamp | Active | Probing since Day 7 |
| Chiark (Agent Quality Index) | Active | Scoring |
| YellowMCP | Active | Health checking |
| AgentDiscoveryIndex | Active | x402 ecosystem crawler |

### Infrastructure
| Metric | Value |
|---|---|
| Monthly cost | $15.50 |
| Test suite | 725 tests passing |
| Smoke tests | 11 tests passing |
| Uptime | 100% (43 days) |
| Production rollbacks | 0 |

## Weekly Review Template

```
## Week [N] Review — [Date]

### Revenue
- MRR: $___
- x402 payments this week: ___
- New paid keys issued: ___

### Adoption
- Weekly unique MCP clients: ___ (prev: ___)
- Auth calls/day avg: ___ (prev: ___)
- New npm users: ___
- New evaluator platforms: ___

### Conversion
- 402 bounces/day avg: ___
- Trial exhausted: ___
- Sandbox → paid conversions: ___

### Action Items
- [ ] ___
```
