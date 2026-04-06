# x402 SDK / Ampersend Compatibility Report

**Date**: April 6, 2026
**Source**: github.com/coinbase/x402 (canonical x402 SDK), github.com/edgeandnode/ampersend-sdk

## Summary

The x402 protocol has two versions. Our server supports both — agents using either
`@coinbase/x402` (v1 or v2) or Ampersend SDK can pay us. This document maps the
exact format differences and confirms our compatibility.

Ampersend uses x402 under the hood — it does NOT define its own payment format.
Any x402-compatible server works with Ampersend automatically.

---

## Header Names

| Direction | x402 v1 | x402 v2 | Our Server |
|---|---|---|---|
| Client → Server (payment) | `X-PAYMENT` | `PAYMENT-SIGNATURE` | Reads both via `getPaymentHeader()` ✅ |
| Server → Client (402) | Body JSON | `PAYMENT-REQUIRED` header (base64) | Both: body JSON + `Payment-Required` header ✅ |
| Server → Client (settlement) | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` | Not yet returned ⚠️ |

**Status**: Payment acceptance works for both v1 and v2 clients. Missing: we don't
return a `Payment-Response` or `X-Payment-Response` header on successful settlement.
The x402 SDK `wrapFetchWithPayment()` doesn't require this header for basic operation
(it checks HTTP 200), but the header confirms settlement details to the client.

---

## Header Value Format

Both v1 and v2 use **base64-encoded JSON** for all headers.

The x402 SDK's encoding function:
```typescript
// From @x402/core/utils
function safeBase64Encode(data: string): string {
  const bytes = new TextEncoder().encode(data);
  const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
  return btoa(binaryString);
}
```

Our server decodes with `atob()` after normalizing URL-safe base64 (`-` → `+`, `_` → `/`).
Compatible. ✅

We also accept raw JSON via the `X-Payment` header (our direct on-chain path). The x402
SDK never sends raw JSON — it always base64-encodes. No conflict.

---

## 402 Response Body (PaymentRequired)

### x402 v1 Format (what @coinbase/x402 v1 expects)

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "1000",
    "asset": "0x...",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "resource": "https://...",
    "description": "...",
    "mimeType": "application/json",
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

### x402 v2 Format (what @coinbase/x402 v2 expects)

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "1000",
    "asset": "0x...",
    "payTo": "0x...",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USD Coin", "version": "2" }
  }],
  "resource": { "url": "...", "description": "...", "mimeType": "..." }
}
```

### Our Server (`buildMainnetFacilitatorPayload`)

```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "1000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3",
    "maxTimeoutSeconds": 300,
    "resource": "https://headlessoracle.com/v5/status?mic=XNYS",
    "description": "Signed market-state receipt...",
    "mimeType": "application/json",
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

**Compatibility**: Our format is x402 v1. The SDK's `wrapFetchWithPayment()` reads
`x402Version` from the 402 body and dispatches to the v1 code path, which expects
`maxAmountRequired` (not `amount`) and `network: "base"` (not CAIP-2). ✅

---

## EIP-712 Domain

The `extra` field in payment requirements carries the EIP-712 domain parameters:

| Parameter | Base Mainnet USDC | Base Sepolia USDC | Our Server |
|---|---|---|---|
| `name` | `"USD Coin"` | `"USDC"` | `"USD Coin"` ✅ |
| `version` | `"2"` | `"2"` | `"2"` ✅ |
| `chainId` | `8453` | `84532` | Derived from network |
| `verifyingContract` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` ✅ |

**Critical note**: Base mainnet USDC uses `name: "USD Coin"`, NOT `"USDC"`. The testnet
uses `"USDC"`. If the name is wrong, EIP-712 domain separator won't match and every
signature will be invalid. Our server sends the correct name. ✅

---

## Payment Payload (what the client sends back)

