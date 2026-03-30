# Multi-Party Attestation Aggregation Spec (MPAS-1.0)

**Status**: Draft v1.0.0
**License**: Apache 2.0
**Authors**: Headless Oracle Project
**Date**: 2026-03-30
**Canonical URL**: https://headlessoracle.com/docs/mpas
**GitHub**: https://github.com/LembaGang/mpas-spec

---

## Problem Statement

The Signed Market Attestation (SMA) Protocol defines how a single oracle operator signs a market-state receipt that any consumer can verify cryptographically. A consumer that fetches a receipt from `headlessoracle.com` and verifies the Ed25519 signature knows the receipt was produced by whoever holds the corresponding private key.

That is not the same as knowing the market state is true.

Single-operator trust is operator-reputation trust. If the operator is compromised, coerced, or simply wrong, the signature still verifies. The cryptography proves authorship; it does not prove correctness. For early adopters who already trust the operator, this is sufficient. For infrastructure-scale adoption — where autonomous agents must act on signed attestations without human review — it is not.

The fix is multi-party attestation: require that N independent operators, each holding distinct signing keys, produce receipts agreeing on the same market state before a consumer acts. Compromising the result then requires compromising multiple independent operators simultaneously, which is qualitatively harder than compromising one.

This document specifies how operators, aggregators, and consumers participate in multi-party attestation using standard SMA Protocol receipts as the primitive.

---

## 1. Overview

This spec defines:

1. The `AggregatedAttestation` JSON schema — a container for receipts from N independent oracle operators
2. Quorum rules — how many operators must agree, within what time window, for consensus to be valid
3. A consumer verification algorithm — deterministic steps to decide whether to act or halt
4. Operator registration conventions — how operators publish keys and join the network
5. An on-chain verification sketch — how smart contract consumers can verify quorum without a trusted intermediary
6. A trust model comparison — what guarantees each configuration provides

**Relationship to SMA Protocol**: MPAS is a composition layer above SMA. Individual receipts inside an `AggregatedAttestation` are standard SMA receipts. MPAS does not replace or modify the SMA signing scheme. Consumers SHOULD implement full SMA receipt verification (per the SMA Protocol v1.0.0 specification) for each individual attestation before applying quorum logic.

**What MPAS does not change**: Ed25519 key pairs, receipt field schemas, canonical payload serialization, the 60-second TTL, or the fail-closed UNKNOWN semantics. All of those remain as defined by the SMA Protocol.

---

## 2. Roles

### Oracle Operator

An entity that:

- Operates an SMA-compliant signing node
- Holds an Ed25519 private key that never leaves the operator's infrastructure
- Publishes the corresponding public key at `/.well-known/oracle-keys.json` per RFC 8615
- Produces signed SMA receipts on demand for any supported MIC code

Oracle operators are independent. They must not share signing keys, coordinate on receipt values before signing, or delegate signing to a common infrastructure component. Independence is the security property that makes multi-party attestation meaningful.

Headless Oracle (`headlessoracle.com`) is one example of an oracle operator. This spec defines how multiple such operators compose.

### Aggregator

An entity that:

- Knows the endpoint URLs and public keys of N oracle operators
- Fetches receipts from all N operators in parallel for a given MIC and timestamp
- Verifies each receipt's Ed25519 signature independently
- Assembles the results into an `AggregatedAttestation`
- Computes the consensus field based on quorum rules

