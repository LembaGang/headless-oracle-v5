# Day 49 Outreach Messages — April 2026

Short (<280 chars) and long (<200 words) variants for 10 distribution targets.
Each message references the target's specific repo/product/statement, includes
one concrete link, and has a clear ask. Written as a contributor solving a
problem, not a vendor promoting.

---

## 1. Korea Investment Securities (KIS Trading MCP)

**Short**:

> Building a pre-trade gate for your KIS Trading MCP — Headless Oracle returns Ed25519-signed OPEN/CLOSED/HALTED receipts for XKRX so your execution tools don't fire into a halted market. Integration guide: https://headlessoracle.com/docs/integrations/korea-investment-mcp — happy to open a PR.

**Long**:

> Hi — I maintain Headless Oracle, a signed market-state attestation service
> for 28 global exchanges including XKRX (Korea Exchange). I've been following
> KIS Trading MCP and noticed your execution tools don't have a native
> pre-trade market-state check. Under Korea's AI Framework Act (Dec 2024)
> high-impact AI including autonomous trading needs an audit trail, and a
> signed receipt from an independent oracle is clean audit-trail evidence.
>
> I drafted an integration guide showing how KIS MCP + Headless Oracle compose
> (agent queries HO for XKRX → OPEN → KIS executes; non-OPEN → halt).
> https://headlessoracle.com/docs/integrations/korea-investment-mcp
>
> Would you be open to a PR adding an optional `verify_market_state` hook to
> the KIS MCP so users can chain the two servers? Happy to do the work.

---

## 2. AgenticTrading (Open-Finance-Lab)

**Short**:

> Open-Finance-Lab/AgenticTrading uses MCP/A2A with DAG execution — perfect fit for a pre-trade verification node. Drafted an integration showing HO as a DAG precondition node before `execute_trade`: https://headlessoracle.com/docs/integrations/agentictrading-mcp — open to a PR?

**Long**:

> Saw AgenticTrading's DAG-based execution model and thought the
> `verify_market_state → risk_check → execute_trade` pattern would drop in
> cleanly as a precondition node. Headless Oracle gives you Ed25519-signed
> OPEN/CLOSED/HALTED/UNKNOWN receipts for 28 exchanges — fail-closed contract
> means UNKNOWN always resolves to CLOSED at the DAG level, so the risk path
> never silently approves an ambiguous state.
>
> Integration guide: https://headlessoracle.com/docs/integrations/agentictrading-mcp
>
> Would you accept a PR adding an example `verify_market_state_node` to the
> cookbook? No new dependencies — uses your existing MCP client layer.

---

## 3. TradingAgents (TauricResearch)

**Short**:

