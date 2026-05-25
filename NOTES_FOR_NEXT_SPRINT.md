# Notes for next sprint

Observations recorded during the 5xx Fix Sprint (2026-05-25) — `fix(routing,rpc):
api.headlessoracle.com passthrough + Base RPC timeouts`. These were noticed but
deliberately **not** touched, to keep that sprint inside its two-fix scope.

## 1. Paddle / Resend outbound fetches still have no timeout (explicitly deferred)

The 5xx sprint added `AbortSignal.timeout(5000)` to the four Base RPC fetches
(`src/index.ts:2222, 2258, 2599, 2628`) and confirmed the two CDP facilitator
fetches (`2422, 2446`) already had it. The remaining unbounded outbound fetches
are the Paddle / Resend calls at approximately:

- `src/index.ts:10619`
- `src/index.ts:10677`
- `src/index.ts:10766`
- `src/index.ts:10965`

These were named out-of-scope for the 5xx sprint ("separate sprint, separate
decision"). They are the same 5xx risk class — a hung Paddle/Resend endpoint can
stall a request — and are the obvious next 5xx hardening target. Verify the exact
line numbers before editing; they will drift.

## 2. `fetchWithTimeout` helper extraction (standing gap)

After this sprint, `signal: AbortSignal.timeout(5000)` is now repeated across the
two CDP fetches and the four Base RPC fetches, and would extend to the Paddle/
Resend fetches in (1). A single `fetchWithTimeout(url, init, ms)` helper would DRY
this and make the timeout discipline uniform and grep-able. Explicitly deferred by
the 5xx sprint as a standing gap — flagged here so the decision is captured, not
lost.

## 3. `scripts/sync-test-count.sh` extracts the wrong number with multiple test files

`scripts/sync-test-count.sh:17` does:

```sh
COUNT=$(echo "$TEST_OUTPUT" | grep -oP '\d+(?= passed)' | head -1)
```

With two spec files, vitest prints `Test Files  2 passed (2)` **before**
`Tests  1064 passed (1064)`, so `head -1` captures `2`. Running
`npm run test:sync-count` would therefore set `TEST_COUNT = "2"` in `wrangler.toml`,
not the real total. TEST_COUNT was updated manually this sprint (1058 → 1064) to
avoid this. Fix would be to match the `Tests` line specifically, e.g.
`grep -oP 'Tests\s+\K\d+(?= passed)'` or `tail -1` on the filtered matches. Out of
scope for the 5xx sprint (CI tooling, not a 5xx source).

## Doc drift observed during doc-sync sprint (2026-05-25)

- `.claude/rules/90_active_priorities.md` **Current Status** block (lines ~7–8)
  still shows `1058/1058` test count and worker `e381e5e4`. The doc-sync sprint
  was scoped to only the DNS-hang note in that file, so these were left stale.
  Should be bumped to `1064` and worker `9eddfc9d-…` in a follow-up. (CLAUDE.md's
  Current State section *was* synced to 1064 / `9eddfc9d` / HEAD `a43bb6b`.)
- The doc-sync prompt assumed the CLAUDE.md worker version was `dde5c165`; the
  actual stale value was `e381e5e4` (the May 21 deploy). Updated to `9eddfc9d-…`
  regardless — noting only that `dde5c165` was never the live-version string in
  CLAUDE.md's Current State.