The aggregator is stateless. It does not sign anything. It does not decide what the market state is — it reports what each operator said and whether enough of them agreed. The aggregator can be run by the consumer itself (eliminating the aggregator as a separate trust assumption) or by a third party (convenient but requires trusting the aggregator's honesty about which operators responded).

Section 11 discusses the aggregator trust assumption and the path to eliminating it entirely.

### Consumer

An entity that:

- Receives an `AggregatedAttestation` (from an aggregator or by running aggregation itself)
- Runs the verification algorithm defined in Section 5
- Proceeds only if verification passes and consensus is AGREE with quorum met
- Treats DISAGREE, INSUFFICIENT, and any verification failure as equivalent to UNKNOWN — halts execution

Consumers MUST NOT act on partial attestations. An `AggregatedAttestation` with `consensus: "INSUFFICIENT"` is not "the best available signal." It is an insufficient signal, and the fail-closed rule applies.

### Registry

An optional directory of known oracle operator public keys and endpoint URLs.

A registry allows consumers to discover operators without prior configuration. Registries can be:

- **Off-chain signed manifest**: a JSON file signed by a trusted curator (introduces curator trust assumption)
- **IPFS**: content-addressed, censorship-resistant, no update mechanism without a new CID
- **On-chain**: stored in a smart contract, updateable by governance, auditable

Registry format is out of scope for MPAS v1.0. Section 11 notes this as a known gap.

---

## 3. AggregatedAttestation Schema

An `AggregatedAttestation` is a JSON object with the following structure:

```json
{
  "mpas_version": "1.0",
  "mic": "XNYS",
  "status": "OPEN",
  "quorum": {
    "required": 2,
    "provided": 3
  },
  "window_ms": 5000,
  "aggregated_at": "2026-03-30T14:32:10.000Z",
  "attestations": [
    {
      "operator_id": "headlessoracle.com",
      "receipt": {
        "mic": "XNYS",
        "status": "OPEN",
        "issued_at": "2026-03-30T14:32:09.121Z",
        "expires_at": "2026-03-30T14:33:09.121Z",
        "issuer": "headlessoracle.com",
        "key_id": "03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178",
        "receipt_mode": "live",
        "schema_version": "v5.0",
        "receipt_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "source": "SCHEDULE",
        "signature": "hex-encoded-ed25519-signature"
      },
      "verified": true
    },
    {
      "operator_id": "oracle-b.example.com",
      "receipt": { "...": "SMA receipt from operator B" },
      "verified": true
    },
    {
      "operator_id": "oracle-c.example.com",
      "receipt": { "...": "SMA receipt from operator C" },
      "verified": true
    }
  ],
  "consensus": "AGREE"
}
```

### Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `mpas_version` | string | yes | Must be `"1.0"` for this spec version |
| `mic` | string | yes | ISO 10383 market identifier code (e.g. `"XNYS"`) |
| `status` | string | yes | The consensus market status: `"OPEN"`, `"CLOSED"`, `"HALTED"`, or `"UNKNOWN"`. Set to the agreed status when `consensus == "AGREE"`, otherwise `"UNKNOWN"`. |
| `quorum.required` | integer | yes | Minimum number of valid agreeing attestations required for AGREE consensus. Must be >= 2 for MPAS compliance. |
| `quorum.provided` | integer | yes | Number of attestations included in this object (regardless of verification outcome). |
| `window_ms` | integer | yes | Maximum allowed difference in milliseconds between the earliest and latest `issued_at` across all attestations. Attestations outside this window are treated as unverified. |
| `aggregated_at` | string | yes | ISO 8601 timestamp at which the aggregator assembled this object. Informational only — not part of any signature. |
| `attestations` | array | yes | Ordered list of individual operator attestations. |
| `attestations[].operator_id` | string | yes | The operator's canonical domain (must match the operator's `/.well-known/oracle-keys.json` host). |
| `attestations[].receipt` | object | yes | The raw SMA receipt as returned by the operator. Must pass full SMA verification. |
| `attestations[].verified` | boolean | yes | Set by the aggregator: `true` if Ed25519 signature verified successfully against the operator's known public key, `false` otherwise. Consumers MUST re-verify independently and not trust this field. |
| `consensus` | string | yes | `"AGREE"` if >= `quorum.required` verified attestations share the same `status`. `"DISAGREE"` if >= `quorum.required` verified attestations exist but disagree on `status`. `"INSUFFICIENT"` if fewer than `quorum.required` valid attestations were collected. |

The `AggregatedAttestation` object is NOT itself signed. Its integrity derives entirely from the independently verifiable signatures within each `attestations[].receipt`. This is intentional: adding a signature over the aggregated object would introduce an aggregator signing key, which is the trust assumption we are trying to eliminate in the long term (see Section 11).

---

## 4. Quorum Rules

### Minimum Quorum

The minimum MPAS-compliant configuration is **2-of-3**: two operators must agree, out of three total. A 1-of-1 configuration degrades to single-operator SMA and is explicitly not MPAS-compliant, even if the schema is used.

Recommended configurations:

