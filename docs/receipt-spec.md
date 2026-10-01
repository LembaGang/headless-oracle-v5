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
  "halt_detection": "active",
  "coverage":      "{\"determination_tier\":1,\"consulted\":[\"manual_override_kv\",\"realtime_halt_feed_via_override\",\"schedule\"],\"not_consulted\":[],\"realtime_halt_feed_scope\":[\"XNAS\",\"XNYS\"],\"unknown_reason\":null,\"feed_state\":\"live\",\"feed_last_run\":\"2026-03-02T14:29:47.000Z\"}",
  "receipt_mode":  "live",
  "schema_version": "v5.0",
  "public_key_id": "key_2026_v1",
  "signature":     "<128-char hex>"
}
```

**Signed fields** (alphabetical; exactly `canonical_payload_spec.receipt_fields` at `/v5/keys`):
`coverage`, `expires_at`, `halt_detection`, `issued_at`, `issuer`, `mic`, `public_key_id`, `receipt_id`, `receipt_mode`, `schema_version`, `source`, `status`

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

**Signed fields** (alphabetical; exactly `canonical_payload_spec.override_fields`):
`coverage`, `expires_at`, `halt_detection`, `issued_at`, `issuer`, `mic`, `public_key_id`, `reason`, `receipt_id`, `receipt_mode`, `schema_version`, `source`, `status`

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
| `halt_detection` | enum | Market receipts | `active` or `schedule_only`: what intraday halt detection is configured for this MIC. It does not say whether a halt feed was live at this determination; `coverage` says that. |
| `coverage` | string | Market receipts | A JSON-encoded string inside the signed bytes. Parse it with `JSON.parse` only after the signature verifies. Members, in this order: `determination_tier` (0 = manual override, 1 = schedule, 2 = fail-closed fallback), `consulted`, `not_consulted`, `realtime_halt_feed_scope`, `unknown_reason` (null unless the status is `UNKNOWN`), `feed_state` (`live`, `stale`, `failed`, `absent` or `not_covered`), `feed_last_run`. `/v5/keys` `canonical_payload_spec.coverage_note` is the authoritative description. |
| `receipt_mode` | enum | Market receipts | One key signs every receipt type. `demo` is served by `/v5/demo`. `live` is served by `/v5/status` (keyed, x402-paid and the keyless trial alike), `/v5/batch`, MCP `get_market_status`, and the free, unauthenticated `/v1/status/{MIC}` and `/v1/safe-to-trade/sample`. `receipt_mode` therefore says which door issued the receipt; it is not an authentication signal. |
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
2. Keep only the fields named for its receipt type in `/v5/keys` `canonical_payload_spec` (`receipt_fields`, `override_fields` or `health_fields`). Served responses also carry unsigned wrapper fields (for example `receipt` and `discovery_url`); they are not signed and must not be included
3. Sort the keys with JavaScript's default sort, which orders by UTF-16 code unit. Every field name is ASCII, so this equals code point order
4. Serialize with `JSON.stringify`: no whitespace, no indentation. Every value is a string; the signer rejects any other type
5. Encode as UTF-8 bytes

The canonical bytes are exactly what `JSON.stringify` produces over that sorted, all-string object (`signPayload` in the reference worker). A verifier written in another language must reproduce `JSON.stringify` string escaping. In particular, `JSON.stringify` emits non-ASCII characters as raw UTF-8, not as `\uXXXX` escapes. In Python that means `ensure_ascii=False`; the default `ensure_ascii=True` produces different bytes and the signature will not verify.

```python
import json

