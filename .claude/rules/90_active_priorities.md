# Active Priorities — Headless Oracle V5
<!-- Claude: update this file after significant work to preserve state across sessions -->

## Current Status
**Phase**: Post-launch (HN March 10). Developer gravity loop active. Conversion infrastructure live.
**Test suite**: 604/604 tests (worker — 65 pre-existing Miniflare EBUSY + isolated-storage failures on Windows, not introduced this session) + 24/24 tests passing (SDK) + 26/26 tests passing (LangGraph template)
**Live endpoints**: All including /v5/usage (auth), /v5/traction (public), /v5/x402/mint (public), /v5/webhooks/subscribe, /v5/webhooks (GET list), /v5/webhooks/:id (DELETE), /v5/webhooks/unsubscribe (legacy DELETE), /v5/webhooks/test/:id (POST test delivery), /v5/webhooks/health (public), /v5/receipts (builder+), /v5/sandbox (public), /v5/implementations (public), /v5/showcase (public), api.headlessoracle.com/*, /.well-known/x402.json, /oauth/token, /oauth/introspect, /.well-known/oauth-authorization-server, /.well-known/agent.json (A2A), /.well-known/mcp/server-card.json, /.well-known/ai-plugin.json, /ai-plugin.json, /status, /badge/:mic, /v5/card/:mic (live SVG status card), /v5/changelog, /v5/archive, /v5/conformance-vectors, /v5/stream (SSE via Durable Object), /v5/dst-risk (public), /docs/sma-protocol/rfc-001 (public), /docs/mpas (public)
**PyPI packages**: headless-oracle-langchain@1.0.1 (pypi.org/project/headless-oracle-langchain/), headless-oracle-crewai@1.0.1 (pypi.org/project/headless-oracle-crewai/)
**npm packages**: headless-oracle-setup@1.0.1 (npx headless-oracle-setup — zero-dep MCP setup for Claude Desktop/Cursor/Windsurf)
**www redirect**: www.headlessoracle.com/* → 301 → headlessoracle.com/* (Worker-level, permanent)
**api subdomain**: api.headlessoracle.com/* → same worker, all routes work identically. NOTE: requires DNS A/CNAME for api.headlessoracle.com pointing to Cloudflare.
**@headlessoracle/verify**: Published — npmjs.com/package/@headlessoracle/verify v1.0.0 (published, auth token in ~/.npmrc)
**Go SDK**: github.com/LembaGang/headless-oracle-go — zero stdlib deps, oracle.Verify(), 9 tests
**Exchanges**: 28 total (23 traditional + XCBT/XNYM overnight CME, XCBO Cboe options, XCOI Coinbase 24/7, XBIN Binance 24/7). mic_type: "iso" | "convention" on all entries.
**Last significant work**: Apr 1 2026 — Accra Sprint (604 tests, +3 testnet x402):
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
