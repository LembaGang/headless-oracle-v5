# Using Headless Oracle with Claude Managed Agents

<!-- Living document. Last updated: 2026-04-08 -->

## Why

Claude Managed Agents run autonomously for hours — executing trades,
managing portfolios, processing financial data. Before any market
operation, the agent must verify the exchange is open. A stale
datetime check or hardcoded UTC offset breaks silently during DST
transitions, holidays, and circuit breaker halts.

Headless Oracle provides Ed25519-signed market-state attestations
that the agent can verify independently. UNKNOWN = CLOSED. The agent
halts execution on uncertainty — fail-closed by design.

## Quick Start

### Pattern 1: MCP Tool (recommended)

The simplest path. The Managed Agent calls `get_market_status` as a
tool. Add `headless-oracle-mcp` as an MCP server in the agent
configuration:

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "headless-oracle-mcp"]
    }
  }
}
```

Or use the remote HTTP transport directly (no npm install):

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp"
    }
  }
}
```

**System prompt snippet** — add this to the agent's instructions:

```
Before executing any trade or market order, call the get_market_status
tool with the target exchange MIC code (e.g. XNYS for NYSE, XNAS for
NASDAQ, XLON for London). If status is not OPEN, do not proceed. Log
the receipt_id for audit purposes.

If status is UNKNOWN or HALTED, treat it as CLOSED and halt all
execution. Do not retry — wait for the next scheduled check.
```

Available MCP tools:

| Tool | Purpose |
|---|---|
| `get_market_status` | Pre-trade verification gate. Returns signed receipt. |
| `get_market_schedule` | Next open/close times, holidays, lunch breaks. |
| `list_exchanges` | All 28 supported exchanges with MIC codes. |
| `verify_receipt` | Verify Ed25519 signature on a receipt from another agent. |
| `get_payment_options` | Upgrade paths when hitting rate limits. |

### Pattern 2: REST API with receipt verification

For agents that use HTTP tools instead of MCP. The agent fetches
a signed receipt from the REST API and verifies the Ed25519 signature
before acting.

```javascript
// Step 1: Fetch the signed receipt
const res = await fetch('https://headlessoracle.com/v5/status?mic=XNYS', {
  headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
});
const data = await res.json();

// Step 2: Check status before proceeding
if (data.status !== 'OPEN') {
  return { action: 'HALT', reason: `Exchange ${data.mic} is ${data.status}` };
}

// Step 3: Check receipt freshness (60-second TTL)
if (new Date(data.expires_at) <= new Date()) {
  return { action: 'HALT', reason: 'Receipt expired — re-fetch before acting' };
}

// Step 4: Proceed with trade
// Log data.receipt_id for audit trail
console.log(`Market verified: ${data.mic} is ${data.status}, receipt ${data.receipt_id}`);
```

For full Ed25519 signature verification, use the `@headlessoracle/verify` SDK:

```javascript
import { verify } from '@headlessoracle/verify';

const result = await verify(data);
if (!result.valid) {
  return { action: 'HALT', reason: `Signature verification failed: ${result.reason}` };
}
```

### Pattern 3: Multi-exchange batch check

For agents operating across markets (arbitrage, cross-listed securities,
global portfolio rebalancing). A single request checks all exchanges:

```javascript
const res = await fetch('https://headlessoracle.com/v5/batch?mics=XNYS,XLON,XHKG', {
  headers: { 'Authorization': 'Bearer YOUR_API_KEY' }
});
const data = await res.json();

// all_open is true only when every exchange is OPEN
if (!data.summary.all_open) {
  const closed = Object.entries(data.exchanges)
    .filter(([_, r]) => r.status !== 'OPEN')
    .map(([mic, r]) => `${mic}: ${r.status}`);
  return { action: 'HALT', reason: `Exchanges not open: ${closed.join(', ')}` };
}

// safe_to_execute checks all OPEN + none HALTED/UNKNOWN
if (!data.summary.safe_to_execute) {
  return { action: 'HALT', reason: data.summary.reason };
}

// correlation_id links all receipts in this batch for audit
console.log(`Batch verified: ${data.correlation_id}`);
```

Key fields in the batch response:
- `summary.all_open` — `true` only if every exchange is OPEN
- `summary.safe_to_execute` — `true` only if all OPEN, none HALTED/UNKNOWN
- `summary.reason` — human-readable explanation when `safe_to_execute` is false
- `correlation_id` — unique ID linking all receipts in this batch
- `exchanges` — map of MIC to individual signed receipt

### Pattern 4: Historical verification

For agents that need to validate past decisions or audit trails.
Reconstructs what the schedule status was at a specific past timestamp:

```javascript
const res = await fetch(
  'https://headlessoracle.com/v5/historical?mic=XNYS&at=2026-04-07T14:30:00Z'
);
const data = await res.json();

// data.computed_status: OPEN, CLOSED, or UNKNOWN
// data.reasoning: explains why (local time, weekend/holiday/hours)
// data.dst_proximity: notes if near a DST transition
```

Note: `/v5/historical` returns unsigned computed status (not a signed
receipt). Use it for audit reconstruction, not real-time decisions.

## Getting an API Key

Three paths, ordered by friction:

