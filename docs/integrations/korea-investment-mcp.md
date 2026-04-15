# Korea Investment Securities MCP + Headless Oracle

Compose KIS Trading MCP (execution) with Headless Oracle (pre-trade verification)
to get autonomous trading on the Korea Exchange (XKRX) without executing into a
halted or closed market.

## Why this matters for KRX

Korean algorithmic trading is roughly 67% equity derivatives, routed through the
Korea Exchange (XKRX). The AI Framework Act (December 2024) makes "high-impact
AI" — which includes autonomous trading — subject to risk-management and audit
requirements. A signed, fail-closed market-state check before every order gives
you:

- Evidence an independent oracle said "OPEN" before execution
- Deterministic halt behaviour when XKRX is down, in circuit breaker, or UNKNOWN
- A 60-second TTL receipt that an auditor can verify offline using Ed25519

KIS MCP ships execution tools. It does not verify whether the exchange is open.
Headless Oracle is the pre-trade gate that closes that gap.

## Architecture

```
Agent
  │
  ├── 1. Headless Oracle MCP ──► get_market_status(mic="XKRX")
  │                              └── returns signed receipt (OPEN/CLOSED/HALTED/UNKNOWN)
  │
  ├── 2. Decision gate
  │     status !== "OPEN"  →  halt, log, do NOT route order
  │     status === "OPEN"  →  continue
  │
  └── 3. Korea Investment Securities MCP ──► place_order(...)
                                             └── executes on XKRX
```

## MCP configuration

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "headless-oracle-mcp"]
    },
    "kis-trading": {
      "command": "python",
      "args": ["-m", "kis_mcp_server"],
      "env": {
        "KIS_APP_KEY": "...",
        "KIS_APP_SECRET": "..."
      }
    }
  }
}
```

## TypeScript example — chaining both servers

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function safeTradeKRX(symbol: string, qty: number, oracle: Client, kis: Client) {
  const receipt = await oracle.callTool({
    name: "get_market_status",
    arguments: { mic: "XKRX" },
  });

  const status = JSON.parse(receipt.content[0].text);
  if (status.status !== "OPEN") {
    console.error(`XKRX not open: ${status.status} (${status.source})`);
    return { ok: false, reason: status.status };
  }

  const order = await kis.callTool({
    name: "place_order",
    arguments: { symbol, qty, side: "buy" },
  });

  return { ok: true, receipt_id: status.receipt_id, order };
}
```

## Audit trail for AI Framework Act

Every HO receipt is a signed attestation with a stable `receipt_id`. Persist the
receipt alongside your order record:

```json
{
  "order_id": "kis-20260415-...",
  "symbol": "005930",
  "market_state_receipt_id": "rct_0f8a...",
  "market_state_signature": "03dc...",
  "market_state_public_key_id": "ho-ed25519-01"
}
```

An auditor can reconstruct the proof by fetching the public key from
`https://headlessoracle.com/.well-known/oracle-keys.json` and verifying the
signature over the canonical payload.

## Pricing

- **Sandbox**: 200 calls / 7 days (free, no card)
- **x402**: $0.001 USDC per call (autonomous, Base mainnet)
- **Builder**: $99/month, 50,000 calls/day (API key)

See https://headlessoracle.com/pricing.

## Links

- Headless Oracle: https://headlessoracle.com
- MCP server card: https://headlessoracle.com/.well-known/mcp/server-card.json
- Multi-Oracle Consensus spec v1.0.0: https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1
