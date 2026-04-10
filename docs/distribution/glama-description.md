# Glama MCP Listing — Optimised Description

## How Glama Gets the Description

Glama pulls from the MCP server's `initialize` response (`instructions` field)
and/or `/.well-known/mcp/server-card.json` (`description` field). Both have
been updated in `src/index.ts` with keyword-rich descriptions.

Glama may also have an admin panel at glama.ai where the description can be
edited manually. If the auto-pulled description doesn't match, Mike should
update it there.

## Optimised Description (for manual update if needed)

Ed25519-signed market-state attestations for 28 global exchanges.
Pre-trade verification gate for autonomous financial agents.
Check if any exchange is open or closed right now — NYSE, NASDAQ,
London, Tokyo, Hong Kong, and 22 more. Handles DST transitions,
exchange holidays, lunch breaks, and circuit breaker detection.
Fail-closed: if state is unknown, agents halt. 60-second TTL
signed receipts. MCP tools: get_market_status, get_market_schedule,
list_exchanges, verify_receipt, get_payment_options. REST API +
x402 micropayments ($0.001 USDC on Base mainnet). Layer 1 of the
composable pre-trade verification stack.

## Discovery Keywords (naturally included)

- exchange hours
- market open closed
- trading schedule
- pre-trade check
- market state API
- DST-aware
- holiday calendar
- circuit breaker detection
- Ed25519 signed receipts
- fail-closed
- autonomous financial agents

## Where Updated

- `src/index.ts` — `/.well-known/mcp/server-card.json` description field
- `src/index.ts` — `/.well-known/mcp-servers.json` description field
- The MCP `initialize` response `instructions` field was already keyword-rich

## Manual Action (if needed)

If Glama admin panel exists:
1. Go to https://glama.ai/mcp/servers/LembaGang/headless-oracle-v5
2. Edit the description to match the optimised text above
3. Glama re-scans periodically, so the server-card update may auto-propagate
