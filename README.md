# Headless Oracle

![MCP-native](https://img.shields.io/badge/MCP-native-6366f1?style=flat-square)
![x402-payable](https://img.shields.io/badge/x402-payable-10b981?style=flat-square)
![Ed25519-signed](https://img.shields.io/badge/Ed25519-signed-f59e0b?style=flat-square)
![28 exchanges](https://img.shields.io/badge/exchanges-28-0ea5e9?style=flat-square)
[![headless-oracle-v5 MCP server](https://glama.ai/mcp/servers/LembaGang/headless-oracle-v5/badges/card.svg)](https://glama.ai/mcp/servers/LembaGang/headless-oracle-v5)

Headless Oracle provides cryptographically signed market status receipts for 28 global exchanges — equities, derivatives (CME, NYMEX, Cboe), and 24/7 crypto (Coinbase, Binance). Every response is Ed25519-signed with a 60-second TTL so autonomous agents can verify market state without trusting the operator. The architecture is fail-closed: `UNKNOWN` always means `CLOSED`. Handles DST transitions, exchange holidays, half-days, lunch breaks, and real-time circuit breaker overrides automatically.

---

## MCP Endpoint

```
https://headlessoracle.com/mcp
```

Protocol: MCP `2024-11-05` over Streamable HTTP (POST). No auth required for MCP tools.

### Configure in Claude Desktop / Cursor / Windsurf

```json
{
  "mcpServers": {
    "headless-oracle": {
      "url": "https://headlessoracle.com/mcp"
    }
  }
}
```

---

## MCP Tools

| Tool | Description |
|---|---|
| `list_exchanges` | List all 28 supported exchanges with MIC codes, names, timezones, and `mic_type` |
| `get_market_status` | Returns a signed receipt: `OPEN`, `CLOSED`, `HALTED`, or `UNKNOWN` for a given MIC |
| `get_market_schedule` | Next open/close times in UTC, holiday flags, half-day details, lunch break windows |
| `verify_receipt` | Verify an Ed25519-signed receipt in-worker — returns `{ valid, reason, expired }` |

**Batch execution gate**: `GET /v5/batch?mics=XNYS,XLON,XJPX` returns per-exchange signed receipts plus a `summary.safe_to_execute` boolean — `true` only when all exchanges are `OPEN` and none are `HALTED` or `UNKNOWN`.

---

## Quick Start

**MCP (ask your AI):**
```
Is NYSE open right now?
```

**curl (public demo — no key):**
```bash
curl "https://headlessoracle.com/v5/demo?mic=XNYS"
```

**curl (schedule):**
```bash
curl "https://headlessoracle.com/v5/schedule?mic=XLON"
```

**JavaScript (verify a receipt):**
```bash
npm install @headlessoracle/verify
```
```javascript
import { verify } from '@headlessoracle/verify';

const res = await fetch('https://headlessoracle.com/v5/demo?mic=XNYS');
const receipt = await res.json();

const result = await verify(receipt);
if (!result.valid || receipt.status !== 'OPEN') {
  throw new Error('Market not open or receipt invalid — halting');
}
```

**Python:**
```bash
pip install headless-oracle
```
```python
from headless_oracle import OracleClient, verify

client = OracleClient()
receipt = client.get_status('XNYS')

if not verify(receipt) or receipt['status'] != 'OPEN':
    raise RuntimeError('Market not open — halting execution')
```

---

## Fail-Closed Contract

| Status | Agent action |
|---|---|
| `OPEN` | Safe to proceed |
| `CLOSED` | Halt — normal schedule |
| `HALTED` | Halt — circuit breaker active |
| `UNKNOWN` | Halt — treat as CLOSED, do not proceed |

Every receipt expires after 60 seconds (`expires_at`). Re-fetch before acting on a cached receipt.

---

## Supported Exchanges (28)

| Region | MICs |
|---|---|
| Americas | `XNYS` `XNAS` `XBSP` |
| Europe | `XLON` `XPAR` `XSWX` `XMIL` `XHEL` `XSTO` `XIST` |
| Middle East / Africa | `XSAU` `XDFM` `XJSE` |
| Asia | `XSHG` `XSHE` `XHKG` `XJPX` `XKRX` `XBOM` `XNSE` `XSES` `XASX` `XNZE` |
| Derivatives (CME/Cboe) | `XCBT` `XNYM` `XCBO` |
| Crypto (24/7) | `XCOI` `XBIN` |

MIC codes follow ISO 10383. `XCOI` (Coinbase) and `XBIN` (Binance) are community convention identifiers.

---

## All Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /v5/demo?mic=` | None | Signed receipt (demo mode) |
| `GET /v5/status?mic=` | API key | Signed receipt (live mode) |
| `GET /v5/batch?mics=` | API key | Parallel signed receipts + `safe_to_execute` summary |
| `GET /v5/schedule?mic=` | None | Next open/close, holidays, lunch breaks |
| `GET /v5/exchanges` | None | Full exchange directory |
| `GET /v5/sandbox` | None | Instant sandbox key (24h, 100 calls) |
| `GET /v5/health` | None | Signed liveness probe |
| `POST /mcp` | None | MCP Streamable HTTP |
| `GET /openapi.json` | None | OpenAPI 3.1 spec |
| `GET /.well-known/oracle-keys.json` | None | Ed25519 public key + lifecycle |
| `GET /.well-known/agent.json` | None | A2A Agent Card |

Full API reference: **[headlessoracle.com/docs](https://headlessoracle.com/docs)**

---

## x402 Autonomous Payments

Agents can pay for API access autonomously using USDC on Base mainnet — no human in the loop.

```
POST /v5/x402/mint
```

Send a Base mainnet USDC transaction hash to mint a persistent API key. Pricing: $99 USDC → `builder` plan (50K calls/day), $299 USDC → `pro` plan (200K calls/day).

Discovery document: `/.well-known/x402.json`

---

## Verification SDKs

| Language | Package | Source |
|---|---|---|
| JavaScript / TypeScript | `npm install @headlessoracle/verify` | [github.com/LembaGang/headless-oracle-verify](https://github.com/LembaGang/headless-oracle-verify) |
| Python | `pip install headless-oracle` | [github.com/LembaGang/headless-oracle-python](https://github.com/LembaGang/headless-oracle-python) |
| Go | `go get github.com/LembaGang/headless-oracle-go` | [github.com/LembaGang/headless-oracle-go](https://github.com/LembaGang/headless-oracle-go) |

All SDKs use the public key from `/.well-known/oracle-keys.json` and verify Ed25519 signatures locally — no trust in the operator required.

---

## Standards

- **SMA Protocol v1.0** — [github.com/LembaGang/sma-protocol](https://github.com/LembaGang/sma-protocol)
- **Agent Pre-Trade Safety Standard** — [github.com/LembaGang/agent-pretrade-safety-standard](https://github.com/LembaGang/agent-pretrade-safety-standard)
