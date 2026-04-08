<!-- Living document. Update after every session that changes relevant
state. Last updated: 2026-04-08 by Day 42 meta-sprint -->

# Business Context — Headless Oracle V5

## Market Position

Headless Oracle is the ONLY product offering cryptographically signed
market-state attestations via MCP or HTTP (confirmed April 2026 research).

- 8,600+ MCP servers exist; ~1,187 in Finance category; zero offer signed market state
- Nearest competitors:
  - **Polygon.io**: basic US-only `get_market_status` tool, unsigned, no Ed25519, no fail-closed
  - **TradingHours.com**: 1,100 exchanges, no MCP server, no cryptographic signing
  - **Pyth Pro AI**: 3,000+ price feeds, zero market-state tools, no attestation model
- No competitor offers: signed receipts, fail-closed UNKNOWN handling, x402 agent payments, or MCP discoverability

## Revenue Model

| Tier | Price | Mechanism | Limit |
|---|---|---|---|
| Free trial | $0 | 3 signed receipts/day per IP (no signup) | 3/day |
| Free tier | $0 | API key via email signup | 500/day |
| Sandbox | $0 | Instant key, no card | 200 calls / 7-day key |
| x402 per-request | $0.001 USDC | On-chain Base mainnet (agent pays directly) | Unlimited |
| Credits | $5 | One-time Paddle purchase | 1,000 calls |
| Builder | $99/month | Paddle subscription | 50,000/day |
| Pro | $299/month | Paddle subscription | 200,000/day |
| Protocol | $500+/month | Custom | Unlimited |

## Distribution Surfaces

### MCP Registries
- Official MCP Registry (listed)
- Smithery (listed)
- Glama (listed, score tracked)
- npm: `headless-oracle-mcp` (listed)
- PulseMCP (listed)
- awesome-mcp-servers PR #343 (pending)

### Agent Framework PRs
- TauricResearch/TradingAgents #523 — market gate node in risk pipeline
- virattt/ai-hedge-fund #564 — market_state_verification_agent
- agent0ai/a0-plugins #193 — Agent Zero plugin
- edgeandnode/ampersend-examples #11 — ampersend x402 example

### AI Crawler Traffic (observed)
ClaudeBot, GPTBot, BingBot, Applebot, Googlebot, Meta-ExternalAgent

### Discovery Files (all live endpoints)
- `/AGENTS.md` — AAIF/Linux Foundation agent briefing
- `/llms.txt` — llmstxt.org spec-compliant index
- `/llms-full.txt` — comprehensive docs for LLM crawlers
- `/openapi.json` — OpenAPI 3.1 spec
- `/.well-known/mcp/server-card.json` — MCP server metadata
- `/.well-known/agent.json` — A2A Agent Card
- `/.well-known/x402.json` — x402 payment discovery
- `/.well-known/ai-plugin.json` — ChatGPT plugin manifest
- `/skill.md` — Ampersend skill format

## Regulatory Tailwinds

| Framework | Date | Relevant Requirement | HO Alignment |
|---|---|---|---|
| ESMA (EU) | Feb 2026 | Algorithms must be explainable, third-party data auditable | Signed receipts = audit trail |
| NIST (US) | Feb 2026 | "Cryptographic chains of custody" for agent authorization | Ed25519 signature chain |
| Singapore MAS | Jan 2026 | World's first agentic AI governance framework | Fail-closed + attestation model |

Full regulatory alignment table: `docs/compliance.md`

## Key Metrics (update regularly)

| Metric | Value | As of |
|---|---|---|
| Weekly unique MCP clients | 65 | Week 14 (Apr 2026) |
| Daily 402 bounces | ~19 | Day 41 |
| Evaluator platforms | DataCamp, Chiark, CacheFly/Glama, MCPScoreboard, YellowMCP, AgentDiscoveryIndex | Apr 2026 |
| npm package users (independent) | 4 (ZA, IT, DE, US-Indiana) | Apr 2026 |
| Auth calls | recurring (Day 41: 9, Day 42: 4+) | Apr 2026 |
| Infrastructure cost | $15.50/month | Apr 2026 |
| External revenue | $0 | Apr 2026 |
| MCPScoreboard score | 100/100 | Apr 2026 |
| Test suite | 714 tests | Apr 2026 |
| Exchanges covered | 28 | Apr 2026 |

## The Thesis

Autonomous agent adoption is reaching critical mass. Compounding distribution
history built NOW creates durable first-mover advantage. Every day of
telemetry, every registry listing, every framework integration, every evaluator
score is inventory that a late entrant cannot replicate.

The window is 6-18 months. Self-improving AI systems will eventually generate
their own solutions to unsolved infrastructure problems. The time to be the
established, trusted answer is before the question is fully formed.

Key compounding assets:
- **Telemetry history**: 40+ days of MCP client fingerprints, tool call patterns, referrer data
- **Registry presence**: 5+ registries, each with review history and scores
- **Framework integrations**: PRs in 4 agent frameworks (each PR is a permanent reference)
- **Evaluator scores**: MCPScoreboard 100/100, Glama score, DataCamp probing
- **Crawl index**: ClaudeBot, GPTBot already indexing /llms.txt and /AGENTS.md
- **Spec authorship**: SMA Protocol, APTS, MPAS — all Apache 2.0, all cited in agent contexts