### x402 v1 PaymentPayload

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x<payer>",
      "to": "0x<payTo>",
      "value": "1000",
      "validAfter": "1712345089",
      "validBefore": "1712345149",
      "nonce": "0x<random-32-bytes>"
    }
  }
}
```

### x402 v2 PaymentPayload

```json
{
  "x402Version": 2,
  "accepted": { ... },
  "payload": {
    "signature": "0x...",
    "authorization": { ... }
  }
}
```

Our server sends this payload to the CDP facilitator at
`api.cdp.coinbase.com/platform/v2/x402/verify` as:
```json
{
  "x402Version": <from payload>,
  "paymentPayload": <decoded payload>,
  "paymentRequirements": <our requirements object>
}
```

The facilitator handles both v1 and v2 payloads. ✅

---

## Network Identifiers

| Surface | Value | Standard |
|---|---|---|
| x402 v1 SDK | `"base-sepolia"`, `"base"` | x402 short names |
| x402 v2 SDK | `"eip155:8453"`, `"eip155:84532"` | CAIP-2 |
| Our 402 body | `"base"` | x402 v1 short name |
| Our verifyX402Payment | Accepts: `"base"`, `"base-mainnet"`, `"eip155:8453"` | All three ✅ |
| Our /.well-known/x402.json | `"base"` | x402 v1 short name |
| Our /.well-known/agent.json | `"eip155:8453"` | CAIP-2 |

**Note**: The network name mismatch between x402.json (`"base"`) and agent.json
(`"eip155:8453"`) is cosmetic — different surfaces use different conventions. Our
payment verification accepts all three forms. No code change needed.

---

## CDP Facilitator URL

| | URL |
|---|---|
| x402 SDK default | `https://api.cdp.coinbase.com/platform/v2/x402` |
| Our server | `https://api.cdp.coinbase.com/platform/v2/x402` ✅ |

Matching. ✅

---

## Ampersend-Specific Details

Ampersend (`edgeandnode/ampersend-sdk`) wraps x402 with higher-level abstractions:

- `X402Treasurer`: decides whether to authorize a payment (budget/policy layer)
- `X402Wallet`: creates the EIP-712 signature (delegates to x402 SDK)
- A2A middleware: intercepts `PAYMENT_REQUIRED` task status in Agent-to-Agent protocol
- MCP proxy: adds x402 payment to any MCP server transparently

Ampersend does NOT define its own header format. It uses standard x402 headers.
Any server that works with `@coinbase/x402` works with Ampersend. ✅

---

## Gaps / Action Items

### 1. Payment-Response header (low priority)
We don't return `Payment-Response` or `X-Payment-Response` on successful settlement.
The x402 SDK doesn't require it for basic `wrapFetchWithPayment()` operation (checks
HTTP 200), but it's part of the spec. Add when we want full spec compliance.

### 2. x402 v2 support in 402 body (medium priority)
Our 402 body uses `x402Version: 1`. The v2 SDK can parse v1 responses (it checks
`x402Version` and dispatches), but native v2 support would be cleaner. Key differences:
- `amount` instead of `maxAmountRequired`
- `resource` as object instead of string
- `network` as CAIP-2 (`eip155:8453`) instead of short name

Not blocking — the SDK handles version dispatch. Upgrade when v2 becomes dominant.

### 3. Permit2 flow (future)
x402 v2 supports Permit2 as an alternative to EIP-3009 (for tokens without
`transferWithAuthorization`). USDC on Base supports EIP-3009 natively, so this
is not needed for our current use case.

---

## Conclusion

**Headless Oracle is fully compatible with @coinbase/x402 SDK and Ampersend SDK.**

An agent using `wrapFetchWithPayment()` from `@coinbase/x402` will:
1. GET /v5/status → receive HTTP 402 with x402 v1 body
2. Parse `accepts[0]`, extract EIP-712 domain from `extra`
3. Sign `TransferWithAuthorization` with their wallet
4. Retry with `X-PAYMENT` header (v1) — our server reads it via `getPaymentHeader()`
5. Our server decodes, sends to CDP facilitator for verify + settle
6. CDP confirms → we return HTTP 200 with signed receipt

No code changes needed for basic compatibility. The three gaps above are spec
polish, not blockers.
