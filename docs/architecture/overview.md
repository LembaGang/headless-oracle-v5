# Architecture Overview

Last updated: 2026-04-08

## System Summary

Headless Oracle is a single Cloudflare Worker (~14,000 lines of TypeScript) that returns Ed25519-signed market-state attestations for 28 global exchanges. Every response to a status query is cryptographically signed. UNKNOWN states are treated as CLOSED (fail-closed).

## Runtime

- **Platform**: Cloudflare Workers (edge, no origin server)
- **Language**: TypeScript (single file: `src/index.ts`)
- **Signing**: Ed25519 via `@noble/ed25519` with `@noble/hashes`
- **Framework**: None — raw `fetch()` handler

## Infrastructure Components

### KV Namespaces

| Namespace | Purpose |
|---|---|
| `ORACLE_OVERRIDES` | Manual circuit-breaker halts (MIC codes only) |
| `ORACLE_API_KEYS` | API key state (sha256 → plan/status/balance) |
| `ORACLE_TELEMETRY` | Usage metrics, MCP analytics, telemetry counters |

### Durable Objects

| Object | Purpose |
|---|---|
| `WebhookDispatcher` | Alarm-based state-change detector, fans out webhook deliveries |
| `StreamCoordinator` | SSE stream for `/v5/stream`, polls every 30s |

### External Services

| Service | Purpose |
|---|---|
| Supabase | Durable API key storage (source of truth) |
| Paddle | Subscription and credit billing |
| Coinbase CDP | x402 micropayment facilitation |
| Resend | Email delivery (API keys, notifications) |
| Polygon.io | Real-time halt detection (primary) |
| Alpaca | Real-time halt detection (fallback, US-only) |

## 4-Tier Fail-Closed Architecture

Every status request passes through 4 tiers:

1. **Tier 0 — KV Override**: Check `ORACLE_OVERRIDES[mic]` for manual halts. If found and not expired → HALTED/OVERRIDE.
2. **Tier 1 — Schedule Engine**: Compute OPEN/CLOSED from market calendar, timezone, holidays, lunch breaks.
3. **Tier 2 — UNKNOWN Fallback**: If Tier 1 throws → sign and return UNKNOWN/SYSTEM receipt. Consumers MUST treat UNKNOWN as CLOSED.
4. **Tier 3 — Critical Failure**: If signing itself fails → return unsigned CRITICAL_FAILURE 500 with UNKNOWN status.

## Signing Model

- **Algorithm**: Ed25519 (deterministic, no external CA)
- **Canonical payload**: All fields except `signature`, keys sorted alphabetically, `JSON.stringify` with no whitespace
- **Receipt TTL**: 60 seconds (signed into the payload, immutable)
- **Key discovery**: `GET /v5/keys` and `GET /.well-known/oracle-keys.json`

## Cron Triggers

| Schedule | Handler |
|---|---|
| `* * * * *` | `runHaltMonitor()` — real-time halt detection |
| `0 9 * * *` | Daily: npm download stats + DST reminders |
| `0 17 * * *` | Daily: MCP client analytics aggregation |
| `0 9 * * 1` | Monday: weekly digest summary |

## Authentication Model

5-step hot path in `checkApiKey()`:
1. `MASTER_API_KEY` → immediate pass
2. `BETA_API_KEYS` → immediate pass
3. In-memory cache (60s TTL) → pass if found
4. `ORACLE_API_KEYS` KV → pass if found, populate cache
5. Supabase lookup → pass if found, populate KV + cache
6. All miss → 403

## Related Documents

- [Data Flow](data-flow.md) — Request lifecycle for common paths
- [Architecture Decisions](adr/) — ADRs for key design choices
- [API Reference](../api/rest-reference.md) — Endpoint documentation
