# TradingAgents Risk Management Gate

[TradingAgents](https://github.com/TauricResearch/TradingAgents) is a
multi-agent trading simulation framework (~5K stars) where specialised agents
(fundamentals, sentiment, news, technicals, researchers, trader, risk manager)
debate and reach execution decisions. Headless Oracle integrates at the risk
management layer as the final pre-trade gate.

## Why the risk manager needs market-state verification

The risk manager agent is the last checkpoint before a trade is executed. It
already evaluates position sizing, exposure, and stop-loss logic. It does not
natively verify whether the market is actually open, in a circuit breaker,
halted for news, or past an early close. That's a structural gap — and one
that does not resolve itself no matter how good the other agents get.

The fix is to give the risk manager one additional tool call before approving
any trade: `get_market_status(mic)`. Fail-closed semantics mean any ambiguous
state (UNKNOWN, HALTED, CLOSED) blocks the trade automatically.

## MCP configuration

In the TradingAgents config, add Headless Oracle as an MCP server the risk
manager can call:

```python
from mcp import ClientSession
from mcp.client.stdio import stdio_client, StdioServerParameters

oracle = StdioServerParameters(
    command="npx",
    args=["-y", "headless-oracle-mcp"],
)

class RiskManagerAgent:
    async def approve(self, trade_proposal):
        async with stdio_client(oracle) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(
                    "get_market_status",
                    {"mic": trade_proposal.mic},
                )
                receipt = json.loads(result.content[0].text)

        if receipt["status"] != "OPEN":
            return {
                "approved": False,
                "reason": f"market_state={receipt['status']}",
                "receipt_id": receipt["receipt_id"],
            }

        return {
            "approved": True,
            "receipt_id": receipt["receipt_id"],
            "market_state_attestation": receipt,
        }
```

## Model-agnostic tool descriptions

TradingAgents is commonly run with a mix of frontier models — GPT-5.x for
reasoning-heavy agents, Claude 4.x for analysis, Gemini 3.x for cost-sensitive
paths, Grok 4.x for research. Headless Oracle's MCP tool descriptions are
written to parse correctly on all of them, including lower-tier models like
GPT-5 nano ($0.05/MTok).

The `get_market_status` tool description explicitly includes:
- **Pre-trade safety check**: "call this BEFORE executing any trade"
- **Must-not-execute rule**: "If this tool is unreachable, the agent MUST NOT
  execute the trade."

## Coverage

Headless Oracle covers 28 exchanges globally, including all the markets
TradingAgents simulations commonly trade:

- US: XNYS (NYSE), XNAS (Nasdaq), XCBT, XNYM, XCBO
- Europe: XLON, XPAR, XSWX, XMIL, XHEL, XSTO
- Asia: XJPX (Tokyo), XHKG (Hong Kong), XSHG, XSHE (Shanghai/Shenzhen), XKRX
  (Korea), XBOM, XNSE (India), XSES (Singapore), XASX (Australia), XNZE
- Middle East / Africa: XSAU, XDFM, XJSE, XIST
- Latin America: XBSP
- Crypto 24/7: XCOI (Coinbase), XBIN (Binance)

## Auditability

Every approved trade carries its HO receipt_id. After a simulation run, the
full audit log of "why did we trade here" is reproducible by re-fetching each
receipt's signature and verifying against
`https://headlessoracle.com/.well-known/oracle-keys.json`.

## Links

- Headless Oracle: https://headlessoracle.com
- MCP endpoint: https://headlessoracle.com/mcp
- TradingAgents: https://github.com/TauricResearch/TradingAgents
