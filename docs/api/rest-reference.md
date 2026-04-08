# REST API Reference

Last updated: 2026-04-08

Base URL: `https://headlessoracle.com`

All responses include security headers (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy). JSON responses use `Content-Type: application/json; charset=utf-8`.

## Public Endpoints (No Auth)

### GET /v5/demo?mic={MIC}
Signed receipt in demo mode. Same 4-tier fail-closed as live, but `receipt_mode: "demo"`.

### GET /v5/schedule?mic={MIC}
Next open/close times in UTC. Includes `lunch_break`, `settlement_window`, `data_coverage_years`.

### GET /v5/exchanges
Directory of all 28 supported exchanges with MIC, name, timezone, hours, `mic_type`.

### GET /v5/keys
Public key registry with `canonical_payload_spec`, `valid_from`, `valid_until`.

### GET /v5/health
Signed liveness probe. Returns `{ status: "OK", source: "SYSTEM", signature }`. On signing failure: 500 CRITICAL_FAILURE.

### GET /v5/briefing
Daily market intelligence snapshot: open/closed markets, lunch breaks, upcoming events, DST transitions.

### GET /v5/sandbox
Instant sandbox key (200 calls, 7-day TTL). No signup required. IP rate-limited.

### GET /v5/pricing
JSON pricing tiers (sandbox, free, x402, credits, builder, pro, protocol).

### GET /v5/traction
Live metrics snapshot for investor/partner check-ins.

### GET /v5/metrics/public
Social proof: exchange count, uptime, test count, evaluator scores, status codes.

### GET /openapi.json
OpenAPI 3.1 specification covering all endpoints.

### POST /mcp
MCP Streamable HTTP endpoint. See [MCP Reference](mcp-reference.md).

## Authenticated Endpoints (X-Oracle-Key Header)

### GET /v5/status?mic={MIC}
Signed receipt in live mode. Also supports free trial (3/day/IP) and x402 payment when no key provided.

**Headers**: `X-Oracle-Key: {api_key}`
**Response headers**: `X-Oracle-Plan`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-Attestation-Mode`

### GET /v5/batch?mics={MIC,MIC,...}
Batch signed receipts. All MICs validated up front. Independent signing per MIC. Includes `summary.safe_to_execute`.

### GET /v5/usage
Per-key usage stats, limits, credit balance, plan details.

### GET /v5/receipts
Audit log query (builder+ plans only). Supports `limit`, `mic`, `from` params.

### POST /v5/webhooks/subscribe
Register webhook for market state changes. Plan limits: builder=5, pro=25.

## Billing Endpoints

### POST /v5/checkout
Paddle transaction (subscription or credits). Query param `type=credits` for one-time credit pack.

### POST /webhooks/paddle
Paddle webhook handler. Events: `transaction.completed`, `subscription.updated`, `subscription.past_due`, `subscription.canceled`.

### POST /v5/x402/mint
Mint persistent API key via on-chain USDC payment. Builder: 99 USDC, Pro: 299 USDC.

### POST /v5/credits/purchase
Buy credits via x402 micropayment.

## Discovery Endpoints

| Path | Format | Purpose |
|---|---|---|
| `/llms.txt` | Text | LLM crawler index |
| `/llms-full.txt` | Text | Comprehensive LLM docs |
| `/AGENTS.md` | Markdown | AAIF agent briefing |
| `/SKILL.md` | Markdown | Ampersend skill format |
| `/.well-known/agent.json` | JSON | A2A Agent Card |
| `/.well-known/mcp/server-card.json` | JSON | MCP server metadata |
| `/.well-known/x402.json` | JSON | x402 payment discovery |
| `/.well-known/oracle-keys.json` | JSON | RFC 8615 key discovery |
| `/.well-known/oauth-authorization-server` | JSON | RFC 8414 AS metadata |

## Error Format

All errors return JSON with `error` (SCREAMING_SNAKE_CASE code), `message`, and `docs` fields. HTTP status codes are deterministic:
- 400: Invalid request (bad MIC, missing params)
- 401: Missing or invalid API key
- 402: Payment required (suspended key, trial exhausted)
- 403: Forbidden (key not found)
- 405: Method not allowed
- 429: Rate limited
- 500: Critical failure (signing offline)

## Rate Limits

| Plan | Daily Limit |
|---|---|
| Free trial | 3/day per IP |
| Free tier | 500/day |
| Sandbox | 200 calls total (7-day key) |
| Credits | Per balance |
| Builder | 50,000/day |
| Pro | 200,000/day |
| Protocol | Unlimited |
