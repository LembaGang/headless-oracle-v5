/**
 * Paddle webhook end-to-end test script
 *
 * Tests the subscription.activated flow against the live worker.
 * Requires PADDLE_WEBHOOK_SECRET to generate valid signatures.
 *
 * Usage:
 *   PADDLE_WEBHOOK_SECRET=pdl_ntfset_... npx tsx scripts/test-paddle-webhook.ts
 *
 * Or for manual testing via curl — see the curl command at the bottom of this file.
 */

const TARGET_URL = 'https://headlessoracle.com/webhooks/paddle';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildSignature(rawBody: string, secret: string): Promise<string> {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signedContent = `${timestamp}:${rawBody}`;
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedContent));
	const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
	return `ts=${timestamp};h1=${hex}`;
}

// ─── Test payloads ────────────────────────────────────────────────────────────

/**
 * subscription.activated payload — new Builder subscription
 *
 * Key differences from transaction.completed:
 *   - event_type: "subscription.activated"
 *   - data.id = subscription_id (not data.subscription_id)
 *   - data.items[0].price.id (nested) vs items[0].price_id (flat in transaction.completed)
 */
function buildActivatedPayload(priceId: string, customerId = 'ctm_test_01abc123', subscriptionId = 'sub_test_01abc456') {
	return {
		event_type: 'subscription.activated',
		notification_id: `ntf_test_${Date.now()}`,
		data: {
			id:           subscriptionId,   // subscription_id — used for idempotency
			status:       'active',
			customer_id:  customerId,
			created_at:   new Date().toISOString(),
			items: [
				{
					price: {
						id:         priceId,   // items[0].price.id — note nested vs transaction.completed
						product_id: 'pro_test_001',
						name:       'Headless Oracle Builder',
					},
					quantity: 1,
					status:   'active',
				},
			],
			custom_data: null,
		},
	};
}

// ─── Step-by-step handler trace ───────────────────────────────────────────────

function traceHandlerLogic() {
	console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  subscription.activated handler — step-by-step trace                ║
╚══════════════════════════════════════════════════════════════════════╝

Step 1: Signature verification
  Header:  Paddle-Signature: ts=<unix>;h1=<hmac-sha256-hex>
  Payload: "<timestamp>:<raw_body>"
  Secret:  PADDLE_WEBHOOK_SECRET env var
  Reject:  signatures older than 300s (replay protection)

Step 2: Parse event
  event.event_type === 'subscription.activated'  →  enters handler
  event.data.id                                  →  subscriptionId (used for idempotency)

Step 3: Supabase guard
  If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing → log error, return 200 { received: true }
  (fail-safe: never return 500 to Paddle on config error — would trigger retries)

Step 4: Idempotency check
  SELECT id, key_hash, plan FROM api_keys
  WHERE stripe_subscription_id = subscriptionId

  If row exists → go to Step 5 (upgrade path)
  If no row    → go to Step 6 (new key path)

Step 5: Upgrade path (existing subscription)
  If existingActiv.plan !== activPlan:
    UPDATE api_keys SET plan = activPlan, status = 'active'
    WHERE stripe_subscription_id = subscriptionId
    Also update ORACLE_API_KEYS KV cache (same key_hash, new plan)
  Return 200 { received: true } — no new key generated

Step 6: Plan detection (new subscription)
  items[0].price?.id  →  compare against env vars:
    PADDLE_PRICE_ID_BUILDER   → plan = 'builder'
    PADDLE_PRICE_ID_PRO       → plan = 'pro'
    PADDLE_PRICE_ID_PROTOCOL  → plan = 'protocol'
    (unrecognised)            → plan = 'pro'  (fail-safe default)

Step 7: Email fetch
  GET https://api.paddle.com/customers/{customer_id}
  Authorization: Bearer PADDLE_API_KEY
  Response: { data: { email: "customer@example.com" } }
  On failure: console.error, continue with activEmail = null

Step 8: Key generation
  rawKeyBytes = crypto.getRandomValues(new Uint8Array(32))
  keyValue    = 'ho_live_' + toHex(rawKeyBytes)   // 'ho_live_' + 64 hex chars
  keyHash     = sha256Hex(keyValue)
  keyPrefix   = keyValue.substring(0, 14)          // 'ho_live_' + 6 chars

Step 9: Supabase insert (fail-closed)
  INSERT INTO api_keys {
    id, key_hash, key_prefix, plan, status='active',
    stripe_customer_id, stripe_subscription_id, email, created_at
  }
  On dbError → return 500 { error: 'DB_ERROR' }  ← key NOT yet in KV

Step 10: KV cache warm
  ORACLE_API_KEYS.put(keyHash, { plan, status, paddle_customer_id, ... })
  (persistent, no TTL — deactivated on subscription.canceled)

Step 11: Email delivery (non-fatal)
  POST https://api.resend.com/emails
  from: keys@headlessoracle.com
  to: [activEmail]
  subject: "Your Headless Oracle API key"
  html: contains keyValue plaintext (shown once, not stored)
  On failure: console.error only — key already stored, user can contact support

Step 12: Return 200 { received: true }
`);
}

// ─── Rate limit logic trace ───────────────────────────────────────────────────

function traceRateLimits() {
	console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  Rate limiting by plan — logic trace                                 ║
╚══════════════════════════════════════════════════════════════════════╝

Constants (src/index.ts):
  FREE_TIER_DAILY_LIMIT    = 500
  BUILDER_TIER_DAILY_LIMIT = 50,000
  PRO_TIER_DAILY_LIMIT     = 200,000

getPlanDailyLimit(plan):
  'free'     → 500
  'builder'  → 50,000
  'pro'      → 200,000
  'protocol' → null  (unlimited)
  'internal' → null  (unlimited)

Rate limit gate in /v5/status (and /v5/batch):

  if (auth.plan === 'free') {
    usage = getDailyUsage(keyHash, env)    // reads KV: free_usage:{keyHash}:{date}
    if usage >= 500: → x402 gate or 402/429
    else: incrementDailyUsage(...)

  } else if (auth.plan === 'builder' || auth.plan === 'pro') {
    paidUsage = getDailyUsage(paidKeyHash, env)
    paidLimit = getPlanDailyLimit(auth.plan)  // 50k or 200k
    if paidUsage >= paidLimit:
      → 429 { error: 'RATE_LIMITED', message: 'builder plan daily limit (50,000 req/day) reached' }
    else: incrementDailyUsage(...)
  }
  // protocol, internal: no check → pass through

KV key format: free_usage:{sha256(apiKey)}:{YYYY-MM-DD}
KV value:      string count, e.g. "12345"
TTL:           25 hours (auto-expires after the day rolls over)

Builder plan verification:
  1. checkApiKey() reads ORACLE_API_KEYS KV → { plan: 'builder', status: 'active' }
  2. auth.plan === 'builder' → enters paid tier gate
  3. getDailyUsage() reads free_usage:{hash}:{today} from ORACLE_TELEMETRY
  4. if count >= 50000 → 429 with message containing 'builder plan daily limit (50,000 req/day)'
  5. Test proof: test 'builder plan at daily limit (50k) → 429 RATE_LIMITED' in index.spec.ts
`);
}

