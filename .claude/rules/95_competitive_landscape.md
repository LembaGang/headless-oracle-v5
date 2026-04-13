# Competitive Landscape — Headless Oracle V5

Honest assessment of who could replace us and what we ship that they don't. Updated Day 47 (2026-04-13). Revisit this file any time a competitor ships something adjacent — stale competitive analysis is worse than none.

The short version: **no direct competitor ships signed, fail-closed market-state attestations for 28 exchanges today.** Several could. The window is 12–24 months.

---

## Tier 1 — Biggest threat: could ship this in months

### Chainlink (~$6.5B market cap)
- **What they do**: Price feeds, NAV (net asset value), Proof of Reserve, CCIP cross-chain messaging.
- **What they don't do**: Market state. No signed "is XNYS open right now?" primitive.
- **Why they're the biggest threat**: Institutional relationships they already have — Swift, DTCC, Euroclear, ANZ, SBI. If any tokenized-collateral customer asks Chainlink for a market-state feed to satisfy the SEC/CFTC Technical Framework for Tokenized Collateral (Nov 2025), Chainlink can build it in months. They have the oracle network, the signing infrastructure, the trust, and the distribution.
- **What we ship that they don't (today)**:
  - 28 exchanges with ISO 10383 MIC coverage
  - Fail-closed UNKNOWN → CLOSED contract
  - 60-second TTL on every receipt
  - Ed25519 signatures agents can verify offline
  - x402 native payment path
  - A published multi-oracle consensus standard (v1.0.0) that names the architecture any entrant now has to match
- **Defensive move**: Be the established, cited reference before Chainlink realises the market exists. The multi-oracle consensus spec is explicitly designed to make any new entrant — including Chainlink — adopt *our* architectural vocabulary.

### Pyth Network (~$250M market cap)
- **What they do**: Sub-second price feeds, 120+ first-party publishers (Jane Street, Virtu, Two Sigma, etc.), 500+ feeds, already ships an MCP server.
- **What they don't do**: Market state. No signed "open/closed/halted" primitive. No circuit-breaker handling. No fail-closed contract.
- **Why they're a threat**: They already have an MCP server — distribution surface is built. Adding a `get_market_status` tool is a weekend of engineering. Their first-party publisher model gives them exchange-adjacent data nobody else has.
- **What we ship that they don't**: Fail-closed semantics, 60s receipt TTL, cryptographic chain of custody for agent authorization (the NIST Feb 2026 requirement), and coverage of exchanges where Pyth has no publisher.
- **Defensive move**: Establish "market state" as an architecturally distinct layer from "price feeds" in every comms surface we own. Price and state are not the same primitive — state requires fail-closed, price does not.

---

## Tier 2 — Flagged the problem, hasn't productized

### RedStone
- **What they do**: Modular oracle network, on-demand price feeds.
- **Signal**: A RedStone co-founder publicly flagged the "weekend gap" problem — agents trading on stale weekend data against stale oracle prices. This is exactly the failure mode our fail-closed contract prevents.
- **Status**: Has **not** productized a market-state solution. Identified the problem out loud; hasn't shipped the fix.
- **Opportunity**: Courting RedStone to wrap their feeds in an SMA-compliant signed envelope would give us a second independent implementation of the multi-oracle consensus spec, which we currently need to make the standard satisfiable in production.

---

## Tier 3 — Adjacent but different trust models

### Mycelia Signal
- **What it is**: Signed price attestations delivered over Lightning Network + x402.
- **Overlap**: x402 payment surface, signed attestations.
- **Difference**: Bitcoin-native, price-focused, not market-state. Different trust assumptions (Lightning channels vs. Ed25519 verification).
- **Threat level**: Low-medium. They've validated x402 + signed attestation as a pattern but stayed in their lane (price).

