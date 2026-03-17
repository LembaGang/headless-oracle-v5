# SMA Protocol v1.0 — Known Implementations

This document lists known implementations of the SMA Protocol v1.0. To add an
implementation, open a pull request with a new row in the appropriate table.

---

## Oracle Operators (Receipt Producers)

| Name | URL | Exchanges | Transport | Status |
|---|---|---|---|---|
| Headless Oracle | [headlessoracle.com](https://headlessoracle.com) | XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE | REST + MCP | Reference implementation — live |

### Headless Oracle

The reference implementation of SMA v1.0.

- **REST API**: `GET /v5/demo` (public), `GET /v5/status` (authenticated), `GET /v5/batch` (multi-exchange)
- **MCP server**: `POST /mcp` — tools: `get_market_status`, `get_market_schedule`, `list_exchanges`
- **Key discovery**: `GET /.well-known/oracle-keys.json`
- **OpenAPI spec**: `GET /openapi.json`
- **23 exchanges**: NYSE, NASDAQ, LSE, JPX, Euronext Paris, HKEX, SGX
- **Fail-closed**: 4-tier architecture — KV override → schedule → UNKNOWN → CRITICAL_FAILURE

---

## Consumer SDKs (Receipt Verifiers)

| Name | Language | Package | Dependencies | Status |
|---|---|---|---|---|
| @headlessoracle/verify | TypeScript / JavaScript | [npm](https://www.npmjs.com/package/@headlessoracle/verify) | Zero production deps (Web Crypto API) | Live — v1.0.0 |
| headless-oracle | Python | [PyPI: headless-oracle](https://pypi.org/project/headless-oracle/) | PyNaCl, httpx | Live — v0.1.0 |

### @headlessoracle/verify (JavaScript / TypeScript)

Zero-dependency Ed25519 receipt verification for Node.js 18+, Cloudflare Workers, and
modern browsers. Uses `crypto.subtle` (Web Crypto API) — no native modules, no build
dependencies.

```js
import { verify } from '@headlessoracle/verify';

const receipt = await fetch('https://headlessoracle.com/v5/demo?mic=XNYS').then(r => r.json());
const result = await verify(receipt);

if (!result.valid) {
  // result.reason: MISSING_FIELDS | EXPIRED | UNKNOWN_KEY | INVALID_SIGNATURE | KEY_FETCH_FAILED | INVALID_KEY_FORMAT
  throw new Error(`Receipt invalid: ${result.reason}`);
}
```

The `publicKey` option skips the key registry network call — required for high-throughput
agent use:

```js
const result = await verify(receipt, { publicKey: '03dc2799...' });
```

Source: [github.com/LembaGang/headless-oracle-verify](https://github.com/LembaGang/headless-oracle-verify)

### headless-oracle (Python)

Python SDK providing `verify()`, `OracleClient`, LangChain `MarketStatusTool`, and
CrewAI `MarketStatusTool`.

```python
from headless_oracle import verify, OracleClient

# Standalone verification
result = verify(receipt)
if not result.valid:
    raise ValueError(f"Receipt invalid: {result.reason}")

# HTTP client
client = OracleClient(api_key="your_key")
receipt = client.get_status("XNYS")
```

LangChain integration:

```python
from headless_oracle.integrations.langchain import MarketStatusTool

tool = MarketStatusTool()  # drops into any LangChain agent
```

---

## Agent Frameworks with SMA Integration

| Framework | Integration | Notes |
|---|---|---|
| LangChain | `headless_oracle.integrations.langchain.MarketStatusTool` | Python, via headless-oracle PyPI package |
| CrewAI | `headless_oracle.integrations.crewai.MarketStatusTool` | Python, via headless-oracle PyPI package |
| LangGraph | [safe-trading-agent-template](https://github.com/LembaGang/safe-trading-agent-template) | TypeScript template with 4-step Oracle execution gate |
| Claude Desktop / Cursor | MCP server at `https://headlessoracle.com/mcp` | Native tool calling via MCP protocol |

---

## Adding Your Implementation

To add an implementation to this list:

1. Ensure it conforms to SMA v1.0 — run the conformance tests in [CONFORMANCE.md](./CONFORMANCE.md)
2. Open a pull request adding a row to the appropriate table above
3. Include: name, URL or package link, language/platform, dependency summary, and status
