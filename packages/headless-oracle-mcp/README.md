# headless-oracle-mcp

[![npm version](https://img.shields.io/npm/v/headless-oracle-mcp)](https://npmjs.com/package/headless-oracle-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Local stdio MCP server for [Headless Oracle](https://headlessoracle.com) — Ed25519-signed market-state receipts for 28 global exchanges.

**Critical safety rule for agents:** treat `UNKNOWN` and `HALTED` as `CLOSED` — halt all execution.

---

## Quick start

```bash
npx headless-oracle-mcp
```

No install required. Works with Claude Desktop, Cursor, Cline, Windsurf, and Continue.dev.

---

## MCP client setup

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

### Cursor

Edit `~/.cursor/mcp.json`:

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

### Cline

Edit `cline_mcp_settings.json` (accessible via Cline settings → MCP Servers):

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

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

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

### Continue.dev

Edit `~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "headless-oracle-mcp"]
        }
      }
    ]
  }
}
```

---

## With API key

For authenticated access (higher rate limits, `/v5/status` endpoint):

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "headless-oracle-mcp"],
      "env": {
        "HEADLESS_ORACLE_API_KEY": "your-key-here"
      }
    }
  }
}
```

Get a free sandbox key at [headlessoracle.com](https://headlessoracle.com) or via the `/v5/sandbox` endpoint.

---

## Tools

| Tool | Description |
|------|-------------|
| `get_market_status` | Returns an Ed25519-signed receipt: `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN`. Treat UNKNOWN/HALTED as CLOSED. |
| `get_market_schedule` | Returns next open/close times in UTC for a given exchange. |
| `list_exchanges` | Lists all 28 supported exchanges with MIC codes, names, and timezones. |
| `verify_receipt` | Verifies an Ed25519 receipt locally — checks signature, TTL, and fields. |
| `get_payment_options` | Returns the upgrade ladder (sandbox → x402 → credits → Builder). |

### Supported exchanges (28 total)

XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE, XCBT, XNYM, XCBO, XCOI, XBIN

---

## Example receipt

```json
{
  "mic": "XNYS",
  "status": "OPEN",
  "receipt_mode": "live",
  "issued_at": "2026-04-04T14:30:00.000Z",
  "expires_at": "2026-04-04T14:31:00.000Z",
  "issuer": "headlessoracle.com",
  "schema_version": "v5.0",
  "source": "SCHEDULE",
  "key_id": "ed25519-v1",
  "receipt_id": "...",
  "signature": "..."
}
```

All receipts are signed with Ed25519. Verify with [`@headlessoracle/verify`](https://npmjs.com/package/@headlessoracle/verify).

---

## How it works

This package is a local stdio MCP server that proxies tool calls to the [Headless Oracle remote endpoint](https://headlessoracle.com/mcp). Your MCP client (Claude Desktop, Cursor, etc.) communicates with this process over stdin/stdout using JSON-RPC 2.0. The process forwards `tools/list` and `tools/call` requests to the remote endpoint and returns the results.

- Zero npm dependencies — uses Node.js built-ins only (`readline`, `https`)
- Requires Node.js 18+
- Errors are logged to stderr only; stdout is reserved for the MCP transport

---

## Links

- **Website**: [headlessoracle.com](https://headlessoracle.com)
- **Docs**: [headlessoracle.com/docs](https://headlessoracle.com/docs)
- **npm**: [npmjs.com/package/@headlessoracle/verify](https://npmjs.com/package/@headlessoracle/verify) (JS verification SDK)
- **Remote MCP endpoint**: `https://headlessoracle.com/mcp` (MCP Streamable HTTP, protocol `2024-11-05`)
- **GitHub**: [github.com/LembaGang/headless-oracle-v5](https://github.com/LembaGang/headless-oracle-v5)

---

## License

MIT
