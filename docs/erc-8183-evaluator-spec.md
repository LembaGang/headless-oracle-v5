# Headless Oracle as an ERC-8183 Evaluator

**Version:** 1.0.0-draft
**Status:** Public Draft
**License:** Apache 2.0
**Relevant proposals:** Virtuals Protocol ERC-8183, Ethereum Foundation dAI Working Group

---

## Abstract

ERC-8183 defines a standard interface for "Jobs" — conditional execution units
that an autonomous agent may execute only when a designated **Evaluator** confirms
the pre-conditions are satisfied. This document specifies how Headless Oracle
functions as an ERC-8183 Evaluator for market-status-conditional Jobs.

The mapping is direct: a Job's `evaluate()` call maps to an Oracle receipt fetch
and verify. The Evaluator returns `complete` when the market is OPEN and the
signed receipt is valid; it returns `reject` for CLOSED, HALTED, UNKNOWN, expired,
or signature-invalid conditions.

---

## Background: ERC-8183

ERC-8183 (conceptual — pre-EIP as of March 2026) proposes a standard for
AI agent job execution with verifiable pre-conditions. The core interface:

```solidity
interface IEvaluator {
    /// Evaluate whether a Job's pre-conditions are met.
    /// @param jobId Identifier of the Job being evaluated
    /// @param context ABI-encoded evaluation context
    /// @return result EvaluationResult.COMPLETE or EvaluationResult.REJECT
    /// @return evidence ABI-encoded proof of evaluation (e.g. signed attestation)
    function evaluate(
        bytes32 jobId,
        bytes calldata context
    ) external returns (EvaluationResult result, bytes calldata evidence);
}

enum EvaluationResult { COMPLETE, REJECT }
```

A Job that requires "NYSE is OPEN before executing trade" would declare Headless
Oracle as its Evaluator. When the agent is ready to execute, it calls `evaluate()`.
The Evaluator returns COMPLETE + a signed receipt (evidence) or REJECT + a
machine-readable failure reason.

---

## Why Market Status Needs an Evaluator

On-chain agents executing or scheduling TradFi-adjacent operations face a
fundamental problem: the EVM has no native oracle for exchange open/close status.
Existing general-purpose price oracles (Chainlink, Pyth) provide asset prices but
not market open/closed signals with circuit-breaker awareness.

The failure modes without an Evaluator:

| Failure | Consequence |
|---|---|
| Trade submitted during DST phantom hour | Order rejected or filled at reopen with gap risk |
| Trade submitted during circuit breaker halt | Order queued, fills at post-halt prices |
| Settlement logic runs during exchange holiday | Settlement fails, position stuck |
| Rebalance executes on half-day close | Partial fills at distorted prices |

Headless Oracle solves this with a signed, time-bounded receipt that any EVM
contract can verify off-chain (via precompile) or accept as calldata evidence.

---

## Interface Mapping

### Oracle Receipt → Evaluator Response

| Oracle receipt field/value | EvaluationResult |
|---|---|
| `status: "OPEN"` + valid signature + not expired + `source: "SCHEDULE"` | `COMPLETE` |
| `status: "CLOSED"` | `REJECT` |
| `status: "HALTED"` | `REJECT` |
| `status: "UNKNOWN"` | `REJECT` |
| `source: "OVERRIDE"` | `REJECT` (regardless of `status`) |
| `source: "SYSTEM"` | `REJECT` (infrastructure error) |
| `expires_at` in the past | `REJECT` |
| Signature invalid | `REJECT` |
| Oracle unreachable | `REJECT` (fail closed) |

**The REJECT condition is the default.** COMPLETE is the narrow exception.
This matches the fail-closed safety contract of the SMA specification.

### Evidence Format

When returning `COMPLETE`, the Evaluator provides the full signed receipt
as ABI-encoded bytes. The consuming contract can:

1. Store the `receipt_id` on-chain as an audit trail
2. Verify the `expires_at` against `block.timestamp`
3. Pass the `signature` to an Ed25519 precompile for on-chain verification
   (EIP-665 / EIP-2844 or equivalent when available)

When returning `REJECT`, the Evaluator provides a structured reason:

```json
{
  "code": "MARKET_CLOSED",
  "receipt_id": "550e8400-...",
  "status": "CLOSED",
  "mic": "XNYS",
  "issued_at": "2026-03-15T12:00:00.000Z"
}
```

---

## Example: "Execute trade only if NYSE is OPEN"

### Job Definition (pseudo-ERC-8183)

