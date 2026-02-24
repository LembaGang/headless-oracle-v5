# Architecture Decision Records — Headless Oracle V5

## ADR-001: Ed25519 for Signing
**Decision**: Use Ed25519 via `@noble/ed25519` + `@noble/hashes`
**Rationale**: Fast, small key sizes, deterministic signatures, no external CA dependency, auditable pure-JS implementation
**Alternatives considered**: RSA (too large), ECDSA (non-deterministic, footgun risk)
**Status**: Active

## ADR-002: Fail-Closed 4-Tier Architecture
**Decision**: KV override → Schedule computation → UNKNOWN fallback → CRITICAL_FAILURE unsigned 500
**Rationale**: A crashed oracle that returns UNKNOWN is safer than one that returns stale OPEN. Consumers are required by contract to treat UNKNOWN as CLOSED.
**Status**: Active

## ADR-003: IANA Timezone Names Only
**Decision**: No hardcoded UTC offsets anywhere in the codebase
**Rationale**: DST transitions are automatic and always correct. Hardcoded offsets require manual updates and are a recurring source of production incidents.
**Status**: Active — enforced in engineering standards

## ADR-004: Cloudflare KV for Circuit Breaker Overrides
**Decision**: `ORACLE_OVERRIDES` KV namespace for manual market halt signals
**Rationale**: Operators can halt trading signals without code changes or redeployment. Expiry timestamps prevent stale overrides from persisting indefinitely.
**Status**: Active

## ADR-005: Multi-Key API Gating
**Decision**: `MASTER_API_KEY` + comma-separated `BETA_API_KEYS` env vars for `/v5/status`
**Rationale**: Beta user access without exposing master key; per-user revocation without redeployment
**Status**: Active

## ADR-006: Public Routes — No Auth Required
**Decision**: `/v5/demo`, `/v5/schedule`, `/v5/exchanges`, `/v5/keys` are unauthenticated
**Rationale**: Market calendar and public key discovery must be accessible for integration without credentialing. Reduces onboarding friction.
**Status**: Active

## ADR-008: Receipt TTL via expires_at (60s)
**Decision**: All signed receipts include `expires_at: issued_at + 60s`, signed as part of the canonical payload.
**Rationale**: An agent caching a receipt has no way to know when `issued_at`-only receipts become stale. A 60s TTL forces re-fetch and prevents an OPEN receipt from being acted on after market close. The field is signed so consumers can verify it hasn't been tampered with.
**Alternatives considered**: No expiry (leaves agents with undefined cache semantics), longer TTL (too much stale-data risk near open/close transitions).
**Status**: Active — Feb 22 2026

## ADR-009: Canonical signing payload — alphabetical key sort
**Decision**: `signPayload` sorts all payload keys alphabetically before `JSON.stringify`. The canonical field list is published at `/v5/keys → canonical_payload_spec`.
**Rationale**: JS object key ordering is insertion-order-dependent. Without a canonical form, any field reorder in a future refactor silently breaks all existing verifiers. Alphabetical sort is simple, deterministic, and easy to implement in any language.
**Status**: Active — Feb 22 2026

## ADR-010: OpenAPI 3.1 spec at /openapi.json
**Decision**: Serve the full OpenAPI 3.1 spec as a static JSON response at `/openapi.json`.
**Rationale**: Agent-native discoverability requires machine-readable interface contracts. Agents using OpenAPI clients (e.g. via MCP tool calling) can auto-discover all routes, schemas, and auth requirements without reading documentation. Zero runtime cost — no generation on request.
**Status**: Active — Feb 22 2026

## ADR-007: Vitest + @cloudflare/vitest-pool-workers
**Decision**: Run tests inside a real Miniflare Workers runtime, not Node.js
**Rationale**: Catches Worker-specific API incompatibilities (crypto, KV, env bindings) that Node tests miss. Config in `vitest.config.mts` pointing to `wrangler.toml`.
**Status**: Active — note: config file is `wrangler.toml`, NOT `wrangler.jsonc` (deleted)

