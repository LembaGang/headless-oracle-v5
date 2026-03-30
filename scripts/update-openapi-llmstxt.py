"""
Adds missing Sprint 2/3 endpoints to the OpenAPI spec and LLMS_TXT table in src/index.ts.

Missing from OpenAPI paths:
  /v5/webhooks/subscribe (POST), /v5/webhooks (GET), /v5/webhooks/{webhook_id} (DELETE),
  /v5/webhooks/test/{webhook_id} (POST), /v5/webhooks/health (GET),
  /v5/receipts (GET), /v5/x402/mint (POST), /v5/credits/purchase (POST),
  /v5/credits/balance (GET), /v5/card/{mic} (GET)

Missing from LLMS_TXT endpoint table:
  /v5/webhooks (GET), /v5/webhooks/:id (DELETE), /v5/webhooks/test/:id (POST),
  /v5/webhooks/health (GET), /v5/card/:mic (GET), /v5/x402/mint (POST),
  /v5/credits/purchase (POST), /v5/credits/balance (GET)
"""

import re

SRC = "src/index.ts"

with open(SRC, "r", encoding="utf-8") as f:
    content = f.read()

# ─── 1. OpenAPI spec additions ────────────────────────────────────────────────
# Insert before the closing of the paths object (before the line that closes OPENAPI_SPEC)
# We look for the last path entry closing before `};` of the whole spec

