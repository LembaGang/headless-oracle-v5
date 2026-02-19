# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Production-ready
**Test suite**: 66 tests passing
**Last significant work**: V5 rewrite — 3-tier fail-closed, 7 exchanges, multi-key gating, full test suite, .claude/ workflow scaffolding

## Sprint Goals
<!-- Define next milestone here -->
- [ ] TBD — awaiting user direction

## Codebase Health
- 7 exchanges: XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES
- All routes covered: /v5/demo, /v5/status, /v5/schedule, /v5/exchanges, /v5/keys
- DST events to watch in 2026: US (Mar 8, Nov 1), UK/EU (Mar 29, Oct 25)

## Known Issues / Blockers
None currently known.

## Potential Next Work (not committed)
- Additional exchanges (XASX Australia, XBOM India, etc.)
- Rate limiting on public routes
- Webhook/push notification for status changes
- KV override management dashboard
- Consumer SDK / verification library

## Context for Next Session
Start by reading:
1. This file (done)
2. `.claude/rules/00_engineering_standards.md` for hard rules
3. `.claude/rules/10_decisions.md` for architectural context
4. `src/index.ts` if touching core logic
