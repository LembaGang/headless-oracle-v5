# Ampersend + Headless Oracle: Composable Pre-Trade Verification

## Why Market State Must Come Before Spend Authorization

An agent requesting spend authorization for a trade on a closed exchange
is wasting compute, authorization bandwidth, and — if approved — creating
a pending order that will fail or queue unpredictably.

The composable pattern is:

1. **Headless Oracle** (Layer 1) → Is the exchange open? Signed receipt.
2. **Ampersend** (Layer 2) → Is the agent authorized to spend? Policy check.
3. **Execute** → Place the order with both proofs attached.

If Layer 1 returns anything other than `OPEN`, Layer 2 is never called.
This is fail-closed by design.

## The Two-Step Verification Pattern

```typescript
import { verify } from '@headlessoracle/verify';

// Step 1: Market State Gate (Headless Oracle)
const marketRes = await fetch('https://headlessoracle.com/v5/status?mic=XNYS', {
  headers: { 'X-Oracle-Key': process.env.ORACLE_KEY }
});
const { receipt } = await marketRes.json();

// Verify the Ed25519 signature
const verification = await verify(receipt);
if (!verification.ok) {
  throw new Error(`Receipt verification failed: ${verification.reason}`);
}
if (receipt.status !== 'OPEN') {
  console.log(`Market ${receipt.mic} is ${receipt.status} — halting`);
  return; // Do not proceed to spend authorization
}

// Step 2: Spend Authorization (Ampersend)
// Include the HO receipt signature as evidence that market state was verified
const authResponse = await ampersendClient.requestAuthorization({
  action: 'BUY',
  asset: 'AAPL',
  amount_usd: 10000,
  exchange: 'XNYS',
  evidence: {
    market_state: {
      provider: 'headlessoracle.com',
      mic: receipt.mic,
      status: receipt.status,
      verified_at: receipt.timestamp,
      expires_at: receipt.expires_at,
      signature: receipt.signature,  // Ed25519 proof
      verify_url: 'https://headlessoracle.com/v5/verify'
    }
  }
});

if (!authResponse.authorized) {
  console.log(`Spend not authorized: ${authResponse.reason}`);
  return;
}

// Step 3: Execute the trade with both proofs
await executeTrade({
  asset: 'AAPL',
  side: 'BUY',
  amount_usd: 10000,
  proofs: {
    market_state: receipt.signature,
    spend_auth: authResponse.token
  }
});
```

## Why the HO Receipt Is Useful as Ampersend Evidence

The `signature` field in the Headless Oracle receipt is an Ed25519
cryptographic proof that:

1. The exchange was verified OPEN at the `timestamp`
2. The receipt was issued by `headlessoracle.com` (verifiable via `/v5/keys`)
3. The receipt has not been tampered with

Including this signature in the Ampersend authorization request means the
spend authorization policy can incorporate market state as a condition:

- "Only authorize spend on exchanges verified OPEN within the last 60 seconds"
- "Require market state evidence for trades above $10,000"
- "Log the market state signature in the audit trail"

## MCP Integration

Both Headless Oracle and Ampersend support agent-to-agent communication.
In an MCP-based workflow:

```typescript
// MCP tool calls
const market = await mcp.callTool('get_market_status', { mic: 'XNYS' });
// market.status === 'OPEN' → proceed
// market.status !== 'OPEN' → halt (fail-closed)

// Pass market proof to Ampersend authorization
const auth = await ampersend.requestAuthorization({
  action: 'BUY',
  evidence: { market_signature: market.signature }
});
```

## Batch Verification

For multi-exchange portfolios, verify all markets before requesting
a single batch authorization:

```typescript
const batchRes = await fetch(
  'https://headlessoracle.com/v5/batch?mics=XNYS,XNAS,XLON',
  { headers: { 'X-Oracle-Key': process.env.ORACLE_KEY } }
);
const batch = await batchRes.json();

if (!batch.summary.safe_to_execute) {
  console.log(`Not all markets open: ${batch.summary.reason}`);
  return; // Do not proceed to spend authorization
}

// All markets verified OPEN — request batch spend authorization
const auth = await ampersend.requestAuthorization({
  action: 'REBALANCE',
  exchanges: ['XNYS', 'XNAS', 'XLON'],
  evidence: {
    market_states: batch.exchanges,
    batch_signature: batch.batch_signature
  }
});
```

## Links

- **Headless Oracle**: [headlessoracle.com](https://headlessoracle.com) — Layer 1: Market State Gate
- **Ampersend**: [github.com/edgeandnode/ampersend](https://github.com/edgeandnode/ampersend) — Layer 2: Spend Authorization
- **Pre-Trade Stack Spec**: [headlessoracle.com/docs/specifications/pre-trade-stack](https://headlessoracle.com/docs/specifications/pre-trade-stack) — Full 5-layer composable stack
- **x402 Integration**: [headlessoracle.com/docs/integrations/x402](https://headlessoracle.com/docs/integrations/x402) — Autonomous payment via USDC on Base