NEW_OPENAPI_PATHS = """		'/v5/webhooks/subscribe': {
			post: {
				tags:        ['Webhooks'],
				summary:     'Subscribe to market state-change webhooks',
				description: 'Register a webhook URL to receive signed receipts when a market transitions between states (OPEN↔CLOSED, HALT). Builder+ plans only. Sandbox keys are rejected. Returns webhook_id and subscription_id.',
				security:    [{ ApiKeyAuth: [] }],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object',
						required: ['url', 'mics'],
						properties: {
							url:    { type: 'string', format: 'uri', description: 'HTTPS endpoint to receive webhook deliveries.' },
							mics:   { type: 'array', items: { type: 'string' }, description: 'MIC codes to subscribe to (e.g. ["XNYS","XNAS"]).' },
							events: { type: 'array', items: { type: 'string' }, description: 'Event types to subscribe to. Default: ["status_change"].' },
						},
					} } },
				},
				responses: {
					'200': {
						description: 'Subscription created',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								webhook_id:      { type: 'string', description: 'Unique ID for this webhook. Use for DELETE /v5/webhooks/{webhook_id}.' },
								subscription_id: { type: 'string', description: 'Legacy alias for webhook_id (backward compat).' },
								url:             { type: 'string' },
								mics:            { type: 'array', items: { type: 'string' } },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'402': { description: 'Sandbox keys cannot use webhooks — upgrade required', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key or plan limit reached (builder=5, pro=25)', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks': {
			get: {
				tags:        ['Webhooks'],
				summary:     'List all webhooks for this API key',
				description: 'Returns all active webhook subscriptions for the authenticated key. Each entry includes webhook_id, url, mics, events, created_at, status.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Webhook list',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								webhooks: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											webhook_id:  { type: 'string' },
											url:         { type: 'string' },
											mics:        { type: 'array', items: { type: 'string' } },
											events:      { type: 'array', items: { type: 'string' } },
											created_at:  { type: 'string', format: 'date-time' },
											status:      { type: 'string', enum: ['active', 'paused'] },
										},
									},
								},
								count: { type: 'integer' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/{webhook_id}': {
			delete: {
				tags:        ['Webhooks'],
				summary:     'Delete a webhook subscription',
				description: 'Permanently removes the webhook subscription. Returns 204 No Content on success. Also decrements the plan webhook count.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'webhook_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Webhook ID returned from POST /v5/webhooks/subscribe.' },
				],
				responses: {
					'204': { description: 'Webhook deleted' },
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key or webhook does not belong to this key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'404': { description: 'Webhook not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/test/{webhook_id}': {
			post: {
				tags:        ['Webhooks'],
				summary:     'Send a synthetic test delivery to a webhook',
				description: 'Fires a single test delivery to the webhook URL. Uses the current market state for the first subscribed MIC. One delivery attempt (no retry). Returns the payload sent.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'webhook_id', in: 'path', required: true, schema: { type: 'string' }, description: 'Webhook ID to test.' },
				],
				responses: {
					'200': {
						description: 'Test delivery result',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								delivered:    { type: 'boolean' },
								payload_sent: { type: 'object', description: 'The exact webhook payload delivered.' },
								status_code:  { type: 'integer', description: 'HTTP status from the webhook endpoint.' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Webhook does not belong to this key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'404': { description: 'Webhook not found', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/webhooks/health': {
			get: {
				tags:        ['Webhooks'],
				summary:     'WebhookDispatcher Durable Object health status',
				description: 'Returns the last known health status of the WebhookDispatcher Durable Object — written by the DO alarm() after each 60s dispatch cycle. No authentication required. Does not wake the DO.',
				responses: {
					'200': {
						description: 'Dispatcher health status',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								status:      { type: 'string', enum: ['ok', 'unknown'], description: '"ok" = DO alarm ran recently. "unknown" = no health record in KV yet.' },
								next_alarm:  { type: 'string', format: 'date-time', description: 'When the next dispatch cycle is scheduled.' },
								checked_at:  { type: 'string', format: 'date-time' },
							},
						} } },
					},
				},
			},
		},
		'/v5/receipts': {
			get: {
				tags:        ['Audit'],
				summary:     'Receipt audit log (builder+ only)',
				description: 'Returns a filtered audit log of signed receipts issued to this API key. Each row contains mic, status, source, issued_at, schema_version. Requires Builder or Pro plan. Supports limit, mic, and from query params.',
				security:    [{ ApiKeyAuth: [] }],
				parameters:  [
					{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50 }, description: 'Max rows to return (max 200).' },
					{ name: 'mic',   in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by MIC code.' },
					{ name: 'from',  in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Return receipts after this ISO8601 timestamp.' },
				],
				responses: {
					'200': {
						description: 'Audit log',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								receipts: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											mic:            { type: 'string' },
											status:         { '$ref': '#/components/schemas/Status' },
											source:         { '$ref': '#/components/schemas/Source' },
											issued_at:      { type: 'string', format: 'date-time' },
											schema_version: { type: 'string', example: 'v5.0' },
										},
									},
								},
								count: { type: 'integer' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'402': { description: 'Plan upgrade required (sandbox/free keys cannot access receipt audit)', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/x402/mint': {
			post: {
				tags:        ['Billing'],
				summary:     'Mint a persistent API key via x402 USDC payment',
				description: 'Agents submit a verified Base mainnet USDC transaction hash and receive a persistent ho_live_ API key. Builder tier: 99 USDC = 50K calls/day. Pro tier: 299 USDC = 200K calls/day. Replay protection: each tx_hash can only be used once (365-day TTL).',
				requestBody: {
					required: true,
					content: { 'application/json': { schema: {
						type: 'object',
						required: ['tx_hash', 'tier'],
						properties: {
							tx_hash: { type: 'string', description: 'Base mainnet USDC transaction hash (0x-prefixed).' },
							tier:    { type: 'string', enum: ['builder', 'pro'], description: 'Desired key tier.' },
							email:   { type: 'string', format: 'email', description: 'Optional: receive the key by email.' },
						},
					} } },
				},
				responses: {
					'200': {
						description: 'Key minted',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								api_key:     { type: 'string', description: 'Your new persistent API key (ho_live_ prefix). Store securely — shown once.' },
								tier:        { type: 'string', enum: ['builder', 'pro'] },
								daily_limit: { type: 'integer' },
							},
						} } },
					},
					'400': { description: 'Invalid tx_hash or payment amount insufficient', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'409': { description: 'Transaction already used to mint a key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'503': { description: 'Base mainnet RPC unavailable', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/credits/purchase': {
			post: {
				tags:        ['Billing'],
				summary:     'Purchase prepaid credits via x402 USDC payment',
				description: 'Submit a verified Base mainnet USDC payment to add prepaid credits to your key. Credit tiers: 0.001 USDC = 1 credit, 0.09 USDC = 100 credits, 0.80 USDC = 1000 credits. Requires X-Payment header with verified tx.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Credits added',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								credits_added:    { type: 'integer' },
								new_balance:      { type: 'integer' },
								tier:             { type: 'string' },
							},
						} } },
					},
					'402': { description: 'Payment required or insufficient amount', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'503': { description: 'Payment verification service unavailable', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/credits/balance': {
			get: {
				tags:        ['Billing'],
				summary:     'Check prepaid credit balance',
				description: 'Returns the current credit balance for the authenticated key. Credits are consumed 1-per-request on /v5/status and /v5/batch when the free tier limit is reached.',
				security:    [{ ApiKeyAuth: [] }],
				responses: {
					'200': {
						description: 'Credit balance',
						content: { 'application/json': { schema: {
							type: 'object',
							properties: {
								balance:                    { type: 'integer', description: 'Remaining prepaid credits.' },
								estimated_requests_remaining: { type: 'integer' },
								last_purchased:             { type: 'string', format: 'date-time' },
							},
						} } },
					},
					'401': { description: 'Missing API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
					'403': { description: 'Invalid API key', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
		'/v5/card/{mic}': {
			get: {
				tags:        ['Discoverability'],
				summary:     'SVG status card for a market exchange',
				description: 'Returns a terminal-style SVG status card showing the current market state for a MIC. Dark chrome, syntax-highlighted JSON, status-coloured text, pulsing LIVE dot. Cache-Control: no-cache. Suitable for README badges and dashboards.',
				parameters:  [
					{ name: 'mic', in: 'path', required: true, schema: { type: 'string' }, description: 'MIC code (e.g. XNYS, XNAS, XLON).' },
				],
				responses: {
					'200': {
						description: 'SVG status card',
						content: { 'image/svg+xml': { schema: { type: 'string', format: 'binary' } } },
					},
					'400': { description: 'Unknown MIC code', content: { 'application/json': { schema: { '$ref': '#/components/schemas/Error' } } } },
				},
			},
		},
"""

