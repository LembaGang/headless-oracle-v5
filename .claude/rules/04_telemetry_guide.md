<!-- Living document. Update when new evaluator fingerprints appear or
telemetry keys are added. Last updated: 2026-04-10 Day 44 living doc
refresh -->

# Telemetry Guide — Headless Oracle V5

How to read and interpret HO's telemetry. All telemetry is stored in
`ORACLE_TELEMETRY` KV namespace. Writes are best-effort (non-blocking
via `ctx.waitUntil`). Reads are cached where noted.

## KV Key Patterns

### MCP Client Tracking
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `mcp_clients:{YYYY-MM-DD}:{sha256(ip)}` | `McpClientRecord` JSON | 48h | `handleMcp()` |
| `mcp_tool:{toolName}:{YYYY-MM-DD}` | Integer counter | 25h | `tools/call` handler |
| `zero_auth_mcp_requests:{YYYY-MM-DD}` | Integer counter | 25h | MCP status calls without auth |
| `unauth_mcp_status:{hash}:{YYYY-MM-DD}` | Integer counter | 25h | Per-IP unauthenticated MCP status |

`McpClientRecord` fields: `user_agent`, `asn_org`, `country`, `city`, `requests`, `first_seen`, `last_seen`, `tools` (per-tool call counts), `client_info` (from MCP initialize)

### Usage Tracking
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `free_usage:{keyHash}:{YYYY-MM-DD}` | Integer counter | 25h | Free-tier rate limit |
| `trial_usage:{YYYY-MM-DD}:{ipHash}` | Integer counter | 25h | Free trial per-IP |
| `trial_usage_served:{YYYY-MM-DD}` | Integer counter | 25h | Total trial receipts |
| `auth_calls:{YYYY-MM-DD}` | Integer counter | 25h | Authenticated API calls |
| `unauth_calls:{YYYY-MM-DD}` | Integer counter | 25h | Unauthenticated calls |
| `sandbox_cap_hit:{YYYY-MM-DD}` | Integer counter | 25h | Sandbox limit hits |

### HTTP Metrics
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `status_code:{YYYY-MM-DD}:{code}` | Integer counter | 25h | `json()` helper |
| `referrer:{YYYY-MM-DD}:{domain}` | Integer counter | 25h | Referrer tracking |
| `batch_combo:{YYYY-MM-DD}` | Integer counter | 25h | Batch MIC combinations |

### 402 Funnel Tracking
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `funnel_402:keyless_no_payment:{YYYY-MM-DD}` | Integer counter | 25h | 402 without payment header |
| `funnel_402:facilitator_rejected:{YYYY-MM-DD}` | Integer counter | 25h | CDP facilitator rejection |
| `funnel_402:trial_exhausted:{YYYY-MM-DD}` | Integer counter | 25h | Trial limit hit |
| `funnel_402:free_limit_reached:{YYYY-MM-DD}` | Integer counter | 25h | Free tier limit hit |
| `funnel_402:sandbox_limit_reached:{YYYY-MM-DD}` | Integer counter | 25h | Sandbox limit hit |
| `funnel_402:saw_upgrade_paths:{YYYY-MM-DD}` | Integer counter | 25h | Agent saw upgrade paths in 402/429 |

### Instant Key / Conversion Funnel
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `funnel_instant_key:requested:{YYYY-MM-DD}` | Integer counter | 25h | Instant key requested |
| `funnel_instant_key:created:{YYYY-MM-DD}` | Integer counter | 25h | Instant key created |
| `funnel_instant_key:reused:{YYYY-MM-DD}` | Integer counter | 25h | Existing key returned |
| `funnel_demo:fallback:{YYYY-MM-DD}` | Integer counter | 25h | Demo fallback triggered |
| `trial_usage_served:{YYYY-MM-DD}` | Integer counter | 25h | Total trial receipts served |

### x402 Payment Tracking
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `x402_used:{txHash}` | `"1"` | 600s | Replay protection |
| `x402_payment_count` | Integer | none | Lifetime payment counter |
| `x402_first_tx` | txHash string | none | First payment tx |
| `x402_first_payment_at` | ISO timestamp | none | First payment time |
| `x402_last_payment_at` | ISO timestamp | none | Last payment time |

### Sandbox / Conversion
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `sandbox_fingerprint:ip:{ipHash}` | `"1"` | 7 days | IP dedup for sandbox provisioning |
| `sandbox_followup:{keyHash}` | JSON | 7 days | Sandbox follow-up tracking |
| `design_partner:{keyHash}:{YYYY-MM-DD}` | `"1"` | 25h | Design partner detection (>200 req/day) |

### Webhook Tracking
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `webhook_count:{keyHash}` | Integer | none | Active webhook count per key |
| `webhook_dispatcher:health` | JSON | none | DO health status |
| `last_state:{mic}` | Status string | none | Last known state per exchange |

### Aggregated / Cached
| Key Pattern | Value | TTL | Written By |
|---|---|---|---|
| `traction_cache:{YYYY-MM-DD}` | JSON snapshot | 25h | 17:00 daily cron |
| `weekly_digest:{YYYY-WW}` | JSON summary | 90 days | Monday 09:00 cron |

## Known Evaluator Fingerprints

These are the recurring automated evaluators. Update this section when
new fingerprints appear in MCP client telemetry.

### DataCamp
- **User Agent**: `mcp-verify/0.1.0` + `node`
- **ASN**: Datacamp Limited
- **Location**: Ashburn, US
- **Hash prefixes**: `6578c8...` (mcp-verify), `f62cdb...` (node)
- **Behavior**: Probes MCP endpoint periodically; started Day ~7
- **Status**: Active evaluator (11+ days continuous)

