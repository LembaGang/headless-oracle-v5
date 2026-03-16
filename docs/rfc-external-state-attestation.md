# RFC: Verifiable External State Attestation for Autonomous Agent Systems

**Document type**: Informational RFC
**Working group**: Verifiable Intent / Agent Interoperability
**Status**: Draft v1.0
**Date**: March 2026
**Author**: Headless Oracle Project
**License**: Apache 2.0

---

## Abstract

This document defines a protocol for cryptographically attested external state claims consumed by autonomous agent systems. As AI agents increasingly make consequential decisions — financial execution, contract enforcement, resource allocation — they require a trustworthy, independently verifiable ground truth about the state of the external world. Existing approaches (trusted APIs, price oracles, oracle networks) provide data delivery but lack a standardised attestation format that agents can verify without trusting the delivery layer. This RFC proposes a minimal, composable attestation format and consumption protocol suitable for any external state domain — with market state as the primary reference implementation.

---

## 1. Introduction

### 1.1 Problem Statement

Autonomous agents operate on behalf of principals who cannot supervise every decision. For an agent action to be auditable, reproducible, and legally defensible, the external state on which the decision was based must be:

1. **Verifiable**: the state claim must be independently confirmable without re-querying the source
2. **Tamper-evident**: modifications to the claim after issuance must be detectable
3. **Temporally bounded**: the claim must carry an explicit validity window; stale state must not be acted upon
4. **Self-describing**: the claim must identify its issuer and schema without out-of-band knowledge

Current industry practice fails on all four requirements. An agent that calls a market data API and receives `{"status": "OPEN"}` has no verifiable evidence that:
- the response was not modified in transit
- the response reflects the state at decision time (not cached state from hours prior)
- the API operator actually signed the claim
- any other agent in the pipeline can verify the same claim independently

This creates a fundamental trust gap at the agent execution layer.

### 1.2 Scope

This RFC defines:
- A canonical attestation record format (the **State Receipt**)
- A signing and verification algorithm
- A key discovery protocol
- Consumption requirements for agent systems
- Failure mode handling requirements

This RFC does not define:
- The underlying state source (exchange schedule, price feed, on-chain data, weather, etc.)
- Transport mechanisms (HTTP, gRPC, WebSocket, on-chain event)
- Operator federation or multi-party signing (addressed in a companion RFC)

### 1.3 Motivation

The primary motivation is financial execution safety for AI agents. A growing class of autonomous agents execute trades, trigger liquidations, manage treasury allocations, and redeem synthetic assets. These decisions are time-sensitive and state-dependent. An agent that executes a trade during a market closure, circuit breaker halt, or settlement window causes real financial harm that is difficult to attribute and impossible to audit without a verifiable state record.

The secondary motivation is generalisation. The same trust gap exists wherever an agent makes a consequential decision based on external state: legal document validity, regulatory compliance windows, counterparty credit status, or infrastructure health. A single attestation format that spans domains enables cross-domain audit trails and composable agent verification pipelines.

---

## 2. The State Receipt Format

A **State Receipt** is a JSON object that attests to the state of a named external entity at a specific instant.

### 2.1 Required Fields

| Field | Type | Description |
|---|---|---|
| `issuer` | string (FQDN) | Operator identity. Agents resolve `{issuer}/v5/keys` to find the signing public key. |
| `subject` | string | Opaque identifier for the attested entity. In market state: ISO 10383 MIC code. |
| `status` | string (enum) | The attested state. Domain-specific; market domain uses: `OPEN \| CLOSED \| HALTED \| UNKNOWN`. |
| `source` | string (enum) | How the status was determined: `SCHEDULE \| OVERRIDE \| SYSTEM`. |
| `issued_at` | ISO 8601 | Timestamp when the receipt was signed. |
| `expires_at` | ISO 8601 | After this time, the receipt MUST NOT be acted upon. |
| `receipt_id` | UUID v4 | Unique receipt identifier for deduplication and audit. |
| `key_id` | string | Identifier for the signing key used. Matches `id` field in the key registry. |
| `schema_version` | string | Receipt schema version identifier (e.g. `"v5.0"`). |
| `signature` | string (hex) | Ed25519 signature over the canonical payload (see §3). |

### 2.2 Optional Fields

Domains may extend the receipt with additional signed fields. All additional fields are included in the canonical payload (§3.1) and are therefore tamper-evident. Examples:

| Field | Type | Description |
|---|---|---|
| `reason` | string | Human-readable reason for a non-nominal state (e.g. circuit breaker description). |
| `receipt_mode` | string | `"demo"` for unauthenticated receipts; `"live"` for authenticated production receipts. |
| `issuer_metadata` | object | Operator-supplied metadata (exchange name, data coverage, etc.). |

