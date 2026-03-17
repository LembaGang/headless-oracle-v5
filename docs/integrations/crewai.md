# CrewAI Integration

Wrap Headless Oracle as CrewAI `BaseTool` subclasses. A single-exchange `MarketStatusTool` handles per-MIC checks; `BatchMarketStatusTool` covers multi-exchange workflows in one request. Both verify the Ed25519 signature before returning — agents receive only verified results.

## Prerequisites

```bash
pip install headless-oracle crewai httpx
```

## Complete Example

```python
import os
import httpx
from typing import Type
from pydantic import BaseModel, Field
from crewai.tools import BaseTool
from headless_oracle import verify, VerificationError

ORACLE_BASE = "https://headlessoracle.com"
ORACLE_KEY = os.environ["ORACLE_KEY"]

VALID_MICS = {"XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"}


# --- Input schemas ---

class MarketStatusInput(BaseModel):
    mic: str = Field(
        description="ISO 10383 MIC code for the exchange. "
                    "One of: XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE."
    )


class BatchMarketStatusInput(BaseModel):
    mics: list[str] = Field(
        description="List of ISO 10383 MIC codes to check in a single request. "
                    "Each MIC must be one of: XNYS, XNAS, XBSP, XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST, XSAU, XDFM, XJSE, XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES, XASX, XNZE."
    )


# --- Single-exchange tool ---

class MarketStatusTool(BaseTool):
    name: str = "check_market_status"
    description: str = (
        "Check whether a stock exchange is OPEN using a cryptographically signed receipt "
        "from Headless Oracle. Returns the verified status and whether it is safe to trade. "
        "Always call this before executing or recommending any trade. "
        "If safe_to_trade is False, halt — do not proceed."
    )
    args_schema: Type[BaseModel] = MarketStatusInput

    def _run(self, mic: str) -> dict:
        mic = mic.upper().strip()
        if mic not in VALID_MICS:
            return {"status": "ERROR", "safe_to_trade": False,
                    "reason": f"Unknown MIC '{mic}'. Valid: {sorted(VALID_MICS)}"}

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
                "mic": mic,
                "status": receipt.get("status"),
                "safe_to_trade": is_open,
                "reason": "Verified OPEN." if is_open
                          else f"Market is {receipt.get('status')} — do not trade.",
                "expires_at": receipt.get("expires_at"),
            }
        except httpx.TimeoutException:
            return {"mic": mic, "status": "UNKNOWN", "safe_to_trade": False,
                    "reason": "Oracle timeout — treating as CLOSED."}
        except VerificationError as e:
            return {"mic": mic, "status": "UNKNOWN", "safe_to_trade": False,
                    "reason": f"Signature verification failed: {e}"}
        except Exception as e:
            return {"mic": mic, "status": "UNKNOWN", "safe_to_trade": False,
                    "reason": f"Unexpected error: {e}"}


# --- Batch multi-exchange tool ---

class BatchMarketStatusTool(BaseTool):
    name: str = "check_batch_market_status"
    description: str = (
        "Check multiple stock exchanges in a single request using Headless Oracle's batch endpoint. "
        "Returns verified status for each MIC. Use this when a strategy spans multiple markets. "
        "Any exchange with safe_to_trade=False must be excluded from execution."
    )
    args_schema: Type[BaseModel] = BatchMarketStatusInput

    def _run(self, mics: list[str]) -> list[dict]:
        mics_clean = [m.upper().strip() for m in mics]
        invalid = [m for m in mics_clean if m not in VALID_MICS]
        if invalid:
            return [{"status": "ERROR", "safe_to_trade": False,
                     "reason": f"Unknown MIC(s): {invalid}. Valid: {sorted(VALID_MICS)}"}]

        try:
            resp = httpx.get(
                f"{ORACLE_BASE}/v5/batch",
                params={"mics": ",".join(mics_clean)},
                headers={"X-Oracle-Key": ORACLE_KEY},
                timeout=10.0,
            )
            resp.raise_for_status()
            batch = resp.json()  # list of receipts

            results = []
            for receipt in batch:
                mic = receipt.get("mic", "UNKNOWN")
                try:
                    verify(receipt)
                    is_open = receipt.get("status") == "OPEN"
                    results.append({
                        "mic": mic,
                        "status": receipt.get("status"),
                        "safe_to_trade": is_open,
                        "reason": "Verified OPEN." if is_open
                                  else f"Market is {receipt.get('status')}.",
                    })
                except VerificationError as e:
                    results.append({"mic": mic, "status": "UNKNOWN", "safe_to_trade": False,
                                    "reason": f"Signature verification failed: {e}"})
            return results

        except httpx.TimeoutException:
            return [{"mic": m, "status": "UNKNOWN", "safe_to_trade": False,
                     "reason": "Oracle timeout."} for m in mics_clean]
        except Exception as e:
            return [{"mic": m, "status": "UNKNOWN", "safe_to_trade": False,
                     "reason": f"Error: {e}"} for m in mics_clean]


# --- Crew assembly ---

from crewai import Agent, Task, Crew

market_analyst = Agent(
    role="Market Safety Analyst",
    goal="Verify that markets are open and safe before any trade recommendation is made.",
    backstory=(
        "You are a rigorous pre-trade safety analyst. You always verify market status "
        "using cryptographically signed receipts before approving any trade. "
        "You never act on unverified or expired receipts. "
        "UNKNOWN status is always treated as CLOSED."
    ),
    tools=[MarketStatusTool(), BatchMarketStatusTool()],
    verbose=True,
)

safety_check_task = Task(
    description=(
        "Check the market status for NYSE (XNYS) and NASDAQ (XNAS). "
        "Report whether both are currently safe to trade. "
        "If either is not OPEN, explain why trading should be halted."
    ),
    expected_output="A verified market status report for XNYS and XNAS with safe_to_trade flags.",
    agent=market_analyst,
)

crew = Crew(agents=[market_analyst], tasks=[safety_check_task], verbose=True)


if __name__ == "__main__":
    result = crew.kickoff()
    print(result)
```

## Important

- **`safe_to_trade` is the only field agents should act on.** The raw `status` string from an unverified receipt has no meaning — `verify()` must run first. Both tools encapsulate this so the agent always receives a pre-verified result.
- **`BatchMarketStatusTool` verifies each receipt independently.** A batch response with 3 MICs where 1 fails verification returns `safe_to_trade=False` for that MIC specifically — the others are unaffected.
- **Do not pass `expires_at` to the agent as a caching hint.** Receipts expire after 60 seconds. Each task invocation must call the tool fresh — do not store results between crew runs.
