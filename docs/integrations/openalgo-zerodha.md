# OpenAlgo + Zerodha + Headless Oracle

[OpenAlgo](https://github.com/marketcalls/openalgo) is a Flask-based unified
trading API that bridges 30+ Indian brokers (including Zerodha, Upstox, Angel
One, Fyers) with algorithmic trading platforms. Headless Oracle plugs in as a
middleware gate that verifies the Indian market (BSE / NSE) is actually open
before any order is routed.

## Why this matters for SEBI compliance

SEBI's February 2025 circular on algorithmic trading mandates:

- **Unique Algo ID** on every order submitted to Indian exchanges
- **5-year audit trail** of algo decisions
- **Accountability** for broker-approved algo strategies

A signed Headless Oracle receipt attached to each order gives you independent,
third-party evidence that the market was OPEN according to a cryptographically
verifiable source at the moment of decision. That is audit-trail evidence in
the format SEBI expects: timestamped, signed, reproducible.

## Exchanges covered

- **BSE (XBOM)** — Bombay Stock Exchange
- **NSE (XNSE)** — National Stock Exchange of India

Both are in Headless Oracle's 28-exchange set with full 2026/2027 holiday
calendars and IANA timezone handling (`Asia/Kolkata`).

## Flask middleware

```python
from flask import Flask, request, jsonify
import requests

app = Flask(__name__)

ORACLE_URL = "https://headlessoracle.com/v5/status"
ORACLE_API_KEY = os.environ["HO_API_KEY"]

def verify_market(mic: str) -> dict:
    r = requests.get(
        ORACLE_URL,
        params={"mic": mic},
        headers={"X-Oracle-Key": ORACLE_API_KEY},
        timeout=5,
    )
    r.raise_for_status()
    return r.json()

@app.before_request
def pre_trade_gate():
    if request.endpoint not in ("place_order", "modify_order"):
        return

    symbol = request.json.get("symbol", "")
    mic = "XNSE" if symbol.endswith("-EQ") else "XBOM"

    try:
        receipt = verify_market(mic)
    except Exception as e:
        return jsonify({"error": "market_state_unknown", "detail": str(e)}), 503

    if receipt["status"] != "OPEN":
        return jsonify({
            "error": "market_not_open",
            "mic": mic,
            "status": receipt["status"],
            "source": receipt["source"],
            "receipt_id": receipt["receipt_id"],
        }), 409

    request.environ["ho_receipt"] = receipt
```

## Persisting receipts for the 5-year audit trail

```python
@app.after_request
def log_receipt(response):
    receipt = request.environ.get("ho_receipt")
    if receipt:
        db.execute(
            "INSERT INTO order_audit (order_id, algo_id, receipt_id, "
            "signature, public_key_id, issued_at, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                response.json.get("order_id"),
                request.json.get("algo_id"),
                receipt["receipt_id"],
                receipt["signature"],
                receipt["public_key_id"],
                receipt["issued_at"],
                receipt["status"],
            ),
        )
    return response
```

## Zerodha-specific notes

Zerodha's Kite Connect API is the most common execution path for Indian retail
algos. OpenAlgo abstracts the Kite API so the same middleware works for every
supported broker. The Headless Oracle gate runs once, before any broker-specific
routing decision, so you pay for one oracle call per trade regardless of which
broker ends up executing.

## Pricing

- **Sandbox**: 200 calls / 7 days (free)
- **x402**: $0.001 USDC per call (autonomous)
- **Builder**: $99/month, 50,000 calls/day

## Links

- Headless Oracle: https://headlessoracle.com
- Exchanges covered: https://headlessoracle.com/v5/exchanges
- OpenAlgo: https://github.com/marketcalls/openalgo
