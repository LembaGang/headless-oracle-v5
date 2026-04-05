# Developer Target List — Autonomous Trading Agent Repos
**Generated: April 5, 2026**  
**Note:** Star counts and commit dates are estimates from training data / public knowledge as of early 2026. Verify before outreach.

---

## Priority 1 — Direct trading agent frameworks with market-hours dependency

| Repo | Stars | Last Commit | Market-Hours Dep? | Maintainer | Outreach Template |
|------|-------|-------------|------------------|------------|-------------------|
| freqtrade/freqtrade | ~28k | Active (weekly) | Yes — `timeframe_to_*` utils + exchange calendar | @xmatthias | B |
| polakowo/vectorbt | ~4.2k | Active | Yes — `pd.DatetimeIndex` + custom calendar | @polakowo | B |
| quantopian/zipline | ~17k | Archived | Yes — `trading_calendar` dep | N/A (archived) | Skip |
| stefan-jansen/machine-learning-for-trading | ~11k | Active | Yes — exchange_calendars dep | @stefan-jansen | A |
| microsoft/qlib | ~15k | Active | Yes — `trade_calendar` in `qlib.data` | @you06 | A |
| AI4Finance-Foundation/FinRL | ~10k | Active | Yes — `StockTradingEnv` uses datetime | @XiaodongSun | A |
| tensortrade-org/tensortrade | ~4.5k | Less active | Yes — `TradingEnvironment` schedule | @adamjedlicka | A |
| pyalgotrade/pyalgotrade | ~4.1k | Archived | Yes — `dataseries` time utils | N/A | Skip |
| hudson-and-thames/mlfinlab | ~3.8k | Active | Partial — financial ML, no live trading | @GrahamBlair | A |
| blankly-finance/blankly | ~1.7k | Less active | Yes — exchange-specific scheduling | @EmersonHan | B |

---

## Priority 2 — AI agent frameworks building trading capabilities

| Repo | Stars | Last Commit | Relevant? | Maintainer | Outreach Template |
|------|-------|-------------|----------|------------|-------------------|
| TauricResearch/TradingAgents | ~3.2k | Active | Yes — multi-agent trading, no market gate | @TauricResearch | A (file issue) |
| virattt/financial-agent | ~2.5k | Active | Yes — LangChain-based stock analysis | @virattt | A |
| langchain-ai/langchain | ~95k | Active | Indirect — finance tools ecosystem | N/A (large project) | C (docs PR) |
| crewAIInc/crewAI | ~23k | Active | Indirect — agent framework used for trading | @joaomdmoura | C (cookbook PR) |
| microsoft/autogen | ~36k | Active | Indirect — multi-agent, trading examples | @ekzhu | C (example PR) |
| assafelovic/gpt-researcher | ~15k | Active | Indirect — research agent, market research | @assafelovic | C |
| OpenBB-Finance/OpenBBTerminal | ~33k | Active | Yes — market data platform, agent-compatible | @DidierRLopes | A |
| QuantConnect/Lean | ~9.5k | Active | Yes — full algo trading engine | @MattMoule | B |
| Huxwell/trading_gpt | ~900 | Less active | Yes — GPT trading agent | @Huxwell | A |
| whittlem/pycryptobot | ~1.9k | Active | Yes — crypto bot, exchange hours | @whittlem | B |

---

## Priority 3 — Crypto/DeFi agents with market-timing logic

| Repo | Stars | Last Commit | Relevant? | Maintainer | Outreach Template |
|------|-------|-------------|----------|------------|-------------------|
| nicksavers/cryptobot | ~1.1k | Less active | Yes — market hours in trade logic | @nicksavers | A |
| coinbase/agentkit | ~4.5k | Active | Yes — Coinbase agent framework | @coinbase | C |
| galoisinc/chainlink-ea | ~600 | Active | Tangential — oracle pattern | @galoisinc | Skip |
| brownie-eth/ape | ~1.3k | Active | Tangential — smart contract framework | @ApeWorX | Skip |
| smol-ai/developer | ~12k | Active | Indirect — code agent | @smol-ai | Skip |

---

## Priority 4 — Quant research repos likely to build agents

| Repo | Stars | Last Commit | Relevant? | Maintainer | Outreach Template |
|------|-------|-------------|----------|------------|-------------------|
| robertmartin8/PyPortfolioOpt | ~4.2k | Active | Partial — portfolio, no live trading | @robertmartin8 | A |
| mementum/backtrader | ~13k | Active | Yes — backtesting + live trading | @mementum | B |
| pmorissette/bt | ~2k | Active | Partial — backtesting framework | @pmorissette | A |
| ranaroussi/yfinance | ~13k | Active | Indirect — data source only | @ranaroussi | A (market gap angle) |
| wilsonfreitas/awesome-quant | ~4.5k | Active | Directory — not a trading bot | @wilsonfreitas | Skip (PR to list) |
| georgezouq/awesome-ai-in-finance | ~3.5k | Active | Directory — not a trading bot | @georgezouq | Skip (PR to list) |
| stefan-jansen/machine-learning-for-trading | ~11k | Active | Yes — ML trading textbook repo | @stefan-jansen | A |

---

## Outreach Prioritization

**Start here (clearest market-hours pain + active development):**
1. TauricResearch/TradingAgents — multi-agent, no market gate, filed issue opportunity
2. freqtrade/freqtrade — 28k stars, active, exchange_calendar dependency
3. AI4Finance-Foundation/FinRL — 10k stars, RL trading agents
4. microsoft/qlib — 15k stars, trade_calendar is a known pain point
5. virattt/financial-agent — smaller, active, LangChain — easy integration story

**Avoid initially:**
- Archived repos (zipline, pyalgotrade)
- Large framework core repos (langchain, autogen) — better as cookbook PRs than DMs
- Pure backtesting repos without live execution plans

---

## Message Tracking

| Repo | Date Contacted | Template Used | Response | Status |
|------|---------------|---------------|----------|--------|
| — | — | — | — | Not started |

---

## Notes

- Verify star counts and commit activity at github.com before outreach — these were accurate as of early 2026 but repos move fast.
- For repos with >10k stars, a PR adding an integration example is more effective than a cold DM.
- For repos with <2k stars and active solo maintainers, direct DM works well.
- The `/v5/demo` endpoint (no auth, no signup) is the lowest-friction entry point. Lead with that.
- Python repos: lead with `pip install headless-oracle` (LangChain/CrewAI tools included).
- TypeScript repos: lead with the MCP config or `npm install @headlessoracle/verify`.
