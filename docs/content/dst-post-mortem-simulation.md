# Post-mortem: How an autonomous agent lost $47,000 during the March 2026 US DST transition

**Severity**: P1 — Financial loss
**Status**: Resolved
**Date of incident**: 2026-03-08 20:47 UTC
**Date of post-mortem**: 2026-03-10
**Author**: Platform Engineering
**Review board**: Risk, Infra, Trading Systems

---

## Incident Summary

On 2026-03-08 at 20:47 UTC, an autonomous liquidation bot (`liquidator-v2`) executed a collateral assessment and settlement attempt against a tokenized equity position (OUSG — Ondo Finance USD Government Bond Fund) held as collateral in an on-chain lending protocol.

At the time of execution, the NYSE had been closed for 47 minutes. The bot used stale price data from the last valid tick at 19:58 UTC, attempted settlement against a dark pool that had already suspended operations for the session, and incurred $47,000 in slippage and failed settlement fees before the circuit breaker in the lending protocol's risk module triggered and halted further attempts.

The root cause was a hardcoded UTC close time of 21:00 (NYSE winter hours) that was not updated for the US DST transition. After the transition, NYSE closed at 20:00 UTC. The bot had no mechanism to verify actual market state before execution.

---

## Timeline (all times UTC)

| Time | Event |
|---|---|
| 2026-03-08 00:00 | US clocks spring forward (EST → EDT). NYSE close shifts from 21:00 UTC to **20:00 UTC**. |
| 2026-03-08 20:00 | NYSE closes. Dark pool suspends session. Last valid price: $102.31 (OUSG). |
| 2026-03-08 20:00–20:58 | Market-maker activity ceases. Bid-ask spread widens. Stale data persists in oracle feed. |
| 2026-03-08 20:47 | `liquidator-v2` wakes on scheduled tick. `isNYSEOpen()` returns `true` (hardcoded 21:00 UTC close). |
| 2026-03-08 20:47:03 | Bot reads OUSG price: $102.31 (last tick at 19:58 UTC — 49 minutes stale). |
| 2026-03-08 20:47:05 | Bot classifies position as undercollateralised. Initiates liquidation against dark pool. |
| 2026-03-08 20:47:06–20:47:31 | Dark pool rejects settlement (session closed). Bot retries 4× with increasing lot size. |
| 2026-03-08 20:47:31 | Bot routes to secondary venue (Uniswap v4 RWA pool). Executes against thin liquidity. |
| 2026-03-08 20:47:33 | $31,200 in slippage realized on forced sell of 382 OUSG units at $101.49 vs fair value $102.31. |
| 2026-03-08 20:47:34–20:51:17 | 3 additional liquidation sequences initiated before on-chain circuit breaker triggers. |
| 2026-03-08 20:51:17 | Lending protocol's `LiquidationHaltModule` (threshold: 4 failed settlements) fires. Bot halted. |
| 2026-03-08 20:52 | On-call engineer paged. Bot manually disabled. |
| 2026-03-08 21:00 | Incident confirmed. Total loss: **$47,223** ($31,200 slippage + $11,800 failed settlement gas + $4,223 protocol fees). |
| 2026-03-09 09:15 | Root cause confirmed as DST offset. |
| 2026-03-10 | Post-mortem published. |

---

## Root Cause Analysis

### Primary: Hardcoded UTC close time

`liquidator-v2` contained a 47-line `isNYSEOpen()` function with a hardcoded UTC close time:

```typescript
// BEFORE — 47 lines of timezone logic
function isNYSEOpen(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat

  // Check weekend
  if (utcDay === 0 || utcDay === 6) return false;

  // HARDCODED: NYSE winter hours (EST = UTC-5)
  // Open:  9:30 EST = 14:30 UTC
  // Close: 16:00 EST = 21:00 UTC   <-- WRONG after DST spring forward
  const openUTC  = 14 * 60 + 30; // 14:30 UTC
  const closeUTC = 21 * 60;      // 21:00 UTC — this is EST (winter), not EDT (summer)

  const nowMinutes = utcHour * 60 + utcMinute;
  if (nowMinutes < openUTC || nowMinutes >= closeUTC) return false;

  // Check US Federal holidays (hardcoded list — missing Good Friday, half-days)
  const month = now.getUTCMonth() + 1;
  const day   = now.getUTCDate();
  const holidays2026 = [
    [1, 1], [1, 19], [2, 16], [5, 25], [7, 3], [9, 7], [11, 26], [12, 25],
  ];
  for (const [hm, hd] of holidays2026) {
    if (month === hm && day === hd) return false;
  }

  // Check early closes (hardcoded — incomplete, missing Black Friday)
  const earlyCloses2026 = [
    [11, 27], // Day after Thanksgiving: 13:00 EST = 18:00 UTC
  ];
  for (const [em, ed] of earlyCloses2026) {
    if (month === em && day === ed) {
      const earlyCloseUTC = 18 * 60; // 18:00 UTC
      if (nowMinutes >= earlyCloseUTC) return false;
    }
  }

  // Additional heuristics for DST transitions would go here
  // TODO: implement DST handling
  return true;
}
```

The function had a `TODO` comment on DST handling that was never implemented. The close time of `21:00 UTC` is correct for Eastern Standard Time (UTC-5) but incorrect for Eastern Daylight Time (UTC-4). After the March 8 clock change, NYSE closes at `20:00 UTC`. The function returned `true` from 20:00–21:00 UTC for the entire duration of summer — a 1-hour window of incorrect state on every trading day through November 1.

### Contributing: No cryptographic verification of market state

