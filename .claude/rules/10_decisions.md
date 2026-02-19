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

## ADR-007: Vitest + @cloudflare/vitest-pool-workers
**Decision**: Run tests inside a real Miniflare Workers runtime, not Node.js
**Rationale**: Catches Worker-specific API incompatibilities (crypto, KV, env bindings) that Node tests miss. Config in `vitest.config.mts` pointing to `wrangler.toml`.
**Status**: Active — note: config file is `wrangler.toml`, NOT `wrangler.jsonc` (deleted)
