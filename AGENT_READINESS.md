# Agent Readiness Stack — Audit Log

**Date:** 2026-05-20
**Author:** Michael Msebenzi (with Claude Opus 4.7 assist)
**Scope:** Static agent-discovery surface for `headlessoracle.com`. No worker logic changes beyond route additions; no `canonical_payload_spec`, signing, or x402 settlement touched; no PyPI/npm publishes.
**Gate at implementation:** `npx tsc --noEmit` → 0 · `npm test` → 1056 passed (1056) · `npx wrangler deploy --dry-run` → 0.

---

## 1. Scanner and method

The reference scanner is **isitagentready.com** (Cloudflare). It evaluates five categories:

1. **Discoverability** — robots.txt, Sitemap, Link headers
2. **Content Accessibility** — Markdown content negotiation
3. **Bot Access Control** — AI bot rules, Content Signals, Web Bot Auth
4. **Protocol Discovery** — MCP, Agent Skills, WebMCP, OAuth, API discovery
5. **Commerce** — x402, MPP, UCP, ACP

**Verification boundary (honest):** the scanner is a UI-driven tool. I could not locate a public per-domain JSON API or a `?domain=`/`/scan/<domain>` URL pattern that returns a structured score, so I could **not** capture a numeric before/after score programmatically in-session. The pre/post numeric scores below are therefore left as operator-captured placeholders (run the scanner against `headlessoracle.com` in the browser after deploy). What I *can* and *do* verify is the concrete HTTP behaviour of each surface (status code + content-type), via `curl` against production, which is the underlying evidence the scanner's checks key off.

### Scanner score (operator to fill via UI)

| | Discoverability | Content Access | Bot Control | Protocol Discovery | Commerce | Overall |
|---|---|---|---|---|---|---|
| **Before** | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| **After**  | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

---

## 2. Pre-change state (curl against production, 2026-05-20, before deploy)

| Path | Status | Note |
|---|---|---|
| `/.well-known/mcp` | **404** | extensionless probe (AgenstryBot) missed the handler |
| `/.well-known/mcp.json` | 200 | server card |
| `/.well-known/agent.json` | 200 | A2A AgentCard |
| `/.well-known/agent-card.json` | 200 | already aliased to agent.json |
| `/.well-known/agent-skills/index.json` | **404** | Agent Skills discovery absent |
| `/.well-known/api-catalog` | **404** | RFC 9727 catalog absent |
| `/.well-known/x402.json` | 200 | x402 discovery (unchanged) |
| `/.well-known/jwks.json` | 200 | RFC 7517 JWKS (unchanged) |
| `/.well-known/oracle-keys.json` | 200 | RFC 8615 key discovery (unchanged) |
| `/agent-directory.json` | **200 `text/html`** | **soft-404 trap** — Pages SPA catch-all returned a success code with an HTML body |
| `/.well-known/agent-directory.json` | **404** | worker-routed, no handler |

---

## 3. Changes shipped, mapped to scanner categories

| # | Change | File(s) | Scanner category improved |
|---|---|---|---|
| 1 | `/.well-known/mcp` extensionless alias → server card | `src/index.ts` | Protocol Discovery (MCP) |
| 2 | Agent Skills discovery `/.well-known/agent-skills/index.json` + 5 `SKILL.md` (verify-receipt, read-market-state, subscribe-halts, pay-with-x402, mcp-tool-catalog) | `src/index.ts` | Protocol Discovery (Agent Skills) + Content Accessibility (markdown) |
| 3 | `/.well-known/api-catalog` (RFC 9727 / RFC 9264 linkset) harvested from `AGENT_JSON.rest_api.endpoints` | `src/index.ts` | Protocol Discovery (API discovery) + Discoverability |
| 4 | `/agent-directory.json` worker route + JSON handler (soft-404 fix) | `wrangler.toml`, `src/index.ts` | Discoverability (no more HTML soft-success) |
| 5 | `/.well-known/agent-directory.json` handler (same payload) | `src/index.ts` | Discoverability |
| 6 | robots.txt: `Content-Signal: ai-train=no, ai-input=yes, search=yes` + explicit allows for ClaudeBot, GPTBot, OAI-SearchBot, PerplexityBot, ChatGPT-User, AgenstryBot, Open402DirectoryCrawler, YellowMCP-HealthChecker | `src/index.ts` (`ROBOTS_TXT`) | Bot Access Control + Discoverability |
| 7 | Root `/` Link headers | — | **Deferred — see §7** |
| 8 | This audit log | `AGENT_READINESS.md` | — |

**Tests:** +19 (`test/index.spec.ts`), 1037 → **1056**, `wrangler.toml` `TEST_COUNT` updated.

### Agent Skills digest integrity
The discovery index lists each skill with a `digest: "sha256:<hex>"`. Digests are computed **at request time from the exact served `SKILL.md` bytes** (not hardcoded), so the index can never drift from the content. A test asserts the index digest equals `SHA-256` of the served `verify-receipt/SKILL.md`.

