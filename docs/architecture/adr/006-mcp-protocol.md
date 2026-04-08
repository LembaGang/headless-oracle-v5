# ADR-006: MCP as Primary Agent Interface

## Status
Accepted

## Date
2026-02-22

## Context
AI agents discover and use tools through the Model Context Protocol
(MCP). Without an MCP endpoint, Headless Oracle is invisible to
Claude Desktop, Cursor, and the growing MCP-compatible agent
ecosystem. We needed to decide whether to build MCP support as a
separate service or integrate it into the existing Worker.

## Decision
Implement MCP Streamable HTTP at `POST /mcp` within the existing
Worker. JSON-RPC 2.0 transport, protocol version `2024-11-05`.

Five tools: `get_market_status`, `get_market_schedule`,
`list_exchanges`, `verify_receipt`, `get_payment_options`.

No new npm dependencies. Tools call the same internal functions as
REST routes. `buildSignedReceipt` is a shared function so the 4-tier
fail-closed architecture applies identically to MCP and REST.

MCP handler is outside the main `try/catch` — returns JSON-RPC error
format, never REST `CRITICAL_FAILURE` format.

## Consequences

**Benefits:**
- Oracle discoverable from Claude Desktop, Cursor, and MCP clients
- Zero additional infrastructure — same Worker, same deployment
- Same signing and safety guarantees as REST endpoints
- 65 unique MCP clients/week already consuming the endpoint
- MCP tool descriptions enable Agent Tool Search discoverability

**Trade-offs:**
- MCP is still evolving — protocol changes may require updates
- Streamable HTTP transport means no SSE push over MCP (polling only)
- Tool descriptions are critical for discoverability — require
  ongoing optimization for keyword relevance
- MCP metering shares rate limits with REST — no separate quota

**Alternatives considered:**
- Separate MCP server process: more ops overhead, no shared signing
  key access
- MCP via SSE: stateful, more complex, not needed at current scale
- stdio MCP only: published as `headless-oracle-mcp` npm package for
  local client use, but HTTP endpoint is primary
