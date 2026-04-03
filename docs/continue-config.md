# Headless Oracle — Continue.dev Setup

Continue.dev supports MCP servers via `~/.continue/config.json`.

## Setup

Add the following to your `~/.continue/config.json` under `mcpServers`:

**Demo mode (no API key — free):**
```json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"]
    }
  ]
}
```

**With API key (live mode):**
```json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"],
      "env": {
        "X_ORACLE_KEY": "YOUR_API_KEY_HERE"
      }
    }
  ]
}
```

Note: `mcp-remote` passes env vars through to the server only if the transport supports headers. For header-based auth, use the `type: "http"` transport if your version of Continue supports it:

```json
{
  "mcpServers": [
    {
      "name": "headless-oracle",
      "transport": {
        "type": "http",
        "url": "https://headlessoracle.com/mcp",
        "headers": {
          "X-Oracle-Key": "YOUR_API_KEY_HERE"
        }
      }
    }
  ]
}
```

Requires Node.js 18+. Reload the VS Code window after saving `config.json`.

## Available tools

| Tool | Description |
|------|-------------|
| `get_market_status` | Signed receipt: OPEN/CLOSED/HALTED/UNKNOWN for any exchange |
| `get_market_schedule` | Next open/close times in UTC for any exchange |
| `list_exchanges` | All 28 supported exchanges with MIC codes and timezones |
| `verify_receipt` | Ed25519 signature verification on any receipt |

## Notes

- UNKNOWN and HALTED receipts must be treated as CLOSED
- All receipts are Ed25519 signed with a 60-second TTL
- x402 per-request micropayments supported (0.001 USDC/req on Base mainnet)
