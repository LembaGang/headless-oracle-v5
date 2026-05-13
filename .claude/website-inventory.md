# Headless Oracle Website — Current-State Inventory

> **Reconciled against live site state 2026-05-13.** Every issue this inventory listed in §7 has been closed in subsequent commits — verify, liability-receipt terminology, PEM framing, DST countdown, `7 venues` → `28 venues`, and the site-wide og-image gap were all addressed by the IETF-announcement polish sprint. **This file is a historical reference artefact, not an action list.** Do not act on it without re-verifying against the live site first.

Read-only inventory of `C:\Users\User\headless-oracle-web` produced 2026-05-04 to feed a follow-up update sprint. **No files in the website folder were modified.** This document is the only artifact written, and it lives in the v5 working notes (`.claude/`), not in the website repo.

Source folder: `C:\Users\User\headless-oracle-web` (branch `main`, working tree clean, last commit `24a5322` 2026-04-15).

---

## 1. Project framework and architecture

| Item | Value |
|---|---|
| Generator | None — hand-authored static HTML, multi-page |
| Bundler | Vite 7 (`vite v7.3.1`) — `vite.config.js` declares 11 HTML entry points |
| Framework | None — vanilla HTML + Tailwind CSS via `cdn.tailwindcss.com` (CDN, not local build) |
| Crypto deps | `@noble/ed25519` ^3.0.0, `@noble/hashes` ^2.0.1 (only used in `verify.html` client-side) |
| Package manager | npm (lock file `package-lock.json` present) |
| Node version | Not pinned (no `.nvmrc`, no `engines` block in `package.json`) |
| Repo type | Git repo, branch `main`, remote tracks origin/main, no submodules |
| Top-level layout | 11 root-level `*.html`, `public/`, `src/`, `dist/` (committed build output), `node_modules/`, `vite.config.js`, `package.json`, `ed25519-public-key.txt` |
| `src/` contents | Vite scaffolding only (`counter.js`, `main.js`, `style.css`, `javascript.svg`) — none of it is referenced from any HTML page. Effectively dead. |
| `dist/` | Committed; contains the built versions of the 11 pages plus `public/` mirror — last built on 2026-05-04 by this inventory's verification step (build succeeded, working tree still clean, so the committed `dist/` matches the rebuild byte-for-byte minus hash drift) |

---

## 2. Deployment configuration

| Item | Value |
|---|---|
| Deploy target | Cloudflare Pages, project name `headless-oracle-web` |
| `wrangler.toml` / `wrangler.jsonc` | **None present in the repo.** Project is referenced by name on the deploy command line. |
| Deploy command | `npm run deploy` → `vite build && npx wrangler pages deploy dist --project-name headless-oracle-web` |
| Auto-deploy via git | Disabled (CLAUDE.md flags this explicitly — pushes to GitHub do NOT update the live site) |
| Routes config | `public/_routes.json` — Pages-side: include `/*`, exclude `*.xml`, `*.txt`, `*.json`, `/.well-known/*` so the Worker can intercept those |
| Required env vars | None used in the website code |
| Build output dir | `dist/` |
| Build commands tested | `npm run build` succeeded in 574ms, working tree remained clean afterward |
| Production routing | Cloudflare Worker (`headless-oracle-v5`) catches `headlessoracle.com/*`; HTML paths are forwarded to Pages via `fetch(request)` passthrough; API paths are answered by the Worker directly |

---

## 3. Page inventory

Eleven Vite-built HTML pages, each registered in `vite.config.js`. Last commit dates from `git log -1 -- <file>`. All pages were touched in the 2026-04-13 nav-and-footer consistency commit (`daedf31`); standards.html was further touched 2026-04-15.