def canonical_payload(receipt: dict, fields: list[str]) -> bytes:
    # fields: the list for this receipt type from /v5/keys canonical_payload_spec
    payload = {k: receipt[k] for k in sorted(fields) if k in receipt}
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
```

Test vector (one non-ASCII character, U+00E9, written in source only as the escape `\u00e9`):

| Serializer | Output | UTF-8 bytes (hex) |
|---|---|---|
| Node `JSON.stringify({a:'\u00e9x'})` | `{"a":"éx"}` (the character itself) | `7b2261223a22c3a978227d` |
| Python `json.dumps({'a':'\u00e9x'}, separators=(',',':'), sort_keys=True)` | `{"a":"\u00e9x"}` (escaped) | `7b2261223a225c753030653978227d` |
| the same with `ensure_ascii=False` | `{"a":"éx"}` (the character itself) | `7b2261223a22c3a978227d` |

Only the first and third agree.

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
2. Check expiry (see "Expiry boundary" below)
3. Fetch public key for public_key_id from {issuer}/v5/keys
4. Construct canonical_payload(receipt)
5. Verify Ed25519(signature, canonical_payload, public_key)
6. If any step fails → reject the receipt; treat status as UNKNOWN/CLOSED
```

### Expiry boundary

The implementations examined on 2026-10-01 do not agree on whether a receipt is still valid at the instant `now == expires_at`. Every one of them rejects a receipt once `now > expires_at`; they differ only at equality:

| Implementation | Rule found | Valid at equality |
|---|---|---|
| `@headlessoracle/verify@1.0.2` (npm; `dist/index.js` line 13, `expiresAt <= now` returns `EXPIRED`) | valid only while `now < expires_at` | no |
| `headless-oracle==0.1.1` (PyPI; `headless_oracle/verify.py` line 159, `current_dt > expires_at` returns `EXPIRED`) | valid while `now <= expires_at` | yes |
| `@headlessoracle/sdk` (in this repository, unpublished; `packages/sdk-typescript/src/index.ts` line 265, `now > expiresAt`) | valid while `now <= expires_at` | yes |
| `headless-oracle-sdk` (in this repository, unpublished; `packages/sdk-python/headless_oracle/client.py` line 130, `now > expires_at`) | valid while `now <= expires_at` | yes |
| `POST /v5/verify` on the reference worker (`verifyReceiptDetailed`, valid only if `expiresMs > nowMs`) | valid only while `now < expires_at` | no |

This document records the difference and does not choose between the two rules.

The published Python package canonicalises with `json.dumps(..., sort_keys=True, separators=(",", ":"))` and the default `ensure_ascii=True` (`headless_oracle/verify.py` line 106), as does the in-repository `headless-oracle-sdk` (`client.py` line 141). For receipts whose signed values are all ASCII the bytes are identical; they would differ for a non-ASCII value (see the test vector above).

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
    "receipt_fields":  ["coverage", "expires_at", "halt_detection", "issued_at", "issuer", "mic", "public_key_id", "receipt_id", "receipt_mode", "schema_version", "source", "status"],
    "override_fields": ["coverage", "expires_at", "halt_detection", "issued_at", "issuer", "mic", "public_key_id", "reason", "receipt_id", "receipt_mode", "schema_version", "source", "status"],
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
| v5.0 | 2026-10-01 | This document now lists `halt_detection` (signed since `fd13ec3`, 2026-03-23) and `coverage` (signed since `19ccb28`, 2026-09-07). `schema_version` remained `v5.0` across these changes. Signed-field changes made under `v5.0`, from `git log -S` and the `canonical_payload_spec` lists at each commit: `cb914de` (2026-02-22) `terms_hash` renamed `schema_version`; `53284b2` (2026-03-01) `receipt_mode` added to market and override receipts; `86b18f7` (2026-03-02) `issuer` added to market, override and health receipts; `fd13ec3` (2026-03-23) `halt_detection` added to market and override receipts; `d3a0193` (2026-06-16) a new `safe_to_trade_fields` list for the `/v1/safe-to-trade` receipt; `19ccb28` (2026-09-07) `coverage` added to market and override receipts. Also corrected: the canonical payload is built from the `canonical_payload_spec` field list, the sort is JavaScript's default, the Python example sets `ensure_ascii=False`, `receipt_mode` is described by the endpoint that issues it, and the expiry boundary is stated as found. No version bump. |