| Config | Required | Total | Notes |
|---|---|---|---|
| 2-of-3 | 2 | 3 | Recommended minimum. Tolerates one operator failure or one Byzantine operator. |
| 3-of-5 | 3 | 5 | Higher assurance. Tolerates two failures or one Byzantine + one failure. |
| 3-of-3 | 3 | 3 | Maximum conservatism. Any single operator failure → INSUFFICIENT. |

### Time Window

All attestations in an `AggregatedAttestation` must have `issued_at` values within `window_ms` of each other (measured as the difference between the earliest and latest `issued_at`).

The recommended `window_ms` is **5000** (5 seconds). This accommodates:
- Network latency variation between aggregator and operators
- Operator clock skew (within NTP-synchronized tolerance)
- Retry on transient failure for one operator

Attestations with `issued_at` outside the window MUST be treated as unverified regardless of signature validity. A receipt that was genuinely issued at a different time may reflect a different market state.

### Consensus Determination

Given a set of attestations that have all passed signature verification and window checks:

- **AGREE**: The count of verified attestations sharing the same `status` value is >= `quorum.required`. The `status` field of the `AggregatedAttestation` is set to that agreed value.
- **DISAGREE**: Verified attestations exist in sufficient number (`>= quorum.required`) but do not share a common `status`. This indicates operators see different market states — a signal that warrants investigation, never a signal to act.
- **INSUFFICIENT**: Fewer than `quorum.required` attestations passed all verification checks (signature valid + within window + not expired).

**Consumers MUST treat DISAGREE and INSUFFICIENT as equivalent to UNKNOWN.** The fail-closed rule from SMA Protocol applies with equal force here: when in doubt, halt all execution.

---

## 5. Verification Algorithm

The following is a deterministic pseudocode description of the consumer verification algorithm. Implementations in any language MUST produce equivalent results.

```
function verifyAggregatedAttestation(agg, knownOperatorKeys, now):

  // Step 0: Version check
  if agg.mpas_version != "1.0":
    return FAIL("unsupported_version")

  // Step 1: Verify each attestation independently
  verified_attestations = []
  for each attestation in agg.attestations:
    operator_key = knownOperatorKeys[attestation.operator_id]
    if operator_key is null:
      // Unknown operator — skip, do not count toward quorum
      continue

    // Step 1a: Verify Ed25519 signature (full SMA verification)
    if not verifySMAReceipt(attestation.receipt, operator_key):
      continue  // Invalid signature — skip

    // Step 1b: Check receipt is not expired
    if parseISO8601(attestation.receipt.expires_at) <= now:
      continue  // Expired — skip

    // Step 1c: Check operator_id matches receipt issuer
    if attestation.operator_id != attestation.receipt.issuer:
      continue  // Operator identity mismatch — skip

    // Step 1d: Check MIC matches the outer object
    if attestation.receipt.mic != agg.mic:
      continue  // MIC mismatch — skip

    verified_attestations.append(attestation)

  // Step 2: Time window check
  if len(verified_attestations) < 2:
    return INSUFFICIENT

  issued_times = [parseISO8601(a.receipt.issued_at) for a in verified_attestations]
  window_actual_ms = max(issued_times) - min(issued_times)  // in milliseconds
  if window_actual_ms > agg.window_ms:
    // Attestations are too far apart in time — cannot treat as concurrent
    return FAIL("window_exceeded")

  // Step 3: Tally consensus
  status_counts = {}
  for each att in verified_attestations:
    status_counts[att.receipt.status] += 1

  best_status = status with highest count in status_counts
  best_count = status_counts[best_status]

  if best_count >= agg.quorum.required:
    if len(status_counts) == 1:
      consensus = AGREE
    else:
      // Multiple statuses present — check if required threshold is unambiguously met
      // by one status without overlap from others
      consensus = AGREE if best_count >= agg.quorum.required else DISAGREE
  else:
    consensus = INSUFFICIENT

  // Step 4: Consumer decision
  if consensus == AGREE and best_status == "OPEN":
    return PROCEED
  else:
    return HALT  // Treat DISAGREE and INSUFFICIENT as UNKNOWN
```

### Key Implementation Notes

