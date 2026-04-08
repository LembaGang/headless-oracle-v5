# Competitive Analysis

Last updated: 2026-04-08

## Category Definition

Headless Oracle operates in the category of **cryptographically signed market-state attestations for autonomous agents**. As of April 2026, no other product occupies this exact category.

## Direct Competitors

**None.** Confirmed via comprehensive research (April 2026):
- 8,600+ MCP servers indexed; ~1,187 in Finance category
- Zero offer signed market-state attestations
- Zero offer fail-closed UNKNOWN handling
- Zero offer x402 agent-native payments for market data
- Zero offer MCP-based market state discovery

## Adjacent Products

### Polygon.io
- **What**: Market data API with `get_market_status` tool
- **Coverage**: US markets only (XNYS, XNAS)
- **Signing**: None — unsigned responses
- **MCP**: Basic MCP server, no Ed25519, no fail-closed
- **Pricing**: $199/month (Currencies plan) for market status
- **Gap**: No cryptographic attestation, no global coverage, no agent-native payments

### TradingHours.com
- **What**: Exchange hours database
- **Coverage**: 1,100+ exchanges (comprehensive)
- **Signing**: None
- **MCP**: No MCP server
- **API**: REST API available
- **Gap**: No cryptographic signing, no MCP, no agent discovery, no fail-closed architecture

### Pyth Pro AI
- **What**: Price feed oracle for DeFi
- **Coverage**: 3,000+ price feeds
- **Signing**: On-chain attestation (different model — price data, not market state)
- **MCP**: Zero market-state tools
- **Gap**: Solves a different problem (price feeds, not session state)

### Alpha Vantage / Financial Modeling Prep
- **What**: Financial data APIs
- **Coverage**: Broad market data
- **Signing**: None
- **MCP**: None
- **Gap**: General data APIs, not specialized attestation service

## Competitive Moat

### What We Have That Others Cannot Quickly Replicate

| Asset | Time to Build | Replicable? |
|---|---|---|
| 43 days of MCP client telemetry | 43 days | No — historical data is unique |
| 725-test suite with edge cases | Weeks | Partially — but our edge case knowledge is earned |
| 6 evaluator platforms tracking us | Months of presence | No — evaluator history is organic |
| 4 independent npm users | Organic adoption | No — trust is earned |
| 7+ registry listings with scores | Weeks of applications | Partially — but review history matters |
| 5 framework integration PRs | Weeks | Partially — but merged PRs are permanent references |
| MCPScoreboard 100/100 | Score earned over time | Yes — but takes consistent quality |
| Spec authorship (SMA, MPAS, APTS) | Months | No — first-mover on open standards |

### What a Funded Competitor Could Replicate

- Core API (2-4 weeks for a competent team)
- 28-exchange coverage (1-2 weeks with holiday research)
- Ed25519 signing (trivial)
- Basic MCP server (1 week)

### What They Cannot Replicate

- Ecosystem integration depth (PRs, evaluators, crawlers, npm users)
- Telemetry history showing real agent adoption patterns
- Open standard authorship and community recognition
- First-mover position in MCP registries

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Polygon.io adds signing | Medium | High | Our coverage is 28 exchanges vs their US-only |
| TradingHours adds MCP | Low-Medium | Medium | We have signing + fail-closed; they'd need architecture rethink |
| New entrant (startup) | Medium | Medium | Ecosystem depth is our moat |
| Exchange provides own MCP | Low | High | We aggregate 28; single-exchange MCP is insufficient |
| AI model trains on our format | High | Positive | Organic adoption of receipt format |
