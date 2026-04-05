# GitHub Outreach Template — Trading Agent Maintainers

**Usage:** Paste this into a GitHub DM or issue comment. Replace [REPO] and [SPECIFIC_THING] with the target.

---

## Template A — General trading agent repos

Hi,

I saw [REPO] and noticed [SPECIFIC_THING — e.g., "you're checking market hours with datetime"].

I've been building Headless Oracle — a signed market oracle for AI agents. The short version: before your agent executes a trade, it fetches a signed attestation that the market is actually open. The attestation is Ed25519 signed with a 60-second TTL, so stale cached state is impossible.

```python
import requests

r = requests.get('https://headlessoracle.com/v5/demo?mic=XNYS')
receipt = r.json()

if receipt['status'] != 'OPEN':
    raise Exception(f"Market not open: {receipt['status']}")
```

28 exchanges covered. Free to try (no key needed for /v5/demo).

If it's useful — pypi.org/project/headless-oracle has a LangChain tool and CrewAI tool with verify() built in.

Let me know if you hit any friction.

— Mike

---

## Template B — Repos with explicit DST/timezone problems

Hi,

I found [REPO] while looking for trading agent projects. Noticed [SPECIFIC_THING — e.g., "the DST handling in market_hours.py"].

DST transitions are the most common source of trading bot post-mortems. I wrote about one here: headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate

I built Headless Oracle specifically because timezone libraries answer the wrong question. They tell you what time it is locally. They don't tell you whether a specific exchange is open, accounting for the exchange's DST schedule, holiday calendar, circuit breakers, and half-days.

The oracle returns a signed receipt with a 60s TTL. If the oracle is down or uncertain, it returns UNKNOWN. Agents are required to treat UNKNOWN as CLOSED.

No key needed for the demo endpoint:
```
curl https://headlessoracle.com/v5/demo?mic=XNYS
```

Would you be open to swapping your datetime check for a signed attestation? Happy to write the integration if it's helpful.

— Mike (headlessoracle.com)

---

## Template C — MCP ecosystem repos (for Claude/Cursor users)

Hi,

I noticed [REPO] is [using Claude / building MCP tools / etc.].

I run headlessoracle.com — a signed market oracle with an MCP server. It gives AI agents a verified pre-trade gate: "Is this exchange open right now, and is the signature fresh?"

The MCP server is at headlessoracle.com/mcp (protocol 2024-11-05). Or via npm:

```json
{
  "mcpServers": {
    "headless-oracle": {
      "command": "npx",
      "args": ["headless-oracle-mcp"]
    }
  }
}
```

Tools: get_market_status, get_market_schedule, list_exchanges, verify_receipt.

Might be useful if you're building agents that touch anything market-related.

— Mike