```json
{
  "job_id": "trade_xnys_20260315_001",
  "description": "Buy 100 shares of $AAPL if NYSE is OPEN",
  "evaluator": "0xHEADLESS_ORACLE_EVALUATOR_ADDRESS",
  "context": {
    "mic": "XNYS",
    "required_status": "OPEN",
    "max_receipt_age_seconds": 60
  },
  "action": {
    "type": "execute_trade",
    "instrument": "AAPL",
    "quantity": 100,
    "side": "BUY"
  }
}
```

### Evaluation Flow

```
Agent                        Headless Oracle Evaluator
  │                                    │
  │── evaluate(jobId, context) ────────▶│
  │                                    │
  │                         GET /v5/status?mic=XNYS
  │                         (verify Ed25519 signature)
  │                         (check expires_at)
  │                         (check status == "OPEN")
  │                         (check source != "OVERRIDE")
  │                                    │
  │◀── COMPLETE, signedReceipt ────────│  (if all checks pass)
  │◀── REJECT, {code, reason} ─────────│  (if any check fails)
  │
  │  [if COMPLETE]
  │── submit trade order
  │── store receipt_id as audit evidence
  │
  │  [if REJECT]
  │── halt, log reason, schedule retry
```

### Reference Implementation (TypeScript)

```typescript
import { verify } from '@headlessoracle/verify';

interface EvaluatorContext {
  mic: string;
  required_status: 'OPEN';
  max_receipt_age_seconds: number;
}

type EvaluationResult =
  | { result: 'COMPLETE'; evidence: object }
  | { result: 'REJECT'; code: string; reason: string };

async function evaluateMarketJob(
  jobId: string,
  context: EvaluatorContext,
): Promise<EvaluationResult> {
  // 1. Fetch signed receipt
  let receipt: Record<string, unknown>;
  try {
    const res = await fetch(
      `https://headlessoracle.com/v5/status?mic=${context.mic}`,
      { headers: { 'X-Oracle-Key': process.env.ORACLE_API_KEY! } },
    );
    if (!res.ok) {
      return { result: 'REJECT', code: 'ORACLE_UNAVAILABLE',
               reason: `HTTP ${res.status}` };
    }
    receipt = await res.json();
  } catch (err) {
    // Oracle unreachable → fail closed
    return { result: 'REJECT', code: 'ORACLE_UNREACHABLE',
             reason: String(err) };
  }

  // 2. Verify Ed25519 signature + TTL
  const { ok, reason } = await verify(receipt);
  if (!ok) {
    return { result: 'REJECT', code: reason ?? 'INVALID_RECEIPT',
             reason: `Signature verification failed: ${reason}` };
  }

  // 3. Status check
  if (receipt.source === 'OVERRIDE') {
    return { result: 'REJECT', code: 'CIRCUIT_BREAKER_ACTIVE',
             reason: String(receipt.reason ?? 'OVERRIDE active') };
  }
  if (receipt.status !== context.required_status) {
    return { result: 'REJECT', code: `MARKET_${receipt.status}`,
             reason: `${context.mic} is ${receipt.status}` };
  }

  // 4. All checks pass
  return {
    result:   'COMPLETE',
    evidence: { jobId, receipt_id: receipt.receipt_id, receipt },
  };
}
```

### Reference Implementation (Python)

```python
import httpx
from headless_oracle import OracleClient, verify

async def evaluate_market_job(job_id: str, mic: str) -> dict:
    """
    ERC-8183 Evaluator for market-status-conditional Jobs.
    Returns {"result": "COMPLETE", "evidence": {...}}
         or {"result": "REJECT",   "code": "...", "reason": "..."}
    """
    client = OracleClient(api_key=os.environ["ORACLE_API_KEY"])

    try:
        receipt = await client.get_status(mic)
    except Exception as exc:
        return {"result": "REJECT", "code": "ORACLE_UNREACHABLE", "reason": str(exc)}

    verification = verify(receipt)
    if not verification.ok:
        return {"result": "REJECT", "code": verification.reason,
                "reason": f"Signature invalid: {verification.reason}"}

    if receipt.get("source") == "OVERRIDE":
        return {"result": "REJECT", "code": "CIRCUIT_BREAKER_ACTIVE",
                "reason": receipt.get("reason", "OVERRIDE active")}

    if receipt.get("status") != "OPEN":
        return {"result": "REJECT", "code": f"MARKET_{receipt['status']}",
                "reason": f"{mic} is {receipt['status']}"}

    return {
        "result":   "COMPLETE",
        "evidence": {"job_id": job_id, "receipt_id": receipt["receipt_id"],
                     "receipt": receipt},
    }
