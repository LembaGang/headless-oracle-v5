# Committee Report -- Day 43

**Date:** April 9, 2026
**Prepared by:** Engineering
**Period:** Day 43 (single day)
**Status:** Operational (post-incident recovery complete)

---

## Executive Summary

Day 43 was one of the most productive days in project history: 8 engineering sprints completed, test suite expanded from 770 to 1,024 (+254 tests), OpenAPI spec completed at 73 paths, and TypeScript + Python SDK stubs created. A professional website was deployed on Cloudflare Pages with all pricing buttons wired to Paddle checkout.

The day also included a 3-hour homepage outage (API unaffected) caused by a routing misconfiguration during the Worker/Pages architecture split. The incident is detailed below with root cause and lessons learned.

On the distribution front, VeroQ -- a new entrant in agent financial tooling -- was engaged on the FinRL repository, and a second building-in-public tweet was posted.

Revenue remains $0 from external customers. The single x402 payment ($0.001 USDC) from Day 36 remains the only on-chain settlement.

---

## Infrastructure

### Test Coverage Sprint

| Metric | Before | After | Delta |
|---|---|---|---|
| Test count | 770 | 1,024 | +254 |
| Statement coverage | 78% | 78.80% | +0.80% |
| Branch coverage | 71% | 71.97% | +0.97% |
| Line coverage | 81% | 81.28% | +0.28% |
| Function coverage | 53% | 53.25% | +0.25% |

Coverage improvements came from three categories:

- **Endpoint coverage (77 tests):** `/v5/keys/instant` error cases, `/v5/verify` error paths, `/v5/historical` edge cases, `/v5/audit/digest` + `/v5/audit/chain`, `/v5/funnel` auth, `/v5/credits/purchase` + `/v5/credits/balance`, `/.well-known/*` endpoints, `/docs/*` endpoints, catch-all 404, method-not-allowed, CORS preflight.
- **Schedule engine exhaustive tests (142 tests):** All 28 exchanges tested for mid-session OPEN, before-open CLOSED, after-close CLOSED, weekend CLOSED, 2026 holiday CLOSED, half-day early close, lunch breaks (XJPX/XHKG/XSHG/XSHE), DST transitions (US March 8 + November 1, EU March 29 + October 25, 3-week gap period), CME overnight session.
- **Ed25519 signing tests (18 tests):** Verification against `/.well-known/oracle-keys.json`, tampered payload/signature rejection, canonical alphabetical key sort, no-whitespace JSON, UUID receipt_id format, ISO 8601 timestamps, 60-second TTL enforcement, receipt_mode differentiation, batch signature integrity, health receipt schema.

Coverage tooling (`npm run test:coverage`) was configured with Istanbul provider. Function coverage at 53% is structurally bounded by cron handlers, Durable Objects, real-network payment verification, and template literal builder functions. The core trust path (signing, schedule engine, authentication) has near-100% coverage.

### OpenAPI 3.1 Specification

The OpenAPI spec reached completeness at 73 paths (previously ~50), organized under 11 semantic tags, with 2 server URLs (`headlessoracle.com` + `api.headlessoracle.com`), MIT license, contact email, and BearerAuth security scheme.

Approximately 25 previously undocumented paths were added: `/oauth/*`, `/v5/historical`, `/v5/status/realtime`, `/v5/briefing`, `/v5/referrers`, `/v5/payment-proof`, `/v5/why-not-free`, `/v5/pricing`, `/v5/slo`, `/v5/errors/{code}`, `/v5/changelog`, `/.well-known/x402.json`, `/.well-known/mcp-servers.json`, `/.well-known/mcp/server-card.json`, `/.well-known/oauth-*`, `/.well-known/ai-plugin.json`, `/AGENTS.md`, `/skill.md`, `/badge/{mic}`, `/v5/webhooks/unsubscribe`, `/sitemap.xml`.

### SDK Stubs

Two SDK packages were created, typed, and tested but not yet published:

- **TypeScript** (`packages/sdk-typescript/`): `@headlessoracle/sdk`. Full types, `getStatus`/`batch`/`historical`/`verify`/`verifyOffline`, Ed25519 via Web Crypto, auto-retry on 429, auto-provision key on 402, safety helpers (`isSafeToExecute`, `allOpen`), `OracleError` class, dual ESM+CJS build via tsup.
- **Python** (`packages/sdk-python/`): `headless-oracle-sdk`. Pydantic v2 models, httpx client, PyNaCl Ed25519 verification, auto-retry/auto-provision, 12 pytest tests using respx mock, pyproject.toml ready for PyPI upload.

Publication will be triggered when the first customer needs them.

### Worker/Pages Architecture Split

The Worker (`headless-oracle-v5`) is now API-only with zero HTML templates or renderers. All HTML is served by Cloudflare Pages (`headless-oracle-web`). The Worker has a catch-all route on `headlessoracle.com/*` and forwards HTML paths to Pages via `fetch(request)`.

---

## Website & Conversion

### Professional Landing Page

A dark-themed professional website was deployed on Cloudflare Pages with:

- All 28 exchanges displayed on the status page
- Instant key provisioning (zero-friction, sub-second)
- Paddle checkout wired for all tiers: Credits ($5), Builder ($99/month), Pro ($299/month)
- All call-to-action buttons functional and tested

### Conversion Infrastructure