- **Do not trust `attestations[].verified`**: The aggregator may lie or be buggy. Consumers MUST independently re-verify each Ed25519 signature against their own copy of the operator's public key.
- **Do not trust `agg.status` or `agg.consensus`**: These are computed summaries. Recompute them from the raw attestations.
- **`knownOperatorKeys`**: The consumer must have obtained operator public keys through a trusted out-of-band process (registry, configuration, or direct fetch from `/.well-known/oracle-keys.json`). Public keys obtained at verification time from an untrusted source provide no security.
- **Clock synchronization**: The consumer's `now` should be NTP-synchronized. A consumer with a skewed clock may incorrectly expire valid receipts or accept expired ones. Fail-closed applies: on clock uncertainty, treat receipts as expired.

---

## 6. Operator Registration

### Publishing a Public Key

Every operator participating in MPAS must publish their signing public key at:

```
GET /.well-known/oracle-keys.json
```

per RFC 8615. The response format follows the SMA Protocol key discovery schema:

```json
{
  "service": "oracle",
  "spec": "https://headlessoracle.com/docs/sma-protocol/rfc-001",
  "keys": [
    {
      "key_id": "hex-encoded-32-byte-public-key",
      "algorithm": "Ed25519",
      "format": "hex",
      "public_key": "hex-encoded-32-byte-public-key",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": null
    }
  ]
}
```

Operators MUST serve this endpoint over HTTPS. Consumers MUST NOT accept public keys over HTTP.

### Key Rotation

Key rotation follows the SMA Protocol key lifecycle:

1. Before rotation: set `valid_until` to the scheduled rotation timestamp (minimum 24 hours notice recommended)
2. At rotation: publish the new key alongside the old key (both in the `keys` array)
3. After rotation: remove the old key from the array once all receipts signed with it have expired

Aggregators and consumers caching operator public keys MUST respect `valid_until` and re-fetch after rotation.

### Operator Independence Requirements

Operators participating in MPAS:

- MUST NOT share Ed25519 private keys with other operators
- MUST NOT co-locate their signing infrastructure in a way that creates a common failure mode (same cloud account, same physical host, same DNS provider if that provider is a point of compromise)
- MUST independently derive market state from primary sources — not from another MPAS participant
- MUST use distinct `operator_id` values (their canonical domain) that are verifiable via HTTPS

An operator that delegates signing to shared infrastructure is not independent, even if they hold a distinct key. The key is a proof of authorship, not a proof of independence.

### Discovery Without a Registry

In the absence of a formal registry, consumers can discover operators by:

1. Configuration: hardcode a list of known operator endpoints and public keys at deployment time
2. Curated manifest: fetch a signed JSON manifest from a curator (introduces curator trust assumption)
3. Web search / community: operators self-announce and consumers vet independently

A canonical operator registry format is deferred to a future spec revision (see Section 11).

---

## 7. On-Chain Verification Sketch

Smart contract consumers need to verify MPAS quorum without an off-chain aggregator in the trust path. The following describes two approaches.

### Approach A: Off-Chain Aggregation with On-Chain Settlement

The aggregator runs off-chain, produces an `AggregatedAttestation`, and submits it to a smart contract that verifies the individual signatures.

The contract receives:
- Array of (operator_public_key, receipt_canonical_payload, signature) tuples
- Quorum threshold N
- Maximum allowed window_ms
- The asserted market status

```solidity
// Pseudocode — not production-ready
function verifyQuorum(
    bytes32[] memory publicKeys,
    bytes[] memory canonicalPayloads,
    bytes[] memory signatures,
    uint256 required,
    uint256 windowMs,
    bytes32 assertedStatus
) public view returns (bool) {
    require(publicKeys.length == canonicalPayloads.length, "length mismatch");
    require(publicKeys.length == signatures.length, "length mismatch");

    uint256 agreeing = 0;
    uint256 earliestIssuedAt = type(uint256).max;
    uint256 latestIssuedAt = 0;

    for (uint i = 0; i < publicKeys.length; i++) {
        // EIP-665: Ed25519 signature verification
        // ed25519verify(message, signature, publicKey) => bool
        bool valid = ed25519verify(
            canonicalPayloads[i],
            signatures[i],
            publicKeys[i]
        );
        if (!valid) continue;

        // Parse issued_at from canonical payload (implementation-specific)
        uint256 issuedAt = parseIssuedAt(canonicalPayloads[i]);
        uint256 expiresAt = parseExpiresAt(canonicalPayloads[i]);
        bytes32 status = parseStatus(canonicalPayloads[i]);

        if (block.timestamp > expiresAt) continue;  // expired
        if (status != assertedStatus) continue;       // disagrees

        if (issuedAt < earliestIssuedAt) earliestIssuedAt = issuedAt;
        if (issuedAt > latestIssuedAt) latestIssuedAt = issuedAt;

        agreeing++;
    }

    // Window check
    require(latestIssuedAt - earliestIssuedAt <= windowMs / 1000, "window exceeded");

    return agreeing >= required;
}
```