## ADR-011: lunch_break in /v5/schedule — local time, not UTC
**Decision**: `lunch_break.start` and `lunch_break.end` are local exchange time strings (`HH:MM`), not UTC instants.
**Rationale**: Lunch breaks are a static property of the exchange configuration, not a dynamic per-session value. Local times (`11:30`, `12:30`) are meaningful and stable. UTC equivalents would be identical (XJPX and XHKG do not observe DST) but would require computing per-request and are less readable. The `timezone` field already in the response gives consumers everything they need to convert if required.
**Alternatives considered**: UTC `HH:MM` (unnecessary conversion, same result for these exchanges), full ISO datetime (wrong abstraction — lunch break is a recurring daily window, not a specific instant).
**Status**: Active — Feb 22 2026

## ADR-012: valid_until defaults to null — not a sentinel date
**Decision**: `/v5/keys` returns `valid_until: null` when no rotation is scheduled, populated from `PUBLIC_KEY_VALID_UNTIL` env var when set.
**Rationale**: Using `null` rather than a far-future sentinel (e.g. `9999-12-31`) avoids agents making false assumptions about key validity windows. `null` is unambiguous: this key has no scheduled expiry. When a rotation is planned, the operator sets `PUBLIC_KEY_VALID_UNTIL` before deploying the new key, giving consumers advance notice.
**Status**: Active — Feb 22 2026

## ADR-013: schema_version replaces terms_hash
**Decision**: The receipt field `terms_hash` is renamed to `schema_version` with value `'v5.0'`.
**Rationale**: `terms_hash` implied a cryptographic commitment to a terms document. The field was hardcoded to a version string (`'v5.0-beta'`), which is misleading. `schema_version` accurately names what the field is: a stable identifier for the receipt schema version. Done pre-launch while zero consumers exist to absorb the breaking change cleanly. If a genuine cryptographic commitment to terms is required in future, a new `terms_hash` field can be added alongside `schema_version`.
**Status**: Active — Feb 22 2026

## ADR-014: /v5/health — no mic field, no schema_version
**Decision**: Health receipts contain `{ receipt_id, issued_at, expires_at, status: 'OK', source: 'SYSTEM', public_key_id, signature }`. No `mic`, no `schema_version`.
**Rationale**: Health is a system-level liveness probe, not a market receipt. Including `mic` would imply exchange-specific health, which is not what the endpoint measures. Omitting `schema_version` keeps the health receipt minimal and avoids coupling liveness checks to schema versioning. The canonical field list is documented in `/v5/keys → health_fields`.
**Status**: Active — Feb 22 2026

## ADR-015: MCP Streamable HTTP at POST /mcp
**Decision**: Implement `POST /mcp` using JSON-RPC 2.0 / MCP Streamable HTTP transport (protocol version `2024-11-05`). Three tools: `get_market_status`, `get_market_schedule`, `list_exchanges`. No new npm dependencies — tools call the same internal functions as the REST routes. `buildSignedReceipt` is extracted as a shared function so the 4-tier fail-closed architecture applies identically to MCP and REST callers.
**Rationale**: MCP is becoming the standard agent tool protocol. Without a `/mcp` endpoint, Oracle is invisible to Claude Desktop, Cursor, and the growing MCP-compatible agent ecosystem. The endpoint is outside the main `try/catch` and uses JSON-RPC error format — never REST `CRITICAL_FAILURE` format — so agent tool callers receive deterministic, unambiguous errors. `isError: true` in the tool result (not a JSON-RPC `error` field) signals a tool-level failure, consistent with the MCP spec and agent expectations.
**Alternatives considered**: Separate MCP server process (more ops overhead, no shared signing key access), MCP via SSE (stateful, more complex, not needed at current scale).
**Status**: Active — Feb 22 2026

