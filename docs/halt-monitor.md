# Headless Oracle — Autonomous Halt Monitor

## What It Does

Headless Oracle runs an autonomous halt monitor every minute via Cloudflare Cron. It checks exchanges that are currently scheduled OPEN against real-time market data sources. When a discrepancy is detected — the exchange is scheduled OPEN but real-time data says it is halted — the monitor writes a `REALTIME` circuit breaker override to the `ORACLE_OVERRIDES` KV namespace.

> **Coverage note**: Real-time halt detection currently covers US markets (XNYS, XNAS) via Polygon.io (primary) and Alpaca (fallback). All 28 exchanges use schedule-based detection for holidays, weekends, and lunch breaks. Non-US exchanges use schedule-based detection unless you extend the `micToPolygon` mapping in `src/index.ts` with additional Polygon exchange names.

This means `GET /v5/status` and `GET /v5/demo` will return `status: 'HALTED', source: 'OVERRIDE'` for affected exchanges within 60 seconds of detection. Every receipt answered from an override entry signs `source: 'OVERRIDE'`, whoever wrote the entry. What tells a monitor-written entry apart is signed elsewhere in the receipt: its `reason` ("Real-time halt detected by halt monitor (source: polygon)"), `coverage.consulted`, which names `realtime_halt_feed_via_override`, and, in schema_version v5.1 receipts, `closure_reason: 'feed_reported_not_open'`.

## Why This Matters for Agents

Agents consuming signed Oracle receipts get the strongest possible safety guarantee:

1. **Schedule-based detection** catches holidays, weekends, lunch breaks, and known early closes
2. **Real-time detection** catches unscheduled halts, circuit breakers, and exchange system outages

Without a halt monitor, an agent could receive `status: 'OPEN'` for an exchange that has suspended trading. With the halt monitor, that discrepancy is detected within 60 seconds and the receipt flips to `HALTED`.

## Data Sources

| Priority | Source | Scope | Auth Required |
|----------|--------|-------|---------------|
| 1 (primary) | Polygon.io `/v1/marketstatus/now` | US markets (XNYS, XNAS) only | `POLYGON_API_KEY` secret |
| 2 (fallback) | Alpaca paper-api `/v2/clock` | US markets only | None (public paper endpoint) |

If both sources fail to respond within 5 seconds, the monitor **fails open** — no REALTIME override is written and the schedule-based status is preserved. This is an intentional design choice: a false halt (blocking trading when the market is actually open) is worse for most consumers than a missed halt.

## KV Override Format

When a halt is detected, the monitor writes to `ORACLE_OVERRIDES`:

```json
{
  "status": "HALTED",
  "source": "REALTIME",
  "origin": "monitor",
  "reason": "Real-time halt detected by halt monitor (source: polygon)",
  "expires": "2026-03-10T11:00:00.000Z",
  "auto_clear_at": "2026-03-10T11:00:00.000Z",
  "detected_at": "2026-03-10T09:00:00.000Z"
}
```

Key: `XNYS` (MIC code), TTL: 7200 seconds (2 hours).

## Auto-Clear Logic

The monitor writes `"origin": "monitor"` in its entries (since B-490 (3)). When it runs:
- and the exchange is OPEN per real-time data, it deletes an entry only if its `origin` is `monitor`;
- and the exchange is halted per real-time data, it writes its entry only if no live entry of another origin is there.

An entry the monitor wrote before origins were recorded has no `origin`, but its bytes are the monitor's own: exactly the keys of the entry above less `origin`, in that order (`status` HALTED, `source` REALTIME, the monitor's `reason` naming polygon or alpaca, `expires` equal to `auto_clear_at` and exactly two hours after `detected_at`, as `toISOString()` writes them). The code (`isLegacyMonitorEntry`) recognises exactly those bytes and treats the entry as the monitor's: at the first run after the deploy it is deleted if the exchange is OPEN per real-time data, and replaced by the monitor's own entry, with `origin`, if not. No route writes `ORACLE_OVERRIDES` and the runbook's operator form has none of those keys, so no operator entry has those bytes.

So the monitor's own entries clear when the exchange resumes, and an entry written by an operator (`"origin": "operator"`), or with no recorded origin and not the monitor's own bytes, is never overwritten or cleared by the monitor: it lasts until its `expires` time or until an operator deletes it.

## Endpoints

### GET /v5/status/realtime

Requires `X-Oracle-Key` header. Returns:
- `signed_receipt` — full signed market receipt for the requested MIC
- `halt_monitor.active_realtime_override` — the active REALTIME override (null if none)

```
GET /v5/status/realtime?mic=XNYS
X-Oracle-Key: your_key

{
  "mic": "XNYS",
  "signed_receipt": { "mic": "XNYS", "status": "OPEN", "source": "SCHEDULE", ... },
  "halt_monitor": {
    "active_realtime_override": null,
    "note": "halt_monitor runs every minute via cron. REALTIME overrides are auto-cleared when exchange resumes."
  }
}
```

### GET /v5/health

The health endpoint includes a `halt_monitor` section:

```json
{
  "halt_monitor": {
    "status": "active",
    "cron": "* * * * *",
    "sources": ["polygon", "alpaca"],
    "active_realtime_overrides": [],
    "note": "Checks scheduled-OPEN exchanges every minute..."
  }
}
```

`active_realtime_overrides` lists all MICs that currently have an active REALTIME halt detected by the monitor. An agent can check this before sending a batch query.

## Configuration

### Enabling Enhanced Coverage (Polygon.io)

Without `POLYGON_API_KEY`, the halt monitor falls back to Alpaca for US markets only. For full international coverage via Polygon, set the secret:

```
wrangler secret put POLYGON_API_KEY
```

Polygon's free tier covers US market status. The `/v1/marketstatus/now` endpoint returns per-exchange status for XNYS (nyse) and XNAS (nasdaq).

### Supported MIC → Polygon Name Mapping

| MIC  | Polygon exchange name |
|------|-----------------------|
| XNYS | nyse                  |
| XNAS | nasdaq                |

Other MICs are not directly supported by Polygon's market status endpoint — they use the schedule-based system only, unless you extend the `micToPolygon` mapping in `src/index.ts`.

## Source Field in Signed Receipts

Receipts produced while a monitor-written override is active have `source: 'OVERRIDE'`, as every receipt answered from an override entry does; the value `REALTIME` in the KV entry is not copied into the receipt. The signed `reason`, `coverage.consulted` (`realtime_halt_feed_via_override`) and, in v5.1, `closure_reason` (`feed_reported_not_open`) say that the entry came from the monitor. All of these are signed fields, covered by the Ed25519 signature.

Valid source values: `SCHEDULE`, `OVERRIDE`, `SYSTEM`, `REALTIME`

Consumers should treat every `HALTED` receipt the same way, whoever wrote the entry: halt all execution.

## Operational Notes

- The 2-hour TTL is intentional: long enough to survive transient API outages without manually clearing, short enough to auto-clear before the next session opens
- Cron fires every minute but only makes external API calls for exchanges currently scheduled OPEN — typically 2-4 exchanges at any given moment
- Workers Logs will show `HALT_MONITOR_RUN` events every minute with a summary of checks and detections
- `HALT_MONITOR_HALTED` events log when a new REALTIME override is written
- `HALT_MONITOR_CLEARED` events log when a REALTIME override is auto-cleared
