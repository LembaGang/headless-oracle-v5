# The Composable Pre-Trade Verification Stack for Autonomous Trading Agents

**Version**: 1.0
**Status**: Draft Specification
**Authors**: LembaGang
**License**: Apache 2.0

## Abstract

Autonomous trading agents are increasingly capable of discovering markets,
generating signals, and executing trades without human intervention. But
capability without verification is liability. An agent that executes a trade
on a closed exchange, without spend authorization, or based on an unverified
signal, creates financial exposure that no amount of post-hoc analysis can
recover.

This specification defines a composable pre-trade verification stack — five
independent layers that an autonomous agent MUST pass through before executing
any financial transaction. Each layer is independently verifiable, fail-closed
by default, and designed for machine consumption.

## The Problem: Agents With Money and No Safety Rails

Consider an autonomous trading agent with:
- Access to exchange APIs
- A funded wallet or brokerage account
- A signal generation model
- No pre-trade verification

This agent will:
1. Execute trades during market closures (exchanges reject or queue orders)
2. Execute trades during circuit breaker halts (orders fail or fill at extreme prices)
3. Execute trades based on stale or fabricated signals (model hallucination)
4. Exceed spend limits without human awareness (compounding losses)
5. Execute payments without cryptographic proof (no audit trail)

Each failure mode is independently dangerous. Together, they represent a
systemic risk to any organization deploying autonomous financial agents.

## The Stack

The pre-trade verification stack consists of five layers, executed in strict
order. If any layer fails, all subsequent layers are skipped and the trade
is halted.

```
┌─────────────────────────────────────────────────┐
│  Layer 5: Trade Execution                       │
│  Place the order with verified state,           │
│  authorized spend, verified signal, and         │
│  confirmed payment.                             │
├─────────────────────────────────────────────────┤
│  Layer 4: Payment (x402 or equivalent)          │
│  Execute payment with cryptographic proof.      │
├─────────────────────────────────────────────────┤
│  Layer 3: Signal Verification (VeroQ or equiv.) │
│  Is the trading signal factually accurate?      │
├─────────────────────────────────────────────────┤
│  Layer 2: Spend Authorization (Ampersend or eq.)│
│  Is the agent authorized to make this trade?    │
├─────────────────────────────────────────────────┤
│  Layer 1: Market State Gate (Headless Oracle)   │
│  Is the exchange open? Ed25519-signed,          │
│  fail-closed. CLOSED/UNKNOWN → halt.            │
└─────────────────────────────────────────────────┘
```

### Layer 1 — Market State Gate (Headless Oracle)

**Question**: Is the target exchange currently open for trading?

**Protocol**: Ed25519-signed market-state receipt with 60-second TTL.

**Possible states**: OPEN, CLOSED, HALTED, UNKNOWN

**Fail-closed rule**: Any state other than OPEN halts the entire stack.
UNKNOWN MUST be treated as CLOSED. HALTED MUST be treated as CLOSED.

**Why this is Layer 1**: Every subsequent layer depends on the market being
open. You cannot authorize spend on a halted exchange. You cannot verify a
signal against a closed market. You cannot execute a payment for a trade
that cannot be placed. Market state is the foundation.

**Implementation**:
- MCP: `get_market_status` tool via `npx headless-oracle-mcp`
- REST: `GET https://headlessoracle.com/v5/status?mic=XNYS`
- x402: $0.001 USDC per call on Base mainnet (no API key required)
- Coverage: 28 global exchanges (equities, derivatives, 24/7 crypto)
- Verification: `@headlessoracle/verify` (npm) or `headless-oracle` (PyPI)

**Receipt schema**:
```json
{
  "mic": "XNYS",
  "status": "OPEN",
  "timestamp": "2026-04-10T14:30:00.000Z",
  "expires_at": "2026-04-10T14:31:00.000Z",
  "issuer": "headlessoracle.com",
  "key_id": "key_2026_v1",
  "receipt_mode": "live",
  "schema_version": "v5.0",
  "signature": "<hex-encoded Ed25519 signature>"
}
```

### Layer 2 — Spend Authorization (Ampersend or equivalent)

**Question**: Is the agent authorized to spend this amount on this trade?

**Protocol**: Policy-bound authorization check. Human-in-the-loop for
high-value actions. Programmatic approval for routine operations within
pre-defined limits.

**Why this follows Layer 1**: There is no point authorizing a $50,000
equity purchase if the exchange is closed. The market state receipt from
Layer 1 can be included as evidence in the authorization request, proving
that the market was verified open at the time of the spend request.

**Composable pattern**: The Headless Oracle receipt (Layer 1) serves as
input evidence to the spend authorization request (Layer 2). The
`signature` field in the receipt is cryptographic proof that market state
was verified.

