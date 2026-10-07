# CLAUDE.md sections moved on 2026-10-07

Moved verbatim from `CLAUDE.md` because the always-loaded memory total had reached
149,997 of its 150,000-character limit. Nothing below was edited; each pointer left
behind keeps the rule that still stands.

## From "GAP-019 (both sections)"

### GAP-019 — NOT REPRODUCING (2026-09-07): moved verbatim to `docs/history/claude-md-moved-2026-10-05.md`

Superseded by "GAP-019 — CLOSED 2026-09-10" below. The rule it set stands: if a
flake appears, capture the full run before retrying.

### GAP-019 — CLOSED 2026-09-10

The two 61-request rate-limit tests (`/v1/status/{MIC}` and
`/v1/safe-to-trade/sample`) pin the clock with `vi.setSystemTime`, so all 61
requests land in one wall-clock-minute bucket by construction. The flake fired
in four of eight full runs on 2026-09-10 once the suite grew — what decides it
is where in the minute the burst starts. Proved it still fails for the right
reason: with the two limit constants temporarily at 9999 both tests went red
with "expected 200 to be 429".

## From "`/v5/payment-proof` — GAP-021, after its first paragraph"

The four, from an `eth_getLogs` walk of USDC `Transfer(_, payTo, _)` over blocks
44,192,527 → 51,000,755 (692 RPC calls, 0 failures, 2026-09-07):

| tx | block | block time | note |
|---|---|---|---|
| `0xeb9da873…b308a` | 44,218,092 | 2026-04-03T14:12:11Z | the first dollar |
| `0xb4b93483…5cf2`  | 44,382,001 | 2026-04-07T09:15:49Z | **was undocumented anywhere** |
| `0xa6bc45dc…ee41`  | 47,022,787 | 2026-06-07T12:22:01Z | first CDP-facilitated settlement |
| `0x46db8fc8…9263`  | 50,998,385 | 2026-09-07T13:01:57Z | the v2 rail run |

Three causes, and the canon's earlier diagnosis was wrong on two of them. The
first-payment keys were **never written**, not evicted: both verifiers seeded them
under `if (count === 0)`, a branch that fires at most once in a counter's lifetime
and had missed its window. The value would have been unusable anyway — it stored
`txHash.slice(-12)`, a twelve-character suffix no explorer can resolve. And the
suggested fix, computing counts on read from the listable prefixes, **cannot work**:
a walk of production `ORACLE_TELEMETRY` on 2026-09-07 returned **zero keys** from all
three of `x402_used:` (600s TTL), `x402_used_tx:` (365d) and
`paddle_revenue_event:` (30d). Also corrected: `payment_count: 3` on 2026-06-07 was
**not** an undercount — exactly three settlements had occurred by then.

Production `x402_payment_count` reads 4 and the chain walk finds 4 — two sources that
could have disagreed, agreeing. What that does **not** establish is the absence of a
settlement before 2026-04-03: the walk starts at that day's first block, so an earlier
one would have to have escaped both the walk's start bound and the counter. The
endpoint reports the counter beside the ledger with an `agrees` flag rather than
replacing it silently.

## From "Working style — the 2026-05-13 bypass class, original text"

Kept
  below for the history of why it existed. Original text: On 2026-05-13 the worker pre-commit hook hung 40+ min on `getaddrinfo(): #11001 No such host is known.` for `sahqfuyneoeqczupmysu.supabase.co` — vitest-pool-workers making real DNS calls instead of mocking Supabase. This is the same flake-class as the "65 pre-existing Windows EBUSY failures" already documented in this file. Two commits used `--no-verify` after explicit MBeenzi approval: `59d9099` (sitemap/robots constants) and the documentation commit that landed this note. The exception class is: **pure string-constant or markdown-only edits with zero logic, route, or test surface, when the hook is failing on documented environment-flake symptoms.** Bypass requires (a) explicit approval per change, (b) the commit message stating the change is docs/data-only, naming the change, and naming the bypass reason. The next worker commit that touches logic or routes must wait for the test env to be fixed — the bypass class does not extend to those.