The function computed market state locally from a hardcoded schedule rather than fetching a cryptographically attested receipt from an authoritative source. There was no mechanism to detect or surface the error — the function returned a boolean with no provenance, no TTL, and no signature.

### Contributing: Stale price data not rejected

The price data pipeline consumed the last available tick without checking its age relative to market close. A 49-minute-stale price should have triggered an abort. No staleness check existed.

### Contributing: Retry-on-rejection logic exacerbated loss

The dark pool rejection (session closed) was treated as a transient failure. The bot retried 4× with increasing lot sizes before routing to secondary venues. The rejection code (`SESSION_CLOSED`) was not differentiated from a transient network error.

---

## Impact

| Category | Amount |
|---|---|
| Slippage on forced OUSG liquidation | $31,200 |
| Failed settlement fees (dark pool × 4 retries) | $11,800 |
| Protocol liquidation fees | $4,223 |
| **Total** | **$47,223** |

Positions affected: 1 borrower account, 382 OUSG units (~$39,100 notional).

No funds were lost from the protocol treasury. The loss was borne by the liquidation bot operator (the team).

---

## Detection

Detection occurred via the on-chain `LiquidationHaltModule`, not by the bot itself. The halt module triggered after 4 consecutive failed settlements — a threshold designed for infrastructure failures, not systematic logic errors.

The on-call page arrived 5 minutes after the first liquidation attempt. By that point, the loss was complete.

No alerting existed for "liquidation during closed market hours" because the system believed the market was open.

---

## Resolution

**Immediate (2026-03-08)**:
- Bot manually disabled at 20:52 UTC.
- Lending protocol risk team notified.

**Short-term (2026-03-09)**:
- `liquidator-v2` taken offline.
- Temporary manual review gate added for all liquidation attempts.

**Permanent (2026-03-10)**:
- `isNYSEOpen()` replaced with a Headless Oracle pre-execution gate.
- Price staleness check added (reject any tick > 5 minutes old).
- Dark pool `SESSION_CLOSED` code added to non-retryable error set.

---

## Code Change

The 47-line `isNYSEOpen()` function was replaced with a 3-line oracle call:

```typescript
// AFTER — 3 lines. Cryptographically verified. DST-aware. Holiday-aware.
import { OracleClient } from 'headless-oracle';

const oracle = new OracleClient({ apiKey: process.env.ORACLE_API_KEY });

async function isNYSEOpen(): Promise<boolean> {
  const receipt = await oracle.status('XNYS');
  return receipt.status === 'OPEN'; // UNKNOWN and HALTED treated as CLOSED by design
}
```

The Headless Oracle receipt includes:
- `status`: `OPEN | CLOSED | HALTED | UNKNOWN`
- `expires_at`: TTL — the receipt is invalid after this timestamp (60-second window)
- `signature`: Ed25519 signature over the canonical payload — tamper-evident
- `issued_at`: when the receipt was generated — used to detect stale data

The bot now aborts if `status !== 'OPEN'`, if the receipt is expired (`expires_at < now`), or if signature verification fails.

---

## Lessons Learned

### 1. Timezone arithmetic is the wrong abstraction

UTC offsets are not stable. They change twice a year for exchanges in DST-observing jurisdictions and require separate maintenance for every exchange in every jurisdiction. A function that was correct on March 7 was wrong on March 8 without any code change.

The correct abstraction is a verified attestation from a source that handles DST, holidays, and early closes correctly and publishes the result with a cryptographic signature and a TTL.

### 2. Market state must be externally attested, not locally computed

Locally computed market state has no chain of custody. There is no way to verify that the computation used correct inputs, was executed at the right time, or accounted for exceptional conditions (circuit breakers, regulatory halts, emergency closures). A signed receipt from an external oracle provides all three: inputs are attested, timestamp is signed, and exceptional conditions are encoded in the `HALTED` status.

### 3. UNKNOWN must halt execution

The Headless Oracle contract requires consumers to treat `UNKNOWN` as `CLOSED`. This is not a suggestion — it is the only safe default. Any system that executes on an `UNKNOWN` market state is accepting a risk it cannot measure.

### 4. Retry logic must distinguish rejection codes

A `SESSION_CLOSED` error from a settlement venue is not a transient infrastructure error. It is a terminal signal that the session is over. Retrying against a closed venue with increasing lot sizes is not a recovery strategy — it is loss amplification.

### 5. Pre-execution gates are not optional

The bot had a liquidation halt module — but it was on-chain, reactive, and triggered after the damage was done. A pre-execution gate that checks market state before initiating any sequence would have prevented the first liquidation attempt entirely.

---

## Action Items

| Item | Owner | Status |
|---|---|---|
| Replace `isNYSEOpen()` with oracle call across all bots | Platform Eng | Done |
| Add price staleness check (reject ticks > 5 min old) | Data Infra | Done |
| Add `SESSION_CLOSED` to non-retryable error set | Trading Systems | Done |
| Audit all hardcoded UTC offsets in the codebase | Platform Eng | In progress |
| Add pre-execution gate to all liquidation entry points | Risk | In progress |
| Implement signed-receipt verification in liquidator | Platform Eng | Scheduled |

---

## Prevention

Any autonomous system that executes financial operations based on market state should:

1. Fetch a signed market state receipt from an external oracle before execution
2. Verify the cryptographic signature (Ed25519) against the published public key
3. Check the receipt TTL (`expires_at`) — reject expired receipts
4. Treat `UNKNOWN` and `HALTED` as `CLOSED` — halt all execution
5. Never cache a receipt beyond its `expires_at`

These five checks take 3 lines of code and one API call. They cost 0.001 USDC.

---

*The oracle call costs 0.001 USDC. The incident cost $47,000.*