**EIP-665 note**: Ed25519 signature verification is not yet a standard EVM precompile as of this writing. EIP-665 proposes adding it. Until EIP-665 is live on the target chain, on-chain Ed25519 verification requires a Solidity Ed25519 library (available but gas-intensive) or a precompile on chains that have already added it (e.g. some L2s). Consumers should evaluate gas cost against security requirements.

### Approach B: Aggregator-Free Threshold Signatures

The long-term path eliminates the aggregator entirely. With threshold signature schemes such as FROST (Flexible Round-Optimized Schnorr Threshold) or MuSig2, N operators each contribute a partial signature. The resulting aggregated signature is a single standard Ed25519 (or Schnorr) signature that a verifier can check with one public key — with the property that producing the signature required participation from at least T-of-N key holders.

This approach requires:
1. A distributed key generation (DKG) ceremony where operators collectively produce a shared public key and individual key shares
2. A signature aggregation round for each attestation
3. The consumer verifies one signature against one public key — the threshold guarantee is cryptographic, not trust-based

Ed25519 was chosen for the SMA Protocol specifically because it composes cleanly into threshold schemes. MPAS v2.0 will specify this path when suitable implementations mature.

---

## 8. Reference Implementation Notes

### Aggregator (TypeScript)

```typescript
interface OperatorConfig {
  operatorId: string;      // e.g. "headlessoracle.com"
  receiptUrl: string;      // e.g. "https://headlessoracle.com/v5/status"
  publicKey: string;       // hex-encoded Ed25519 public key
  apiKey?: string;         // if the operator requires authentication
}

async function fetchAttestation(
  operator: OperatorConfig,
  mic: string
): Promise<Attestation | null> {
  try {
    const res = await fetch(`${operator.receiptUrl}?mic=${mic}`, {
      headers: operator.apiKey ? { 'X-Oracle-Key': operator.apiKey } : {}
    });
    if (!res.ok) return null;
    const data = await res.json();
    const receipt = data.receipt ?? data;  // handle discovery_url wrapper
    const verified = await verifySMAReceipt(receipt, operator.publicKey);
    return { operator_id: operator.operatorId, receipt, verified };
  } catch {
    return null;
  }
}

async function aggregateAttestation(
  operators: OperatorConfig[],
  mic: string,
  quorumRequired: number,
  windowMs: number = 5000
): Promise<AggregatedAttestation> {
  const aggregated_at = new Date().toISOString();

  // Fetch all operators in parallel — do not wait for slow operators to block fast ones
  const results = await Promise.all(
    operators.map(op => fetchAttestation(op, mic))
  );

  const attestations = results.filter(a => a !== null) as Attestation[];

  // Compute consensus
  const consensus = computeConsensus(attestations, quorumRequired, windowMs);

  return {
    mpas_version: "1.0",
    mic,
    status: consensus.agreedStatus ?? "UNKNOWN",
    quorum: { required: quorumRequired, provided: attestations.length },
    window_ms: windowMs,
    aggregated_at,
    attestations,
    consensus: consensus.result
  };
}
```

### Aggregator (Python)

