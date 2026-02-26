# Show HN: Headless Oracle — Signed Market-Status API for AI Agents

Three draft variants for the March 10 Hacker News launch. Pick one or blend.

---

## Variant 1: Technical-first (lead with crypto/signing)

```
Show HN: Headless Oracle – Ed25519-signed market-status API for AI agents

I built an API that answers one question: is this stock exchange open right now?

Every response is a signed receipt — an Ed25519 signature over a canonical JSON payload including receipt_id, issued_at, expires_at (60s TTL), MIC code, status, and source. Agents verify the signature before acting. An unverified receipt has zero attestation weight.

Status values: OPEN, CLOSED, HALTED, UNKNOWN. UNKNOWN is fail-closed by contract — treat it as CLOSED, halt all execution.

Seven exchanges: NYSE, NASDAQ, London, Tokyo, Paris, Hong Kong, Singapore. DST is handled via IANA timezone names — no hardcoded UTC offsets.

Motivation: tokenised equity protocols (RWA/DeFi) need to gate liquidation bots on market state. Hardcoded offsets break twice a year at DST transitions. Signed receipts mean the consuming agent doesn't have to trust the API operator — it verifies.

MCP server available for Claude/Cursor integrations. Consumer SDK: @headlessoracle/verify (zero prod deps, Web Crypto only).

Live demo: https://headlessoracle.com/v5/demo?mic=XNYS
Free during beta: https://headlessoracle.com
```

**Word count:** ~170

---

## Variant 2: Problem-first (lead with "agents trade 24/7 but markets don't")

```
Show HN: Headless Oracle – AI agents run 24/7 but markets don't

Built this for autonomous trading agents and DeFi liquidation bots that need to know if a stock exchange is currently open before executing.

The problem: markets have DST transitions, public holidays, lunch breaks (Tokyo, Hong Kong), and unexpected circuit-breaker halts. Agents built on hardcoded UTC offsets or stale calendar data get this wrong — sometimes expensively. The Stream Finance incident ($93M loss, November 2025) was caused by hardcoded collateral assumptions. DST is the same class of bug.

Headless Oracle returns Ed25519-signed receipts with a 60-second TTL. Status: OPEN, CLOSED, HALTED, or UNKNOWN. UNKNOWN is always treated as CLOSED — the API is explicitly fail-closed.

Covers 7 exchanges (NYSE, NASDAQ, London, Tokyo, Paris, Hong Kong, Singapore). DST handled automatically via IANA timezone names. KV-backed circuit breaker for emergency halts.

MCP server for agent tool integrations. OpenAPI spec at /openapi.json. Consumer SDK: @headlessoracle/verify.

Live demo: https://headlessoracle.com/v5/demo?mic=XNYS
Site: https://headlessoracle.com | Free during beta
```

**Word count:** ~185

---

## Variant 3: Short and punchy (under 100 words, just the facts)

```
Show HN: Headless Oracle – Signed market-status API for AI agents

Is NYSE open right now? This API answers that — for 7 global exchanges — with an Ed25519-signed receipt agents can verify independently.

Status: OPEN / CLOSED / HALTED / UNKNOWN. Fail-closed: UNKNOWN means halt.

Handles DST, public holidays, lunch breaks (Tokyo/HK), circuit breakers. MCP server included. 60s receipt TTL.

Demo: https://headlessoracle.com/v5/demo?mic=XNYS
Free beta: https://headlessoracle.com
```

**Word count:** ~70

---

## Notes on HN tone

- HN readers will hit the demo link first. Make sure it returns a clean JSON receipt.
- The signing angle is unusual — most APIs don't produce cryptographically verifiable outputs. Lead with that if using Variant 1.
- Variant 2's problem setup is the strongest narrative for a DeFi/RWA audience but may land better on a Monday than a Tuesday.
- Variant 3 is safest if the launch is competitive (many submissions that day). Short posts get read; long posts get skimmed.
- Do NOT post before 10am ET — HN morning traffic peaks 9–11am ET. Tuesday 10am ET (March 10) is the target.
- Respond to every early comment within the first hour. HN ranks by velocity of engagement.