```

---

## On-Chain Verification Sketch

When EIP-665 (Ed25519 precompile) is available on the target chain:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IEd25519 {
    function verify(
        bytes32 message_hash,
        bytes32 r,
        bytes32 s,
        bytes32 public_key
    ) external view returns (bool);
}

contract MarketStatusEvaluator {
    IEd25519 constant ED25519 = IEd25519(0x0000...ED25519_PRECOMPILE);
    bytes32  public  oraclePublicKey;  // Set at deploy time from /v5/keys

    struct Receipt {
        bytes32 receipt_id;
        uint256 expires_at;   // Unix timestamp
        string  mic;
        string  status;       // "OPEN" | "CLOSED" | "HALTED" | "UNKNOWN"
        string  source;       // "SCHEDULE" | "OVERRIDE" | "SYSTEM"
        bytes32 r;            // Ed25519 signature r component
        bytes32 s;            // Ed25519 signature s component
    }

    function evaluate(Receipt calldata receipt)
        external view returns (bool complete)
    {
        // 1. Freshness
        require(block.timestamp < receipt.expires_at, "EXPIRED");

        // 2. Status
        require(
            keccak256(bytes(receipt.status)) == keccak256("OPEN") &&
            keccak256(bytes(receipt.source)) == keccak256("SCHEDULE"),
            "MARKET_NOT_OPEN"
        );

        // 3. Signature (canonical payload hash must be computed off-chain
        //    and passed as calldata, or computed on-chain via keccak of
        //    the ABI-encoded canonical JSON string)
        bytes32 payloadHash = _canonicalHash(receipt);
        require(
            ED25519.verify(payloadHash, receipt.r, receipt.s, oraclePublicKey),
            "INVALID_SIGNATURE"
        );

        return true;
    }

    function _canonicalHash(Receipt calldata r) internal pure returns (bytes32) {
        // Off-chain: produce alphabetically-sorted compact JSON,
        // hash with keccak256, pass in calldata.
        // Implementation depends on chain's JSON encoding support.
        // Full specification: docs/sma-spec.md § Canonical Serialization
        revert("NOT_IMPLEMENTED");
    }
}
```

Note: Full on-chain verification requires either the Ed25519 precompile (EIP-665),
a Solidity Ed25519 library, or a ZK proof of the signature. Off-chain verification
with on-chain audit trail (storing `receipt_id`) is the practical near-term pattern.

---

## Multi-Exchange Jobs

An agent executing across multiple exchanges needs an OPEN attestation for each:

```typescript
async function evaluateMultiMicJob(mics: string[]): Promise<EvaluationResult> {
  const res = await fetch(
    `https://headlessoracle.com/v5/batch?mics=${mics.join(',')}`,
    { headers: { 'X-Oracle-Key': process.env.ORACLE_API_KEY! } },
  );
  const { receipts } = await res.json();

  for (const receipt of receipts) {
    const { ok, reason } = await verify(receipt);
    if (!ok || receipt.status !== 'OPEN') {
      return { result: 'REJECT', code: `MARKET_${receipt.status}`,
               reason: `${receipt.mic}: ${reason ?? receipt.status}` };
    }
  }

  return { result: 'COMPLETE', evidence: { receipts } };
}
```

The batch endpoint (`/v5/batch`) returns independently signed receipts for each
MIC, allowing a single Evaluator call to gate a multi-exchange operation.

---

## Submission Notes

### Virtuals Protocol

Headless Oracle is positioned as a native Evaluator for Virtuals-hosted agents
executing market-conditional Jobs. The signed receipt provides the `evidence`
field required by the ERC-8183 Job completion interface. Key selling points:

- Cryptographic non-repudiation: the agent can prove it checked before trading
- Fail-closed by design: UNKNOWN → REJECT, no permissive fallback
- MCP-discoverable: agents can auto-configure via `POST /mcp`

Contact: [virtuals.io](https://virtuals.io) — reference the ERC-8183 proposal.

### Ethereum Foundation dAI Working Group

This spec aligns with the dAI working group's focus on verifiable agent behaviour.
The SMA receipt format is a candidate primitive for the "environmental attestation"
layer in dAI agent architectures. Ed25519 was chosen to compose into threshold
multi-party signing schemes relevant to decentralised oracle networks.

Contact: dAI working group mailing list / EF Discord.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| 1.0.0-draft | 2026-03-15 | Initial draft for Virtuals + EF dAI submission |

---

## License

Copyright 2026 LembaGang / Headless Oracle contributors.

Licensed under the Apache License, Version 2.0.
See: https://www.apache.org/licenses/LICENSE-2.0