```python
import asyncio
import aiohttp
from typing import Optional

async def fetch_attestation(
    session: aiohttp.ClientSession,
    operator_id: str,
    receipt_url: str,
    public_key: str,
    mic: str,
    api_key: Optional[str] = None
) -> Optional[dict]:
    headers = {"X-Oracle-Key": api_key} if api_key else {}
    try:
        async with session.get(f"{receipt_url}?mic={mic}", headers=headers) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            receipt = data.get("receipt", data)  # handle discovery_url wrapper
            verified = verify_sma_receipt(receipt, public_key)
            return {"operator_id": operator_id, "receipt": receipt, "verified": verified}
    except Exception:
        return None

async def aggregate_attestation(operators: list[dict], mic: str, quorum_required: int, window_ms: int = 5000) -> dict:
    async with aiohttp.ClientSession() as session:
        tasks = [
            fetch_attestation(session, op["operator_id"], op["receipt_url"], op["public_key"], mic, op.get("api_key"))
            for op in operators
        ]
        results = await asyncio.gather(*tasks)

    attestations = [r for r in results if r is not None]
    consensus = compute_consensus(attestations, quorum_required, window_ms)

    return {
        "mpas_version": "1.0",
        "mic": mic,
        "status": consensus.get("agreed_status", "UNKNOWN"),
        "quorum": {"required": quorum_required, "provided": len(attestations)},
        "window_ms": window_ms,
        "aggregated_at": datetime.utcnow().isoformat() + "Z",
        "attestations": attestations,
        "consensus": consensus["result"]
    }
```

### No New Cryptographic Dependencies

The aggregator uses the same Ed25519 verification already required by SMA Protocol consumers. No new cryptographic libraries are needed. The `verifySMAReceipt` / `verify_sma_receipt` functions are the same functions used to verify individual SMA receipts — which every SMA consumer already implements.

---

## 9. Trust Model Comparison

| Configuration | Latency | Trust Requirement | Failure Tolerance | Recommended For |
|---|---|---|---|---|
| Single-operator SMA | ~50ms | Operator-reputation trust | None — one failure = total failure | Early adopters, low-stakes queries, development |
| MPAS 2-of-3 | ~100–200ms (parallel) | Collusion of 2 independent operators | 1 operator failure | Production autonomous agents, DeFi triggers |
| MPAS 3-of-5 | ~100–200ms (parallel) | Collusion of 3 independent operators | 2 operator failures | High-value settlement, regulatory-sensitive contexts |
| MPAS 3-of-3 | ~100–200ms (parallel) | All 3 operators collude | 0 — any failure → INSUFFICIENT | Maximum conservatism, circuit-breaker enforcement |
| On-chain (Approach A) | ~500ms–2s + block time | On-chain contract correctness | Depends on quorum config | Smart contract execution, DeFi automated settlement |
| Threshold sig (future) | ~100–300ms + aggregation round | Cryptographic, no trusted aggregator | Depends on T-of-N config | Infrastructure-grade, aggregator-free deployment |

**Latency note**: Parallel fetching means the effective latency is determined by the slowest responding operator, not the sum. With a 5-second timeout and 3 operators, a 2-of-3 quorum succeeds as soon as any 2 respond.

**Cost of increased assurance**: MPAS 2-of-3 requires trust relationships with (or payments to) 2 additional oracle operators. For many consumers, the operator-coordination overhead of MPAS will be worthwhile only when acting on the oracle result carries material financial or operational risk. Single-operator SMA is not wrong — it is appropriate for the risk level it is designed for.

---

## 10. Relationship to SMA Protocol

MPAS is defined as a composition layer above SMA Protocol v1.0.0. The relationship:

- **SMA Protocol** defines: the signed receipt format, canonical payload serialization, Ed25519 signing algorithm, key discovery protocol, fail-closed semantics, and individual receipt verification
- **MPAS** defines: how multiple SMA receipts are collected, how quorum is determined, and what guarantees a consumer may derive from an agreed quorum

There is no new signature scheme in MPAS. There are no new cryptographic primitives. The only new artifact is the `AggregatedAttestation` JSON container, which is unsigned (its integrity is inherited from the independently-signed receipts it contains).

**Ed25519 was chosen for SMA Protocol specifically to compose cleanly into threshold signature schemes.** The migration from MPAS (with aggregator) to threshold-signature-based MPAS (without aggregator) does not require changing the underlying key type. Operators that generate Ed25519 keys today are participating in the same key material that will support FROST-based threshold signing when that path is ready.

Consumers implementing MPAS SHOULD also implement the full SMA Protocol consumer checklist for each individual attestation:

1. Fetch signed receipt from operator
2. Verify Ed25519 signature against operator's published public key
3. Check `expires_at` — reject expired receipts
4. Check `issued_at` is within the expected window
5. Check `receipt_mode == "live"` (reject demo receipts in production)
6. Apply fail-closed: treat UNKNOWN and HALTED as CLOSED
7. Then, and only then, apply MPAS quorum logic across verified receipts

