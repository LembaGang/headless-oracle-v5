Good framing — the pre-commitment record gap is real and worth resolving before the schema hardens.

**Q1: `authorized_by`**

`null` should not be a valid value. In audit logs, null is ambiguous: did the field fail to populate, did approval not fire, or was this intentionally autonomous? Propose explicit string values:

```
"auto:<threshold_usdc>"   // e.g. "auto:0.01" — autonomous below configured threshold
"operator"                // human approved out-of-band
"agent:<agent_id>"        // delegated agent approval in A2A flows
```

The `auto:` prefix makes the threshold machine-readable without a separate field — a log aggregator or Cedar policy can group and alert by threshold without joining another table. If a flow produces `authorized_by: null`, that's a bug to surface, not a state to represent.

**Q2: `attestation_ref`**

Required in all `payment_receipt` events. For human-approved overrides where oracle verification was explicitly skipped:

```json
{
  "attestation_ref": null,
  "oracle_skipped": true,
  "oracle_skipped_reason": "operator_override"
}
```

Omitting the field entirely is indistinguishable from a logging failure — the worst outcome for an audit chain that must prove what happened. `null` with an explicit `oracle_skipped` flag is unambiguous to both a human auditor and an automated verifier.

**Proposed `attestation_ref` schema** (fields drawn directly from the oracle receipt):

```json
{
  "provider":      "headlessoracle.com",
  "receipt_id":    "6b4a2c8f-...",
  "issued_at":     "2026-03-28T14:30:00.000Z",
  "expires_at":    "2026-03-28T14:31:00.000Z",
  "mic":           "XNYS",
  "status":        "OPEN",
  "source":        "REALTIME",
  "signature":     "<lowercase hex Ed25519, 128 chars>",
  "public_key_id": "key_2026_v1",
  "issuer":        "headlessoracle.com",
  "replay_protection": {
    "correlation_id":  "<x402_transaction_id>",
    "composite_hash":  "<sha256(signature + correlation_id)>"
  }
}
```

`receipt_id` is the primary correlation key — a UUID inside the signed payload, so constructing a valid one for a different status requires breaking Ed25519. `source` carries audit value: `REALTIME` vs `SCHEDULE` vs `OVERRIDE` tells a compliance reviewer whether the OPEN state came from a live feed or a scheduled calendar. The `signature` field is the raw oracle receipt signature (lowercase hex, 128 chars), not a re-signature of the `attestation_ref` object — the facilitator verifies it independently against the oracle's public key.

**TTL gap**

Oracle receipts expire 60 seconds after `issued_at`. The implied rule: `payment_required` MUST fire before `expires_at`. The agent should proactively re-fetch if `T_current > T_expiry - 5s` before initiating the x402 sequence. The facilitator enforces `attestation_ref.expires_at > now` at execution — not at approval. A ~500ms grace window at Lambda@Edge is reasonable for geographic propagation delay.

**Replay**

The facilitator indexes `payment_required` events by `attestation_ref.receipt_id`. On `payment_receipt`, it verifies `attestation_ref` is identical to the stored record. The `replay_protection.composite_hash` — `sha256(signature + correlation_id)` — adds a second layer: it binds the oracle receipt to this specific x402 transaction attempt, preventing a valid receipt from being injected into a different payment flow entirely.

One known limitation worth naming: the oracle currently runs on a single signing key with no multi-signer attestation. For institutional deployments requiring decentralized trust, threshold signatures are on the roadmap — but for the pre-execution gate pattern proposed here, single-issuer Ed25519 with a public key registry at `/.well-known/oracle-keys.json` satisfies the verification requirement.

The Bit-Chat `payment_required` / `payment_approval` / `payment_receipt` contract is a useful reference for the authorization schema — the oracle attestation fits cleanly as a pre-condition on `payment_required`.

Happy to draft a reference implementation PR — `attestation_ref` construction from an oracle receipt, TTL enforcement, composite hash generation, and replay detection as composable helpers. Let me know if that's useful.