### Agent Skills schema note
`https://schemas.agentskills.io/discovery/0.2.0/schema.json` refused connection at implementation time (`ECONNREFUSED`), so the discovery document was built to the field spec given in the brief — per-skill `name` (lowercase alphanumeric + hyphens, 1–64), `type: "skill-md"`, `description`, `url`, `digest: "sha256:<hex>"` — wrapped with `$schema` + `version: "0.2.0"`. Re-validate against the published schema once the host is reachable.

---

## 4. Per-check predicted delta

- **Protocol Discovery → MCP:** `/.well-known/mcp` now 200 (was 404). Extensionless probers (AgenstryBot) resolve on first hit.
- **Protocol Discovery → Agent Skills:** new — `/.well-known/agent-skills/index.json` (200) + 5 discoverable `SKILL.md` documents. Previously absent (404).
- **Protocol Discovery → API discovery:** new — `/.well-known/api-catalog` (200, `application/linkset+json`) per RFC 9727. Previously absent (404).
- **Discoverability → Link headers / catalog:** api-catalog present at the well-known location (the RFC 9727 default discovery point). Root-page `Link` headers remain a gap — see §7.
- **Discoverability → soft-404:** `/agent-directory.json` now returns 200 `application/json` instead of 200 `text/html`. Agents probing it no longer get a success code with an HTML body.
- **Bot Access Control → Content Signals:** robots.txt now declares `Content-Signal: ai-train=no, ai-input=yes, search=yes`.
- **Bot Access Control → AI bot rules:** explicit allow groups for 8 named agent/AI crawlers.
- **Content Accessibility:** 5 markdown skill documents served as `text/markdown`.
- **Commerce (x402):** unchanged — already passing via `/.well-known/x402.json` and the 402 flow. Not touched.

---

## 5. Post-change live verification

Deployed worker version **`dde5c165-6479-415c-9f49-b7529daaa98d`** (2026-05-20). `curl` against production:

| Path | Status | Content-Type | Verdict |
|---|---|---|---|
| `/.well-known/mcp` | 200 | `application/json` | **fixed** (was 404) |
| `/.well-known/agent-skills/index.json` | 200 | `application/json` | new — `$schema` + `version 0.2.0` + 5 skills |
| `/.well-known/agent-skills/verify-receipt/SKILL.md` | 200 | `text/markdown` | new |
| `/.well-known/agent-skills/pay-with-x402/SKILL.md` | 200 | `text/markdown` | new |
| `/.well-known/api-catalog` | 200 | `application/linkset+json` | new (RFC 9727) |
| `/agent-directory.json` | 200 | `application/json` | **soft-404 FIXED** (was 200 `text/html`) |
| `/.well-known/agent-directory.json` | 200 | `application/json` | new |
| `/robots.txt` | 200 | `text/plain` | `Content-Signal` + 8 explicit bot allows present |

All seven new/changed surfaces verified live. The `/agent-directory.json` soft-404 (200 `text/html`) is resolved.

### Agenstry crawler status (`agenstry.com/agents/headlessoracle.com`)
Agenstry's most recent snapshot is **2026-05-18** ("Card drift detected") — it has **not** re-crawled today's changes, so the new agent-skills / api-catalog / agent-directory surfaces are not yet reflected there. A re-crawl is expected on Agenstry's own cadence; no action required.

**Out-of-scope finding (flagged, NOT fixed):** Agenstry reports a **35/100 (grade F)** trust score attributed to "failing JSON-RPC endpoint validation" and "lacking protocol version declaration" on `/mcp`, despite 100% uptime and a 10/10 agent-card score. This concerns the MCP JSON-RPC endpoint, which the brief explicitly placed off-limits for this change. It is unrelated to the static-discovery surface shipped here and warrants a **separate** investigation: confirm whether `POST /mcp` `initialize` returns a spec-conformant result advertising `protocolVersion`, and why Agenstry's validator marks it failing. (`/.well-known/mcp` and the server card both declare protocol `2024-11-05`; the gap, if real, is in the live JSON-RPC `initialize` response, not discovery.)

---

## 6. The `/agent-directory.json` soft-404 issue and its fix

**Issue.** The worker's apex routes are path-specific (not a catch-all). Any apex path the worker is *not* routed for is served by Cloudflare Pages (`headless-oracle-web`), whose SPA returns its `index.html` with **HTTP 200 `text/html`** for unknown paths. `/agent-directory.json` had no worker route, so it hit the Pages SPA and returned a 200 with an HTML body — a *soft-404*. For an agent this is worse than a clean 404: it's a success code carrying the wrong content type, which can poison directory crawlers and JSON parsers.

**Fix (option (a), per brief).** Added a worker route `headlessoracle.com/agent-directory.json` in `wrangler.toml` so Cloudflare delivers the request to the worker, plus a handler returning a proper `application/json` agent-directory document. The well-known sibling `/.well-known/agent-directory.json` is covered by the existing `/.well-known/*` wildcard and serves the identical payload (both are probed by AgenstryBot). Single shared `AGENT_DIRECTORY_JSON` constant so the two never diverge.

**Note:** this fix only takes effect in production **after deploy** (route table change). In the test suite it is exercised directly via `worker.fetch`, independent of Cloudflare routing.