Steps 1–6 MUST precede MPAS quorum logic. An invalid SMA receipt does not become valid by being included in an `AggregatedAttestation`.

---

## 11. Gaps and Known Limitations

### No Canonical Registry Format

This spec does not define how consumers discover operator endpoints and public keys. Operator discovery is an open problem. Without a canonical registry, MPAS deployments will use hardcoded operator lists or ad-hoc discovery mechanisms that themselves introduce trust assumptions.

**Deferred to**: MPAS v1.1 or a companion Registry Specification.

### The Aggregator Trust Assumption

The Aggregator role in this spec is a new trust assumption. A consumer that delegates aggregation to a third party is trusting that the aggregator:

- Actually fetched from the claimed operators (not spoofed responses)
- Correctly verified each signature
- Accurately reported which operators responded within the window
- Did not selectively include or exclude attestations to manufacture a desired consensus

A malicious aggregator can forge a quorum by fabricating `verified: true` on receipts it never received, if the consumer accepts the aggregator's output without re-verification. **Consumers MUST independently re-verify all attestation signatures.** They MUST NOT trust the `verified` field set by an aggregator.

The fix is threshold signatures (FROST or MuSig2), where the aggregated signature itself proves that T-of-N key holders participated in producing it — making the aggregator role unnecessary. Ed25519 was chosen to make this migration possible. Until threshold signing is specified, consumers who cannot independently verify should run the aggregator themselves rather than delegating to a third party.

**Deferred to**: MPAS v2.0 — Threshold Signature Extension.

### Operator Independence is Unverifiable

This spec requires that operators be independent, but provides no cryptographic proof of independence. Two operators could share signing infrastructure (or one operator could control two keys) while appearing independent to consumers. The trust model is: independence is asserted, not verified.

Potential future mitigations include:
- Signed attestations of independence from operators (legal / contractual, not cryptographic)
- On-chain operator registration with slashing conditions (cryptoeconomic)
- SGX/TEE-attested signing nodes (hardware-rooted independence)

### No Dispute Resolution Protocol

When `consensus == "DISAGREE"`, this spec says halt. It does not specify how to investigate which operator is wrong, how to report discrepancies, or how to update operator trust scores over time. A persistent DISAGREE state with no resolution mechanism is a denial-of-service vector.

**Deferred to**: a companion Operator Monitoring and Dispute Resolution specification.

---

## Gap Statement

One gap this spec does not yet solve: the Aggregator role is a new trust assumption. An aggregator that lies about which operators responded — or fabricates verified attestations — can forge a quorum against a consumer that does not independently re-verify. The fix is threshold signatures (FROST or MuSig2), where the aggregated signature itself proves participation without requiring a trusted intermediary. Under FROST, N operators each contribute a partial signature, and the result is a single standard Ed25519 signature verifiable against a single public key — with the participation of T-of-N key holders cryptographically guaranteed. Ed25519 was chosen for the SMA Protocol precisely to make this migration possible. MPAS v2.0 will specify this path when suitable FROST implementations are production-ready across the target language ecosystems. Until then, consumers who require aggregator-free verification should run the aggregation step themselves.

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| MPAS | Multi-Party Attestation Aggregation Spec — this document |
| SMA | Signed Market Attestation — the underlying single-operator receipt protocol |
| Quorum | The minimum number of independent operators that must agree for consensus to be valid |
| AggregatedAttestation | The JSON container defined by this spec, holding N individual SMA receipts |
| Consensus | The computed agreement status: AGREE, DISAGREE, or INSUFFICIENT |
| Window | The maximum allowed time difference between the earliest and latest `issued_at` across attestations |
| FROST | Flexible Round-Optimized Schnorr Threshold — a threshold signature scheme for Ed25519-compatible keys |
| DKG | Distributed Key Generation — a ceremony in which N parties jointly produce a shared public key and individual key shares, such that no single party knows the full private key |
| Fail-closed | The safety principle: when in doubt, halt. Unknown or ambiguous state is treated as the restrictive case. |

## Appendix B: Version History

| Version | Date | Notes |
|---|---|---|
| 1.0.0-draft | 2026-03-30 | Initial draft. Aggregator-based model. Threshold signing deferred to v2.0. |

---

*This specification is published under the Apache 2.0 License. Contributions and implementations welcome. Canonical URL: https://headlessoracle.com/docs/mpas*