## ADR-016: /v5/batch — all-or-nothing validation, independent signing, Tier 3 fails whole batch
**Decision**: `GET /v5/batch?mics=XNYS,XNAS,XLON` validates all MICs up front before processing any. Each receipt is independently signed via `buildSignedReceipt` (full 4-tier apply per-MIC). If any MIC triggers Tier 3 (signing offline), the entire batch returns 500 CRITICAL_FAILURE rather than partially succeeding.
**Rationale**: Validating all MICs up front is fail-closed — it prevents silently processing a partially valid request. Independent signing means each receipt is self-contained and verifiable in isolation; agents can split the batch and forward individual receipts to other agents. Tier 3 failure is total because signing failure means the signing key or infrastructure is offline — partial results from a compromised signing system are worse than no results.
**Alternatives considered**: `POST /v5/batch` with a JSON body (GET with query param is simpler and more cache-friendly for future CDN caching), extending `/v5/status` to accept comma-separated `mic` (changes response schema conditionally — agents can't reliably parse), returning partial results on Tier 3 failure (unsafe).
**Status**: Active — Feb 23 2026

## ADR-017: /.well-known/oracle-keys.json — RFC 8615 key discovery, minimal payload
**Decision**: `GET /.well-known/oracle-keys.json` returns the active signing key(s) with lifecycle metadata (`key_id`, `algorithm`, `format`, `public_key`, `valid_from`, `valid_until`) plus `service` and `spec` fields. Does NOT include `canonical_payload_spec` (that stays at `/v5/keys`).
**Rationale**: RFC 8615 defines `/.well-known/` as the standard location where agents and web infrastructure look for service metadata — before checking any service-specific path. Without this endpoint, Oracle is invisible to any agent or tool that follows the standard. The minimal payload (key data only, no spec) keeps the well-known response broadly interoperable and avoids coupling the standard discovery path to Oracle-specific schema details.
**Status**: Active — Feb 23 2026

## ADR-018: @headlessoracle/verify — Web Crypto only, zero production dependencies
**Decision**: The consumer SDK (`@headlessoracle/verify` at `C:\Users\User\headless-oracle-verify\`) uses only the Web Crypto API (`crypto.subtle`) for Ed25519 verification. No production npm dependencies. `@noble/ed25519` is a devDependency only (used in tests to sign payloads, mirroring the server).
**Rationale**: Zero production dependencies eliminates supply-chain risk for consumers and removes `sha512` global-mutation requirements. Web Crypto is available in all target environments (Node.js 18+, Cloudflare Workers, modern browsers). The test strategy — sign with noble, verify with Web Crypto — is a true round-trip integration test that proves Oracle server ↔ SDK compatibility. The `publicKey` option lets high-throughput consumers skip the key registry fetch entirely, avoiding a network call on every verification.
**Alternatives considered**: Using `@noble/ed25519` as a production dep (adds supply-chain dep, requires sha512 setup by consumer), supporting both noble and Web Crypto (increases bundle and complexity for no gain in modern environments).
**Status**: Active — Feb 24 2026

## ADR-019: Stripe billing — anonymous checkout, KV cache in front of Supabase, 402 for payment failures
**Decision**: Anonymous Stripe Checkout (no user accounts). `POST /v5/checkout` creates a Checkout Session (subscription mode, success/cancel URLs hardcoded server-side). `POST /webhooks/stripe` verifies Stripe-Signature (HMAC-SHA256, 5-min replay window) before processing. Key format: `ok_live_<32 random hex bytes>`. Key hash: `sha256(UTF-8 encoded key string)` stored in Supabase `api_keys` table. `ORACLE_API_KEYS` KV caches `sha256(key) → { plan, status }` with 300s TTL. Auth hot path: MASTER → beta → KV hit → Supabase → 403. Suspended/cancelled keys return 402 (not 403) so agents can distinguish payment failure from invalid key. No Stripe Node SDK — pure `fetch()` calls against Stripe REST API.
**Rationale**: Anonymous checkout eliminates friction and Supabase Auth complexity. KV cache keeps auth latency low (sub-millisecond for cache hits) while Supabase remains the durable source of truth. 402 is semantically correct for payment failure and gives agents a machine-readable signal distinct from "key doesn't exist." Hardcoding success/cancel URLs server-side prevents open-redirect abuse. The `ok_live_` prefix makes API keys visually distinct from other secrets in logs and config files.
**Alternatives considered**: Supabase Auth for user accounts (adds friction, out of scope for V1), storing plaintext key in KV (security risk — KV is not a secret store), using Stripe webhook signing with a shared secret stored in Supabase (adds unnecessary indirection), returning 403 for all payment failures (agents can't distinguish "rotate key" from "fix billing").
**Status**: Active — Feb 24 2026
