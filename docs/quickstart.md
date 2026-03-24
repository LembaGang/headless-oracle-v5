# Headless Oracle — 5-Minute Quickstart

From zero to first signed receipt in under 5 minutes.

---

## Step 1: Get a sandbox key (instant, no signup)

```bash
curl "https://api.headlessoracle.com/v5/sandbox"
```

Response:
```json
{
  "api_key": "sb_a1b2c3d4e5f6...",
  "tier": "sandbox",
  "expires_at": "2026-03-25T08:00:00.000Z",
  "calls_remaining": 100
}
```

Save the `api_key` value — you'll use it as `YOUR_KEY` below.

Optional: add `?email=you@example.com` to receive the key by email and get an expiry reminder.

---

## Step 2: Call /v5/status

Replace `YOUR_KEY` with your sandbox key.

**curl:**
```bash
curl "https://api.headlessoracle.com/v5/status?mic=XNYS" \
  -H "X-Oracle-Key: YOUR_KEY"
```

**Python (requests):**
```python
import requests

key = "YOUR_KEY"
r = requests.get(
    "https://api.headlessoracle.com/v5/status",
    params={"mic": "XNYS"},
    headers={"X-Oracle-Key": key},
)
receipt = r.json()
print(receipt["status"])   # OPEN, CLOSED, HALTED, or UNKNOWN
print(receipt["expires_at"])  # Receipt is valid for 60 seconds
```

**Node.js (fetch):**
```javascript
const key = "YOUR_KEY";
const res = await fetch("https://api.headlessoracle.com/v5/status?mic=XNYS", {
  headers: { "X-Oracle-Key": key },
});
const receipt = await res.json();
console.log(receipt.status);     // OPEN, CLOSED, HALTED, or UNKNOWN
console.log(receipt.expires_at); // Receipt is valid for 60 seconds
```

---

## Step 3: Check the status field — fail-closed

```javascript
// Fail-closed: only proceed if status is explicitly OPEN
if (receipt.status !== "OPEN") {
  throw new Error(`Market not open: ${receipt.status}. Halting.`);
}
// Safe to proceed
```

```python
if receipt["status"] != "OPEN":
    raise RuntimeError(f"Market not open: {receipt['status']}. Halting.")
# Safe to proceed
```

---

## Step 4: Verify the signed receipt (optional but recommended)

The receipt includes an Ed25519 signature. Verify it before acting:

```bash
# Install the SDK:
npm install @headlessoracle/verify

# Verify (Node.js):
import { verify } from '@headlessoracle/verify';
const result = await verify(receipt);
if (!result.valid) throw new Error(result.reason);
```

```python
# Python:
pip install headless-oracle

from headless_oracle import verify
result = verify(receipt)
if not result.valid:
    raise RuntimeError(result.reason)
```

---

## Step 5: Try other exchanges

```bash
# London Stock Exchange
curl "https://api.headlessoracle.com/v5/status?mic=XLON" -H "X-Oracle-Key: YOUR_KEY"

# Tokyo (Japan Exchange Group — has lunch break 11:30-12:30 JST)
curl "https://api.headlessoracle.com/v5/status?mic=XJPX" -H "X-Oracle-Key: YOUR_KEY"

# List all 23 supported exchanges:
curl "https://api.headlessoracle.com/v5/exchanges"
```

---

## Supported exchanges

23 exchanges across 6 regions:

| Region   | MIC codes |
|----------|-----------|
| Americas | XNYS, XNAS, XBSP |
| Europe   | XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST |
| Middle East | XSAU, XDFM |
| Africa   | XJSE |
| Asia     | XSHG, XSHE, XHKG, XJPX, XKRX, XBOM, XNSE, XSES |
| Pacific  | XASX, XNZE |

---

## Next steps

- **Production key**: [headlessoracle.com/pricing](https://headlessoracle.com/pricing) (Builder: $99/mo, 50K calls/day)
- **Free key** (500 req/day): `POST https://api.headlessoracle.com/v5/keys/request` with `{"email":"you@example.com"}`
- **MCP server** (Claude Desktop / Cursor): add `"https://headlessoracle.com/mcp"` as an MCP endpoint
- **Full docs**: [headlessoracle.com/docs](https://headlessoracle.com/docs)
- **OpenAPI spec**: `GET https://headlessoracle.com/openapi.json`
- **Framework examples**: `docs/integrations.md`
