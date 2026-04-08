# MCP Reference

Last updated: 2026-04-08

## Endpoint

`POST https://headlessoracle.com/mcp`

Protocol: MCP 2024-11-05 over Streamable HTTP. JSON-RPC 2.0.

## Configuration

### Claude Desktop / Cursor / Windsurf

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "headless-oracle-mcp"]
    }
  }
}
```

### Direct HTTP (any MCP client)

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp"
    }
  }
}
```

## Tools (5)

### get_market_status
Returns a signed Ed25519 receipt with the current market state.

**Parameters**: `mic` (string, required) — ISO 10383 Market Identifier Code
**Returns**: Signed receipt with `status` (OPEN/CLOSED/HALTED/UNKNOWN), `source`, `signature`, `expires_at`
**Failure**: `isError: true` with machine-readable reason

### get_market_schedule
Returns next open/close times for an exchange.

**Parameters**: `mic` (string, required)
**Returns**: `next_open`, `next_close` (UTC ISO 8601), `lunch_break`, `settlement_window`, `data_coverage_years`

### list_exchanges
Returns all 28 supported exchanges.

**Parameters**: None
**Returns**: Array of `{ mic, name, timezone, mic_type }`

### verify_receipt
Verifies an Ed25519-signed receipt in-worker.

**Parameters**: `receipt` (object, required) — full receipt object including signature
**Returns**: `{ valid, expired, reason, mic, status, expires_at }`

### get_payment_options
Returns the upgrade ladder for agents hitting rate limits.

**Parameters**: None
**Returns**: Sandbox, x402, credits, builder, pro options with URLs and pricing

## Authentication

MCP access is unauthenticated by default. Optional OAuth 2.0 soft auth:
- `Authorization: Bearer {token}` from `POST /oauth/token`
- Invalid/missing tokens fall through as anonymous (never rejected)
- Authenticated MCP calls count against plan daily limits

## Supported MICs

23 traditional: XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES, XASX, XBOM, XNSE, XSHG, XSHE, XKRX, XJSE, XBSP, XSWX, XMIL, XIST, XSAU, XDFM, XNZE, XHEL, XSTO

5 extended: XCBT, XNYM (CME overnight), XCBO (Cboe options), XCOI (Coinbase 24/7), XBIN (Binance 24/7)

## npm Package

`headless-oracle-mcp` — stdio bridge for local MCP clients.

```bash
npx headless-oracle-mcp
```

Supports `HEADLESS_ORACLE_API_KEY` environment variable for authenticated access.
