# Agent Zero Plugin Hub Submission

## Status: READY TO SUBMIT

Submission target: https://github.com/agent0ai/a0-plugins

---

## PR Title

```
feat: add Headless Oracle plugin — Ed25519-signed market-state receipts for 28 exchanges
```

## PR Description

```markdown
## Headless Oracle

**Pre-trade verification gate for autonomous financial agents.**

An Agent Zero instance (AgentZero/19353) discovered and called our MCP endpoint tonight. 
This submission makes the integration official.

### What it does

Headless Oracle returns Ed25519-signed receipts indicating whether a stock exchange is 
OPEN, CLOSED, HALTED, or UNKNOWN. The signature lets any downstream agent verify the 
receipt independently without calling the API again.

This is a pre-trade safety primitive: before any financial execution decision, check the oracle.

### MCP tools included

| Tool | Description |
|------|-------------|
| `get_market_status` | Signed receipt (OPEN/CLOSED/HALTED/UNKNOWN) for a given MIC |
| `get_market_schedule` | Next open/close times in UTC, lunch breaks, holiday data |
| `list_exchanges` | All 28 supported exchanges with timezones and MIC codes |
| `verify_receipt` | Verify an Ed25519-signed receipt in-worker |

### Coverage

28 global exchanges: NYSE, NASDAQ, LSE, JPX, Euronext Paris, HKEX, SGX, ASX, BSE/NSE India, 
Shanghai, Shenzhen, Korea, Johannesburg, B3 Brazil, SIX Swiss, Borsa Italiana, Istanbul, 
Tadawul, Dubai, NZX, Nasdaq Helsinki/Stockholm, CME, NYMEX, Cboe, Coinbase (24/7), 
Binance (24/7).

### Getting started

No API key required for sandbox (200 free calls). Configure in Agent Zero via MCP:

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://headlessoracle.com/mcp"]
    }
  }
}
```

Or use the `get_market_status` tool directly once the plugin is installed.

### x402 autonomous payment

Agents can pay $0.001 USDC per request on Base mainnet without human intervention 
(ERC-8004 registry: 8453:38413).

### Compliance

- APTS v1.0 (Agent Pre-Trade Safety Standard) — all 6 checks pass
- SMA Protocol v1.0 (Signed Market Attestation) — receipts are SMA-compliant
- UNKNOWN always means CLOSED — fail-closed by design

### Links

- Skill file: https://headlessoracle.com/skill.md
- MCP endpoint: https://headlessoracle.com/mcp
- OpenAPI spec: https://headlessoracle.com/openapi.json
- Ampersend listing: https://app.ampersend.ai/agents/headless-oracle
- Agent discovery: https://headlessoracle.com/.well-known/agent.json

Checklist:
- [x] `plugin.yaml` at repo root
- [x] `skills/headless_oracle.md` included (auto-installed skill)
- [x] Folder name `headless_oracle` matches `name` in `plugin.yaml`
- [x] GitHub URL is publicly accessible
- [x] One plugin per PR
```

---

## Files in this PR (submitted to agent0ai/a0-plugins)

```
plugins/
  headless_oracle/
    index.yaml      ← contents in docs/agent-zero-plugin/index.yaml
```

## Steps to submit

1. Fork https://github.com/agent0ai/a0-plugins
2. Create file: `plugins/headless_oracle/index.yaml`
   (copy contents from docs/agent-zero-plugin/index.yaml)
3. Open PR with the title and description above
4. Wait for CI validation (checks that our plugin.yaml exists at github.com/LembaGang/headless-oracle-v5)

## Contact if stalled

pr@agent-zero.ai
