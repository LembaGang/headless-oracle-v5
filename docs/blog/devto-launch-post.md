---
title: "I Built an MCP Server That Signs Market Data for 28 Exchanges"
published: false
tags: mcp, api, opensource, showdev
---

41 days ago I started building something I wasn't sure anyone needed. A cryptographically signed oracle for market hours. For AI agents. Not a dashboard. Not a webhook. An Ed25519-signed receipt that says "yes, this exchange is open right now" with a 60-second TTL and a fail-closed guarantee. Here's what I learned.

## The Problem No One Talks About

AI agents are trading stocks, managing portfolios, and executing DeFi strategies. Most of them check market hours the same way: `datetime.now()` plus some hardcoded UTC offsets.

This breaks in ways that cost real money:

- **DST transitions**: The US springs forward in March. Europe springs forward two weeks later. For those two weeks, the offset between NYSE and London is wrong. An agent using `America/New_York = UTC-5` submits orders to a market that closed an hour ago.
- **Exchange holidays**: Martin Luther King Day, Golden Week, Diwali. Your timezone library doesn't know about these. Your agent submits orders to a closed exchange and gets rejected fills — or worse, queued orders that execute at unpredictable prices at the next open.
- **Circuit breakers**: NYSE Level 1 halt. Your agent has no idea. It keeps submitting orders into a halted market.
- **Lunch breaks**: Tokyo and Shanghai close for lunch. Hong Kong too. Your "market is open from 9 to 3" check is wrong for half the trading day.

The root cause is the same every time: agents use boolean `is_open()` checks that don't account for the full complexity of real market schedules.

## What I Built

[Headless Oracle](https://headlessoracle.com) returns cryptographically signed receipts for 28 global exchanges. Each receipt includes:

- **Ed25519 signature** — verifiable without trusting the server
- **60-second TTL** — `expires_at` forces re-fetch, prevents stale OPEN acting
- **Fail-closed guarantee** — UNKNOWN always means CLOSED, halt all execution
- **Receipt mode** — `demo` vs `live` so agents know what they're working with

It's available as an MCP server that works with Claude Desktop, Cursor, and Windsurf:

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["headless-oracle-mcp"]
    }
  }
}
```

Or as a REST API:

```bash
$ curl https://headlessoracle.com/v5/demo?mic=XNYS
{
  "receipt": {
    "mic": "XNYS",
    "status": "OPEN",
    "issued_at": "2026-04-07T15:30:00.000Z",
    "expires_at": "2026-04-07T15:31:00.000Z",
    "issuer": "headlessoracle.com",
    "source": "SCHEDULE",
    "schema_version": "v5.0",
    "receipt_mode": "demo",
    "signature": "a3f8c1d2..."
  }
}
```

## The Architecture

```
Agent
  │
  ├─ MCP ──→ Headless Oracle Worker (Cloudflare)
  │              │
  │              ├─ Schedule Engine (28 exchanges, IANA timezones)
  │              ├─ KV Override Check (circuit breakers)
  │              ├─ Ed25519 Sign (canonical payload, alphabetical sort)
  │              └─ Return signed receipt
  │
  └─ Agent verifies signature + TTL + status
       │
       └─ OPEN? → proceed
          NOT OPEN? → halt execution
```

The worker runs on Cloudflare's edge network — 42+ data centers globally. Schedule computation uses `Intl.DateTimeFormat` with IANA timezone names. No hardcoded UTC offsets anywhere. DST transitions are handled automatically by the runtime.

Signing uses `@noble/ed25519` — a pure JavaScript implementation with no native dependencies. The canonical payload is built by sorting keys alphabetically and JSON-stringifying with no whitespace. Any consumer in any language can independently verify.

x402 micropayments are live on Base mainnet. Agents can pay $0.001 USDC per call with no API key, no signup, no human in the loop. The agent sends a USDC transaction, includes the proof in the `X-Payment` header, and gets a signed receipt back. Self-sovereign agent commerce.

## The Numbers

- **714 tests** passing (Vitest + Cloudflare Workers runtime)
- **28 exchanges** across Americas, Europe, Middle East, Africa, Asia, Pacific
- **4 MCP tools**: `get_market_status`, `get_market_schedule`, `list_exchanges`, `verify_receipt`
- **42+ Cloudflare edge locations** serving requests
- **6 AI platforms** already crawling our llms.txt (ClaudeBot, GPTBot, Applebot, Bytespider, PerplexityBot, AhrefsBot)
- **$0.001/call** via x402 on Base mainnet — first autonomous agent payment processed on Day 41
- **1,319 schedule edge cases** per year computed from the exchange configs (holidays, DST, lunch breaks, weekends)

## What Surprised Me

**x402 changed everything.** The x402 protocol lets agents pay for API calls with USDC on Base — no API key, no signup form, no OAuth dance. An agent that hits a 402 response can read the payment details, sign a USDC transfer, and retry with the proof. Zero human interaction.

This isn't theoretical. We have a live 402 response with full x402 payment details. The first real payment was processed on Day 41. An agent paid for its own oracle call.

**The compliance angle was unexpected.** ESMA (Europe), NIST (US), and Singapore's MAS are all publishing requirements that map directly to what we built — pre-trade transparency, reliable AI systems, fail-closed risk management. The Ed25519 signatures and 60-second TTL aren't just engineering choices. They're regulatory compliance features.

## Try It

**Free trial**: 3 signed receipts per day on `/v5/status` — no API key needed.

**Demo endpoint**: Always free, unlimited. Try it now:
```bash
curl https://headlessoracle.com/v5/demo?mic=XNYS
```

**MCP server**: Install in 30 seconds:
```bash
npx headless-oracle-mcp
```

**Python SDK**:
```bash
pip install headless-oracle
```

**JavaScript verification**:
```bash
npm install @headlessoracle/verify
```

## What's Next

- **More exchanges**: 28 → 50 → 100. Architecture scales — each exchange is a config object.
- **Multi-party attestation (MPAS)**: Two or more independent operators verify before an agent acts. Ed25519 was chosen to compose cleanly into threshold signing.
- **Framework integrations**: PRs submitted to [TradingAgents](https://github.com/TauricResearch/TradingAgents/pull/523) and [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund/pull/564). More coming.
- **LangChain + CrewAI**: First-party PyPI packages already live (`headless-oracle-langchain`, `headless-oracle-crewai`).

Star us on GitHub if this is useful: [github.com/LembaGang/headless-oracle-v5](https://github.com/LembaGang/headless-oracle-v5)

What pre-trade checks do your agents run? I'd love to hear in the comments.
