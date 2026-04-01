# Headless Oracle — Pre-Trade Market Safety Gate

Use this skill whenever you need to verify that a stock exchange is open before executing a trade, placing an order, or acting on market data.

## When to use this skill

- Before any financial execution decision that depends on market hours
- When an agent needs cryptographic proof that a market was checked
- When detecting circuit breaker halts, holidays, or early closes
- When working across multiple exchanges in different timezones

## Critical safety rules

1. **UNKNOWN = CLOSED.** If the oracle returns UNKNOWN, halt all execution immediately.
2. **Check expires_at.** Receipts expire 60 seconds after issuance. Reject stale receipts.
3. **HALTED overrides OPEN.** Treat HALTED the same as CLOSED.
4. **Verify the signature** for production decisions. Use `@headlessoracle/verify` (npm) or the Go SDK.

## MCP tools (preferred method)

Connect Agent Zero to Headless Oracle via MCP:
- Endpoint: `https://headlessoracle.com/mcp`
- Protocol: `2024-11-05`
- No API key required for sandbox (200 free calls)

Available tools:

| Tool | What it does | Required param |
|------|-------------|----------------|
| `get_market_status` | Returns signed receipt: OPEN / CLOSED / HALTED / UNKNOWN | `mic` (e.g. "XNYS") |
| `get_market_schedule` | Next open/close times in UTC + lunch breaks | `mic` |
| `list_exchanges` | All 28 supported exchanges with timezones | none |
| `verify_receipt` | Verify an Ed25519-signed receipt in-worker | `receipt` (JSON object) |

## REST API (fallback)

```
# Demo (no auth):
GET https://headlessoracle.com/v5/demo?mic=XNYS

# Authenticated:
GET https://headlessoracle.com/v5/status?mic=XNYS
X-Oracle-Key: your_api_key

# Batch:
GET https://headlessoracle.com/v5/batch?mics=XNYS,XNAS,XLON
X-Oracle-Key: your_api_key
```

## x402 micropayment (agent self-payment)

Agents can pay $0.001 USDC per request on Base mainnet without human intervention:
1. Call `/v5/status` with no key → receive 402 with payment details
2. Submit USDC transfer to the address in the `x402` response object
3. Re-call with `X-Payment: <tx_hash>` header

## Supported exchanges (MIC codes)

Americas: XNYS, XNAS, XBSP  
Europe: XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST  
Middle East / Africa: XSAU, XDFM, XJSE  
Asia: XJPX, XHKG, XSES, XSHG, XSHE, XKRX, XBOM, XNSE, XASX, XNZE  
Derivatives/Crypto: XCBT, XNYM, XCBO, XCOI, XBIN

## Standard pre-trade gate pattern

```python
import requests

def safe_to_execute(mic: str, api_key: str) -> bool:
    resp = requests.get(
        f"https://headlessoracle.com/v5/status?mic={mic}",
        headers={"X-Oracle-Key": api_key},
        timeout=5,
    )
    if resp.status_code != 200:
        return False  # fail closed
    receipt = resp.json().get("receipt", resp.json())
    if receipt.get("status") != "OPEN":
        return False  # CLOSED / HALTED / UNKNOWN all halt execution
    # Optionally verify Ed25519 signature here
    return True
```

## Discovery and conformance

- OpenAPI spec: `GET https://headlessoracle.com/openapi.json`
- Public key: `GET https://headlessoracle.com/.well-known/oracle-keys.json`
- Health check: `GET https://headlessoracle.com/v5/health`
- APTS compliance: `GET https://headlessoracle.com/v5/compliance`
- Skill file: `https://headlessoracle.com/skill.md`
- ERC-8004 registry: `8453:38413`
