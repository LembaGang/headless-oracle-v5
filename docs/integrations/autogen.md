# AutoGen Integration

Register a Headless Oracle market-status check as an AutoGen tool. The `AssistantAgent` can call it when deciding whether to execute a trade action. The tool verifies the Ed25519 signature before returning a result — the agent never sees an unverified receipt.

## Prerequisites

```bash
pip install headless-oracle pyautogen httpx
```

## Complete Example

```python
import os
import httpx
from autogen import AssistantAgent, UserProxyAgent, register_function
from headless_oracle import verify, VerificationError

ORACLE_BASE = "https://headlessoracle.com"
ORACLE_KEY = os.environ["ORACLE_KEY"]

VALID_MICS = {"XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"}


# --- Tool implementation ---

def check_market_status(mic: str) -> dict:
    """
    Fetch and verify a signed market status receipt from Headless Oracle.

    Returns a dict with:
      - status: "OPEN" | "CLOSED" | "HALTED" | "UNKNOWN"
      - safe_to_trade: bool (False for anything other than OPEN with valid signature)
      - reason: human-readable explanation
      - receipt: the raw verified receipt, or None on failure

    UNKNOWN and any verification failure always return safe_to_trade=False.
    """
    mic = mic.upper().strip()
    if mic not in VALID_MICS:
        return {"status": "ERROR", "safe_to_trade": False,
                "reason": f"Unknown MIC '{mic}'. Valid: {sorted(VALID_MICS)}", "receipt": None}

    try:
        resp = httpx.get(
            f"{ORACLE_BASE}/v5/status",
            params={"mic": mic},
            headers={"X-Oracle-Key": ORACLE_KEY},
            timeout=5.0,
        )
        resp.raise_for_status()
        receipt = resp.json()

        verify(receipt)  # raises VerificationError on invalid signature or expired TTL

        is_open = receipt.get("status") == "OPEN"
        return {
            "status": receipt.get("status"),
            "safe_to_trade": is_open,
            "reason": "Market is OPEN — verified." if is_open
                      else f"Market is {receipt.get('status')} — do not trade.",
            "receipt": receipt,
        }

    except httpx.TimeoutException:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": "Oracle request timed out. Treating as CLOSED.", "receipt": None}
    except VerificationError as e:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": f"Signature verification failed: {e}", "receipt": None}
    except Exception as e:
        return {"status": "UNKNOWN", "safe_to_trade": False,
                "reason": f"Unexpected error: {e}", "receipt": None}


# --- Agent configuration ---

llm_config = {
    "config_list": [{"model": "gpt-4o", "api_key": os.environ["OPENAI_API_KEY"]}],
    "tools": [
        {
            "type": "function",
            "function": {
                "name": "check_market_status",
                "description": (
                    "Check whether a stock exchange is currently OPEN using a cryptographically "
                    "signed receipt from Headless Oracle. Always call this before executing any trade. "
                    "If safe_to_trade is False, do not proceed with the trade."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "mic": {
                            "type": "string",
                            "description": "ISO 10383 MIC code. One of: XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE.",
                        }
                    },
                    "required": ["mic"],
                },
            },
        }
    ],
}

assistant = AssistantAgent(name="trading_assistant", llm_config=llm_config)

user_proxy = UserProxyAgent(
    name="user_proxy",
    human_input_mode="NEVER",
    max_consecutive_auto_reply=3,
    code_execution_config=False,
)

# Register the tool so user_proxy can execute it when the assistant requests it
register_function(
    check_market_status,
    caller=assistant,
    executor=user_proxy,
    name="check_market_status",
    description="Check market status via Headless Oracle (Ed25519-verified).",
)


# --- Usage ---

if __name__ == "__main__":
    user_proxy.initiate_chat(
        assistant,
        message="Should I execute a trade on the NYSE right now? Check the market status first.",
    )
```

## Important

- **`safe_to_trade` is the decision field.** The agent is instructed to treat any `safe_to_trade=False` result as a hard halt. Wire this into your system prompt explicitly: "If check_market_status returns safe_to_trade=False, do not proceed."
- **Never expose the raw receipt to the LLM as a trust signal.** The LLM cannot verify signatures. Only return `safe_to_trade` (computed by `verify()`) as the actionable field.
- **Timeout and verification failure both return UNKNOWN/False.** The tool is fail-closed: ambiguity is always treated as CLOSED, never as OPEN.
