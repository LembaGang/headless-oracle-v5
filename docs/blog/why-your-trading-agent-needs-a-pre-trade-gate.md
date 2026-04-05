# Why Your Trading Agent Needs a Pre-Trade Gate

Your agent traded $50,000 into a halted market at 3am. Nobody was watching.

This isn't a hypothetical. It's the failure mode that autonomous trading agents are quietly running toward — and almost nobody has a circuit breaker in place.

---

## The Blind Spot in Autonomous Execution

Agents that execute trades check a lot of things. Price feeds. Order book depth. Portfolio constraints. Risk limits. Slippage estimates.

What they almost never check: **is the exchange actually open right now?**

Price feeds don't tell you the exchange is closed. They serve you the last known price — which may be hours old — and they do it silently. A market data feed returning a stale quote and a market data feed returning a live quote look identical to an agent reading the response.

An agent that sees a valid price and a filled order book and a cleared risk check will execute. It has no reason not to.

Unless someone told it to check market state first.

---

## The DST Bug Nobody Saw Coming

March 8, 2026. US clocks spring forward. European clocks don't change for another three weeks.

For exactly one hour, agents using hardcoded UTC-offset schedules believed European markets were open. Their local-time arithmetic said "09:30 Paris time" but their UTC math was wrong by an hour. The clocks disagreed.

Trades executed into closed markets. The positions sat there, unhedged, until European markets actually opened — 60 minutes and several volatility points later.

No error was thrown. No alert fired. The trades looked syntactically correct.

This is the class of bug that kills accounts: not a crash, not a panic, but a silent wrong answer that looks like a right answer.

---

## What a Pre-Trade Gate Actually Does

A pre-trade gate is a check you run before any trade, payment, or capital commitment. It asks one question: **is this exchange open right now, with cryptographic proof?**

The answer comes back as a signed receipt:

```json
{
  "mic": "XNYS",
  "status": "OPEN",
  "issued_at": "2026-04-03T14:32:10.000Z",
  "expires_at": "2026-04-03T14:33:10.000Z",
  "receipt_mode": "live",
  "signature": "a3f9..."
}
```

The signature is Ed25519. The TTL is 60 seconds. If either check fails, you don't trade.

---

## The Fail-Closed Contract

This is the design decision that separates a verification gate from a rubber stamp:

| Status | Action |
|--------|--------|
| `OPEN` | Proceed |
| `CLOSED` | Halt |
| `HALTED` | Halt (circuit breaker active) |
| `UNKNOWN` | **Halt** (treat as CLOSED) |

`UNKNOWN` is the critical case. It's what you get when the oracle can't determine the answer — network partition, data gap, signing infrastructure problem. An oracle that returns `UNKNOWN` is telling you it cannot confirm the safe state.

The fail-closed contract says: **if you can't verify, don't trade.** An agent that proceeds on `UNKNOWN` is choosing to skip the gate, not to pass it.

---

## The Gate in 5 Lines of Python

```python
from headless_oracle import OracleClient, verify

client = OracleClient()

def safe_to_execute(mic: str = 'XNYS') -> bool:
    receipt = client.get_status(mic)
    return verify(receipt) and receipt['status'] == 'OPEN'
```

Call `safe_to_execute()` before any trade. If it returns `False` — for any reason — halt.

That's it. Five lines between your agent and a $50K mistake at 3am.

---

## Why Cryptographic Signing Matters

A signed receipt isn't just a JSON response. It's a tamper-proof attestation you can pass between agents.

If your execution agent receives a market state receipt from a data collection agent, it doesn't have to trust the data pipeline. It verifies the Ed25519 signature against the oracle's public key. If the signature is invalid — whether from tampering, replay, or corruption — the receipt is rejected.

This is how you build multi-agent financial workflows without a single trusted intermediary.

---

## The Question Isn't Whether Your Agent Will Encounter a Closed Market

Markets close. Exchanges halt. Holidays happen. DST transitions land on trading days.

In 2026 alone, there are over 5,000 schedule edge cases across 28 global exchanges — holidays, early closes, lunch breaks, circuit breakers, DST transitions, weekend rules for Middle Eastern markets that treat Friday as a non-trading day.

Your agent will encounter these. The question is whether it will know.

A pre-trade gate doesn't guarantee profit. It guarantees that when a market is closed, your agent knows it — and stops.

---

## Get Started

- **MCP (Claude/Cursor/Windsurf):** Add `https://headlessoracle.com/mcp` to your MCP config
- **Python:** `pip install headless-oracle`
- **REST:** `GET https://headlessoracle.com/v5/demo?mic=XNYS`
- **Free sandbox key:** `POST https://headlessoracle.com/v5/sandbox`

Documentation: [headlessoracle.com/docs](https://headlessoracle.com/docs)
