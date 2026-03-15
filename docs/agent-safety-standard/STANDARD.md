# Agent Pre-Trade Safety Standard

**Version:** 1.0.0-draft
**Status:** Public Draft
**License:** Apache 2.0
**Canonical URL:** https://github.com/LembaGang/headless-oracle-v5/blob/main/docs/agent-safety-standard/STANDARD.md

---

## Abstract

This document defines a minimum pre-trade safety checklist for autonomous AI agents
executing orders on financial exchanges. It is a vendor-neutral open standard.
Any conforming oracle implementation may be used to satisfy the requirements.

The standard is deliberately minimal. An agent that passes all six checks has
done the irreducible minimum before touching a live market. Additional checks
(position sizing, risk limits, slippage tolerance) are outside scope.

---

## Motivation

Autonomous AI agents are increasingly capable of submitting financial orders without
human review. The failure modes are well-documented: DST phantom hours, circuit
breaker events, exchange holidays, and stale cached status all produce the same
outcome — orders submitted into a closed or halted market, with losses ranging from
transaction fees to full position gap risk.

The cost of a correct pre-trade check is one API call and one cryptographic
verification, amortized across every trade. The cost of skipping it is unbounded.

This standard establishes a shared vocabulary and implementation checklist so that:

1. Agent frameworks can assert conformance
2. Audit logs can record which checks passed before each trade
3. Risk teams can verify agent behaviour without reading source code
4. The broader ecosystem can converge on a common baseline

---

## Scope

This standard applies to any autonomous or semi-autonomous agent that:

- Submits orders on regulated exchanges (NYSE, NASDAQ, LSE, TSE, etc.)
- Routes orders to DeFi protocols whose liquidity depends on TradFi market hours
- Schedules market-dependent workflows (rebalancing, reporting, settlement)

It does not apply to agents that exclusively operate in 24/7 markets with no
scheduled halts or exchange holidays, provided the agent has independently verified
that the target venue has no halt mechanism.

---

## Definitions

**Signed Attestation:** A JSON object asserting market state, signed with an
asymmetric key (Ed25519 or equivalent), including an expiry timestamp. See the
[Signed Market Attestation (SMA) specification](../sma-spec.md).

