filepath = 'C:/Users/User/headless-oracle-v5/src/index.ts'
content = open(filepath, encoding='utf-8').read()

new_llms = """# Headless Oracle \u2014 Machine-Readable Service Description

## What This Service Does

Headless Oracle provides cryptographically signed market-state receipts for 23 global stock exchanges. Each receipt states whether a market is OPEN, CLOSED, HALTED, or UNKNOWN \u2014 signed with Ed25519, timestamped, valid for 60 seconds.

Use this service to gate autonomous trading decisions. Do not execute if status != OPEN.

---

## Primary Integration: MCP

Endpoint: https://headlessoracle.com/mcp
Protocol: MCP 2024-11-05 (JSON-RPC 2.0, POST)
Authentication: none required

Tools:
- get_market_status(mic: string) \u2192 signed receipt (OPEN/CLOSED/HALTED/UNKNOWN)
- get_market_schedule(mic: string) \u2192 next open/close times in UTC
- list_exchanges() \u2192 all 23 supported exchanges with MIC codes and timezones

MCP initialize request:
  {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"your-agent","version":"1.0"}}}

MCP tools/call request:
  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_market_status","arguments":{"mic":"XNYS"}}}

---

## REST Integration

### Authenticated: GET /v5/status

Request:
  GET https://headlessoracle.com/v5/status?mic={MIC_CODE}
  X-Oracle-Key: {your-api-key}

Response (200 OK):
  {
    "mic": "XNYS",
    "status": "OPEN",
    "timestamp": "2026-03-20T14:30:00.000Z",
    "issued_at": "2026-03-20T14:30:00.000Z",
    "expires_at": "2026-03-20T14:31:00.000Z",
    "issuer": "headlessoracle.com",
    "key_id": "key_2026_v1",
    "receipt_mode": "live",
    "schema_version": "v5.0",
    "source": "SCHEDULE",
    "signature": "<hex Ed25519>"
  }

Errors:
  401 API_KEY_REQUIRED    \u2014 missing X-Oracle-Key header
  403 INVALID_API_KEY     \u2014 key not recognised or revoked
  402 PAYMENT_REQUIRED    \u2014 subscription suspended or payment failed
  404 UNKNOWN_MIC         \u2014 MIC code not in supported set
  429 RATE_LIMITED        \u2014 daily plan limit reached

### Public: GET /v5/demo

Request:
  GET https://headlessoracle.com/v5/demo?mic={MIC_CODE}

Returns signed receipt with receipt_mode: "demo". No authentication required. Same schema as /v5/status. Use for integration testing without an API key.

### Batch: GET /v5/batch

Request:
  GET https://headlessoracle.com/v5/batch?mics=XNYS,XNAS,XLON
  X-Oracle-Key: {your-api-key}

Response (200 OK):
  {
    "receipts": [
      {"mic":"XNYS","status":"OPEN",...},
      {"mic":"XNAS","status":"OPEN",...},
      {"mic":"XLON","status":"CLOSED",...}
    ],
    "count": 3
  }

### Schedule: GET /v5/schedule

Request:
  GET https://headlessoracle.com/v5/schedule?mic={MIC_CODE}

Response (200 OK):
  {
    "mic": "XNYS",
    "timezone": "America/New_York",
    "next_open": "2026-03-23T13:30:00.000Z",
    "next_close": "2026-03-23T20:00:00.000Z",
    "lunch_break": null,
    "data_coverage_years": ["2026","2027"]
  }

lunch_break is non-null for: XJPX (11:30-12:30 local JST), XHKG (12:00-13:00 local HKT),
XSHG and XSHE (11:30-13:00 local CST).

---

## Key Acquisition

Request:
  POST https://headlessoracle.com/v5/keys/request
  Content-Type: application/json
  {"email":"operator@example.com"}

Response (200 OK):
  {"message":"API key sent to operator@example.com"}

The API key is emailed once. It is not stored in plaintext. Format: ho_live_ prefix + 64 hex characters.

Plans and limits:
  builder  \u2014 50,000 req/day
  pro      \u2014 200,000 req/day
  protocol \u2014 unlimited

Free demo access (no key): GET /v5/demo \u2014 500 req/day before x402 gate activates.

Pricing: https://headlessoracle.com/pricing

---

## Response Schema (complete field reference)

Field          | Type   | Description
---------------|--------|-----------------------------------------------------
mic            | string | ISO 10383 Market Identifier Code
status         | string | OPEN, CLOSED, HALTED, or UNKNOWN
timestamp      | string | ISO 8601 UTC \u2014 when status was computed
issued_at      | string | ISO 8601 UTC \u2014 when receipt was signed
expires_at     | string | ISO 8601 UTC \u2014 valid until (issued_at + 60s)
issuer         | string | Always "headlessoracle.com"
key_id         | string | Public key identifier for signature verification
receipt_mode   | string | "demo" (no auth) or "live" (authenticated)
schema_version | string | Always "v5.0"
source         | string | SCHEDULE, OVERRIDE, REALTIME, or SYSTEM
signature      | string | Hex-encoded Ed25519 over canonical payload
reason         | string | Present when source is OVERRIDE or REALTIME (halt reason)

---

## Status Values

OPEN    \u2014 market is currently trading. Safe to execute.
CLOSED  \u2014 market is closed (outside hours, holiday, weekend). Do not execute.
HALTED  \u2014 market is open but trading suspended (circuit breaker). Do not execute.
UNKNOWN \u2014 status cannot be determined. Treat as CLOSED. Do not execute.

---

## Fail-Closed Rules

IF status != "OPEN"       \u2192 do not execute. No exceptions.
IF API returns 5xx        \u2192 treat all markets as CLOSED, halt.
IF request times out (>4s)\u2192 treat all markets as CLOSED, halt.
IF signature invalid      \u2192 do not act on the receipt.
IF receipt past expires_at\u2192 fetch fresh status, do not reuse cached receipt.
UNKNOWN is not an error state \u2014 it is a definitive halt signal identical to CLOSED.

---

## Ed25519 Signature Verification

Public key (hex), key_id: key_2026_v1
  03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178

Public key endpoints:
  GET https://headlessoracle.com/v5/keys
  GET https://headlessoracle.com/.well-known/oracle-keys.json

Canonical payload algorithm:
  1. Remove the "signature" field from the receipt object
  2. Sort remaining keys alphabetically
  3. JSON.stringify compact (no whitespace, no trailing newline)
  4. UTF-8 encode to bytes
  5. Verify Ed25519 signature (from receipt.signature hex) against those bytes

JavaScript (Web Crypto \u2014 zero dependencies):
  async function verifyReceipt(receipt) {
    const { signature, ...fields } = receipt;
    const sorted = Object.fromEntries(Object.entries(fields).sort());
    const canonical = JSON.stringify(sorted);
    const pubBytes = hexToBytes('03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178');
    const key = await crypto.subtle.importKey('raw', pubBytes, {name:'Ed25519'}, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, hexToBytes(signature), new TextEncoder().encode(canonical));
  }

Python (PyNaCl):
  from nacl.signing import VerifyKey
  import json
  def verify_receipt(receipt):
      fields = {k:v for k,v in receipt.items() if k != 'signature'}
      canonical = json.dumps(dict(sorted(fields.items())), separators=(',',':'))
      VerifyKey(bytes.fromhex('03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178')) \\
          .verify(canonical.encode(), bytes.fromhex(receipt['signature']))

npm SDK: @headlessoracle/verify \u2014 zero production dependencies, Web Crypto, 3-line API.
  import { verify } from '@headlessoracle/verify';
  const result = await verify(receipt);
  if (!result.valid) throw new Error(result.reason);

---

## Supported MIC Codes (23 exchanges)

Americas:    XNYS (New York), XNAS (NASDAQ), XBSP (Sao Paulo)
Europe:      XLON (London), XPAR (Paris), XSWX (Zurich), XMIL (Milan), XHEL (Helsinki), XSTO (Stockholm), XIST (Istanbul)
Middle East: XSAU (Riyadh), XDFM (Dubai) \u2014 weekends Fri-Sat; Sunday is a trading day
Africa:      XJSE (Johannesburg)
Asia:        XJPX (Tokyo), XHKG (Hong Kong), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Seoul), XBOM (Mumbai BSE), XNSE (Mumbai NSE), XSES (Singapore)
Pacific:     XASX (Sydney), XNZE (Auckland)

Invalid MIC \u2192 404 UNKNOWN_MIC.
Full directory: GET https://headlessoracle.com/v5/exchanges

---

## Rate Limits by Plan

Plan      | Daily Limit   | On Exceed
----------|---------------|------------------------------------------
free      | 500 requests  | 402 + x402 payment object (Base USDC)
builder   | 50,000        | 429 RATE_LIMITED
pro       | 200,000       | 429 RATE_LIMITED
protocol  | unlimited     | \u2014

Resets at UTC midnight daily.
Soft warning headers at 80% and 95% of free tier: X-RateLimit-Warning.

---

## x402 Micropayment Path

When the free tier limit is exceeded, HTTP 402 response body:
  {
    "error": "PAYMENT_REQUIRED",
    "x402": {
      "network": "base-mainnet",
      "chainId": 8453,
      "amount": "1000",
      "currency": "USDC",
      "paymentAddress": "0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3",
      "usdcContractAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAge": 300
    }
  }

amount=1000 means 0.001 USDC (6 decimal places). Network: Base mainnet (chainId 8453).

To retry: send USDC transfer on Base mainnet, then include:
  X-Payment: {"txHash":"0x...","network":"base-mainnet","chainId":8453}

Constraints: transaction <= 300 seconds old; each txHash accepted once (replay protection).

Full docs: https://headlessoracle.com/docs/x402-payments

---

## OAuth / Authentication Discovery

GET https://headlessoracle.com/.well-known/oauth-protected-resource

Response:
  {
    "resource": "https://headlessoracle.com",
    "authorization_servers": [],
    "bearer_methods_supported": ["header"],
    "resource_documentation": "https://headlessoracle.com/docs"
  }

Authentication header name: X-Oracle-Key (not Authorization: Bearer).
This endpoint exists for RFC 8705 resource discovery used by MCP-compatible clients.

---

## Additional Endpoints

GET /v5/health         \u2014 signed liveness probe (no auth). Returns status: OK or 500 CRITICAL_FAILURE.
GET /v5/keys           \u2014 public key registry, canonical payload spec, key lifecycle metadata.
GET /v5/compliance     \u2014 APTS compliance status (6 checks), sma_spec_version, verify_sdk.
GET /v5/traction       \u2014 live metrics snapshot: exchanges, MCP requests today, days live.
GET /v5/usage          \u2014 per-key usage stats (auth required): requests today, limit, percent.
GET /v5/errors/{code}  \u2014 machine-readable error recovery details for any 4xx error code.
GET /openapi.json      \u2014 OpenAPI 3.1 specification (all routes, schemas, auth).
GET /.well-known/oracle-keys.json \u2014 RFC 8615 key discovery.
GET /llms.txt          \u2014 this document.

---

## DST Transitions 2026

Date        | Event                            | Affected MICs
2026-03-08  | US spring forward (EST to EDT)   | XNYS, XNAS
2026-03-29  | EU/UK spring forward             | XLON, XPAR, XSWX, XMIL, XHEL, XSTO
2026-10-25  | EU/UK fall back                  | XLON, XPAR, XSWX, XMIL, XHEL, XSTO
2026-11-01  | US fall back                     | XNYS, XNAS

All DST handling is automatic via IANA timezone names in Intl.DateTimeFormat. No hardcoded UTC offsets.

---

## Standards

SMA Protocol: https://github.com/LembaGang/sma-protocol (Apache 2.0)
Agent Pre-Trade Safety Standard (APTS): https://github.com/LembaGang/agent-pretrade-safety-standard (Apache 2.0)
OpenAPI spec: https://headlessoracle.com/openapi.json
Receipt specification: https://headlessoracle.com/docs

---

## Legal

API use constitutes acceptance of Terms of Service: https://headlessoracle.com/terms.html
Fail-closed obligation is contractual. Ignoring UNKNOWN status shifts liability to the operator.
"""

# Find old LLMS_TXT block boundaries
old_start_marker = "const LLMS_TXT = `# Headless Oracle\n"
idx_start = content.find(old_start_marker)
if idx_start == -1:
    print("ERROR: start marker not found")
    exit(1)

search_from = idx_start + len(old_start_marker)
end_marker = '`;\n'
idx_end = content.find(end_marker, search_from)
if idx_end == -1:
    print("ERROR: end marker not found")
    exit(1)

print(f"Replacing chars {idx_start} to {idx_end + len(end_marker)}")

new_block = "const LLMS_TXT = `" + new_llms + "`;\n"
new_content = content[:idx_start] + new_block + content[idx_end + len(end_marker):]
open(filepath, 'w', encoding='utf-8').write(new_content)

# Verify
verify = open(filepath, encoding='utf-8').read()
idx = verify.find("const LLMS_TXT = `")
end = verify.find("`;\n", idx + 18)
chunk = verify[idx:end+3]
print(f"New LLMS_TXT block: {chunk.count(chr(10))} lines")
print("SUCCESS")
