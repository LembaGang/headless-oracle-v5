# Headless Oracle — Open Receipt Specification

**Version**: v5.0
**Status**: Active
**Canonical source**: https://headlessoracle.com/v5/keys

This document defines the signed receipt format produced by Headless Oracle V5. The format is open — any oracle operator can implement it. An agent that understands this spec can consume receipts from any compliant oracle without prior configuration.

---

## Overview

A receipt is a JSON object asserting the open/closed status of a financial exchange at a specific moment in time. The oracle signs the receipt with an Ed25519 private key. Consumers verify the signature against the oracle's public key.

Receipts are:
- **Self-describing** — the `issuer` field identifies the oracle; the `public_key_id` field identifies which key signed it
- **Time-bounded** — receipts expire 60 seconds after issuance; stale receipts must not be acted on
- **Tamper-evident** — any field modification invalidates the signature
- **Fail-closed** — `UNKNOWN` status means the oracle encountered an error; consumers must treat it as `CLOSED`

---

## Receipt Types

### Market Receipt (standard)

Produced by `/v5/demo` and `/v5/status`.

```json
{
  "receipt_id":    "550e8400-e29b-41d4-a716-446655440000",
  "issued_at":     "2026-03-02T14:30:00.000Z",
  "expires_at":    "2026-03-02T14:31:00.000Z",
  "issuer":        "headlessoracle.com",
  "mic":           "XNYS",
  "status":        "OPEN",
  "source":        "SCHEDULE",
  "receipt_mode":  "live",
  "schema_version": "v5.0",
  "public_key_id": "key_2026_v1",
  "signature":     "<128-char hex>"
}
```

**Signed fields** (alphabetical, all fields except `signature`):
`expires_at`, `issued_at`, `issuer`, `mic`, `public_key_id`, `receipt_id`, `receipt_mode`, `schema_version`, `source`, `status`

### Override Receipt

When a manual circuit breaker is active. Adds one field:

```json
{
  ...,
  "status": "HALTED",
  "source": "OVERRIDE",
  "reason": "NYSE circuit breaker L1 triggered",
  ...
}
```

**Signed fields** (alphabetical):
`expires_at`, `issued_at`, `issuer`, `mic`, `public_key_id`, `reason`, `receipt_id`, `receipt_mode`, `schema_version`, `source`, `status`

### Health Receipt

Produced by `/v5/health`. System-level liveness probe — not exchange-specific.

```json
{
  "receipt_id":    "550e8400-e29b-41d4-a716-446655440001",
  "issued_at":     "2026-03-02T14:30:00.000Z",
  "expires_at":    "2026-03-02T14:31:00.000Z",
  "issuer":        "headlessoracle.com",
  "status":        "OK",
  "source":        "SYSTEM",
  "public_key_id": "key_2026_v1",
  "signature":     "<128-char hex>"
}
```

Note: no `mic`, no `schema_version`, no `receipt_mode` — health is system-level.

**Signed fields** (alphabetical):
`expires_at`, `issued_at`, `issuer`, `public_key_id`, `receipt_id`, `source`, `status`

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `receipt_id` | UUID string | Yes | Unique identifier. Useful for deduplication and audit logs. |
| `issued_at` | ISO 8601 UTC | Yes | When the oracle generated this receipt. |
| `expires_at` | ISO 8601 UTC | Yes | TTL boundary. Do not act on receipts after this time. Standard TTL is 60 seconds. |
| `issuer` | string | Yes | Domain of the oracle. Resolve `{issuer}/v5/keys` to find the public key. |
| `mic` | string | Market receipts | ISO 10383 Market Identifier Code (e.g. `XNYS`). |
| `status` | enum | Yes | `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN`. |
| `source` | enum | Yes | `SCHEDULE`, `OVERRIDE`, or `SYSTEM`. |
| `reason` | string | Override only | Human-readable explanation of the override. |
| `receipt_mode` | enum | Market receipts | `demo` (unauthenticated endpoint) or `live` (authenticated endpoint). |
| `schema_version` | string | Market receipts | Receipt schema version. Current: `v5.0`. |
| `public_key_id` | string | Yes | Identifies which key in the key registry signed this receipt. |
| `signature` | hex string | Yes | 128-character hex-encoded Ed25519 signature. |

---

## Status Values

| Status | Meaning for consumers |
|--------|----------------------|
| `OPEN` | Market is trading. Safe to proceed. |
| `CLOSED` | Market is not trading. Halt execution. |
| `HALTED` | Trading halt in effect (circuit breaker or manual override). Halt execution. |
| `UNKNOWN` | Oracle internal error — the oracle could not determine status safely. **Must be treated as `CLOSED`.** |

