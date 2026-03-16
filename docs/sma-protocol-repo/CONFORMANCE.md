# SMA Protocol v1.0 — Conformance

This document defines conformance requirements for oracle operators and consumers implementing
SMA v1.0. Conformance is self-declared; there is no certification authority.

---

## Oracle Operator Conformance

An SMA-conformant oracle operator MUST:

1. **Sign all market status responses** using Ed25519 over the canonical payload defined in
   SPEC.md Section 4. Unsigned responses are non-conforming regardless of content.

2. **Include `expires_at` in every signed receipt**, set to `timestamp + 60 seconds`.
   Receipts without `expires_at` cannot be safely cached or relayed by consumers.

3. **Serve the public key at `/.well-known/oracle-keys.json`** in the format specified in
   SPEC.md Section 7. Key discovery must not require prior configuration by the consumer.

4. **Support key rotation via `valid_until`**. When a key rotation is planned, the operator
   MUST set `valid_until` on the outgoing key before deploying the replacement. The gap
   between `valid_until` announcement and key rotation SHOULD be at least 24 hours.

5. **Return `UNKNOWN` (not `OPEN`) when market state cannot be determined with confidence**.
   This includes: missing holiday data for the current year, schedule computation errors,
   and any other indeterminate condition. Fail-closed behavior is a protocol requirement,
   not an implementation detail.

---

## Consumer Conformance

An SMA-conformant consumer MUST:

1. **Verify the Ed25519 signature before acting on any status field.** A receipt with an
   invalid or unverifiable signature MUST be treated as `UNKNOWN`.

2. **Reject receipts where `now > expires_at`.** Expired receipts MUST be treated as
   `UNKNOWN`. A consumer MUST NOT act on stale market state.

3. **Treat `UNKNOWN` status as `CLOSED`.** Any indeterminate state is unsafe to act on.
   This applies to: `status: "UNKNOWN"` in a valid receipt, failed signature verification,
   expired receipts, and network/fetch failures.

4. **Check `receipt_mode` before making production decisions.** A `receipt_mode: "demo"`
   receipt MUST NOT be used as the basis for trade execution or other production actions.

5. **Handle network timeouts as `UNKNOWN`.** A consumer that cannot reach the oracle within
   its timeout budget MUST default to `UNKNOWN` (fail closed), not to a cached prior state
   or an assumed open/closed condition.

---

## Conformance Test

The following procedure verifies a basic SMA implementation against the Headless Oracle
reference implementation.

### Step 1: Fetch a receipt

```sh
curl -s "https://headlessoracle.com/v5/demo?mic=XNYS" | jq .
```

Expected: JSON object with `mic`, `status`, `timestamp`, `expires_at`, `issuer`,
`key_id`, `receipt_mode`, `schema_version`, `public_key_id`, `signature` fields.

### Step 2: Fetch the public key

```sh
curl -s "https://headlessoracle.com/.well-known/oracle-keys.json" | jq .
```

Expected: `keys` array with at least one entry containing `public_key` (hex-encoded Ed25519).

### Step 3: Verify the receipt using @headlessoracle/verify (Node.js)

```js
import { verify } from '@headlessoracle/verify';

const receipt = await fetch('https://headlessoracle.com/v5/demo?mic=XNYS').then(r => r.json());

const result = await verify(receipt);
// result.valid === true for a fresh, correctly signed receipt
// result.reason === undefined on success
console.log(result);
```

### Step 4: Verify the receipt in Python

```python
import httpx
from headless_oracle import verify

receipt = httpx.get("https://headlessoracle.com/v5/demo?mic=XNYS").json()
result = verify(receipt)
# result.valid == True for a fresh, correctly signed receipt
print(result)
```

### Step 5: Verify TTL handling

Fetch a receipt, wait 61 seconds, then run verification again. A conformant verifier MUST
return `valid: false` with `reason: "EXPIRED"`.

### Step 6: Verify fail-closed on UNKNOWN

A conformant consumer MUST treat any receipt with `status: "UNKNOWN"` as `CLOSED`.
Test this by passing `status: "UNKNOWN"` in your consumer logic and confirming the consumer
halts rather than proceeds.

---

## Non-Conformance Failure Modes

| Failure | Classification |
|---|---|
| Acting on unsigned response | Critical — non-conformant |
| Acting on expired receipt | Critical — non-conformant |
| Treating UNKNOWN as OPEN | Critical — non-conformant |
| Using demo receipt for production decisions | High — non-conformant |
| Proceeding on network timeout without fallback | High — non-conformant |
| Not checking `receipt_mode` field | Medium — non-conformant |
