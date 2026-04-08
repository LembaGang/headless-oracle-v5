# Compliance: Signed Market-State Attestations for Autonomous Trading

## Why signed attestations matter for autonomous trading

Regulators are moving to require verifiable audit trails for algorithmic and autonomous trading systems. Three regulatory developments in early 2026 set the direction:

**ESMA (European Securities and Markets Authority) — February 2026**
Updated guidance on algorithmic trading under MiFID II requires that algorithms be explainable and that third-party data sources used in execution decisions be auditable. Firms deploying autonomous agents for trade execution must demonstrate that the data informing each decision was sourced, timestamped, and independently verifiable.

**NIST (National Institute of Standards and Technology) — February 2026**
The Bureau of Standards and Analytics called for "cryptographic chains of custody" for agent authorization in financial systems. The recommendation targets autonomous systems that make execution decisions without human-in-the-loop approval — specifically requiring that each decision point in the chain be cryptographically signed and independently auditable.

**Singapore MAS — January 2026**
Singapore published the world's first agentic AI governance framework, requiring "technical controls" for autonomous agents operating in regulated markets. The framework mandates that agent actions be traceable, that data sources be verifiable, and that fail-safe mechanisms exist when data integrity cannot be confirmed.

## How Headless Oracle receipts work

Every response from the Headless Oracle API is a cryptographically signed receipt containing:

| Field | Purpose |
|---|---|
| `mic` | ISO 10383 Market Identifier Code (e.g., XNYS for NYSE) |
| `status` | OPEN, CLOSED, HALTED, or UNKNOWN |
| `timestamp` | ISO 8601 UTC timestamp of receipt generation |
| `expires_at` | Timestamp after which the receipt must not be used (60s TTL) |
| `issuer` | `headlessoracle.com` — identifies the attestation source |
| `signature` | Ed25519 signature over the canonical JSON payload |

**Ed25519 signature**: The entire payload (all fields except `signature`, keys sorted alphabetically, compact JSON) is signed with the Oracle's Ed25519 private key. Any consumer can verify the signature using the public key at `/v5/keys` or `/.well-known/oracle-keys.json`.

**60-second TTL**: Receipts expire 60 seconds after issuance. This prevents stale-data liability — an agent cannot use a receipt from 5 minutes ago to justify a trade executed now.

**Fail-closed architecture**: If the Oracle cannot determine market state with certainty, it returns `UNKNOWN`. The SMA Protocol specification requires that consumers treat `UNKNOWN` as `CLOSED` and halt all execution. This is the regulatory safe harbor: when in doubt, do not trade.

**Independent verification**: Any third party can verify a receipt's authenticity using only the receipt itself and the public key. No trust in the agent, the trading firm, or the Oracle operator is required. The receipt is self-proving.

## Audit trail pattern

A compliant autonomous trading workflow using Headless Oracle:

1. **Agent calls `get_market_status`** before executing a trade
2. **Receipt returned** with signed market state (e.g., XNYS: OPEN)
3. **Agent verifies signature** using `@headlessoracle/verify` or native Ed25519
4. **Agent checks `expires_at`** — receipt must not be expired
5. **Agent checks `status`** — only proceeds if OPEN
6. **Receipt stored alongside trade record** — the receipt_id, signature, and full receipt JSON are persisted with the trade execution log
7. **Third-party audit**: any auditor can independently verify that:
   - The market was confirmed OPEN at the time of trade
   - The receipt was issued within its TTL window
   - The signature is valid against the Oracle's published public key
   - No trust in the agent or trading firm is required

The receipt is the audit artifact. It is self-contained, independently verifiable, and timestamped.

## Regulatory alignment

| Requirement | Regulation | Headless Oracle Feature |
|---|---|---|
| Third-party data must be auditable | ESMA MiFID II (2026 update) | Ed25519 signed receipts with issuer field |
| Algorithms must be explainable | ESMA MiFID II (2026 update) | Deterministic status (OPEN/CLOSED/HALTED/UNKNOWN), no ML inference |
| Cryptographic chain of custody | NIST BSA (Feb 2026) | Signed payload → agent decision → trade record. Each link verifiable. |
| Agent authorization must be auditable | NIST BSA (Feb 2026) | Receipt signature serves as attestation_ref in authorization chain |
| Technical controls for autonomous agents | Singapore MAS (Jan 2026) | Fail-closed: UNKNOWN = CLOSED. Agent cannot trade on ambiguous state. |
| Fail-safe when data integrity unconfirmed | Singapore MAS (Jan 2026) | Tier 2/3 fallback returns UNKNOWN with signature. Never silent failure. |
| Data sources must be verifiable | Singapore MAS (Jan 2026) | Public key at /.well-known/oracle-keys.json. Independent verification. |
| Traceability of agent actions | Singapore MAS (Jan 2026) | receipt_id + signature stored with each trade provides full trace |

## Verification endpoints

| Endpoint | Purpose |
|---|---|
| `GET /v5/keys` | Public key registry with canonical payload specification |
| `GET /.well-known/oracle-keys.json` | RFC 8615 key discovery |
| `GET /v5/compliance` | APTS conformance check (6 pre-trade safety checks) |
| `POST /v5/verify` | Server-side receipt verification (Ed25519) |
| `GET /v5/conformance-vectors` | 5 signed test vectors for SDK authors |
