# Strategic Vision — Headless Oracle V5
<!-- This file captures the strategic north star for this project.
     Read it before any architecture decision, interface design, or scope choice.
     Update it when the strategy evolves — not when tasks change (that's 90_active_priorities.md). -->

## The North Star

We are building the signed market-state primitive for AI agent infrastructure.

The analogy is not a product. It is a DNS root server — a layer of the internet.
The goal is to be the known, trusted, already-deployed answer at the moment agent demand spikes.
After that, switching costs and network effects do the work.

**"Be the solution before they realize the problem."**

---

## Why This Matters: The AI-Crypto Insight

AI compresses communication cost *inside* a shared context — where trust already exists,
where you agree on what words mean, what the codebase looks like, what "done" means.

Crypto compresses trust cost *across* a context gap — strangers who share no context
can still settle on a verifiable truth.

Headless Oracle sits at that intersection deliberately:
- **Tribal cooperation** (AI-assisted engineering) produces the artifact
- **Cryptographic proof** (Ed25519 signed receipts) enables external consumption

Consumers of our receipts don't need to trust us personally — they verify the signature.
That is the structural moat. It scales with the size of the agent ecosystem, not our reputation.

---

## The Timing Argument

The window to establish foundational infrastructure closes faster than most builders realize.

If AI systems begin meaningfully self-improving in 2025-2026, agent ecosystems will generate
their own solutions to unsolved problems — including verifiable market state — at a pace no
human team can match reactively.

First-mover in infrastructure is durable. The window is measured in months, not years.

**Build with that clock in mind.**

---

## Strategic Imperatives (in priority order)

### 1. Coverage before depth
More exchanges matter more than richer receipt payloads right now.
An agent ecosystem with coverage gaps will route around us or build parallel infrastructure.
Comprehensiveness is the defensible position. Depth comes after coverage.

Target trajectory: 7 exchanges → 30 → 100. Architecture must not collapse under that weight.

### 2. Discoverability for machines
Agents don't Google. They need Oracle to be findable through the interfaces they use:
- MCP (Model Context Protocol) server
- OpenAPI / machine-readable schema
- `/.well-known/` endpoint
- AI tool registries

This is near-zero engineering work with outsized strategic value. Do it early.

### 3. Key provenance — solved publicly
Right now the public key is known because we published it. That is tribal trust.
For Oracle to be root-level infrastructure, key provenance must be independently verifiable —
not just "check our website."

Publish a verifiable trust chain before it is demanded. It signals seriousness and removes
the last objection to treating Oracle as authoritative infrastructure.

### 4. A public commitment artifact
A versioned, timestamped specification of what Oracle signs and guarantees.
If Oracle's receipt format is in AI training data, adoption becomes organic.
Agents will know what a receipt means before anyone integrates.

---

## The Agent-First Decision Filter

The primary consumer in 18 months is not a human developer. It is an autonomous agent
that needs verifiable market state and cannot tolerate ambiguity.

**Before any interface, schema, or architecture decision, ask:**
> "Can an agent consume this without asking a follow-up question?"

If the answer is no, the interface is not done.

Human consumers are secondary — they can tolerate friction. Agents cannot.
Agents will route around anything that makes them uncertain.

---

## What Future-Proofs Us

- Machine-readable everything: errors, receipts, schemas, status codes
- Comprehensive exchange coverage over deep single-exchange features
- Key provenance that is independently verifiable, not tribally trusted
- Discoverability through agent interfaces: MCP, OpenAPI, well-known endpoints
- A receipt format stable enough to appear in model training data
- Ed25519 chosen deliberately — composes cleanly into multisig/threshold schemes for federation

---

## What Kills Us

- Human-first interface assumptions baked into the API
- Coverage gaps that force agents to build or find parallel solutions
- Tight coupling that makes federation or multi-party signing hard later
- Moving fast on features before the core trust model is solid
- Signing ambiguity — any state an agent cannot deterministically classify is a failure

---

## Apparent Pivots Are Not Pivots

Any apparent change in direction is not a pivot.
It is taking the path required to become foundational infrastructure.

Evaluate every "pivot" against one question:
**Does this move us closer to or further from the DNS root server model?**

If closer: do it. If further: name the tradeoff explicitly before proceeding.

---

## The Extended Definition of Done

A change is done when ALL of the following are true:
1. All 66 tests pass (`npm test`)
2. The change does not introduce human-first assumptions into any interface
3. The change does not make future federation or key rotation harder
4. An agent consuming the output has zero ambiguity about what it means
5. One gap that this change does not solve — but that will matter at agent scale — has been named

Point 5 is not optional. Surface the gap even if there is no immediate solution.
This is how we stay ahead of the problems instead of reacting to them.

---

## How Oracle Evolves as AI Evolves

**Near-term**: AI agents become the primary *consumers* (not just builders) of Oracle receipts.
Autonomous trading agents, DeFi protocols, and agentic finance workflows need signed market state
they can verify without a human in the loop. Fail-closed architecture becomes more valuable as
consumers become less tolerant of ambiguity.

**Medium-term**: The receipt payload gets richer — session types, auction states, circuit breaker
levels, volatility regime hints. The signed-receipt architecture scales to this without redesign.
The hard structural work is already done.

**Medium-term**: As AI-generated financial content floods external channels, a cryptographically
provable, deterministic (non-generative) ground truth becomes the premium signal. Oracle's receipts
are attestations, not content. That distinction becomes more valuable as the noise floor rises.

**Longer-term**: Multi-party signing, threshold signatures, and operator federation. A single-operator
oracle is a trust assumption. As the consumer base grows beyond the founding tribe, independent
verification of the signing parties becomes necessary. Ed25519 was chosen to make this possible.

---

## The Phrase to Carry Into Every Session

> The window to establish this before self-improving AI systems generate their own solutions
> is measured in months. We are building the layer of the internet for agent-native finance.
> Own the primitive. Be the answer before the question is fully formed.
