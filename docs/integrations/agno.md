# Agno Integration

Use Headless Oracle as an MCP tool in [Agno](https://github.com/agno-agi/agno) agents via `MCPTools`. Two patterns: Streamable HTTP (zero install) or stdio (local process).

## Streamable HTTP (recommended)

No local server needed — connects directly to the remote MCP endpoint:

```python
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.tools.mcp import MCPTools

# Streamable HTTP transport — connects to the remote MCP server
tools = MCPTools(
    transport="streamable-http",
    url="https://headlessoracle.com/mcp",
)

risk_officer = Agent(
    name="Risk Officer",
    model=OpenAIChat(id="gpt-4.1"),
    tools=[tools],
    instructions=[
        "Before any trade execution, use get_market_status to verify the exchange is OPEN.",
        "If status is CLOSED, HALTED, or UNKNOWN, halt all trading for that exchange.",
        "Always check expires_at — receipts older than 60 seconds are stale.",
    ],
)

# The agent will call get_market_status via MCP
risk_officer.print_response(
    "Check if NYSE (XNYS) is currently open for trading"
)
```

## Stdio (local MCP server)

Uses the npm package as a local subprocess:

```python
from agno.tools.mcp import MCPTools

tools = MCPTools(
    transport="stdio",
    command="npx",
    args=["headless-oracle-mcp"],
)
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `get_market_status` | Signed receipt: OPEN, CLOSED, HALTED, or UNKNOWN for any MIC |
| `get_market_schedule` | Next open/close times, holidays, lunch breaks |
| `list_exchanges` | All 28 supported exchanges with MIC codes and timezones |
| `verify_receipt` | Ed25519 signature verification on a receipt from another agent |

## Multi-Exchange Pre-Trade Gate

```python
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from agno.tools.mcp import MCPTools

tools = MCPTools(
    transport="streamable-http",
    url="https://headlessoracle.com/mcp",
)

gate_agent = Agent(
    name="Market Gate",
    model=OpenAIChat(id="gpt-4.1"),
    tools=[tools],
    instructions=[
        "You are a pre-trade gate. Given a list of MIC codes:",
        "1. Call get_market_status for each MIC",
        "2. Report which are OPEN and which are not",
        "3. If ANY exchange is not OPEN, recommend holding all positions on that exchange",
        "4. UNKNOWN and HALTED must be treated as CLOSED (fail-closed)",
    ],
)

gate_agent.print_response(
    "Check market status for XNYS, XLON, and XJPX before our portfolio rebalance"
)
```

## Important

- **UNKNOWN = CLOSED**: The fail-closed guarantee means any ambiguous state halts execution.
- **60-second TTL**: Always verify `expires_at` is in the future before acting on a receipt.
- **No API key needed**: MCP tools use the free demo endpoint. For live receipts with `receipt_mode: "live"`, set `HEADLESS_ORACLE_API_KEY` environment variable.
