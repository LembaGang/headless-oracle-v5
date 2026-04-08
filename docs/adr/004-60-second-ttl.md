# ADR-004: 60-Second Receipt TTL

## Status
Accepted

## Date
2026-02-22

## Context
Signed receipts carry market status at a point in time. Without an
expiry, a receipt saying "XNYS is OPEN" could be cached and acted on
after market close. Agents need a deterministic expiry to know when
to re-fetch.

## Decision
All signed receipts include `expires_at = issued_at + 60 seconds`.
The `expires_at` field is part of the canonical signed payload — it
cannot be tampered with.

`RECEIPT_TTL_SECONDS = 60` is a permanent product constant. It must
never be changed.

## Consequences

**Benefits:**
- Agents have unambiguous cache semantics: discard after `expires_at`
- 60s is short enough to catch open/close transitions (exchanges
  don't close and reopen within 60 seconds)
- Signed expiry prevents cache extension attacks
- Simple mental model: every receipt is valid for exactly 1 minute

**Trade-offs:**
- Agents must re-fetch at least every 60 seconds during active
  trading — generates baseline request volume
- No way to issue longer-lived receipts for "definitely closed"
  periods (weekends, holidays)
- At scale, 60s TTL drives more traffic than 5-minute or 15-minute
  alternatives

**Why not longer:**
Market state transitions (open, close, circuit breaker) happen on
minute boundaries. A 5-minute TTL would mean an agent could hold an
"OPEN" receipt for up to 5 minutes after market close — dangerous
for automated order execution.

**Why not shorter:**
Sub-60s TTLs create unnecessary request pressure without meaningfully
improving safety. Exchanges don't change state more than once per
minute under normal conditions.
