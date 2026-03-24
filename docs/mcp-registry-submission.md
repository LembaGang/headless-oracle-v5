# Headless Oracle — MCP Registry Submission

Ready-to-submit content for Smithery, mcp.so, and similar MCP server registries.

---

## Server Details

| Field | Value |
|-------|-------|
| Name | Headless Oracle |
| Endpoint | https://headlessoracle.com/mcp |
| Protocol | 2024-11-05 |
| Transport | Streamable HTTP (POST) |
| Authentication | Optional — sandbox/free/paid key via `X-Oracle-Key` header or OAuth 2.0 Bearer |
| License | Apache 2.0 (SMA Protocol) |

---

## Description

Headless Oracle is the signed market-state primitive for AI agent infrastructure. It provides Ed25519-cryptographically-signed receipts stating whether any of 23 global stock exchanges is OPEN, CLOSED, HALTED, or UNKNOWN.

**Key properties:**
- **Fail-closed**: UNKNOWN and HALTED always mean halt execution — never a false OPEN
- **Cryptographically verifiable**: every receipt is Ed25519-signed with a published key
- **23 exchanges**: NYSE, NASDAQ, LSE, Tokyo, Paris, Hong Kong, Singapore, Sydney, Mumbai, Shanghai, Shenzhen, Seoul, Johannesburg, São Paulo, Zurich, Milan, Istanbul, Riyadh, Dubai, Auckland, Helsinki, Stockholm
- **60-second TTL**: receipts expire, preventing stale data from being acted on
- **Receipt portability**: signed receipts can be verified by downstream agents without calling the API again

---

## Tools

### get_market_status

Returns a cryptographically signed Ed25519 receipt for one exchange.

**When to use:** Before executing any trade, payment, or market-dependent action.

**Input:**
```json
{
  "mic": "XNYS"
}
```

**Output:**
```json
{
  "receipt_id": "uuid",
  "mic": "XNYS",
  "status": "OPEN",
  "issued_at": "2026-03-24T14:30:00.000Z",
  "expires_at": "2026-03-24T14:31:00.000Z",
  "issuer": "headlessoracle.com",
  "source": "SCHEDULE",
  "schema_version": "v5.0",
  "receipt_mode": "live",
  "public_key_id": "key_2026_v1",
  "signature": "<hex Ed25519>"
}
```

**CRITICAL:** Treat `HALTED` and `UNKNOWN` as `CLOSED`. Halt all execution immediately.

---

### get_market_schedule

Returns next open and close times in UTC for an exchange, including lunch break windows.

**Input:**
```json
{
  "mic": "XJPX"
}
```

**Output:**
```json
{
  "mic": "XJPX",
  "timezone": "Asia/Tokyo",
  "next_open": "2026-03-25T00:00:00.000Z",
  "next_close": "2026-03-25T06:30:00.000Z",
  "lunch_break": { "start": "11:30", "end": "12:30" },
  "data_coverage_years": ["2026", "2027"]
}
```

---

### list_exchanges

Returns all 23 supported exchanges with MIC codes, names, and timezones.

**Input:** none

**Output:**
```json
{
  "exchanges": [
    { "mic": "XNYS", "name": "New York Stock Exchange", "timezone": "America/New_York" },
    { "mic": "XNAS", "name": "NASDAQ", "timezone": "America/New_York" },
    ...
  ]
}
```

---

### verify_receipt

Verifies an Ed25519-signed receipt against the Headless Oracle public key. Allows downstream agents to confirm receipt authenticity independently.

**Input:**
```json
{
  "receipt": { "mic": "XNYS", "status": "OPEN", "signature": "...", "..." }
}
```

**Output:**
```json
{
  "valid": true,
  "expired": false,
  "reason": null,
  "mic": "XNYS",
  "status": "OPEN",
  "expires_at": "2026-03-24T14:31:00.000Z"
}
```

---

## Supported MIC codes (all 23)

`XNYS`, `XNAS`, `XBSP`, `XLON`, `XPAR`, `XSWX`, `XMIL`, `XHEL`, `XSTO`, `XIST`, `XSAU`, `XDFM`, `XJSE`, `XSHG`, `XSHE`, `XHKG`, `XJPX`, `XKRX`, `XBOM`, `XNSE`, `XSES`, `XASX`, `XNZE`

---

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp"
    }
  }
}
```

With optional API key (higher rate limits):

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp",
      "headers": {
        "X-Oracle-Key": "YOUR_KEY"
      }
    }
  }
}
```

---

## Cursor Configuration

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp"
    }
  }
}
```

---

## Example tool calls

**Check if NYSE is open:**
```
User: Is NYSE open right now?
→ Tool: get_market_status({ "mic": "XNYS" })
→ Response: { "status": "OPEN", "expires_at": "..." }
```

**Get Tokyo trading hours:**
```
User: When does Tokyo stock exchange open next?
→ Tool: get_market_schedule({ "mic": "XJPX" })
→ Response: { "next_open": "...", "lunch_break": { "start": "11:30", "end": "12:30" } }
```

**Pre-trade safety check:**
```
User: Verify it's safe to execute a trade on LSE
→ Tool: get_market_status({ "mic": "XLON" })
→ If status !== "OPEN": halt execution, return reason to user
```

---

## Authentication

- **No key required**: MCP tools work without authentication (anonymous, rate-limited)
- **Sandbox key** (instant, 24h, 100 calls): `GET https://api.headlessoracle.com/v5/sandbox`
- **Free key** (500 req/day): `POST https://api.headlessoracle.com/v5/keys/request` with `{"email":"you@example.com"}`
- **Paid key**: [headlessoracle.com/pricing](https://headlessoracle.com/pricing)
- **OAuth 2.0**: `POST https://headlessoracle.com/oauth/token` (client_credentials grant)

---

## Links

- Homepage: https://headlessoracle.com
- Docs: https://headlessoracle.com/docs
- OpenAPI spec: https://headlessoracle.com/openapi.json
- MCP server card: https://headlessoracle.com/.well-known/mcp/server-card.json
- Agent Card (A2A): https://headlessoracle.com/.well-known/agent.json
- Key request: https://headlessoracle.com/v5/keys/request
- Compliance: https://headlessoracle.com/v5/compliance
- SMA Protocol: https://github.com/LembaGang/sma-protocol
- Agent Pre-Trade Safety Standard: https://github.com/LembaGang/agent-pretrade-safety-standard
