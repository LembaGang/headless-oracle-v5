# Headless Oracle — Cline Setup

Cline (VS Code extension) supports MCP servers. Add Headless Oracle via the Cline MCP config.

## Setup

In VS Code with Cline installed, open the Cline sidebar → click the MCP icon → **Edit MCP Settings**.

This opens `cline_mcp_settings.json`. Add the following entry inside `mcpServers`:

**Demo mode (no API key — free):**
```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"]
    }
  }
}
```

**With API key (live mode):**
```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"],
      "env": {
        "HEADLESS_ORACLE_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

Requires Node.js 18+. Restart VS Code after saving.

## Config file location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Windows | `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json` |
| Linux | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |

## Available tools

| Tool | Description |
|------|-------------|
| `get_market_status` | Signed receipt: OPEN/CLOSED/HALTED/UNKNOWN for any exchange |
| `get_market_schedule` | Next open/close times in UTC for any exchange |
| `list_exchanges` | All 28 supported exchanges with MIC codes and timezones |
| `verify_receipt` | Ed25519 signature verification on any receipt |

## Supported exchanges

28 global exchanges across equities, derivatives, and 24/7 crypto. Call `list_exchanges` for the full directory with timezones and mic_type.

## Notes

- UNKNOWN and HALTED receipts must be treated as CLOSED — do not execute trades
- All market receipts are Ed25519 signed with a 60-second TTL
- x402 per-request micropayments supported (0.001 USDC/req on Base mainnet)
