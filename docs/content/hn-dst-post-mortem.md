# Hacker News post

**Title**: Post-mortem: autonomous agent executed during market close due to DST offset — $47K impact

---

An autonomous liquidation bot executed a collateral assessment 47 minutes after NYSE close on March 8 (US DST transition day). Market state was computed locally from a hardcoded UTC close time. The function had the winter offset (21:00 UTC) — correct for EST, wrong after the spring-forward to EDT (20:00 UTC).

**Timeline** (UTC, March 8 2026):

- `20:00` — NYSE closes. Last valid OUSG price: $102.31.
- `20:47` — Bot wakes on scheduled tick. `isNYSEOpen()` returns `true`. Price read: $102.31 (49 minutes stale).
- `20:47:05` — Liquidation initiated. Dark pool rejects: `SESSION_CLOSED`. Bot retries 4× (exponential backoff + increasing lot sizes).
- `20:47:31` — Routed to secondary AMM (Uniswap v4 RWA pool). Thin liquidity. Executed.
- `20:51:17` — On-chain circuit breaker triggers (4 consecutive failed settlements). Bot halted.
- Total loss: **$47,223** ($31,200 slippage + $11,800 dark pool rejection fees + $4,223 protocol fees).

**Root cause**: hardcoded UTC offset, no external market state verification, retry logic treating `SESSION_CLOSED` as transient.

**The diff**:

```typescript
// BEFORE: 47 lines, wrong after DST
function isNYSEOpen(): boolean {
  const closeUTC = 21 * 60; // EST (UTC-5), not EDT (UTC-4)
  // ... 43 more lines of timezone + holiday + early-close logic
  // TODO: implement DST handling   <-- never done
}

// AFTER: 3 lines, externally attested, cryptographically verified
async function isNYSEOpen(): Promise<boolean> {
  const receipt = await oracle.status('XNYS');
  return receipt.status === 'OPEN';
}
```

The receipt is Ed25519-signed, includes `expires_at` (60s TTL), and encodes `OPEN | CLOSED | HALTED | UNKNOWN`. `UNKNOWN` is treated as `CLOSED` by contract.

**Why "just use UTC" doesn't solve this**: UTC offsets for exchange local times are not constant. NYSE is UTC-5 in winter and UTC-4 in summer. Maintaining DST-aware timezone logic per exchange — for 23 exchanges across 6 regions — is the same maintenance problem as maintaining a market calendar. The correct fix is to not maintain it yourself.

**Fix cost**: 0.001 USDC per oracle call. Incident cost: $47,000.

We're using [Headless Oracle](https://headlessoracle.com/v5/demo?mic=XNYS&utm_source=hn&utm_campaign=dst-postmortem) — free tier is 500 req/day. The MCP server works with Claude if you want to just check: `curl https://headlessoracle.com/v5/demo?mic=XNYS&utm_source=hn&utm_campaign=dst-postmortem`.

---

## Anticipated HN Comments + Drafted Responses

### Comment 1: "This is a monitoring problem. You should have had an alert when market hours didn't match your internal clock."

**Response**: That would require knowing that your internal clock was wrong in the first place. The system had no external reference to compare against — `isNYSEOpen()` returned a boolean with no provenance. You can alert on disagreement between two systems, but if one system is your own hardcoded logic, you've bootstrapped the alert from the same broken source. The fix isn't better alerting on stale state; it's eliminating the locally-computed state entirely and replacing it with an externally attested, cryptographically signed result that either verifies or doesn't.

### Comment 2: "You should just use an IANA timezone library like `luxon` or `date-fns-tz`. This is a solved problem."

**Response**: IANA timezone data handles the UTC offset correctly for any given moment — that's not the gap. The gaps are: (1) exchange-specific holiday calendars that change annually and are not in the IANA tz database; (2) early close schedules (Thanksgiving, pre-holiday sessions); (3) emergency halts and circuit breakers that are not calendar-predictable at all. You can get DST right with a timezone library and still execute on Good Friday or the day NYSE halts trading due to a technical failure. The oracle handles all three categories and attests to them cryptographically.

### Comment 3: "Why was the retry logic treating SESSION_CLOSED as a transient error? That's a separate bug."

**Response**: Correct — it's a separate bug, and it's in the action items. We had the dark pool rejection code mapped to the generic `VenueUnavailableError` catch block, which triggered retry-with-backoff. The `SESSION_CLOSED` code should have been in the non-retryable set alongside `INSUFFICIENT_FUNDS` and `INVALID_POSITION`. It wasn't. The pre-execution market state check would have prevented the first attempt entirely; the retry fix ensures we don't amplify any future slippage on the small remaining window of execution after an oracle call expires.

### Comment 4: "Ed25519 verification adds latency. At what point does the verification overhead become a problem?"

**Response**: Ed25519 verification on the consumer side takes approximately 0.1ms using Web Crypto. The network round-trip to fetch the receipt from a Cloudflare Worker at the nearest PoP is ~10–30ms at the 95th percentile. The verification itself is not the bottleneck. For high-frequency strategies where 30ms is meaningful, the receipt can be cached up to `expires_at` (60 seconds), so you're paying one round-trip per minute at most. The liquidation bot in this incident runs on a 30-second tick — one oracle call per tick is well within acceptable latency budget.

### Comment 5: "This seems like a lot of infrastructure for a problem you could solve with a simple NTP-synchronized cron that updates the market hours from an exchange API."

**Response**: The exchange APIs don't publish cryptographically signed real-time status. What you get from them is a REST response with no tamper-evidence, no TTL semantics, and no guaranteed encoding of circuit breaker state. For a system making financial decisions autonomously, "I called the exchange API" is a different trust model than "I have a signed, verifiable attestation." The oracle is the layer that converts an unsigned exchange API call into a verifiable artifact that can be passed between agents, logged for audit, and verified independently by any party — without trusting the operator.
