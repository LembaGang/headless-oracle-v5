# Headless Oracle V5 — Engineering Standards

## Hard Rules (Never Break)
- All 66 tests must pass before any change is considered complete — run `npm test` to verify
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
- All 7 MICs must be covered; do not add partial-exchange tests

## What Must Not Change Without Explicit Discussion
- The 4-tier fail-closed architecture (Tier 0-3)
- The signed receipt schema (fields, encoding)
- The `ORACLE_OVERRIDES` KV key naming convention
- Auth header name (`X-Oracle-Key`)
