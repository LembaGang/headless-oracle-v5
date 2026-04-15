# AgenticTrading + Headless Oracle

[AgenticTrading](https://github.com/Open-Finance-Lab/AgenticTrading) is an
agent-based trading research framework using MCP tool calling, A2A messaging,
Neo4j memory, and DAG execution. Headless Oracle drops in as a native MCP tool
for pre-trade market-state verification.

## Why pre-trade verification belongs in the DAG

AgenticTrading's DAG model separates planning, risk, and execution. A trade
node executing on stale market state — weekend, overnight, halt, circuit breaker
— is the single most expensive unforced error an autonomous agent can make.
The fail-closed contract in Headless Oracle (UNKNOWN → CLOSED) collapses every
ambiguous state into "do not execute."

## DAG node placement

```
plan_trade ──► verify_market_state ──► risk_check ──► execute_trade
                       │                                     ▲
                       └── status != OPEN ──► halt ──────────┘
```

`verify_market_state` is a precondition node. Its output is persisted into the
Neo4j memory layer so downstream audits can reconstruct why a trade was or was
not executed.

## MCP tool registration

```python
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

oracle_params = StdioServerParameters(
    command="npx",
    args=["-y", "headless-oracle-mcp"],
)

async def register_oracle(agent_pool):
    async with stdio_client(oracle_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            agent_pool.register_mcp_tools("headless_oracle", tools.tools, session)
```

Agents in the pool can now call `get_market_status`, `get_market_schedule`,
`list_exchanges`, `verify_receipt`, and `get_payment_options`.

## DAG node implementation

```python
async def verify_market_state_node(ctx):
    mic = ctx.state["target_mic"]
    result = await ctx.mcp["headless_oracle"].call_tool(
        "get_market_status", {"mic": mic}
    )
    receipt = result.content[0].text
    ctx.memory.write(f"receipt:{ctx.trade_id}", receipt)

    if receipt["status"] != "OPEN":
        ctx.halt(reason=f"{mic} not open: {receipt['status']}")
        return

    ctx.state["market_state_receipt_id"] = receipt["receipt_id"]
    return receipt
```

## Model-agnostic

Headless Oracle's MCP tool descriptions are written to parse correctly on any
frontier model — GPT-5.x, Claude 4.x, Gemini 3.x, Grok 4.x, and lower-capability
models such as GPT-5 nano ($0.05/MTok). No tier dependency.

## Links

- Headless Oracle: https://headlessoracle.com
- MCP endpoint: https://headlessoracle.com/mcp
- AgenticTrading: https://github.com/Open-Finance-Lab/AgenticTrading
