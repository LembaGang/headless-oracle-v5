# headless-oracle-mcp

[![npm](https://img.shields.io/npm/v/headless-oracle-mcp)](https://npmjs.com/package/headless-oracle-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Local stdio MCP server for [Headless Oracle](https://headlessoracle.com) — Ed25519-signed market-state receipts for 28 global exchanges.

---

## What is this?

Headless Oracle is a cryptographically signed market-state oracle for AI agents. It tells you whether a stock exchange is `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN` — and proves it with an Ed25519 signature.

This package lets any MCP-compatible AI client (Claude Desktop, Cursor, Cline, Windsurf, Continue.dev) call Headless Oracle tools directly. It runs as a local stdio MCP server that proxies tool calls to the Headless Oracle remote endpoint.

**Coverage:** NYSE, NASDAQ, London, Tokyo, Paris, Hong Kong, Singapore, Sydney, Mumbai (BSE + NSE), Shanghai, Shenzhen, Seoul, Johannesburg, São Paulo, Zurich, Milan, Istanbul, Riyadh, Dubai, Auckland, Helsinki, Stockholm — plus CME, NYMEX, Cboe, Coinbase, and Binance (28 total).

**Critical safety rule for agents:** treat `UNKNOWN` and `HALTED` as `CLOSED` — halt all execution.

---

## Install

```bash
npx headless-oracle-mcp
```

No install required. Requires Node.js 18+.

---

## Client setup

### Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

With API key:

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

---

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

With API key:

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

---

### Cline

Edit `cline_mcp_settings.json` (Cline settings → MCP Servers):

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

With API key:

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

---

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

With API key:

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

---

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

With API key:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "headless-oracle-mcp"],
          "env": {
            "HEADLESS_ORACLE_API_KEY": "your-key-here"
          }
        }
      }
    ]
  }
}
```

---

## Tools

| Tool | Description |
|------|-------------|
| `get_market_status` | Returns an Ed25519-signed receipt: `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN`. Always treat `UNKNOWN`/`HALTED` as `CLOSED`. |
| `get_market_schedule` | Returns next open/close times in UTC, including lunch break windows for XJPX, XHKG, XSHG, XSHE. |
| `list_exchanges` | Lists all 28 supported exchanges with MIC codes, names, and timezones. |
| `verify_receipt` | Verifies an Ed25519-signed receipt locally — checks signature, TTL expiry, and required fields. |
| `get_payment_options` | Returns the upgrade ladder: sandbox → x402 per-request → credits → Builder subscription. |

### Supported MIC codes (28 total)

`XNYS` `XNAS` `XBSP` `XLON` `XPAR` `XSWX` `XMIL` `XHEL` `XSTO` `XIST` `XSAU` `XDFM` `XJSE` `XSHG` `XSHE` `XHKG` `XJPX` `XKRX` `XBOM` `XNSE` `XSES` `XASX` `XNZE` `XCBT` `XNYM` `XCBO` `XCOI` `XBIN`

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

Receipts expire after 60 seconds (`expires_at`). Verify with [`@headlessoracle/verify`](https://npmjs.com/package/@headlessoracle/verify).

---

## How it works

Your MCP client communicates with this process over stdin/stdout (JSON-RPC 2.0). `initialize` and `ping` are handled locally; `tools/list` and `tools/call` are forwarded to `https://headlessoracle.com/mcp`.

- Zero npm dependencies — uses Node.js built-ins only (`readline`, `https`)
- Requires Node.js 18+
- Errors are written to stderr only; stdout is reserved for the MCP transport
- Set `HEADLESS_ORACLE_API_KEY` for authenticated access and higher rate limits

---

## Links

- **Website**: [headlessoracle.com](https://headlessoracle.com)
- **Docs**: [headlessoracle.com/docs](https://headlessoracle.com/docs)
- **Get a free key**: [headlessoracle.com/v5/sandbox](https://headlessoracle.com/v5/sandbox) (instant, no sign-up)
- **Verify SDK (JS)**: [npmjs.com/package/@headlessoracle/verify](https://npmjs.com/package/@headlessoracle/verify)
- **Remote MCP endpoint**: `https://headlessoracle.com/mcp` (protocol `2024-11-05`)
- **GitHub**: [github.com/LembaGang/headless-oracle-v5](https://github.com/LembaGang/headless-oracle-v5)

---

## License

MIT
