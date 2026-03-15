# Signed Market Attestation (SMA) Protocol Specification

**Version:** 1.0.0
**Status:** Active
**License:** Apache 2.0
**Canonical source:** https://headlessoracle.com/v5/keys

---

## Abstract

A Signed Market Attestation (SMA) is a cryptographically signed JSON object
asserting the open/closed/halted status of a financial exchange at a specific
moment in time. This specification defines the canonical field set, serialization
rules, signing algorithm, and verification procedure.

The SMA format is **vendor-neutral**. Any operator may implement a conforming oracle.
Consumers that implement this specification can verify receipts from any conforming
oracle without prior coordination.

---

## Motivation

Autonomous agents executing financial trades need a tamper-evident, time-bounded
signal they can verify without trusting a specific operator. Existing approaches —
polling exchange APIs, checking timezone libraries, or trusting broker connectivity —
all fail at one or more of:

- **Tamper-evidence**: a MITM or caching layer can substitute an OPEN signal
- **Time-bounding**: a cached OPEN status from 5 minutes ago is dangerous during
  circuit breaker events
- **Fail-closed**: HTTP 500 from a broker API gives no guidance — the agent can't
  distinguish "market is closed" from "API is down"

An SMA solves all three: the signature prevents substitution, `expires_at` enforces
freshness, and `status: "UNKNOWN"` is a well-defined HALT signal.

---

## Terminology

- **Oracle**: A service that produces SMAs
- **Issuer**: The operator of an oracle, identified by the `issuer` field
- **Consumer**: An agent, SDK, or system that receives and verifies SMAs
- **MIC**: ISO 10383 Market Identifier Code (e.g. `XNYS` = NYSE)
- **Receipt**: A single SMA instance

---

## Field Definitions

### Standard Market Receipt

| Field | Type | Required | Description |
|---|---|---|---|
| `receipt_id` | string (UUID v4) | Yes | Globally unique identifier for this receipt |
| `issued_at` | string (ISO 8601 UTC) | Yes | Timestamp when the oracle generated this receipt |
| `expires_at` | string (ISO 8601 UTC) | Yes | Timestamp after which this receipt MUST NOT be acted on |
| `issuer` | string (domain) | Yes | Identifying domain of the oracle operator (e.g. `headlessoracle.com`) |
| `mic` | string | Yes | ISO 10383 Market Identifier Code for the attested exchange |
| `status` | string (enum) | Yes | Market status at `issued_at`. See Status Enum. |
| `source` | string (enum) | Yes | How the status was determined. See Source Enum. |
| `receipt_mode` | string (enum) | Yes | `"demo"` (unauthenticated) or `"live"` (authenticated) |
| `schema_version` | string | Yes | Schema version identifier (e.g. `"v5.0"`) |
| `public_key_id` | string | Yes | Identifier of the signing key. Resolves via `{issuer}/v5/keys` |
| `signature` | string (hex) | Yes | 128-character lowercase hex Ed25519 signature |

### Status Enum

| Value | Meaning | Consumer action |
|---|---|---|
| `OPEN` | Exchange is accepting orders | May proceed with trade checks |
| `CLOSED` | Exchange is not accepting orders (scheduled) | HALT — do not submit |
| `HALTED` | Exchange has been manually halted (circuit breaker) | HALT — log `reason` |
| `UNKNOWN` | Oracle could not determine status | HALT — treat as CLOSED |

**UNKNOWN is a first-class value, not an error.** A consumer that receives UNKNOWN
MUST halt. An oracle that returns UNKNOWN is functioning correctly — it is signalling
that the safe/closed state should be assumed.

### Source Enum

| Value | Meaning |
|---|---|
| `SCHEDULE` | Status computed from market calendar and timezone |
| `OVERRIDE` | Operator has manually applied a halt via the circuit-breaker override system |
| `SYSTEM` | Oracle infrastructure error — signing key unavailable or computation failed |

### Override Receipt (extends standard)

When `source = "OVERRIDE"`, one additional field is present:

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | string | Yes | Human-readable halt reason (e.g. `"NYSE circuit breaker L1"`) |

`reason` is part of the signed payload.

### Health Receipt