### 2.3 The UNKNOWN Status

Every domain MUST define an `UNKNOWN` status value representing "state cannot be determined." Consumers MUST treat `UNKNOWN` as the most restrictive safe state — in market domain, this means CLOSED. This fail-closed requirement is non-negotiable: an oracle that defaults to permissive state on uncertainty is a liability for agent operators.

---

## 3. Signing and Verification

### 3.1 Canonical Payload Construction

The canonical payload is a deterministic string derived from the receipt:

1. Collect all receipt fields **except** `signature`
2. Sort keys alphabetically (lexicographic byte order, case-sensitive)
3. Serialize with `JSON.stringify` using no whitespace (separators: `","` and `":"`)
4. Encode the result as UTF-8 bytes

This procedure is deterministic across all compliant implementations regardless of object construction order, JSON library, or language.

**Rationale for alphabetical sort**: JSON object key ordering is insertion-order-dependent in many languages. Without a canonical form, any field reorder in a future refactor silently breaks all existing verifiers. Alphabetical sort is simple, well-defined, and easily implemented in any language without additional dependencies.

### 3.2 Signing Algorithm

```
canonical_bytes = utf8_encode(json_canonical(receipt_without_signature))
signature = ed25519_sign(canonical_bytes, private_key)
receipt.signature = hex_encode(signature)
```

**Algorithm choice**: Ed25519 (RFC 8032). Rationale: deterministic signatures (no per-signature randomness required), compact (64-byte signature, 32-byte key), high performance, no external CA dependency, pure-JS implementation available (`@noble/ed25519`). Ed25519 composes cleanly into threshold signing schemes (required for federation, see §6.2).

### 3.3 Verification Algorithm

```
public_key_bytes = hex_decode(public_key)
signature_bytes  = hex_decode(receipt.signature)
canonical_bytes  = utf8_encode(json_canonical(receipt_without_signature))
valid = ed25519_verify(signature_bytes, canonical_bytes, public_key_bytes)
```

Consumers MUST additionally verify:
1. `new Date(receipt.expires_at) > Date.now()` — reject expired receipts
2. `receipt.key_id` matches the key retrieved from the issuer's key registry
3. `receipt.issuer` resolves to a legitimate key registry endpoint (trust anchor)

### 3.4 Receipt TTL

The `expires_at` field MUST be set to `issued_at + 60 seconds` in market state receipts. Domain-specific implementations MAY use different TTLs subject to the following constraints:
- TTL MUST be positive (expires_at > issued_at)
- TTL MUST be short enough that acting on a stale receipt could cause material harm
- TTL MUST be long enough that network latency does not cause systematic expiry before consumption

The 60-second TTL for market state receipts reflects the need to prevent an OPEN receipt from being acted on after market close, while allowing for reasonable network latency and caching.

---

## 4. Key Discovery Protocol

### 4.1 Well-Known Endpoint

Operators MUST serve active signing key(s) at:

```
GET {issuer}/.well-known/oracle-keys.json
```

This follows RFC 8615 (Well-Known Uniform Resource Identifiers). The response MUST include:

```json
{
  "keys": [
    {
      "id":         "key_2026_v1",
      "algorithm":  "Ed25519",
      "format":     "hex",
      "public_key": "03dc27993a2c...",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": null
    }
  ]
}
```

`valid_until: null` indicates no scheduled rotation. Operators MUST set `valid_until` before rotating keys to provide consumers advance notice.

### 4.2 Issuer-Based Discovery

The `issuer` field in every receipt is a FQDN. Agents encountering an unfamiliar receipt can resolve the key registry at `{issuer}/.well-known/oracle-keys.json` without prior knowledge of the oracle. This makes receipts self-describing: no configuration is required to verify a receipt from any conformant oracle.

### 4.3 Key Rotation

Operators SHOULD provide at least 24 hours advance notice before key rotation by setting `valid_until` on the outgoing key. During the rotation window, both old and new keys SHOULD be served in the `keys` array. Consumers SHOULD re-fetch keys when signature verification fails against the cached key.

---

## 5. Consumer Requirements

### 5.1 Mandatory

1. **Verify every receipt** before acting on its status. An unverified receipt has zero attestation weight.
2. **Reject expired receipts**. Check `expires_at` before acting; re-fetch if stale.
3. **Treat UNKNOWN as the most restrictive safe state**. Never treat UNKNOWN as permissive.
4. **Handle network failure as UNKNOWN**. A timeout, DNS failure, or 5xx response must produce the same outcome as a verified UNKNOWN receipt.
5. **Verify key identity**. Confirm `receipt.key_id` matches the key fetched from the issuer's key registry.

