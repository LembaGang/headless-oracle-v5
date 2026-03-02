# Prepared Answers — HN Launch and Protocol Conversations

These are written to be copied directly or lightly adapted for HN comments, DMs, and email.

---

## "How quickly do circuit breaker halts propagate?"

Manual override within 5 minutes during market hours via the `ORACLE_OVERRIDES` KV namespace.
The override propagates globally in under 1 second (Cloudflare KV eventual consistency — 300+
edge locations). Automated halt detection from exchange data feeds is on the roadmap. For the
beta, we monitor major exchanges during trading hours and can push an override immediately.

---

## "Why not just use a timezone library?"

pytz and IANA handle DST transitions correctly. They don't handle:

- Exchange-specific holidays (67 across 7 venues in 2026)
- Early close days (NYSE closes at 1pm ET on Christmas Eve, not 4pm)
- Lunch breaks (Tokyo 11:30–12:30, Hong Kong 12:00–13:00 every trading day — ~490 sessions/year)
- Emergency circuit breaker halts

A timezone library solves 80% of the problem. The other 20% is where protocols lose money.
We handle ~1,300 schedule edge cases per year that a timezone library returns the wrong answer for.

---

## "What stops you from serving wrong data?"

The signature isn't about trusting us — it's about trusting the receipt. Every response has a
60-second expiry, a timestamp, and a public key ID. Your bot verifies the signature locally before
acting on it. If verification fails, the bot halts — that's the fail-closed design.

You're not trusting the oracle. You're trusting the math. The private key never leaves Cloudflare's
secret store. Even if our API is compromised, an attacker can't forge a valid signed receipt without
the private key.

---

## "I could build this in a weekend."

Here's the spec: return OPEN/CLOSED/HALTED/UNKNOWN for 7 exchanges. Handle DST transitions for
US, UK/EU, and Japan (no DST). Handle 67 exchange-specific holidays for 2026 and 2027. Handle
early close days. Handle lunch breaks. Sign every response with Ed25519. Expire every receipt in
60 seconds. Fail closed on any error — UNKNOWN, not OPEN. Make it discoverable by AI agents via
MCP, llms.txt, and OpenAPI. Have 160+ tests covering all of this.

We have all of that. Happy to compare implementations.

---

## "What if someone clones this?"

Good — the ecosystem needs more independent market status oracles. Our fail-closed architecture
is designed so bots can verify against multiple oracles. More independent oracles means more robust
verification. We welcome forks and competition. The signed-receipt format is designed to compose:
a 2-of-3 multi-oracle threshold scheme requires each oracle independently sign, and a consumer
verifies all three. Ed25519 was chosen to make this composable.

---

## "What about on-chain verification?"

Currently off-chain only — an on-chain keeper calls the API and posts the receipt hash or raw
receipt. On-chain Ed25519 verification contracts for Ethereum/Base/Arbitrum are on the roadmap
for Q2–Q3 2026. The receipt format is already designed for on-chain compatibility: fixed-length
fields, hex-encoded signature, deterministic canonical payload. The hard work is done.

---

## "What's your uptime guarantee?"

During beta: no SLA. We're deployed on Cloudflare Workers across 300+ cities with automatic
failover. Historical uptime since deployment has been 100%. Protocol tier ($500–$5K/month)
includes a custom SLA negotiated directly.

The fail-closed design means even if we go down, your bot halts safely — it receives UNKNOWN and
stops, rather than trading blind on stale data. Downtime is detectable and safe; silent wrong
answers are not.

---

## "Why Ed25519 and not ECDSA/secp256k1?"

Ed25519 is faster to verify, has a simpler implementation (less surface area for bugs), is
deterministic (no nonce reuse vulnerability like ECDSA), and is natively supported by the Web
Crypto API in Node.js 18+, Cloudflare Workers, and modern browsers — no Wasm polyfills needed.

secp256k1 is standard in Ethereum but requires heavy libraries in non-blockchain environments.
We chose the algorithm that's safest and fastest for the broadest range of agents, not just
on-chain ones. When on-chain verification contracts are ready, we'll support both.
