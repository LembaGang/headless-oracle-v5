# Trading Halt Capital Loss Simulator — Architecture

## Purpose

A visual web app that pits a naive bot (using `pytz`) against a safe bot (using Headless Oracle)
during a DST transition or SEC circuit breaker, calculating exact financial loss from a wrong
market status signal. The goal: make the cost of the DST bug visceral and concrete.

Target audience: quant/algo developers who understand the risk conceptually but haven't
felt it personally. A simulator with a dollar figure is more persuasive than an article.

---

## Stack Decision

**Streamlit** (not Next.js).

Rationale:
- Solo founder, Python-first audience (quant community is Python)
- Streamlit ships in hours, not days
- The demo is a calculation tool, not a product UI — Streamlit is the right tool
- Deploys free to Streamlit Community Cloud

---

## User Flow

1. User selects **scenario** (dropdown):
   - DST Phantom Hour — US (March 8/9 2026, 2:00–3:00 AM ET)
   - DST Phantom Hour — UK (March 29 2026)
   - SEC Circuit Breaker Level 1 (15-min halt)
   - Exchange Holiday (example: XNYS closed July 4)

2. User sets **position parameters**:
   - Portfolio size: $10,000 → $10,000,000 (log slider)
   - Position size: % of portfolio (1–100%)
   - Asset volatility: Low / Medium / High (maps to σ values)
   - Order type: Market / Limit

3. User clicks **Run Simulation**

4. Side-by-side output:

```
┌─────────────────────────────┬──────────────────────────────────┐
│    NAIVE BOT (pytz)         │    SAFE BOT (Headless Oracle)    │
├─────────────────────────────┼──────────────────────────────────┤
│ Market status: OPEN ✗       │ Market status: CLOSED ✓          │
│ Order submitted: YES        │ Order submitted: NO              │
│                             │                                  │
│ Slippage cost:   -$1,847    │ Slippage cost:   $0              │
│ MEV sandwich:    -$412      │ MEV sandwich:    $0              │
│ Rejected fill:   -$230      │ Rejected fill:   $0              │
│ ─────────────────────────── │ ──────────────────────────────── │
│ TOTAL LOSS:      -$2,489    │ TOTAL LOSS:      $0              │
│                             │                                  │
│ Oracle API cost: $0         │ Oracle API cost: $0.001/mo       │
└─────────────────────────────┴──────────────────────────────────┘

  Your DST bug would have cost you $2,489 on this trade.
  Headless Oracle costs $X/month.
```

---

## Loss Calculation Model

### Slippage (market order into closed/illiquid market)
```python
def slippage_cost(position_value: float, volatility: str) -> float:
    # Spread widens 3–10x during halt/DST transitions
    spread_multiplier = {"low": 3.0, "medium": 5.0, "high": 10.0}[volatility]
    base_spread_pct = 0.001  # 10bps normal spread
    actual_spread = base_spread_pct * spread_multiplier
    return position_value * actual_spread
```

### MEV Sandwich Attack (DeFi / on-chain markets)
```python
def mev_sandwich_cost(position_value: float, asset_type: str) -> float:
    # MEV bots target large orders on low-liquidity chains
    # Conservative estimate: 0.5–2% of order value
    if asset_type == "equity":
        return 0.0  # Not applicable for TradFi
    mev_rate = 0.008  # 80bps on DeFi
    return position_value * mev_rate
```

### Rejected fill / partial fill cost
```python
def rejected_fill_cost(position_value: float, volatility: str) -> float:
    # Order submitted into halt — fills at market reopen with adverse move
    adverse_move_pct = {"low": 0.005, "medium": 0.012, "high": 0.025}[volatility]
    return position_value * adverse_move_pct
```

---

## Scenario Data

### DST Phantom Hour (XNYS, March 8 2026)

The naive bot's `pytz.timezone('US/Eastern').localize()` call returns the wrong UTC
offset during the transition window. The market appears OPEN from 2:00–3:00 AM ET
because the bot is 1 hour off. Reality: NYSE is closed. Any order submitted is either:
- Rejected by the exchange (fee charged, position not opened, price moves against you)
- Routed to dark pool / ATS with extreme spread
- Accepted and filled at the NEXT open with significant gap risk

```python
DST_SCENARIOS = {
    "us_spring_2026": {
        "date": "2026-03-08",
        "window_local": ("02:00", "03:00"),
        "mic": "XNYS",
        "description": "US clocks spring forward. pytz shows OPEN; market is CLOSED.",
        "phantom_duration_minutes": 60,
    },
    "uk_spring_2026": {
        "date": "2026-03-29",
        "window_local": ("01:00", "02:00"),
        "mic": "XLON",
        "description": "UK clocks spring forward. Same phantom hour, London exchange.",
        "phantom_duration_minutes": 60,
    },
}
```

### SEC Circuit Breaker Level 1 (15-min halt)
```python
CIRCUIT_BREAKER_SCENARIOS = {
    "sec_l1": {
        "trigger": "S&P 500 drops 7% intraday",
        "halt_duration_minutes": 15,
        "mic": "XNYS",
        "description": "All trading halted. Naive bot submits orders during halt.",
        "historical_reference": "March 9 2020 (COVID crash)",
    },
}
```

---

## Implementation Plan

### Phase 1: Core calculator (1 day)
- `simulator/calculations.py` — pure functions for slippage, MEV, rejected fill
- `simulator/scenarios.py` — scenario definitions + pre-canned parameters
- `tests/test_calculations.py` — unit tests for loss functions

### Phase 2: Streamlit UI (1 day)
- `app.py` — Streamlit app, scenario selector, parameter inputs, side-by-side output
- `simulator/charts.py` — Altair/Plotly charts for loss breakdown visualization

### Phase 3: Live oracle integration (0.5 day)
- Add a "Live demo" button that hits the real `/v5/demo` endpoint and shows the actual
  current market status with the signed receipt displayed inline

### Phase 4: Deploy + link
- `streamlit deploy`
- Add link from headlessoracle.com/docs#simulator
- Include in r/algotrading post

---

## File Structure

```
halt-simulator/
├── app.py                    # Streamlit entry point
├── requirements.txt          # streamlit, altair, httpx, PyNaCl
├── simulator/
│   ├── __init__.py
│   ├── scenarios.py          # DST + circuit breaker scenario definitions
│   ├── calculations.py       # slippage / MEV / rejected fill formulas
│   └── charts.py             # Altair visualization helpers
└── tests/
    └── test_calculations.py
```

---

## Key UX Decisions

- **Dollar amount is the headline.** The loss figure is in large text. The technical explanation is below the fold.
- **Conservative estimates.** The model intentionally underestimates loss. Users who push back on the numbers are still engaging.
- **Source transparency.** Each loss component links to its reference (academic paper, incident report, exchange rule).
- **No registration.** Instant result. The API key CTA appears after the result is shown.

---

## Gap

This simulator models individual-trade loss. It doesn't model systemic risk: an agent
running 100 concurrent positions across 5 exchanges during a DST transition. That's
the enterprise argument. Document the per-trade loss now; model the portfolio argument
when selling to hedge funds.
