# Multi-Oracle Consensus Protocol for Market-State Verification

**Version**: 1.0.1 (errata correction, 2026-04-22)
**Status**: Published Standard
**License**: MIT
**Editor**: Headless Oracle (headlessoracle.com)
**Canonical URL**: https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1
**Machine-Readable**: https://headlessoracle.com/v1/verification/multi-oracle-guide

**Changelog**: v1.0.1 removes references in Sections 3 and 10 to a
regulatory framework name that did not correspond to a specific
published document. Replaced with citations to CFTC Staff Letter 25-39
(December 2025) and the SEC Crypto Task Force Project Blueprint on
Tokenized Collateral (November 2025), both of which are
government-published. Section 10 ESMA/NIST/MAS references removed
pending independent verification.

## Abstract

This specification defines how an autonomous agent SHOULD query multiple
independent market-state oracles and reach consensus before executing a
financial transaction. It establishes a minimum-oracle-count threshold
and a fail-closed consensus algorithm consistent with the architectural
direction in emerging regulatory guidance on tokenized collateral (CFTC
Staff Letter 25-39, December 2025; SEC Crypto Task Force Project
Blueprint on Tokenized Collateral, November 2025).

This is a verification standard for *market state* — whether an exchange is
open, closed, halted, in pre-market, after-hours, on a scheduled break, or
unknown — not for *price feeds*. Price-oracle consensus is out of scope.

## 1. Scope

In scope:

- Verifying whether one or more exchanges are in a tradeable state at a given
  instant.
- Reaching agreement across independent oracle providers on that state.
- Defining the minimum cryptographic and structural requirements an oracle
  response MUST meet to participate in consensus.
- Defining the agent-side decision rules that turn N oracle responses into a
  single execute / do-not-execute outcome.

Out of scope:

- Price discovery, last-trade prices, orderbook depth.
- Settlement, custody, and post-trade workflows.
- Identity of the oracle operator (covered separately by APTS and MPAS).

## 2. Terminology

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document
are to be interpreted as described in RFC 2119.

**Signed Market-State Attestation (SMA)**
A cryptographically signed statement, issued by an oracle, asserting the
state of a single exchange at a single point in time. The minimum field set
is defined in section 5.

**Oracle feed**
An independent oracle endpoint that issues SMAs. Two feeds are independent
if they are operated by different entities, signed with different keys, and
do not share an upstream data source or signing infrastructure.

**Consensus threshold**
The minimum number of oracle feeds whose valid SMAs must agree on the same
market state for the agent to proceed. Defined as `floor(N/2) + 1` where N
is the number of valid responses.

**Fail-closed default**
The behavior an agent MUST exhibit when consensus cannot be established:
treat the market as CLOSED and do not execute the trade.

**UNKNOWN**
A distinct market-state value that an oracle MUST emit when it cannot
determine the true state. UNKNOWN is treated as CLOSED for execution
purposes but MUST be preserved as UNKNOWN in audit logs.

## 3. Minimum Oracle Count

An agent MUST query at least three independent oracle feeds before
executing any trade where venue-state verification is load-bearing for
capital safety. Fewer than three valid responses MUST result in a
fail-closed outcome. This threshold reflects standard Byzantine-fault-
tolerance practice (tolerance of one faulty feed in three) and is
consistent with the architectural direction in the SEC Crypto Task
Force's Project Blueprint on Tokenized Collateral (November 2025).

The agent MAY query more than three; the consensus rule scales with N.

## 4. Consensus Algorithm

The agent MUST implement the following algorithm:

1. Query all configured oracle feeds in parallel with a uniform timeout
   (RECOMMENDED: 2000 ms).
2. For each response, perform the verification flow defined in section 6.
3. Discard any response that fails verification or whose `expires_at` has
   passed at the moment of evaluation.
4. Let `V` be the set of remaining valid SMAs. If `|V| < 3`, the agent MUST
   NOT execute the trade.
5. Group `V` by `status`. Let `M` be the largest group.
6. If `|M| >= floor(|V|/2) + 1` AND every member of `M` has `status = "open"`,
   the agent MAY proceed to the next pre-trade verification layer.
7. In all other cases — including a tied vote, a majority for any non-open
   status, or unanimous disagreement — the agent MUST NOT execute the
   trade. The agent SHOULD log the disagreement for human review.

The algorithm is named `majority_with_fail_closed`.

## 5. Attestation Format

Each oracle response MUST contain at least the following fields. Additional
fields are permitted but MUST NOT be required by verifiers.

| Field            | Type    | Description                                                                       |
|------------------|---------|-----------------------------------------------------------------------------------|
| `exchange`       | string  | ISO 10383 Market Identifier Code (MIC), e.g. `XNYS`.                              |
| `status`         | enum    | One of: `open`, `closed`, `pre_market`, `after_hours`, `break`, `halted`, `unknown`. |
| `timestamp`      | string  | ISO 8601 UTC instant the attestation was issued.                                  |
| `expires_at`     | string  | ISO 8601 UTC instant after which the attestation MUST NOT be acted on.            |
| `signature`      | string  | Base64-encoded Ed25519 signature (or equivalent algorithm — see section 8).       |
| `public_key_url` | string  | HTTPS URL where the oracle's signing key can be retrieved.                        |
| `oracle_id`      | string  | Globally unique identifier for the oracle provider.                               |

