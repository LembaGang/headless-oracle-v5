# Monitors & Health Checks

Durable monitoring infrastructure for Headless Oracle. Everything in this file
runs unattended — none of it depends on a Claude Code session being open.

For the rationale on why session-scoped `/loop` and `CronCreate` are NOT used
here, see the discussion in 90_active_priorities.md (Day 45 monitor sprint).
The short version: they die when the Claude session exits. Anything that
must survive overnight lives in GitHub Actions, the Worker cron triggers, or
the Worker's own KV-backed observability surfaces.

## What's running

| Monitor | Mechanism | Cadence | Source of truth |
|---|---|---|---|
| Production health check | GitHub Actions | every 15 min (cron `*/15 * * * *`) | `.github/workflows/health-check.yml` + `scripts/health-check.mjs` |
| Frontend SLO + classifier | Same workflow, single script | every 15 min | `scripts/health-check.mjs` → `checkFrontend()` |
| Worker exception watcher | Cloudflare Workers Logs (observability enabled in `wrangler.toml`) | continuous | Dashboard, plus `console.error` lines surfaced by health check failures |
| Halt monitor (real-time) | Cloudflare Worker cron | every minute (`* * * * *` in `wrangler.toml`) | `runHaltMonitor()` in `src/index.ts` |
| Paddle revenue pulse | Worker KV writes from `/webhooks/paddle` → `/v5/revenue-pulse` queried by GH Action | every 15 min | `recordPaddleRevenueEvent()` + `GET /v5/revenue-pulse` (master-key gated) |
| x402 payment ledger | Worker KV writes from x402 verifiers → `/v5/payment-proof` (public) | continuous | `verifyX402Payment()` + `verifyX402ViaFacilitator()` |

## scripts/health-check.mjs

Self-contained Node 22 script. Zero npm dependencies — uses the built-in
`fetch` and `crypto.subtle` Ed25519 verifier. Runs in roughly three seconds
against production.

What it checks each tick:

1. **Five critical endpoints** — fetches `/v5/health`, `/v5/demo?mic=XNYS`,
   `/v5/exchanges`, `/v5/schedule?mic=XNYS`, `/openapi.json`. Each must
   return 200 within 10 seconds.

2. **Response shape** — field-presence checks against the known contracts.
   This is intentionally NOT full OpenAPI JSON-Schema validation: pulling
   `ajv` and a fresh copy of the spec on every tick is overkill, and the
   `openapi.json` paths-count assertion catches the most common drift
   (a route silently disappearing from the spec). If a future change
   warrants strict schema validation, swap in `ajv` here — the structure
   already isolates the per-endpoint checks.

3. **Ed25519 signature verification** on `/v5/health` and `/v5/demo`:
   - Fetches `/v5/keys` once and caches both the public key set and the
     `canonical_payload_spec`.
   - Picks the field list (`receipt_fields`, `override_fields`, or
     `health_fields`) based on receipt shape — health receipts have no
     `mic` and `source: SYSTEM`, override receipts include `reason`.
   - Canonicalizes alphabetically + JSON.stringify with no whitespace.
   - Verifies via `crypto.subtle.verify({ name: 'Ed25519' }, ...)`.
   - **Critical detail**: do NOT use a "drop wrapper fields" heuristic.
     `/v5/health` returns the receipt fields flat alongside unsigned
     metadata like `exchange_count` and `supported_mics`. Driving
     canonicalization off the published spec is the only safe approach.
     This bug took one iteration to find — see the Day 45 commit history.

4. **TTL window** — `expires_at - issued_at` must equal exactly 60 seconds
   (`RECEIPT_TTL_SECONDS`). Receipt must not already be expired.

5. **Pages frontend SLO** — `GET /` must return 200 in under 3 seconds.

6. **Pages-vs-Worker failure classification** — when something is broken,
   probes both `/` (Pages passthrough) and `/v5/health` (Worker API direct)
   and picks one of three suspects. See the decision tree below.

7. **Revenue pulse** — only when `MASTER_API_KEY` is set in env. Fetches
   `/v5/revenue-pulse`, filters `recent_events` to a 20-minute sliding
   window (matches the 15-min cron with overlap), emits one
   `REVENUE_NEW` JSON line per event. The workflow then opens a GitHub
   issue per `txn_id`, deduplicating against existing issues.

The script exits 0 on success, 1 on any failure. The workflow opens a
labelled GitHub issue (`health-check`, `auto`, `incident`) on exit 1
containing the last 3500 bytes of output.

### Running it locally

```bash
node scripts/health-check.mjs
# with revenue pulse:
MASTER_API_KEY=... node scripts/health-check.mjs
# against a different host:
HEADLESS_ORACLE_BASE_URL=https://staging.headlessoracle.com node scripts/health-check.mjs
```

## Pages-vs-Worker failure decision tree