| Method | Friction | Limit | How |
|---|---|---|---|
| Instant key | Zero | 500 calls/day | `POST /v5/keys/instant` — returns key immediately |
| Email key | Low | 500 calls/day | `POST /v5/keys/request` with `email` field |
| x402 payment | Zero (for agents) | Unlimited | $0.001 USDC per call on Base, no key needed |

For Managed Agents, the **instant key** is the best starting path.
The agent can provision its own key programmatically:

```javascript
const keyRes = await fetch('https://headlessoracle.com/v5/keys/instant', {
  method: 'POST'
});
const { api_key } = await keyRes.json();
// Store api_key securely; use in subsequent requests
```

For higher volume, use x402 per-request payment (the agent pays $0.001
USDC per call with no signup) or upgrade to Builder ($99/month,
50,000 calls/day).

## The Fail-Closed Contract

Every consumer of Headless Oracle receipts must follow this contract:

| Status | Action | Why |
|---|---|---|
| `OPEN` | Proceed | Exchange is in session |
| `CLOSED` | Halt | Exchange is outside trading hours |
| `HALTED` | Halt | Circuit breaker or manual override active |
| `UNKNOWN` | **Halt** | System cannot determine state — this is the critical one |
| Expired receipt (TTL > 60s) | Re-fetch | Do not act on stale data |
| Network error | Halt | Fail-closed: silence = stop |
| Signature invalid | Halt | Receipt may be tampered |

**UNKNOWN = CLOSED is the foundational guarantee.** When the oracle
cannot determine market state (missing holiday data, signing error,
system failure), it returns UNKNOWN rather than guessing. Agents must
treat UNKNOWN identically to CLOSED.

## Audit Trail

Every signed receipt includes a `receipt_id` (UUID v4). The agent
should log this ID alongside every trade decision for compliance:

```
Trade decision log:
  timestamp: 2026-04-08T14:30:00Z
  exchange: XNYS
  receipt_id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  status: OPEN
  action: EXECUTE_ORDER
```

Headless Oracle provides two audit endpoints:

- **`GET /v5/audit/digest?date=2026-04-08`** — daily attestation digest
  with SHA-256 Merkle root over all receipt IDs issued that day. Proves
  a specific receipt existed without revealing all receipts.

- **`GET /v5/audit/chain`** — hash chain of daily digests (default 7
  days, max 30). Each day chains to the previous via
  `previous_day_merkle_root`. The `chain_intact` flag verifies no
  gaps or tampering.

This maps to:
- **ESMA** pre-trade transparency requirements (algorithms must log
  third-party data sources)
- **NIST** agent authorization framework ("cryptographic chains of
  custody" for agent decisions)
- **Singapore MAS** agentic AI governance (audit trail for autonomous
  financial operations)

## Exchanges Covered

### Americas
| MIC | Exchange | Notes |
|---|---|---|
| XNYS | New York Stock Exchange | |
| XNAS | NASDAQ | |
| XBSP | B3 (Sao Paulo) | |
| XCBT | CME CBOT (overnight) | Globex session |
| XNYM | CME NYMEX (overnight) | Globex session |
| XCBO | Cboe Options | |

### Europe
| MIC | Exchange | Notes |
|---|---|---|
| XLON | London Stock Exchange | |
| XPAR | Euronext Paris | |
| XSWX | SIX Swiss Exchange | |
| XMIL | Borsa Italiana | |
| XHEL | Nasdaq Helsinki | |
| XSTO | Nasdaq Stockholm | |
| XIST | Borsa Istanbul | |

### Asia-Pacific
| MIC | Exchange | Notes |
|---|---|---|
| XJPX | Japan Exchange Group | Lunch break 11:30-12:30 JST |
| XHKG | Hong Kong Exchange | Lunch break 12:00-13:00 HKT |
| XSES | Singapore Exchange | |
| XASX | Australian Securities Exchange | |
| XBOM | BSE India | |
| XNSE | National Stock Exchange of India | |
| XSHG | Shanghai Stock Exchange | Lunch break 11:30-13:00 CST |
| XSHE | Shenzhen Stock Exchange | Lunch break 11:30-13:00 CST |
| XKRX | Korea Exchange | |
| XNZE | New Zealand Exchange | |

### Middle East & Africa
| MIC | Exchange | Notes |
|---|---|---|
| XSAU | Saudi Exchange (Tadawul) | Weekend: Fri-Sat |
| XDFM | Dubai Financial Market | Weekend: Fri-Sat |
| XJSE | Johannesburg Stock Exchange | |

### 24/7 Crypto
| MIC | Exchange | Notes |
|---|---|---|
| XCOI | Coinbase | Always OPEN |
| XBIN | Binance | Always OPEN |

## Links

- **MCP server**: `npx headless-oracle-mcp`
- **REST API**: https://headlessoracle.com/v5/
- **Full documentation**: https://headlessoracle.com/llms-full.txt
- **OpenAPI spec**: https://headlessoracle.com/openapi.json
- **Agent briefing**: https://headlessoracle.com/AGENTS.md
- **Verify SDK (JS)**: `npm install @headlessoracle/verify`
- **GitHub**: https://github.com/LembaGang/headless-oracle-v5