The interval `expires_at - timestamp` MUST NOT exceed 60 seconds. This
matches the receipt TTL constraint inherited from the Signed Market-State
Attestation profile and limits the blast radius of a stolen receipt.

The `status` enum is closed: an oracle MUST NOT emit any value outside this
set. New states require a versioned revision of this specification.

## 6. Verification Flow

For every oracle response, the agent MUST execute the following steps in
order. Failure at any step MUST cause the response to be discarded.

1. **Discover** the oracle endpoint via MCP, `/.well-known/agent.json`,
   `/.well-known/oracle-keys.json`, a registry, or hardcoded configuration.
2. **Fetch** the response under the timeout from section 4.
3. **Parse** the response and confirm every field in section 5 is present
   and well-formed.
4. **Retrieve** the public key from `public_key_url`. The agent SHOULD
   cache this key with a TTL no longer than 24 hours.
5. **Verify** the signature against the canonical payload as defined by
   the oracle's published signing specification. (For Headless Oracle, the
   canonical payload is the SMA fields sorted alphabetically and serialized
   as JSON without whitespace.)
6. **Check freshness** — `expires_at` MUST be in the future relative to the
   agent's current monotonic clock.
7. **Admit** the response to the consensus pool only if every preceding
   step succeeded.

After all responses have been processed, the agent applies the consensus
algorithm in section 4 and proceeds or halts accordingly.

## 7. Error Handling

| Condition                                | Required behavior                                              |
|------------------------------------------|----------------------------------------------------------------|
| Network timeout                          | Treat the missing response as `closed` for accounting; do not include in `V`. |
| Invalid signature                        | Discard the response. Log `oracle_id`, `signature`, and reason. |
| Expired `expires_at`                     | Discard the response.                                          |
| Schema violation                         | Discard the response.                                          |
| Disagreement (no clear majority)         | Use majority if one exists for `open`; otherwise fail-closed. Flag for human review. |
| Fewer than 3 valid responses             | Do not trade. This is a hard floor.                            |
| Public key fetch failure                 | Discard the response. Optionally retry once with backoff.      |
| Oracle returns `unknown`                 | Count as a valid vote for `unknown` (which is not `open`).     |

Errors MUST NOT be silently swallowed. Every discard SHOULD produce an
auditable log entry containing `oracle_id`, the failure reason, and the
agent's local timestamp.

## 8. Cryptographic Requirements

The default signature algorithm is Ed25519. An oracle MAY use an alternate
algorithm provided that:

- The algorithm is declared at `public_key_url` alongside the public key.
- The agent's verifier supports the algorithm.
- The algorithm provides at least 128-bit security.

ECDSA over secp256k1 and Ed25519 are RECOMMENDED. RSA-PSS with at least
2048-bit keys is permitted. SHA-1 and 1024-bit RSA are forbidden.

## 9. Reference Implementation

Headless Oracle is the first compliant implementation of this specification.

| Property                | Value                                              |
|-------------------------|----------------------------------------------------|
| `oracle_id`             | `headlessoracle.com`                               |
| Endpoint (REST)         | `https://headlessoracle.com/v5/status`             |
| Endpoint (MCP)          | `https://headlessoracle.com/mcp`                   |
| `public_key_url`        | `https://headlessoracle.com/v5/keys`               |
| Signature algorithm     | Ed25519                                            |
| Exchanges               | 28 global venues (equities, derivatives, crypto)  |
| Receipt TTL             | 60 seconds                                         |
| Fail-closed             | Yes — `unknown` is always treated as `closed`     |

A second and third independent implementation are required to satisfy the
minimum oracle count in production. This specification exists in part to
make it possible for those implementations to interoperate without bilateral
coordination.

## 10. Regulatory Alignment

This specification is architecturally consistent with emerging regulatory
direction on tokenized collateral and algorithmic execution:

- **CFTC Staff Letter 25-39** (December 2025) — technology-neutral
  guidance on tokenized collateral; final rulemaking expected August 2026.
- **SEC Crypto Task Force Project Blueprint on Tokenized Collateral**
  (November 2025) — discusses multiple independent oracles and
  cryptographic attestation as architectural building blocks.

Where this specification uses RFC 2119 MUST/SHOULD language, the
normative force derives from the specification itself, not from any
external regulatory document. Operators MUST evaluate their own
regulatory obligations independently.

## 11. Versioning and Changes

This is version 1.0.1 (errata correction from v1.0.0). Backwards-incompatible changes will be published
under a new major version at a new URL. The current version will continue
to be served at its canonical URL.

Comments, errata, and proposed changes can be submitted at
https://github.com/LembaGang/headless-oracle-v5/issues.

## 12. License

This specification is published under the MIT License. Implementers MAY
copy, redistribute, and build on it without restriction.