This distinction is critical and the source of more than one wasted hour.
The Worker has a catch-all route on `headlessoracle.com/*`. For HTML paths
it forwards via `fetch(request)` to Cloudflare Pages (the
`headless-oracle-web` repo). For API paths it handles them directly.

```
                            +---------------------------+
                            |  GET / returns 200?       |
                            +---------------------------+
                              |                       |
                             yes                      no
                              |                       |
                              v                       v
                  +---------------------+   +----------------------+
                  | GET /v5/health 200? |   | GET /v5/health 200?  |
                  +---------------------+   +----------------------+
                    |             |           |              |
                   yes           no          yes             no
                    |             |           |              |
                    v             v           v              v
                 HEALTHY   WORKER API   PAGES (Worker      WORKER
                 (no       (Pages       routes API but    (catch-all
                 action)   passthrough  passthrough        is down —
                           OK, /v5      to Pages is        BOTH paths
                           is broken —  broken — fix       fail. Fix
                           fix          headless-          headless-
                           headless-    oracle-web         oracle-v5)
                           oracle-v5    deploy)
                           API code)
```

The script emits a `FAILURE_CLASSIFIED` log line with `pages_ok`,
`worker_ok`, and a human-readable `suspect` whenever either probe fails.

## Worker exceptions

We do NOT poll `wrangler tail` from a long-running session — Cloudflare's
own observability replaces that need:

- `wrangler.toml` already has `[observability] enabled = true,
  head_sampling_rate = 1`. All events go to **Workers Logs** in the
  Cloudflare dashboard.
- The health check fails on any sustained error in `/v5/health` /
  `/v5/demo`, which is a stronger signal than counting raw exceptions.
- For ad-hoc deep dives, run `wrangler tail --format json` from your
  terminal — it doesn't need to be persistent infrastructure.
- `runHaltMonitor()` runs every minute in production via the Worker
  cron trigger and writes its own structured logs visible in the
  dashboard.

## Paddle revenue pulse

The pipeline that turns a Paddle payment into a GitHub issue:

1. Customer pays via Paddle Checkout.
2. Paddle delivers `transaction.completed` to `POST /webhooks/paddle`.
3. The webhook handler verifies the HMAC signature, then in both the
   credits and subscription branches calls `recordPaddleRevenueEvent()`,
   which writes:
   - `paddle_revenue_count` (lifetime, no TTL)
   - `paddle_revenue_count:{tier}` (per-tier, no TTL)
   - `paddle_revenue_last_at` (ISO timestamp, no TTL)
   - `paddle_revenue_event:{ISO}` (JSON blob, 30-day TTL, listable)
4. The `health-check.yml` workflow runs every 15 min and queries
   `GET /v5/revenue-pulse` with `MASTER_API_KEY` (stored as a GitHub
   Actions secret).
5. The script filters `recent_events` to the last 20 minutes and emits
   one `REVENUE_NEW` JSON line per event.
6. The workflow's `actions/github-script@v7` step opens a GitHub issue
   per `txn_id`, deduping against existing open issues with the same
   transaction id in the title.

To verify the pulse is wired correctly without waiting for a real payment,
run the existing test: `npx vitest run -t "credits webhook records a paddle revenue event"`.

### Required secrets

The `MASTER_API_KEY` GitHub Actions secret must be configured at
**Settings → Secrets and variables → Actions** for `LembaGang/headless-oracle-v5`.
Without it, the revenue pulse step is skipped and only health checks run
(the workflow still passes — revenue surfacing is best-effort, not
required for health). The skip is logged as `REVENUE_SKIPPED`.

## Adding a new monitor

Default to durable mechanisms:

| If the check is... | Use | Why |
|---|---|---|
| HTTP probe of a public endpoint | Add to `scripts/health-check.mjs` | Already wired into the 15-min cron |
| Synthetic transaction (signed receipt, Ed25519, payment) | Same script, new function | Same |
| Real-time event (state change, payment landing) | Worker cron in `wrangler.toml` + KV write + new endpoint reading the KV | Survives session exits, agents can consume |
| One-off interactive babysitting during a session | `/loop` or `CronCreate` | Cheap, no commit cost — but it dies with the session |

Anything that must alert humans should open a GitHub issue with a stable
label so duplicates can be detected.

## What's intentionally NOT here

- **External uptime services** (Pingdom, UptimeRobot, BetterUptime). These
  are an obvious next step — the health check workflow is "good enough"
  but a third-party prober gives independent verification that
  Cloudflare itself is reachable. Add when paid traffic justifies it.
- **PagerDuty / phone alerting**. GitHub issue notifications are the
  current alert channel. Upgrade when there's an SLA to hold.
- **wrangler tail piping into a filter**. Replaced by Workers Logs +
  health-check failures, which together cover the same surface without
  needing a long-running process.
