# Composio Listing — Headless Oracle

Reference content for the Headless Oracle tool submission to
[Composio](https://composio.dev). Composio is a unified toolkit for AI agents
that exposes 100+ tools via a single integration layer.

## Tool name

`headless_oracle`

## Short description

Signed, fail-closed market-state attestations for 28 global exchanges.
Pre-trade safety check for autonomous trading agents.

## Long description

Headless Oracle is the only cryptographically signed market-state attestation
service for autonomous trading agents. Every response is an Ed25519-signed
receipt answering "Is this exchange open right now?" for 28 global exchanges
covering equities, derivatives, and 24/7 crypto venues.

**Unique properties:**

- **Fail-closed by contract**: UNKNOWN always resolves to CLOSED. An agent
  consuming a Headless Oracle receipt has zero ambiguity about whether it is
  safe to execute.
- **60-second TTL**: every receipt expires 60 seconds after issue. Stale
  receipts cannot be replayed into a closed market.
- **Ed25519 offline verification**: agents verify receipts using the public
  key at `/.well-known/oracle-keys.json` without calling back to Headless
  Oracle on the verification path.
- **x402 autonomous payment**: $0.001 USDC per call on Base mainnet. Agents
  self-fund without human intervention.
- **Multi-Oracle Consensus v1.0.0**: Headless Oracle is the reference
  implementation of a published standard for market-state verification across
  independent oracle feeds (SEC/CFTC Technical Framework for Tokenized
  Collateral, November 2025).

## Category

Finance / Market Data

## Actions exposed via Composio

| Action | Description |
|---|---|
| `get_market_status` | Return a signed receipt for OPEN/CLOSED/HALTED/UNKNOWN for a single exchange (MIC). |
| `get_market_schedule` | Return next open and next close times in UTC for a single exchange. |
| `list_exchanges` | Return the full directory of 28 supported exchanges with timezone and MIC metadata. |
| `verify_receipt` | Verify an Ed25519 signature over a previously issued receipt. |
| `get_payment_options` | Return the upgrade ladder (sandbox → x402 → credits → Builder → Pro → Protocol). |

## Authentication

- **No auth**: sandbox endpoints, 3 free trial calls/day/IP
- **API key** (`X-Oracle-Key` header): free tier 500/day, paid tiers via Paddle
- **x402** (`X-Payment` header): autonomous per-request payment on Base mainnet

## Sample usage (Composio Python SDK)

```python
from composio import ComposioToolSet, App

toolset = ComposioToolSet()
tools = toolset.get_tools(apps=[App.HEADLESS_ORACLE])

response = toolset.execute_action(
    action="HEADLESS_ORACLE_GET_MARKET_STATUS",
    params={"mic": "XNYS"},
)

if response["status"] != "OPEN":
    raise RuntimeError(f"XNYS not open: {response['status']}")
```

## Links

- Website: https://headlessoracle.com
- MCP endpoint: https://headlessoracle.com/mcp
- OpenAPI 3.1 spec: https://headlessoracle.com/openapi.json
- Discovery: https://headlessoracle.com/.well-known/mcp/server-card.json
- Multi-Oracle Consensus spec: https://headlessoracle.com/docs/specifications/multi-oracle-consensus-v1
- Pricing: https://headlessoracle.com/pricing

## Regulatory alignment

- SEC/CFTC Technical Framework for Tokenized Collateral (November 2025)
- ESMA algorithmic trading audit requirements (February 2026)
- NIST cryptographic chains of custody for agent authorization (February 2026)
- Singapore MAS agentic AI governance framework (January 2026)
- SEBI algorithmic trading audit circular (February 2025)
