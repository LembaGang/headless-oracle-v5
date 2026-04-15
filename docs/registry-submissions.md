# MCP Registry Submission Copy — April 2026

Paste-ready listings for 7 MCP registries. All descriptions reflect the April
2026 semantic upgrade: model-agnostic positioning, SEC/CFTC tokenized collateral
alignment, 28 exchanges, Multi-Oracle Consensus v1.0.0 authorship, regional
exchange names for Asian discoverability.

---

## 1. Official MCP Registry (modelcontextprotocol/servers)

**Name**: Headless Oracle
**Short description**: Signed, fail-closed market-state attestations for 28 global exchanges. Pre-trade safety check for autonomous trading agents.
**Long description**:

> Headless Oracle returns Ed25519-signed market-state receipts for 28 global
> exchanges including NYSE (XNYS), Nasdaq (XNAS), Tokyo Stock Exchange (XJPX),
> Shanghai Stock Exchange (XSHG), Korea Exchange (XKRX), London (XLON), and 23
> more. Every response is a cryptographically signed attestation with a
> 60-second TTL. Fail-closed by contract: UNKNOWN resolves to CLOSED. Aligned
> with SEC/CFTC Technical Framework for Tokenized Collateral (Nov 2025).
> Reference implementation of Multi-Oracle Consensus spec v1.0.0.

**Category**: Finance
**MCP endpoint**: `https://headlessoracle.com/mcp`
**Transport**: Streamable HTTP (2024-11-05)
**Tools**: `get_market_status`, `get_market_schedule`, `list_exchanges`, `verify_receipt`, `get_payment_options`
**Prompts**: `pre_trade_check`, `market_briefing`
**Resources**: `oracle://exchanges/directory`
**Authentication**: None required for sandbox/trial; API key or x402 for production
**GitHub**: https://github.com/LembaGang/headless-oracle-v5
**npm**: https://www.npmjs.com/package/headless-oracle-mcp
**Website**: https://headlessoracle.com
**License**: MIT

---

## 2. Smithery (update existing listing)

**Display name**: Headless Oracle
**Version**: 5.0.0
**License**: MIT
**Homepage**: https://headlessoracle.com
**Documentation**: https://headlessoracle.com/docs
**Repository**: https://github.com/LembaGang/headless-oracle-v5
**Description**:

> Model-agnostic, signed, fail-closed market-state attestations for 28 global
> exchanges. Parseable by every frontier model (GPT-5.x, Claude 4.x, Gemini
> 3.x, Grok 4.x) down to GPT-5 nano. Regulatory alignment: SEC/CFTC tokenized
> collateral (Nov 2025), ESMA algorithmic trading, NIST cryptographic chains
> of custody, Singapore MAS agentic AI governance.

**Tools**: 5 (`get_market_status`, `get_market_schedule`, `list_exchanges`, `verify_receipt`, `get_payment_options`)
**Prompts**: 2 (`pre_trade_check`, `market_briefing`)
**Resources**: 1 (`oracle://exchanges/directory`)
**Capabilities**: tools, prompts, resources

---

## 3. Glama

**Name**: Headless Oracle
**Description**: Signed market-state attestations for 28 global exchanges. Ed25519, 60s TTL, fail-closed UNKNOWN → CLOSED, x402 native payment. Reference implementation of Multi-Oracle Consensus spec v1.0.0.
**Tags**: finance, market-data, attestation, verification, pre-trade-safety, rwa, tokenization, ed25519, x402, mcp
**Category**: Finance / Market Data
**GitHub**: https://github.com/LembaGang/headless-oracle-v5
**License**: MIT
**Demo**: `curl https://headlessoracle.com/v5/demo?mic=XNYS`

---

## 4. PulseMCP

**Server name**: Headless Oracle
**Short description**: Signed pre-trade market-state attestations for autonomous trading agents. 28 exchanges.
**Install command**: `npx headless-oracle-mcp`
**Remote endpoint**: `https://headlessoracle.com/mcp`
**Homepage**: https://headlessoracle.com
**Tools**:
- `get_market_status(mic)` — signed OPEN/CLOSED/HALTED/UNKNOWN receipt
- `get_market_schedule(mic)` — next open/close times in UTC
- `list_exchanges()` — 28-exchange directory
- `verify_receipt(receipt)` — Ed25519 verification
- `get_payment_options()` — upgrade ladder

---

## 5. mcp.so

**Name**: Headless Oracle
**Author**: LembaGang
**URL**: https://headlessoracle.com
**Description**:

> The only MCP server that returns cryptographically signed market-state
> receipts. 28 exchanges (NYSE, Nasdaq, Tokyo, Shanghai, Korea, London, and
> 22 more). Ed25519 signatures. 60-second TTL. Fail-closed: UNKNOWN → CLOSED.
> Aligned with SEC/CFTC Technical Framework for Tokenized Collateral (Nov
> 2025). Reference implementation of Multi-Oracle Consensus spec v1.0.0.

**Tags**: finance, mcp, market-data, trading, attestation, rwa
**License**: MIT
**GitHub**: https://github.com/LembaGang/headless-oracle-v5

---

## 6. mcpservers.org

**Name**: Headless Oracle
**Slug**: headless-oracle
**Category**: Finance
**Maintainer**: LembaGang (mike@headlessoracle.com)
**Description**: Pre-trade safety check for autonomous trading agents. Signed market-state attestations for 28 global exchanges. Fail-closed, Ed25519, x402 payment.
**Endpoint**: https://headlessoracle.com/mcp
**Repository**: https://github.com/LembaGang/headless-oracle-v5
**License**: MIT
**Documentation**: https://headlessoracle.com/docs

---

## 7. mcpmarket.com

**Title**: Headless Oracle — Signed Market-State Attestations
**One-liner**: The pre-trade safety primitive for autonomous trading agents.
**Description**:

> Every response is an Ed25519-signed, fail-closed receipt answering "Is this
> exchange open right now?" for 28 global exchanges. Autonomous agents can
> verify offline using the public key at /.well-known/oracle-keys.json.
> Agents pay per-request via x402 on Base mainnet ($0.001 USDC) without
> human intervention. Sandbox tier is free (200 calls / 7 days).

**Category**: Finance / Data Feeds
**Install**: `npx headless-oracle-mcp` or use remote endpoint `https://headlessoracle.com/mcp`
**Screenshots**: https://headlessoracle.com/v5/card/XNYS (live SVG status card)
**GitHub**: https://github.com/LembaGang/headless-oracle-v5
**Website**: https://headlessoracle.com

---

## Common fields across all submissions

- **MCP endpoint**: https://headlessoracle.com/mcp
- **npm package**: headless-oracle-mcp
- **PyPI package**: headless-oracle
- **OpenAPI spec**: https://headlessoracle.com/openapi.json
- **Server card**: https://headlessoracle.com/.well-known/mcp/server-card.json
- **Agent card (A2A)**: https://headlessoracle.com/.well-known/agent.json
- **License**: MIT
- **Maintainer contact**: mike@headlessoracle.com