### Prova
- **What it is**: Hardware-backed TEE (trusted execution environment) attestations for AI agents.
- **Difference**: Fundamentally different trust model — hardware trust (Intel SGX / AMD SEV) vs. cryptographic trust (Ed25519 over published public keys). Both are valid for different threat models.
- **Threat level**: Low. TEE-backed attestation is complementary, not competitive. An agent could require both: Prova TEE attestation that *the agent is running unmodified code* + HO signed receipt that *the market is actually open*.

### EODHD MCP server
- **What it is**: 77 tools including exchange trading hours.
- **Difference**: Schedule-only. **No cryptographic verification, no real-time state, no fail-closed, no halt handling, no DST correctness story.** An agent using EODHD for market hours would sail straight into a circuit-breaker halt or phantom DST hour.
- **Threat level**: Low. They've covered "what are the hours" but not "is the market actually open right now, and can I prove it." Useful existence proof that the category is in demand.

---

## Tier 4 — Complementary, not competitive

### Korean / Indian MCP servers
Korea Investment Securities, Zerodha, OpenAlgo, and several others ship brokerage / execution-focused MCP servers. These are trading and order-placement tools. **None of them verify market state before executing.** An agent using any of them today is exposed to exactly the failure modes our pre-trade gate prevents.

**Positioning**: Integration partners, not competitors. The pitch is "our pre-trade verification gate + your execution tool = safe agentic trading" as one MCP config. See Day 47 priorities 2–4.

---

## Headless Oracle differentiation (what we ship that none of the above do)

1. **Market STATE, not price** — a structurally different primitive that requires fail-closed semantics
2. **Fail-closed UNKNOWN → CLOSED contract** — signed, published, testable, enforced at 4 tiers
3. **28 exchanges across 6 regions** — ISO 10383 MIC codes, not ad-hoc names
4. **60-second receipt TTL** — signed into the payload; consumers cannot stretch it
5. **Ed25519 offline verification** — agents verify receipts without calling back to us
6. **x402 autonomous payment path** — agents self-fund on Base mainnet, no human in the loop
7. **Multi-Oracle Consensus spec v1.0.0** — we authored the standard for market-state verification across independent feeds; HO is `reference_oracles[0]`
8. **SEC/CFTC tokenized collateral alignment** — surfaced in OpenAPI `x-regulatory-alignment`, server-card, and multi-oracle guide
9. **Model-agnostic MCP tool descriptions** — parseable by GPT-5 nano ($0.05/MTok) through Mythos ($125/MTok); no tier dependency

---

## Window of opportunity

**12–24 months** before any incumbent fills this gap. The structural advantages that extend that window:

- **Standards authorship**: we published the first multi-oracle consensus spec. Any incumbent who ships market-state has to either cite us or fork the standard — both outcomes advantage us.
- **Distribution compounding**: 65 weekly unique MCP clients, 5+ registry listings, 10+ evaluator platforms, 4 framework integrations already shipped. Late entrants start from zero.
- **Fail-closed as a brand**: we are the only oracle whose public contract is "return UNKNOWN as CLOSED." Any competitor who ships later has to either match this contract (and cite us) or explicitly choose a different trust model (and explain why).
- **Receipt format stability**: every day the receipt schema stays unchanged is a day it moves closer to being frozen in model training data.

**Closing moves** (prioritized in `90_active_priorities.md`):
- Asia-Pacific distribution sprint (Korea, India, China)
- Standards body formalization (AAIF / Linux Foundation submission research)
- Regulator-venue presence (Singapore FinTech Festival 2026)
- Two more independent implementations of the multi-oracle consensus spec

---

## Review trigger

Update this file whenever any of the following happens:
- A Tier 1 or Tier 2 entity ships anything adjacent to market state
- A new MCP server launches with signed attestations of any kind
- Any of the Asian broker MCP servers adds a "market status" tool
- A standards body publishes competing vocabulary for market-state verification
- Regulatory guidance explicitly names a competitor as a reference implementation
