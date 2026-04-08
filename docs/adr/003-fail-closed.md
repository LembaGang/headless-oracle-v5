# ADR-003: Fail-Closed Architecture (UNKNOWN = CLOSED)

## Status
Accepted

## Date
2026-01-15

## Context
Autonomous trading agents act on market-state data without human
oversight. If the oracle crashes, returns stale data, or encounters
an unexpected state, the agent must not interpret silence or errors
as permission to trade.

## Decision
Implement a 4-tier fail-closed architecture:

- **Tier 0:** KV override check — if a manual halt exists and is not
  expired, return HALTED/OVERRIDE
- **Tier 1:** Schedule computation — return OPEN or CLOSED from the
  market calendar
- **Tier 2:** If Tier 1 throws, sign and return UNKNOWN/SYSTEM
  (a signed receipt confirming we don't know)
- **Tier 3:** If signing itself fails, return unsigned
  CRITICAL_FAILURE 500 with UNKNOWN status

Consumers MUST treat UNKNOWN as CLOSED and halt all execution.

## Consequences

**Benefits:**
- A crashed oracle never silently permits trading
- UNKNOWN is a first-class status, not an error code — it's signed
  and carries the same TTL as any other receipt
- Agents can distinguish "oracle is down" (no response) from "oracle
  doesn't know" (UNKNOWN receipt) from "market is closed" (CLOSED)
- Tier 3 is the only unsigned response — agents can detect signing
  system failure

**Trade-offs:**
- False CLOSED: if Tier 1 has a bug, the oracle will report UNKNOWN
  instead of the correct status. This means agents stop trading
  unnecessarily (safe failure, not dangerous)
- More complex than a simple "return 500 on error" approach
- Consumers must implement UNKNOWN handling — can't just check for
  OPEN/CLOSED

**Why not fail-open:**
A fail-open oracle that returns OPEN during an outage could cause
agents to trade during a market halt, circuit breaker, or holiday.
The financial risk of a false OPEN far exceeds the opportunity cost
of a false CLOSED.