**Reference**: [Ampersend](https://github.com/edgeandnode/ampersend) —
agent spend control and policy enforcement.

### Layer 3 — Signal Verification (VeroQ or equivalent)

**Question**: Is the trading signal factually accurate?

**Protocol**: Claim verification against live market data. Cross-reference
the signal's assertions (price targets, volume thresholds, indicator values)
against independent data sources.

**Why this follows Layer 2**: An agent should not verify signals for trades
it is not authorized to make. Authorization (Layer 2) gates the
computational cost of signal verification.

**Reference**: [VeroQ](https://veroq.ai) — AI claim verification.

### Layer 4 — Payment (x402 or equivalent)

**Question**: Can the payment be executed with cryptographic proof?

**Protocol**: On-chain payment with verifiable receipt. The x402 protocol
enables autonomous USDC payments on Base with transaction-level proof.

**Why this follows Layer 3**: Payment should only occur after the signal
is verified. Paying for a trade based on an unverified signal is equivalent
to paying for a product you haven't inspected.

**Reference**: [x402 Protocol](https://www.x402.org/) — HTTP 402-based
autonomous payments.

### Layer 5 — Trade Execution

**Question**: Execute the trade with all verification proofs attached.

**Protocol**: Place the order on the target exchange with:
- Market state receipt (Layer 1) as pre-condition proof
- Spend authorization token (Layer 2) as authority proof
- Signal verification result (Layer 3) as accuracy proof
- Payment receipt (Layer 4) as settlement proof

**Audit trail**: All four proofs are independently verifiable after the
fact. An auditor can reconstruct whether each layer was satisfied at the
time of execution.

## Why Layer 1 Must Be Fail-Closed

The market state gate is the foundation of the stack because it is the
only layer where the failure mode is deterministic and externally
verifiable.

1. **Markets have objective state.** An exchange is either open or closed.
   This is not a judgment call — it is a fact derived from published
   schedules, holidays, and real-time halt feeds.

2. **All other layers depend on market state.** Spend authorization for a
   closed market is meaningless. Signal verification against a halted
   exchange is wasted computation. Payment for an unexecutable trade is
   a loss.

3. **Fail-closed prevents the worst outcomes.** An agent that halts on
   UNKNOWN loses opportunity cost. An agent that proceeds on UNKNOWN
   risks capital loss, regulatory violation, and audit failure.

4. **60-second TTL forces re-verification.** Markets can halt mid-session
   (circuit breakers, technical outages). A 60-second TTL ensures the
   agent re-checks market state before every execution window.

## Integration Pattern

### MCP (Recommended for Agent Frameworks)

```typescript
// Layer 1: Market State Gate
const marketResult = await mcpClient.callTool('get_market_status', { mic: 'XNYS' });
if (marketResult.status !== 'OPEN') {
  return { action: 'HALT', reason: `Market ${marketResult.status}` };
}

// Layer 2: Spend Authorization (Ampersend or equivalent)
const authResult = await spendAuth.checkAuthorization({
  action: 'BUY',
  amount: 50000,
  currency: 'USD',
  evidence: { market_receipt: marketResult.signature }
});
if (!authResult.authorized) {
  return { action: 'HALT', reason: 'Spend not authorized' };
}

// Layer 3: Signal Verification (VeroQ or equivalent)
const signalResult = await verifySignal(tradingSignal);
if (!signalResult.verified) {
  return { action: 'HALT', reason: 'Signal unverified' };
}

// Layer 4: Payment
const paymentResult = await executePayment(order);

// Layer 5: Trade Execution
const tradeResult = await executeTrade(order, {
  market_proof: marketResult.signature,
  auth_token: authResult.token,
  signal_proof: signalResult.proof,
  payment_proof: paymentResult.txHash
});
```

### REST

```bash
# Layer 1: Check market state
RECEIPT=$(curl -s -H "X-Oracle-Key: $KEY" \
  "https://headlessoracle.com/v5/status?mic=XNYS")

STATUS=$(echo $RECEIPT | jq -r '.receipt.status')
if [ "$STATUS" != "OPEN" ]; then
  echo "HALT: Market is $STATUS"
  exit 1
fi

# Layer 2+: Continue with spend auth, signal verification, payment, execution
```

## Reference Implementations

| Layer | Reference Implementation | Protocol |
|-------|--------------------------|----------|
| 1 — Market State | [Headless Oracle](https://headlessoracle.com) | Ed25519 signed receipts, MCP, REST, x402 |
| 2 — Spend Auth | [Ampersend](https://github.com/edgeandnode/ampersend) | A2A, policy-bound authorization |
| 3 — Signal Verification | [VeroQ](https://veroq.ai) | AI claim verification |
| 4 — Payment | [x402 Protocol](https://www.x402.org/) | HTTP 402, on-chain USDC |
| 5 — Execution | Application-specific | Exchange APIs, DeFi protocols |

## Machine-Readable Discovery

The stack definition is available as structured JSON at:
`GET https://headlessoracle.com/v5/pre-trade-stack`

Agents can discover and inspect the stack programmatically.

## Versioning

This specification follows semantic versioning. The current version is 1.0.
Breaking changes increment the major version. Additive changes increment
the minor version.

## License

Apache 2.0. This specification is open for adoption, extension, and
implementation by any party.