// ─── Live test ────────────────────────────────────────────────────────────────

async function runLiveTest() {
	const secret = process.env.PADDLE_WEBHOOK_SECRET;
	const builderPriceId = process.env.PADDLE_PRICE_ID_BUILDER ?? 'pri_test_builder_placeholder';

	if (!secret) {
		console.warn('\n⚠  PADDLE_WEBHOOK_SECRET not set — cannot sign payload. See curl command below.\n');
		printCurlCommand(builderPriceId);
		return;
	}

	const payload = buildActivatedPayload(builderPriceId);
	const rawBody = JSON.stringify(payload);
	const sig = await buildSignature(rawBody, secret);

	console.log('\n🔑  Sending subscription.activated to', TARGET_URL);
	console.log('    Subscription ID:', payload.data.id);
	console.log('    Plan price ID:  ', builderPriceId);

	const res = await fetch(TARGET_URL, {
		method: 'POST',
		headers: {
			'Content-Type':    'application/json',
			'Paddle-Signature': sig,
		},
		body: rawBody,
	});

	const body = await res.json();
	console.log('\nHTTP status:', res.status);
	console.log('Response:   ', JSON.stringify(body, null, 2));

	if (res.status === 200 && (body as Record<string, unknown>).received === true) {
		console.log('\n✅  Webhook accepted. Check Supabase api_keys table for subscription_id:', payload.data.id);
		console.log('    Also check Resend dashboard for delivery to the customer email.');
	} else {
		console.error('\n❌  Unexpected response — check worker logs.');
	}
}

function printCurlCommand(priceId: string) {
	const payload = buildActivatedPayload(priceId);
	const rawBody = JSON.stringify(payload);

	console.log(`
To test manually using Paddle's webhook dashboard:
──────────────────────────────────────────────────
1. Go to: https://vendors.paddle.com/notifications
2. Create a notification destination: POST https://headlessoracle.com/webhooks/paddle
3. Enable event: subscription.activated
4. Use "Send test notification" with the payload below
5. Check Supabase api_keys for the new row
6. Check Resend logs for the key email

Test payload (paste into Paddle's test tool):
${rawBody}

──────────────────────────────────────────────────
To test with a real secret (replace pdl_ntfset_... with your actual secret):
──────────────────────────────────────────────────
TIMESTAMP=$(date +%s)
BODY='${rawBody}'
SIG=$(echo -n "\${TIMESTAMP}:\${BODY}" | openssl dgst -sha256 -hmac "YOUR_WEBHOOK_SECRET" | awk '{print "ts="\$1";h1="\$2}')

# Note: above openssl command outputs "ts=<algo>;<hash>" — adjust format to "ts=<timestamp>;h1=<hex>"
# Use the Node.js script approach instead for correct formatting:
PADDLE_WEBHOOK_SECRET=pdl_ntfset_YOUR_SECRET npx tsx scripts/test-paddle-webhook.ts
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

traceHandlerLogic();
traceRateLimits();
await runLiveTest();
