# SMA Protocol v1.0 — Signed Market Attestation

Vendor-neutral open standard for cryptographically attested market state.

**Status**: v1.0.0 — Stable
**License**: Apache 2.0

---

## What It Is

SMA (Signed Market Attestation) is a protocol specification — not an implementation — for
representing market open/closed state as a cryptographically signed, self-describing receipt.

A conforming SMA receipt answers one question: *is this market open right now?* The answer
is signed by a known operator key, carries an expiry, and names the operator so any consumer
can independently locate the public key without prior configuration.

## Why It Exists

Autonomous agents that make financial decisions need market state they can:

1. Verify independently, without trusting the transport layer
2. Pass to other agents as a portable, self-contained proof
3. Act on deterministically — no ambiguous states, no silent failures

HTTP responses can be tampered with, cached stale, or silently fail. A signed receipt with a
short TTL and a named issuer survives all three failure modes: tampering breaks the signature,
stale data violates `expires_at`, and a missing issuer key means fail-closed.

## Key Properties

- **Ed25519 signed** — deterministic, compact, composable into threshold schemes
- **Alphabetically sorted canonical payload** — verifiable in any language without coordinating key insertion order
- **60-second TTL (`expires_at`)** — prevents stale receipts from being acted on near open/close transitions
- **`issuer` field** — FQDN of the oracle operator; agents resolve `{issuer}/v5/keys` without prior config
- **`receipt_mode`** — signed field distinguishing demo receipts from live production receipts
- **Fail-closed `UNKNOWN` status** — indeterminate state is explicit, never silently omitted

## Quick Start

Read [SPEC.md](./SPEC.md) for the full protocol specification.

For conformance requirements, see [CONFORMANCE.md](./CONFORMANCE.md).

## Reference Implementation

[Headless Oracle](https://headlessoracle.com) — 23 global exchanges, REST API, MCP server,
public key discovery at `/.well-known/oracle-keys.json`.

- REST: `GET https://headlessoracle.com/v5/demo?mic=XNYS`
- Key discovery: `GET https://headlessoracle.com/.well-known/oracle-keys.json`
- MCP server: `POST https://headlessoracle.com/mcp`

## Known Implementations

See [IMPLEMENTATIONS.md](./IMPLEMENTATIONS.md).

## License

Apache License 2.0. See [LICENSE](./LICENSE).
