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

## Final Coverage (after sprint)

_Updated after Tasks 2-4 completion._
