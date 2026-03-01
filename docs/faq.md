# Headless Oracle — Prepared FAQ Answers

Use these for HN launch comments, direct messages, and email responses.
Each answer is written to be copied directly or lightly adapted.

---

## "Why not just check the exchange website / use a free API?"

Exchange websites are for humans. They don't return machine-readable structured data, they have no SLA, no cryptographic proof you checked, and they go down during high-traffic events (exactly when you need them most).

Free market data APIs tell you prices. They don't tell you whether the exchange is actually accepting orders right now — circuit breakers, lunch breaks, and emergency halts are not reflected in price feeds. Headless Oracle's status is schedule-based + operator-overridable via KV, so it can reflect unscheduled halts within seconds.

---

## "Why Ed25519 signatures? What does signing actually give me?"

Two things: tamper-proof receipts and multi-agent forwarding.

Tamper-proof: if you log a receipt and audit it later, the signature proves the Oracle said OPEN at that timestamp — not CLOSED, not UNKNOWN. You can't reconstruct a valid receipt retroactively without the private key.

Multi-agent: if Agent A fetches a receipt and forwards it to Agent B, Agent B can verify the signature independently without hitting the API again. The proof travels with the data. This is the pattern that makes agent pipelines auditable.

---

## "Isn't this just a fancy cron job? I can build this in a weekend."

Building a market hours checker is a weekend project. Building one that:
- Handles DST transitions for 7 exchanges (US, UK, EU, Japan, HK, Singapore) correctly
- Tracks 67 holiday closures per year, year-keyed, with fail-closed guards
- Handles half-days (Black Friday close at 13:00, Christmas Eve at 12:30 London)
- Handles lunch breaks (Tokyo 11:30–12:30, HK 12:00–13:00) — ~490 trading days/year
- Signs every response with Ed25519 so consumers can verify offline
- Returns UNKNOWN (not OPEN) when it doesn't know — never fails open
- Has a circuit breaker override system that propagates in <1s without redeployment
- Runs on Cloudflare Workers globally with no cold starts

…is not a weekend project. And if you're building agents that execute financial decisions, the signing and fail-closed contract are the parts that matter for compliance.

---

## "What happens if Headless Oracle goes down?"

Tier 3: if the signing key is unreachable, the Oracle returns a 500 with `CRITICAL_FAILURE` and `status: UNKNOWN`. Consumers are contractually required to treat UNKNOWN as CLOSED and halt execution.

The architecture is designed so Oracle going down causes conservatism, not permissiveness. You stop trading; you don't trade on stale data.

For extra resilience: poll `/v5/health` before each batch. A signed `status: OK` health receipt confirms signing infrastructure is alive. If health returns CRITICAL_FAILURE, you know Oracle is down before you trust any market receipts.

---

## "Is this a financial data provider? Do I need to worry about regulations?"

Headless Oracle operates under the Lowe v. SEC (1985) publisher exclusion — the same doctrine that covers Bloomberg, Reuters, and financial data publishers generally. We provide market state information publicly derived from exchange schedules. We are not a broker-dealer, investment advisor, or fiduciary.

Our terms explicitly cap liability at fees paid in the 12 months preceding any claim and disclaim any trading advisory relationship. Full text: headlessoracle.com/terms.html.

---

## "What's the SLA / uptime guarantee?"

Cloudflare Workers has 99.99% uptime SLA globally. Because the Oracle runs on Workers (no origin server), there's no single point of failure. During Cloudflare outages, the fail-closed architecture means consumers receive UNKNOWN and halt — they don't receive stale OPEN receipts.

We don't publish a formal SLA for the current beta tier. Paid tier SLA terms are in development.

---

## "How is this different from Polygon.io / Alpaca / other trading APIs?"

Those are market data and brokerage APIs. They tell you prices, order books, and let you place trades. Headless Oracle does none of that. We tell you one thing: is this exchange accepting orders right now?

We are a safety layer, not a data layer. The correct mental model is: check Headless Oracle before calling your trading API, not instead of it.

---

## "Can I self-host this?"

The core logic (schedule computation, holiday lists, signing) is in a single TypeScript file and runs on Cloudflare Workers. You could fork it. But:

1. You'd need your own Ed25519 keypair — receipts signed by your key are not interoperable with consumers trusting the Oracle public key.
2. You'd need to maintain holiday lists annually (all 7 exchanges, including lunar calendar venues).
3. You'd lose the KV circuit breaker system — the ability to propagate HALTED receipts without redeployment.

Self-hosting makes sense for private deployments. For the network effect (agents that trust the Oracle key don't need per-operator configuration), the shared hosted service is more useful.

---

## "Why only 7 exchanges?"

7 covers the exchanges that matter most for global equities trading: NYSE, NASDAQ (US), LSE (UK), JPX (Japan), Euronext Paris (EU), HKEX (Hong Kong), SGX (Singapore). These 7 represent the bulk of global market capitalisation.

Coverage will expand. Each exchange requires manual holiday calendar maintenance — HKEX and SGX use lunar/Islamic/Hindu calendars that require human verification each year. We're adding exchanges as fast as we can do that verification correctly.

---

## "What MIC codes do you support?"

`XNYS` (NYSE), `XNAS` (NASDAQ), `XLON` (LSE), `XJPX` (Tokyo), `XPAR` (Paris), `XHKG` (Hong Kong), `XSES` (Singapore). Full directory: `GET /v5/exchanges`.

---

## "How do I verify a receipt without your SDK?"

Canonical payload: take all receipt fields except `signature`, sort keys alphabetically, `JSON.stringify` with no whitespace (no spaces, no line breaks), UTF-8 encode. Verify with the Ed25519 public key from `/.well-known/oracle-keys.json`.

Python: `nacl.signing.VerifyKey(bytes.fromhex(public_key)).verify(canonical.encode('utf-8'), bytes.fromhex(receipt['signature']))`. JS: `crypto.subtle.verify` with `Ed25519` algorithm. Full examples in `/llms.txt`.

---

## "What does receipt_mode mean?"

`demo` — came from `/v5/demo` (no API key required). Good for testing and dashboards. `live` — came from `/v5/status`, `/v5/batch`, or an MCP tool call. This field is signed, so it's tamper-proof: an adversary can't strip `receipt_mode: 'demo'` from a receipt and replay it as a live one.

---

## "Is there a free tier?"

`/v5/demo` is permanently free and unauthenticated. It returns a signed receipt (receipt_mode: 'demo') for any of the 7 exchanges. Use it for dashboards, testing, and integration verification.

`/v5/status`, `/v5/batch`, and the MCP tools (live mode) require an API key — sign up at headlessoracle.com.

---

## "Do you store my queries / trading data?"

No. We log: API key identifier (hashed), request timestamp, MIC code, HTTP status code. We do not store portfolio data, position data, trade intent, or wallet addresses. Full policy: headlessoracle.com/privacy.html.

---

*Last updated: March 2026. Update before HN launch if pricing / tier details change.*
