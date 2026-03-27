import sys

filepath = r'C:\Users\User\headless-oracle-v5\src\index.ts'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# RFC content - inline as template literal constant
rfc_constant = '''
const SMA_RFC_001_MD = `# SMA-RFC-001: Signed Market Attestation Protocol v1.0.0

\`\`\`
Status:          Draft — Seeking Implementations
Date:            2026-03-27
Author:          LembaGang (headlessoracle.com)
License:         Apache 2.0
Repository:      github.com/LembaGang/sma-protocol
\`\`\`

---

## Terminology Disambiguation

**In this document, SMA denotes "Signed Market Attestation."**

This usage is entirely distinct from the statistical term "Simple Moving Average" (SMA) used in technical analysis and quantitative finance. All schema fields, OpenAPI descriptions, and agent tool descriptions that reference this protocol MUST use the full phrase "Signed Market Attestation" alongside the acronym on first reference.

---

## Abstract

This document specifies the Signed Market Attestation (SMA) Protocol — a cryptographic attestation format enabling autonomous financial agents to verify the operational state of global financial exchanges with non-repudiable, machine-verifiable proof.

The protocol defines: a canonical receipt schema, an Ed25519 signing procedure, key discovery conventions, TTL semantics, fail-closed behaviour, and conformance requirements for both issuers and verifiers.

---

## 1. Conformance Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119].

---

## 2. Exchange State Model

Every exchange covered by the SMA Protocol MUST be in exactly one of the following states:

| State     | Meaning                                                                 |
|-----------|-------------------------------------------------------------------------|
| OPEN    | The exchange is accepting orders. Execution MAY proceed.                |
| CLOSED  | The exchange is not accepting orders. Execution MUST NOT proceed.       |
| HALTED  | Trading is suspended (circuit breaker, regulatory halt). MUST NOT proceed. |
| UNKNOWN | State cannot be determined. MUST be treated as CLOSED by all verifiers. |

**Fail-Closed Invariant**: A conformant verifier MUST deny execution for any state that is not OPEN. UNKNOWN is not a recoverable state — it is equivalent to CLOSED for all execution purposes.

---

## 3. Receipt Schema

A complete SMA receipt is a JSON object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| mic | string | REQUIRED | ISO 10383 MIC code. MUST be uppercase. |
| status | string | REQUIRED | One of: OPEN, CLOSED, HALTED, UNKNOWN. |
| issued_at | string | REQUIRED | ISO 8601 UTC timestamp of attestation. |
| expires_at | string | REQUIRED | ISO 8601 UTC timestamp of expiry. |
| ttl_seconds | integer | OPTIONAL | Duration in seconds (typically 60). |
| schema_version | string | REQUIRED | SMA Protocol version. Current: "v5.0". |
| issuer | string | REQUIRED | Domain of the issuing oracle. |
| public_key_id | string | REQUIRED | Key identifier matching an entry in /.well-known/oracle-keys.json. |
| signature | string | REQUIRED | Hex-encoded Ed25519 signature over the canonical payload. |
| discovery_url | string | OPTIONAL | URL to issuer MCP server-card.json for capability discovery. |

---

## 4. Canonical Payload and Signing

### 4.1 Canonical Payload Fields

The following fields are included in the canonical payload, sorted alphabetically by key:

\`\`\`
expires_at, halt_detection, issued_at, issuer, mic, public_key_id, receipt_id, receipt_mode, schema_version, source, status
\`\`\`

Fields NOT part of the canonical payload: signature, discovery_url, exchange_name, timezone.

### 4.2 Serialisation

The canonical payload MUST be serialised as compact JSON with keys in alphabetical (Unicode code point) order. No extraneous whitespace.

### 4.3 Signing Algorithm

Issuers MUST use Ed25519 [RFC8037]:

\`\`\`
signature = Ed25519_Sign(private_key, UTF8(JSON.stringify(sortedPayload)))
\`\`\`

The resulting 64-byte signature MUST be encoded as hex (lowercase).

---

## 5. Key Discovery

Issuers MUST publish their active public keys at:

\`\`\`
GET /.well-known/oracle-keys.json
\`\`\`

---

## 6. TTL and Expiry Semantics

- Issuers MUST set expires_at = issued_at + 60 seconds (reference implementation).
- Verifiers MUST check expires_at before trusting a receipt.
- Expired receipts MUST be treated as UNKNOWN (CLOSED).
- Verifiers MUST NOT cache receipts beyond their expires_at timestamp.

---

## 7. Fail-Closed Requirements (Normative)

1. A verifier that cannot contact the issuer MUST default to UNKNOWN (CLOSED).
2. A verifier that receives an invalid signature MUST treat the state as UNKNOWN (CLOSED).
3. A verifier that receives status: "UNKNOWN" MUST deny execution.
4. A verifier that receives an expired receipt MUST treat the state as UNKNOWN (CLOSED).
5. A verifier that receives a receipt for the wrong MIC MUST treat the state as UNKNOWN (CLOSED).

---

## 8. DST and Timezone Handling

Issuers MUST use IANA timezone identifiers (e.g., "Europe/London"), not UTC offsets. The IANA timezone database handles all DST transitions automatically.

**The US-Europe DST Gap (2026)**: US transitions March 8, Europe transitions March 29. During the 21-day window (March 8-29), the NY/London offset compresses from 5 hours to 4 hours. Agents with hardcoded UTC offsets produce incorrect cross-market overlap calculations.

SMA receipts are immune to this vulnerability because they use IANA timezones.

---

## 9. Conformance Requirements Summary

### 9.1 Issuer Conformance (MUST)

- [ ] Produce receipts with all REQUIRED fields
- [ ] Use ISO 10383 MIC codes (uppercase)
- [ ] Use IANA timezone identifiers (no UTC offsets)
- [ ] Sign receipts using Ed25519 over alphabetically-sorted compact JSON
- [ ] Publish public keys at /.well-known/oracle-keys.json
- [ ] Return UNKNOWN (never omit status) when state cannot be determined

### 9.2 Verifier Conformance (MUST)

- [ ] Validate signature using issuer public key
- [ ] Check expires_at before trusting any receipt
- [ ] Treat UNKNOWN, expired, and invalid-signature receipts as CLOSED
- [ ] Never execute against a non-OPEN state

---

## 10. Conformance Vectors

Machine-testable conformance vectors are published at:

\`\`\`
GET https://api.headlessoracle.com/v5/conformance-vectors
\`\`\`

---

## 11. Compatible Implementations

| Implementation | Language | Role | Link |
|---|---|---|---|
| Headless Oracle | TypeScript (CF Workers) | Issuer (28 exchanges) | headlessoracle.com |
| headless-oracle-go | Go | Verifier SDK | github.com/LembaGang/headless-oracle-go |
| @headlessoracle/verify | JavaScript | Verifier SDK | npmjs.com/@headlessoracle/verify |
| headless-oracle | Python | Client + Verifier | pypi.org/project/headless-oracle |

---

## 12. Relationship to Other Standards

- **MCP**: SMA receipts are delivered as MCP tool responses. The discovery_url field enables capability discovery.
- **A2A**: SMA receipts are transport-portable and MAY be included in A2A task messages.
- **x402**: Premium SMA endpoints are x402-payable on Base (eip155:8453, USDC).
- **ERC-8183**: Headless Oracle functions as an ERC-8183 Evaluator. An SMA receipt with status: "OPEN" can trigger conditional settlement.

---

## 13. Security Considerations

- **TTL**: Receipts expire in 60 seconds. Verifiers MUST enforce expiry.
- **Replay protection**: Per-request x402 payments use txHash KV with 600s TTL.
- **Key compromise**: Rotate immediately; publish new JWKS; remove old key after 24h grace period.
- **Post-quantum**: Ed25519 is not post-quantum secure. A future version SHOULD specify a migration path to CRYSTALS-Dilithium [FIPS204].

---

## 14. Normative References

- [RFC2119] Key words for use in RFCs
- [RFC7517] JSON Web Key (JWK)
- [RFC8037] CFRG Elliptic Curves for JOSE (Ed25519)
- [ISO10383] Market Identifier Codes
- [FIPS204] ML-DSA (post-quantum digital signature)

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| Draft-01 | 2026-03-27 | Initial draft |
`;

'''

# Insert after the SMA_SPEC_MD constant (right before APTS_STANDARD_MD)
marker = "\nconst APTS_STANDARD_MD = "
idx = content.find(marker)
if idx == -1:
    print("Marker not found")
    sys.exit(1)

content = content[:idx] + rfc_constant + content[idx:]
print(f"Inserted SMA_RFC_001_MD constant ({len(rfc_constant)} chars)")

# Now add the route to serve it
route_marker = "\t\t\t\tif (p === '/docs/rfc')\n\t\t\t\t\treturn new Response(RFC_EXTERNAL_STATE_MD, { headers: plainHeaders });"
route_addition = "\n\t\t\t\tif (p === '/docs/sma-protocol/rfc-001' || p === '/docs/sma-protocol/rfc-001.md')\n\t\t\t\t\treturn new Response(SMA_RFC_001_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });"

if route_marker in content:
    content = content.replace(route_marker, route_marker + route_addition, 1)
    print("Added /docs/sma-protocol/rfc-001 route")
else:
    print("Route marker not found")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print("Done.")