### Chiark (Agent Quality Index)
- **User Agent**: `Chiark/0.1`
- **ASN**: Hetzner
- **Location**: Ashburn, US
- **Hash prefix**: `e06614...`
- **ClientInfo**: `chiark-prober/0.1.0`
- **Behavior**: Calls `list_exchanges` tool, quality scoring
- **URL**: chiark.ai

### CacheFly / Glama
- **User Agent**: `node`
- **ASN**: CacheFly
- **Location**: Leesburg, US
- **Hash prefix**: `f86046...`
- **ClientInfo**: `glama/1.0.0`
- **Behavior**: 130-170+ requests/day, highest volume evaluator
- **URL**: glama.ai

### MCPScoreboard
- **User Agent**: `MCPScoringEngine/1.0`
- **ASN**: Hetzner
- **Location**: Hillsboro, US
- **Hash prefix**: `290969...`
- **Behavior**: Scoring engine; HO score: 100/100
- **Note**: Also probes via HEAD /mcp for uptime

### YellowMCP
- **User Agent**: `YellowMCP-HealthChecker/1.0`
- **ASN**: Hostinger
- **Location**: Boston, US
- **Hash prefixes**: `90e9d4...`, `b0c5d1...`
- **ClientInfo**: `yellowmcp-health/1.0`

### AgentDiscoveryIndex
- **User Agent**: `AgentDiscoveryIndex/1.0`
- **ASN**: Amazon
- **Location**: Stockholm, Sweden
- **Behavior**: x402 ecosystem crawler — appeared after first payment settled

### Amazon San Jose (unidentified)
- **User Agent**: empty
- **ASN**: Amazon Technologies Inc.
- **Location**: San Jose, US
- **Hash prefix**: `726bd7...`
- **Behavior**: Persistent daily presence, no clientInfo

### Microsoft
- **User Agent**: `python-httpx/0.28.1`
- **ASN**: Microsoft Corporation
- **Location**: Rotating cities
- **Behavior**: Sporadic probing

### Deutsche Telekom Berlin
- **User Agent**: `headless-oracle-mcp/1.0.0`
- **ASN**: Deutsche Telekom AG
- **Location**: Berlin, DE
- **Behavior**: Real npm package user

### Oracle Svenska / Italy
- **User Agent**: `headless-oracle-mcp/1.0.0`
- **ASN**: Oracle Svenska AB
- **Location**: Rivoli, IT
- **Behavior**: Real npm package user

### Indiana University
- **User Agent**: `headless-oracle-mcp/1.0.0`
- **ASN**: Indiana University
- **Location**: Bloomington, US
- **Behavior**: Called `get_market_status` — academic user

### Drexel University
- **User Agent**: varies
- **ASN**: Drexel University
- **Location**: Philadelphia, US
- **Behavior**: Academic evaluator — appeared Day 44

### Latitude.sh
- **User Agent**: varies
- **ASN**: Latitude.sh
- **Behavior**: Infrastructure evaluator — appeared Day 44

### continuum-sync
- **Behavior**: Evaluator — appeared Day 44

### MCP-Client NYC
- **Behavior**: MCP client evaluator — appeared Day 44

### Comcast Philadelphia
- **User Agent**: `python-httpx/0.24.1`
- **ASN**: Comcast
- **Location**: Philadelphia, US

### Bel Air Internet LA
- **User Agent**: `Bun/1.3.2`
- **ASN**: Bel Air Internet LLC
- **Location**: Los Angeles, US

## How to Read the Data

### Traffic Health Indicators
- **200 count** = successful requests (trial + auth + demo + public)
- **402 count** = paywall hits — conversion opportunities
- **429 count** = rate limit hits — possible abuse or need to upgrade limits
- **auth_calls > 0** = real paying/authorized usage

### Conversion Signals
- **funnel_402:keyless_no_payment** = agents that could convert but didn't provide payment
- **funnel_402:trial_exhausted** = agents that used all 3 free receipts (high-intent)
- **design_partner:** entries = keys exceeding 200 req/day (reach out)
- **sandbox_cap_hit** increasing = sandbox limit too low or users need upgrade path

### Discovery & Growth
- New user agents or ASNs = new discovery (check within 48hrs of outreach)
- `referrer:*:t.co` = Twitter/X driving traffic
- `referrer:*:github.com` = GitHub issues/PRs driving traffic
- `referrer:*:smithery.ai` = Smithery registry referrals
- New `client_info` names = new MCP clients integrating

### Weekly Trends
- `weekly_digest` week-over-week: `unique_clients`, `total_requests`, `new_clients`, `returning_clients`, `top_client_asn`
- `returning_clients` growing = retention signal
- `new_clients` growing = discovery working

## Endpoints That Expose Telemetry

| Endpoint | Auth | What It Shows |
|---|---|---|
| `GET /v5/metrics` | no | Total MCP requests + unique clients today |
| `GET /v5/metrics/public` | no | Social proof: exchanges, uptime, tests, status codes, clients |
| `GET /v5/traction` | no | Live snapshot: exchanges, days live, MCP stats, x402 status |
| `GET /v5/referrers` | no | Referrer domain counts (supports `?date=`) |
| `GET /v5/usage` | yes | Per-key usage stats, limits, credit balance |
| `GET /v5/payment-proof` | no | x402 lifetime payment stats from KV |
