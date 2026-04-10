# CPVR-1: Composable Pre-Trade Verification Receipt

**Version**: 1.0 | **Status**: PROPOSAL — Seeking Community Feedback | **License**: Apache 2.0

## Abstract

Autonomous trading agents perform multi-step verification before executing
financial transactions. Each verification layer — market state, spend
authorization, signal verification, payment — produces its own proof in its
own format. No standard exists for bundling these independent proofs into a
single, verifiable artifact that an auditor, compliance system, or downstream
agent can inspect without collecting evidence from multiple sources.

This specification proposes the **Composable Pre-Trade Verification Receipt
(CPVR)**: a JSON envelope format that wraps all pre-trade verification proofs
into a single composite receipt. The CPVR is the output artifact of the
composable pre-trade verification stack.

## Problem Statement

A typical pre-trade verification chain involves four or more independent
verification steps, each producing a proof in its own format:

1. **Market state**: An Ed25519-signed receipt from a market-state oracle
2. **Spend authorization**: A policy-bound authorization from a spend control
   service (e.g., Ampersend)
3. **Signal verification**: A verdict from a claim verification engine
   (e.g., VeroQ)
4. **Payment**: An on-chain transaction receipt from a blockchain

Today, each proof exists in isolation. An auditor reconstructing the
verification chain must:

- Collect proofs from 4+ different sources
- Correlate them by timestamp and context
- Verify each independently in its native format
- Confirm no gaps exist in the chain

This is error-prone for humans and impractical for autonomous agents. A
standardized composite receipt eliminates this friction.

## Proposed Format

The CPVR envelope wraps all layer proofs into a single JSON document:

```json
{
  "cpvr_version": "1.0",
  "spec": "CPVR-1",
  "title": "Composable Pre-Trade Verification Receipt",
  "timestamp": "2026-04-10T14:30:00Z",
  "agent_id": "trading-agent-alpha",
  "target": {
    "mic": "XNYS",
    "action": "BUY",
    "instrument": "AAPL"
  },
  "layers": [
    {
      "layer": 1,
      "name": "market_state",
      "provider": "headlessoracle.com",
      "passed": true,
      "receipt": {
        "receipt_id": "550e8400-e29b-41d4-a716-446655440000",
        "status": "OPEN",
        "signature": "a1b2c3..."
      },
      "verified_at": "2026-04-10T14:30:01Z"
    },
    {
      "layer": 2,
      "name": "spend_authorization",
      "provider": "ampersend.xyz",
      "passed": true,
      "proof": {
        "authorization_id": "auth-789",
        "limit": "10000 USD",
        "signature": "d4e5f6..."
      },
      "verified_at": "2026-04-10T14:30:02Z"
    },
    {
      "layer": 3,
      "name": "signal_verification",
      "provider": "veroq.ai",
      "passed": true,
      "verdict": {
        "claims_checked": 3,
        "claims_contradicted": 0
      },
      "verified_at": "2026-04-10T14:30:03Z"
    },
    {
      "layer": 4,
      "name": "payment",
      "protocol": "x402",
      "passed": true,
      "proof": {
        "tx_hash": "0xabc123...",
        "chain_id": 8453,
        "amount": "0.001 USDC"
      },
      "verified_at": "2026-04-10T14:30:04Z"
    }
  ],
  "all_passed": true,
  "composite_hash": "sha256-of-all-layer-proofs-concatenated",
  "issuer": "trading-agent-alpha"
}
```

## Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cpvr_version` | string | Yes | Specification version. Currently `"1.0"`. |
| `spec` | string | Yes | Specification identifier. Always `"CPVR-1"`. |
| `title` | string | Yes | Human-readable title. |
| `timestamp` | string (ISO 8601) | Yes | When the composite receipt was assembled. |
| `agent_id` | string | Yes | Identifier of the agent that assembled the receipt. |
| `target.mic` | string | Yes | ISO 10383 Market Identifier Code of the target exchange. |
| `target.action` | string | Yes | Intended action (e.g., `BUY`, `SELL`, `CANCEL`). |
| `target.instrument` | string | No | Instrument identifier (ticker, ISIN, etc.). |
| `layers` | array | Yes | Ordered array of verification layer results. |
| `layers[].layer` | integer | Yes | Layer number (1-indexed). |
| `layers[].name` | string | Yes | Layer identifier (e.g., `market_state`, `spend_authorization`). |
| `layers[].provider` | string | Conditional | Service that performed the verification. Required unless `protocol` is set. |
| `layers[].protocol` | string | Conditional | Protocol used for verification (e.g., `x402`). Required unless `provider` is set. |
| `layers[].passed` | boolean | Yes | Whether this layer's verification passed. |
| `layers[].receipt` / `proof` / `verdict` | object | Yes | Layer-specific proof data. Field name varies by layer type. |
| `layers[].verified_at` | string (ISO 8601) | Yes | When this layer's verification completed. |
| `all_passed` | boolean | Yes | `true` only if every layer's `passed` is `true`. |
| `composite_hash` | string | Yes | SHA-256 hash of all layer proof objects concatenated in layer order. |
| `issuer` | string | Yes | The agent or framework that assembled this composite receipt. |