### `/` — index.html (751 lines, last modified 2026-04-13)
- **Title**: "Headless Oracle | Signed Market-Status API for AI Agents"
- **Description**: Homepage — hero, 28-exchange pills, edge-case counters (67/18/8/490/728), live status widget for XNYS, Verifiable Intent positioning ("RFC Submitted · March 17, 2026"), Open Standards card row (SMA/MPAS/APTS), social-proof block (49 countries / ~1,300 edge cases / 0 execution errors), comparison table, failure-mode + fix split, 3-step quickstart, inline sandbox-key generator, demo curl box
- **Internal links** (in order of appearance): `/docs`, `/status`, `/pricing`, `/standards`, `/blog`, `/docs/x402-payments` (×3), `/llms.txt` (×2), `/verify` (×3), `/docs#mcp`, `/openapi.json` (alternate), `/`, `/terms`, `/privacy`, `/refund`
- **External links**: `cdn.tailwindcss.com`, `fonts.googleapis.com`, `fonts.gstatic.com`, `https://github.com/LembaGang` (×2), `https://github.com/agent-intent/verifiable-intent/pulls`, `https://github.com/LembaGang/sma-protocol`, `https://github.com/LembaGang/mpas-spec`, `https://github.com/LembaGang/agent-pretrade-safety-standard`, `mailto:mike@headlessoracle.com`, `https://cdn.paddle.com/paddle/v2/paddle.js`, `https://www.iso20022.org/market-identifier-codes` (×28 in JSON-LD)
- **Date references**: "RFC Submitted · March 17, 2026", "© 2026 Headless Oracle"
- **Stale state markers**: counter card claims "0 execution errors since launch" (no concrete launch date here); JSON-LD `sameAs` lists agent-intent/verifiable-intent + sma/mpas/apts repos but does NOT include any sibling-spec/wallet_state repo or the new verify.headlessoracle.com Pages project; the "RFC Submitted · March 17, 2026" badge is the load-bearing PR #9 reference and now lags two PR revisions (current is v0.5.10-draft per the prompt)

### `/docs` — docs.html (760 lines, last modified 2026-04-13)
- **Title**: "Integration Docs | Headless Oracle V5"
- **Description**: Full API documentation — sticky sidebar with 12 anchors, 28-exchange edge-case banner, exchange table with DST column, endpoint reference (`/v5/status`, `/v5/demo`, `/v5/schedule`, `/v5/exchanges`, `/v5/keys`, `/v5/batch`, `/v5/health`), response schema, verification logic with Python (PyNaCl) and JS (Web Crypto) snippets, fail-closed architecture, MCP integration with Claude Desktop config, billing, Open Standards (SMA/MPAS/APTS), circuit-breaker overrides
- **Internal links**: `/docs` (active), `/status`, `/pricing`, `/standards`, `/blog`, anchor links (`#complexity`, `#quickstart`, `#exchanges`, `#endpoints`, `#health`, `#batch`, `#schema`, `#verification`, `#fail-closed`, `#overrides`, `#mcp`, `#billing`, `#standards`), `/docs/quickstart`, `/docs/x402-payments`, `/openapi.json`, `/llms.txt`, `/v5/exchanges`, `/v5/health`, `ed25519-public-key.txt` (relative — resolves to `/docs/ed25519-public-key.txt` which 404s; should be `/ed25519-public-key.txt`), `/verify`, `/.well-known/oracle-keys.json`, `/v5/account`, `/terms`, `/privacy`
- **External links**: `https://headlessoracle.com/docs/sma-protocol/rfc-001`, `/v5/compliance`, `/v5/conformance-vectors`, `https://github.com/LembaGang/sma-protocol`, `/docs/mpas`, `https://github.com/LembaGang/mpas-spec`, `https://github.com/LembaGang/mpas-spec/blob/main/IMPLEMENTATIONS.md`, `https://github.com/LembaGang/agent-pretrade-safety-standard`, `https://github.com/LembaGang`
- **Stale state**: line 106 reads "weekend days **across 7 venues** per calendar year" — this is the only site-wide hold-out from the 23→28 exchange migration; the same card on index.html line 269 correctly says "across 28 venues"; line 494 inside the Verification Logic section uses a relative URL `ed25519-public-key.txt` which resolves to `/docs/ed25519-public-key.txt` and 404s

### `/status` — status.html (382 lines, last modified 2026-04-13)
- **Title**: "System Status | Headless Oracle V5"
- **Description**: Live status dashboard — sticky nav with global status badge, API health banner, region-grouped exchange grid (Americas 6, Europe 8 incl. XJSE, Asia-Pacific 10, Middle East 4), sample receipt JSON, US/UK DST countdown cards, 3-line Python integration snippet
- **Internal links**: `/`, `/docs`, `/status` (active), `/pricing`, `/standards`, `/blog`, `/verify` (×2), `/llms.txt`, `/terms`, `/privacy`
- **External links**: `https://github.com/LembaGang`, `mailto:mike@headlessoracle.com`, Paddle SDK
- **Stale state**: DST countdown targets `2026-03-08T07:00:00Z` (US) and `2026-03-29T01:00:00Z` (UK/EU) — both already in the past as of the 2026-05-04 inventory date; the JS will display "Passed" but the visual treatment still highlights them as upcoming events. The fall-back DST events (Oct 25 / Nov 1) are not yet in the page. Region grouping puts Johannesburg (XJSE) under "Europe" — geographically wrong; standards.html correctly lists it under Africa.

