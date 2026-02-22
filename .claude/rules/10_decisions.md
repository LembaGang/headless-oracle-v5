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
