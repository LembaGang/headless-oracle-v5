# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Post-IETF-I-D-filing. Agent Readiness Stack fully shipped (2026-05-20 discovery surface + 2026-05-21 follow-ups; loose ends closed). Standards authorship remains the load-bearing positioning; engineering velocity is in service of that.
**Day**: 85 (2026-05-21 — three small follow-ups: robots Sitemap directive, MCP-Protocol-Version header, Agenstry A2A audit log)
**Test suite**: 1058/1058 in `wrangler.toml` TEST_COUNT + 11/11 (smoke) + 24/24 (SDK) + 26/26 (LangGraph template) + 17/17 (ai-hedge-fund). +2 since the Agent Readiness ship (May 21 follow-ups).
**Worker**: src/index.ts ~13,700 lines (API-only, zero HTML). Live version: `e381e5e4` (deployed 2026-05-21 — May 21 follow-ups).

### What's Done (Day 85 — May 21 follow-ups, 2026-05-21)

May 21 — three small follow-ups landed. Sitemap directive, MCP-Protocol-Version header, Agenstry A2A finding documented as audit-log §11. No A2A implementation planned. Discovery-surface signing remains deferred.

- **robots.txt `Sitemap:` directive** (commit `10304ed`, worker `24dcc8c5`) — `Sitemap: https://headlessoracle.com/sitemap.xml` now declared in `ROBOTS_TXT`. Closes the AGENT_READINESS.md §10 Discoverability follow-up. +1 test (1056 → 1057).
- **MCP-Protocol-Version response header fix** (commit `6cb332e`) — `POST /mcp` HTTP response header corrected from the non-standard `MCP-Version` to the spec name `MCP-Protocol-Version`; body field unchanged. +1 test (1057 → 1058).
- **Agenstry A2A finding** (AGENT_READINESS.md §11) — the §5 "out-of-scope finding" was reframed after the 2026-05-21 re-crawl: Agenstry grades HO as an **A2A agent, not an MCP server**, so the 35/100 F reflects A2A non-conformance, not MCP. MCP is spec-compliant against `2024-11-05`. **No A2A implementation planned**; discovery-surface signing (the standing gap) **remains deferred**. Audit-log entry only — the only code change from the investigation is the header fix above.
- This entry is a docs-only commit; the two worker changes (`10304ed`, `6cb332e`) were already committed, gated, and deployed (`e381e5e4`).

### What's Done (Day 84 — Agent Readiness Stack, 2026-05-20)

Shipped the static agent-discovery surface (commits `54700a0` + `5639a23`, worker `dde5c165`, pushed to main, both SSH-signed). Gate green: tsc 0 / npm test 1056 / wrangler dry-run 0. **No signing, canonical-payload, or x402-settlement changes — route additions only.** Live-verified against production. **Audit log of record: `AGENT_READINESS.md`.**

- **`/.well-known/mcp`** — extensionless alias to the MCP server card (was 404; AgenstryBot probes the extensionless form first).
- **Agent Skills (agentskills.io 0.2.0)** — `/.well-known/agent-skills/index.json` + 5 `SKILL.md` docs: `verify-receipt`, `read-market-state`, `subscribe-halts`, `pay-with-x402`, `mcp-tool-catalog`. Index digests computed at request time from the served bytes (drift-proof; test-enforced).
- **`/.well-known/api-catalog`** — RFC 9727 / RFC 9264 linkset harvested from `AGENT_JSON.rest_api.endpoints`.
- **`/agent-directory.json`** (+ worker route in `wrangler.toml`) and **`/.well-known/agent-directory.json`** — fixes the prior 200 `text/html` Pages soft-404 on `/agent-directory.json` (an agent was getting a success code with an HTML body).
- **robots.txt** — Cloudflare `Content-Signal: ai-train=no, ai-input=yes, search=yes` + explicit `Allow` for ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, ChatGPT-User, AgenstryBot, Open402DirectoryCrawler, YellowMCP-HealthChecker. Existing directives preserved.
- **Deferred**: root `/` `Link` headers — root is Pages-served; needs a `_headers` file in `headless-oracle-web` (AGENT_READINESS.md §7).
- **Flagged, not fixed**: the CLAUDE.md / `02_architecture_map.md` "catch-all" routing claim is inaccurate (FIXME left in CLAUDE.md; AGENT_READINESS.md §8). (The robots.txt `Sitemap:` directive flagged here, AGENT_READINESS.md §10, **shipped 2026-05-21** — commit `10304ed`; see Day 85 above.)

### Next engineering priorities (added 2026-05-20)

These are two **separate** items surfaced by the Agent Readiness ship. Do not conflate them.

- **(a) Agenstry conformance — RESOLVED 2026-05-21 (AGENT_READINESS.md §11).** Root cause confirmed after the 2026-05-21 re-crawl: Agenstry grades the domain as an **A2A agent, not an MCP server**. The two failing criteria — *Live JSON-RPC* (requires an A2A `message/send` handler) and *Protocol Version* (the A2A AgentCard field) — are A2A concepts. The MCP endpoint is spec-compliant against `2024-11-05` (`initialize` returns `result.protocolVersion`, `serverInfo`, `capabilities`; `tools/list` returns a valid 4-tool result), so the 35/100 F reflects A2A non-conformance, not an MCP gap. **Decision: do not implement A2A** — the AgentCard is descriptive metadata, not a commitment to serve A2A's JSON-RPC method surface; presenting HO as a first-class A2A agent is a separate strategic question, deliberately deferred. The only code change from the investigation: MCP HTTP response header corrected `MCP-Version` → spec-name `MCP-Protocol-Version` (commit `6cb332e`), body field unchanged.
- **(b) Discovery-surface signing (the standing gap from this ship).** Every `.well-known` document, the agent-skills digests, the api-catalog, and the agent-card payload trace to one signing identity an agent must take on trust. Receipts are Ed25519-signed; the discovery surface that *points to* them is not — at agent scale, a MITM-tampered discovery document is a real attack surface. Investigate a JWS envelope or detached-signature pattern using the existing Ed25519 key (`kid 8lN8jsy9MHN7aqttziG6W3wBs0wVvdCfHi_eBoTqbBc`) for at least the agent-skills index and the api-catalog. **Defer** until A2A/MCP standardize a discovery-surface signing convention, or until acquirer-diligence pressure forces the call — building ahead of the standard risks a throwaway format.

### What's Done (Day 77 — IETF I-D announcement deploy)

- **IETF Internet-Draft filed 2026-05-11**: `draft-borthwick-msebenzi-environment-state-00` live at <https://datatracker.ietf.org/doc/draft-borthwick-msebenzi-environment-state/>. 43 pages, Independent Submission / Informational track, co-authored with Douglas Borthwick (InsumerAPI). Family-definition spec for the `environment.*` constraint family. Expires 2026-11-11. Documented in `CLAUDE.md → Current State` and `CLAUDE.md → Active standards work`. This is the artefact that makes HO the named reference implementation rather than one of many candidates.
- **Essay infrastructure on headlessoracle.com**: `/essays/` index + two HTML-rendered essays now live — `/essays/environment-internet-draft` (announcement of the I-D filing, v1.0.0) and `/essays/trust-primitive` (architectural argument, v1.6.4). Each page carries full OG/Twitter/canonical/article metadata. Canonical markdown sources at `github.com/headlessoracle/essays`. Commits: `e468b05` (essays repo, tag `v1.0.0-environment-internet-draft-2026-05-13`, SSH-signed) and `65b81df` (headless-oracle-web).
- **Site-wide og-image.png shipped**: `https://headlessoracle.com/og-image.png` returns 200 image/png (1200×630, 28.85 KB) instead of the pre-existing text/html SPA fallback. Closes the broken-preview-card gap that affected every page advertising the URL. Generated via PowerShell + System.Drawing (no new deps). Commits `b1de21d` + `6e78a0e` on headless-oracle-web.
- **Homepage + traction.html "I-D Filed · May 11, 2026" badges**: clickable, link to `/essays/environment-internet-draft`. Replaces the "Verifiable Intent RFC: submitted (March 17 2026)" framing flagged as stale in the prior session's inventory. Bonus fix on traction.html: removed JS that was overwriting the static badge text from the `/v5/traction` API field on page load.
- **Standards page card updated** (prior session, 2026-05-12): the "forthcoming IETF Internet-Draft" card on `/standards` now reads "filed · May 11, 2026" with a clickable link to the datatracker.
- **Worker SITEMAP_XML + ROBOTS_TXT include essays + standards**: commit `59d9099` (SSH-signed). Deployed worker version `be0c8f19`. Live-verified — `/sitemap.xml` now lists `/essays/`, `/essays/environment-internet-draft`, `/essays/trust-primitive`, `/standards`; `/robots.txt` has explicit `Allow: /essays/` and `Allow: /standards`. **Committed with `--no-verify`** after explicit MBeenzi approval — the worker pre-commit hook had hung 40+ min on `getaddrinfo(): #11001 No such host is known.` for the Supabase URL inside vitest-pool-workers (environment flake, unrelated to the change). See `CLAUDE.md → Documented bypass class (2026-05-13)` for the policy.
- **`.claude/website-inventory.md` reconciled**: every item it listed (Liability Receipt terminology, PEM framing, `7 venues` typo, stale DST countdown, og-image gap) is now closed. File kept as a historical artefact with a reconciliation banner at the top. Next session should not act on it without re-verifying live state first.
- **Documentation updated** (this commit): `CLAUDE.md → Current State`, `CLAUDE.md → Active standards work`, `CLAUDE.md → Working style → Documented bypass class`, `CLAUDE.md → File Layout` (inventory note), this file's `Current Status` block, and the website-inventory banner.

### In flight today (2026-05-13)

- **LinkedIn + X announcement posts** for the I-D filing — being drafted in the current strategic session. Will link to `https://headlessoracle.com/essays/environment-internet-draft` as canonical URL. Both surfaces ship today or 2026-05-14. Not yet posted.

### Strategic carry-forward (sourced from session prompt 2026-05-13, not previously in this file)

These items were named by MBeenzi as active strategic priorities outside the engineering active-list. They are captured here so the next session — strategic or engineering — has them in view. They are not currently sourced from any committed doc; if any has shifted status since the prompt was authored, the strategic memory file or MBeenzi is the source of truth.

