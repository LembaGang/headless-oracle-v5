# Using Headless Oracle in Cursor

Cursor supports MCP (Model Context Protocol), giving the AI assistant in Cursor direct access to live, signed market status data.

---

## Setup (~30 seconds)

Open Cursor → `Cursor Settings` → `MCP` → `Add new MCP server`.

Or edit `~/.cursor/mcp.json` directly:

**macOS / Linux** (`~/.cursor/mcp.json`):
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

**Windows** (`%APPDATA%\Cursor\mcp.json`):
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

Restart Cursor after saving.

---

## Available tools

Once connected, Cursor's AI can use these tools:

| Tool | Description |
|------|-------------|
| `get_market_status` | Current open/closed status for an exchange (signed receipt) |
| `get_market_schedule` | Next open and close times for an exchange |
| `list_exchanges` | All 7 supported exchanges |

---

## Try it

After setup, ask Cursor:

- "Is NYSE open right now?"
- "What time does the London Stock Exchange close today?"
- "Check if both XNYS and XNAS are open before running my trading backtest."
- "Get the signed market receipt for XJPX and include the receipt_id in my log."
- "What markets are open right now across all 7 exchanges?"

---

## Using market status in code generation

Cursor can call Oracle tools and use the result inline:

```
"Generate a Python trading script that only runs when XNYS is OPEN.
 Use the market status tool to verify the current state first."
```

The signed receipt (with `receipt_id`) is included in the generated code as an audit trail.

---

## Supported exchanges

| MIC | Exchange | Timezone |
|-----|----------|----------|
| XNYS | New York Stock Exchange | America/New_York |
| XNAS | NASDAQ | America/New_York |
| XLON | London Stock Exchange | Europe/London |
| XJPX | Japan Exchange Group (Tokyo) | Asia/Tokyo |
| XPAR | Euronext Paris | Europe/Paris |
| XHKG | Hong Kong Exchanges | Asia/Hong_Kong |
| XSES | Singapore Exchange | Asia/Singapore |

---

## Fail-closed guarantee

Every receipt includes a cryptographic signature. The oracle's internal architecture ensures that if market status cannot be determined, it returns `UNKNOWN` (never stale `OPEN`). Cursor's AI assistant is aware of this contract — it will surface the `UNKNOWN` status rather than assuming the market is open.

---

## Troubleshooting

**Tool not appearing in Cursor**: Restart Cursor fully after editing `mcp.json`.

**`npx mcp-remote` not found**: Install Node.js 18+ from nodejs.org.

**Want to verify receipts independently**: The receipt's `issuer` field is `headlessoracle.com`. Fetch `https://headlessoracle.com/v5/keys` to get the Ed25519 public key and verify any receipt independently.

---

## Related

- [Claude Desktop setup](https://headlessoracle.com/docs#mcp) — identical config format
- [OpenAPI spec](https://headlessoracle.com/openapi.json) — machine-readable API schema
- [Verify a receipt](https://headlessoracle.com/verify) — paste any receipt to check its signature
