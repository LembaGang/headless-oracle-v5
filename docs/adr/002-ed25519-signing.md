# ADR-002: Ed25519 for Receipt Signing

## Status
Accepted

## Date
2026-01-15

## Context
Every market-state receipt must be cryptographically signed so
consumers can verify authenticity without trusting the operator. We
needed a signature scheme that is fast, produces small signatures,
and composes into threshold/multisig schemes for future federation.

## Decision
Use Ed25519 via `@noble/ed25519` (pure JavaScript, audited
implementation by Paul Miller) with SHA-512 from `@noble/hashes`.

Canonical payload: keys sorted alphabetically, JSON.stringify with
no whitespace, then Ed25519 sign. The canonical field list is
published at `/v5/keys`.

## Consequences

**Benefits:**
- Deterministic signatures (same input always produces same output)
- 64-byte signatures, 32-byte keys — minimal overhead in receipts
- Fast: ~0.5ms to sign on Cloudflare Workers V8 isolate
- No external CA dependency — self-contained verification
- Composes into Ed25519 multisig/threshold schemes for federation
- Pure JS implementation — no native addons, works everywhere
- Web Crypto API compatible for consumer verification

**Trade-offs:**
- Not NIST-approved (vs ECDSA P-256) — some compliance contexts prefer NIST curves
- No built-in key rotation mechanism (addressed via `valid_from`/`valid_until`)
- Single private key is a trust concentration (mitigated by future threshold signing)

**Alternatives considered:**
- RSA-2048/4096: Too large (256-512 byte signatures), slower
- ECDSA P-256: Non-deterministic (requires extra entropy), footgun risk
- Ed448: Larger signatures for marginal security gain at this threat model