- **Enhanced 402 responses:** Machine-readable `agent_upgrade_paths` with 3 methods (x402, API key, demo). Agents can autonomously select an upgrade path without human intervention.
- **429 upgrade nudge:** Free-tier and paid-tier 429 responses now include structured `upgrade_paths`, `recommended`, `daily_limit`, `used`, `resets_at` fields. `X-Upgrade-Path` header on all 429s. `X-Daily-Usage` header at 80%+ usage.
- **Rate limit header fix:** `_rlUsed` and `_rlLimit` were initialized to 0 and never updated from actual usage values. Now correctly wired to `getDailyUsage()` results for both free and paid tiers.
- **Funnel telemetry active:** 5 distinct 402 exit points tracked via `incrementKvCounter()`.

---

## Incident Report

### 3-Hour Homepage Outage (April 9, 2026)

| Field | Detail |
|---|---|
| **Duration** | ~3 hours (10:31 -- 13:28 UTC) |
| **Severity** | P2 -- user-facing HTML pages unavailable |
| **Impact** | Homepage and all HTML pages returned 404. All API endpoints (`/v5/*`, `/mcp`, `/.well-known/*`) remained fully operational throughout. |
| **Detection** | Manual verification during sprint |
| **Resolution** | Pages deployment + Worker passthrough guard |

**Root cause:** During the Worker/Pages architecture split, Worker routes for HTML pages were removed before confirming that Cloudflare Pages was correctly receiving and serving those requests. The Worker's catch-all route dropped HTML path requests into a 404 handler instead of forwarding them to Pages.

**Timeline:**
1. Worker HTML route handlers removed (dead code cleanup sprint)
2. Pages deployment not yet configured to receive forwarded requests
3. HTML paths fell through to Worker 404 handler
4. API endpoints continued serving normally (separate route handlers)
5. Pages deployed and Worker passthrough guard added
6. Full service restored

**Lessons learned:**
1. **Always verify the receiving system before removing the serving system.** Deploy and confirm Pages is serving correctly, then remove Worker routes -- not the reverse.
2. **API-first architecture proved its value.** The 3-hour outage affected only the marketing website. Every API consumer, MCP client, and agent continued operating without interruption.
3. **Staging verification for routing changes.** Any change to the routing chain should be verified with a curl test before and after deployment.

---

## Telemetry (Day 43)

### Traffic

| Metric | Value | Trend |
|---|---|---|
| 200 responses | 553+ | On pace, API healthy throughout outage |
| 402 responses | 36 | Conversion paths now visible |
| Auth calls (weekly) | 3 -> 8 -> 14 -> 19 | Consistent upward trend over 4 weeks |

### AI Crawler Activity

| Crawler | Requests | Note |
|---|---|---|
| AI crawlers (total) | 54 | +46% vs previous day |
| BingBot | 31 | 5x increase |

### MCP Client Activity

| Client | Requests | Note |
|---|---|---|
| DataCamp | 10 | Consistent evaluator presence |
| Chiark | 37 | Agent Quality Index scoring |
| Glama | 80 | Highest volume evaluator |
| continuum-sync | -- | New evaluator (Day 43) |
| MCP-Client/NYC | -- | New MCP client (Day 43) |
| Drexel University | -- | New academic evaluator (Day 43) |

Three new entities appeared in telemetry on Day 43: continuum-sync, an MCP client from New York City, and Drexel University (Philadelphia). These join Indiana University as academic institutions evaluating the service.

---

## Distribution

| Activity | Status |
|---|---|
| VeroQ reply on FinRL #1412 | Posted -- composable pre-trade stack positioning |
| Building-in-public tweet (Day 43) | Posted |
| dev.to article | Continuing to drive crawler attention |
| DataCamp follow-up | Scheduled for April 12 |

---

## Competitive Intelligence

### VeroQ Assessment

A new entrant, VeroQ, was identified in the agent financial tooling space.

- **Positioning:** Adjacent, not competitive. VeroQ focuses on signal verification; Headless Oracle provides market-state verification. These are complementary layers.
- **Maturity:** Small and early. Unclaimed Glama listing. Quality of implementation not yet verified.
- **Recommendation:** Monitor but do not invest engineering time. If VeroQ gains traction, the composable pre-trade stack framing positions HO as Layer 1 (market state) with VeroQ as a potential Layer 3 (signal verification).

---

## Financial Summary

| Item | Value |
|---|---|
| External revenue | $0 |
| x402 payment count | 1 ($0.001 USDC, Day 36) |
| Infrastructure cost | ~$15.50/month |
| Max subscription | $200/month (may downgrade to Pro $20/month next week) |
| Runway impact | Negligible at current burn rate |

---

## Next Priorities

| Priority | Target Date | Notes |
|---|---|---|
| Dead code cleanup | Day 44 | Reduce Worker from ~16.5K to ~12K lines |
| DataCamp follow-up | April 12 | Warmest evaluator lead |
| Managed Agents decision | April 15 | Cost-benefit analysis for Claude Managed Agents |
| First paying customer | Ongoing | Primary revenue objective |
| Monitor VeroQ | Ongoing | Track response to FinRL engagement |
| Max -> Pro transition | Next week | Cost optimization ($200 -> $20/month) |

---

## Standing Gap

**Function coverage at 53%** is the primary testing gap. The uncovered surface is structurally difficult to test in Miniflare: cron handlers (`runHaltMonitor`, daily aggregation, weekly digest), Durable Object lifecycle methods (`WebhookDispatcher.alarm`, `StreamCoordinator.fetch`), real-network payment verification (`verifyX402Payment` with live RPC calls), and ~100 template literal builder functions (static content, low risk). The core trust path -- signing, schedule engine, authentication -- has near-100% coverage. At scale, the cron and DO paths become the highest-risk untested surface.

---

*Report ends. Next report: Day 44 or next significant milestone.*
