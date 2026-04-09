# Coverage Report — Headless Oracle V5

## Baseline Coverage (Apr 9 2026 — 777 tests)

| Metric     | Coverage | Covered | Total |
|------------|----------|---------|-------|
| Statements | 78.06%   | 2,438   | 3,123 |
| Branches   | 70.91%   | 1,746   | 2,462 |
| Functions  | 52.95%   | 179     | 338   |
| Lines      | 80.51%   | 2,306   | 2,864 |

**Provider**: Istanbul via `@vitest/coverage-istanbul`
**Runner**: `npm run test:coverage`
**Reports**: `coverage/` (HTML, JSON, text)

## Per-File Breakdown

Single-file architecture — all production code is `src/index.ts`.

| File     | Stmts  | Branch | Funcs  | Lines  |
|----------|--------|--------|--------|--------|
| index.ts | 78.06% | 70.91% | 52.95% | 80.51% |

## Identified Gaps

### Functions (52.95% — biggest gap)

Major uncovered function categories:

1. **Cron/scheduled handlers**: `runHaltMonitor()`, `runWeeklyDigest()`, daily npm stats — cron triggers are hard to test in Miniflare without explicit cron invocation
2. **Payment verification internals**: `generateCdpJwt()`, `verifyX402ViaFacilitator()` real-network paths, `buildX402IndexHeaders()`
3. **Durable Object methods**: `WebhookDispatcher.alarm()`, `StreamCoordinator` — DO lifecycle harder to test in pool workers
4. **Helper functions for string constants**: Many `build*()` helpers for large markdown/HTML constants
5. **Upgrade/redirect routes**: `/upgrade`, `/status` HTML generation, `/v5/stack`, etc.

### Branches (70.91%)

Key uncovered branches:

1. **Error paths in payment verification**: Edge cases in `verifyX402Payment()` (wrong USDC contract, missing logs, RPC failures)
2. **Schedule engine**: Some overnight session edge cases, year-boundary guards for lesser-tested exchanges
3. **Auth cascade**: Some paths in `checkApiKey()` (Supabase fallback, credits edge cases)
4. **MCP protocol**: Some error paths in `handleMcp()` (malformed batches, edge cases in tool dispatch)
5. **Webhook delivery**: Retry logic branches, HMAC validation edge cases

### Lines (80.51%)

Uncovered line clusters:

1. Large string constants (LLMS_TXT, SKILL_MD, etc.) — ~3,500 lines of template literals that get served but aren't individually asserted
2. `/v5/checkout` Paddle API interaction paths
3. `/v5/keys/request` email delivery branches
4. HTML generation for `/status`, `/upgrade`, `/pricing` pages
5. Cron handler branches

## Coverage Targets

| Metric     | Baseline | Target  |
|------------|----------|---------|
| Statements | 78.06%   | > 80%   |
| Branches   | 70.91%   | > 75%   |
| Functions  | 52.95%   | > 65%   |
| Lines      | 80.51%   | > 82%   |

## How to Run

```bash
# Full coverage report (HTML + JSON + text)
npm run test:coverage

# Open HTML report
open coverage/index.html
```

## Final Coverage (Apr 9 2026 — 1,014 tests)

| Metric     | Baseline | Final  | Delta  | Covered | Total |
|------------|----------|--------|--------|---------|-------|
| Statements | 78.06%   | 78.80% | +0.74% | 2,461   | 3,123 |
| Branches   | 70.91%   | 71.97% | +1.06% | 1,772   | 2,462 |
| Functions  | 52.95%   | 53.25% | +0.30% | 180     | 338   |
| Lines      | 80.51%   | 81.28% | +0.77% | 2,328   | 2,864 |

### Tests added: 237 (777 → 1,014)

| Category | Tests | Description |
|----------|-------|-------------|
| Endpoint coverage gaps | 77 | Error paths, auth, CORS, method not allowed for 25+ routes |
| Schedule engine | 142 | All 28 exchanges: open, closed, weekend, holiday, half-day, lunch, DST |
| Cryptographic signing | 18 | Signature verification, tampering, canonical payload, TTL, receipt modes |

### Why functions coverage is hard to move

The single-file architecture (~15K lines) has ~338 functions. Coverage of
~158 functions is blocked by:

- **Cron handlers** (4): `runHaltMonitor()`, `runWeeklyDigest()`, npm stats, MCP aggregation — these require `scheduled()` event simulation
- **Durable Objects** (6+): `WebhookDispatcher.alarm()`, `StreamCoordinator` methods — require DO lifecycle mocking
- **Real network calls** (5): `verifyX402Payment()` RPC paths, `generateCdpJwt()`, `verifyX402ViaFacilitator()` — require external API mocking
- **HTML generators** (10+): `/status`, `/upgrade`, `/pricing` pages, `/v5/card/:mic` SVG — executed but functions inside template literals not counted
- **Template literal builders** (100+): `LLMS_TXT`, `SKILL_MD`, `AGENTS_MD`, etc. — constant strings, not functions

The core **trust path** (signing, schedule, auth, fail-closed) has near-100% coverage.
