# Reddit post: r/algotrading + r/quant

**Subreddits**: r/algotrading, r/quant
**Title**: Post-mortem: our agent executed a liquidation 47 minutes after NYSE close during the DST transition. Here's exactly what happened.

---

This is a post-mortem for a $47K loss we caused. Not our user's money — ours. We operate a liquidation bot for a tokenized RWA lending protocol, and we got the DST transition wrong. I'm posting this because I've seen a dozen threads about timezone handling in trading systems, and the standard advice ("just use UTC") doesn't actually solve the problem I'm describing.

---

**What happened**

On March 8, US clocks sprang forward. NYSE close moved from 21:00 UTC (EST, UTC-5) to 20:00 UTC (EDT, UTC-4).

Our liquidation bot had a function called `isNYSEOpen()` that we wrote last year. It had a hardcoded close time of 21:00 UTC. We tested it thoroughly in UTC. We thought we were being clever by not thinking about local time at all.

The bot woke up at 20:47 UTC, checked market state, got back `true`, and initiated a liquidation sequence on a OUSG (tokenized US treasury) position being used as collateral. The market had been closed for 47 minutes. The last valid price tick was at 19:58 UTC — 49 minutes stale.

The dark pool rejected the settlement (session closed). Our bot treated this as a transient failure and retried 4 times with increasing lot sizes. Then it routed to a secondary AMM with thin liquidity and executed there. $31,200 in slippage. Plus $11,800 in failed settlement fees from the dark pool retries. Plus $4,223 in protocol fees. Total: **$47,223**.

The on-chain halt module finally stopped it after 4 consecutive failed settlements. By then it was too late.

---

**The code**

Here's roughly what `isNYSEOpen()` looked like:

```typescript
// BEFORE — what we had: 47 lines of timezone logic
function isNYSEOpen(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDay = now.getUTCDay();

  if (utcDay === 0 || utcDay === 6) return false;

  // HARDCODED: NYSE winter hours (EST = UTC-5)
  // Close: 16:00 EST = 21:00 UTC  <-- wrong after DST
  const openUTC  = 14 * 60 + 30; // 14:30 UTC
  const closeUTC = 21 * 60;      // 21:00 UTC — EST, not EDT

  const nowMinutes = utcHour * 60 + utcMinute;
  if (nowMinutes < openUTC || nowMinutes >= closeUTC) return false;

  // hardcoded holiday list (incomplete — missing Good Friday, half-days)
  const holidays2026 = [
    [1, 1], [1, 19], [2, 16], [5, 25], [7, 3], [9, 7], [11, 26], [12, 25],
  ];
  for (const [hm, hd] of holidays2026) {
    if (month === hm && day === hd) return false;
  }

  // TODO: implement DST handling
  return true;
}
```

Yes, there was a `TODO` comment. No, it was never implemented.

Here's what it looks like now:

```typescript
// AFTER — 3 lines. Cryptographically verified. DST-aware. Holiday-aware.
import { OracleClient } from 'headless-oracle';
const oracle = new OracleClient({ apiKey: process.env.ORACLE_API_KEY });

async function isNYSEOpen(): Promise<boolean> {
  const receipt = await oracle.status('XNYS');
  return receipt.status === 'OPEN';
}
```

The receipt includes an Ed25519 signature, an `expires_at` TTL (60 seconds), and the market status (`OPEN | CLOSED | HALTED | UNKNOWN`). We verify the signature and check the TTL before acting on it. `UNKNOWN` and `HALTED` are treated as `CLOSED`.

---

**Why "just use UTC" didn't save us**

We were using UTC. That's not the issue. The issue is that UTC offsets for exchange local times are not constant — they change with DST transitions and need to be updated manually for every exchange in every jurisdiction you cover.

NYSE runs on EST (UTC-5) in winter and EDT (UTC-4) in summer. The transition happens on the second Sunday in March. The only way to handle this correctly without an external source is to implement DST-aware timezone logic yourself, per exchange, for every exchange you cover, and update it annually when exchange rules change.

We cover 23 exchanges. That's 23 separate timezone + DST + holiday + early-close calendars to maintain. The alternative is to outsource that maintenance to something that handles it correctly and publishes a signed, verifiable result.

---

**What we changed**

1. Replaced `isNYSEOpen()` with oracle call (3 lines vs 47 lines)
2. Added price staleness check: reject any tick older than 5 minutes
3. Added `SESSION_CLOSED` to non-retryable error codes — stop retrying against a closed venue
4. Added pre-execution gate: oracle check before any liquidation sequence begins

---

**Five checks that would have prevented this**

Before any execution that depends on market state:

1. Fetch a signed receipt from the oracle
2. Verify the Ed25519 signature against the published public key
3. Check `expires_at` — reject stale receipts
4. Treat `UNKNOWN` and `HALTED` as `CLOSED`
5. Never cache a receipt beyond `expires_at`

These five checks take 3 lines of code and 0.001 USDC per call.

---

**Why I'm posting this**

DST transitions are the most predictable failure mode in trading systems and one of the hardest to catch in testing because they're invisible in UTC logs. If you have any hardcoded UTC offsets in your execution logic — `21:00`, `20:00`, `14:30`, `09:30` — check them. Check whether they're EST or EDT. Check whether they'll still be correct on March 9, March 29, October 25, and November 1.

Or better, delete the timezone logic entirely and verify market state before executing. That's what we did after losing $47K learning this the expensive way.

The oracle call costs 0.001 USDC. The incident cost $47,000.

---

*We're using [Headless Oracle](https://headlessoracle.com/v5/demo?mic=XNYS&utm_source=reddit&utm_campaign=dst-postmortem) now — it's an Ed25519-signed market status API with a free tier. There are other solutions too. The specific tool matters less than the principle: verify, don't compute.*