Produced by liveness endpoints. Omits `mic`, `status`, `source`,
`receipt_mode`, `schema_version`. Adds:

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `"OK"` | Yes | Oracle infrastructure is operational |
| `source` | `"SYSTEM"` | Yes | Fixed value for health receipts |

---

## Canonical Serialization

The canonical payload is the input to the signing and verification algorithm.

**Rules:**

1. Start with all receipt fields **except** `signature`
2. Sort the keys **alphabetically** (Unicode code point order)
3. Serialize as compact JSON: no whitespace between tokens
4. Encode as UTF-8 bytes

**Rationale:** JavaScript object key ordering is insertion-order-dependent.
Without a canonical form, any field reorder in a future refactor silently
invalidates all existing verifier implementations. Alphabetical sort is
deterministic across all languages and easy to implement.

**Example (market receipt, keys sorted):**

```json
{"expires_at":"2026-03-15T12:01:00.000Z","issued_at":"2026-03-15T12:00:00.000Z","issuer":"headlessoracle.com","mic":"XNYS","public_key_id":"key_2026_v1","receipt_id":"550e8400-e29b-41d4-a716-446655440000","receipt_mode":"live","schema_version":"v5.0","source":"SCHEDULE","status":"OPEN"}
```

This byte string is the message signed by the oracle and verified by consumers.

---

## Signing Algorithm

**Algorithm:** Ed25519 (RFC 8032)
**Key format:** 32-byte raw private key, hex-encoded in operator configuration
**Public key format:** 32-byte raw public key, hex-encoded, served at `{issuer}/v5/keys`

**Signing procedure (oracle):**

```python
import json
from nacl.signing import SigningKey

def sign_payload(fields: dict, private_key_hex: str) -> str:
    """
    Produce the hex-encoded Ed25519 signature for a receipt payload.
    fields: all receipt fields EXCEPT 'signature'
    """
    sorted_fields = dict(sorted(fields.items()))
    canonical     = json.dumps(sorted_fields, separators=(",", ":"))
    message       = canonical.encode("utf-8")
    signing_key   = SigningKey(bytes.fromhex(private_key_hex))
    signed        = signing_key.sign(message)
    return signed.signature.hex()
```

---

## Verification Algorithm

**Verification procedure (consumer):**

```python
import json
from nacl.signing import VerifyKey
from nacl.exceptions import BadSignatureError
from datetime import datetime, timezone

def verify_sma(receipt: dict, public_key_hex: str) -> tuple[bool, str]:
    """
    Verify a Signed Market Attestation.

    Returns (True, "") on success.
    Returns (False, reason) on failure — reason is a machine-readable string.

    Failure reasons:
      MISSING_FIELDS     — required field absent
      EXPIRED            — expires_at is in the past
      INVALID_SIGNATURE  — signature does not match payload
      INVALID_KEY_FORMAT — public key is malformed
    """
    # 1. Field presence check
    required = {"receipt_id", "issued_at", "expires_at", "issuer",
                "public_key_id", "signature"}
    missing = required - receipt.keys()
    if missing:
        return False, f"MISSING_FIELDS:{','.join(sorted(missing))}"

    # 2. Freshness check
    try:
        expires = datetime.fromisoformat(receipt["expires_at"].replace("Z", "+00:00"))
    except ValueError:
        return False, "MISSING_FIELDS:expires_at_invalid"
    if datetime.now(timezone.utc) >= expires:
        return False, "EXPIRED"

    # 3. Signature verification
    payload_fields = {k: v for k, v in receipt.items() if k != "signature"}
    sorted_fields  = dict(sorted(payload_fields.items()))
    canonical      = json.dumps(sorted_fields, separators=(",", ":"))
    message        = canonical.encode("utf-8")

    try:
        verify_key = VerifyKey(bytes.fromhex(public_key_hex))
        verify_key.verify(message, bytes.fromhex(receipt["signature"]))
    except ValueError:
        return False, "INVALID_KEY_FORMAT"
    except BadSignatureError:
        return False, "INVALID_SIGNATURE"

    return True, ""
```

**JavaScript (Web Crypto API — zero dependencies):**

