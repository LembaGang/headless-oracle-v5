# Data Flow — Request Lifecycle

Last updated: 2026-04-08

Three common request paths through the system, from incoming request to signed response.

## Path 1: Free Trial Receipt

`GET /v5/status?mic=XNYS` — no API key, no payment header.

```
Request → main fetch()
  → No X-Oracle-Key header → keyless path
  → No X-Payment header
  → Hash client IP → read trial_usage:{date}:{hash} from KV
  → trialCount < 3 → proceed
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
    → Tier 0: getCachedOverride(mic) → null (no halt)
    → Tier 1: getScheduleStatus(mic, now) → { status: 'OPEN', source: 'SCHEDULE' }
    → signPayload(payload, privKey) → hex signature
  → Response 200 with receipt + X-Trial-Remaining header
  → Deferred: increment trial_usage KV counter
```

**Key behaviors**: IP hashed (never stored raw). 4th request returns 402 with x402 payment instructions. Trial counter resets daily.

## Path 2: Authenticated Receipt

`GET /v5/status?mic=XNYS` — with `X-Oracle-Key` header.

```
Request → main fetch()
  → X-Oracle-Key present → checkApiKey(key, env)
    → Not master/beta → sha256(key) → check in-memory cache
    → Cache hit: { plan: 'builder', status: 'active' } → allowed
  → getDailyUsage(keyHash, env) → check against getPlanDailyLimit(plan)
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
  → Response 200 with receipt + X-Oracle-Plan + X-RateLimit-* headers
  → Deferred: incrementDailyUsage, updateKeyUsage, insertReceiptAudit, incrementKvCounter
```

**Key behaviors**: In-memory cache avoids KV round-trip on warm isolates. Credits-tier keys bypass cache (balance mutates per request). Rate limit headers on every response.

## Path 3: x402 Payment

`GET /v5/status?mic=XNYS` — no API key, trial exhausted, `X-Payment` header present.

```
Request → main fetch()
  → No X-Oracle-Key → keyless path
  → X-Payment header present (base64 or raw JSON)
  → verifyPaymentAnyFormat(request, env, paymentHeader)
    → Try verifyX402Payment (direct on-chain)
      → eth_getTransactionReceipt → verify USDC Transfer event
      → eth_getBlockByNumber → verify block age < 300s
      → Check replay: x402_used:{txHash} KV → not found → valid
    → Payment verified
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
  → Response 200 with receipt + Payment-Response header
  → Deferred: store x402_used:{txHash}, increment x402_payment_count
```

**Key behaviors**: Accepts both base64-encoded and raw JSON payment headers. Replay protection via KV with 600s TTL. Two RPC calls per verification (receipt + block timestamp).

## Path 3b: 402 Payment Required

When no key, no payment, and trial exhausted:

```
Request → No key, no payment, trial exhausted
  → ORACLE_PAYMENT_ADDRESS set?
    → Yes → build402Payload() + buildX402ScanPayload()
    → Response 402 with x402 payment instructions + agent_upgrade_paths
  → ORACLE_PAYMENT_ADDRESS not set?
    → Response 429 RATE_LIMITED
```

## MCP Tool Call Path

`POST /mcp` — JSON-RPC 2.0 `tools/call` with `get_market_status`.

```
Request → handleMcp(request, env, ctx)
  → Parse JSON-RPC 2.0 envelope
  → Method: tools/call, tool: get_market_status
  → Optional: soft auth via Bearer token (failure = anonymous)
  → buildSignedReceipt(mic, env, now, expiresAt, 'live')
  → Wrap in JSON-RPC result with type: 'text' content block
  → Deferred: MCP client tracking, tool call counter, telemetry
```

**Key behaviors**: Same `buildSignedReceipt` as REST — identical 4-tier fail-closed. MCP handler has its own error format (JSON-RPC errors, never REST format). Unauthenticated access always allowed (soft auth).