### 5.2 Recommended

6. **Cache the public key** to avoid a key registry fetch on every verification. Invalidate on signature failure.
7. **Set a request timeout** of 4 seconds or less. Agents that block indefinitely on oracle requests create cascading failure modes.
8. **Check `receipt_mode`** before production decisions. A `"demo"` receipt is unauthenticated; it MUST NOT be used for production execution decisions.
9. **Log receipt IDs** in execution audit trails. `receipt_id` enables post-hoc verification that the state on which a decision was made was legitimate.

### 5.3 Agent Pipeline Portability

A signed receipt is self-contained and portable across agent pipelines. An orchestrator agent may fetch a receipt once and distribute it to sub-agents, each of which independently verifies before acting. This eliminates redundant oracle requests at scale while preserving the cryptographic trust chain. Sub-agents MUST verify independently — they MUST NOT act on receipts received from other agents without performing their own signature and TTL verification.

---

## 6. Failure Mode Handling

### 6.1 Failure Classification

| Failure | Agent Response |
|---|---|
| Network timeout / connection error | Treat as UNKNOWN → halt |
| HTTP 4xx from oracle | Treat as UNKNOWN → halt |
| HTTP 5xx from oracle | Treat as UNKNOWN → halt |
| Signature verification failure | Treat as UNKNOWN → halt; alert operator |
| Expired receipt (`expires_at` in past) | Re-fetch; if re-fetch fails → halt |
| `status: "UNKNOWN"` from oracle | Halt immediately — this is the oracle's own fail-closed signal |
| `status: "HALTED"` from oracle | Halt; log reason field; do not retry until next signed OPEN receipt |
| Key not found in registry | Treat as UNKNOWN → halt; may indicate key rotation |

### 6.2 Partial Failure in Batch Requests

When fetching receipts for multiple subjects in a single request, the batch fails as a whole if signing infrastructure is offline. Partial results from a potentially compromised signing system are worse than no results — an agent acting on some verified and some unverified receipts from the same batch cannot isolate the trust boundary.

---

## 7. Security Considerations

### 7.1 Replay Attacks

The `expires_at` field limits the replay window to the TTL duration. Consumers that enforce expiry are protected against receipt replay attacks. The `receipt_id` field enables deduplication for consumers that require stricter replay protection within the TTL window.

### 7.2 Trust Anchor Bootstrapping

The security of this protocol depends on the consumer correctly establishing the issuer's public key. The well-known endpoint (§4.1) provides a standard discovery path, but bootstrapping trust in the issuer domain itself requires out-of-band verification (e.g. DNSSEC, CT logs, or social proof). This RFC does not specify how initial trust in an issuer is established — that is a deployment decision. Operators SHOULD publish their public key through multiple independent channels.

### 7.3 Key Compromise

If a signing key is compromised, all receipts issued under that key must be considered untrusted, even if their signatures are mathematically valid. Operators MUST have a key rotation procedure and MUST communicate compromises to consumers promptly. The `valid_until` mechanism enables graceful rotation; emergency rotation requires out-of-band notification.

### 7.4 Transport Security

Receipts are self-authenticating via their Ed25519 signatures — an attacker who intercepts a receipt in transit cannot forge a valid signature. However, HTTPS SHOULD still be used for all oracle requests to prevent traffic analysis and request tampering.

---

## 8. Relationship to Existing Standards

**ISO 10383 (Market Identifier Codes)**: The market state domain uses ISO 10383 MIC codes as subject identifiers. This RFC is MIC-aware but domain-agnostic.

**RFC 8615 (Well-Known URIs)**: Key discovery follows the RFC 8615 well-known pattern. The path `/.well-known/oracle-keys.json` is registered as part of this protocol.

**W3C Verifiable Credentials**: State Receipts share goals with W3C VCs (tamper-evident, issuer-signed claims) but are intentionally simpler — no DID, no JSON-LD, no credential status registry. Simplicity is a feature for high-frequency, low-latency agent consumption. A mapping from State Receipts to W3C VCs is possible and left as future work.

**ERC-8183 (On-Chain Oracle Evaluation)**: The ERC-8183 draft specifies how on-chain contracts evaluate oracle receipts. State Receipts as defined here are compatible with the ERC-8183 receipt format — Ed25519 signatures can be verified on-chain via EIP-665.

---

## 9. Implementation Notes

### 9.1 Reference Implementation