### `/pricing` — pricing.html (440 lines, last modified 2026-04-13)
- **Title**: "Pricing | Headless Oracle"
- **Description**: 6 pricing cards (Sandbox, Free Tier, x402 pay-per-use, Credits, Builder, Pro) plus Protocol/Enterprise contact card, instant-key section with `agent_id` input, "all plans include" block, demo CTA
- **Internal links**: `/`, `/docs`, `/status`, `/pricing` (active), `/standards`, `/blog`, `/llms.txt`, `/terms`, `/privacy`, `/refund`
- **External links**: `https://github.com/LembaGang`, `mailto:mike@headlessoracle.com?subject=Protocol%20tier%20inquiry`, Paddle SDK
- **Stale state**: line 209 references `/v5/keys/request` (legacy email-delivery endpoint) — present in the worker, but the more agent-friendly path is `/v5/keys/instant`; the "All plans include" block claims "~1,300 schedule edge cases handled annually" matching index.html

### `/verify` — verify.html (261 lines, last modified 2026-04-13) **[HIGH-PRIORITY UPDATE TARGET]**
- **Title**: "Receipt Verifier | Headless Oracle"
- **Description**: Browser-side Ed25519 verifier
- **Internal links**: `/docs`, `/status`, `/pricing`, `/standards`, `/blog`, `ed25519-public-key.txt` (relative; resolves to `/ed25519-public-key.txt`), `/llms.txt`, `/terms`, `/privacy`, `/`
- **External links**: `https://github.com/LembaGang`, `mailto:mike@headlessoracle.com`, `https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto`, `cdn.tailwindcss.com`, fonts, Paddle SDK
- **Verification implementation**:
  - Pure browser, no framework. `window.crypto.subtle` with `name: "Ed25519"` for verify.
  - On load: sets a `FALLBACK_PUBLIC_KEY` constant (`03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178`) immediately, then asynchronously fetches `https://headlessoracle.com/v5/keys` and overwrites with the live `keys[0].public_key` if available.
  - Browser capability check imports a 32-byte zero key with `name: "Ed25519"` and shows a warning banner on failure (Chrome 113+ / Firefox 128+ / Safari latest).
  - Canonicalization: alphabetical key sort, `JSON.stringify` with default no-whitespace, signature stripped from the receipt before signing — matches the worker's `signPayload`.
  - Public key import: branches on whether the trimmed key matches `/^[0-9a-fA-F]{64}$/` (raw hex) — uses `subtle.importKey("raw", ...)`. Otherwise treats it as PEM, base64-decodes the body between `-----BEGIN PUBLIC KEY-----` markers, and picks `format = binaryKey.length > 32 ? "spki" : "raw"`. Comments label this PEM/SPKI branch as "legacy fallback".
  - Signature decode: hex pair-split into `Uint8Array`.
- **"Liability Receipt" terminology**:
  - Line 51: `<h1>Verify Liability Receipt</h1>` — page-level H1
  - Line 63: `<label>Liability Receipt (JSON)</label>` — textarea label
  - These are the only two occurrences of "Liability Receipt" on the entire site (grep confirmed)
- **PEM key handling**:
  - Line 74 label: `Oracle Public Key (PEM Format)`
  - Line 77 placeholder: full PEM block
  - Lines 184–203: full PEM/SPKI parsing fallback path
  - The page DOES support hex out of the box (lines 187–192) — PEM is only the fallback — but the user-facing label and placeholder both still advertise PEM as the primary format.
- **Internal links pointing TO `/verify`**: `index.html:239`, `index.html:431`, `index.html:508` (hidden by default), `index.html:542`, `status.html:93`, `status.html:98`, `status.html:159`, `docs.html:552`, `pricing.html` (footer), `standards.html:304`, `standards.html` (footer), `terms.html` (likely — not directly checked but conventional)

