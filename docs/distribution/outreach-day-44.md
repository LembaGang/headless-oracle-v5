# Outreach Drafts — Day 44 (2026-04-10)

## Ampersend GitHub Comment (Draft)

**Target**: edgeandnode/ampersend — Issues or Discussions
**Context**: Their A2A tweet positioning Ampersend as agent spend control.
We already have PR #11 on ampersend-examples showing x402 integration.

**POST INSTRUCTIONS**: Post as a GitHub Discussion (not Issue) on
edgeandnode/ampersend or ampersend repo. If no Discussions enabled,
comment on the most relevant open issue about architecture or
integrations. Post at 15:00-16:00 SAST (09:00-10:00 ET) for US
business hours.

---

Hey team,

Saw your A2A positioning tweet — the framing of Ampersend as the spend
control layer for autonomous agents is exactly right. We've been thinking
about the same problem from the market-state side.

We built [Headless Oracle](https://headlessoracle.com) — Ed25519-signed
market-state attestations for 28 global exchanges. It answers one question
before any trade: "Is this exchange open right now?" Fail-closed: if we
don't know, the answer is CLOSED.

The composable pattern we see emerging:

1. **Market State Verification** (Headless Oracle) → Is the exchange open?
   Ed25519-signed receipt, 60-second TTL. If not OPEN → halt.
2. **Spend Authorization** (Ampersend) → Is the agent authorized to
   execute this trade? Policy-bound limits, human-in-the-loop.
3. **Execute** → Place the order with both proofs in the audit trail.

Market state is naturally Layer 1 because there's no point authorizing
spend on a closed exchange. The HO receipt signature can serve as evidence
in the Ampersend authorization request — cryptographic proof that market
state was verified before the agent requested spend authority.

We already have an example in your ampersend-examples repo (PR #11) showing
the x402 payment flow. Happy to build a more complete two-step verification
example showing HO → Ampersend → execute if that's useful.

Interested in your thoughts on the Layer 1 → Layer 2 handoff
pattern.

---

**Tone check**: Written as a fellow builder, not a vendor. References
their positioning positively. Proposes collaboration, not competition.
Includes concrete code reference (PR #11). Ends with a question.

## VeroQ Follow-Up (Draft)

**HOLD — wait for FinRL reply before sending. If no reply by April 16,
send as cold outreach.**

**Target**: VeroQ — Twitter DM or GitHub
**Context**: Signal verification as Layer 3 in the pre-trade stack.

---

We've been building pre-trade infrastructure for autonomous trading agents
and noticed VeroQ's claim verification work. We published a composable
pre-trade verification stack spec that positions signal verification
(like VeroQ) as Layer 3:

1. Market state gate (Headless Oracle) — is the exchange open?
2. Spend authorization (Ampersend) — is the agent authorized?
3. Signal verification (VeroQ) — is the signal accurate?
4. Payment execution (x402)
5. Trade execution

The spec is at: https://headlessoracle.com/docs/specifications/pre-trade-stack

Would you be interested in being referenced as the Layer 3 reference
implementation? We mention VeroQ in the spec already — happy to add
more detail if you'd like.

---
