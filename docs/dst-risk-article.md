# The Phantom Hour: How DST Breaks Trading Agents

*Published for the March 8, 2026 US DST transition.*

---

Every trading bot eventually discovers the same bug — usually at 2 a.m. on a Sunday.

The clocks change. Your hardcoded UTC offset is now wrong by an hour. Orders fire during what your bot thinks is market-open but what the exchange considers pre-market. Or the inverse: your bot sits idle during the first hour of actual trading, waiting for an open signal that never arrives on its old schedule.

This isn't a fringe case. It happens twice a year, to every system that doesn't handle it correctly.

---

## What Actually Happens on DST Day

**March 8, 2026** — US clocks spring forward at 2:00 a.m. EST. Clocks jump to 3:00 a.m. EDT. There is no 2:00–3:00 a.m. That hour does not exist.

**March 29, 2026** — UK and EU clocks spring forward. The EU transition is 3 weeks after the US transition. For those 3 weeks, the spread between New York and London is one hour narrower than usual.

The 2026 DST event calendar:

| Date | Event | Exchanges affected |
|------|-------|--------------------|
| Mar 8 | US: EST → EDT (UTC−5 → UTC−4) | XNYS, XNAS |
| Mar 29 | UK: GMT → BST (UTC+0 → UTC+1) | XLON |
| Mar 29 | EU: CET → CEST (UTC+1 → UTC+2) | XPAR |
| Oct 25 | UK/EU fall back | XLON, XPAR |
| Nov 1 | US falls back | XNYS, XNAS |

These are the only clock transitions that affect the 7 major equity markets. XJPX, XHKG, and XSES do not observe DST. But Tokyo and Hong Kong both have lunch breaks — a separate complexity addressed below.

---

## The 3-Week Window: March 8–29

Between March 8 and March 29, the US has already moved to summer time but Europe hasn't. This is the most disruptive period:

- **NYSE open** shifts from 14:30 UTC to **13:30 UTC** (one hour earlier)
- **LSE open** stays at 08:00 UTC until March 29
- The US-EU overlap, which normally runs 14:30–16:30 UTC, now runs **13:30–16:30 UTC** — an extra hour of parallel trading

An agent with hardcoded UTC open times like:
```python
NYSE_OPEN_UTC  = "14:30"  # WRONG from March 8 to March 29
LSE_OPEN_UTC   = "08:00"  # correct until March 29, then wrong
```

...will misfire during this window. If it fires orders assuming the market is closed because it's before 14:30 UTC, it's wrong. If it skips orders during what it thinks is NYSE pre-market but is actually NYSE regular hours, it's wrong in the opposite direction.

---

## The Three Categories of DST Bug

### 1. Hardcoded UTC offsets

The most common pattern:

```python
# The wrong way — hardcoded EST offset
NYSE_OPEN  = datetime.now(tz=timezone.utc).replace(hour=14, minute=30)
NYSE_CLOSE = datetime.now(tz=timezone.utc).replace(hour=21, minute=0)
```

This is correct during Eastern Standard Time (UTC−5). It is wrong from March 8 to November 1, when NYSE operates on Eastern Daylight Time (UTC−4), opening at 13:30 UTC and closing at 20:00 UTC.

The failure mode is silent — the bot doesn't crash, it just operates on the wrong schedule.

### 2. Timezone library bugs

Some libraries handle the DST transition correctly for local-time arithmetic but produce incorrect UTC conversions near the transition boundary. The classic pattern:

```javascript
// Appears correct, breaks at DST boundary
const open = new Date('2026-03-08 09:30:00 America/New_York');
// Does the library know that 2:00-3:00 a.m. doesn't exist?
// What does it return for dates in the phantom hour?
```

Different libraries make different choices about what to do with times that don't exist (the phantom hour on spring-forward day) or times that occur twice (fall-back). There is no universally correct answer — but most bots aren't testing for it.

### 3. Cached schedule data

Agents that fetch market schedules at startup and cache them for 24 hours will serve the pre-DST schedule for the entire day of the transition if the cache was populated before the clocks changed. An hour of trades fire on the wrong schedule.

---

## The Lunch Break Complication