### `/standards` — standards.html (351 lines, last modified 2026-04-15) **[NEWEST PAGE]**
- **Title**: "Standards & Compliance | Headless Oracle"
- **Description**: SMA explainer, regulatory alignment (Ed25519, 60s TTL, ISO 10383, fail-closed), multi-oracle verification (3+ oracles, N-1 fault tolerance), 28-exchange grid by region (Americas 3, Europe 6, MENA 3, Africa 1, Asia-Pacific 10, Derivatives 5), agentic-economy section, developer resource cards, bottom CTA
- **Internal links**: `/`, `/docs`, `/status`, `/pricing`, `/standards` (active), `/blog`, `/llms.txt`, `/openapi.json`, `/terms`, `/privacy`, `/refund`, `/ed25519-public-key.txt`, `/docs/specifications/multi-oracle-consensus-v1`, `/v1/verification/multi-oracle-guide`, `/mcp`, `/docs/x402-payments`, `/docs/quickstart`, `/v5/demo?mic=XNYS`, `/verify`, `/.well-known/x402.json`
- **External links**: `https://github.com/LembaGang`
- **Stale state**: line 295 reads "73 paths" in the OpenAPI card description — the v5 worker is now at 81 paths per `90_active_priorities.md`; this is the only stale path-count claim on the website

