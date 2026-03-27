import sys

filepath = r'C:\Users\User\headless-oracle-v5\src\index.ts'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

old_llms_start = "const LLMS_TXT = `# Headless Oracle\n> Cryptographically signed, fail-closed market-state receipts for AI agents. Ed25519-signed. 28 global exchanges."
old_llms_end = "Auth: optional Bearer token (Oracle API key via POST /oauth/token)\n`"

start_idx = content.find(old_llms_start)
end_idx = content.find(old_llms_end) + len(old_llms_end)

if start_idx == -1 or end_idx == len(old_llms_end) - 1:
    print(f"Not found: start={start_idx}, end={end_idx}")
    sys.exit(1)

print(f"Found LLMS_TXT: {start_idx}-{end_idx}")

new_llms_txt = '''const LLMS_TXT = `# Headless Oracle

> Cryptographically signed market state verification for autonomous financial agents. Ed25519-signed receipts ("SMA receipts") for 28 global exchanges \u2014 equities, derivatives, and 24/7 crypto. MCP-native, A2A-discoverable, x402-payable, fail-closed. UNKNOWN always means CLOSED.

**In this documentation, SMA denotes "Signed Market Attestation" \u2014 not the statistical "Simple Moving Average" used in technical analysis.**

## Instructions for Autonomous Agents

Before executing any trade or financial action, call \\`get_market_status\\` with the target exchange\'s ISO 10383 MIC code. Only proceed if \\`status\\` is \\`OPEN\\` and the receipt has not expired (\\`expires_at\\` is in the future).

- ALWAYS use the MCP endpoint at \\`https://headlessoracle.com/mcp\\` for tool access
- ALWAYS verify \\`expires_at\\` before trusting a receipt \u2014 receipts expire after 60 seconds
- NEVER execute against \\`CLOSED\\`, \\`HALTED\\`, or \\`UNKNOWN\\` status
- NEVER hardcode UTC offsets for market hours \u2014 use Headless Oracle receipts which handle DST automatically
- USE \\`list_exchanges\\` to get all supported MIC codes before querying a specific exchange
- USE \\`get_market_schedule\\` to check upcoming open/close times for planning workflows
- USE \\`verify_receipt\\` to independently validate a receipt signature before acting on it
- PREFER the MCP interface over REST for agent workflows
- FOR batch verification of multiple exchanges, use \\`POST /v5/batch\\` with an array of MIC codes

**x402 payment**: Premium endpoints accept autonomous USDC payments via x402 on Base (CAIP-2: \\`eip155:8453\\`). No API key required for x402 payments.

**Free access**: All MCP tools are available without authentication. Request a free REST API key at \\`https://headlessoracle.com/v5/keys/request\\`.

## API Reference

- [OpenAPI Specification](https://api.headlessoracle.com/openapi.json)
- [MCP Tool Definitions](https://api.headlessoracle.com/mcp) \u2014 tool list via GET
- [Conformance Vectors](https://api.headlessoracle.com/v5/conformance-vectors)
- [DST Risk Endpoint](https://headlessoracle.com/v5/dst-risk) \u2014 current DST transition vulnerabilities

## Core Documentation

- [Quick Start](https://headlessoracle.com/docs)
- [MCP Integration Guide](https://headlessoracle.com/docs/integrations/mcp)
- [LangChain Integration](https://headlessoracle.com/docs/integrations/langchain)
- [CrewAI Integration](https://headlessoracle.com/docs/integrations/crewai)
- [REST API Reference](https://headlessoracle.com/docs/api)
- [Receipt Verification](https://headlessoracle.com/docs/verification)
- [SMA Protocol RFC-001](https://headlessoracle.com/docs/sma-protocol/rfc-001)

## SDK Documentation

- [JavaScript/TypeScript (@headlessoracle/verify)](https://headlessoracle.com/docs/sdks/javascript)
- [Python (headless-oracle)](https://headlessoracle.com/docs/sdks/python)
- [Go (headless-oracle-go)](https://headlessoracle.com/docs/sdks/go)

## Quick Start (no signup required)
# Get an instant sandbox key (24h, 100 calls):
GET https://api.headlessoracle.com/v5/sandbox

# Use it immediately:
GET https://api.headlessoracle.com/v5/status?mic=XNYS
Header: X-Oracle-Key: {your_sandbox_key}

# Demo (signed receipt, no key needed):
GET https://api.headlessoracle.com/v5/demo?mic=XNYS

## Endpoints
| Endpoint | Method | Auth | Description | Returns |
|---|---|---|---|---|
| /v5/demo | GET | No | Signed receipt, demo mode | SMA receipt (receipt_mode=demo) |
| /v5/status | GET | Yes | Signed receipt, live mode | SMA receipt (receipt_mode=live) |
| /v5/batch | GET | Yes | Signed receipts for multiple MICs | { summary, receipts[] } |
| /v5/sandbox | GET | No | Instant sandbox key (24h, 100 calls) | { api_key, tier, expires_at } |
| /v5/schedule | GET | No | Next open/close times (not signed) | { next_open, next_close, lunch_break, settlement_window } |
| /v5/exchanges | GET | No | All 28 supported exchanges | { exchanges: [{mic, name, timezone, mic_type}] } |
| /v5/keys | GET | No | Public signing key + canonical spec | { keys: [{key_id, public_key, algorithm}] } |
| /v5/health | GET | No | Signed liveness probe | SMA-format health receipt |
| /v5/usage | GET | Yes | Per-key daily usage stats | { requests_today, limit, percent_used } |
| /v5/traction | GET | No | Live metrics snapshot | { exchanges_covered, mcp_requests_today, ... } |
| /v5/receipts | GET | Builder+ | Receipt audit log | { receipts: [{mic, status, issued_at}] } |
| /v5/dst-risk | GET | No | DST transition risk for affected exchanges | { event, affected_exchanges[], risk_window_minutes } |
| /v5/webhooks/subscribe | POST | Yes | Subscribe to state-change webhooks | { subscription_id } |
| /v5/webhooks/unsubscribe | DELETE | Yes | Remove webhook subscription | { ok: true } |
| /v5/archive | GET | Optional | Historical receipt archive | { mic, date, count, receipts[] } |
| /v5/stream | GET | Yes | SSE stream of signed market_status events every 30s | text/event-stream |
| /v5/conformance-vectors | GET | No | 5 live-signed canonical test vectors | { vectors: [{name, receipt, canonical_payload, public_key}] } |
| /mcp | POST | No (optional Bearer) | MCP Streamable HTTP (JSON-RPC 2.0) | JSON-RPC response |
| /openapi.json | GET | No | OpenAPI 3.1 machine-readable spec | OpenAPI document |
| /.well-known/oracle-keys.json | GET | No | RFC 8615 key discovery | Key lifecycle metadata |
| /.well-known/agent.json | GET | No | A2A Agent Card | A2A agent capabilities |
| /.well-known/mcp/server-card.json | GET | No | MCP server card | Tool list, reliability, coverage |
| /v5/errors/{code} | GET | No | Machine-readable error definition | { message, resolution, http_status } |
| /v5/changelog | GET | No | Versioned changelog feed | { version, updated, entries[] } |
| /badge/:mic | GET | No | SVG status badge | image/svg+xml |
| /status | GET | No | HTML market status page for all 28 exchanges | text/html |

## Receipt Schema (SMA = Signed Market Attestation, not Simple Moving Average)
\\`\\`\\`json
{
  "receipt_id":     "uuid",
  "mic":            "XNYS",
  "status":         "OPEN | CLOSED | HALTED | UNKNOWN",
  "issued_at":      "2026-03-27T14:30:00.000Z",
  "expires_at":     "2026-03-27T14:31:00.000Z",
  "issuer":         "headlessoracle.com",
  "source":         "SCHEDULE | OVERRIDE | REALTIME | SYSTEM",
  "schema_version": "v5.0",
  "receipt_mode":   "demo | live",
  "public_key_id":  "key_2026_v1",
  "signature":      "<hex-encoded Ed25519 signature>"
}
\\`\\`\\`

## Verification
Ed25519 signature verification steps:
1. Receive receipt JSON
2. Extract all fields EXCEPT "signature" -> payload object
3. Sort payload keys alphabetically
4. JSON.stringify(sortedPayload) with no whitespace -> canonical string
5. Verify signature (hex) against canonical string using public key from /v5/keys
6. Check expires_at > now (60s TTL)
7. Check status === "OPEN" before proceeding
If any step fails -> halt execution

SDK (JS): npm install @headlessoracle/verify (zero deps, Web Crypto)
SDK (Go): go get github.com/LembaGang/headless-oracle-go (zero stdlib deps, oracle.Verify())
SDK (Python): pip install headless-oracle

## Supported Exchanges

### Equities (23)
XNYS (NYSE, America/New_York), XNAS (NASDAQ, America/New_York), XLON (London, Europe/London),
XJPX (Tokyo, Asia/Tokyo), XPAR (Paris, Europe/Paris), XHKG (Hong Kong, Asia/Hong_Kong),
XSES (Singapore, Asia/Singapore), XASX (Sydney, Australia/Sydney), XBOM (Mumbai BSE, Asia/Kolkata),
XNSE (Mumbai NSE, Asia/Kolkata), XSHG (Shanghai, Asia/Shanghai), XSHE (Shenzhen, Asia/Shanghai),
XKRX (Seoul, Asia/Seoul), XJSE (Johannesburg, Africa/Johannesburg), XBSP (Sao Paulo, America/Sao_Paulo),
XSWX (Zurich, Europe/Zurich), XMIL (Milan, Europe/Rome), XIST (Istanbul, Europe/Istanbul),
XSAU (Riyadh, Asia/Riyadh, Fri/Sat weekends), XDFM (Dubai, Asia/Dubai, Fri/Sat weekends),
XNZE (Auckland, Pacific/Auckland), XHEL (Helsinki, Europe/Helsinki), XSTO (Stockholm, Europe/Stockholm)

### Derivatives & Crypto (5)
XCBT (CME Futures, America/Chicago, overnight/Sunday pre-open, mic_type: iso)
XNYM (NYMEX, America/Chicago, overnight/Sunday pre-open, mic_type: iso)
XCBO (Cboe Options, America/Chicago, 9:30-16:15 ET, mic_type: iso)
XCOI (Coinbase, UTC, 24/7 no weekends, mic_type: convention)
XBIN (Binance, UTC, 24/7 no weekends, mic_type: convention)

settlement_window: T+1/DTCC (XNYS/XNAS), T+2/Euroclear (XLON), T+2/JSCC (XJPX), null for all others

## DST Risk (Critical: March 29, 2026)
European clocks spring forward Sunday March 29, 2026 at 01:00 UTC.
XLON, XPAR, XSWX, XMIL, XHEL, XSTO shift +1h (GMT/CET \u2192 BST/CEST).
Agents using hardcoded UTC offsets will compute incorrect market hours starting Monday March 30.
Headless Oracle receipts use IANA timezone identifiers \u2014 DST is handled automatically.
Live risk endpoint: GET https://headlessoracle.com/v5/dst-risk

## Fail-Closed Guarantee
UNKNOWN status means the oracle cannot determine market state. Agents MUST treat UNKNOWN as CLOSED and halt. HALTED means a circuit breaker or operator override is active \u2014 also treat as CLOSED. The absence of a valid signed receipt is itself proof of unsafety.

## Pricing
- Free: 500 req/day (GET /v5/keys/request)
- Sandbox: 100 req/24h, instant, no signup (GET /v5/sandbox)
- x402: 0.001 USDC/req via Base mainnet (no key, no signup)
- Builder: 50,000 req/day ($99/mo)
- Pro: 200,000 req/day ($299/mo)
- Protocol: unlimited ($500/mo)
Upgrade: https://headlessoracle.com/upgrade

## Discovery Endpoints
- [Agent Card (A2A)](https://headlessoracle.com/.well-known/agent.json)
- [MCP Server Card](https://headlessoracle.com/.well-known/mcp/server-card.json)
- [Oracle Public Keys (JWKS)](https://headlessoracle.com/.well-known/oracle-keys.json)

## MCP Integration
Server card: GET https://headlessoracle.com/.well-known/mcp/server-card.json
Protocol: MCP-2024-11-05
Endpoint: POST https://headlessoracle.com/mcp
Tools: get_market_status, get_market_schedule, list_exchanges, verify_receipt
Auth: optional Bearer token (Oracle API key via POST /oauth/token)
`'''

content = content[:start_idx] + new_llms_txt + content[end_idx:]

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print(f"Done. New LLMS_TXT is {len(new_llms_txt)} chars.")
