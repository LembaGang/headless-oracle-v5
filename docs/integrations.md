# Headless Oracle — Framework Integration Examples

Copy-paste-ready examples for 5 agent frameworks. Each example:
- Uses `X-Oracle-Key` header for authentication
- Implements fail-closed logic (halt on HALTED, UNKNOWN, or error)
- Gets a sandbox key first: `GET https://api.headlessoracle.com/v5/sandbox`

---

## 1. LangChain (Python)

```python
from langchain.tools import BaseTool
import httpx

class MarketStatusTool(BaseTool):
    name = "market_status"
    description = "Check if a stock exchange is OPEN before executing a trade. Returns OPEN, CLOSED, HALTED, or UNKNOWN. Treat HALTED/UNKNOWN as CLOSED."
    api_key: str

    def _run(self, mic: str) -> dict:
        # halt_detection: each receipt includes whether real-time halt detection is active
        r = httpx.get(
            f"https://api.headlessoracle.com/v5/status",
            params={"mic": mic.upper()},
            headers={"X-Oracle-Key": self.api_key},
            timeout=5,
        )
        if r.status_code != 200:
            return {"safe_to_execute": False, "reason": f"oracle_error:{r.status_code}"}
        receipt = r.json()
        status = receipt.get("status", "UNKNOWN")
        return {
            "safe_to_execute": status == "OPEN",
            "status": status,
            "mic": mic.upper(),
            "expires_at": receipt.get("expires_at"),
        }

# Usage:
# tool = MarketStatusTool(api_key="sb_your_key")
# result = tool.run("XNYS")
# if not result["safe_to_execute"]: raise RuntimeError("Market not OPEN")
```

---

## 2. Vercel AI SDK (TypeScript)

```typescript
import { tool } from 'ai';
import { z } from 'zod';

export const marketStatusTool = tool({
  description: 'Check if a stock exchange is OPEN before executing a trade. Treat HALTED or UNKNOWN as CLOSED — halt execution immediately.',
  parameters: z.object({
    mic: z.string().describe('ISO 10383 MIC code e.g. XNYS, XLON, XJPX'),
  }),
  execute: async ({ mic }) => {
    // halt_detection field in receipt indicates whether real-time circuit breaker detection is active
    const res = await fetch(`https://api.headlessoracle.com/v5/status?mic=${mic}`, {
      headers: { 'X-Oracle-Key': process.env.ORACLE_API_KEY! },
    });
    if (!res.ok) return { safe_to_execute: false, status: 'UNKNOWN', error: res.status };
    const receipt = await res.json();
    return {
      safe_to_execute: receipt.status === 'OPEN',
      status: receipt.status,
      mic,
      expires_at: receipt.expires_at,
    };
  },
});
```

---

## 3. AutoGen (Python)

```python
import httpx

def check_market_status(mic: str, api_key: str) -> dict:
    """
    Check if a stock exchange is OPEN. Always call before executing a trade.
    halt_detection field in receipt shows if real-time circuit breaker detection is active.
    Returns: { safe_to_execute: bool, status: str, mic: str }
    Fail-closed: UNKNOWN and HALTED both return safe_to_execute=False.
    """
    try:
        r = httpx.get(
            "https://api.headlessoracle.com/v5/status",
            params={"mic": mic.upper()},
            headers={"X-Oracle-Key": api_key},
            timeout=5,
        )
        r.raise_for_status()
        receipt = r.json()
        status = receipt.get("status", "UNKNOWN")
        return {"safe_to_execute": status == "OPEN", "status": status, "mic": mic.upper()}
    except Exception as e:
        return {"safe_to_execute": False, "status": "UNKNOWN", "error": str(e)}

# Register with AutoGen:
# register_function(check_market_status, caller=agent, executor=executor, name="check_market_status")
```

---

## 4. CrewAI (Python)

```python
from crewai_tools import tool
import httpx

@tool("market_status")
def market_status(mic: str) -> str:
    """
    Check if a stock exchange is OPEN before executing any trade.
    halt_detection in the receipt indicates if real-time intraday halts are monitored.
    Fail-closed: returns 'UNSAFE' for CLOSED, HALTED, UNKNOWN, or errors.
    Input: MIC code e.g. 'XNYS', 'XLON', 'XJPX'
    """
    import os
    api_key = os.environ["ORACLE_API_KEY"]
    try:
        r = httpx.get(
            "https://api.headlessoracle.com/v5/status",
            params={"mic": mic.upper()},
            headers={"X-Oracle-Key": api_key},
            timeout=5,
        )
        r.raise_for_status()
        receipt = r.json()
        status = receipt.get("status", "UNKNOWN")
        if status == "OPEN":
            return f"SAFE: {mic} is OPEN. Expires: {receipt.get('expires_at')}"
        return f"UNSAFE: {mic} is {status}. Halt execution."
    except Exception as e:
        return f"UNSAFE: Oracle error — {e}. Fail-closed."
```

---

## 5. OpenAI Assistants API — function definition JSON

```json
{
  "name": "check_market_status",
  "description": "Returns whether a stock exchange is currently OPEN, CLOSED, HALTED, or UNKNOWN. Call this before executing any trade or financial action. Fail-closed: treat HALTED and UNKNOWN as CLOSED and halt execution. The receipt includes a halt_detection field indicating whether real-time intraday circuit breaker detection is active for that exchange.",
  "parameters": {
    "type": "object",
    "properties": {
      "mic": {
        "type": "string",
        "description": "ISO 10383 Market Identifier Code. Examples: XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Tokyo), XPAR (Paris), XHKG (Hong Kong), XSES (Singapore), XASX (Sydney), XBOM (Mumbai BSE), XNSE (Mumbai NSE), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Seoul), XJSE (Johannesburg), XBSP (Sao Paulo), XSWX (Zurich), XMIL (Milan), XIST (Istanbul), XSAU (Riyadh), XDFM (Dubai), XNZE (Auckland), XHEL (Helsinki), XSTO (Stockholm).",
        "enum": ["XNYS","XNAS","XLON","XJPX","XPAR","XHKG","XSES","XASX","XBOM","XNSE","XSHG","XSHE","XKRX","XJSE","XBSP","XSWX","XMIL","XIST","XSAU","XDFM","XNZE","XHEL","XSTO"]
      }
    },
    "required": ["mic"]
  }
}
```

**Handler (Node.js):**

```javascript
async function handleCheckMarketStatus({ mic }) {
  const res = await fetch(`https://api.headlessoracle.com/v5/status?mic=${mic}`, {
    headers: { 'X-Oracle-Key': process.env.ORACLE_API_KEY },
  });
  if (!res.ok) return { safe_to_execute: false, status: 'UNKNOWN' };
  const receipt = await res.json();
  return { safe_to_execute: receipt.status === 'OPEN', status: receipt.status, expires_at: receipt.expires_at };
}
```

---

## Get your API key

```bash
# Instant sandbox key (24h, 100 calls, no signup):
curl "https://api.headlessoracle.com/v5/sandbox"

# Free key (500 req/day, email delivery):
curl -X POST https://api.headlessoracle.com/v5/keys/request \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

Documentation: https://headlessoracle.com/docs