### `/blog` — blog.html (128 lines, last modified 2026-04-13)
- **Title**: "Blog | Headless Oracle"
- **Description**: 4 article cards, each linking to dev.to (one specific URL, three to the author's profile fallback)
- **Internal links**: standard nav + footer
- **External links**: `https://dev.to/lembagang/i-built-an-mcp-server-that-signs-market-data-for-28-exchanges-i8a` (real article URL), `https://dev.to/msebenzi` ×4 (author profile, used as fallback for three articles whose URLs are not yet wired up)
- **Stale state**: 3 of 4 article cards point to the author profile rather than specific article URLs — this is a content-creation gap rather than a stale claim

### `/terms` — terms.html (563 lines, last modified 2026-04-13)
- **Title**: "Terms of Service | Headless Oracle"
- **Effective date**: line 306 — "Last Updated: 27 February 2026"
- **Description**: Long-form ToS with custom serif typography (Source Serif 4) — fail-closed obligation, attestation-only classification, zero execution-outcome liability, JSON-canonical signature requirement
- **Embedded `<script type="text/llms.txt">`** (lines 19–25) summarising the terms for crawlers
- **Stale state**: "Last Updated: 27 February 2026" — over two months stale relative to inventory date but unlikely to need a content update unless a clause changed

### `/privacy` — privacy.html (298 lines, last modified 2026-04-13)
- **Effective date**: line 191 — "Last updated: March 2, 2026"
- **Description**: Standard privacy policy referencing Paddle, Cloudflare, Supabase, Resend as sub-processors

### `/refund` — refund.html (230 lines, last modified 2026-04-13)
- **Effective date**: line 169 — "Last updated: March 2, 2026"
- **Description**: Refund policy

### `/traction` — traction.html (264 lines, last modified 2026-04-13)
- **Title**: "Live Traction | Headless Oracle"
- **Description**: Live metric tiles fed from `GET /v5/traction`, plus three "secondary" cards (SMA Protocol, Verifiable Intent RFC `submitted`, x402 Micropayments), halt-monitor status, raw JSON dump
- **Internal links**: standard nav, `/docs/x402-payments`
- **External links**: `https://github.com/LembaGang/sma-protocol`, `https://github.com/agent-intent/verifiable-intent`, `https://headlessoracle.com/v5/traction`
- **Stale state**: "Verifiable Intent RFC: submitted" badge is the same March 17 framing as index.html — needs updating to reflect the four-patch v0.5.10-draft stack just landed

---

## 4. Content surfaces beyond pages

### `/llms.txt`
**NOT served by the website.** CLAUDE.md is explicit: `headlessoracle.com/llms.txt` is intercepted by the Worker (`headless-oracle-v5/src/index.ts`'s `LLMS_TXT` constant) and the website repo must NOT carry an `llms.txt` file. None present in this repo. Excluded from Pages routing via `_routes.json`.

### `/openapi.json`
Same as above — served by the Worker. The website's `<link rel="alternate">` tags simply point at it. Standards.html line 295 hardcodes "73 paths" which is now stale (Worker is at 81).

### `/sitemap.xml` (`public/sitemap.xml`)
Served by Pages (excluded from SPA fallback by `_routes.json`). Contains 8 URLs, all dated `2026-03-22` (`<lastmod>`). Missing entries: `/standards`, `/blog`, `/verify`, `/privacy`. Has `/docs/x402-payments` but not `/docs/quickstart`. Linked from `robots.txt`.

### `/robots.txt` (`public/robots.txt`)
Standard `Allow: /llms.txt`, `/openapi.json`, `/.well-known/`, plus 5 Worker API paths (`/v5/demo`, `/v5/schedule`, `/v5/exchanges`, `/v5/keys`, `/v5/health`). `Disallow:` empty. Sitemap URL declared.

### `/ed25519-public-key.txt`
Two identical copies in the repo:
- `ed25519-public-key.txt` (root) — 11 lines
- `public/ed25519-public-key.txt` — same 11 lines, served at `/ed25519-public-key.txt`

Content:
```
HEADLESS ORACLE - PUBLIC KEY REGISTRY (V5 BETA)
KEY_ID: key_2026_v1
ALGORITHM: Ed25519
STATUS: ACTIVE
CREATED: 2026-02-16
HEX: 03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178
BASE64 (RAW): A9wnmToskIVs3rReIorAZfGPafCTPJF7IzbB51cS8Xg=
PEM FORMAT (SPKI): -----BEGIN PUBLIC KEY----- MCowBQYDK2VwAyEAA9wnmToskIVs3rReIorAZfGPafCTPJF7IzbB51cS8Xg= -----END PUBLIC KEY-----
```
"V5 BETA" is now stale — the product has been live since at least Day 1, and the Worker's CLAUDE.md treats v5 as production. The file actively advertises PEM format which is the format the v5 spec is moving away from.

### `/.well-known/oracle-keys.json`
**NOT in this repo.** Served by the Worker (RFC 8615). Excluded from Pages by `_routes.json`'s `/.well-known/*` rule. docs.html links to it directly at line 633.

### `/.well-known/x402.json`, `/.well-known/agent.json`, `/.well-known/mcp/server-card.json`, `/.well-known/ai-plugin.json`
All served by the Worker. None present in the website repo. Standards.html links to `/.well-known/x402.json`.

### `/AGENTS.md`, `/skill.md`, `/v5/conformance-vectors`, `/v5/compliance`, `/docs/sma-protocol/rfc-001`, `/docs/mpas`, `/docs/specifications/multi-oracle-consensus-v1`, `/v1/verification/multi-oracle-guide`
All served by the Worker. Various pages link to them.

### Public integration guides served by Pages
Inside `public/docs/`:
- `public/docs/quickstart/index.html` — 181 lines — Claude Code `.mcp.json` setup; sandbox + auth variants; uses sandbox limit "200 calls free" which matches the worker
- `public/docs/x402-payments/index.html` — 300 lines — full x402 micropayment guide
- `public/docs/integrations/anthropic-claude/index.html` — 264 lines
- `public/docs/integrations/bun/index.html` — 248 lines — uses `@headlessoracle/verify` SDK, hits `/v5/keys` for public key
- `public/docs/integrations/datacamp-workspace/index.html` — 287 lines — references `/v5/keys/request` (legacy email-delivery endpoint, line 89)
- `public/docs/integrations/langgraph/index.html` — 220 lines — uses Python `headless_oracle` SDK

Each of these is a self-contained Vite-publicDir asset (passes through `dist/` verbatim).

### `public/js/paddle-init.js`
Single shared Paddle.js initializer; `<script src="/js/paddle-init.js">` is included on every HTML page (even those that don't trigger checkout — e.g. blog, verify). Cleanly extracted from inline scripts per commit `c3eef5a`.

---

## 5. Navigation and chrome

**Top navigation** is identical across pages (the 2026-04-13 consistency commit standardised this) — order: Docs · Status · Pricing · Standards · Blog · GitHub. Logo links to `/`. The current page is rendered as `text-white font-semibold` instead of an `<a>`-styled link.

**Footer** order varies slightly per page (some include Refund, some Verify, status.html omits Refund and Verify). Conventional order: Home · Docs · Pricing · Standards · Blog · llms.txt · Terms · Privacy · Refund · GitHub · email. Verify and Status are sometimes added.

**Sidebar / secondary nav**: only `docs.html` has a sticky aside with 12 in-page anchors plus 2 "→" outbound links (MCP Setup, x402 Payments).

---

## 6. Verification page (deep-dive)

Already covered in §3 above and §10 below. Key extracts repeated for the update sprint's convenience:

- **Source path**: `verify.html` (root, 261 lines)
- **Distinguishing terminology**: "Liability Receipt" appears at lines 51 and 63 only; nowhere else on the site
- **PEM advertised** at lines 74 (label) + 77–79 (placeholder); PEM/SPKI parsing path at lines 194–203 (already labelled "legacy fallback")
- **Hex path** is the primary, fully working path — the page just doesn't surface it in the UI
- **Inbound links to `/verify`**: index.html (×4), status.html (×3), docs.html (×1), standards.html (×1), pricing.html footer (×1)
- **Crypto algorithm**: Ed25519 via Web Crypto, canonical alphabetical-sort + minified `JSON.stringify`, signature stripped before canonicalization — implementation matches the worker exactly

---

## 7. Stale content audit

| # | Location | Stale claim | Inventory note |
|---|---|---|---|
| 1 | `verify.html:51` | `<h1>Verify Liability Receipt</h1>` | "Liability Receipt" terminology is being retired |
| 2 | `verify.html:63` | `<label>Liability Receipt (JSON)</label>` | Same — second of two occurrences |
| 3 | `verify.html:74` | "Oracle Public Key (PEM Format)" label | PEM is being de-prioritised; hex / oracle-keys.json is the canonical surface |
| 4 | `verify.html:77-79` | PEM placeholder text | Same |
| 5 | `verify.html:194` | Comment "PEM/SPKI format (legacy fallback)" | Code already labels it legacy — UI hasn't caught up |
| 6 | `ed25519-public-key.txt` (×2) | "(V5 BETA)" header | Product is past beta |
| 7 | `ed25519-public-key.txt` (×2) | PEM block dominates the artifact | The PEM section should be retired or de-emphasised |
| 8 | `docs.html:106` | "weekend days **across 7 venues**" | Should be 28 — only stale 7-exchange claim left on the site |
| 9 | `docs.html:494` | `<a href="ed25519-public-key.txt">` (relative) | Resolves to `/docs/ed25519-public-key.txt` and 404s |
| 10 | `standards.html:295` | "73 paths" in OpenAPI card | Worker is now at 81 paths |
| 11 | `index.html:281` | "RFC Submitted · March 17, 2026" badge | The PR is now at v0.5.10-draft on a four-patch stack — the framing should reflect the current revision |
| 12 | `traction.html:118` | `<span class="badge">submitted</span>` for Verifiable Intent RFC | Same — needs current PR-state framing |
| 13 | `status.html:111-128` | DST countdown targets `2026-03-08` and `2026-03-29` | Both already passed; cards still treat them as upcoming. Fall-back DST events (Oct 25 / Nov 1) are absent. |
| 14 | `status.html:184-216` | XJSE listed under Europe in the region grouping | Geographically wrong; standards.html correctly puts JSE under Africa |
| 15 | `public/sitemap.xml` | Missing entries for `/standards`, `/blog`, `/verify`, `/privacy`; missing `/docs/quickstart` | `<lastmod>` values are all `2026-03-22` |
| 16 | `pricing.html:209` + `public/docs/integrations/datacamp-workspace/index.html:89` | References `/v5/keys/request` (legacy email-only) | `/v5/keys/instant` is the agent-friendlier path and what the rest of the site already uses |

**Items missing entirely from the site** (for the update sprint to add):
- Any reference to **`verify.headlessoracle.com`** — the standalone verifier shipped today is not linked from the main site
- Any reference to the **InsumerAPI / wallet_state sibling-spec PR #22** at `agent-intent/verifiable-intent`
- Any reference to **`github.com/headlessoracle/demo-agent`** (per the prompt — needs sourcing)
- Any reference to **`github.com/headlessoracle/essays`**
- Any reference to a forthcoming **IETF Internet-Draft** in the family/vocabulary layer
- Any reference to **RFC 6982 Appendix D Implementation Status** (verify.html and standards.html mention RFCs 8032 and 8615 only)
- An explicit operational-since date (the prompt names `2026-02-18` as canonical; the site only carries "since launch" in counters and the public-key file's `CREATED: 2026-02-16` which is the *signing-key* creation date, not the operational-since date)

---

## 8. Build, test, deploy state

| Item | Value |
|---|---|
| `npm run build` | Succeeded in 574ms; 22 modules transformed; `dist/` rebuilt; working tree remained clean (committed `dist/` matches the rebuild) |
| `npm run dev` | Not run (would block); Vite scaffolding is intact and the site pages don't depend on Vite features beyond the multi-entry build, so dev mode should work |
| Tests | None — no test runner, no test files, no test script in `package.json` |
| Last deploy | Cannot be determined from the repo alone — Pages keeps deploy history in Cloudflare's dashboard. Last commit on `main` is `24a5322` (2026-04-15). Per CLAUDE.md, deploys are manual via `npm run deploy`, so the live site reflects whichever revision was last `wrangler pages deploy`-ed, not necessarily HEAD. |
| Uncommitted changes | None — `git status` clean, `git diff --stat` empty |
| Untracked | None |

---

## 9. Recommended update scope

Order is roughly by priority (verify.html first, since the prompt names it as the highest-value change target).

### A. `verify.html` content updates
1. **Line 51**: replace `<h1>Verify Liability Receipt</h1>` with the new SMA-aligned title (e.g. `<h1>Verify Signed Market-State Attestation</h1>` — confirm wording with MBeenzi).
2. **Line 63**: replace `<label>Liability Receipt (JSON)</label>` with matching new label (e.g. `Signed Receipt (JSON)`).
3. **Lines 74, 77–79**: change the public-key label/placeholder primary format from PEM to the hex or `/.well-known/oracle-keys.json` flow:
   - New label: `Oracle Public Key (hex)` or `Public Key Source` (with the dropdown of `oracle-keys.json` JWK / hex)
   - New placeholder: `03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178`
   - Help-text under the box: link to `/.well-known/oracle-keys.json` (RFC 8615) instead of the .txt registry
4. Keep the PEM/SPKI parsing branch (lines 184–203) for backward compatibility — this is a UI/copy change only, the JS already prefers hex.
5. **Add a banner** linking to `verify.headlessoracle.com` so readers know the standalone verifier exists.
6. (Confirm with MBeenzi) **Update `<meta name="description">` and OG tags** to drop "Liability" if those still surface in social previews.

### B. `verify.html` inbound link audit
Pages that link to `/verify` and currently say "Verify Liability Receipt" or imply the old framing in their anchor text need a quick pass:
- `index.html:239` ("Verify this receipt yourself (no server needed) →")
- `index.html:431` ("Verify any receipt yourself — no server needed →")
- `index.html:508` (hidden "Verify This Receipt")
- `status.html:93,98,159` (sample-receipt verify links — copy is already neutral)
- `docs.html:552` ("browser-based verifier" — already neutral)
- `standards.html:304` (Receipt verifier card description — already neutral)
- The footers — universally neutral "Verify"

The anchor text itself does not say "Liability" anywhere — only the destination's H1 does — so footer/link copy is safe to leave alone. Verify this assumption holds before updating.

### C. PEM key file retirement
Both `ed25519-public-key.txt` and `public/ed25519-public-key.txt` need a header pass:
- Drop "(V5 BETA)" — replace with "(production)" or remove the qualifier
- Add a note pointing to `/.well-known/oracle-keys.json` as the canonical machine-readable source
- Keep the PEM block (it is valid and still in agent training data) but de-emphasise it visually (move below hex)

If MBeenzi prefers, retire the .txt entirely and 301 the route to `/.well-known/oracle-keys.json` — this requires a Worker route change, not a Pages change.

### D. `docs.html` corrections
1. Line 106: change `across 7 venues` to `across 28 venues` (one-line fix; the only stale 7-exchange claim left).
2. Line 494: change `<a href="ed25519-public-key.txt">` to `<a href="/ed25519-public-key.txt">` (absolute path so `/docs` doesn't 404 the link).

### E. `standards.html` page-count correction
1. Line 295: change `73 paths` to the current count (per `90_active_priorities.md` it is 81).

### F. Verifiable Intent positioning refresh (index.html + traction.html)
1. `index.html:281` — change badge text from "RFC Submitted · March 17, 2026" to reflect the current PR state (e.g. "PR #9 · v0.5.10-draft · April 2026"). Confirm exact wording with MBeenzi.
2. `index.html:307` — update the GitHub link title accordingly.
3. `traction.html:118` — replace `submitted` badge with current state.
4. **Add a section or card** on index.html for the sibling-spec **PR #22** (`environment.wallet_state` / Douglas Borthwick) — current site is silent on the sibling spec.
5. **Add a card** on standards.html for the forthcoming IETF Internet-Draft (family/vocabulary layer scope) once MBeenzi confirms framing.

### G. `status.html` DST card refresh
1. Replace the spring-forward 2026-03-08 / 2026-03-29 cards with the upcoming fall-back transitions (2026-10-25 EU, 2026-11-01 US) — countdown JS at line 355 needs the new target dates and the card copy at lines 111–129 needs to flip.
2. Move XJSE from "Europe" to a new "Africa" group (matching standards.html), or rename the group to "EMEA" so it's geographically accurate.

### H. Sitemap repair
1. Add `<url>` entries for `/standards`, `/blog`, `/verify`, `/privacy`. Optionally add `/docs/quickstart`.
2. Bump every `<lastmod>` to the actual change date (2026-04-13 / 2026-04-15) or to today (2026-05-04).
3. Set `/standards` priority to 0.8 (matches docs/pricing/status); set `/verify` to 0.7.

### I. Legacy `/v5/keys/request` references
Decide whether to retain. If keeping the email-delivery flow, leave as is. If not:
1. `pricing.html:209` — replace inline curl with `/v5/keys/instant`.
2. `public/docs/integrations/datacamp-workspace/index.html:89` — same.

### J. Blog content gap
Three of four blog cards link to `https://dev.to/msebenzi` (author profile fallback) instead of specific articles. Either:
- Surface the actual article URLs once published, or
- Reduce the blog page to the single article that has a real URL until more land

This is content/decision-driven — needs MBeenzi input.

### K. `index.html` hero pill / tagline update (optional, MBeenzi confirms)
The "x402 · Agents can pay for themselves · 0.001 USDC/req" pill is current. The "0 execution errors since launch" social-proof claim is unverifiable from the page — consider replacing with a concrete metric driven from `/v5/traction`.

### L. Items requiring MBeenzi input before automated update
- Exact replacement copy for "Liability Receipt" → ? (proposed: "Signed Market-State Attestation" or "Signed Receipt")
- Whether to retire `ed25519-public-key.txt` entirely or keep as a hybrid hex+PEM display
- Verifiable Intent badge text — exact PR-stack revision and framing
- Whether to add `verify.headlessoracle.com` as a dedicated nav item or only as a banner on `/verify`
- Whether `github.com/headlessoracle/demo-agent` and `github.com/headlessoracle/essays` are public repositories yet (the prompt mentions them as "likely missing entirely")
- Whether the IETF Internet-Draft has a citable identifier yet
- Whether to publish an "operational since 2026-02-18" date prominently — and where
- Sitemap and OpenAPI path-count cadence: who owns refreshing these on each Worker deploy?

---

## Estimated time for the follow-up update sprint

- Items A + D + E + I (mechanical find-and-replace + ~20 lines of copy in verify.html): **~25 minutes** including build verification
- Item C (PEM file header rewrite, both copies): **~10 minutes**
- Item F (Verifiable Intent positioning refresh + new cards for PR #22 / IETF / verify subdomain): **~45 minutes** — content-heavy, needs MBeenzi input on copy first
- Item G (DST card refresh + region regrouping): **~20 minutes**
- Item H (sitemap repair): **~10 minutes**
- Items J + K + L: blocked on MBeenzi decisions; once unblocked, **~30 minutes** combined

**Total: ~2 hours of execution time once copy decisions are locked in**, of which ~1 hour is mechanical and the other ~1 hour depends on MBeenzi's input on Item L.

The build is fast (~600ms), no tests to run, and deploy is a single `npm run deploy` away. The risk is low and reversible — every change is a content edit; no JS/crypto behaviour change is required for the verify-page rebrand because hex is already the primary code path.
