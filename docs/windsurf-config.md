# Headless Oracle — Windsurf Setup

## Configuration

Add this to your Windsurf MCP configuration file:

- macOS/Linux: `~/.codeium/windsurf/mcp_config.json`
- Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "headless-oracle": {
      "serverUrl": "https://headlessoracle.com/mcp",
      "headers": {
        "X-Oracle-Key": "${HEADLESS_ORACLE_API_KEY}"
      }
    }
  }
}
```

For demo mode (no API key needed), remove the `headers` block entirely.

## What This Provides

Three tools available to Cascade:

- **get_market_status** — Is this exchange open right now? Returns signed receipt.
- **get_market_schedule** — When does this exchange next open/close?
- **list_exchanges** — All 28 supported exchanges (equities, derivatives, 24/7 crypto).

Supported exchanges include: NYSE (XNYS), NASDAQ (XNAS), London (XLON), Tokyo (XJPX), Paris (XPAR), Hong Kong (XHKG), Singapore (XSES), Sydney (XASX), Seoul (XKRX), Mumbai (XBOM/XNSE), Shanghai (XSHG/XSHE), Zurich (XSWX), Johannesburg (XJSE), Dubai (XDFM), Riyadh (XSAU), CME Futures (XCBT), NYMEX (XNYM), Cboe (XCBO), Coinbase 24/7 (XCOI), Binance 24/7 (XBIN), and more. Call `list_exchanges` for the full directory.

## Why This Matters

AI coding agents generating trading algorithms cannot verify whether target markets are currently operational. Headless Oracle prevents Cascade from generating trade execution logic against closed, halted, or holiday-affected markets. Every response is cryptographically signed with Ed25519 and expires in 60 seconds.
