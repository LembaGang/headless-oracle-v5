# LangGraph Integration

Use Headless Oracle as a market gate node in a LangGraph `StateGraph`. The node fetches a signed receipt, verifies the Ed25519 signature, and halts the graph if the market is not OPEN — before any trade execution node runs.

## Prerequisites

```bash
pip install headless-oracle langgraph langchain-core httpx
```

## Complete Example

```python
import httpx
from typing import TypedDict, Annotated
from langgraph.graph import StateGraph, END
from headless_oracle import verify, VerificationError

ORACLE_BASE = "https://headlessoracle.com"
ORACLE_KEY = "your_key_here"  # set via environment variable in production
MIC = "XNYS"


# --- State definition ---

class TradeState(TypedDict):
    mic: str
    market_open: bool
    receipt: dict | None
    halt_reason: str | None
    trade_result: str | None


# --- Nodes ---

def market_gate(state: TradeState) -> TradeState:
    """
    Fetch a signed market receipt and verify it.
    Sets market_open=False on any failure — fail-closed by design.
    A timeout is treated as UNKNOWN, which is CLOSED.
    """
    mic = state.get("mic", MIC)
    try:
        resp = httpx.get(
            f"{ORACLE_BASE}/v5/status",
            params={"mic": mic},
            headers={"X-Oracle-Key": ORACLE_KEY},
            timeout=5.0,
        )
        resp.raise_for_status()
        receipt = resp.json()

        # Verify signature and TTL — raises VerificationError on failure
        verify(receipt)

        if receipt.get("status") != "OPEN":
            return {**state, "market_open": False, "receipt": receipt,
                    "halt_reason": f"Market status is {receipt.get('status')}"}

        return {**state, "market_open": True, "receipt": receipt, "halt_reason": None}

    except httpx.TimeoutException:
        return {**state, "market_open": False, "receipt": None,
                "halt_reason": "Oracle timeout — treating as UNKNOWN (CLOSED)"}
    except VerificationError as e:
        return {**state, "market_open": False, "receipt": None,
                "halt_reason": f"Receipt verification failed: {e}"}
    except Exception as e:
        return {**state, "market_open": False, "receipt": None,
                "halt_reason": f"Oracle error: {e}"}


def execute_trade(state: TradeState) -> TradeState:
    """Runs only when market_gate confirms OPEN."""
    # Replace with real trade logic
    return {**state, "trade_result": f"Trade executed for {state['mic']}"}


def halt_node(state: TradeState) -> TradeState:
    print(f"HALTED: {state['halt_reason']}")
    return {**state, "trade_result": None}


# --- Routing ---

def route_after_gate(state: TradeState) -> str:
    return "execute_trade" if state["market_open"] else "halt"


# --- Graph assembly ---

builder = StateGraph(TradeState)
builder.add_node("market_gate", market_gate)
builder.add_node("execute_trade", execute_trade)
builder.add_node("halt", halt_node)

builder.set_entry_point("market_gate")
builder.add_conditional_edges("market_gate", route_after_gate,
                               {"execute_trade": "execute_trade", "halt": "halt"})
builder.add_edge("execute_trade", END)
builder.add_edge("halt", END)

graph = builder.compile()


# --- Usage ---

if __name__ == "__main__":
    result = graph.invoke({"mic": "XNYS"})
    print(result)
```

## Important

- **Verify before routing.** The `verify()` call checks both the Ed25519 signature and the `expires_at` TTL (60 seconds). A receipt that passes HTTP status checks but fails `verify()` must be treated as untrusted.
- **Timeout is CLOSED.** If the Oracle request times out, the node returns `market_open=False`. Never default to OPEN on an unknown state.
- **UNKNOWN means CLOSED.** A receipt with `status="UNKNOWN"` indicates the Oracle's signing infrastructure detected an error. Route it to `halt`, not `execute_trade`.
- **Do not cache receipts** across LangGraph invocations. Each graph run must fetch a fresh receipt — receipts expire after 60 seconds.
