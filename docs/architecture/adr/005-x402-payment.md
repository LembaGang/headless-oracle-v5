# ADR-005: x402 Micropayments over Stripe Direct

## Status
Accepted

## Date
2026-03-20

## Context
Autonomous agents need to pay for oracle services without human
intervention. Traditional payment flows (Stripe Checkout, card entry)
require a human in the loop. Agents need to pay programmatically,
per-request, using on-chain assets.

## Decision
Implement x402 micropayments on Base mainnet. Agents pay $0.001 USDC
per request by including an `X-Payment` header with a transaction
hash. The oracle verifies the on-chain transfer before returning a
signed receipt.

Payment verification: two RPC calls per request
(`eth_getTransactionReceipt` + `eth_getBlockByNumber`). Replay
protection via `x402_used:{txHash}` KV key with 600s TTL.

Paddle handles traditional subscription billing (human path).

## Consequences

**Benefits:**
- Agents pay autonomously — no API key provisioning, no signup
- Per-request pricing ($0.001) eliminates commitment barrier
- On-chain verification is trustless — no payment processor dependency
- x402 is an emerging standard (Coinbase CDP, Ampersend)
- Dual-path: x402 for agents, Paddle for humans

**Trade-offs:**
- Two RPC calls per request adds ~200ms latency to the payment path
- Base mainnet gas costs paid by the agent (~$0.001 per tx)
- No caching of verified transactions (each request re-verifies)
- x402 ecosystem is early — limited agent wallet support
- Revenue per request ($0.001) requires high volume for meaningful income

**Why not Stripe direct for agents:**
Stripe requires a browser redirect for initial setup, credit card
details, and PCI compliance. An autonomous agent cannot complete
these steps without human assistance.
