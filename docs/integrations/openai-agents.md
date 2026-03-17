# OpenAI Agents SDK Integration

Two approaches: a **function tool** (REST, full control over verification) and an **MCP tool** (protocol-native, zero-boilerplate). Use the function tool when you need custom verification logic or structured output typing. Use MCP when you want the Agents SDK to manage the transport.

## Prerequisites

```bash
pip install headless-oracle openai-agents httpx
# for MCP approach only:
pip install mcp
```

## Approach 1 — Function Tool (REST + verification)

```python
import os
import httpx
from agents import Agent, Runner, function_tool
from headless_oracle import verify, VerificationError

ORACLE_BASE = "https://headlessoracle.com"
ORACLE_KEY = os.environ["ORACLE_KEY"]

VALID_MICS = {"XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"}


@function_tool
def check_market_status(mic: str) -> dict:
    """
    Check whether a stock exchange is currently OPEN using a cryptographically
    signed receipt from Headless Oracle.

    Args:
        mic: ISO 10383 MIC code. One of: XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE.

    Returns:
        A dict with keys:
          - status: "OPEN" | "CLOSED" | "HALTED" | "UNKNOWN"
          - safe_to_trade: bool
          - reason: explanation
        UNKNOWN always means safe_to_trade=False. Never proceed on UNKNOWN.
    """
    mic = mic.upper().strip()
    if mic not in VALID_MICS:
        return {"status": "ERROR", "safe_to_trade": False,
                "reason": f"Invalid MIC '{mic}'. Valid: {sorted(VALID_MICS)}"}

    try:
        resp = httpx.get(
            f"{ORACLE_BASE}/v5/status",
            params={"mic": mic},
            headers={"X-Oracle-Key": ORACLE_KEY},
            timeout=5.0,
        )
        resp.raise_for_status()
        receipt = resp.json()
        verify(receipt)

        is_open = receipt.get("status") == "OPEN"
        return {
            "status": receipt.get("status"),
            "safe_to_trade": is_open,
            "reason": "Verified OPEN." if is_open else f"Market is {receipt.get('status')} — halt.",
            "expires_at": receipt.get("expires_at"),
        }

    except httpx.TimeoutException:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": "Oracle timeout — treating as CLOSED."}
    except VerificationError as e:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": f"Signature verification failed: {e}"}
    except Exception as e:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": f"Oracle error: {e}"}


trading_agent = Agent(
    name="Trading Safety Agent",
    instructions=(
        "You are a pre-trade safety agent. Before taking any trading action, "
        "you must call check_market_status for the relevant exchange. "
        "If safe_to_trade is False, you must halt and explain why. "
        "UNKNOWN status is always treated as CLOSED — do not trade."
    ),
    tools=[check_market_status],
)

if __name__ == "__main__":
    result = Runner.run_sync(
        trading_agent,
        "Should I buy AAPL right now? Check the NYSE market status first."
    )
    print(result.final_output)
```

---

## Approach 2 — MCP Tool (protocol-native)

Use the Oracle MCP server directly. The Agents SDK manages the JSON-RPC transport. No manual HTTP or verification code — the MCP tool exposes `get_market_status`, `get_market_schedule`, and `list_exchanges`.

```python
import asyncio
import os
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

ORACLE_MCP_URL = "https://headlessoracle.com/mcp"


async def main():
    # MCPServerStreamableHttp connects to POST /mcp using protocol 2024-11-05
    async with MCPServerStreamableHttp(
        url=ORACLE_MCP_URL,
        # No auth required for MCP — the server exposes public tools
    ) as oracle_mcp:
        agent = Agent(
            name="MCP Trading Agent",
            instructions=(
                "You have access to Headless Oracle via MCP. "
                "Always call get_market_status before recommending a trade. "
                "If the status is not OPEN, halt. UNKNOWN means CLOSED."
            ),
            mcp_servers=[oracle_mcp],
        )

        result = await Runner.run(
            agent,
            "Is the Tokyo Stock Exchange open right now?",
        )
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

The MCP server exposes these tools automatically:

| Tool | Description |
|---|---|
| `get_market_status` | Signed receipt for a single MIC — same 4-tier fail-closed as REST |
| `get_market_schedule` | Next open/close times in UTC for a MIC |
| `list_exchanges` | Directory of all 23 supported exchanges |

---

## Fail-Closed Decorator (optional utility)

If you have multiple tools that must gate on market status, use a decorator instead of repeating the check:

```python
import functools

def require_market_open(mic: str):
    """Decorator: run the wrapped function only if the market is OPEN."""
    def decorator(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            status = check_market_status(mic)
            if not status["safe_to_trade"]:
                return {"halted": True, "reason": status["reason"]}
            return fn(*args, **kwargs)
        return wrapper
    return decorator


@function_tool
@require_market_open("XNYS")
def execute_nyse_trade(symbol: str, quantity: int) -> dict:
    """Execute a trade on NYSE — only runs if market is verified OPEN."""
    # Real trade logic here
    return {"executed": True, "symbol": symbol, "quantity": quantity}
```

## Important

- **Approach 1 verifies the signature in Python.** Approach 2 relies on the MCP server's internal verification. For regulated or high-value workflows, Approach 1 gives you an audit trail of the raw signed receipt.
- **MCP tools return `isError: true`** in their result object when the Oracle returns UNKNOWN or the market is not OPEN — not as a JSON-RPC transport error. The Agents SDK surfaces this as a tool error, not a run failure.
- **The `@require_market_open` decorator does not retry.** A single CLOSED result halts the decorated function. Do not add retry logic that could execute a trade during a halt.
