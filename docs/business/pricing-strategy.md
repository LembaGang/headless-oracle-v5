# Pricing Strategy

Last updated: 2026-04-08

## Tier Structure and Rationale

### Free Trial (3/day per IP, no signup)
**Rationale**: Zero-friction first contact. An agent or developer can verify the service works without any commitment. IP-based limiting prevents abuse while allowing immediate evaluation.

### Free Tier (500/day, API key required)
**Rationale**: Developer adoption funnel. Email capture provides a contact channel. 500 calls/day is sufficient for development and light production use. Converts trial users into identifiable contacts.

### Sandbox (200 calls, 7-day key, instant)
**Rationale**: Bridge between anonymous trial and committed free tier. No email required. Designed for CI/CD integration testing and quick evaluations.

### x402 Per-Request ($0.001 USDC per call)
**Rationale**: Agent-native payment. No signup, no API key, no human in the loop. An autonomous agent can pay for each request independently. At $0.001, individual calls are negligible. At scale: 1,000 calls/day = $30/month, 10,000/day = $300/month.

### Credits ($5 for 1,000 calls)
**Rationale**: Lowest-friction paid entry point for individual developers. One-time Paddle purchase, no subscription commitment. Bridges the gap between free (500/day) and Builder ($99/mo).

### Builder ($99/month, 50,000/day)
**Rationale**: Production teams running trading agents, backtesting systems, or multi-exchange monitoring. Price point comparable to typical API subscriptions. 50K/day handles most production workloads.

### Pro ($299/month, 200,000/day)
**Rationale**: High-frequency consumers, multi-tenant platforms, or agent infrastructure providers. 200K/day supports serving multiple downstream clients.

### Protocol ($500+/month, custom)
**Rationale**: Enterprise and infrastructure integrations requiring custom SLAs, dedicated support, or white-label arrangements.

## Unit Economics

| Item | Value |
|---|---|
| Cost per Worker invocation | ~$0.000005 (Cloudflare Workers pricing) |
| Cost per KV read | ~$0.0000005 |
| Infrastructure cost/month | $15.50 |
| Gross margin at x402 ($0.001) | ~99.5% |
| Break-even | 15,500 x402 calls OR 1 Builder subscription |

## Price Positioning

- **Below exchange data feeds**: Bloomberg Terminal ($24K/year), Refinitiv (~$22K/year), Polygon.io ($199/month for market status)
- **Above free alternatives**: TradingHours.com (no API), manual exchange calendar lookup
- **x402 per-call**: No direct competitor offers agent-native micropayment for market state

## Revenue Projections

| Scenario | Monthly Revenue | Assumption |
|---|---|---|
| Current | $0 | Pre-revenue (Day 43) |
| 10 Builder subs | $990 | 10 teams adopt |
| 100K x402 calls/day | $3,000 | Agent ecosystem scales |
| 5 Pro + 50K x402/day | $2,995 | Mixed enterprise + agent |

## Pricing Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-03-17 | Free trial: 3/day/IP | Balance trial access vs abuse prevention |
| 2026-03-28 | Sandbox: 200 calls/7 days | Was 25 calls/24h — too restrictive for evaluation |
| 2026-04-02 | x402: $0.001 USDC | Minimum viable micropayment. Considered $0.01 but deferred price increase |
| 2026-03-30 | Credits: $5/1000 | Bridge between free and Builder for individual devs |