```js
async function verifySma(receipt, publicKeyHex) {
  // 1. Freshness
  if (new Date(receipt.expires_at) <= new Date()) return { ok: false, reason: 'EXPIRED' };

  // 2. Canonical payload
  const { signature, ...rest } = receipt;
  const sorted    = Object.fromEntries(Object.entries(rest).sort());
  const canonical = JSON.stringify(sorted);
  const message   = new TextEncoder().encode(canonical);

  // 3. Import public key
  const keyBytes = Uint8Array.from(publicKeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'Ed25519' }, false, ['verify']
  );

  // 4. Verify
  const sigBytes = Uint8Array.from(signature.match(/.{2}/g).map(h => parseInt(h, 16)));
  const valid = await crypto.subtle.verify('Ed25519', key, sigBytes, message);
  return valid
    ? { ok: true }
    : { ok: false, reason: 'INVALID_SIGNATURE' };
}
```

---

## Public Key Discovery

Consumers can resolve the signing public key from the `issuer` field without
prior configuration:

1. Resolve `https://{issuer}/v5/keys`
2. Find the entry matching `key_id = receipt.public_key_id`
3. Extract `public_key` (hex-encoded 32-byte Ed25519 key)
4. Optionally cache the public key; re-fetch if `key_id` changes

**Well-known endpoint (RFC 8615):**

```
GET https://{issuer}/.well-known/oracle-keys.json
```

Returns the same key data in a standardised format suitable for web infrastructure
key discovery (service workers, reverse proxies, agent registries).

---

## Key Lifecycle

The key response includes lifecycle metadata:

```json
{
  "key_id":     "key_2026_v1",
  "algorithm":  "Ed25519",
  "format":     "hex",
  "public_key": "03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178",
  "valid_from": "2026-01-01T00:00:00Z",
  "valid_until": null
}
```

`valid_until: null` means no rotation is scheduled. Operators set `valid_until`
in advance of a key rotation to allow consumers to pre-fetch the incoming key.

---

## Error Codes

All SMA verification failures MUST produce one of these machine-readable codes:

| Code | Meaning |
|---|---|
| `MISSING_FIELDS` | One or more required fields absent from the receipt |
| `EXPIRED` | `expires_at` is in the past |
| `UNKNOWN_KEY` | `public_key_id` not found in the issuer's key registry |
| `INVALID_SIGNATURE` | Signature does not match the canonical payload |
| `KEY_FETCH_FAILED` | Could not retrieve public key from oracle |
| `INVALID_KEY_FORMAT` | Public key is not valid Ed25519 material |

---

## Verifiable Intent Compatibility

The SMA format is compatible with Verifiable Intent frameworks where an agent
must prove it checked market conditions before acting. An SMA can be included
as an environmental attestation in a Verifiable Intent payload:

```json
{
  "intent": "execute_trade",
  "pre_conditions": [
    {
      "type": "sma",
      "issuer": "headlessoracle.com",
      "mic": "XNYS",
      "required_status": "OPEN",
      "receipt": { "...": "full SMA receipt with signature" }
    }
  ]
}
```

A verifier can independently check the SMA signature and assert that the agent
had a valid OPEN receipt at the time of the trade decision.

---

## ERC-8183 Evaluator Compatibility

An SMA oracle is a natural ERC-8183 Evaluator for market-status-conditional Jobs.
See the [ERC-8183 Evaluator Specification](./erc-8183-evaluator-spec.md) for
the full mapping.

---

## Reference Implementations

| Implementation | Language | Package |
|---|---|---|
| Headless Oracle (oracle server) | TypeScript / Cloudflare Workers | [`headless-oracle-v5`](https://github.com/LembaGang/headless-oracle-v5) |
| Consumer SDK (JS/TS) | TypeScript | [`@headlessoracle/verify`](https://npmjs.com/package/@headlessoracle/verify) |
| Consumer SDK (Python) | Python | [`headless-oracle`](https://github.com/LembaGang/headless-oracle-python) |

---

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-03-15 | Initial specification |

---

## License

Copyright 2026 LembaGang / Headless Oracle contributors.

Licensed under the Apache License, Version 2.0.
See: https://www.apache.org/licenses/LICENSE-2.0