> TauricResearch/TradingAgents — the risk manager is the right place for a pre-trade market-state check. Already have a Market Gate PR open (#523). Drafted a focused integration doc: https://headlessoracle.com/docs/integrations/tradingagents-risk — updating the PR to match.

**Long**:

> Following up on PR #523 (Market Gate node for the risk management pipeline).
> I've written a focused integration guide that matches how the risk manager
> agent is structured and shows the fail-closed contract applied at the
> approval checkpoint:
> https://headlessoracle.com/docs/integrations/tradingagents-risk
>
> Happy to update #523 to reference this guide, or rewrite the PR description
> if you'd prefer a different integration shape. The core idea is that the
> risk manager already approves trades based on position/exposure — adding
> `get_market_status(mic)` before approval closes the one structural gap that
> no amount of reasoning across the other agents can fix. MCP-native, works
> with every frontier model including GPT-5 nano.

---

## 4. CrewAI

**Short**:

> CrewAI — published a Composio listing for Headless Oracle (signed market-state for 28 exchanges) and wanted to flag it for the CrewAI tools ecosystem. Existing integration guide: https://headlessoracle.com/docs/integrations/crewai — any interest in adding to the tools registry?

**Long**:

> Hi João — Headless Oracle has a published CrewAI integration
> (`headless-oracle-crewai` on PyPI) and I'd like to get it listed in the
> official CrewAI tools registry. It exposes `MarketStatusTool` and
> `BatchMarketStatusTool`, auto-provisions a sandbox key on first use (no
> signup friction), and returns Ed25519-signed receipts your crew agents can
> verify offline.
>
> Integration doc: https://headlessoracle.com/docs/integrations/crewai
>
> The use case is autonomous trading crews — TradingAgents-style multi-agent
> setups where a risk manager agent wants a cryptographic pre-trade gate
> before the trader executes. Happy to submit whatever form the registry
> accepts.

---

## 5. AutoGen (Microsoft)

**Short**:

> AutoGen v0.4 — Headless Oracle has an existing integration guide for AutoGen agents as a market-state verification tool in GroupChat flows: https://headlessoracle.com/docs/integrations/autogen — worth adding to the extensions gallery?

**Long**:

> Hi — Headless Oracle (signed market-state attestations for 28 exchanges)
> has a working AutoGen integration for use in GroupChat flows where a
> critic/verifier agent wants a cryptographic pre-trade check before the
> trader agent executes. Guide:
> https://headlessoracle.com/docs/integrations/autogen
>
> With AutoGen v0.4's actor model, the fail-closed contract (UNKNOWN → CLOSED)
> is a natural fit for a dedicated verification agent that either approves
> the trade message or redirects to halt. Would this fit in the extensions
> gallery, or is there a different path for third-party tool submissions?

---

## 6. Zerodha / OpenAlgo / Rajandran R

**Short**:

> Rajandran — built a Flask middleware for OpenAlgo that verifies XBOM/XNSE via Headless Oracle before routing orders. SEBI Feb 2025 algo circular wants 5-yr audit trails; signed receipts are clean evidence. https://headlessoracle.com/docs/integrations/openalgo-zerodha

**Long**:

> Hi Rajandran — I maintain Headless Oracle, a signed market-state
> attestation service that covers XBOM and XNSE with full Indian holiday
> calendars and DST handling via IANA timezones. I drafted a Flask middleware
> integration for OpenAlgo that verifies the market is actually open before
> routing orders through the unified broker layer, and attaches the signed
> receipt to the order audit log:
> https://headlessoracle.com/docs/integrations/openalgo-zerodha
>
> The SEBI February 2025 circular on algo trading mandates 5-year audit
> trails and unique Algo IDs. An Ed25519-signed third-party attestation that
> the exchange was open at the moment of decision is the cleanest audit
> evidence I can think of — independent, reproducible, machine-verifiable.
>
> Would you consider a PR adding this as an optional middleware to OpenAlgo?

---

## 7. Alpaca

**Short**:

> Alpaca team — Headless Oracle uses Alpaca as the US-only fallback in our real-time halt monitor (runs every minute). Would a short case-study / co-marketing piece be interesting? https://headlessoracle.com — currently 28 exchanges, Ed25519-signed receipts.

**Long**:

> Hi — Headless Oracle is a signed market-state attestation layer for
> autonomous trading agents (28 exchanges, Ed25519, fail-closed). We use
> Alpaca's market status API as the US-only fallback in our real-time halt
> monitor after Polygon.io — it runs every minute and feeds our REALTIME
> override layer for XNYS and XNAS.
>
> As the autonomous agent market grows (SEC/CFTC tokenized collateral
> guidance Nov 2025, NIST cryptographic chains of custody Feb 2026) there's
> a compounding story here about Alpaca as the retail execution layer and a
> signed verification layer sitting in front of it. Would a short case study
> or co-marketing piece be worth exploring? https://headlessoracle.com

---

## 8. TradingHours.com

**Short**:

> TradingHours.com covers 1,100+ exchanges — Headless Oracle (28 exchanges, signed Ed25519 receipts) is courting reference oracles for Multi-Oracle Consensus v1.0.0. Would you consider wrapping your feed in a signed envelope? https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1

**Long**:

> Hi — Headless Oracle recently published Multi-Oracle Consensus spec
> v1.0.0, the first standard for market-state verification across
> independent oracle feeds (aligned with SEC/CFTC tokenized collateral
> guidance, Nov 2025). The spec mandates at least 3 independent
> implementations, and we're courting additional reference oracles.
>
> TradingHours.com already has the deepest coverage in the space (1,100+
> exchanges). Would you consider wrapping your existing data in a
> SMA-compliant signed envelope (Ed25519 or ECDSA-secp256k1, attestation
> field set defined in the spec)? That would give your data an audit-grade
> cryptographic chain of custody that no competitor currently has.
>
> Spec: https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1
>
> Happy to help with the signing infrastructure if it's useful.

---

## 9. RedStone

**Short**:

> RedStone team — you publicly flagged the oracle weekend-gap problem. Headless Oracle published Multi-Oracle Consensus v1.0.0 that solves exactly this for market state. Would you consider a second reference implementation? https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1

**Long**:

> Hi — I saw the RedStone post flagging the oracle weekend-gap problem
> (agents trading on stale weekend data against stale feeds). We hit the
> same wall from the opposite direction and shipped Multi-Oracle Consensus
> spec v1.0.0 — the first published standard for market-state verification
> across independent oracle feeds. Fail-closed by contract (UNKNOWN →
> CLOSED), majority-with-fail-closed algorithm, minimum 3 independent feeds.
>
> Spec: https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1
>
> The spec is currently normative-but-unsatisfiable in production because
> Headless Oracle is the only compliant implementation. Would RedStone
> consider shipping a second reference implementation — even a narrow one
> covering the exchanges you already touch via your feeds? That would make
> the consensus algorithm satisfiable on-chain and give both of us a
> defensible position for the SEC/CFTC tokenized collateral market.

---

## 10. Polygon.io

**Short**:

> Polygon team — HO uses Polygon.io as the primary feed for the real-time halt monitor. Drafting a case study; also courting a second reference implementation of Multi-Oracle Consensus v1.0.0. https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1

**Long**:

> Hi — Headless Oracle uses Polygon.io's market status API as the primary
> feed for our real-time halt detection layer (runs every minute against
> XNYS and XNAS, writes to a REALTIME override). Two asks:
>
> 1. Would a short case study / co-marketing piece be interesting? HO is
>    growing as the pre-trade safety primitive for autonomous trading
>    agents — 65 weekly unique MCP clients, 10+ evaluator platforms, active
>    MCP registry listings.
>
> 2. We published Multi-Oracle Consensus spec v1.0.0 — a standard for
>    market-state verification across independent oracle feeds aligned
>    with SEC/CFTC tokenized collateral guidance (Nov 2025). The spec
>    requires at least 3 independent implementations. Would Polygon.io
>    consider wrapping your existing market-status data in a signed
>    attestation envelope (Ed25519 or ECDSA-secp256k1) as a second
>    reference implementation? Spec:
>    https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1

---

## Post-send discipline

After sending each message:

- Log target, channel, date, link into `docs/distribution/outreach-log.md`
- Do not re-ping before 7 calendar days
- If the response is a clarifying question, answer with ONE concrete link —
  not a wall of marketing copy
- If the response is "not now," add a `followup_at` date 60 days out and move on
- If the response is silence after 7 days, send one short follow-up only
