# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## 2026-09-24 (later) — B-224d and B-224f pushed and deployed; TEST_COUNT 1369

Two handoffs from the Lead, executed in this session:
`cc-output/CC_REPORT_2026-09-24_b224d.md` and `…_b224f.md`.

| commit | what |
|---|---|
| `0e437a6` | canon refresh (the entry below) |
| `20404e4` | B-224d — consensus spec §3 sentence; guard rebuilt to a sentence-level rule over 20 GET surfaces (1356 → 1368) |
| `78fa1cd` | B-224f — `get_market_status` tool description; sentence splitter fixed for `v1.0.1`; `tools/list` case (1368 → 1369) |
| (this one) | canon refresh |

**Gate**: every commit passed the four-step hook; no `--no-verify`. Suite
1369/1369. `tools/verify-history.sh` 35/35 at `78fa1cd`. Controls run: the
rebuilt guard went red on the old §3 sentence (3 paths) and on the old tool
description, and green after each fix. **Pushed**: `origin/main` at `78fa1cd`;
CI and Tests both green on it before the deploy. **Deployed**:
`f20ba28c-571b-4e92-b1f0-0489688ce60d` at 2026-09-24T09:59:40Z, replacing
`e4cf7f87…`. Same benign B-115 exit 1; routes unchanged. Live-verified as
recorded in `CLAUDE.md` → Current State.

### Still open after 2026-09-24 (later)

- **B-115** — unchanged.
- **The guard is still list-based** — twenty GET surfaces plus `tools/list`; a
  new served text surface escapes it unless added. `headless-oracle-web` is
  outside it. A new disclaimer wording must be added to `DISCLAIMER` or the
  guard fails.
- The Paddle, `verify_receipt` and GAP-017 rows below are unchanged.

## 2026-09-24 — B-224 pushed and deployed; TEST_COUNT 1356

The served text stops claiming regulatory compliance or alignment (cite, never
claim — detail in `CLAUDE.md` → B-224). The founder authorised the push and the
deploy in this session.

| commit | what |
|---|---|
| `3b2a2c0` | B-224 — MCP tool text and prompt: no SEC/CFTC compliance claim; `uptime_sla` → `uptime_slo` |
| `4347051` | B-224b — `regulatory_alignment` removed from openapi `info` and the server card |
| `5f0ec3a` | B-224c — `/llms.txt`, `/llms-full.txt`, spec §10; eight-surface guard (+8 tests) |
| `0bff1f8` | `TEST_COUNT` 1348 → 1356 |
| (this one) | canon refresh |

**Gate**: every commit passed the four-step hook; no `--no-verify`. Suite
1356/1356. `tools/verify-history.sh` 32/32 at `0bff1f8`. **Pushed**: `origin/main`
`268af1c..0bff1f8`; CI and Tests both green on `0bff1f8`. **Deployed**:
`e4cf7f87-cdd0-4e53-b884-8dcdd7d5fa5d` at 2026-09-24T08:17:05Z, replacing
`9151bbeb…` (2026-09-10T12:46Z). The deploy exited 1 on the B-115 route-listing
step after a good upload; routes unchanged, so benign. Live-verified as recorded
in `CLAUDE.md` → Current State.

### Still open after 2026-09-24

- **B-115** — the deploy token cannot list zone routes; a route change would fail.
- **The B-224c guard is list-based** — a new surface carrying the claim escapes
  it; MCP `tools/list` and `headless-oracle-web` are outside it.
- **No referee price exercised end to end** against live Paddle — unchanged.
- **`verify_receipt` described as an MCP tool where it is not one** — unchanged.
  (`tools/list` on production serves four tools, read 2026-09-24.)
- **403-vs-503 on an auth-backend timeout** (GAP-017) — unchanged.

## 2026-09-10 — B-149, B-146, B-122 (one session)

**The till is open.** Six referee prices existed in Paddle and in
`REFEREE_PRICES` and nothing could reach them; `POST /v5/checkout` now sells all
ten plans, `/v5/pricing` carries the `referee` block, and
`POST /v5/referee/intake` is the front door. The repository can now verify its
own commit history. The README stopped claiming things the source does not say.

| commit | what |
|---|---|
| `02b0a1a` | B-146 — `SIGNING_KEYS` + `tools/verify-history.sh` + the CI step |
| `38b247c` | B-149 — the six services are buyable; a referee purchase is recorded and mints nothing |
| `3fa0dd4` | B-149 — the `referee` block on `/v5/pricing`, and `POST /v5/referee/intake` |
| `9ba3960` | GAP-019 — the two 61-request rate-limit tests stop depending on the clock |
| `f2b2515` | B-122 — the README's numeric claims, measured; `TEST_COUNT` 1308 → 1337 |
| (this one) | canon refresh |

**Gate**: all five commits passed the full four-step hook; no `--no-verify`.
Suite 1337/1337. `tools/verify-history.sh` reports 26/26 on the final `main`.
**Nothing pushed, nothing deployed** — both the founder's. Read from git
today rather than carried forward: `origin/main` is at `eb2f567`, so the four
commits of 2026-09-09 HAVE been pushed and the previous stamp naming `7a0bafe`
was stale. Unpushed: this session's six.

### The defect this session found

B-145 placed the referee branch in `transaction.completed` **after** the
`subscription_id` guard, and four of the six referee prices are one-time. So
`conformance_entry`, `regrade`, `dispute` and `dispute_note` never reached it —
a paid conformance entry would have left no trace outside the Paddle dashboard.
Fixed; the branch now sits before the guard, beside the credits branch.

### Still open after 2026-09-10

- **The push and the deploy** — both the founder's. The live worker
  (`a83fa8bf…`, 2026-09-07) still serves neither the referee purchase path nor
  the fail-closed billing path.
- **No referee price has been exercised end to end** against the live Paddle
  account: no checkout, no transaction, no webhook. The intake's mail path has
  only run against a mock.
- **No web surface carries a referee section** — that is the web pass's.
- **`verify_receipt` is described as an MCP tool on surfaces where it is not
  one**, and `CLAUDE.md` still says five tools in places where the code has
  four. Flagged, not fixed.
- **403-vs-503 on an auth-backend timeout** (GAP-017) — still open.
- **The four `PADDLE_PRICE_ID_*` secrets are not migrated to source** — still
  its own row.

Older entries (2026-09-09 and earlier: the Day 196 status block, day-two rail notes, GAP-020/021, the Day 44 to Day 85 logs, the February sprint goals and architectural gaps) were moved verbatim to `docs/history/active-priorities-to-2026-09-09.md` on 2026-10-02. Read it when you need that history; it is not auto-loaded.
