# ai-hedge-fund Integration

Integration guide for adding pre-trade market state verification to [virattt/ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) (50K+ stars). The market state verifier sits between the risk management agent and the portfolio manager in the LangGraph DAG, blocking trades on closed exchanges.

## Architecture

```
START → start_node → [analyst nodes PARALLEL] → risk_management_agent
                                                        │
                                                market_state_verifier  ← NEW
                                                        │
                                                portfolio_manager → END
```

The verifier calls Headless Oracle's free `/v5/demo` endpoint — **zero new dependencies**, zero API keys required.

## How It Works

1. After risk analysis completes, the market state verifier runs
2. For each ticker, it maps the symbol to an exchange MIC code (e.g., AAPL → XNYS, VOD.L → XLON)
3. It calls the oracle once per unique exchange (deduplicated — AAPL + MSFT = 1 call to XNYS)
4. Results are written to `state["data"]["market_state"]` and `analyst_signals`
5. If any exchange is not OPEN, a warning message is added for the portfolio manager
6. The portfolio manager sees the warning and holds those tickers

## The Agent

```python
# src/agents/market_state_verifier.py

import json
from urllib.request import urlopen, Request
from urllib.error import URLError
from langchain_core.messages import HumanMessage
from src.graph.state import AgentState, show_agent_reasoning
from src.utils.progress import progress

SUFFIX_TO_MIC = {
    "":     "XNYS",   # US equities (default)
    ".L":   "XLON",   # London
    ".T":   "XJPX",   # Tokyo
    ".PA":  "XPAR",   # Paris
    ".HK":  "XHKG",   # Hong Kong
    ".SI":  "XSES",   # Singapore
    ".AX":  "XASX",   # Australia
    ".BO":  "XBOM",   # BSE India
    ".NS":  "XNSE",   # NSE India
    ".SS":  "XSHG",   # Shanghai
    ".SZ":  "XSHE",   # Shenzhen
    ".KS":  "XKRX",   # Korea
    ".JO":  "XJSE",   # Johannesburg
    ".SA":  "XBSP",   # Brazil
    ".SW":  "XSWX",   # Switzerland
    ".MI":  "XMIL",   # Milan
    ".IS":  "XIST",   # Istanbul
    ".NZ":  "XNZE",   # New Zealand
    ".HE":  "XHEL",   # Helsinki
    ".ST":  "XSTO",   # Stockholm
}


def ticker_to_mic(ticker):
    for suffix, mic in SUFFIX_TO_MIC.items():
        if suffix and ticker.upper().endswith(suffix.upper()):
            return mic
    return "XNYS"


def fetch_market_status(mic, timeout=5):
    url = f"https://headlessoracle.com/v5/demo?mic={mic}"
    try:
        req = Request(url, headers={"User-Agent": "ai-hedge-fund/1.0"})
        with urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
            return data.get("receipt", data)
    except (URLError, OSError, json.JSONDecodeError) as e:
        return {"status": "UNKNOWN", "error": str(e), "mic": mic}


def market_state_verification_agent(state, agent_id="market_state_verifier"):
    tickers = state["data"]["tickers"]
    market_states = {}
    blocked = []
    mic_results = {}

    for ticker in tickers:
        mic = ticker_to_mic(ticker)
        progress.update_status(agent_id, ticker, f"Checking {mic}")
        if mic not in mic_results:
            mic_results[mic] = fetch_market_status(mic)
        result = mic_results[mic]
        status = result.get("status", "UNKNOWN")
        market_states[ticker] = {
            "mic": mic, "status": status, "is_open": status == "OPEN",
        }
        if status != "OPEN":
            blocked.append(ticker)
            market_states[ticker]["warning"] = f"{mic} is {status}"

    warning = (
        f"BLOCKED: {', '.join(blocked)}" if blocked
        else f"All {len(tickers)} exchanges OPEN"
    )

    return {
        "messages": [HumanMessage(content=json.dumps({
            "market_state_verification": {
                "summary": warning, "blocked_tickers": blocked,
                "details": market_states,
            }
        }), name=agent_id)],
        "data": {
            "analyst_signals": {agent_id: market_states},
            "market_state": market_states,
        },
    }
```

## Wiring Into the Graph

In `src/main.py`:

```python
from src.agents.market_state_verifier import market_state_verification_agent

# Inside create_workflow():
workflow.add_node("market_state_verifier", market_state_verification_agent)

# Replace:
#   workflow.add_edge("risk_management_agent", "portfolio_manager")
# With:
workflow.add_edge("risk_management_agent", "market_state_verifier")
workflow.add_edge("market_state_verifier", "portfolio_manager")
```

## Fail-Closed Guarantee

| Oracle Response | Agent Behavior |
|----------------|----------------|
| `OPEN` | Allow trading |
| `CLOSED` | Block — hold position |
| `HALTED` | Block — circuit breaker active |
| `UNKNOWN` | Block — oracle can't determine state |
| Network error | Block — treated as UNKNOWN |

The verifier uses only `urllib` (stdlib). No new pip dependencies.

## PR Reference

- PR: [virattt/ai-hedge-fund#564](https://github.com/virattt/ai-hedge-fund/pull/564)
- 17 tests in `tests/test_market_state.py`
- All existing tests pass unchanged
