# SMA Protocol v1.0 — Specification

**Version**: 1.0.0
**Status**: Stable
**License**: Apache 2.0

---

## 1. Receipt Schema

An SMA receipt is a JSON object. All fields listed below are required.

| Field | Type | Description |
|---|---|---|
| `mic` | string | ISO 10383 Market Identifier Code (e.g. `"XNYS"`) |
| `status` | string | See Section 2 — Status Enum |
| `timestamp` | string | ISO 8601 UTC datetime of receipt issuance (e.g. `"2026-03-17T14:30:00.000Z"`) |
| `expires_at` | string | ISO 8601 UTC datetime after which the receipt must not be acted on |
| `issuer` | string | FQDN of the oracle operator (e.g. `"headlessoracle.com"`) |
| `key_id` | string | Identifier for the signing key used; matches `key_id` in the key registry |
| `receipt_mode` | string | `"demo"` or `"live"` — see Section 6 |
| `schema_version` | string | Protocol schema version identifier (e.g. `"v5.0"`) |
| `public_key_id` | string | Hex-encoded Ed25519 public key used to sign this receipt |
| `signature` | string | Hex-encoded Ed25519 signature over the canonical payload (Section 4) |

Additional fields (e.g. `receipt_id`, `source`, `reason`) MAY be present. If present, they
MUST be included in the canonical payload and MUST be covered by the signature.

---

## 2. Status Enum

| Value | Meaning |
|---|---|
| `OPEN` | The market is currently in a trading session |
| `CLOSED` | The market is outside trading hours |
| `HALTED` | Trading has been suspended (e.g. circuit breaker, operator override) |
| `UNKNOWN` | The oracle cannot determine state with confidence |

Consumers MUST treat `UNKNOWN` identically to `CLOSED`. It is never safe to act on an
indeterminate state. See Section 8 for consumer requirements.

---

## 3. TTL

```
expires_at = timestamp + 60 seconds
```

Receipts are valid for 60 seconds from issuance. This prevents a cached `OPEN` receipt from
being acted on after a market close event. Consumers MUST reject receipts where
`now > expires_at`.

The 60-second window is intentionally short. Agents that need continuous state must re-fetch;
this is by design.

---

## 4. Canonical Payload Construction

The canonical payload is the byte sequence that is signed. It is constructed as follows:

1. Take all fields from the receipt object **except** `signature`.
2. Sort the remaining keys **alphabetically** (lexicographic, case-sensitive, ascending).
3. Serialize to JSON with **no whitespace**: use `","` as item separator and `":"` as key separator.
4. Encode the resulting string as **UTF-8 bytes**.

Example (abbreviated):

```json
{"expires_at":"2026-03-17T14:31:00.000Z","issuer":"headlessoracle.com","key_id":"primary","mic":"XNYS","public_key_id":"03dc2799...","receipt_mode":"live","schema_version":"v5.0","status":"OPEN","timestamp":"2026-03-17T14:30:00.000Z"}
```

The alphabetical sort requirement eliminates ambiguity caused by insertion-order-dependent
serializers. Any conforming implementation in any language will produce identical bytes for
the same logical receipt.

---

## 5. Signing Algorithm

- **Algorithm**: Ed25519 (RFC 8032)
- **Input**: UTF-8 encoded canonical payload bytes (Section 4)
- **Output**: 64-byte signature, hex-encoded, stored in the `signature` field

Implementations MUST use a deterministic Ed25519 implementation. Non-deterministic signing
(e.g. ECDSA without RFC 6979) is not conforming.

---

## 6. `receipt_mode` Field

`receipt_mode` distinguishes receipts intended for production use from demonstration receipts:

- `"live"` — receipt from a production, authenticated endpoint; suitable for agent decisions
- `"demo"` — receipt from a public demonstration endpoint; must not be used for trade execution

This field is part of the signed canonical payload. An adversary cannot strip or flip it
without invalidating the signature.

---

## 7. Issuer Field and Key Discovery

The `issuer` field is the FQDN of the oracle operator (e.g. `"headlessoracle.com"`).

Agents resolve the public key as follows:

1. **Primary**: `GET https://{issuer}/.well-known/oracle-keys.json` (RFC 8615)
2. **Fallback**: `GET https://{issuer}/v5/keys`

The `/.well-known/oracle-keys.json` response MUST include:

```json
{
  "keys": [
    {
      "key_id": "<string>",
      "algorithm": "Ed25519",
      "format": "hex",
      "public_key": "<hex-encoded 32-byte public key>",
      "valid_from": "<ISO 8601 datetime>",
      "valid_until": "<ISO 8601 datetime | null>"
    }
  ]
}
```

`valid_until: null` means no scheduled expiry. When key rotation is planned, operators MUST
set `valid_until` before rotating — giving consumers advance notice.

---

## 8. Consumer Requirements

A conforming SMA consumer MUST:

1. Fetch the issuer's public key via `/.well-known/oracle-keys.json` (or use a pre-configured key)
2. Reconstruct the canonical payload per Section 4
3. Verify the Ed25519 signature before acting on any status field
4. Reject any receipt where `now > expires_at`
5. Treat `UNKNOWN` status as `CLOSED` — never act on indeterminate state
6. Check `receipt_mode`: reject `"demo"` receipts for production decisions
7. On any network timeout or verification failure: default to `UNKNOWN` (fail closed)

---

## 9. Changelog

| Version | Date | Notes |
|---|---|---|
| 1.0.0 | 2026-03-17 | Initial stable release |