# Find the closing of the paths object — look for the last path entry before the overall OPENAPI_SPEC closes
# The pattern we want: the last `},` before `\t},\n};\n\n// ─── Signed Receipt`
# Find the spot after the /.well-known/agent.json entry closes
TARGET = "\t\t},\n\t},\n};\n"
REPLACEMENT = "\t\t},\n\t},\n" + NEW_OPENAPI_PATHS + "};\n"

if TARGET not in content:
    # Try alternative closing pattern
    TARGET = "\t\t\t},\n\t\t},\n\t},\n};\n"
    print("Using alternative closing pattern")

if TARGET in content:
    # Only replace the LAST occurrence (end of OpenAPI spec, not intermediate closing)
    idx = content.rfind(TARGET)
    if idx != -1:
        content = content[:idx] + REPLACEMENT + content[idx + len(TARGET):]
        print("OpenAPI paths: inserted successfully")
    else:
        print("ERROR: Could not find insertion point for OpenAPI paths")
else:
    print(f"ERROR: Target pattern not found in content. First 50 chars: {repr(TARGET[:50])}")

# ─── 2. LLMS_TXT endpoint table additions ─────────────────────────────────────
NEW_LLMS_ROWS = """\
| /v5/webhooks | GET | Yes | List all webhook subscriptions for this key | { webhooks: [{webhook_id, url, mics, events, status}], count } |
| /v5/webhooks/:id | DELETE | Yes | Delete a webhook subscription | 204 No Content |
| /v5/webhooks/test/:id | POST | Yes | Fire a synthetic test delivery to a webhook | { delivered, payload_sent, status_code } |
| /v5/webhooks/health | GET | No | WebhookDispatcher DO health (last alarm cycle) | { status, next_alarm } |
| /v5/card/:mic | GET | No | SVG terminal-style status card | image/svg+xml |
| /v5/x402/mint | POST | No | Mint persistent API key via Base USDC tx | { api_key, tier, daily_limit } |
| /v5/credits/purchase | POST | Yes | Add prepaid credits via x402 USDC payment | { credits_added, new_balance } |
| /v5/credits/balance | GET | Yes | Check prepaid credit balance | { balance, estimated_requests_remaining } |"""

# Insert after the last row of the endpoint table (before the Receipt Schema section)
TABLE_END_MARKER = "| /status | GET | No | HTML market status page for all 28 exchanges | text/html |"
TABLE_INSERT = TABLE_END_MARKER + "\n" + NEW_LLMS_ROWS

if TABLE_END_MARKER in content:
    content = content.replace(TABLE_END_MARKER, TABLE_INSERT, 1)
    print("LLMS_TXT table: rows inserted successfully")
else:
    print("ERROR: LLMS_TXT table end marker not found")

# ─── Write back ───────────────────────────────────────────────────────────────
with open(SRC, "w", encoding="utf-8") as f:
    f.write(content)

print("Done.")
