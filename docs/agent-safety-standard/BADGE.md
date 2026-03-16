# APTS Compliance Badge

## Badge

[![APTS v1.0 Compliant](https://img.shields.io/badge/APTS-v1.0%20Compliant-green)](https://headlessoracle.com/v5/compliance)

```markdown
[![APTS v1.0 Compliant](https://img.shields.io/badge/APTS-v1.0%20Compliant-green)](https://headlessoracle.com/v5/compliance)
```

---

## What the badge means

A project displaying this badge asserts that the oracle it uses passes all 6 checks
defined in the [Agent Pre-Trade Safety Standard v1.0](./STANDARD.md):

1. Returns a Signed Market Status Attestation on every request
2. Exposes circuit breaker status via the `source` field
3. Supports settlement window verification (instrument-level check)
4. Issues receipts with a signed `expires_at` TTL field
5. Signs all receipts with Ed25519 (verifiable via public key)
6. Returns UNKNOWN (not OPEN) on any infrastructure failure — fail-closed by design

The badge is not self-declared — it links directly to the live compliance endpoint
where any agent or human can verify the assertion at runtime.

---

## How to verify

The compliance endpoint returns a machine-readable result for all 6 checks:

```
GET https://headlessoracle.com/v5/compliance
```

Expected response shape:

```json
{
  "standard": "Agent Pre-Trade Safety Standard",
  "version": "1.0.0",
  "checks": [
    { "id": "signed_attestation",   "status": "pass" },
    { "id": "circuit_breaker",      "status": "pass" },
    { "id": "settlement_window",    "status": "pass" },
    { "id": "receipt_freshness",    "status": "pass" },
    { "id": "signature_verification","status": "pass" },
    { "id": "fail_closed",          "status": "pass" }
  ],
  "overall": "pass"
}
```

An agent integrating Headless Oracle can call this endpoint before any session to
confirm the oracle it is about to rely on has not regressed on its safety guarantees.

---

## Verify from the command line

```bash
curl -s https://headlessoracle.com/v5/compliance | jq '.overall'
# "pass"

# Assert all individual checks pass
curl -s https://headlessoracle.com/v5/compliance \
  | jq '[.checks[] | select(.status != "pass")] | length == 0'
# true
```

---

## Adding the badge to your project

Copy the Markdown snippet above into your project's README. The badge links to the
live compliance endpoint so reviewers can verify the claim without reading your code.

If you are building an agent that integrates Headless Oracle, consider adding this
to your README to signal to downstream consumers that your agent's oracle integration
meets the APTS baseline.

---

## For oracle implementors

If you have built a conforming oracle (not Headless Oracle) and want to display this
badge, implement the `/v5/compliance` response contract described above and update
the badge link to point to your endpoint. The standard is Apache 2.0 — no permission
required to implement or assert conformance.