- **SA tax counsel retention** — 30-day window opened 2026-05-09, clock is running.
- **Delaware C-corp parent target** — June 2026 reincorporation target.
- **Borthwick MOU** — narrow scope, 1-pager, only when drafted with text (per Borthwick's 2026-05-06 reply).
- **US-based technical advisor recruitment** — sub-1% equity grant, "VP Standards" title.
- **Cloudflare outbound** — Rita Kozlov, Sunil Pai, Dane Knecht per strategic plan.
- **`environment.market_state` registration as a named VI constraint** — via Pablo Fourez (Mastercard CDO). Consent-required intro through Borthwick.
- **MCP server + 4 agent-framework adapters in 4 weeks** — OpenAI Agents SDK, Google ADK, Vercel AI SDK, LangChain.
- **Paradigm + a16z crypto Seed conversations** — as a competitive-process floor.
- **One network-logo pilot mention** — Mastercard / Visa TAP / Coinbase x402 Bazaar; pick one and earn the cite.

### New items surfaced today (2026-05-13)

- **Per-essay OG images** — current `og-image.png` is site-wide and minimum-viable (type-only, single tagline). When promotional capacity allows, render a distinct OG image per essay so social cards differentiate visually. Low priority; the current image is shipped and serves all pages.
- **"Essays" in global nav — deferred** — nav is hand-copied across 11 pages with at least three styling patterns (active-page, slate-style, footer-style with no class). Adding "Essays" cleanly is ~22 distinct edits with variance risk. Revisit during a nav-templating sprint; until then, discovery path is standards → "Read the announcement →" inline link → essay → essays index.
- **Worker test environment fix — BLOCKING for next logic commit** — vitest-pool-workers makes real DNS requests to `sahqfuyneoeqczupmysu.supabase.co` instead of mocking, causing the pre-commit hook to hang 40+ min and fail. Today's two `--no-verify` commits are within the documented bypass class (docs/data-only). The next worker commit that touches logic, routes, or test surface must wait for this to be fixed. Likely root cause: a Supabase client construction path in `src/index.ts` not wrapped in a mock guard during vitest, or a vitest-pool-workers config gap. Diagnose and fix before the next logic sprint.
- **Sitemap/robots indexing window** — Google/Bing crawl `/sitemap.xml` on their own schedule (typically within hours for known sites, up to a few days). Essays should appear in search indexes within the standard window; no action required, but worth noting if a search-discoverability question arises.

### What's Done (Day 49 — content sprint, docs only)

- **5 integration guides** under `docs/integrations/`:
  - `korea-investment-mcp.md` — KIS Trading MCP ↔ HO composition for XKRX, AI Framework Act positioning
  - `agentictrading-mcp.md` — HO as DAG precondition node before `execute_trade` in AgenticTrading (Open-Finance-Lab)
  - `openalgo-zerodha.md` — Flask middleware for OpenAlgo + SEBI Feb 2025 5-year audit trail positioning (XBOM/XNSE)
  - `tradingagents-risk.md` — risk manager agent pre-trade gate for TauricResearch/TradingAgents (ties to PR #523)
  - `composio-listing.md` — Composio tool registry reference content (5 actions, long description, regulatory alignment)
- **7 registry listings** (`docs/registry-submissions.md`): paste-ready copy for Official MCP Registry, Smithery, Glama, PulseMCP, mcp.so, mcpservers.org, mcpmarket.com. All use April 2026 semantic upgrade positioning.
- **4 awesome-list PR entries** (`docs/awesome-mcp-pr.md`): PR-ready markdown matching the exact format of wong2/awesome-mcp-servers, TensorBlock/awesome-mcp-servers (updates existing PR #343), georgezouq/awesome-ai-in-finance, punkpeye/awesome-mcp-servers. Each includes PR title, commit message, and format discipline rules.
- **10 outreach drafts** (`docs/outreach/day49-messages.md`): short (<280 chars) and long (<200 words) variants for KIS, AgenticTrading, TradingAgents, CrewAI, AutoGen, Zerodha/OpenAlgo/Rajandran R, Alpaca, TradingHours.com, RedStone, Polygon.io. Each references a specific repo/product/statement and includes one concrete link.
- **Tests**: 1020/1020 (no code changes, content only).
- **No worker deploy**: content-only sprint. Worker version unchanged at 3c5c8727.
- **HUMAN TASKS (the whole point of this sprint)**:
  1. Send the 10 outreach messages — ideally as GitHub issues/PRs/Discussions where the target accepts contributor traffic, DMs where not. Log sends into `docs/distribution/outreach-log.md`.
  2. Open 4 awesome-list PRs using the entries in `docs/awesome-mcp-pr.md` (wong2, TensorBlock update of PR #343, georgezouq, punkpeye).
  3. Submit to the 7 registries in `docs/registry-submissions.md`.
  4. The 5 integration guides are not yet routed through the worker (`docs/integrations/` markdown is not auto-served today — existing integrations are served via embedded string constants in `src/index.ts`). That is an intentional deferral: routing all markdown through a wildcard resolver is a separate architectural decision from writing the content. If any of these guides is linked externally before the routing lands, either (a) add a specific worker route for that file like the existing pattern, or (b) link to the GitHub raw URL.
- **Gap**: The integration guides live only in git. Agents crawling `headlessoracle.com` cannot discover them via the Worker yet. Next engineering sprint should add a `/docs/integrations/{slug}` wildcard handler that reads from a manifest, so new guides become crawlable without requiring a worker change per file. This is the compounding distribution surface — every guide that isn't crawlable is invisible to the primary consumer.

### What's Done (Day 48 — Smithery score fix + pricing dedup)

- **MCP prompts declared**: `prompts/list` and new `prompts/get` handler. Two prompts:
  - `pre_trade_check(mic)` — structured 6-step fail-closed guidance template for single-exchange pre-trade verification. Cites SEC/CFTC tokenized collateral guidance and the Multi-Oracle Consensus spec v1.0.0.
  - `market_briefing` — 6-step template for global cross-exchange briefing, treats missing signatures as UNKNOWN.
- **MCP resources declared**: `resources/list` and new `resources/read` handler. One resource:
  - `oracle://exchanges/directory` — returns the full 28-exchange directory (MICs, names, timezones, mic_type, weekends, lunch breaks) as application/json.
- **GET /mcp metadata enriched**: now includes `display_name: "Headless Oracle"`, `capabilities: { tools, prompts, resources: true }`, explicit `prompts` and `resources` arrays, full description, `homepage`, `documentation` URL. Existing fields preserved (sma_compliant, sma_version, authentication).
- **smithery.yaml upgraded**:
  - License fixed: `Commercial` → `MIT` (matches LICENSE file)
  - `display_name`: `Headless Oracle — Signed Market Status` → `Headless Oracle` (cleaner for registry cards)
  - Added `documentation` + `repository` top-level fields
  - Added missing 5th tool (`get_payment_options`) to tools block
  - Added `prompts:` block declaring both prompts with full argument schema
  - Added `resources:` block declaring the exchange directory
  - `version`: `"5.0"` → `"5.0.0"` (semver)
- **9 new tests** (1011 → 1020): resources/list (strict), resources/read happy path / no uri / unknown uri, prompts/list (strict), prompts/get pre_trade_check / market_briefing / no name / no mic / unknown prompt, GET /mcp declares prompts+resources+capabilities.
- **Pricing dedup (gap from Day 47)**: introduced a canonical `PRICING` constant alongside `BUILDER_TIER_DAILY_LIMIT` / `PRO_TIER_DAILY_LIMIT`. Both `build402Payload` and `/v5/pricing` now derive dollar amounts from it — no more hardcoded "5.00"/"99.00"/"299.00" in two places. Fields `credit_pack_usd`, `builder_monthly_usd`, `pro_monthly_usd`, `protocol_monthly_usd`, `x402_per_request_usdc`, `credit_pack_calls`.
- **Standards page CTA fix**: `headless-oracle-web/standards.html` — primary "Read the multi-oracle consensus spec" button now points at the markdown route (`/docs/specifications/multi-oracle-consensus-v1`) for human readers; a secondary "JSON discovery doc" button points at `/v1/verification/multi-oracle-guide` for agents.
- **Deployed**: Worker version `3c5c8727`. Pages deployed (0442218b.headless-oracle-web.pages.dev). Live-verified — `POST /mcp` prompts/list returns both prompts, resources/list returns `oracle://exchanges/directory`.
- **Strategic significance**: Smithery's automated scoring was 63/100 partly because the server declared empty prompts and resources. Every MCP registry card is a compounding distribution surface — Smithery propagates to other aggregators. The prompts themselves also double as agent-guidance templates: any client calling `prompts/get pre_trade_check` receives the exact fail-closed instruction we want agents to follow, baked directly into their context.
- **Gap**: The Day 47 priority list (Asia-Pacific distribution sprint, SMA standardisation, SFF2026 application, SEBI positioning) is unchanged — today's work was Smithery-score infrastructure, not distribution execution. The distribution content drafts (5 integration guides, 7 registry listings, 10 outreach messages) from the full Day 48 prompt are **still outstanding** and need a dedicated content-focused session rather than being folded into an infra sprint. The PRICING constant is now single-source, but `/docs/x402-payments.md` and various integration docs still reference `$0.001` inline — acceptable for now (docs drift is less dangerous than runtime drift), revisit if dollar amounts ever change.

### Day 47 Top Priorities (new)

These are the next moves. They flow from today's four sprints (semantic upgrade, multi-oracle spec v1.0.0, OpenAPI extensions, x402 hardening) — the product is now positioned for Asia-Pacific distribution and standards body outreach. Do them in roughly this order.

1. **MCP directory re-submissions with updated descriptions**. The semantic upgrade (model-agnostic, SEC/CFTC, regional exchange names) only helps if the directory listings carry the new copy. Targets: Smithery, Glama, mcp.so, mcpservers.org, mcpmarket.com, awesome-mcp-servers (PR #343 already open — update description). Pull the new descriptions from `/.well-known/mcp/server-card.json` — do not hand-write.
2. **Korea Investment Securities MCP co-integration outreach**. KIS operates Korea's largest retail brokerage MCP server and deals exclusively in execution — they have no verified market-state layer. Pitch: "Our pre-trade gate slots in front of your order-placement tool; agents get KIS execution + HO verification in one MCP config." XKRX is already in our 28-exchange set.
3. **Zerodha / OpenAlgo integration for India**. Zerodha dominates Indian retail; OpenAlgo is the open-source MCP bridge. XBOM + XNSE are already live. Positioning: SEBI is drafting algo trading accountability rules — a signed pre-trade gate is the cleanest audit trail available. Draft an OpenAlgo plugin that wraps HO's `get_market_status` before every order.
4. **Dify / Coze MCP extension submission for China**. Dify (136K GitHub stars) and Coze (ByteDance) are the dominant Chinese agent frameworks. Neither has a market-state tool. XSHG/XSHE are live with lunch-break handling. Submit as an official MCP extension in both marketplaces.
5. **AgenticTrading direct MCP integration**. Highest-priority framework target — they ship autonomous multi-exchange execution agents and have publicly flagged the market-state gap. Direct integration PR, not just a docs guide.
6. **SMA Protocol v1.0 standardization — AAIF / Linux Foundation submission research**. The Multi-Oracle Consensus spec gives us standards-body credibility. Research the AAIF (Agentic AI Foundation) and LF Decentralized Trust submission processes. Goal: get SMA Protocol and Multi-Oracle Consensus listed as reference standards before any incumbent does.
7. **Singapore FinTech Festival 2026 application** (November deadline). SFF is the single highest-signal fintech-infrastructure venue globally. MAS already runs the world's first agentic-AI governance framework (Jan 2026) — our fail-closed + signed attestation story is on-thesis. Apply as a standards contributor, not a vendor.
8. **SEBI algo trading compliance positioning for Indian market**. SEBI's draft rules on algo accountability are the clearest regulatory forcing function in Asia. Publish a compliance alignment doc (parallel to `docs/compliance.md`) mapping SEBI requirements to HO's receipts + audit digest + multi-oracle consensus.

### Standing gaps carried from Day 46
- **Pricing drift**: `build402Payload` hardcodes `"5.00"/"99.00"/"299.00"` while `/v5/pricing` has the tier list. Two paths for the same numbers. Fix: extract a single `PRICING` constant and have both endpoints derive from it. (Already named in the Day 46 gap note.)
- **Multi-oracle spec is normative-but-unsatisfiable** until at least two more independent implementations ship. Paths forward: (a) seed reference implementations under different operators, or (b) court Polygon.io / TradingHours.com / RedStone to wrap their data in an SMA-compliant signed envelope. Both are distribution moves, not engineering moves.

### What's Done (Day 46 — x402 payment hardening sprint)
- **build402Payload**: Added flat top-level machine-readable fields so any agent — regardless of model tier (Mythos $125/MTok, GPT-5 nano $0.05, on down) — can parse the 402 response without walking nested objects. New fields: `payment_required: true`, `payment_method: "x402"`, `currency: "USDC"`, `network: "base"`, `chain_id: 8453`, `pricing` (per_request/credit_pack/builder_monthly/pro_monthly with real values from BUILDER_TIER_DAILY_LIMIT/PRO_TIER_DAILY_LIMIT constants), `x402_endpoint`, `pricing_endpoint`, `documentation_url`, `alternative` (sandbox path). Existing nested `x402` object, `upgrade_paths`, `agent_actions`, and `alternatives` blocks preserved for backward compat.
- **server-card.json**: Added top-level `payment` section (methods, currency, network, chain_id, autonomous_payment=true, human_required=false, pricing_endpoint, documentation_url) sitting alongside the existing nested `x402` block. Surfaces autonomous payment capability to any agent walking the discovery card without needing to read the x402 sub-object.
- **/v5/pricing**: Already present (Day 39). Verified live — 7 tiers, x402 amount/network/chain_id correct.
- **docs/x402-payments.md**: Already present (214 lines). Covers full agent flow, code examples, failure modes.
- **3 new tests** (1008 → 1011): (1) 402 body contains all 9 flat fields with correct values + nested pricing object; (2) /v5/pricing returns valid JSON with all 6 tier IDs and correct x402 metadata; (3) server-card.json payment section has autonomous_payment=true and all required URLs.
- **TEST_COUNT**: 1008 → 1011 in wrangler.toml.
- **Live verified**: server-card payment section + /v5/pricing both return expected fields against production.
- **Deployed**: Worker version 35beb439.
- **Strategic significance**: In a compute-stratified world (Mythos restricted to 50 orgs, GPT-5 nano at $0.05/MTok), the bottleneck shifts from "can the agent access the tool?" to "can the agent PAY for the tool autonomously?" HO's 402 response is now parseable by the lowest-capability model in any framework. Korea Investment, Zerodha, AgenticTrading, Dify, Coze, AgentScope agents can all hit /v5/status, get a 402, and immediately know exactly how to pay — no human-readable parsing required.
- **Gap**: Pricing values are still duplicated between `build402Payload` (hardcoded "5.00", "99.00", "299.00") and the `/v5/pricing` tier list (5, 99, 299 numbers + "$5", "$99/month" labels). Two paths for the same numbers will eventually drift. Next sprint: extract a single PRICING constant and have both endpoints derive from it.

### What's Done (Day 46 — multi-oracle consensus v1.0.0 sprint)
- **MULTI-ORACLE-CONSENSUS-v1.md**: full spec written and shipped at `docs/specs/MULTI-ORACLE-CONSENSUS-v1.md`. First published standard for market-state verification across independent oracle feeds. License: MIT. Designed to satisfy SEC/CFTC Technical Framework for Tokenized Collateral (Nov 2025) requirement for ≥3 independent oracle feeds with cryptographic attestation. Defines `majority_with_fail_closed` algorithm, attestation field set (exchange, status, timestamp, expires_at, signature, public_key_url, oracle_id), 7-step verification flow, error handling table, and Ed25519/ECDSA-secp256k1/RSA-PSS-2048+ crypto requirements (SHA-1 and RSA-1024 forbidden).
- **Markdown route**: served at `/docs/specifications/multi-oracle-consensus-v1` (and `.md` + `/docs/specs/MULTI-ORACLE-CONSENSUS-v1.md` aliases). text/markdown. Mirror of the on-disk file lives in `MULTI_ORACLE_CONSENSUS_SPEC_MD` constant in `src/index.ts`.
- **JSON discovery endpoint**: `GET /v1/verification/multi-oracle-guide` — unauthenticated public-good. Spec-versioned `/v1/` prefix (deliberately distinct from Headless Oracle's `/v5/` product namespace) so other oracles can adopt the same path. Returns spec_version, consensus_algorithm, minimum_oracles=3, fail_closed_default=true, attestation_format with required fields, verification_flow, error_handling table, cryptographic_requirements, regulatory_alignment array (SEC/CFTC, ESMA, NIST, MAS), and reference_oracles list with Headless Oracle as the first compliant implementation.
- **Worker route added**: `headlessoracle.com/v1/verification/*` in wrangler.toml. Without this the path was being intercepted by Pages passthrough — caught on first live verify, fixed before final deploy.
- **OpenAPI**: 79 → 81 paths (+1 spec markdown, +1 JSON guide). Tagged Documentation + Discovery respectively.
- **9 new tests** (999 → 1008): JSON shape (spec_version 1.0.0), minimum_oracles=3 + fail_closed_default=true + algorithm name, attestation_format required fields presence (all 7), reference_oracles non-empty + Headless Oracle compliant + Ed25519 + 28 exchanges, regulatory_alignment cites SEC/CFTC, spec_url consistency, markdown 200/text-markdown, markdown content checks (algorithm name, "three independent oracle feeds", SEC/CFTC, "Signed Market-State Attestation"), `.md` variant works.
- **TEST_COUNT**: 999 → 1008 in wrangler.toml.
- **Live verification**: `curl https://headlessoracle.com/v1/verification/multi-oracle-guide` returns spec_version 1.0.0, minimum_oracles 3, fail_closed_default true, algorithm majority_with_fail_closed, reference_oracles[0].name "Headless Oracle". Markdown spec returns 200 text/markdown.
- **Deployed**: Worker version d5bfdaf1.
- **Strategic significance**: Headless Oracle is now the editor of the multi-oracle market-state verification standard, not just one provider within it. Chainlink and Pyth do price-feed consensus; nobody had published a market-state consensus protocol. Publishing first establishes us as the architectural reference for the SEC/CFTC tokenized collateral compliance market.
- **Gap**: The standard mandates ≥3 independent oracles, and only one currently exists (us). Until at least two more independent implementations ship, the spec is normative-but-unsatisfiable in production. Next move is either (a) seed reference implementations under different operators, or (b) court Polygon.io / TradingHours.com / RedStone to wrap their data in an SMA-compliant signed envelope. Both are distribution moves, not engineering moves.

### What's Done (Day 46 — semantic upgrade sprint)
- **MCP tool descriptions**: model-agnostic positioning + SEC/CFTC tokenized collateral language added to all 5 tools (get_market_status, get_market_schedule, list_exchanges, verify_receipt, get_payment_options). Same 5-point WHAT/WHEN/RETURNS/FAILURE/LATENCY structure preserved; content upgraded.
- **get_market_status**: explicit "Pre-trade safety check: call this BEFORE executing any trade" line + "If this tool is unreachable, the agent MUST NOT execute the trade." Reinforces fail-closed at the tool description level so agents in compute-stratified ecosystems (Mythos $25/$125 per MTok, GPT-5 nano $0.05) all receive the same gating contract.
- **Regional exchange names**: every MIC code in tool descriptions now reads as "Regional Exchange Name (XMIC)" — e.g. "Shanghai Stock Exchange (XSHG)", "Korea Exchange / KRX Seoul (XKRX)", "Tokyo Stock Exchange / Japan Exchange Group (XJPX)". Driven by the discovery thesis: Asian agent platforms (Dify 136K stars, Coze, AgentScope) and Korean/Indian brokerage MCP servers match on exchange names, not just codes.
- **inputSchema enums**: confirmed all 28 MICs already present in get_market_status and get_market_schedule enum lists; no change needed.
- **LLMS_TXT_INDEX**: added "Model-agnostic infrastructure" line at top, "Regulatory alignment" line referencing SEC/CFTC Technical Framework for Tokenized Collateral, x402 autonomous payment line, and a new `## Multi-Oracle Verification` section explaining the three-feed consensus pattern and fail-closed behaviour when feeds disagree.
- **/.well-known/mcp/server-card.json**: added `model_agnostic: true`, `regulatory_alignment: ["SEC_CFTC_tokenized_collateral", "ISO_10383"]`, and `categories: ["finance", "market-data", "attestation", "verification", "pre-trade-safety", "rwa", "tokenization"]`. Description updated to mention model-agnostic + SEC/CFTC.
- **4 new tests** (994 → 998): server-card semantic fields, server-card coverage.exchanges == 28, get_market_status description content (model-agnostic, SEC/CFTC, pre-trade safety, MUST NOT execute), tool descriptions name regional exchanges (Shanghai/Korea/Tokyo Stock Exchange).
- **TEST_COUNT**: bumped 994 → 998 in wrangler.toml.
- **Live verification**: server-card.json returns model_agnostic/regulatory_alignment/categories live; tools/list returns "Model-agnostic" in description payload.
- **Deployed**: Worker version 942911e8. Pushed to main (b59e6a2).
- **Gap**: server-card.json is the agent-facing discovery surface, but the OpenAPI spec (`/openapi.json`) still describes endpoints in human-developer terms — there's no top-level `x-model-agnostic` or `x-regulatory-alignment` extension on the OpenAPI document itself. Agents that consume OpenAPI before MCP (some of the new Asian framework crawlers) won't see the new positioning. Next sprint: lift the same metadata into OpenAPI `info` extensions.

**Website**: 10 HTML pages on Cloudflare Pages (headless-oracle-web). Instant keys + Paddle checkout live.
**OpenAPI**: 79 paths (+1 /v5/revenue-pulse), 11 semantic tags.
**SDKs**: packages/sdk-typescript + packages/sdk-python (ready, not published).
**Monitoring**: GitHub Actions health-check every 15 min. See `.claude/rules/monitors.md`.

### What's Done (Day 45 — monitor sprint, durable option)
- **Decision (architectural)**: rejected session-scoped `/loop` and `CronCreate` for monitoring — they die when the Claude session exits. All monitoring lives in GitHub Actions, the Worker cron, or KV-backed observability surfaces. Rationale and the constraint discussion are captured in `.claude/rules/monitors.md`.
- **`scripts/health-check.mjs`**: self-contained Node 22 script, zero npm deps. Hits `/v5/health`, `/v5/demo?mic=XNYS`, `/v5/exchanges`, `/v5/schedule?mic=XNYS`, `/openapi.json`. Verifies Ed25519 signatures on `/v5/health` and `/v5/demo` using Web Crypto, with the canonical payload field list driven off `canonical_payload_spec` from `/v5/keys` (NOT a heuristic). Asserts TTL is exactly 60s. Probes the Pages frontend `/` against a 3s SLO and emits a Pages-vs-Worker classifier when something fails. When `MASTER_API_KEY` is in env, also queries `/v5/revenue-pulse` and emits `REVENUE_NEW` log lines for events in a 20-min sliding window.
- **`.github/workflows/health-check.yml`**: runs the script every 15 min on `*/15 * * * *`. On failure, opens a GitHub issue (labels: `health-check`, `auto`, `incident`) with the last 3500 bytes of script output. On `REVENUE_NEW` log lines, opens one GitHub issue per `txn_id` (labels: `revenue`, `auto`), deduping against existing open issues with the same transaction id in the title.
- **`recordPaddleRevenueEvent()` helper** (src/index.ts ~line 1765): best-effort KV writer called from both `transaction.completed` branches in the Paddle webhook. Writes `paddle_revenue_count`, `paddle_revenue_count:{tier}`, `paddle_revenue_last_at`, and `paddle_revenue_event:{ISO}` (30-day TTL, listable).
- **`GET /v5/revenue-pulse`** (src/index.ts ~line 11045): admin-only (master-key gated). Returns Paddle lifetime counts by tier, x402 lifetime counts, and the most recent 50 Paddle revenue events. Added to OpenAPI spec under the Operations tag.
- **5 new tests** for `/v5/revenue-pulse`: 401 without key, 401 with wrong key, 200 empty state, 200 reflects KV state, end-to-end credits webhook → revenue-pulse readback. Total: 989 → 994.
- **Live verification**: `node scripts/health-check.mjs` against production passes — both `/v5/health` and `/v5/demo` Ed25519 signatures verify, all 5 endpoints under SLO, Pages frontend 200 in <1s.
- **Worker exception monitoring**: explicitly NOT running `wrangler tail` from a Claude session. `wrangler.toml` already has `[observability] enabled=true head_sampling_rate=1`, all events flow to Cloudflare Workers Logs, and the health-check captures sustained errors as test failures (a stronger signal than raw exception counts).
- **Required GitHub secret**: `MASTER_API_KEY` must be set at Settings → Secrets → Actions for the revenue pulse step to fire. Without it the workflow logs `REVENUE_SKIPPED` and continues — health checks still run.
- **Gap**: no third-party uptime prober (Pingdom/UptimeRobot/BetterUptime). The current setup verifies headlessoracle.com from a GitHub-hosted runner, which catches Worker bugs and Pages bugs but cannot independently confirm that Cloudflare itself is reachable from outside the github.com network egress. Add an external prober when paid traffic justifies the spend.

### What's Done (Day 45 — 402 messaging update)
- **402 response messaging**: All human-readable `message` fields in 402 responses updated to risk-framing language: "You are running an execution system without verified market-state gating. Continuing without verification increases risk of invalid trades. Upgrade for execution-grade access." Applies to: build402Payload (free tier gate), trial exhausted (with and without x402), and /v5/errors/PAYMENT_REQUIRED. All machine-readable fields (upgrade_paths, agent_upgrade_paths, x402, pricing) unchanged. 1 test updated to match new message. 989/989 passing. Deployed 0436cbd3. Live-verified via curl.

### What's Done (Day 44 — late evening distribution sprint)
- **CPVR-1 spec**: Composable Pre-Trade Verification Receipt — PROPOSAL for JSON envelope wrapping all layer proofs into a single artifact. Served at /docs/specifications/cpvr-1. 4 new tests.
- **Ampersend outreach edited**: Removed spec URL, added POST INSTRUCTIONS (GitHub Discussion, timing). Draft ends with handoff pattern question.
- **VeroQ hold note**: "Wait for FinRL reply until April 16, then cold outreach."
- **Distribution outreach drafts**: 8 targets (CrewAI, AutoGen, Strands, OpenBB, Composio, LangChain, Mastra, QuantConnect). 5 READY TO POST, 3 NEEDS REVIEW. Each with project-specific code examples.
- **Glama description update**: server-card.json and mcp-servers.json descriptions updated with discovery keywords (exchange hours, market open closed, trading schedule, DST-aware, etc.). Saved docs/distribution/glama-description.md.
- **OpenAPI**: 77 → 78 paths (+1: /docs/specifications/cpvr-1).
- Updated: AGENTS_MD, LLMS_TXT_INDEX, LLMS_FULL_TXT, SITEMAP_XML, OPENAPI_SPEC.

### What's Done (Day 44 — evening session)
- **Pre-Trade Verification Stack spec**: 5-layer composable verification (Market State → Spend Auth → Signal Verification → Payment → Execution). HO = Layer 1. Published as markdown at /docs/specifications/pre-trade-stack and JSON at /v5/pre-trade-stack.
- **Ampersend Integration Guide**: Composable market state + spend authorization pattern with code examples. /docs/integrations/ampersend live.
- **A2A Agent Card v1**: /.well-known/agent-card.json (A2A v1 standard path) aliased to agent.json. Added schemaVersion, humanReadableId, agentVersion, authSchemes, tags, privacyPolicyUrl, termsOfServiceUrl. pre_trade_stack reference in agent card.
- **Outreach drafts**: Ampersend GitHub comment + VeroQ follow-up in docs/distribution/outreach-day-44.md.
- **12 new tests**: pre-trade stack JSON shape, spec markdown routes, Ampersend guide, A2A agent-card.json fields.
- **OpenAPI**: 73 → 77 paths (+4: /v5/pre-trade-stack, /docs/specifications/pre-trade-stack, /docs/integrations/ampersend, /.well-known/agent-card.json).
- Updated: AGENTS_MD, LLMS_TXT_INDEX, LLMS_FULL_TXT, SITEMAP_XML, OPENAPI_SPEC, ROBOTS_TXT, AGENT_JSON, wrangler.toml routes.

### What's Done (Day 44 — earlier)
- Dead code cleanup: removed 4,439 lines from Worker (was 16,565 → 12,126). Worker = API only.
- 51 dead HTML-page tests removed. Worker serves zero HTML.
- OpenAPI spec complete: 73 paths (was ~50).
- TypeScript + Python SDKs stubbed in packages/.
- Coverage sprint: 777 → 1,014 tests, then 1,024 → 973 after dead test removal.
- Instant key provisioning live. Enhanced 402/429 with agent_upgrade_paths.
- 3-hour outage recovered (Day 42).
- Website deployed on Pages: working buttons, 28 exchanges, all CTAs wired.
- Living documents refreshed.

### What's Next
- **Revenue**: DataCamp follow-up April 12. Warmest lead.
- **Distribution**: VeroQ on FinRL — reply posted, second tweet posted.
- **Outreach**: Mike to review Ampersend and VeroQ drafts in docs/distribution/outreach-day-44.md.
- **Managed Agents decision**: April 15.
- **Max → Pro transition**: possible next week (cost optimization).
- **SDKs**: publish to npm/PyPI when first customer needs them.
- **Gap**: Line ranges in 02_architecture_map.md approximate (shifted by cleanup). Re-map on next deep code change.

**Previous**: Apr 9 2026 — Day 44 continued: API completeness sprint:
- **OpenAPI 3.1 spec complete**: 73 paths (was ~50), 11 semantic tags, 2 server URLs (headlessoracle.com + api.headlessoracle.com), MIT license, contact email, BearerAuth security scheme. Added ~25 missing paths: /oauth/*, /v5/historical, /v5/status/realtime, /v5/briefing, /v5/referrers, /v5/payment-proof, /v5/why-not-free, /v5/pricing, /v5/slo, /v5/errors/{code}, /v5/changelog, /.well-known/x402.json, /.well-known/mcp-servers.json, /.well-known/mcp/server-card.json, /.well-known/oauth-*, /.well-known/ai-plugin.json, /AGENTS.md, /skill.md, /badge/{mic}, /v5/webhooks/unsubscribe, /sitemap.xml. Deployed d07e539a. Verified live: 73 paths.
- **TypeScript SDK stub**: packages/sdk-typescript/ — @headlessoracle/sdk. Full types, getStatus/batch/historical/verify/verifyOffline, Ed25519 via Web Crypto, auto-retry 429, auto-provision key on 402, safety helpers (isSafeToExecute, allOpen), OracleError class, dual ESM+CJS build via tsup.
- **Python SDK stub**: packages/sdk-python/ — headless-oracle-sdk. Pydantic v2 models, httpx client, PyNaCl Ed25519 verification, auto-retry/auto-provision, 12 pytest tests using respx mock, pyproject.toml ready for publish.
- Gap: Neither SDK is published yet. TypeScript needs `tsup` build + `npm publish`. Python needs `pip install -e .` test + PyPI upload.

**Previous**: Apr 9 2026 — Day 44 continued: Coverage sprint (777→1014 tests):
- **Coverage tooling**: Istanbul coverage provider configured (`npm run test:coverage`). Baseline: 78% stmts / 71% branch / 53% funcs / 81% lines.
- **Endpoint coverage gaps (77 tests)**: /v5/keys/instant error cases, /v5/verify error paths, /v5/historical edge cases, /v5/audit/digest + chain, /v5/funnel auth, /v5/stack, /v5/credits/purchase + balance, /.well-known/* endpoints, /docs/* endpoints, catch-all 404, method not allowed, CORS preflight.
- **Schedule engine exhaustive tests (142 tests)**: All 28 exchanges tested for mid-session OPEN, before-open CLOSED, after-close CLOSED, weekend CLOSED, 2026 holiday CLOSED, half-day early close, lunch breaks (XJPX/XHKG/XSHG/XSHE), DST transitions (US Mar 8 + Nov 1, EU Mar 29 + Oct 25, 3-week gap), CME overnight session.
- **Ed25519 signing tests (18 tests)**: Verify against /.well-known/oracle-keys.json, tampered payload/signature rejection, canonical alphabetical key sort, no-whitespace JSON, UUID receipt_id, ISO 8601 timestamps, 60s TTL, receipt_mode differentiation, batch signature, health receipt schema.
- Final coverage: 78.80% stmts / 71.97% branch / 53.25% funcs / 81.28% lines.
- Gap: Function coverage at 53% is bounded by cron handlers, Durable Objects, real-network payment verification, and ~100 template literal builder functions. Core trust path (signing, schedule, auth) has near-100% coverage.

**Previous**: Apr 9 2026 — Day 44: Telemetry gap fixes (770→777 tests):
- **/.well-known/oracle-keys.json enhanced**: Added `created_at`, `status` (active), `usage` (receipt_signing), `issuer` (headlessoracle.com) fields. Cache-Control: public, max-age=86400. Backward-compatible (existing `service` and `spec` fields preserved). Triggered by agent request at 22:00 UTC looking for signing keys.
- **GET /docs/integrations/claude-managed-agents**: Full integration guide now served at the URL referenced in AGENTS.md and LLMS_TXT. Both extensionless (text/plain) and .md (text/markdown) variants. 299 lines covering 4 patterns, fail-closed contract, audit trail, 28 exchanges.
- **GET /docs**: Master documentation index (docs/README.md) served as text/markdown. Links to architecture, API, operations, legal, security, business, and integrations docs.
- **wrangler.toml**: Routes added for /docs, /docs/integrations/claude-managed-agents, and .md variant.
- **3 new tests** for oracle-keys.json (status/usage/created_at fields, issuer field, Cache-Control header). **5 new tests** for doc routes (claude-managed-agents extensionless + .md + content, /docs content-type + content).
- Gap: /docs serves a static index with relative links (architecture/overview.md etc.) but those sub-paths are not yet routed in the worker. Only specific /docs/* paths are served — a wildcard /docs/* → markdown file resolver would eliminate the need to add routes one-by-one.

**Previous**: Apr 8 2026 — Day 43 continued: Claude Managed Agents guide + upgrade nudge (753→770 tests):
- **docs/integrations/claude-managed-agents.md**: Full integration guide for Anthropic's Claude Managed Agents platform. 4 patterns: MCP tool (recommended), REST API with verification, multi-exchange batch, historical verification. Covers fail-closed contract, audit trail via /v5/audit/digest and /v5/audit/chain, all 28 exchanges by region, API key provisioning paths. Written for developers who have never heard of HO.
- **Upgrade nudge on 429 responses**: Free-tier and paid-tier 429 RATE_LIMITED responses now include structured `upgrade_paths`, `recommended`, `daily_limit`, `used`, `resets_at` fields. Agents can autonomously choose the next tier. X-Upgrade-Path header on all 429s. X-Daily-Usage header at 80%+ usage.
- **Rate limit header bug fix**: `_rlUsed` and `_rlLimit` were initialized to 0 and never updated from actual usage values. Now correctly wired to `getDailyUsage()` results for both free and paid tiers.
- **Files updated**: docs/README.md (Integrations section), docs/api/mcp-reference.md (Managed Agents link), AGENTS.md (new section), llms-full.txt (Agent Framework Integrations), 01_business_context.md (Agent Hosting Platforms distribution surface).
- Gap: The integration guide references `https://headlessoracle.com/docs/integrations/claude-managed-agents` but this route doesn't exist in the worker yet. The guide is a static markdown file — needs a route added or served via Pages when ready.

**Previous**: Apr 8 2026 — Day 43 continued: Merkle Audit Chain (742→753 tests):
- **GET /v5/audit/digest** (commit 3e498e9): Daily attestation digest with SHA-256 Merkle root over ordered receipt IDs. Public, no auth. ?date= param, partial flag for today, validation (future dates, pre-launch dates, format). 7 tests.
- **GET /v5/audit/chain** (commit 3e498e9): Hash chain of last N daily digests (default 7, max 30). chain_intact verification flag. Each day chains to previous via previous_day_merkle_root. 4 tests.
- **trackReceiptId()**: Appends receipt_id + MIC to digest_receipt_ids:{date} KV on every receipt (all modes). Non-blocking via ctx.waitUntil.
- **computeMerkleRoot()**: SHA-256 Merkle tree — leaf = sha256(receipt_id), pairs hashed upward, odd promoted.
- **getOrBuildDigest()**: Lazy-computes and caches completed daily digests in attestation_digest:{date} KV (90-day TTL). Only caches past days (today always live-computed).
- **Batch tracking**: Receipt IDs from /v5/batch also tracked via separate loop.
- **Archive write fix**: Restored mode === 'live' guard on archive (was accidentally removed). Digest tracks all modes.
- **OpenAPI spec**: /v5/audit/digest and /v5/audit/chain added with full schemas.
- **LLMS_TXT**: "Audit & Transparency" section added.
- Live-verified: both endpoints returning correct structure. Receipt tracking confirmed working.
- Gap: Merkle proofs (proving a specific receipt_id is in the tree without the full list) not yet implemented. Needed when agents want to verify inclusion without fetching all IDs.

**Previous**: Apr 8 2026 — Day 43 continued: Engineering Hardening Sprint (725→742 tests):
- **Property-based tests** (commit b32e704): fast-check schedule engine tests — 15 generative tests verifying timezone determinism, holiday fail-closed, DST safety, lunch break correctness, overnight session continuity.
- **Load test script** (commit 3ac4c13): scripts/load-test.ts with configurable RPS, baseline results at 10 req/s documented.
- **Error budget tracker** (commit a639064): GET /v5/slo — SLO reporting endpoint with error budget computation, uptime tracking, burn rate. 4 tests.
- **/v5/verify enhancements** (commit 953e0bc): GET support (query params), detailed check breakdown (fields_present, not_expired, signature_valid, schema_version_match), structured checks array. 4 tests.
- **/v5/batch enhancements** (commit 1dc84e8): correlation_id for request tracing, exchanges map (keyed by MIC), batch_signature (Ed25519 over sorted MICs+statuses). 4 tests.
- **GET /v5/historical** (commit 71de82b): Schedule reconstruction at past timestamp. Returns computed_status, reasoning (local time, weekend/holiday/hours), DST proximity notes. Public, unsigned. 9 tests.
- Gap: /v5/historical DST transition data is hardcoded for 2026-2027 only. Needs dynamic generation from Intl API or annual maintenance beyond 2027.

**Previous**: Apr 8 2026 — Day 43: Acquisition Readiness Sprint Part 2 (725 tests, docs only):
- **Documentation reorganization**: docs/ restructured into architecture/, api/, operations/, legal/, business/, security/, integrations/, distribution/, blog/. Master index at docs/README.md. ADRs moved to docs/architecture/adr/ via git mv (history preserved).
- **Architecture docs**: docs/architecture/overview.md (system summary, 4-tier fail-closed, signing model, auth model), docs/architecture/data-flow.md (3 request lifecycle paths + MCP path).
- **API reference**: docs/api/rest-reference.md (all endpoints, error format, rate limits), docs/api/mcp-reference.md (5 tools, config examples, auth model).
- **Legal documents** (all DRAFT pending counsel): Terms of Service (assignment clause for M&A, 12-month liability cap, SA governing law), Privacy Policy (GDPR rights, sub-processor list, no cookies), Acceptable Use Policy, IP Ownership (sole-author attestation, AI-tooling disclosure), Data Processing Addendum (EU SCCs Module 2).
- **Operational docs**: Deployment guide (pre/post checklists), Rollback procedure, Incident Response (P1-P4 severity, post-mortem template), Monitoring (alert thresholds, weekly review), SLA (99.9% target, credit policy for Builder+).
- **Business docs**: Pricing strategy (tier rationale, unit economics, revenue projections), Competitive analysis (zero direct competitors, moat analysis), Metrics dashboard (data sources, current values, weekly template).
- **README.md overhaul**: Professional README replacing stale MCP Registry content. Quick start, architecture summary, exchange list, testing, security, documentation index.
- **CHANGELOG.md**: Keep a Changelog format covering major milestones from coverage sprint through acquisition readiness.
- Gap: Legal documents are DRAFT — require legal counsel review before production publication. No published ToS or privacy policy on headlessoracle.com yet.

**Previous**: Apr 8 2026 — Day 43: Acquisition Readiness Sprint Part 1 (714→725 tests):
- **Security headers** (commit 7bd73aa, deployed b9655d6e): HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, CSP on ALL responses. `Content-Type: application/json; charset=utf-8`. `X-Attestation-Mode` header (demo/trial/live). Module-level `SECURITY_HEADERS` constant shared by json(), MCP, OAuth, and static paths. 11 new tests.
- **SECURITY.md** (commit e36996b): Responsible disclosure policy. security@headlessoracle.com. 48h acknowledgment, 90-day fix target. Safe harbor. Scope includes MCP package + verify SDK.
- **security.txt updated**: Contact → security@headlessoracle.com, Expires → 2027-04-08, Policy → SECURITY.md link.
- **CI/CD pipeline** (commit da40e07): `.github/workflows/ci.yml` — test + npm audit + license check on push/PR, smoke tests on main only. dependabot.yml (weekly npm updates). CODEOWNERS (@MBeenz). PR template. `.nvmrc` (Node 22).
- **Dependency audit** (commit 40eb990): `npm audit fix` resolved 3/7 high (picomatch, rollup, vite). Remaining 4 are devDependencies only (undici/miniflare/wrangler). All production deps MIT/0BSD. CycloneDX SBOM. Secret scan: clean. `docs/security/` index.
- **Repository hygiene** (commit 21d1285): LICENSE corrected to MIT (was MCP template). CONTRIBUTING.md. `.env.example` with all vars. 6 ADRs (Cloudflare Workers, Ed25519, fail-closed, 60s TTL, x402, MCP).
- **Task 0 BLOCKED**: Cloudflare API token failed authentication — email routing requires manual setup via Dashboard or new token with Email Routing Edit permission.
- Gap: Email routing for headlessoracle.com not yet configured (blocked on API token). Manual setup required via Cloudflare Dashboard.

**Previous**: Apr 8 2026 — Day 42: Next-Model Readiness Meta-Sprint (714 tests + 11 smoke):
- **CLAUDE.md rewrite**: Restructured as definitive onboarding doc — architecture, invariants, routes, update protocol, file layout
- **01_business_context.md**: Market position (only signed market-state MCP), revenue model, distribution surfaces, regulatory tailwinds, key metrics
- **02_architecture_map.md**: Route map with line ranges, 20+ key functions with signatures, 3 data flow traces, constants reference, DO classes, cron triggers
- **03_sprint_playbook.md**: Sprint structure, 10 failure modes with mitigations, external PR checklist, session closing checklist, test/deploy patterns
- **04_telemetry_guide.md**: All KV key patterns, 15 evaluator fingerprints, traffic indicators, conversion signals
- **Smoke test suite**: 11 tests hitting live production. Separate vitest config. All passing.
- Gap: Living document update discipline is documented but not enforced.

**Previous**: Apr 7 2026 — Day 41 late: Performance + Discovery + Distribution Sprint (714 tests):
- **In-memory API key cache** (commit 9489888): Module-scope Map with 60s TTL for ORACLE_API_KEYS reads. Eliminates ~5ms KV round-trip on warm isolates. Credits-tier excluded (balance mutates per-request). HMAC CryptoKey cached across calls.
- **llms.txt spec-compliant index** (commit e28618b): GET /llms.txt returns concise llmstxt.org index with blockquote summary, section links. GET /llms-full.txt returns complete docs (exchange hours, curl examples, verification code, MCP configs, compliance mapping). All JSON responses include `Link: </llms.txt>; rel="llms-txt"` header.
- **ai-hedge-fund PR** (commit 6680f9a): virattt/ai-hedge-fund#564 — market_state_verification_agent between risk and portfolio managers. 17 tests, zero deps, fail-closed. MIC deduplication. Uses /v5/demo (free).
- **dev.to launch post**: docs/blog/devto-launch-post.md — ~2,000 word Show Dev post draft.
- **Integration docs**: CrewAI MCPServerStdio pattern added to existing guide. New Agno guide (Streamable HTTP + stdio). New ai-hedge-fund architecture guide.
- **TEST_COUNT**: 707 → 714 (+3 cache tests, +4 llms.txt tests). Worker deployed: Version 192b0ce6. All pushed to main.
- Gap: In-memory API key cache has no eviction policy beyond TTL. At extreme scale (>10K unique keys per isolate), the Map could grow unbounded. Add LRU eviction or max-size cap when key count warrants it.

**Previous**: Apr 7 2026 — Day 41 evening: Discovery + Conversion + Distribution Sprint (707 tests):
- **AGENTS.md rewrite** (commit b96477d): Rewrote for agent discovery — MCP config snippet, exchange list, REST usage, trust model. ClaudeBot already crawling this endpoint.
- **agent_upgrade_paths on 402** (commit b96477d): Trial-exhausted 402 responses now include structured agent_upgrade_paths with 3 methods (x402/api_key/demo). Agents can autonomously choose upgrade path.
- **MCP registry submissions** (commit 150b939): docs/distribution/registry-submissions.md tracking 8 registries. Already on 5 (Official, Smithery, Glama, npm, PulseMCP). PR submitted to TensorBlock/awesome-mcp-servers. Manual instructions for mcp.so and mcpserverfinder.com.
- **Compliance docs** (commit 28d2c3b): docs/compliance.md mapping ESMA/NIST/Singapore MAS requirements to HO features. Audit trail pattern, regulatory alignment table.
- **MCP clientInfo capture** (commit 9f1d70e): Initialize handler extracts clientInfo.name/version from params, writes to ORACLE_TELEMETRY KV. Tells us which MCP clients are connecting (Claude Desktop, Cursor, etc.).
- **TEST_COUNT**: 703 → 707. Worker deployed: Version 645d074e. All pushed to main.
- Gap: clientInfo capture is best-effort (deferred KV write). If initialize is sent without clientInfo (some probers omit it), no client_info is recorded. Could add User-Agent parsing as fallback at scale.

**Previous**: Apr 7 2026 — Day 41 continued: Free Trial + Briefing + GitHub Action + TradingAgents PR (703 tests):
- **FREE TRIAL** (commit 1c9bf9d): 3 signed receipts/day per IP on /v5/status without API key. IP tracking via ORACLE_TELEMETRY KV. 4th request → 402. Live-verified: 3x 200 then 402.
- **GET /v5/briefing** (commit 2d733b6): Daily market intelligence endpoint — markets_open_now, markets_closed_now, markets_in_lunch_break, upcoming_opens/closes, dst_transitions, holidays_today. Public, no auth.
- **GitHub Action** (commit f2a9e64): .github/actions/market-gate reusable action for CI/CD pipelines. Checks exchange status before deploy/trade steps.
- **TradingAgents PR**: TauricResearch/TradingAgents#523 — Market Gate node in risk management pipeline. 12 tests, zero new deps, fail-closed. Uses /v5/demo (free). Optional via `use_market_gate` config flag. Resolves #514.
- **TEST_COUNT**: 692 → 703. viem devDependency added.
- Worker deployed: Version dc13d22d. All pushed to main (commit dec8b70).
- Gap: Free trial IP tracking trusts X-Original-IP headers which can be spoofed by direct callers bypassing Cloudflare proxy. X-Proxy-Token shared secret validation needed at scale.

**Previous**: Apr 7 2026 — Day 41 Payment Pipeline Verification + Ampersend PR (692 tests):
- **CI FIX**: /v5/receipts Supabase query error now degrades gracefully (returns empty receipts, not 500). Root cause: Supabase JS client returns { data, error } on network failure — catch block never fired. CI green on Node.js 22 LTS.
- **CI UPDATE**: GitHub Actions upgraded: actions/checkout@v5, actions/setup-node@v5, Node.js 22 (was deprecated Node.js 20).
- **LIVE 402 VERIFICATION**: All x402 spec fields verified against live production response. extra.name="USD Coin", extra.version="2", network="base", maxAmountRequired="1000", payTo checksummed, resource exact URL — all correct.
- **DRY RUN COMPLETE**: scripts/test-x402-mainnet-minimum.ts dry-run successful. EIP-712 TransferWithAuthorization payload constructed and signed. Waiting for Mike to fund wallet and confirm --send.
- **Payment-Response header ADDED**: Successful x402 settlement now returns `Payment-Response: {"status":"payment-accepted","network":"base"}`. This closes the last x402 spec gap from the Day 40c audit. CORS Expose-Headers updated.
- **Ampersend PR**: edgeandnode/ampersend-examples#11 — working TypeScript example showing ampersend-governed agent consuming Headless Oracle via x402. Demonstrates market-state attestation as policy pre-condition.
- **Ampersend discovery**: app.ampersend.ai/discover has no public registration mechanism. No API or form found. Documented for future reference.
- **viem installed**: Added as devDependency for E2E payment script.
- Worker deployed: Version b7c3d86e. All pushed to main (commit a2fd424).
- Gap: No real x402 payment processed yet — waiting for Mike to fund wallet and run with --send.

**Previous**: Apr 6 2026 — Day 40c x402 Spec Compliance + E2E Audit (691 tests):
- **scripts/test-x402-mainnet-minimum.ts** — real EIP-712 transferWithAuthorization E2E payment script. Uses viem. Dry-run by default, `--send` to spend $0.001 USDC. Ready for Mike to run with funded wallet.
- **docs/ampersend-sdk-compatibility.md** — full x402 SDK format comparison (header names, EIP-712 domain, payload structure, v1 vs v2). Confirmed: Headless Oracle is fully compatible with @coinbase/x402 and Ampersend SDK. No blocking mismatches.
- **CORS audit: CLEAN** — all 5 payment endpoints (status, batch, sandbox, credits/purchase, x402/mint) return correct preflight with Payment-Signature in Allow-Headers and Payment-Required in Expose-Headers.
- **OpenAPI spec fixes**: Payment-Signature + X-Payment header params added to /v5/status and /v5/batch; 402 response documented on /v5/status; batch description updated to mention x402 payment option.
- **agent.json**: batch_amount_units field added (0.005 USDC) to clarify batch vs single pricing.
- **agent_actions.pay_per_request**: header_names now lists both ['Payment-Signature', 'X-Payment'] (was only X-Payment).
- **Discovery consistency**: x402.json uses "base" (x402 v1), agent.json uses "eip155:8453" (CAIP-2) — both valid, no code change needed (verifyX402Payment accepts all three forms).

**Previous**: Apr 6 2026 — Day 40b Unified Payment Parsing (687→691 tests, worker aa6bfe5c):
- **CRITICAL FIX: verifyPaymentAnyFormat()** — all 6 X-Payment entry points now accept BOTH raw JSON (direct on-chain) AND base64-encoded JSON (x402 standard/CDP facilitator). Previously 5 of 6 paths only accepted raw JSON while 402 responses told agents to use base64-json. An agent following the instructions would get rejected.
- **paymentHeaderEncoding** changed from `'base64-json'` to `['base64-json', 'json']` in `build402Payload` and `buildX402ScanPayload` (facilitator path keeps `'base64-json'` since that's all CDP accepts)
- **agent_actions.pay_per_request** now documents both `accepted_formats` with example flows for each
- **Fixed sandbox crash** — `sbPayment is not defined` error when minting credit key via x402 sandbox path
- **Funnel metrics live** — `/v5/metrics/public.funnel_402_today` tracking 5 distinct exit points (already seeing data: 43 402s today, 5 keyless_no_payment)
- CDP credentials confirmed working in production (CDP_API_KEY_NAME + CDP_API_KEY_PRIVATE_KEY set)

**Previous**: Apr 6 2026 — Day 40 Payment Friction Removal (680→687 tests, +7, worker f74521de):
- **buildAgentActions()** helper — unified `agent_actions` block in every 402 response (pay per request, get credits instantly, mint key, buy subscription)
- **paymentHeaderName/paymentHeaderEncoding** in `accepts[0]` for all three 402 builders
- **alternatives dead-end fixed** in `build402Payload` — `prepaid` circular URL → `sandbox_x402` + `mint_key`
- **Funnel observability** — `incrementKvCounter` at 5 distinct 402 exit points; exposed in `/v5/metrics/public.funnel_402_today`
- **7 new tests** covering agent_actions on all three 402 paths + funnel counter seeding

**Previous**: Apr 6 2026 — Day 39 Performance Sprint (674→680 tests, +6, worker e85ece2c):
- Ed25519 Gpows pre-warm at module init (`void ed.getPublicKeyAsync`)
- Private key bytes cached across requests (module-level `_cachedPrivKeyBytes`)
- MCP tools/call KV bottleneck removed: telemetry deferred to `ctx.waitUntil`, ORACLE_OVERRIDES cached in module memory (10s TTL, `clearOverrideCache()` for tests)

**Previous**: Apr 5 2026 — Day 38 Revenue Infrastructure Sprint (671→674 tests, +3):
- **docs/STATE_OF_PRODUCT.md** — comprehensive audit of all endpoints, pricing, auth, infra, what's wired vs. stubbed
- **GET /v5/pricing** — JSON pricing tiers endpoint (sandbox/free/x402/credits/builder/pro/protocol). Public, no auth.
- **3 new tests** for /v5/pricing (tiers array shape, x402 Base mainnet fields, builder daily limit)
- **x402 price note**: current is $0.001 USDC (1000 units). Proposed increase to $0.01 pending founder approval.
- **docs/outreach/**: twitter-thread-day38.md, linkedin-post-day38.md, github-dm-template.md, datacamp-cold-email.md
- **docs/outreach/developer-targets.md**: 30 repos across 4 priority tiers with outreach templates
- Worker not yet deployed — run `npm run deploy` after approval.

**Previous:** Day 37 Distribution Sprint (664→671 tests, +7, worker 6e73cd5d):

### Phase 1 — Telemetry (shipped)
- **Referrer tracking**: every request with a non-self Referer increments `referrer:{date}:{domain}` KV counter
- **GET /v5/referrers**: public endpoint — `{ date, referrers: { "github.com": 12, ... } }`, supports `?date=`
- **Status code counters**: `json()` helper increments `status_code:{date}:{code}` best-effort on every response
- **GET /v5/metrics/public**: now includes `status_codes_today: { "200": N, "402": N, ... }`
- **Convenience redirects**: GET /npm → npmjs.com, /pypi → pypi.org, /github → github.com (all 302)
- **Blog canonical headers**: `Link: <url>; rel="canonical"` on all /blog/* responses
- Gap: referrer KV write hotspot at scale — no coalescing. Fix when a single domain exceeds ~100 req/day.

### Phase 2 — Distribution content (ready to paste)
All content generated in session output. Human tasks:
- [ ] PR to georgezouq/awesome-ai-in-finance (Data Sources section)
- [ ] PR to wilsonfreitas/awesome-quant (Calendars & Market Hours section)
- [ ] PR to edarchimbaud/awesome-systematic-trading (Libraries and Packages table)
- [ ] Issue on TauricResearch/TradingAgents (risk management market-state gap)
- [ ] dev.to post #1: "Why Your Trading Agent Needs a Pre-Trade Gate"
- [ ] dev.to post #2: "Market Hours APIs Are Not Enough for Autonomous Agents"
- [ ] PulseMCP submission (npx headless-oracle-mcp, https://headlessoracle.com/mcp)
- [ ] mcp.so submission (same details)
- [ ] PR to google/adk-docs (docs/integrations/headless-oracle.md)
- [ ] PR to agno-agi/agno (cookbook/tools/headless_oracle_market_gate.py)

**Previous significant work**: Apr 4 2026 (session 2) — registry endpoint polish:
  - `/v5/metrics/public`: added `unique_mcp_clients_today`, `mcp_requests_today` (live, not zero),
    `install`, `evaluator_platforms`, `response_time_ms`, `ecosystem_listings`
  - `/.well-known/mcp-servers.json`: added `install`, `clients`, `metrics_url`, `health_url`, `demo_url`
  - Extracted `getMcpUsageToday()` helper — cache-first (traction_cache KV), live fallback (KV list scan).
    Both `/v5/metrics/public` and `/v5/traction` now use it; the old live-compute duplication is gone.
  - Gap closed: metrics/public now returns real client/request counts at any hour, not zeros pre-17:00.
  - Worker: d509c8b7 → (post-housekeeping deploy)
  - +2 tests (664 total)
**Previous significant work**: Apr 4 2026 — stdio MCP package + distribution sprint:
  - NEW: `packages/headless-oracle-mcp/` — local stdio MCP server, zero npm dependencies
  - Proxies tools/list + tools/call to headlessoracle.com/mcp; handles initialize/ping locally
  - Published to npm: `headless-oracle-mcp@1.0.1` (npmjs.com/package/headless-oracle-mcp)
  - `npx headless-oracle-mcp` works — tested initialize + tools/list + tools/call
  - Supports HEADLESS_ORACLE_API_KEY env var (X-Oracle-Key + Authorization: Bearer)
  - README covers Claude Desktop, Cursor, Cline, Windsurf, Continue.dev configs
  - PURPOSE: enables punkpeye/awesome-mcp-servers listing (requires GitHub-hosted server, not remote connector)
  - HUMAN TASK: reopen PR on punkpeye/awesome-mcp-servers referencing this package
**Previous significant work**: Apr 3 2026 — Weekend Sprint Tier 3 (641 → 647 tests, +6, worker 20d59abc):
  - ITEM 8: Olas + AutoGPT integration docs served at /docs/integrations/olas and /docs/integrations/autogpt
  - ITEM 9: /.well-known/security.txt updated — Expires 2027-04-03, Canonical field added
  - ITEM 10: Blog post "Why Your Trading Agent Needs a Pre-Trade Gate" at /blog/why-your-trading-agent-needs-a-pre-trade-gate
  - SITEMAP_XML: 3 new entries (Olas, AutoGPT, blog post)
  - LLMS_TXT: "Agent Framework Integrations" + "Blog" sections added
  - docs/blog/why-your-trading-agent-needs-a-pre-trade-gate.md created
  - Existing security.txt test updated to match new Expires + Canonical fields
**Previous significant work**: Apr 3 2026 — Weekend Sprint Tier 2 (633 → 641 tests, +8, worker 8c64aa40, commit df538f0):
  - MCP initialize _meta block: x402_enabled, payment_count_url, upgrade_path_url, sandbox_url, x402_discovery
  - New 5th MCP tool: get_payment_options — returns upgrade ladder, no auth, always 200
  - verifyReceiptLogic() extracted as shared helper function
  - POST /v5/verify — public REST receipt verification (reuses verifyReceiptLogic)
  - GET /x402 — x402 Foundation compatibility declaration (first_payment_at from KV)
  - X-X402-Foundation: compatible header on all 402 responses
  - buildPaymentOptions() helper extracted — reused by /v5/why-not-free and get_payment_options MCP tool
  - wrangler.toml: /x402 and /v5/verify routes added
  - Pre-existing test updated: "4 tools" → "5 tools"
**Previous significant work**: Apr 2 2026 — MCP protocol conformance audit (615 tests, 550 passing):
  - tools/call with missing "name" → -32602 Invalid Params (was -32601 Method Not Found)
  - get_market_schedule computation wrapped in try/catch → returns isError:true on unexpected error (was uncaught, could 500)
  - Outer .catch() added on handleMcp call in main router → JSON-RPC -32603 on uncaught throws
  - verify_receipt tool description corrected: SIGNATURE_VALID (uppercase) was documented as signature_valid (lowercase)
  - 10 new tests: null/string/malformed-hex receipt, unknown MIC in schedule, missing params, initialize conformance
**Previous significant work**: Apr 2 2026 — security.txt + OpenAPI gap closed (commit 534aab2, worker 554e1896):
  - GET /.well-known/security.txt live — RFC 9116, Contact/Expires/Preferred-Languages
  - /.well-known/security.txt added to OpenAPI 3.1 spec (42 total paths) and LLMS_TXT endpoint table
  - 3 tests: 2 for route, 1 OpenAPI paths assertion (606 total, 541 passing)
  - MIT LICENSE + package.json "license": "MIT" added for Glama score (commit c9b3b25)
  - HUMAN TASK: Check Glama score at https://glama.ai/mcp/servers/LembaGang/headless-oracle-v5 in ~24h

**Previous significant work**: Apr 2 2026 — MIT license added (commit c9b3b25):
  - Added LICENSE (MIT) and "license": "MIT" to package.json
  - Required for Glama score — "license not found" was causing F grade on punkpeye/awesome-mcp-servers PR #4005
  - HUMAN TASK: Glama re-scans repos periodically; check https://glama.ai/mcp/servers/LembaGang/headless-oracle-v5 for updated score in ~24h

**Previous significant work**: Apr 2 2026 — x402 mainnet migration + Bazaar discovery (commit abd89c7, worker 086e72cf):
  - x402 switched from Base Sepolia testnet to Base mainnet via CDP facilitator (https://api.cdp.coinbase.com/platform/v2/x402)
  - Network updated: eip155:84532 → eip155:8453, USDC contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  - X402_ENABLED now defaults true (opt-out via X402_ENABLED=false); was previously opt-in
  - payTo: 0x26d4ffe98017d2f160e2daae9d119e3d8b860ad3, amount: 1000 units ($0.001 USDC)
  - Bazaar discovery extension added to /v5/status receipts: discoverable:true, category:financial-data, 11 tags
  - agent.json payment.network updated to eip155:8453
  - UNSIGNED_WRAPPER_FIELDS updated to include 'extensions' (fix for verify_receipt signature verification)
  - 3 mainnet facilitator tests pass; 64 pre-existing failures unchanged (527 passing)
  - GAP: Bazaar extension is on /v5/status only. /v5/batch and /v5/demo receipts don't carry Bazaar metadata. Add when Bazaar aggregates multi-receipt responses.
  - HUMAN TASK: Verify 402 response post-deploy: `curl -I https://headlessoracle.com/v5/status?mic=XNYS` should show HTTP 402 with X-X402-Network: mainnet and X-Payment-Required: true

**Previous significant work**: Apr 2 2026 — Agent Zero Plugin Hub PR submitted and CI passing:
  - PR: https://github.com/agent0ai/a0-plugins/pull/193 — open, green CI tick
  - Fix applied: description field in index.yaml quoted to escape colons (YAML parse error caught by a0-bot)
  - docs/agent-zero-plugin/index.yaml updated with fix (source file kept in sync)
  - plugin.yaml at repo root (name: headless_oracle, v1.0.0) — required by Agent Zero plugin system
  - skills/headless_oracle.md — Agent Zero skill file (auto-loaded when market context needed)
  - HUMAN TASK: Monitor PR for maintainer merge/feedback at https://github.com/agent0ai/a0-plugins/pull/193
  - Triggered by: Agent Zero instance AgentZero/19353 hit MCP endpoint unprompted tonight
  - GAP: plugin.yaml has no backend code — purely a skill+metadata plugin. If Agent Zero users want MCP auto-configuration on install, a Python backend extension would be needed (out of scope for initial listing)
  - Tests: 539/604 passing (65 pre-existing EBUSY, no regressions)

**Previous significant work**: Apr 1 2026 (evening) — Ampersend integration (commit 4d9aec5, worker abac0129):
  - GET /skill.md live — Ampersend skill format (YAML frontmatter: x402 payment details, ERC-8004 8453:38413, pricing $0.001 USDC, networks base+base-sepolia, MCP endpoint, all 28 exchanges, verify usage pattern)
  - AGENT_JSON updated: skill_url, erc8004 (8453:38413), ampersend listing URL
  - /.well-known/mcp/server-card.json updated: same skill_url + erc8004 fields
  - LLMS_TXT updated: Listings section with Ampersend registry + ERC-8004 entry
  - ROBOTS_TXT: Allow /skill.md added
  - wrangler.toml: headlessoracle.com/skill.md route added
  - X402_TEST_WALLET set in .dev.vars (gitignored) — HUMAN TASK: wrangler secret put X402_TEST_WALLET (value: 0x26d4ffe98017d2f160e2daae9d119e3d8b860ad3)
  - GAP: /skill.md has no unit test yet — add test when Ampersend format stabilises
  - Tests: 539/604 (65 pre-existing Windows EBUSY, no regressions)

**Live endpoints**: All including /v5/usage (auth), /v5/traction (public), /v5/x402/mint (public), /v5/webhooks/subscribe, /v5/webhooks (GET list), /v5/webhooks/:id (DELETE), /v5/webhooks/unsubscribe (legacy DELETE), /v5/webhooks/test/:id (POST test delivery), /v5/webhooks/health (public), /v5/receipts (builder+), /v5/sandbox (public), /v5/implementations (public), /v5/showcase (public), api.headlessoracle.com/*, /.well-known/x402.json, /oauth/token, /oauth/introspect, /.well-known/oauth-authorization-server, /.well-known/agent.json (A2A), /.well-known/mcp/server-card.json, /.well-known/ai-plugin.json, /ai-plugin.json, /status, /badge/:mic, /v5/card/:mic (live SVG status card), /v5/changelog, /v5/archive, /v5/conformance-vectors, /v5/stream (SSE via Durable Object), /v5/dst-risk (public), /docs/sma-protocol/rfc-001 (public), /docs/mpas (public)
**PyPI packages**: headless-oracle-langchain@1.0.1 (pypi.org/project/headless-oracle-langchain/), headless-oracle-crewai@1.0.1 (pypi.org/project/headless-oracle-crewai/)
**npm packages**: headless-oracle-setup@1.0.1 (npx headless-oracle-setup — zero-dep MCP setup for Claude Desktop/Cursor/Windsurf)
**www redirect**: www.headlessoracle.com/* → 301 → headlessoracle.com/* (Worker-level, permanent)
**api subdomain**: api.headlessoracle.com/* → same worker, all routes work identically. NOTE: requires DNS A/CNAME for api.headlessoracle.com pointing to Cloudflare.
**@headlessoracle/verify**: Published — npmjs.com/package/@headlessoracle/verify v1.0.0 (published, auth token in ~/.npmrc)
**Go SDK**: github.com/LembaGang/headless-oracle-go — zero stdlib deps, oracle.Verify(), 9 tests
**Exchanges**: 28 total (23 traditional + XCBT/XNYM overnight CME, XCBO Cboe options, XCOI Coinbase 24/7, XBIN Binance 24/7). mic_type: "iso" | "convention" on all entries.
**Last significant work**: Apr 1 2026 — Post-Accra Sprint Verification (604 tests, no new tests):
  - POST-SPRINT VERIFICATION COMPLETE. All blocks passed after fixes.
  - FIX 1: traction.html missing from vite.config.js rollup inputs — /traction was serving homepage fallback. Added to build inputs, rebuilt, redeployed (web commit fad51dd).
  - FIX 2: /.well-known/mcp.json returned 404 — route didn't exist. Added as alias for /.well-known/mcp/server-card.json in worker (commit 187a5ce). Now returns 200 with full server card JSON.
  - FIX 3: docs.html had no link to /docs/quickstart or /docs/x402-payments. Added sidebar links and in-section link in Quick Start section (same web commit fad51dd).
  - GAP-016: x402 testnet facilitator cache — verifyX402ViaFacilitator() makes a network call per request with no replay-proof KV cache. Add x402_testnet_used:{paymentHeaderHash} KV key (TTL 300s) before testnet goes to production traffic.
  - Worker: 9ecfe821 | Web: a09eb9af.headless-oracle-web.pages.dev
  - Tests: 604 total, 65 pre-existing EBUSY (Windows), 539 passing.

**Previous significant work**: Apr 1 2026 — Accra Sprint (604 tests, +3 testnet x402):
  - TASK 1: MCP tool descriptions rewritten for Agent Tool Search keyword discoverability (pre-trade gate, execution safety, market verification, Ed25519, SMA keywords). Server `instructions` updated. AGENT_JSON/server-card.json/LLMS_TXT surfaces updated.
  - TASK 2: AGENTS.md created at repo root (AAIF/Linux Foundation coordinator mode briefing: purpose, critical rules, tools, x402, auth, 28 exchanges). Served at /AGENTS.md. Route added to wrangler.toml. ROBOTS_TXT updated.
  - TASK 3: docs/mcp-config-template/{mcp-sandbox.json,mcp-http.json} created. headless-oracle-web/public/docs/quickstart/index.html created (3-step quickstart with copy buttons). LLMS_TXT quick start link updated. AGENT_JSON quickstartUrl added. server-card.json quickstart_url added.
  - TASK 4: GitHub Issue #11 on aws-samples/sample-agentcore-cloudfront-x402-payments reviewed. Follow-up comment prepared (human task — see SESSION END REPORT below).
  - TASK 5: x402 testnet facilitator prototype implemented. New env vars: X402_ENABLED, X402_TEST_WALLET. New constants: X402_SEPOLIA_USDC_CONTRACT (Base Sepolia), X402_FACILITATOR_URL. New functions: verifyX402ViaFacilitator(), buildTestnetX402Payload(). Testnet path injected into /v5/status no-API-key branch (gated behind X402_ENABLED=true). 3 new tests: 402 on no payment, 200 on valid facilitator mock, 402 on rejected facilitator.
  - TASK 6: /.well-known/x402.json updated to include testnet resources when X402_ENABLED=true + X402_TEST_WALLET set (Base Sepolia, eip155:84532, X402_SEPOLIA_USDC_CONTRACT).
**Previous significant work**: Mar 31 2026 — Conversion & ecosystem gaps (601 tests):
  - GAP-A: Sandbox 25 calls/24h → 200 calls/7 days. Upgrade ladder now clear: sandbox → credits → Builder.
  - GAP-B: GET /v5/implementations — public standards registry (SMA/MPAS/APTS, 5 implementations). AGENT_JSON gets implementations_registry field. GitHub issue templates in sma-protocol + mpas-spec repos.
  - GAP-C: POST /v5/sandbox accepts optional use_case field. SANDBOX_SIGNUP event logged (hashed, no PII). P.S. line in welcome email invites design partner conversation.
  - GAP-D: GET /v5/showcase — seeded with Halt Simulator. submit_url points to showcase-submit page (human task: build form on headless-oracle-web).
  - GAP-014: Already implemented + tested in previous session — no new work needed.
  - Deployed: Version 0b420ca0. Pushed to main (b66e9f6).
**Previous significant work**: Mar 30 2026 — Sprint 4: OpenAPI paths fix, MPAS spec, AgentCore oracle integration (597 tests + 16 payer-agent tests):
  - OpenAPI spec bug fixed: 10 new paths (webhooks, credits, x402/mint, card) now correctly nested inside paths: object — 39 total
  - MPAS-1.0 spec published: docs/multi-party-attestation-spec.md (651 lines, Apache 2.0)
  - /docs/mpas route live — serves MPAS spec; wrangler.toml routes added for /docs/mpas and /docs/sma-protocol/rfc-001
  - agent.json and server-card.json updated with mpas_spec + mpas_version fields
  - LLMS_TXT updated with MPAS link
  - AgentCore sample wired: oracle_tools.py check_market_status + build_payment_attestation @tool wrappers
  - config.py: oracle_api_url, oracle_mic, oracle_api_key fields; .env.example oracle section
  - main.py: oracle tools in CORE_TOOLS, Step 0 market verification in SYSTEM_PROMPT
  - 16/16 payer-agent pytest tests passing
  - Deployed: Version d2d0eb83 → eb708338
**Previous significant work**: Mar 30 2026 — Sprint 3: GAP-012/013, credit packs, DO health endpoint (597 tests):
  - GAP-012 CLOSED: safe_to_execute re-checks ORACLE_OVERRIDES after buildSignedReceipt (catches halt-monitor race)
  - GAP-013 CLOSED: batch receipts now written to Supabase audit log (source='batch') via insertReceiptAudit()
  - Paddle credit packs: PADDLE_PRICE_ID_CREDITS secret; POST /v5/checkout?type=credits creates one-time transaction
  - Webhook transaction.completed: detects credits price_id before subscription_id guard → mints ho_crd_ key (balance:1000, no expiry)
  - checkApiKey credits tier: balance-based auth, atomic decrement on each call, 402 CREDITS_EXHAUSTED at balance=0 (insight + plans in body)
  - GET /v5/webhooks/health (public): reads webhook_dispatcher:health KV key written by DO alarm() — no DO instance creation
  - WebhookDispatcher.alarm(): writes { status, next_alarm } to ORACLE_TELEMETRY KV after rescheduling
  - Removed cron DO heartbeat call (durable alarms survive eviction; heartbeat was unnecessary and caused Miniflare SQLite EBUSY on Windows)
  - 597/597 tests passing. Deployed (Version 4e7665cd).
**Previous significant work**: Mar 30 2026 — Sprint 2: webhook CRUD + plan limits + WebhookDispatcher DO (586 tests):
  - GET /v5/webhooks — list all webhooks for authenticated key (webhook_id, url, mics, events, created_at, status)
  - DELETE /v5/webhooks/:webhook_id — path-based delete → 204, decrements webhook_count KV
  - POST /v5/webhooks/test/:webhook_id — synthetic delivery, 1 attempt, returns payload_sent schema
  - POST /v5/webhooks/subscribe: plan limits (builder=5, pro=25); response now includes webhook_id + subscription_id (backward compat); webhook_count KV tracking
  - deliverWebhook(): HMAC-SHA256 (X-Oracle-Signature header), 3-retry exponential backoff (1s/4s/16s), maxAttempts param (1 for test endpoint)
  - computeHmacSignature() helper: sha256=<hmac_hex> format
  - Webhook payload schema: event, webhook_id, mic, previous_status, current_status, receipt, delivered_at (removed secret from body)
  - WebhookDispatcher DO: alarm-based state-change detection every 60s; reads from KV; DO storage for last_state; self-reschedules alarm; bootstrap via fetch /bootstrap
  - wrangler.toml: WEBHOOK_DISPATCHER binding + v2 migration
  - 12 new tests added (574→586)
**Previous significant work**: Mar 27 2026 — Day 27 continued: /v5/card/:mic + agent-demo repo (558 tests):
  - /v5/card/:mic live endpoint: terminal-style SVG card, image/svg+xml, Cache-Control: no-cache
  - generateStatusCard(): dark chrome, syntax-highlighted JSON fields, status-coloured text, pulsing LIVE dot
  - headless-oracle-agent-demo repo: README updated with live SVG card (replaces planned demo GIF)
  - headless-oracle-langchain@1.0.1 + headless-oracle-crewai@1.0.1: 3-priority key resolution (env → config file → sandbox auto-provision)
  - 558/558 tests passing. Deployed (Version 22989c5c). Pushed.
**Previous significant work**: Mar 27 2026 — Day 27 sprint (553 tests + PyPI packages):
  - SMA disambiguation: "SMA = Signed Market Attestation, not Simple Moving Average" added to MCP tool descriptions, ai-plugin.json, LLMS_TXT, all SDK READMEs
  - "23 exchanges" bug fixed: 10 occurrences in src/index.ts updated to "28 global exchanges (equities, derivatives, and 24/7 crypto)"
  - /v5/dst-risk endpoint: EU DST transition March 29 — affected_exchanges (7), transition details, timing_utc, agent advisory (2 tests)
  - discovery_url wrapper: every receipt endpoint (/v5/demo, /v5/status, /v5/batch, /v5/health) now returns discovery_url + nested receipt copy (4 tests)
  - verify_receipt canonical payload: UNSIGNED_WRAPPER_FIELDS = Set(['discovery_url', 'receipt']) excluded from sig verification
  - server-card.json: sma_protocol_version, sma_note, conformance_vectors URL, dst_aware, discovery_url added
  - AGENT_JSON: sma_protocol_version, conformance_vectors, sma_disambiguation, dst_aware, discovery_url added
  - /docs/sma-protocol/rfc-001: SMA_RFC_001_MD constant + route serving RFC-001 markdown
  - npx headless-oracle-setup@1.0.1: published to npm — zero-dependency MCP client setup for Claude Desktop/Cursor/Windsurf
  - headless-oracle-langchain@1.0.0: published to PyPI — LangChain MarketStatusTool + MarketScheduleTool, auto-provision sandbox key
  - headless-oracle-crewai@1.0.0: published to PyPI — CrewAI MarketStatusTool + MarketScheduleTool, auto-provision sandbox key
  - LLMS_TXT: rewritten with "Instructions for Autonomous Agents" section, SMA disambiguation, 28 exchanges
  - Deployed: 3 worker versions (f712f79a, 42b90a62, 8b26624e). 553 tests passing.
**Previous significant work**: Mar 25 2026 — capability audit + surface update (547 tests):
  - Updated all user-facing surfaces from 23 → 28 exchanges (LLMS_TXT, SKILL_MD, MCP_TOOLS, AGENT_JSON, OpenAPI spec, docs/registry-server.json, docs/mcp-listing.md)
  - Added /v5/archive, /v5/stream, /v5/conformance-vectors to LLMS_TXT endpoint table, AGENT_JSON endpoints, and OpenAPI spec
  - MCP tool mic enums expanded: XCBT, XNYM, XCBO, XCOI, XBIN added to get_market_status and get_market_schedule
  - SKILL_MD exchange table expanded from 7 → 28 rows with mic_type column
  - Go SDK (github.com/LembaGang/headless-oracle-go) mentioned in LLMS_TXT verification section and SKILL_MD discovery endpoints
  - settlement_window (T+1/T+2) documented in LLMS_TXT exchanges section
  - Deployed: Version e615148e-81f6-4feb-9495-ac6f0973a62b
**Previous significant work**: Mar 25 2026 — infrastructure sprint (547 tests):
  - ITEM 1: /v5/archive — template literal bug fixed; KV list prefix now resolves correctly
  - ITEM 2: /v5/conformance-vectors — 5 live-signed test vectors (XNYS OPEN/CLOSED, XJPX lunch, UNKNOWN, HEALTH OK) with canonical_payload base64 + public_key for SDK authors
  - ITEM 3: headless-oracle-go SDK — github.com/LembaGang/headless-oracle-go; zero non-stdlib deps; crypto/ed25519 verify; oracle.Verify() with 4 sentinel errors; 9 tests
  - ITEM 4: /v5/stream — SSE endpoint via StreamCoordinator Durable Object; signed market_status events every 30s; halted terminal event; auth required; DO binding + migration in wrangler.toml
  - ITEM 5: settlement_window in /v5/schedule — T+1 (XNYS/XNAS/DTCC), T+2 (XLON/Euroclear, XJPX/JSCC); null for all others; 6 tests
  - ITEM 6: crypto/derivatives exchange coverage — XCBT/XNYM (ISO, overnight CME Globex, overnightSession flag + Sunday pre-open guard), XCBO (ISO, 9:30–16:15 ET), XCOI/XBIN (convention, 24/7 weekends:[]); mic_type field on all exchanges; 28 new tests; AGENT_JSON + server-card.json now derive exchange list dynamically from SUPPORTED_EXCHANGES
  - Deployed: Version bb6992d7. Pushed to main (dc4ef5f).
**Previous significant work**: Mar 24 2026 — reach infrastructure sprint (483 tests):
  - GET /.well-known/ai-plugin.json + /ai-plugin.json: ChatGPT/OpenAI plugin manifest (schema_version v1, name_for_model: headless_oracle)
  - GET /status: HTML real-time market status page, all 23 exchanges, auto-refresh 60s, colour-coded OPEN/CLOSED/HALTED/UNKNOWN
  - GET /badge/:mic: SVG shields.io-style status badge (green=OPEN, grey=CLOSED, red=HALTED, orange=UNKNOWN), Cache-Control 60s
  - GET /v5/changelog: structured versioned changelog feed, 5 entries, no auth required
  - docs/integrations.md: LangChain, Vercel AI SDK, AutoGen, CrewAI, OpenAI Assistants framework examples
  - docs/quickstart.md: 5-minute quickstart (curl, Python, Node.js)
  - docs/mcp-registry-submission.md: complete MCP registry submission document (Smithery/mcp.so ready)
  - headless-oracle-web index.html: inline sandbox key generator with email capture, copy button, pre-filled curl command
  - LLMS_TXT + AGENT_JSON updated with new routes
  - 6 new tests; 483/483 passing
  - Deployed: Version ed26b119. Pushed to main (ceae11e).
  - Web repo: index.html updated. Pushed to main (37cfd36).
**Previous significant work**: Mar 24 2026 — x402 autonomous key minting + per-tool MCP telemetry (477 tests):
  - POST /v5/x402/mint: agents submit Base mainnet USDC tx_hash → get persistent ho_live_ key. builder (99 USDC = 50K calls/day), pro (299 USDC = 200K calls/day). Replay protection via x402_used_tx: KV (365-day TTL, separate from per-request x402_used: TTL). Keys stored in ORACLE_API_KEYS KV (no expiry) + non-blocking Supabase insert. Non-blocking Resend email if email field present.
  - Per-tool MCP telemetry: mcp_tool:{name}:{date} KV counters for get_market_status, get_market_schedule, list_exchanges, verify_receipt (via incrementKvCounter). Per-client breakdown stored in McpClientRecord.tools (second non-blocking KV read-modify-write inside tools/call case).
  - /v5/traction: mcp_tools_today object (live 4 KV gets in both cached and uncached paths)
  - /v5/handoff: "## MCP Tool Calls Today" markdown section
  - /v5/health: mcp_tools_today in response (pre-computed via Promise.all before withRateLimitWarning)
  - /.well-known/x402.json: /v5/x402/mint added as third resource with tier pricing
  - agent.json: mint_endpoint: 'https://headlessoracle.com/v5/x402/mint'
  - LLMS_TXT: Path C (autonomous key minting) documented
  - Deployed: Version d789d582. Pushed to main (9a1dc0f).
  - 13 new tests in test/x402_mint_telemetry.spec.ts (7 mint + 6 telemetry)
**Previous significant work**: Mar 24 2026 — x402 audit + E2E tests + discovery document enrichment (464 tests):
  - Task 1 (audit): x402 flow is complete. Two verified payment paths:
    Path A (per-request): keyless /v5/status → 402 (x402scan format) → X-Payment header → on-chain verify → receipt
    Path B (subscription): Paddle webhook → transaction.completed/subscription.activated → ho_live_ key minted in KV → key auth
  - Task 2: No code gaps. Flow is end-to-end working.
  - Task 3 (E2E test): 3 new tests added in `x402 — end-to-end payment flow` describe block:
    (1) /v5/status without auth → 402 with x402Version/accepts/payTo fields
    (2) Paddle webhook → key minted in ORACLE_API_KEYS KV → key authenticates /v5/status → 200
    (3) Keyless X-Payment header → 200 with signed receipt
    Key fix in test mock: Supabase "no rows" response must be status 406 (not 200) for supabase-js to return data:null
  - Task 4 (discovery docs): agent.json x402_payable:true + payment_endpoint + subscription_endpoint + asset/amount_units;
    server-card.json x402 block with payable:true; llms.txt "x402 autonomous payment (verified working)" section
  - Deployed: Version ca9f5268. Pushed to main (aaf39b5).
**Previous significant work**: Mar 22 2026 (session 2) — Discoverability + telemetry sprint (10 findings, 436 tests):
  - FINDING-10: test for MCP initialize capabilities.tools object + protocolVersion (was already in code)
  - FINDING-12: test for webhook subscribe flow (deliverWebhook Content-Type already in code)
  - FINDING-09: HALT_MONITOR_TIMEOUT structured log on AbortError in halt monitor fetch + test
  - FINDING-01/B: /v5/sandbox added to OpenAPI spec + get_sandbox_key skill in AGENT_JSON
  - FINDING-02/C: json() helper now emits X-Oracle-Plan/X-RateLimit-* headers on every response
  - FINDING-03/D: computeRetryAfterSeconds() + Retry-After on all 7 rate-limit 429 paths; sandbox uses hourly boundary
  - FINDING-04/14: sitemap.xml + Sitemap directive in robots.txt (web repo, not yet deployed)
  - FINDING-13/E: incrementKvCounter() helper; batch_combo/auth_calls/unauth_calls/sandbox_cap_hit telemetry; SANDBOX_DAILY_LIMIT=100 enforced on /v5/status + /v5/batch; /v5/traction exposes batch_combos_today, auth_ratio_today, sandbox_caps_today
  - FINDING-05/G: LLMS_TXT Quick start rewritten to sandbox-first with api.headlessoracle.com URLs
  - Deployed: Version ca63420d. Pushed to main (490c69c).
  - HUMAN TASK: cd C:\Users\User\headless-oracle-web && git push origin main (to publish sitemap.xml)
**Previous significant work**: Mar 22 2026 — Sprint: GAP-012/013 closure, sandbox endpoint, rate-limit headers, MCP enrichment, llms.txt rewrite, tier-gated 402s (426 tests):
  - GAP-012 CLOSED: batch safe_to_execute re-checks ORACLE_OVERRIDES after buildSignedReceipt to catch halt-monitor race
  - GAP-013 CLOSED: /v5/batch now calls insertReceiptAudit() for each receipt (non-blocking, source='batch')
  - GET /v5/sandbox: instant no-auth sandbox key (sb_ prefix, 24h TTL, 100 calls, IP rate-limit 10/hr)
  - checkApiKey: recognises tier:sandbox KV records; checks expires_at belt-and-suspenders
  - makeRateLimitHeaders(): X-Oracle-Plan + X-RateLimit-Limit/Remaining/Reset on all responses
  - withRateLimitWarning: now adds standard RL headers on every wrapped response (public + auth)
  - /v5/receipts: 402 paid_feature for free and sandbox plans; builder+ gets through
  - /v5/webhooks/subscribe: 402 paid_feature for sandbox plan
  - MCP_TOOLS: descriptions enriched with WHEN TO USE, RETURNS, FAILURE BEHAVIOUR, LATENCY
  - server-card.json: reliability, verification, coverage, protocols, fail_closed fields added
  - LLMS_TXT: complete rewrite — agent-first, action-oriented, endpoint table, receipt schema, exchanges list
**Previous significant work**: Mar 22 2026 — Weekend sprint: webhooks, receipt audit, batch summary, GAP-007–009 (409 tests):
  - GAP-007 CLOSED: handleMcp soft-auth now checks expires_at — logically expired tokens fall through as anonymous
  - GAP-008 CLOSED: verify_receipt MCP tool added — Ed25519 verification in-worker, returns {valid, expired, reason, mic, status, expires_at}
  - GAP-009 CLOSED: /.well-known/mcp/server-card.json updated — mcp_endpoint, version v5.0, all 4 tools, authentication array
  - POST /v5/webhooks/subscribe (auth required) — registers webhook URL + MIC list; stored in ORACLE_API_KEYS KV
  - DELETE /v5/webhooks/unsubscribe (auth required) — removes subscription by subscription_id
  - runHaltMonitor: state-change detection via last_state:{mic} KV; fan-out delivery on change
  - deliverWebhook(): HMAC-SHA256 signed payload, 1-retry via scheduler.wait(1000)
  - insertReceiptAudit(): non-blocking Supabase insert on every /v5/status live call
  - GET /v5/receipts (auth required) — filtered audit query with limit, mic, from params
  - GET /v5/batch: enriched with summary {total, open, closed, halted, unknown, all_open, any_halted, safe_to_execute, reason}
  - safe_to_execute: true only when ALL exchanges OPEN, none HALTED/UNKNOWN
  - GAP-012 identified: safe_to_execute ignores REALTIME halt-monitor overrides (race condition at scale)
  - GAP-013 identified: /v5/batch calls not audited (only /v5/status inserts audit rows)
  - DataCamp extension repo: github.com/LembaGang/headless-oracle-datacamp-extension (3 files — README, config-extension.toml, market-safe-agent.ts)
  - Deployed: Version 0524ca6a. Pushed to main (08aa375).
  - HUMAN TASK: Supabase receipt_audit table migration (SQL in GAPS.md GAP-011)
**Previous significant work**: Mar 21 2026 — A2A Agent Card + GAP-001–004 closed (387 tests):
  - /.well-known/agent.json: full A2A Agent Card (name, version, description, capabilities struct, provider, 4 skills including verify_receipt, authentication, input/output schemas, fail_closed:true, all 23 MICs)
  - GAP-001 CLOSED: MCP traffic metered against plan limits — shared daily counter with REST, JSON-RPC -32000 on limit hit
  - GAP-002 CLOSED: /.well-known/x402.json returns resources:[] when ORACLE_PAYMENT_ADDRESS unset
  - GAP-003 CLOSED: POST /oauth/introspect (RFC 7662) — active:true with exp, inactive for expired/missing tokens
  - GAP-004 CLOSED: webhook race hardened via unique_violation code 23505 catch (both transaction.completed + subscription.activated)
  - /.well-known/oauth-authorization-server: includes introspection_endpoint
  - Deployed: Version 3c795be5. Pushed to main (8b4d733).
**Previous significant work**: Mar 21 2026 — OAuth 2.0 optional upgrade path for MCP (382 tests):
  - POST /oauth/token: RFC 6749 client_credentials grant. client_id = existing Oracle API key. Issues opaque 32-byte token, stored in ORACLE_API_KEYS KV as oauth:{sha256(token)} with 3600s TTL.
  - GET /.well-known/oauth-authorization-server: RFC 8414 AS metadata. Describes token_endpoint, grant_types_supported, scopes_supported.
  - /.well-known/oauth-protected-resource updated: authorization_servers now includes headlessoracle.com/oauth + scopes_supported: [oracle:read].
  - POST /mcp: soft auth — Bearer token extracted, validated via KV lookup. ANY failure (missing, invalid, expired) falls through as anonymous. Existing unauthenticated MCP access 100% preserved.
  - wrangler.toml: headlessoracle.com/oauth/token route added.
  - 8 new tests: AS metadata shape, token issuance, invalid_client, invalid_request, unsupported_grant_type, KV storage, MCP with valid token, MCP with invalid token falls through anonymously.
  - github.com/LembaGang/headless-oracle-agentpay created and pushed (5 files).
  - GAP-001 (MCP metering) resolved: handleMcp applies getPlanDailyLimit() after soft auth; returns JSON-RPC -32000 RATE_LIMITED on limit hit; shares free_usage: KV counter with REST gate.
  - 3 new tests: free-tier at limit → -32000, free-tier below limit → success, unauthenticated ignores counter.
  - GAPS.md created at repo root with 6 prioritised gaps.
  - 382/382 tests passing.
**Previous significant work**: Mar 20 2026 — x402scan full fix: input schema + /.well-known/x402.json discovery document (371 tests):
  - buildX402ScanPayload(): x402scan-compatible format (x402Version:1, accepts[], eip155:8453, payTo, maxAmountRequired, maxTimeoutSeconds)
  - input field added: /v5/status requires mic (string), /v5/batch requires mics (string) — fixes "Missing input schema" error
  - /.well-known/x402.json: discovery document listing /v5/status + /v5/batch as paid resources — fixes "No valid x402 response" on 22 free endpoints
  - /v5/status auth gate restructured: key present → existing path; no key → x402 payment path or 402 gate
  - /v5/batch: no key → 402 x402scan format (keyless batch execution not yet implemented)
  - ORACLE_PAYMENT_ADDRESS set as production secret (0x26D4...AD3)
  - CURL confirmed: /v5/status → HTTP 402 live; /.well-known/x402.json → discovery doc live
  - 371/371 tests passing. Commits: 7d52f76, 8533a96, cc2d50c. All pushed to main.
  - HUMAN TASK: resubmit headlessoracle.com resources on x402scan
**Previous significant work**: Mar 20 2026 — llms.txt agent-first rewrite, AgentPay demo repo, KV billing desync fix (368 tests):
  - LLMS_TXT constant rewritten: agent-first, action-oriented, 13 sections (MCP primary, REST contracts, fail-closed rules, 23 MICs, Ed25519 verification, x402 path, rate limits, OAuth discovery)
  - scripts/test-paddle-webhook.ts: end-to-end test script for subscription.activated with handler trace and rate limit trace
  - headless-oracle-agentpay repo created: README.md (ASCII architecture diagram), example-agent.ts, verify.ts, package.json, .env.example
  - CRITICAL FIX: subscription.updated and subscription.past_due now sync KV immediately (previously only updated Supabase — suspended keys remained auth-active for up to 300s)
  - 2 new tests: subscription.updated → KV status 'suspended', subscription.past_due → KV status 'suspended'
  - HUMAN TASK: npm run deploy + git push
**Previous significant work**: Mar 20 2026 — api subdomain + subscription.activated webhook + plan-based rate limits (366 tests):
  - wrangler.toml: api.headlessoracle.com/* route alias added — deployed (b0651728)
  - src/index.ts: subscription.activated handler added (idempotency by subscription_id; plan-upgrade if existing; price at items[0].price.id not items[0].price_id)
  - src/index.ts: BUILDER_TIER_DAILY_LIMIT (50k/day), PRO_TIER_DAILY_LIMIT (200k/day), getPlanDailyLimit() helper
  - src/index.ts: paid tier rate limits applied to /v5/status and /v5/batch (protocol/internal unlimited)
  - Task 3 (404 investigation): /refund is a Pages route — refund.html exists in web repo, not a worker issue. Worker correctly does NOT intercept /refund (not in wrangler.toml routes).
  - 6 new tests: subscription.activated new customer, subscription.activated idempotency, builder 429, pro 429, builder below limit 200, batch builder 429
  - Commit: d6751e4. Deployed + pushed.
**Previous significant work**: Mar 19 2026 — Key issuance pipeline fix (360 tests):
  - /v5/keys/request: Supabase insert now fail-closed (returns 503 if not configured, 500 on error)
  - KV write moved AFTER Supabase success — Supabase is source of truth, KV is the hot-path cache
  - Resend failure: 200 with warning + full resend_error body instead of silent 200 "sent"
  - checkApiKey: AuthResult now carries keyHash (avoids re-hashing on hot path)
  - updateKeyUsage(): new helper updates last_used_at on every authenticated call via ctx.waitUntil
  - 3 new tests: DB error → 500, Resend failure → 200 with warning, last_used_at PATCH verified
  - Root cause of missing Supabase rows: insert result was never checked, errors silently swallowed
  - Commit: 9b5725d. HUMAN TASK: `npm run deploy` then `git push`
  - NOTE: request_count increment requires DB migration — see comment above updateKeyUsage in index.ts
**Previous significant work**: Mar 18 2026 — Sessions T+U+V: DST post-mortem content, traction page, conversion audit (357 tests):
  - docs/content/ created with 4 DST post-mortem files (full technical, Reddit, HN, Twitter thread)
  - Session U audit: /v5/traction confirmed in OpenAPI spec and llms.txt; DESIGN_PARTNER_CANDIDATE fires in test logs
  - traction.html live — fetches /v5/traction, auto-refreshes every 60s, linked from index.html footer
  - Canonical URL tags added to all 8 HTML pages (index, docs, pricing, status, verify, terms, privacy, refund)
  - Worker deployed (Version 744beecf). Pages deployed. Both repos pushed to main.
  - 357/357 tests passing.
**Previous significant work**: Mar 17 2026 (evening) — Sessions Q+R+S: conversion infrastructure (357 tests):
  - GET /v5/usage (auth) — per-key usage stats, free tier limits, credit balance, upgrade info
  - GET /v5/traction (public) — live metrics snapshot for investor/partner check-ins
  - Soft rate-limit warning headers at 80%/95% free tier usage (X-RateLimit-Warning etc.)
  - Design partner detection at >200 req/day (DESIGN_PARTNER_CANDIDATE log, KV dedup)
  - Key request email rewritten with founder-personal tone + conversion links
  - 402 response includes founder_note humanising the payment gate
  - Weekly digest cron (0 9 * * 1) — MCP client analytics summary to KV
  - DST reminder crons consolidated into daily 0 9 * * * (Cloudflare 5-cron limit respected)
  - OpenAPI + AGENT_JSON + LLMS_TXT updated with new endpoints
  - Outreach assets: docs/outreach/ (3 files), docs/investor-one-pager.md, docs/design-partner-pitch.md
  - Deployed (Version 79a18a2f). Pushed to main.
  - 357/357 tests passing.
**Previous significant work**: Mar 17 2026 — Accuracy Audit: all surfaces updated to 23 exchanges (345 tests):
  - src/index.ts: MCP initialize instructions, OpenAPI health endpoint exchange_count, compliance settlement_window evidence
  - smithery.yaml: full rewrite to 23 exchanges, all 23 MICs in tool descriptions
  - OPERATOR_RUNBOOK.md: 7->23 count + expanded MIC list
  - docs/halt-monitor.md: added US-only real-time detection coverage note
  - 20+ docs files: all "7 exchanges" -> "23 exchanges", old 7-MIC list -> all 23 MICs
  - headless-oracle-web: index.html, docs.html, pricing.html, status.html all updated
  - sma-protocol standalone repo: IMPLEMENTATIONS.md + README.md updated
  - Deployed worker (Version 489d2ee2). All repos pushed to main.
  - 345/345 tests passing.
**Previous significant work**: Mar 18 2026 — Sessions L+M: 23 exchanges + autonomous halt monitor (345 tests):
  - Session L: weekends?: string[] field in MarketConfig — XSAU/XDFM use ['Fri','Sat'] (Sunday is a trading day)
  - Session L: 16 new exchanges added — XASX, XBOM, XNSE, XSHG, XSHE, XKRX, XJSE, XBSP, XSWX, XMIL, XIST, XSAU, XDFM, XNZE, XHEL, XSTO
  - Session L: XSHG/XSHE have lunchBreak 11:30–13:00 CST
  - Session L: MICS_SUPPLEMENT, MCP tool enums, LLMS_TXT, SKILL_MD, AGENT_JSON all updated 7→23
  - Session L: Timezone coverage map section added to LLMS_TXT
  - Session M: POLYGON_API_KEY? added to Env interface
  - Session M: REALTIME added to SourceValue type + OpenAPI Source enum
  - Session M: runHaltMonitor() — Polygon.io primary → Alpaca fallback; REALTIME KV overrides with 2h TTL; fail-open
  - Session M: * * * * * cron trigger added to wrangler.toml
  - Session M: GET /v5/status/realtime — auth required; signed receipt + halt_monitor metadata
  - Session M: /v5/health includes halt_monitor section with active_realtime_overrides
  - Session M: LLMS_TXT Autonomous Halt Monitoring section added
  - 345/345 tests passing. Worker deployed (bd9db999). Pushed.
**Previous significant work**: Mar 18 2026 — Sessions I–K: web frontend x402 launch, doc routes, standalone repos (238 tests):
  - Session I: pricing.html — Pay-per-use x402 tier added (5-column grid, indigo theme, $0.001/req)
  - Session I: index.html — hero copy "The only market oracle autonomous agents can pay for themselves." + x402 badge
  - Session I: /docs/integrations/datacamp-workspace — DataCamp/Jupyter guide (sent to Filip Schouwenaars)
  - Session I: /docs/integrations/langgraph, /docs/integrations/bun, /docs/integrations/anthropic-claude — HTML guides
  - Session I: /docs/x402-payments — Full x402 guide page (HTML, served by Pages)
  - Session J: /docs/*.md Worker routes (4 specific paths — wildcard rejected by Cloudflare error 10022)
  - Session J: /v5/errors/{code} — machine-readable error docs for 12 known codes
  - Session J: EU DST cron triggers (0 9 28 3 *, 0 9 25 10 *) + scheduled() handler branches
  - Session J: LLMS_TXT audit — x402 section, /v5/errors/{code}, /v5/credits/* all documented
  - Session K: github.com/LembaGang/sma-protocol — standalone repo (Apache 2.0, master branch)
  - Session K: github.com/LembaGang/agent-pretrade-safety-standard — standalone repo (Apache 2.0, master branch)
  - Session K: agent.json standards + /v5/compliance + LLMS_TXT all updated to GitHub canonical URLs
  - Session K: CLAUDE.md updated with all Session I–K autonomous decisions + MCP directory submission content
  - 238/238 tests passing. Worker deployed (46a4c5eb). Both repos pushed.
**Previous significant work**: Mar 17 2026 — Session H: x402 micropayments + docs field fix (238 tests):
  - Session H: ORACLE_PAYMENT_ADDRESS env var added to Env interface
  - Session H: Free tier (ho_free_*) gated at 500 req/day in ORACLE_TELEMETRY KV (free_usage:{hash}:{date})
  - Session H: x402 payment verification via Base mainnet public RPC (eth_getTransactionReceipt + eth_getBlockByNumber)
  - Session H: Replay protection via x402_used:{txHash} KV key (600s TTL)
  - Session H: 402 response includes machine-readable x402 object + 5 X-Payment-* headers
  - Session H: Credit priority: Paddle → free under limit → credits → x402 → 429
  - Session H: POST /v5/credits/purchase — verify x402 payment, grant 1/100/1000 credits based on amount
  - Session H: GET /v5/credits/balance — returns balance, estimated_requests_remaining, last_purchased
  - Session H: agent.json updated with x402_micropayments capability + payment object
  - Session H: /v5/health includes payment_schemes: ["x402"]
  - Session H: docs field in 4xx responses changed from docs#${code} to plain /docs
  - Session H: docs/x402-payments.md created (Node.js + Python auto-pay agent examples)
  - Session H: CLAUDE.md updated with founder verification log + Decisions 7-10
  - 238/238 tests passing.
**Previous significant work**: Mar 17 2026 — MCP compliance, production headers, /v5/compliance endpoint + Session G docs (worker commit a7a2bd3):
  - Sessions B+E: GET /mcp → server info, PUT/PATCH/DELETE → 405, invalid JSON → -32700, unknown method → -32601
  - Session B: tools/call content blocks always include type:'text', initialize returns instructions
  - Session E: X-Oracle-Version: v5 on all responses, Cache-Control: no-store on signed receipts
  - Session E: 4xx errors include docs field (agent-readable recovery URL auto-appended by json() helper)
  - Session E: GET /v5/compliance — 6 APTS checks, sma_spec_version, verify_sdk, standard_url
  - Session E: /v5/health enriched with version, sma_spec_version, mcp_protocol_version, uptime_since, fail_closed
  - Session G: agent.json updated with compliance_check + sma_attestation capabilities + standards object
  - Session G: LLMS_TXT updated with /v5/compliance docs + SMA Protocol section + APTS section + updated Agent Discovery
  - Session G: SKILL_MD updated with /v5/compliance + Compliance Standards section
  - Session G: docs/multi-exchange-monitor.ts — production-ready 7-exchange polling template (Ed25519-verified, fail-closed)
  - Session G: docs/sma-protocol-repo/ — SMA v1.0 open standard publication (6 files, background agent)
  - Session G: docs/integrations/ — 7 framework guides: LangGraph, AutoGen, CrewAI, Vercel AI SDK, OpenAI Agents, Bun, Anthropic Claude (background agent)
  - Session G: docs/agent-safety-standard/ — APTS docs completed (README, CHECKLIST.yaml, BADGE.md, CI-INTEGRATION.md)
  - OpenAPI spec updated for /v5/compliance
  - 219/219 tests passing. Deployed (Version c90b7aaf). Pushed.
**Previous significant work**: Mar 16 2026 — Surface ORACLE_TELEMETRY write outcomes and guard ctx.waitUntil (worker commit bdeb158):
  - Problem: direct MCP requests via headlessoracle.com/mcp logged MCP_REQUEST but never wrote to ORACLE_TELEMETRY KV; proxy path worked
  - Root cause 1: ctx.waitUntil called unconditionally — if unavailable on custom-domain execution context, throws, caught as TELEMETRY_GET_FAILED, masking the real issue
  - Root cause 2: only PUT failures were logged (TELEMETRY_PUT_FAILED); no success log, making it impossible to distinguish "put never called" from "put silently failed"
  - Fix 1: split put into named const with both .then() → TELEMETRY_PUT_OK and .catch() → TELEMETRY_PUT_FAILED
  - Fix 2: guard ctx.waitUntil with typeof check; fall back to direct await if unavailable (guarantees write completes)
  - Fix 3: carry forward X-Original-{IP,ASN-Org,Country,City} header fallbacks so real client fingerprint is captured on direct custom-domain requests
  - Workers Logs will now show TELEMETRY_PUT_OK (success), TELEMETRY_PUT_FAILED (KV error), or TELEMETRY_CTX_NO_WAITUNTIL (execution context issue)
  - 198/198 tests passing. Deployed (bc1534d1). Pushed.
**Previous significant work**: Mar 16 2026 — Fix silent ORACLE_TELEMETRY KV write failures (worker commit 963dfd6):
  - Root cause: ctx.waitUntil() silently drops rejected promises — any KV put failure was invisible
  - Secondary: unprotected await env.ORACLE_TELEMETRY.get() would crash all MCP requests if KV unavailable
  - Fix: wrap telemetry GET/PUT block in try/catch; add .catch(err => console.error(...)) to waitUntil put
  - Fix: add console.error to /v5/metrics catch block so read failures are visible in Workers Logs
  - Telemetry is now best-effort (non-fatal): KV failure no longer propagates to MCP response
  - 198/198 tests passing. Deployed (3f2d3e80). Pushed.
**Previous significant work**: Mar 15 2026 — Observability, metrics, rate limiting, Paddle dedup (worker commit cb13d7f, web commit c3eef5a):
  - wrangler.toml: [observability] enabled=true head_sampling_rate=1 — matches dashboard settings
  - GET /v5/metrics: public endpoint; total_mcp_requests_today + unique_mcp_clients_today from ORACLE_TELEMETRY; fail-safe zeros on KV error
  - POST /v5/keys/request: IP-based rate limit (max 3/day, ORACLE_TELEMETRY key: ratelimit:keys:{ip_hash}:{date}, 25h TTL, 429 RATE_LIMITED)
  - OpenAPI: added /v5/metrics and /v5/keys/request paths with full schemas
  - Fixed stale comment: ORACLE_OVERRIDES → ORACLE_TELEMETRY in MCP handler + McpClientRecord comment
  - headless-oracle-web: extracted Paddle init to public/js/paddle-init.js; removed 8 identical inline script blocks
  - Tests: 168→198 (+3 new: metrics shape, metrics with KV data, rate limit 429)
  - Both repos deployed and pushed.
**Previous significant work**: Mar 14 2026 — Multi-tier Paddle billing upgrade (commit 5e8e28a, deployed cf28ea3c):
  - Key format changed from `ok_live_` → `ho_live_` (8-char prefix + 32 hex chars)
  - Multi-tier pricing: PADDLE_PRICE_ID_BUILDER/PRO/PROTOCOL env vars, plan derived from items[0].price_id
  - KV storage now persistent (no TTL); value expanded to { plan, status, paddle_customer_id, paddle_subscription_id, email, created_at }
  - subscription.canceled: fetches key_hash from Supabase, deactivates KV immediately (status: inactive)
  - 4 new tests → 168 total. All passing. Deployed + pushed.
  - .dev.vars: added PADDLE_PRICE_ID_BUILDER/PRO/PROTOCOL test values
**Previous significant work**: Mar 12 2026 — Developer Gravity Loop sprint (strategic pivot from advisory committee):
  - **safe-trading-agent-template**: NEW repo at `C:\Users\User\safe-trading-agent-template`. LangGraph agent with 4-step Headless Oracle execution gate. 26/26 tests passing. Committed (5ed0a4e). HUMAN TASK: create GitHub repo + push.
  - **docs/simulator-architecture.md**: Full architecture for Trading Halt Capital Loss Simulator (Streamlit, DST + circuit breaker scenarios, slippage/MEV/rejected-fill loss model). Ready to build.
  - **docs/algotrading-community-posts.md**: Polished posts for r/algotrading, QuantConnect forum, Twitter/X thread. Integrates Cloudflare crawler limitation (March 10) and Anthropic/Time Magazine narrative (March 11).
  - **Strategic pivot confirmed**: Kill Discord scatter-gun. Deprioritize ERC-8183. Identity locked: "execution safety primitive for autonomous financial agents." Focus: TradFi hybrid agents.
**Previous significant work**: Mar 3 2026 — 10-task distribution sprint:
  - **Task 1 (issuer field)**: `issuer: "headlessoracle.com"` added to all 4 signed receipt builders (normal, override, UNKNOWN, health). canonical_payload_spec updated. OpenAPI updated. SKILL_MD updated. 1 new test → 164 total. Deployed (Version 8f4ac458).
  - **Task 2 (Python SDK)**: `headless-oracle-python` repo created at `C:\Users\User\headless-oracle-python`. `pip install headless-oracle` (v0.1.0). verify() + OracleClient + LangChain/CrewAI tools. 11 pytest tests. NOT yet on PyPI.
  - **Task 3 (JS client)**: `@headlessoracle/client` at `C:\Users\User\headless-oracle-client`. Typed TS client for all 7 endpoints. Optional verify:true (peer dep). Dual ESM+CJS. NOT yet on npm.
  - **Task 4 (LangChain+CrewAI)**: MarketStatusTool + MarketScheduleTool (LangChain). MarketStatusTool + BatchMarketStatusTool (CrewAI). In `headless-oracle-python/integrations/`.
  - **Task 5 (Custom GPT spec)**: `docs/custom-gpt-action.yaml` — OpenAPI 3.1 for Custom GPT Actions (getMarketStatusDemo, getMarketSchedule, listExchanges). Public endpoints only.
  - **Task 6 (trading bot)**: `trading-bot-starter` at `C:\Users\User\trading-bot-starter`. TS, @headlessoracle/client + @headlessoracle/verify. Correct 4-step gate: fetch → verify sig → TTL → OPEN check.
  - **Task 7 (receipt spec)**: `docs/receipt-spec.md` — implementation-agnostic open spec. Field reference, signing algo, canonical payload pseudocode, impl checklist, changelog.
  - **Task 8 (Cursor plugin)**: `docs/cursor-setup.md` — mcp.json config, macOS+Windows paths, 5 example prompts, troubleshooting.
  - **Task 9 (FAQ update)**: `docs/faq.md` +7 Q&As: issuer field, Python/JS SDKs, LangChain/CrewAI, Custom GPT, Cursor, trading bot.
  - **Task 10 (was in-progress)**: see Task 1 above — issuer IS the "open receipt spec" seed.
  - **3 commits to worker repo, 2 new repos created, 1 new repo created.**
**Previous significant work**: Mar 2 2026 — gap-fill sprint completing Mar 1 spec:
  - **SKILL.md**: Added `## Sharing Receipts Between Agents` section with 6-step verification protocol and @headlessoracle/verify convenience reference.
  - **agent.json**: Added `portable_receipts` to capabilities array (alongside signed_receipts, mcp_tools, etc.).
  - **/v5/health**: Added `data_coverage` (holidays: ['2026','2027'], half_days: ['2026','2027'] — intersection of all 7 exchanges) and `edge_case_count_current_year: 1319` (from edgeCaseCount()). Agents can now confirm data coverage before relying on oracle.
  - **docs.html MCP section**: Added macOS/Windows config file paths, "~30 seconds" label, 5 example prompts to try after setup.
  - **docs/mcp-listing.md**: Full YAML block for MCP directory submissions (Smithery, mcp.so). Includes all 7 exchanges, safety guarantees, all discovery links, reviewer notes.
  - **docs/metrics.md**: Weekly/monthly tracking checklist with alert thresholds and post-launch benchmark table.
  - **docs/faq-prepared-answers.md**: 8 prepared answers for HN and protocol conversations (circuit breakers, timezone libs, signing rationale, weekend objection, clones, on-chain, uptime, Ed25519 choice).
  - **3 new tests** (163 total): health data_coverage structure, sorted holidays check, edge_case_count_current_year > 0.
  - **2 commits (worker) + 1 commit (web), both deployed and pushed.**
**Previous significant work**: Mar 1 2026 — 8-task pre-launch sprint:
  - **Task 1 (receipt_mode)**: Added `receipt_mode: 'demo' | 'live'` as a signed field to all market receipts. `/v5/demo` → `'demo'`, `/v5/status`+batch+MCP → `'live'`. canonical_payload_spec updated. Schema tamper-proof: an adversary can't strip or flip receipt_mode.
  - **Task 2 (year boundary)**: `/v5/schedule` now returns `data_coverage_years: string[]` so agents know when holiday data runs out. Note text explains `next_open: null` semantics. Dec 31 2027 boundary test confirmed.
  - **Task 3 (portability docs)**: Added `## Receipt Portability` section to llms.txt: multi-agent pattern, 6 verification steps, why it matters at scale, SDK convenience link.
  - **Task 4 (MCP guide)**: Expanded SKILL.md MCP section with per-client setup steps (Claude Desktop macOS+Windows, Cursor, custom agents with raw JSON-RPC), tool reference table.
  - **Task 5 (MCP metadata)**: Created `smithery.yaml` for Smithery registry submission. Covers server URL, protocol, all 3 tools, 7 exchanges, safety guarantees, auth, verification.
  - **Task 6 (npm tracking)**: Added Cloudflare Cron trigger (daily 09:00 UTC) + `scheduled()` handler. Fetches npm last-7/30 day downloads for @headlessoracle/verify, logs structured JSON to Workers Logs.
  - **Task 7 (FAQ)**: Created `docs/faq.md` with 14 prepared Q&A answers for HN launch.
  - **Task 8 (health enhanced)**: `/v5/health` now includes unsigned `exchange_count: 7` and `supported_mics: string[]` alongside the signed receipt.
  - **8 commits, 160/160 tests passing.**
**Previous significant work**: Feb 28 2026 (evening) — content + computed edge-case utility:
  - **llms.txt**: Added `## Edge Cases This API Handles` section (7 bullet points covering DST, holidays, early closes, lunch breaks, circuit breakers, weekends, UNKNOWN handling; closes with ~1,300/year figure)
  - **SKILL.md**: Added `## When to Use Headless Oracle vs a Timezone Library` comparison table (8-row two-column with rule-of-thumb)
  - **edgeCaseCount(year)**: Exported utility function that computes schedule edge cases directly from MARKET_CONFIGS — holidays, halfDays, DST transitions (detected via Intl UTC-offset Jan vs Jul), lunchBreakSessions (weekdays minus weekday holidays per lunch-break exchange), weekendDays. Replaces hardcoded ~1,311 comment.
  - **6 new tests**: Assert 2026 values component-by-component; total = 1,319 (81 + 9 + 8 + 493 + 728). Drift is now test-caught.
  - **npm publish status confirmed**: @headlessoracle/verify@1.0.0 live on npm, published by mbeenz. Auth token in ~/.npmrc.
  - **Deployed**: Worker (commit d917197) live and verified. 154/154 tests passing.
**Previous significant work**: Feb 28 2026 — legal fixes, SEO, www redirect, llms.txt single source of truth:
  - **Legal**: 4 playbook fixes in terms.html + api-disclaimer-draft.md (12-month cap, no retroactive voiding, third-party data disclaimer, signature scope clarification)
  - **llms.txt**: Deleted orphaned copies from web repo; LLMS_TXT constant in src/index.ts is sole source of truth — no manual sync ever needed again
  - **www redirect**: Worker handles www.headlessoracle.com/* with 301 → bare domain; prevents Pages cache divergence permanently
  - **SEO**: All 6 HTML pages have meta description, og:*, robots meta; index+docs have link rel alternate for openapi.json and llms.txt
  - **MCP auth prompts**: Suppressed via permissions.deny in ~/.claude/settings.json (8 legal plugin OAuth connectors blocked — skill still works)
  - **.gitignore**: MCP token files (.mcpregistry_*) and .claude/settings.local.json excluded
  - **legal-playbook.md**: Committed to worker repo
  - **Deployed**: Worker (commit 1414dc1) + Pages (commit a1b0d86) both live and verified
  - 148/148 tests passing
**Previous significant work**: Feb 26 2026 — error code standardisation + SEO audit + content creation:
  - **Error codes**: All 405 errors now `METHOD_NOT_ALLOWED` (SCREAMING_SNAKE_CASE); all auth errors include `message` field
  - **OpenAPI**: Server URL corrected (`headlessoracle.com`); new paths added (`/robots.txt`, `/llms.txt`, `/SKILL.md`, `/.well-known/agent.json`); error response schemas completed for all routes
  - **wrangler.toml**: Rate limiting comments expanded to all 10 public routes with notes on what NOT to rate-limit
  - **docs/hn-launch-post.md**: Three Show HN variants for March 10 launch
  - **docs/dst-risk-article.md**: ~1100-word technical article on DST risks for trading agents
  - **Web SEO**: All 6 HTML pages now have `<meta description>`, `og:title`, `og:description`, `og:type`, `og:url`, `<meta name="robots">`. index.html and docs.html have `link rel="alternate"` for openapi.json and llms.txt. Fixed stale `workers.dev` URL in status.html.
  - **Deployed**: Worker (commit 2b24036) + Pages (commit a294d19) both live
  - 148/148 tests passing
**Previous significant work**: Feb 25 2026 — full website audit + LLMS_TXT expansion + deploy:
  - **LLMS_TXT**: Added `## Code Examples` (Python PyNaCl, JS Web Crypto, fail-closed bot pattern, key fetching), `## Known Schedule Risk Events` (DST table 2026), and full docs for /v5/batch, /v5/keys, /v5/health, /v5/account, POST /v5/checkout — every public route now covered
  - **docs.html**: Added `#mcp` section (MCP setup for Claude Desktop, 3 tools documented), `/v5/batch` docs, `#billing` section (/v5/account, /v5/checkout, error codes 401/402/403), sidebar updated with new anchors
  - **index.html**: Added MCP server mention with link to docs.html#mcp and llms.txt
  - **Website audit**: terms.html ✅ #fail-closed + #no-liability, privacy.html ✅ consistent, verify.html ✅ correct key, ed25519-public-key.txt ✅ correct key (03dc...), no stale terms_hash or wrong fingerprint in live codebase
  - **llms.txt synced**: headless-oracle-v5/public/, headless-oracle-web/llms.txt, headless-oracle-web/public/llms.txt all match LLMS_TXT constant
  - **Deployed**: Worker (headless-oracle-v5) + Pages (headless-oracle-web) both live
  - 141/141 tests passing
  - `GET /robots.txt` — live; permits AI crawlers to all public endpoints
  - `GET /llms.txt` — live; full structured coverage for LLM crawlers
**Previous significant work**: Feb 24 2026 — Paddle billing (Stripe → Paddle swap):
  - `POST /v5/checkout` — creates Paddle transaction (`POST https://api.paddle.com/transactions`), returns `{ url }`, no auth
  - `POST /webhooks/paddle` — verifies `Paddle-Signature` header (format: `ts=<ts>;h1=<hex>`, signed content: `<ts>:<body>`, HMAC-SHA256, 5-min replay protection), handles 4 events:
    - `transaction.completed` → idempotency guard (skip if `stripe_subscription_id` already exists in Supabase) + skip if no `subscription_id` (one-time payment guard) → generate `ok_live_<32 random hex bytes>` key, fetch email via Paddle customer API, hash + store in Supabase `api_keys` table, warm `ORACLE_API_KEYS` KV cache (TTL 300s), send key via Resend (shown once)
    - `subscription.updated` → update `status` in Supabase (active→active, else suspended)
    - `subscription.past_due` → set `status = 'suspended'` in Supabase
    - `subscription.canceled` → set `status = 'cancelled'` in Supabase
  - `GET /v5/account` — requires `X-Oracle-Key`, returns `{ plan, status, key_prefix }`
  - `checkApiKey` (async, 5-step hot path) — unchanged
  - New status code: 402 PAYMENT_REQUIRED for suspended/cancelled (distinguishable from 403 by agents)
  - New KV namespace: `ORACLE_API_KEYS` (id: real ID needed before deploy)
  - Secrets needed: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_ID`, `RESEND_API_KEY`
    (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` already in .dev.vars)
  - All 112 existing tests pass unchanged; 25 new billing tests added (137 total — 2 more than Stripe version for idempotency + non-subscription guards)
  - OpenAPI spec updated: `/webhooks/stripe` → `/webhooks/paddle`, event names updated
  - ADR-019 updated in 10_decisions.md
**Previous significant work**: Feb 24 2026 — gap 10 fully resolved (@headlessoracle/verify SDK published):
  - `@headlessoracle/verify` live at npmjs.com/package/@headlessoracle/verify
  - Zero production dependencies — uses Web Crypto API (crypto.subtle)
  - Single `verify(receipt, options?)` function: fields check → TTL check → Ed25519 verification
  - Handles all receipt types: SCHEDULE, OVERRIDE (with reason), HEALTH (no mic/schema_version)
  - `publicKey` option skips key registry fetch — essential for high-throughput agent use
  - `keysUrl` option supports staging/self-hosted instances
  - `now` option supports time-override in consumer tests
  - 6 machine-readable failure reasons: MISSING_FIELDS, EXPIRED, UNKNOWN_KEY, INVALID_SIGNATURE, KEY_FETCH_FAILED, INVALID_KEY_FORMAT
  - Dual ESM + CJS build via tsup; TypeScript declarations included
  - 24/24 tests passing; tests sign with noble/ed25519, verify with Web Crypto — true round-trip integration test
  - ADR-018 added to 10_decisions.md
  - GitHub: github.com/LembaGang/headless-oracle-verify
**Previous significant work**: Feb 23 2026 — gap 8 resolved (/v5/batch) + /.well-known/oracle-keys.json added:
  - `GET /v5/batch?mics=XNYS,XNAS,XLON` live: authenticated, parallel, independently signed receipts
  - Full 4-tier fail-closed applies per-MIC; Tier 3 failure fails the whole batch
  - Deduplicates MICs, validates all up front, preserves request order
  - `GET /.well-known/oracle-keys.json` live: RFC 8615 standard key-discovery URI
  - Returns active key data (without canonical_payload_spec) for web-standard discoverability
  - OpenAPI spec updated for both new routes
  - 22 new tests added (112 total); all 112 pass
  - ADR-016 (batch) and ADR-017 (well-known) added to 10_decisions.md
**Previous significant work**: Feb 22 2026 — gap 9 resolved (MCP server):
  - `POST /mcp` live: MCP Streamable HTTP, JSON-RPC 2.0, protocol version `2024-11-05`
  - Three tools: `get_market_status`, `get_market_schedule`, `list_exchanges`
  - No new npm dependencies — tools call the same internal functions as REST routes
  - `buildSignedReceipt` extracted as shared function: 4-tier fail-closed applies equally to MCP and REST
  - MCP handler outside main try/catch — returns JSON-RPC error format, never REST CRITICAL_FAILURE
  - CORS updated to allow POST; OpenAPI spec updated with `/mcp` path
  - 10 new MCP tests added (90 total); all 90 pass
  - ADR-015 added to 10_decisions.md
  - Oracle is now discoverable from Claude Desktop, Cursor, and MCP-compatible agents
**Previous significant work**: Feb 22 2026 — gaps 4 + 11 resolved (terms_hash rename, /v5/health):
  - `terms_hash` renamed to `schema_version`, value updated `'v5.0-beta'` → `'v5.0'`
  - Breaking change to signed payload schema — done pre-launch while zero consumers exist
  - `/v5/health` endpoint live: signed liveness probe, public, no auth
  - Health receipt: `{ receipt_id, issued_at, expires_at, status: 'OK', source: 'SYSTEM', public_key_id, signature }`
  - No `mic` field — health is system-level, not exchange-specific
  - On signing failure: 500 CRITICAL_FAILURE (same pattern as Tier 3)
  - `health_fields` added to canonical_payload_spec in `/v5/keys`
  - ADR-013 (health endpoint) and ADR-014 (schema_version) added to 10_decisions.md
  - 4 new health tests added (80 total)
**Previous significant work**: Feb 22 2026 — HIGH gaps 5 + 6 resolved:
  - `valid_until` added to `/v5/keys` response (null by default; set via `PUBLIC_KEY_VALID_UNTIL` env var)
  - Gap 5 now fully resolved: key rotation has `valid_from` + `valid_until`
  - `lunch_break: { start, end } | null` added to `/v5/schedule` response for all MICs
  - XJPX returns `{ start: '11:30', end: '12:30' }` (local JST), XHKG `{ start: '12:00', end: '13:00' }` (local HKT)
  - All other MICs return `lunch_break: null` — explicit signal, not absent field
  - lunch_break times are local exchange time (see `timezone` field); `note` field updated accordingly
  - OpenAPI spec updated for both changes
  - 4 new lunch_break tests + 1 valid_until assertion added (76 total)
**Previous significant work**: Feb 22 2026 — HIGH gap 7 resolved (holiday time bomb)
**Next session trigger**: User completes human tasks → HN launch March 10.
**npm publish**: @headlessoracle/verify@1.0.0 confirmed live on npmjs.com. Auth token already in ~/.npmrc. Human task marked DONE.

## Immediate Next Engineering Tasks (when user returns)
1. **HUMAN TASK: showcase-submit page** — Build a simple form at headlessoracle.com/showcase-submit that emails mike@headlessoracle.com. Basic fields: name, project URL, brief description. Can be a static HTML form in headless-oracle-web or a Cloudflare Pages Function. No worker changes needed.

2. **Before deploy: Supabase schema** — create the `api_keys` table (human task):
   ```sql
   create table api_keys (
     id                       uuid primary key,
     key_hash                 text unique not null,
     key_prefix               text not null,
     plan                     text not null default 'pro',
     status                   text not null default 'active',
     stripe_customer_id       text,
     stripe_subscription_id   text,
     email                    text,
     created_at               timestamptz not null,
     last_used_at             timestamptz
   );
   create index on api_keys (key_hash);
   create index on api_keys (stripe_subscription_id);
   ```
2. **Before deploy: Cloudflare KV** — create `ORACLE_API_KEYS` namespace in Cloudflare Dashboard, replace placeholder ID `00000000000000000000000000000001` in `wrangler.toml` with the real namespace ID, then redeploy.
3. **Before deploy: set secrets** via `wrangler secret put`:
   - `PADDLE_API_KEY` (live API key from Paddle Dashboard → Developer → Authentication)
   - `PADDLE_WEBHOOK_SECRET` (from Paddle Dashboard → Notifications → endpoint secret)
   - `PADDLE_PRICE_ID` (from Paddle Dashboard → Catalog → Prices, format: `pri_*`)
   - `SUPABASE_URL` (already in .dev.vars — add production value)
   - `SUPABASE_SERVICE_ROLE_KEY` (already in .dev.vars — add production value)
   - `RESEND_API_KEY` (from Resend Dashboard)
4. **Before deploy: register Paddle webhook** — point `POST https://api.headlessoracle.com/webhooks/paddle` at the worker, select events: `transaction.completed`, `subscription.updated`, `subscription.past_due`, `subscription.canceled`
5. **Paddle billing** — DONE ✓

2. **Add rate limiting in Cloudflare Dashboard** — must be done before HN launch (March 10)
   - Dashboard: Workers & Pages → headless-oracle-v5 → Settings → Rate Limiting
   - Rules to add:
     - `/v5/demo*`     → 100 req/min per IP → Block (429)
     - `/v5/schedule*` → 60 req/min per IP  → Block (429)
     - `/v5/exchanges` → 60 req/min per IP  → Block (429)
     - `/v5/keys`      → 60 req/min per IP  → Block (429)
   - `/v5/status` is already protected by API key auth — no rate limit rule needed
   - **This is a human task** — must be done in the Cloudflare Dashboard

2. **Beta API key provisioning** — when first prospect wants to test /v5/status
   - Add their key to `BETA_API_KEYS` secret via:
     `wrangler secret put BETA_API_KEYS` (enter comma-separated list including new key)
   - Format: `existing_key,new_key_for_ondo`
   - Then redeploy: `wrangler deploy`

3. **Monitoring / alerting** — optional but recommended before scale
   - Cloudflare Dashboard → Workers & Pages → headless-oracle-v5 → Metrics
   - Set up email alerts for Worker errors (4xx/5xx spikes)

## Sprint Goals (Pre-March 8)
- [x] 7 exchanges live and tested
- [x] /v5/schedule and /v5/exchanges endpoints live
- [x] KV circuit breaker override system live
- [x] status.html live dashboard
- [x] 66-test suite passing
- [x] CLAUDE.md files updated in both repos
- [x] Risk committee status update written
- [x] Financial model written
- [x] DST exploit demo repo published on GitHub (github.com/LembaGang/dst-exploit-demo)
- [x] All internal frontend links fixed (extensionless paths)
- [x] Operator runbook written (headless-oracle-v5/OPERATOR_RUNBOOK.md)
- [x] Business handover document written (C:/Users/User/Headless Oracle/Business/HANDOVER.md)
- [x] DST risk article written (headless-oracle-v5/docs/dst-risk-article.md)
- [x] HN launch post drafted (3 variants in headless-oracle-v5/docs/hn-launch-post.md)
- [x] All HTML pages have OG tags and robots meta
- [x] @headlessoracle/verify published to npm (v1.0.0 — confirmed live)
- [x] llms.txt ## Edge Cases This API Handles section added
- [x] SKILL.md timezone library comparison table added
- [x] edgeCaseCount() utility built — 6 tests, total 1,319 for 2026, drift is now test-caught
- [ ] Phantom Hour article published (human task — Gemini draft ready)
- [ ] Twitter/X thread posted (human task)
- [ ] 15 targeted DMs sent (human task — begins Feb 28)
- [ ] Rate limiting configured in Cloudflare Dashboard (human task — before March 10)

## Codebase Health
- **Worker**: headless-oracle-v5 | main branch | deployed to Cloudflare Workers (commit d917197)
- **Frontend**: headless-oracle-web | main branch | deployed to Cloudflare Pages via `npm run deploy`
- **DST Demo**: dst-exploit-demo | master branch | published on GitHub
- **SDK**: @headlessoracle/verify@1.0.0 | npmjs.com/package/@headlessoracle/verify | 24/24 tests passing
- **Tests**: 154/154 passing. `.dev.vars` populated with test-only keypair.
- **Public key**: `03dc27993a2c90856cdeb45e228ac065f18f69f0933c917b2336c1e75712f178` (production)
- **All live pages**: headlessoracle.com, /docs, /status, /verify, /terms, /privacy, /llms.txt, /openapi.json

## Known Issues / Blockers
- **No rate limiting on public routes yet**: Acceptable at zero-traffic stage. Must add before HN launch.
  See: OPERATOR_RUNBOOK.md → Section 5. Dashboard instructions are ready.

## DST Calendar — Critical Dates
- **March 8, 2026**: US clocks spring forward (EST→EDT). XNYS + XNAS affected. Phantom hour 2–3am ET.
- **March 10, 2026**: Hacker News "Show HN" launch. Tuesday 10am ET.
- **March 29, 2026**: UK/EU clocks spring forward (GMT→BST / CET→CEST). XLON + XPAR affected.
- **October 25, 2026**: UK/EU fall back. XLON + XPAR.
- **November 1, 2026**: US fall back. XNYS + XNAS.

## Architectural Gaps (identified Feb 21 2026 — post-code-review)
<!-- These are the gaps the current architecture does not solve that will matter at agent scale.
     Work through these in priority order after HN launch. -->

### CRITICAL — blocks agent adoption
1. ~~**No `expires_at` in signed receipts**~~ **RESOLVED Feb 22 2026**
   All signed receipts now include `expires_at: issued_at + 60s`. Signed in the canonical
   payload. Consumers must not act on receipts past their `expires_at`.

2. ~~**No OpenAPI / machine-readable schema**~~ **RESOLVED Feb 22 2026**
   `/openapi.json` is live. OpenAPI 3.1 spec covers all routes, schemas, auth, and error
   shapes. Agent-discoverable without reading documentation.

3. ~~**Canonical signing payload is implicit, not documented**~~ **RESOLVED Feb 22 2026**
   `signPayload` sorts keys alphabetically (deterministic regardless of insertion order).
   Field lists documented at `/v5/keys → canonical_payload_spec`. Consumer SDKs can now
   implement independent verification against a published spec.

### HIGH — needed before scale
4. ~~**`terms_hash` is a label, not a hash**~~ **RESOLVED Feb 22 2026**
   Field renamed to `schema_version`, value updated to `'v5.0'`. Accurately describes what
   the field is: a schema version identifier. Done pre-launch while zero consumers exist.
   If a true cryptographic commitment to a terms document is needed later, that is a new
   field (`terms_hash`) to add alongside `schema_version`, not a rename.

5. ~~**Key rotation has no lifecycle**~~ **RESOLVED Feb 22 2026**
   `/v5/keys` now returns `valid_from` (populated via `PUBLIC_KEY_VALID_FROM` env var, default
   `2026-01-01T00:00:00Z`) and `valid_until` (populated via `PUBLIC_KEY_VALID_UNTIL` env var,
   default `null`). Set `PUBLIC_KEY_VALID_UNTIL` before a scheduled key rotation to signal
   consumers before the key expires.

6. ~~**Lunch breaks missing from `/v5/schedule`**~~ **RESOLVED Feb 22 2026**
   `/v5/schedule` now returns `lunch_break: { start, end } | null` for all MICs.
   XJPX: `{ start: '11:30', end: '12:30' }` (local JST).
   XHKG: `{ start: '12:00', end: '13:00' }` (local HKT).
   All other MICs: `null` — explicit field, not absent. Times are local exchange time;
   timezone is already in the response. OpenAPI spec updated.

7. ~~**Holiday lists are 2026-only — time bomb**~~ **RESOLVED Feb 22 2026**
   `holidays` is now year-keyed (`Record<string, string[]>`). 2027 data added for all 7
   exchanges. Fail-closed guard returns UNKNOWN/SYSTEM if the current year has no data —
   converts a silent wrong answer into a detectable safe state.
   **ANNUAL MAINTENANCE**: Before Dec 31 each year, add the following year's holidays to
   all 7 configs in `src/index.ts` and run `npm test`. Lunar/Islamic/Hindu calendar dates
   (XHKG, XSES) need manual verification from official exchange calendars.

### MEDIUM — when consumer base grows
8. ~~**No batch query**~~ **RESOLVED Feb 23 2026**
   `GET /v5/batch?mics=XNYS,XNAS,XLON` is live. Authenticated, parallel, independently
   signed. Full 4-tier fail-closed applies per-MIC. Deduplicates, validates all MICs up
   front, preserves request order. 15 new tests added.

9. ~~**No MCP server**~~ **RESOLVED Feb 22 2026**
   `POST /mcp` is live. MCP Streamable HTTP, protocol `2024-11-05`. Three tools:
   `get_market_status` (signed receipt, same 4-tier safety), `get_market_schedule`,
   `list_exchanges`. Oracle is now discoverable from Claude Desktop, Cursor, and any
   MCP-compatible agent. No new npm dependencies. 10 tests added (90 total).
   **Next binding constraint**: polling pressure at scale — see gap 13 (push/webhook).

10. ~~**No consumer verification SDK**~~ **RESOLVED Feb 24 2026**
    `@headlessoracle/verify` package built at `C:\Users\User\headless-oracle-verify\`.
    3-line verification, zero prod deps, dual ESM+CJS build, 24 tests.
    **HUMAN TASK**: Publish to npm — `npm publish --access public` after creating npm org `@headlessoracle`.
    Full 3-line example in README: fetch receipt → `verify(receipt, { publicKey })` → check `receipt.status`.

11. ~~**No health endpoint**~~ **RESOLVED Feb 22 2026**
    `GET /v5/health` is live. Returns a signed receipt (`status: 'OK', source: 'SYSTEM'`).
    On signing failure returns 500 CRITICAL_FAILURE. Agents can now distinguish Oracle-down
    from market-UNKNOWN: a valid signed health receipt confirms the signing infrastructure works.

### LONG-TERM — when federation matters
12. **Single-operator trust model**
    "Trust Oracle" currently means "trust LembaGang." At root-server scale, this must
    become multi-party. Fix: threshold Ed25519 (e.g. 2-of-3 operators). Ed25519 was
    chosen to make this composable when needed.

13. **No push/webhook model**
    Agents polling at scale is wasteful and creates rate-limit pressure. The correct
    primitive is: subscribe to XNYS status changes, receive a signed push when state
    changes. Fix: Cloudflare Durable Objects or Queues for stateful subscriptions.

## Context for Next Session
Start by reading:
1. This file (done)
2. `.claude/rules/05_strategic_vision.md` for north star and decision filters
3. `.claude/rules/00_engineering_standards.md` for hard rules
4. `.claude/rules/10_decisions.md` for architectural context
5. `OPERATOR_RUNBOOK.md` for operational procedures
6. `src/index.ts` if touching core logic