Headless Oracle (headlessoracle.com) is the reference implementation of this RFC:
- 7 exchanges (XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES)
- REST API + MCP Streamable HTTP
- Ed25519 signing via `@noble/ed25519`
- `@headlessoracle/verify` npm SDK (zero production dependencies)
- APTS v1.0 compliance: `GET /v5/compliance`

### 9.2 Minimal Verifier (JavaScript, Web Crypto)

```javascript
async function verifyStateReceipt(receipt) {
  const { signature, ...payload } = receipt;
  const sorted = Object.fromEntries(Object.keys(payload).sort().map(k => [k, payload[k]]));
  const canonical = JSON.stringify(sorted);
  const keyResp = await fetch(`https://${receipt.issuer}/.well-known/oracle-keys.json`);
  const { keys } = await keyResp.json();
  const key = keys.find(k => k.id === receipt.key_id);
  if (!key) throw new Error('Key not found');
  const cryptoKey = await crypto.subtle.importKey(
    'raw', hexToBytes(key.public_key), { name: 'Ed25519' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' }, cryptoKey, hexToBytes(signature), new TextEncoder().encode(canonical)
  );
  if (!valid) throw new Error('Invalid signature');
  if (new Date(receipt.expires_at) < new Date()) throw new Error('Expired');
  return receipt.status;
}
```

### 9.3 Fail-Closed Integration Pattern (Python)

```python
def get_verified_state(issuer, subject, api_key=None):
    """Returns verified state or 'UNKNOWN' on any failure — never raises."""
    try:
        headers = {'X-Oracle-Key': api_key} if api_key else {}
        r = requests.get(
            f'https://{issuer}/v5/status',
            params={'mic': subject}, headers=headers, timeout=4
        )
        if not r.ok:
            return 'UNKNOWN'
        receipt = r.json()
        # verify signature (using headless-oracle SDK or manual Ed25519 check)
        from headless_oracle import verify
        if not verify(receipt):
            return 'UNKNOWN'
        if datetime.fromisoformat(receipt['expires_at']) < datetime.utcnow():
            return 'UNKNOWN'
        return receipt['status']
    except Exception:
        return 'UNKNOWN'  # fail-closed: any exception = UNKNOWN
```

---

## 10. Open Questions

1. **Batch receipts**: Should a batch receipt covering multiple subjects be a single signed envelope, or an array of independently signed receipts? The reference implementation uses independent signing per subject (see ADR-016). An envelope approach reduces verification calls but prevents per-subject forwarding.

2. **Subscription / push receipts**: Pull-based receipt issuance creates polling pressure at scale. A push model (webhook or SSE) would reduce latency but requires stateful subscriptions. The signing format is identical; the transport layer needs specification.

3. **Multi-party signing**: Single-operator oracles require trusting the operator. Threshold Ed25519 (k-of-n operators) eliminates this trust assumption. The receipt format supports multi-party signing by including multiple `signature` entries; the protocol for coordinating signers is left to a companion RFC.

4. **On-chain anchoring**: Periodic Merkle roots of issued receipts anchored on-chain would enable tamper-evident audit trails without requiring on-chain verification of every receipt. Specification deferred.

---

## 11. Changelog

| Version | Date | Changes |
|---|---|---|
| v1.0 | March 2026 | Initial draft. Market state domain. Ed25519 + alphabetical canonical form. Key discovery via well-known. |

---

## Appendix A: Test Vectors

These test vectors allow implementors to verify canonical payload construction.

**Receipt (before signing)**:
```json
{
  "expires_at": "2026-03-17T12:01:00Z",
  "issued_at":  "2026-03-17T12:00:00Z",
  "issuer":     "headlessoracle.com",
  "key_id":     "key_2026_v1",
  "mic":        "XNYS",
  "receipt_id": "550e8400-e29b-41d4-a716-446655440000",
  "receipt_mode": "live",
  "schema_version": "v5.0",
  "source":     "SCHEDULE",
  "status":     "OPEN"
}
```

**Canonical payload** (fields sorted alphabetically, no whitespace):
```
{"expires_at":"2026-03-17T12:01:00Z","issued_at":"2026-03-17T12:00:00Z","issuer":"headlessoracle.com","key_id":"key_2026_v1","mic":"XNYS","receipt_id":"550e8400-e29b-41d4-a716-446655440000","receipt_mode":"live","schema_version":"v5.0","source":"SCHEDULE","status":"OPEN"}
```

**Note**: Verify that your canonical form matches this string byte-for-byte before signing. If it does not, your key sort or serialisation differs from the spec.

---

*End of document. Comments and revisions should be submitted as pull requests to the reference implementation repository.*