**Oracle:** A service that produces Signed Attestations. The reference
implementation is [Headless Oracle](https://headlessoracle.com).

**HALT condition:** Any of: `status = "CLOSED"`, `status = "HALTED"`,
`status = "UNKNOWN"`. An agent receiving a HALT condition MUST NOT submit orders.

**Fresh receipt:** A Signed Attestation whose `expires_at` timestamp is in the
future at the time of evaluation.

---

## The Six Checks

### Check 1 — Obtain a Signed Market Status Attestation

Before any order submission, the agent MUST obtain a Signed Attestation for the
target exchange from a conforming oracle.

```
GET https://headlessoracle.com/v5/status?mic={MIC}
X-Oracle-Key: {api_key}
```

The response is a signed JSON receipt. Free tier available at
`https://headlessoracle.com/v5/keys/request` — no account required.

**Fail condition:** Unable to reach oracle, oracle returns non-200, or response
body cannot be parsed as a valid Signed Attestation. → **HALT.**

---

### Check 2 — Verify No Active Circuit Breakers

The `source` field in the receipt distinguishes schedule-based status from
manual circuit-breaker overrides.

| `source` value | Meaning |
|---|---|
| `SCHEDULE` | Status computed from market calendar |
| `OVERRIDE` | Operator has manually halted this exchange |
| `SYSTEM` | Oracle infrastructure error — treat as UNKNOWN |

If `source = "OVERRIDE"`, the `reason` field contains the human-readable halt reason.
The agent MUST treat OVERRIDE as a HALT condition regardless of the `status` field.

```python
if receipt["source"] == "OVERRIDE":
    halt(reason=receipt.get("reason", "OVERRIDE active"))
```

**Fail condition:** `source` is `OVERRIDE` or `SYSTEM`. → **HALT.**

---

### Check 3 — Verify the Settlement Window Is Open

A market may be technically open (regular hours) while the settlement window
for the specific instrument is closed (e.g., T+1 settlement cut-off, futures
expiry, options expiration Friday close). The agent MUST verify that the
instrument's settlement window is open in addition to the exchange status.

The exchange-level check (`status = "OPEN"`) is a necessary but not sufficient
condition. Instrument-level settlement verification is the agent's responsibility
and is outside the scope of an exchange oracle.

**Recommended approach:** Combine the oracle receipt with instrument metadata
from the broker/exchange API. Reject if either source signals closed/unavailable.

**Fail condition:** Exchange open but instrument settlement window closed. → **HALT.**

---

### Check 4 — Verify the Oracle Receipt Is Fresh

A Signed Attestation MUST have a non-expired `expires_at` timestamp at the
time of trade submission. Do not cache and reuse receipts across trading decisions.

```python
from datetime import datetime, timezone

def is_fresh(receipt: dict) -> bool:
    expires_at = datetime.fromisoformat(receipt["expires_at"].replace("Z", "+00:00"))
    return datetime.now(timezone.utc) < expires_at
```

The reference oracle issues receipts with a 60-second TTL. An agent caching a
receipt for longer than its TTL may trade on a stale OPEN signal that has since
become CLOSED (e.g., an intraday halt occurring between the cache write and the
trade submission).

**Fail condition:** `expires_at` is in the past. → Fetch a fresh receipt. If
unable to fetch a fresh receipt, → **HALT.**

---

### Check 5 — Verify the Ed25519 Signature

The agent MUST cryptographically verify the receipt signature before acting on
it. A receipt that passes structural validation but fails signature verification
indicates tampering or key mismatch.

**JavaScript (Node.js / browser):**
```js
import { verify } from '@headlessoracle/verify';

const { ok, reason } = await verify(receipt);
if (!ok) {
    halt(`Signature verification failed: ${reason}`);
}
```

**Python:**
```python
# pip install PyNaCl httpx
from headless_oracle import verify

result = verify(receipt)
if not result.ok:
    halt(f"Signature verification failed: {result.reason}")
```

**Manual verification** (any language with Ed25519 support):
1. Fetch public key from `https://headlessoracle.com/v5/keys` (or cache it)
2. Sort all receipt fields alphabetically, exclude `signature`
3. Serialize as compact JSON (`JSON.stringify` with no whitespace)
4. Verify `signature` (hex-encoded) against serialized payload using Ed25519

Full specification: [SMA Protocol Specification](../sma-spec.md)

**Fail condition:** Signature invalid or public key unavailable. → **HALT.**

---

### Check 6 — Halt on Any Failure

If ANY of the preceding checks fails or produces an ambiguous result, the agent
MUST halt and log the failure. It MUST NOT:

- Fall back to a permissive default ("assume OPEN if oracle unavailable")
- Retry indefinitely without exponential backoff
- Proceed with a degraded confidence level ("probably open")

```python
# Reference: fail-closed pattern
def pre_trade_gate(mic: str, receipt: dict | None) -> bool:
    """
    Returns True only if ALL checks pass.
    Returns False (HALT) on any ambiguity or failure.
    """
    if receipt is None:
        return False  # No receipt → HALT

    checks = [
        receipt.get("status") == "OPEN",
        receipt.get("source") != "SYSTEM",
        receipt.get("source") != "OVERRIDE",
        is_fresh(receipt),
        verify_signature(receipt),
    ]
    return all(checks)
```

The fail-closed principle: **an unknown state is always the safe/restricted state.**
This is not a conservative bias — it is the only correct behaviour for an agent
that cannot ask a human for clarification.

---

## Conformance

An agent implementation is **conformant** with this standard if:

- [ ] It obtains a Signed Attestation before each trade decision
- [ ] It checks `source` for OVERRIDE/SYSTEM conditions
- [ ] It verifies the receipt is not expired
- [ ] It cryptographically verifies the Ed25519 signature
- [ ] It halts on ANY check failure without permissive fallback
- [ ] It logs the outcome of each check (pass/fail + timestamp) for audit

An agent that satisfies all six checks MAY assert:

```
Pre-trade safety: compliant with Agent Pre-Trade Safety Standard v1.0
Oracle: headlessoracle.com
```

---

## Reference Implementations

| Language | Package | Pre-trade gate example |
|---|---|---|
| JavaScript / TypeScript | [`@headlessoracle/verify`](https://npmjs.com/package/@headlessoracle/verify) | [`trading-bot-starter`](https://github.com/LembaGang/trading-bot-starter) |
| Python | [`headless-oracle`](https://github.com/LembaGang/headless-oracle-python) | `OracleClient.get_status()` |
| LangGraph | [`safe-trading-agent-template`](https://github.com/LembaGang/safe-trading-agent-template) | 4-node execution gate |

---

## Appendix: Failure Mode Reference

| Failure | Receipt field | Correct agent behaviour |
|---|---|---|
| Market closed (scheduled) | `status: "CLOSED"` | HALT — do not submit |
| Circuit breaker / manual halt | `source: "OVERRIDE"` | HALT — log `reason` field |
| Oracle infrastructure error | `source: "SYSTEM"` | HALT — treat as UNKNOWN |
| Stale receipt | `expires_at` in past | Fetch fresh receipt; HALT if unavailable |
| Invalid signature | `signature` fails verification | HALT — possible tampering |
| Oracle unreachable | HTTP error / timeout | HALT — fail closed |
| Unknown status value | `status` not in known enum | HALT — unknown state = safe state |

---

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0-draft | 2026-03-15 | Initial public draft |

---

## License

Copyright 2026 LembaGang / Headless Oracle contributors.

Licensed under the Apache License, Version 2.0. You may use this standard freely,
including in commercial products, provided attribution is maintained.

See: https://www.apache.org/licenses/LICENSE-2.0