Two exchanges have daily mid-session breaks that catch agents off-guard:

| Exchange | Lunch break (local time) | UTC equivalent |
|----------|--------------------------|----------------|
| XJPX (Tokyo) | 11:30–12:30 JST | 02:30–03:30 UTC |
| XHKG (Hong Kong) | 12:00–13:00 HKT | 04:00–05:00 UTC |

Tokyo and Hong Kong don't observe DST, so the UTC times above are stable year-round. But agents built for NYSE/NASDAQ behavior (continuous trading, no mid-session break) don't model this correctly.

An agent querying XJPX at 11:45 JST will get CLOSED. If it treats that as "market is done for the day" rather than "market is on lunch break," it may not re-check or re-enable execution for the afternoon session.

---

## The Right Architecture

The correct approach is to not compute market state locally at all.

```python
# The right way — query a signed source of truth
import httpx

def is_market_open(mic: str) -> bool:
    resp = httpx.get(
        f"https://headlessoracle.com/v5/demo?mic={mic}",
        timeout=5.0
    )
    receipt = resp.json()

    # Receipts expire in 60 seconds — always re-fetch
    if receipt["status"] == "OPEN":
        return True

    # UNKNOWN is fail-closed by contract — treat as CLOSED
    return False
```

```javascript
// JavaScript equivalent — with signature verification
import { verify } from '@headlessoracle/verify';

async function isMarketOpen(mic) {
  const resp = await fetch(`https://headlessoracle.com/v5/demo?mic=${mic}`);
  const receipt = await resp.json();

  // Verify the Ed25519 signature before trusting the result
  const result = await verify(receipt);
  if (!result.ok) throw new Error(`Invalid receipt: ${result.reason}`);

  return receipt.status === 'OPEN';
  // UNKNOWN → false (fail-closed)
}
```

This approach delegates all schedule complexity — DST, holidays, lunch breaks, circuit breakers — to an API that handles it correctly. The consumer never touches timezone logic.

---

## How Headless Oracle Handles This

The schedule engine in Headless Oracle uses IANA timezone names (`America/New_York`, `Europe/London`, `Asia/Tokyo`) via `Intl.DateTimeFormat`. There are no hardcoded UTC offsets anywhere in the codebase. DST transitions are automatic and always correct because the IANA timezone database is authoritative and updated by the OS.

The holiday lists are year-keyed. If you query 2027 and 2027 data hasn't been loaded, the system returns `UNKNOWN/SYSTEM` rather than silently falling back to 2026 data. That converts a silent wrong answer into a detectable safe state.

Every response includes `expires_at: issued_at + 60s`. A cached receipt that was OPEN cannot be acted on after it expires. Agents must re-fetch before acting.

The KV-backed circuit breaker lets operators post an emergency HALTED override without redeployment — relevant if an exchange halts trading mid-session and the scheduled status would otherwise say OPEN.

---

## What to Do Before March 8

1. **Find every UTC offset in your codebase**: `grep -r "14:30\|09:30\|16:00" .` — those are probably hardcoded NYSE/LSE/XPAR open times.

2. **Check your timezone library**: does it handle non-existent times (phantom hour) and ambiguous times (fall-back) deterministically?

3. **Check your cache TTLs**: anything over 60 seconds risks serving the wrong schedule through a DST transition if the cache was populated before the clocks changed.

4. **Test the March 8–29 window explicitly**: write a test that mocks the current time to March 9, 2026 08:00 UTC (before NYSE opens under EDT) and verify your bot correctly waits until 13:30 UTC, not 14:30 UTC.

5. **Consider delegating entirely**: if getting market state right isn't your core competency, use an API that specialises in it.

---

## Live Demo

```
GET https://headlessoracle.com/v5/demo?mic=XNYS
```

Returns a signed receipt with `status: OPEN | CLOSED | HALTED | UNKNOWN`, `expires_at` (60s TTL), and an Ed25519 signature over the canonical payload. Consumers can verify the signature independently using the public key at `/v5/keys`.

`UNKNOWN` is always fail-closed. An agent that treats `UNKNOWN` as `CLOSED` and halts execution is correct by contract.
