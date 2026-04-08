<!-- Living document. Update when new patterns are discovered or failure
modes are encountered. Last updated: 2026-04-08 by Day 42 meta-sprint -->

# Sprint Playbook — Headless Oracle V5

Patterns that produce successful autonomous sprints. Read this before
starting any multi-task session.

## Sprint Structure

1. Mike provides a multi-task prompt with CONTEXT, numbered TASKs, and RULES
2. Tasks are prioritized — do them in order
3. Commit after each task with descriptive message including test count
4. Deploy after tasks that change the worker (`npm run deploy`)
5. Live-verify after deploy (curl the changed endpoints)
6. Update `.claude/rules/` docs and `90_active_priorities.md` when done

## What Makes a Good Task

- Clear acceptance criteria (not "make it better" but "add X-Trial-Remaining header")
- Specific file paths when known
- Test requirements spelled out
- Explicit rules about what NOT to do
- Self-contained — each task can be committed independently

## Common Failure Modes (and how to avoid them)

### 1. Modifying tests that expect old behavior
Tests encode product contracts. Before changing an assertion, understand
WHY it expected that value. Read the test name, the describe block, and
any comments. If the old expectation was wrong, document why in the commit.

### 2. Including unrelated files in external PRs
Every PR to a repo we don't own must be surgically scoped. Unrelated
changes (formatting, imports, config) signal amateur hour and get PRs
rejected. Rule: `git diff --stat` should only show files directly
related to the feature.

### 3. Using marketing language in GitHub issues/PRs
Write as a contributor solving a problem, not a vendor promoting a product.
"This adds market-state verification to the risk pipeline" — yes.
"The industry-leading oracle solution" — no.

### 4. Breaking the x402 payment flow
This took 27 days to debug end-to-end. The payment flow touches:
`verifyX402Payment()`, `verifyX402ViaFacilitator()`, `verifyPaymentAnyFormat()`,
`build402Payload()`, `buildX402ScanPayload()`, CDP JWT generation, and 6
different entry points. If you're touching any of these, run the x402
tests explicitly and trace the full flow mentally before committing.

### 5. Extending the 60-second TTL
The receipt TTL (`RECEIPT_TTL_SECONDS = 60`) is a permanent product fact.
It is signed into every receipt. Consumers and specs depend on it.
Never change it. Ever.

### 6. Forgetting to update TEST_COUNT in wrangler.toml
`TEST_COUNT` in `wrangler.toml [vars]` is read by `/v5/metrics/public`.
Run `npm run test:sync-count` or update manually after adding tests.

### 7. Windows path issues
This repo runs on Windows. Use bash-style paths in commands (`/c/Users/...`
or `C:/Users/...`). The Write tool uses absolute Windows paths. External
repos should be manipulated via git commands, not the Write tool, when
possible.

### 8. Session compaction losing context
Long sessions get compacted. Commit frequently so work isn't lost.
Update `90_active_priorities.md` at natural milestones (not just at
session end) so compacted context still has the latest state.

### 9. Stale context docs
If you add a route and don't update `02_architecture_map.md`, the next
session will have wrong assumptions about the codebase. Update living
docs as you go, not just at the end.

### 10. Supabase/KV mismatch in tests
Tests use Miniflare's in-memory KV. Supabase calls in tests must be
mocked (the test env has no real Supabase). When Supabase returns
`{ data: null }`, it uses HTTP 406 (not 200) — this has caused real bugs.

## External PR Checklist

Before submitting any PR to a repo we don't own:

- [ ] Forked and cloned the repo locally
- [ ] Read their code style and matched it (tabs vs spaces, import style, etc.)
- [ ] Read their test setup and CI config
- [ ] Written tests that pass against their repo's test runner
- [ ] Verified no unrelated files in the diff (`git diff --stat`)
- [ ] PR description written as a contributor, not a vendor
- [ ] Referenced any existing issues naturally
- [ ] Zero new dependencies (stdlib only when possible)
- [ ] PR compiles and tests pass in their CI

## Communication Patterns

- Mike gives strategic direction; CC executes technically
- When stuck for >10 minutes on a single issue, document what you've tried
  and move to the next task
- When a task is blocked (repo won't clone, tests won't install), write
  documentation instead (e.g. `docs/integrations/{framework}.md`)
- Don't ask questions that can be resolved by reading the code
- Make reasonable decisions and document assumptions in the commit message

## Session Closing Checklist

Before ending any session:

- [ ] All tests pass (`npm test`)
- [ ] Changes committed and pushed to main
- [ ] Worker deployed if any runtime code changed (`npm run deploy`)
- [ ] `CLAUDE.md` "Current State" section updated
- [ ] `90_active_priorities.md` updated with what was done
- [ ] `01_business_context.md` updated if metrics changed
- [ ] `02_architecture_map.md` updated if routes/functions changed
- [ ] `04_telemetry_guide.md` updated if new evaluator fingerprints appeared
- [ ] Live verification completed for deployed changes
- [ ] Named one gap the current approach doesn't solve at scale

## Test Patterns

### Adding a new endpoint
1. Add route handler in `src/index.ts` (in the correct position in the routing chain)
2. Add tests in `test/index.spec.ts`: happy path, error cases, auth if applicable
3. Add to OpenAPI spec (inline in `src/index.ts`)
4. Add to LLMS_TXT constant if agent-relevant
5. Update `02_architecture_map.md` with new route

### Adding a new exchange
1. Add config object in `MARKET_CONFIGS` (MIC, name, timezone, hours, holidays 2026+2027)
2. Add tests: OPEN, CLOSED, HALTED, /v5/schedule, /v5/exchanges listing
3. Update exchange count in CLAUDE.md and all surfaces
4. Verify DST behavior for the new timezone

### Adding a new MCP tool
1. Add to `MCP_TOOLS` array with description, inputSchema
2. Add case in `tools/call` switch in `handleMcp()`
3. Update `tools/list` count assertion in tests
4. Add tool-specific tests
5. Update `server-card.json`, `AGENT_JSON`, `LLMS_TXT`

## Deploy Verification

After `npm run deploy`, verify these endpoints:

```bash
# Basic health
curl -s https://headlessoracle.com/v5/health | jq .status

# Demo receipt
curl -s https://headlessoracle.com/v5/demo?mic=XNYS | jq .status

# MCP endpoint
curl -s -X POST https://headlessoracle.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .result

# Discovery files
curl -s https://headlessoracle.com/llms.txt | head -1
curl -s https://headlessoracle.com/AGENTS.md | head -1
```
