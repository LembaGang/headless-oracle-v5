# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Production-ready. All engineering complete. Awaiting human marketing tasks.
**Test suite**: 66/66 tests passing
**Last significant work**: Feb 19 2026 — full audit pass, all tests green, all pages live, docs updated
**Next session trigger**: User completes human tasks (article publish, Twitter thread, DST demo repo, outreach)

## Immediate Next Engineering Tasks (when user returns)
1. **DST Exploit Demo repo** — create `github.com/LembaGang/dst-exploit-demo`
   - `vulnerable_bot.py` — breaks on March 8 phantom hour with hardcoded UTC offset
   - `safe_bot.py` — calls /v5/demo, halts if not OPEN, sig verified
   - `README.md` — bad-debt scenario ($13M–$19.5M at OUSG/Ondo 150% CR, 15% drop)
   - This is the single highest-priority engineering task before March 8

2. **Rate limiting on public routes** — after first real user, add Cloudflare Rate Limiting
   - `/v5/demo`: 1000 req/min per IP
   - `/v5/schedule`, `/v5/exchanges`, `/v5/keys`: 500 req/min per IP
   - `/v5/status` already protected by API key

3. **Beta API key provisioning** — when first prospect wants to test /v5/status
   - Add their key to `BETA_API_KEYS` secret via `wrangler secret put BETA_API_KEYS`
   - Format: comma-separated, e.g. `existing_key,new_key_for_ondo`

## Sprint Goals (Pre-March 8)
- [x] 7 exchanges live and tested
- [x] /v5/schedule and /v5/exchanges endpoints live
- [x] KV circuit breaker override system live
- [x] status.html live dashboard
- [x] 66-test suite passing
- [x] CLAUDE.md files updated in both repos
- [x] Risk committee status update written
- [x] Financial model written
- [ ] DST exploit demo repo published on GitHub
- [ ] Phantom Hour article published (human task — Gemini)
- [ ] Twitter/X thread posted (human task)
- [ ] 15 targeted DMs sent (human task — begins Feb 28)

## Codebase Health
- **Worker**: headless-oracle-v5 | main branch | deployed to Cloudflare Workers
- **Frontend**: headless-oracle-web | main branch | deployed to Cloudflare Pages via `npm run deploy`
- **Tests**: 66/66 passing. `.dev.vars` populated with test-only keypair.
- **Public key**: `03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178` (production)
- **All live pages**: headlessoracle.com, /docs, /status, /verify, /terms, /privacy, /llms.txt

## Known Issues / Blockers
- **308 redirects on .html links**: Cloudflare Pages strips `.html` extensions and 308-redirects to
  extensionless URLs (/docs, /status etc). Browsers handle this transparently. Internal `.html` links
  work correctly. Not a functional issue — cosmetic only. Can fix by updating internal hrefs to
  extensionless if desired.
- **No rate limiting on public routes yet**: Acceptable at zero-traffic stage. Add before HN launch.

## DST Calendar — Critical Dates
- **March 8, 2026**: US clocks spring forward (EST→EDT). XNYS + XNAS affected. Phantom hour 2–3am ET.
- **March 10, 2026**: Hacker News "Show HN" launch. Tuesday 10am ET.
- **March 29, 2026**: UK/EU clocks spring forward (GMT→BST / CET→CEST). XLON + XPAR affected.
- **October 25, 2026**: UK/EU fall back. XLON + XPAR.
- **November 1, 2026**: US fall back. XNYS + XNAS.

## Context for Next Session
Start by reading:
1. This file (done)
2. `.claude/rules/00_engineering_standards.md` for hard rules
3. `.claude/rules/10_decisions.md` for architectural context
4. `src/index.ts` if touching core logic
5. First task is almost certainly the DST exploit demo repo
