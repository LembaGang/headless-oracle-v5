# CLAUDE.md sections moved on 2026-10-05

Moved verbatim from `CLAUDE.md` by H4a, because the pre-commit memory-size gate
failed (CLAUDE.md 62,222 chars, limit 60,000). Nothing below was edited.

## From "Current State"

- **2026-10-02: A2A claims removed (handoff `CC_HANDOFF_2026-10-02_hov5-a2a-claims_rev3`),
  deployed in `32f367e6`.** A1 `820cbf7`: `/.well-known/agent-card.json`
  (A2A's registered well-known URI) answers 404; `/.well-known/agent.json` stays as plain JSON
  metadata without the AgentCard-only fields; `/llms-full.txt`, `/AGENTS.md`, `/skill.md`,
  `/openapi.json` and the agent directory no longer claim A2A; `/v5/changelog` keeps its
  5.2 line and adds a 2026-10-02 entry withdrawing the label; guard
  `A2A: no served surface claims A2A support` (36 surfaces plus MCP, three allowlisted
  strings). A2 `a012ab9`: `scripts/verify-agent-readiness.mjs` check 10 and `--only`. Suite
  **1395 to 1432**, read from `npm run test:sync-count` and the pre-commit hook. No route
  change. Post-deploy check: `node scripts/verify-agent-readiness.mjs --only 10`.
- **2026-10-01: agent readiness (handoff `CC_HANDOFF_2026-10-01_hov5-agent-readiness_rev2`),
  deployed in `32f367e6`.** W1 `1de0c53` Bazaar extension in the
  v2 `PAYMENT-REQUIRED` header of `/v5/status/x402` only, payment-header inputs folded
  to ASCII, `EXTENSION-RESPONSES` logged; W2 `4640b06` `/.well-known/ai-catalog.json`
  (MCP card, agent-skills index, API catalog; no A2A); W3 `f10a48d` `/auth.md` plus the
  `headlessoracle.com/auth.md` route (a route change: B-115 is not benign for this
  deploy); W4 `3486ac8` server card tools derive from `MCP_TOOLS`, `A2A` removed from
  `protocols`, halt-detection lists derived, past-dated CFTC sentence and model-tier
  paragraph removed, Bazaar schema enums fixed; W5 `25a65d9` dead links removed from
  `/sitemap.xml` (26 to 16), `/llms.txt`, `/llms-full.txt`, `/AGENTS.md`; W6 `89b96cf`
  `docs/receipt-spec.md` (B-254) agrees with `/v5/keys`. Suite **1369 to 1395**, read
  from `npm run test:sync-count` and the pre-commit hook. Post-deploy check:
  `node scripts/verify-agent-readiness.mjs` (failed every check but liveness against
  production before the deploy, as it should).

## Superseded section

### GAP-019 — the local test gate: NOT REPRODUCING (2026-09-07)

The canon recorded local `npm test` as blocked by non-deterministic workerd
timeouts, with CI as the authoritative gate and `--no-verify` reserved for
prose-only commits. It did not reproduce on any commit of 2026-09-07: seven
commits ran the full hook clean (tsc 0, suite green, dry-run 0, and from
`b4c4fb4` onward the start smoke too). Full-suite wall time 120–130s.

Two flakes were observed and are recorded rather than swept up, because a gate
that goes red for the wrong reason erodes trust in the gate:

- `GET /v1/status/{MIC} — in-worker rate limit > exact-limit (60) all pass; 61st
  returns 429` failed once in a full-suite run and passed 3/3 in isolation. The
  mechanism is identified: the limiter buckets on `Math.floor(now/60_000)`, a
  wall-clock minute, and the test fires 61 real sequential requests. If those
  straddle a minute boundary the counter resets and the 61st returns 200. Latent
  since the test was written; surfaced by the extra milliseconds T3b adds per
  receipt. One-line fix: pin the clock with `vi.setSystemTime` for that test.
  **Flagged, not fixed** — it is outside this sprint's scope.
- One further single-test failure during the first attempt at the `b4c4fb4`
  commit, which passed on re-run and on retry. Not identified; the output was not
  captured. If a third flake appears, capture the full run before retrying.


## Closed section

### CI test-count annotation — closed 2026-09-07 (`61db54c`)

The detector was the bug, not the count. `grep -oP '\d+(?= passed)' | head -1` reads
the `Test Files  2 passed` line, so CI annotated "actual test count (2)" for as long
as the check existed. Extraction now lives in `scripts/vitest-count.sh`, shared by
`scripts/sync-test-count.sh` and CI so they cannot drift apart: it anchors on the
`Tests` summary line, strips ANSI first, uses `sed` rather than `grep -P` (which the
Git Bash running the local hook refuses outright, so the old detector returned an
empty string locally and `npm run test:sync-count` could never have worked on this
machine), and refuses to report a count from a run that had failures. **The CI step
now fails on a mismatch instead of warning** — `TEST_COUNT` is served at
`/v5/metrics/public`, so a mismatch is a number we publish and cannot support. CI also
no longer runs the suite twice.

