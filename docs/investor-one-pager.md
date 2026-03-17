# Headless Oracle — Investor One-Pager

## What We Do

Headless Oracle is the signed market-state primitive for autonomous financial agents — a cryptographically verified, fail-closed API that tells agents whether a market is open before they execute. Think DNS for market state.

## The Market

Autonomous finance is assembling its stack in real time. Mastercard acquired BVNK for $1.8B this week. The Verifiable Intent framework is live. Every layer of that stack needs verified market state before execution. We submitted the External State Attestation RFC to the Verifiable Intent repo today — positioning Headless Oracle as the verification layer in the stack.

## The Product

- **23 global exchanges** — NYSE, NASDAQ, LSE, TSE, HKEx, and 18 more
- **Ed25519 signed receipts** — cryptographically verifiable, not self-reported
- **Fail-closed architecture** — UNKNOWN always means CLOSED, never OPEN
- **x402 micropayments** — agents pay per-request in USDC with no subscription
- **MCP protocol** — discoverable by Claude, Cursor, and every MCP-compatible agent
- **Autonomous halt monitor** — real-time circuit breaker detection, 1-minute polling

## Traction (Day 8, March 18 2026)

- Datacamp client: 8 days continuous usage
- Google Cloud cluster: 5 instances, Council Bluffs
- Microsoft Azure client: active
- France: active
- 3,300+ daily events logged, 0 errors
- @headlessoracle/verify: npm package live
- /mcp endpoint: discoverable via Claude Desktop and Cursor

## The RFC

We submitted an External State Attestation RFC to github.com/agent-intent/verifiable-intent today. This positions Headless Oracle as the reference implementation for verifiable market state in the autonomous finance stack alongside Mastercard Verifiable Intent and BVNK.

## The Ask

We are not fundraising. We are looking for design partners who will pay for production access — specifically teams building autonomous trading agents, DeFi execution layers, and agent orchestration platforms who need verified market state as a primitive.

## Contact

mike@headlessoracle.com | headlessoracle.com | /v5/traction for live metrics