---

## 7. Root `/` Link headers — DEFERRED (Pages-repo follow-up)

Brief step #7 asks for `Link` response headers on `/` (`api-catalog`, `agent-card`, `mcp-server`, `agent-skills`). **The apex root `/` is served by Cloudflare Pages (`headless-oracle-web`), not the worker** — confirmed: `wrangler.toml` has no apex `/` or `/*` route, and the worker's `fetch(request)` passthrough at `src/index.ts` only triggers if a root request reaches the worker via the `www.`/`api.` catch-alls. The worker cannot set headers on the Pages-served root.

**Action required (separate repo):** add a `_headers` file to `headless-oracle-web` (the only repo that owns the root response) with:

```
/
  Link: </.well-known/api-catalog>; rel="api-catalog"
  Link: </.well-known/agent-card.json>; rel="agent-card"
  Link: </.well-known/mcp/server-card.json>; rel="mcp-server"
  Link: </.well-known/agent-skills/index.json>; rel="agent-skills"
```

Not done in this change because it lives in `headless-oracle-web`, outside the scope of this worker PR. Note RFC 9727 clients can still discover the API catalog at its well-known location without the root `Link` header.

---

## 8. CLAUDE.md catch-all stale claim — FLAGGED, not fixed here

`CLAUDE.md` ("Architecture in 30 Seconds") and `.claude/rules/02_architecture_map.md` both state the worker has a **catch-all route on `headlessoracle.com/*`**. This is **inaccurate**: `wrangler.toml` routes are path-specific (`/v5/*`, `/mcp`, `/.well-known/*`, etc.), and only `www.` and `api.` carry `/*` catch-alls. The practical consequence (which directly motivated this work) is that new top-level apex paths do **not** automatically reach the worker — they fall through to the Pages SPA and soft-404. **Flagged for a follow-up doc correction; deliberately not fixed in this change** per the brief.

---

## 9. Deliberate exclusion — Web Bot Auth

`/.well-known/http-message-signatures-directory` (Web Bot Auth) was **deliberately not added**. Headless Oracle is a server-side responder; Web Bot Auth advertises keys an agent uses to *sign its own outbound requests*. HO does not currently make outbound signed requests, so the directory would be empty/misleading. Revisit only if HO begins making authenticated outbound calls as a client.

---

## 10. Recommended follow-ups (out of this change's scope — flagged, not silently fixed)

- **robots.txt `Sitemap:` directive.** The scanner's Discoverability check looks for a `Sitemap` line in robots.txt. `Sitemap: https://headlessoracle.com/sitemap.xml` was **shipped 2026-05-21, commit `10304ed`** (worker `24dcc8c5`) — robots.txt now references the served `/sitemap.xml`.
- **Per-essay / per-surface OG images** (tracked elsewhere) — unrelated.
- **Re-validate** the Agent Skills index against the published 0.2.0 JSON Schema once `schemas.agentskills.io` is reachable.

---

## 11. Agenstry A2A mismatch (2026-05-21)

The §5 "out-of-scope finding" framing was wrong. Agenstry re-crawled `headlessoracle.com` on **2026-05-21 00:32:22** and held the score at **35/100 (grade F)**. Inspecting Agenstry's published rubric shows it grades the domain as an **A2A (Agent-to-Agent) agent, not an MCP server**: the two failing criteria are *Live JSON-RPC* (5/25, "body isn't a valid JSON-RPC 2.0 A2A response — the probe requires implementing `message/send`") and *Protocol Version* (0/10, "missing required `protocolVersion` declaration" — the A2A *AgentCard* field, Major.Minor format). Both are A2A-protocol concepts. The F grade therefore reflects **A2A non-conformance, not MCP non-conformance**.

The MCP endpoint was verified spec-compliant against MCP **2024-11-05** the same day via `curl` against production: `POST /mcp` `initialize` → 200 with `result.protocolVersion: "2024-11-05"`, `serverInfo`, and `capabilities` all present; `tools/list` → 200 with a valid `ListToolsResult` (4 tools). There is no missing-`protocolVersion` gap in the MCP `initialize` response. Agenstry's `message/send` probe lands on a method HO does not implement: it returns `405` at the AgentCard `url` (apex root) and a valid-envelope JSON-RPC `-32601 "Method not found: message/send"` at `/mcp` — correct behaviour for an MCP server that does not speak A2A.

**Decision: do not implement A2A at this time.** Headless Oracle is an MCP server; the AgentCard at `/.well-known/agent.json` is descriptive metadata, not a commitment to serve the A2A JSON-RPC method surface. Adopting A2A (`message/send` handler, AgentCard `protocolVersion`, JWS/uptime criteria) is a **separate strategic question** — whether HO should present as a first-class A2A agent — and is deliberately deferred, not treated as a bug. The only change shipped from this investigation is a true-MCP-spec alignment unrelated to A2A: the MCP HTTP response header was corrected from the non-standard `MCP-Version` to the spec name `MCP-Protocol-Version` (`src/index.ts`), body field unchanged.
