# Design Partner Pitch — 10-Slide Deck Outline

## Slide 1: The Problem
Autonomous agents are executing financial transactions without verifying whether markets are actually open. When a DST transition, circuit breaker, or exchange holiday isn't detected, the agent executes anyway. The loss is real and quantifiable.

## Slide 2: The DST Example
A single DST transition creates a phantom trading hour — the agent thinks the market is open, it isn't. For a mid-frequency strategy running $150K/day: $13,000–$19,500 in direct exposure per transition. There are 8 DST transitions per year across major exchanges. At $1M/day, the exposure is $87K–$130K annually — from a bug that costs $0 to fix.

## Slide 3: The Solution
Headless Oracle issues cryptographically signed receipts for market state — OPEN, CLOSED, HALTED, or UNKNOWN. The receipt includes an Ed25519 signature, 60-second TTL, and issuer field. The agent verifies the signature, checks the TTL, and halts on UNKNOWN. The entire safety gate is 3 lines of code.

## Slide 4: The Architecture — Three-Layer Stack
```
Authorization  →  Mastercard Verifiable Intent
Execution      →  BVNK / Mastercard
Verification   →  Headless Oracle (SMA Protocol v1.0)
```
Mastercard acquired BVNK for $1.8B this week. The stack is assembling. Oracle is the verification layer.

## Slide 5: The RFC
We submitted an External State Attestation RFC to the Verifiable Intent framework today. It defines how any external state (not just market state) gets attested for autonomous agent consumption — with market state as the reference implementation. If adopted, every agent in the Verifiable Intent ecosystem needs Oracle-compatible signed state.

## Slide 6: Live Traction — Day 8
- Datacamp: 8 days continuous
- Google Cloud: 5-instance cluster, Council Bluffs
- Microsoft Azure: active
- France: active
- 3,300+ daily events, 0 errors
- Live at /v5/traction

## Slide 7: Global Coverage
23 exchanges across 6 regions: Americas (NYSE, NASDAQ, B3), Europe (LSE, Euronext, SIX, Milan, Helsinki, Stockholm, Istanbul), Middle East (Tadawul, DFM), Africa (JSE), Asia (Tokyo, Hong Kong, Shanghai, Shenzhen, Seoul, BSE, NSE, SGX), Pacific (ASX, NZX). DST handled via IANA timezones. Lunar, Islamic, and Hindu holiday calendars included.

## Slide 8: The Technology
- **Ed25519** — deterministic, auditable, composable into multisig (federation-ready)
- **Fail-closed** — 4-tier: KV override → schedule → UNKNOWN → unsigned 500
- **MCP protocol** — Claude Desktop, Cursor, any MCP-compatible agent discovers us automatically
- **x402 micropayments** — agents pay 0.001 USDC per request on Base mainnet, no subscription
- **Autonomous halt monitor** — Polygon.io + Alpaca, 1-minute polling, REALTIME circuit breakers

## Slide 9: The Design Partner Offer
We are not selling a subscription. We are looking for 3–5 design partners who will:
- Use Oracle in a real production agent workflow
- Provide weekly feedback on what the API needs to serve them
- Pay for production access (Builder or Protocol tier)

In return, they get: direct line to the founder, custom exchange coverage, early access to federation features, and a reference in the RFC.

## Slide 10: Contact
Mike Mbeenz
mike@headlessoracle.com
headlessoracle.com
/v5/traction — live metrics, always current