## Design Principles

### Layer Independence

Each layer in the CPVR operates independently. Any provider can fill any
layer slot as long as it produces a proof object. The market state layer
could be served by Headless Oracle, a competing oracle, or an internal
exchange feed — the envelope format does not dictate the provider.

### Fail-Closed

If any layer is missing or has `passed: false`, the `all_passed` field
MUST be `false`. A consuming agent MUST NOT proceed with execution when
`all_passed` is `false`. There is no partial-pass concept.

### Self-Describing

Each layer includes its `provider` (or `protocol`), a `verified_at`
timestamp, and the native proof object from that layer. A consumer
encountering an unfamiliar CPVR can inspect each layer independently
without external documentation.

### Hashable

The `composite_hash` field provides integrity verification over the full
chain. It is computed as:

```
composite_hash = SHA-256(
  JSON.stringify(layers[0].receipt || layers[0].proof || layers[0].verdict) +
  JSON.stringify(layers[1].receipt || layers[1].proof || layers[1].verdict) +
  ...
)
```

This enables an auditor to verify that no layer proof was tampered with
after the CPVR was assembled.

### Extensible

Layers beyond the four defined here can be added. A CPVR with 6 layers
is valid. The `layer` number, `name`, and proof object are sufficient
for any consuming agent to process an unknown layer type.

## Relationship to MPAS-1.0

The Multi-Party Attestation Specification (MPAS-1.0) defines how multiple
independent parties can co-sign a single attestation. CPVR-1 extends this
concept from multi-party attestation of a single fact to multi-layer
attestation of a verification chain. Where MPAS asks "do multiple parties
agree on one claim?", CPVR asks "did multiple verification steps all pass?"

A CPVR layer MAY contain an MPAS attestation as its proof object. For
example, a market state layer could include an MPAS multi-party signed
receipt instead of a single-oracle receipt.

## Relationship to Pre-Trade Stack Specification

The Pre-Trade Verification Stack Specification defines the 5-layer
verification architecture for autonomous trading agents. CPVR-1 is the
output format that the stack produces. The stack defines *what* must be
verified; CPVR-1 defines *how the results are packaged*.

- Stack Spec: https://headlessoracle.com/docs/specifications/pre-trade-stack
- Machine-readable: https://headlessoracle.com/v5/pre-trade-stack

## Status

**PROPOSAL** — This specification is seeking community feedback. The format
has not yet been implemented end-to-end. We propose this as a starting
point for discussion among providers of pre-trade verification services.

## Reference Implementation

Headless Oracle receipts already conform to the Layer 1 format defined in
this specification. The `receipt` object in Layer 1 maps directly to the
existing Ed25519-signed market-state receipt format:

```json
{
  "layer": 1,
  "name": "market_state",
  "provider": "headlessoracle.com",
  "passed": true,
  "receipt": {
    "receipt_id": "...",
    "mic": "XNYS",
    "status": "OPEN",
    "issued_at": "2026-04-10T14:30:00Z",
    "expires_at": "2026-04-10T14:31:00Z",
    "signature": "..."
  },
  "verified_at": "2026-04-10T14:30:01Z"
}
```

Full CPVR envelope generation will be added to the Headless Oracle SDK
when downstream layers (spend authorization, signal verification) publish
compatible proof formats.

## Feedback

This specification is maintained at:
https://github.com/LembaGang/headless-oracle-v5

We welcome feedback via GitHub Issues or Discussions on the repository.

## License

Apache 2.0
