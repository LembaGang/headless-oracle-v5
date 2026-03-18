# Twitter/X thread: DST post-mortem

**Format**: 6-tweet thread
**Account**: @headlessoracle (or founder @mbeenz)
**When to post**: March 9–10, morning ET (day after or two days after DST transition)

---

**Tweet 1** (hook):

$47,000 loss.
47 minutes after NYSE close.
One DST transition.

Post-mortem thread 🧵

---

**Tweet 2** (what happened):

March 8, 2026. US clocks spring forward.

NYSE close: 21:00 UTC → 20:00 UTC.

Our liquidation bot didn't know.

At 20:47 UTC it woke up, checked market state, got back `true`, and initiated a liquidation on a tokenized treasury position.

The market had been closed for 47 minutes.

---

**Tweet 3** (root cause):

The function had a hardcoded UTC close time of `21:00` — correct for EST (UTC-5 winter), wrong for EDT (UTC-4 summer).

It had worked correctly every day for 8 months.

On March 8 it silently broke.

There was even a `TODO: implement DST handling` comment.

It was never implemented.

---

**Tweet 4** (the diff):

```
// BEFORE: 47 lines
const closeUTC = 21 * 60; // EST, not EDT
// + 43 lines of holiday/early-close logic
// TODO: implement DST handling

// AFTER: 3 lines
const receipt = await oracle.status('XNYS');
return receipt.status === 'OPEN';
```

The receipt is Ed25519-signed.
It includes a 60-second TTL.
It handles DST, holidays, early closes, and circuit breakers.

---

**Tweet 5** (the math):

47 lines of timezone logic vs 3 lines + one API call.

The homegrown logic: wrong twice a year, missing Good Friday, missing half-days, no circuit breaker handling, no TTL, no cryptographic proof.

The oracle call: 0.001 USDC.

The incident: $47,000.

---

**Tweet 6** (lesson + CTA):

If you have any hardcoded UTC offsets in your execution logic — `21:00`, `14:30`, `09:30` — check them now.

Check whether they're EST or EDT.
Check whether they'll still be correct on March 29 (UK/EU DST) and November 1 (US fall back).

Or delete the timezone logic entirely.

Free tier: headlessoracle.com/v5/demo

---

**Thread notes for poster**:

- Pin a reply with the full post-mortem link once it's published
- Reply to any quote-tweets from quant/DeFi accounts personally
- If the thread gets traction, quote-tweet with: "The five checks that would have prevented this: [link to prevention section of post-mortem]"
- Relevant accounts to tag in reply: @ondofinance @aaveaave @compoundfinance (as examples of protocols where this matters)
- Do NOT tag competitor oracle products — let the technical content speak
