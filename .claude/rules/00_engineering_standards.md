# Headless Oracle V5 — Engineering Standards

## Hard Rules (Never Break)
- All tests must pass before any change is considered complete — run `npm test` to verify (count tracked in `wrangler.toml` TEST_COUNT)
- Fail-closed behavior must be preserved at all tiers: UNKNOWN always means CLOSED to consumers
- No hardcoded UTC offsets — DST is handled exclusively via IANA timezone names in `Intl.DateTimeFormat`
- KV override expiry MUST be checked before returning HALTED — expired overrides are silently ignored
- Signing must be attempted before any non-CRITICAL_FAILURE response is returned

## Adding a New Exchange
When adding any exchange:
1. Add the exchange config object to `src/index.ts` (MIC, name, timezone, hours, holidays)
2. Add test cases in `test/index.spec.ts` covering: OPEN, CLOSED, HALTED, /v5/schedule, /v5/exchanges listing
3. Update the exchange table in `CLAUDE.md`
4. Verify DST behavior is correct for the new timezone — check against IANA tz database

## Route Contracts
Every route must:
- Return correct `Content-Type` header
- Be covered by tests for each meaningful state
- Follow the existing signed-receipt schema for data routes

Routes that do NOT require signing: `/v5/exchanges`, `/v5/schedule`, `/v5/keys`
Routes that require auth: `/v5/status` only

## Test Discipline
- Tests live in `test/index.spec.ts`
- Mock time via `vi.setSystemTime()` — never test against real wall clock
- KV overrides are tested via `ORACLE_OVERRIDES.put()` in test setup
- All 28 MICs must be covered; do not add partial-exchange tests

## Verification Standard (Infrastructure-Grade)

This project builds financial infrastructure. The standard is not "tests pass."
The standard is "live output matches the external spec, field by field."

Rules:
1. Every change that touches an external protocol (x402, MCP, EIP-712, Ed25519)
   MUST end with a live verification step: fetch the production endpoint and
   diff the output against the spec. Document the verification in the commit
   message.
2. "Tests pass" is necessary but not sufficient. Tests verify our code does
   what WE think it should. Verification confirms the output matches what
   EXTERNAL CLIENTS expect.
3. When a task requires human action (wallet funding, account creation, manual
   approval), say so explicitly and STOP. Do not work around it or simulate it.
4. When you cannot verify something end-to-end (e.g., real payment settlement),
   state the exact boundary of what you verified and what remains unverified.
5. Numbers that appear in multiple files (test counts, exchange counts, version
   strings) must be sourced from a single location. If you find a hardcoded
   number that could drift, fix the root cause — don't just update the number.
6. Every PR to an external repo must compile against that repo's build system
   before submission. A PR that doesn't compile signals amateur hour.

This rule is permanent and applies to every session.

## What Must Not Change Without Explicit Discussion
- The 4-tier fail-closed architecture (Tier 0-3)
- The signed receipt schema (fields, encoding)
- The `ORACLE_OVERRIDES` KV key naming convention
- Auth header name (`X-Oracle-Key`)