**The fail-closed rule is non-negotiable**: `UNKNOWN` must always cause a halt. An oracle returning `UNKNOWN` has detected a condition where asserting any status would be unsafe.

---

## Source Values

| Source | Meaning |
|--------|---------|
| `SCHEDULE` | Status derived from the market's published trading calendar. |
| `OVERRIDE` | A manual circuit breaker is active. See `reason` field. |
| `SYSTEM` | Oracle infrastructure issued this receipt (health receipts, and UNKNOWN receipts when schedule computation fails). |

---

## Signing Specification

### Algorithm
Ed25519 (RFC 8032). 32-byte private key, 32-byte public key, 64-byte signature.

### Canonical payload construction

1. Take the receipt object
2. Remove the `signature` field
3. Sort all remaining keys alphabetically (Unicode codepoint order)
4. Serialize with `JSON.stringify` — no whitespace, no indentation
5. Encode as UTF-8 bytes

```python
import json

def canonical_payload(receipt: dict) -> bytes:
    payload = {k: v for k, v in receipt.items() if k != 'signature'}
    return json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
```

### Signature encoding
The 64-byte Ed25519 signature is hex-encoded as a 128-character lowercase string.

### Public key discovery
1. Read `issuer` from the receipt
2. Fetch `https://{issuer}/v5/keys` (or `/.well-known/oracle-keys.json`)
3. Find the entry where `key_id` matches `public_key_id`
4. Use the `public_key` (hex-encoded 32-byte Ed25519 public key) to verify

---

## Verification Algorithm

```
1. Assert all required fields are present
2. Assert current time < expires_at
3. Fetch public key for public_key_id from {issuer}/v5/keys
4. Construct canonical_payload(receipt)
5. Verify Ed25519(signature, canonical_payload, public_key)
6. If any step fails → reject the receipt; treat status as UNKNOWN/CLOSED
```

### Reference implementations
- JavaScript/TypeScript: [`@headlessoracle/verify`](https://npmjs.com/package/@headlessoracle/verify) (Web Crypto API, zero deps)
- Python: [`headless-oracle`](https://pypi.org/project/headless-oracle) (PyNaCl)

---

## Key Registry Format

`GET {issuer}/v5/keys` returns:

```json
{
  "keys": [
    {
      "key_id":     "key_2026_v1",
      "algorithm":  "Ed25519",
      "format":     "hex",
      "public_key": "<64-char hex>",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": null
    }
  ],
  "canonical_payload_spec": {
    "description":     "Keys sorted alphabetically, JSON.stringify with no whitespace, UTF-8 encoded.",
    "receipt_fields":  ["expires_at", "issued_at", "issuer", "mic", "public_key_id", "receipt_id", "receipt_mode", "schema_version", "source", "status"],
    "override_fields": ["expires_at", "issued_at", "issuer", "mic", "public_key_id", "reason", "receipt_id", "receipt_mode", "schema_version", "source", "status"],
    "health_fields":   ["expires_at", "issued_at", "issuer", "public_key_id", "receipt_id", "source", "status"]
  }
}
```

The `canonical_payload_spec` is the authoritative field list for each receipt type. Verifiers should use this to determine which fields are included in the signing payload.

---

## Well-Known Endpoint

Compliant oracles SHOULD serve key metadata at `/.well-known/oracle-keys.json` (RFC 8615):

```json
{
  "service": "headless-oracle",
  "spec": "https://headlessoracle.com/v5/keys",
  "keys": [
    {
      "key_id": "key_2026_v1",
      "algorithm": "Ed25519",
      "format": "hex",
      "public_key": "<64-char hex>",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": null
    }
  ]
}
```

---

## Implementing a Compliant Oracle

A compliant oracle implementation MUST:

1. Produce receipts with all required fields for the applicable receipt type
2. Sign the canonical payload using Ed25519 (alphabetical key sort, no whitespace JSON, UTF-8)
3. Set `expires_at` to a value no more than 300 seconds in the future (recommended: 60s)
4. Serve a key registry at `{base}/v5/keys` matching the format above
5. Return `status: UNKNOWN` (not an error body) when market status cannot be determined
6. Return `source: SYSTEM` on all UNKNOWN receipts
7. Include the `issuer` field set to the oracle's canonical domain

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v5.0 | 2026-02-22 | Initial open specification. Renamed `terms_hash` → `schema_version`. Added `expires_at`. |
| v5.0 | 2026-03-01 | Added `receipt_mode`. Added `data_coverage_years` to schedule response. |
| v5.0 | 2026-03-02 | Added `issuer` to all signed receipt types. |
