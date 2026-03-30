#!/usr/bin/env python3
"""
Sprint 2: Real-time webhook state change notifications via WebhookDispatcher DO.
Applies all changes to src/index.ts and wrangler.toml.
"""

import re

# ─── Load files ────────────────────────────────────────────────────────────────

with open('src/index.ts', 'r', encoding='utf-8') as f:
    src = f.read()

with open('wrangler.toml', 'r', encoding='utf-8') as f:
    toml = f.read()

# ─── Change 1: Add WEBHOOK_DISPATCHER to Env interface ────────────────────────

old = '\tSTREAM_COORDINATOR:          DurableObjectNamespace;  // SSE stream coordinator — one DO per MIC\n}'
new = '\tSTREAM_COORDINATOR:          DurableObjectNamespace;  // SSE stream coordinator — one DO per MIC\n\tWEBHOOK_DISPATCHER:          DurableObjectNamespace;  // Webhook delivery DO — alarm-based state-change fan-out\n}'
assert old in src, 'CHANGE 1 FAILED: STREAM_COORDINATOR line not found'
src = src.replace(old, new, 1)

# ─── Change 2: Add plan webhook limit constants + helpers after getPlanDailyLimit ─

old_func = """\
// Returns the daily request limit for a given plan. null = unlimited (protocol, internal).
function getPlanDailyLimit(plan: string): number | null {
\tswitch (plan) {
\t\tcase 'free':    return FREE_TIER_DAILY_LIMIT;
\t\tcase 'sandbox': return SANDBOX_DAILY_LIMIT;
\t\tcase 'builder': return BUILDER_TIER_DAILY_LIMIT;
\t\tcase 'pro':     return PRO_TIER_DAILY_LIMIT;
\t\tdefault:        return null; // protocol, internal — no limit
\t}
}"""

new_func = """\
// Returns the daily request limit for a given plan. null = unlimited (protocol, internal).
function getPlanDailyLimit(plan: string): number | null {
\tswitch (plan) {
\t\tcase 'free':    return FREE_TIER_DAILY_LIMIT;
\t\tcase 'sandbox': return SANDBOX_DAILY_LIMIT;
\t\tcase 'builder': return BUILDER_TIER_DAILY_LIMIT;
\t\tcase 'pro':     return PRO_TIER_DAILY_LIMIT;
\t\tdefault:        return null; // protocol, internal — no limit
\t}
}

// Max active webhook subscriptions per plan.
// null = unlimited (protocol, internal keys).
// 0 = not allowed (sandbox).
const BUILDER_WEBHOOK_LIMIT = 5;
const PRO_WEBHOOK_LIMIT     = 25;

function getPlanWebhookLimit(plan: string): number | null {
\tswitch (plan) {
\t\tcase 'sandbox': return 0;
\t\tcase 'builder': return BUILDER_WEBHOOK_LIMIT;
\t\tcase 'pro':     return PRO_WEBHOOK_LIMIT;
\t\tdefault:        return null; // protocol, internal, free — handled by separate MIC limit
\t}
}

// Computes HMAC-SHA256 over a payload string using a shared secret.
// Returns "sha256=<hex>" for use in the X-Oracle-Signature header.
async function computeHmacSignature(secret: string, payload: string): Promise<string> {
\tconst key = await crypto.subtle.importKey(
\t\t'raw',
\t\tnew TextEncoder().encode(secret),
\t\t{ name: 'HMAC', hash: 'SHA-256' },
\t\tfalse,
\t\t['sign'],
\t);
\tconst sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
\treturn 'sha256=' + toHex(new Uint8Array(sig));
}"""

assert old_func in src, 'CHANGE 2 FAILED: getPlanDailyLimit block not found'
src = src.replace(old_func, new_func, 1)

# ─── Change 3: Replace deliverWebhook() with HMAC + 3-retry exponential backoff ─

old_deliver = """\
async function deliverWebhook(target: WebhookDeliveryTarget, payload: Record<string, unknown>): Promise<void> {
\tconst body = JSON.stringify(payload);
\tconst attempt = async () => fetch(target.url, {
\t\tmethod:  'POST',
\t\theaders: { 'Content-Type': 'application/json', 'User-Agent': 'HeadlessOracle-Webhook/1.0' },
\t\tbody,
\t\tsignal:  AbortSignal.timeout(10000),
\t});
\ttry {
\t\tconst resp = await attempt();
\t\tif (!resp.ok) {
\t\t\t// One retry after 1 second
\t\t\tawait scheduler.wait(1000);
\t\t\tconst retry = await attempt();
\t\t\tif (!retry.ok) {
\t\t\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, url: target.url, status: retry.status }));
\t\t\t\treturn;
\t\t\t}
\t\t}
\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED', subscription_id: target.subscription_id }));
\t} catch (err) {
\t\tconst msg = err instanceof Error ? err.message : String(err);
\t\ttry {
\t\t\tawait scheduler.wait(1000);
\t\t\tconst retry = await attempt();
\t\t\tif (retry.ok) { console.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED_RETRY', subscription_id: target.subscription_id })); return; }
\t\t} catch { /* ignore retry error */ }
\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, error: msg }));
\t}
}"""

new_deliver = """\
async function deliverWebhook(target: WebhookDeliveryTarget, payload: Record<string, unknown>): Promise<{ ok: boolean; status?: number; error?: string }> {
\tconst body = JSON.stringify(payload);
\tconst deliveredAt = new Date().toISOString();

\t// Add HMAC-SHA256 signature to the payload if the subscription has a secret.
\t// Header: X-Oracle-Signature: sha256=<hmac_hex>
\tconst sigHeaders: Record<string, string> = {};
\tif (target.secret) {
\t\tsigHeaders['X-Oracle-Signature'] = await computeHmacSignature(target.secret, body);
\t}

\tconst attempt = () => fetch(target.url, {
\t\tmethod:  'POST',
\t\theaders: {
\t\t\t'Content-Type': 'application/json',
\t\t\t'User-Agent':   'HeadlessOracle-Webhook/1.0',
\t\t\t'X-Oracle-Event-At': deliveredAt,
\t\t\t...sigHeaders,
\t\t},
\t\tbody,
\t\tsignal: AbortSignal.timeout(10000),
\t});

\t// 3 attempts with exponential backoff: immediate, 1s, 4s, 16s
\tconst delays = [0, 1000, 4000, 16000];
\tfor (let i = 0; i < delays.length; i++) {
\t\tif (delays[i] > 0) await scheduler.wait(delays[i]);
\t\ttry {
\t\t\tconst resp = await attempt();
\t\t\tif (resp.ok) {
\t\t\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_DELIVERED', subscription_id: target.subscription_id, attempt: i + 1 }));
\t\t\t\treturn { ok: true, status: resp.status };
\t\t\t}
\t\t\tif (i === delays.length - 1) {
\t\t\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, url: target.url, status: resp.status, attempts: delays.length }));
\t\t\t\treturn { ok: false, status: resp.status };
\t\t\t}
\t\t} catch (err) {
\t\t\tconst msg = err instanceof Error ? err.message : String(err);
\t\t\tif (i === delays.length - 1) {
\t\t\t\tconsole.log(JSON.stringify({ event: 'WEBHOOK_FAILED', subscription_id: target.subscription_id, error: msg, attempts: delays.length }));
\t\t\t\treturn { ok: false, error: msg };
\t\t\t}
\t\t}
\t}
\treturn { ok: false, error: 'exhausted' };
}"""

assert old_deliver in src, 'CHANGE 3 FAILED: old deliverWebhook not found'
src = src.replace(old_deliver, new_deliver, 1)

# ─── Change 4: Update webhook delivery payload in runHaltMonitor ──────────────

old_payload = """\
\t\tfor (const target of targets) {
\t\t\tconst payload = {
\t\t\t\tevent:           'state_changed',
\t\t\t\tmic,
\t\t\t\tprevious_status: lastState,
\t\t\t\tnew_status:      currentStatus,
\t\t\t\treceipt,
\t\t\t\tsecret:          target.secret,
\t\t\t\ttimestamp:       now.toISOString(),
\t\t\t};
\t\t\twebhookDeliveries.push(deliverWebhook(target, payload));
\t\t}"""

new_payload = """\
\t\tfor (const target of targets) {
\t\t\tconst payload = {
\t\t\t\tevent:           'status_change',
\t\t\t\twebhook_id:      target.subscription_id,
\t\t\t\tmic,
\t\t\t\tprevious_status: lastState,
\t\t\t\tcurrent_status:  currentStatus,
\t\t\t\treceipt,
\t\t\t\tdelivered_at:    now.toISOString(),
\t\t\t};
\t\t\twebhookDeliveries.push(deliverWebhook(target, payload));
\t\t}"""

assert old_payload in src, 'CHANGE 4 FAILED: old delivery payload not found'
src = src.replace(old_payload, new_payload, 1)

# ─── Change 5: Add plan limit check inside POST /v5/webhooks/subscribe ────────
# After sandbox check, before body parsing — add builder/pro plan limit check.

old_after_sandbox = """\
\t\t\t\tif (subAuth.plan === 'sandbox') {
\t\t\t\t\treturn json({
\t\t\t\t\t\terror:          'paid_feature',
\t\t\t\t\t\tfeature:        'webhook_subscriptions',
\t\t\t\t\t\tavailable_from: 'free',
\t\t\t\t\t\tupgrade:        'https://headlessoracle.com/upgrade',
\t\t\t\t\t\tcurrent_plan:   'sandbox',
\t\t\t\t\t}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/upgrade' });
\t\t\t\t}

\t\t\t\tlet body: { url?: unknown; mics?: unknown; secret?: unknown };"""

new_after_sandbox = """\
\t\t\t\tif (subAuth.plan === 'sandbox') {
\t\t\t\t\treturn json({
\t\t\t\t\t\terror:          'paid_feature',
\t\t\t\t\t\tfeature:        'webhook_subscriptions',
\t\t\t\t\t\tavailable_from: 'free',
\t\t\t\t\t\tupgrade:        'https://headlessoracle.com/upgrade',
\t\t\t\t\t\tcurrent_plan:   'sandbox',
\t\t\t\t\t}, 402, { 'X-Upgrade-URL': 'https://headlessoracle.com/upgrade' });
\t\t\t\t}

\t\t\t\t// Enforce per-plan webhook count limits (builder: 5, pro: 25, protocol: unlimited)
\t\t\t\tconst webhookPlanLimit = getPlanWebhookLimit(subAuth.plan ?? 'free');
\t\t\t\tif (webhookPlanLimit !== null && webhookPlanLimit > 0) {
\t\t\t\t\tconst subKeyHash = subAuth.keyHash ?? await sha256Hex(request.headers.get('X-Oracle-Key')!);
\t\t\t\t\tconst existingSubs = await getWebhookSubscriptions(subKeyHash, env);
\t\t\t\t\tif (existingSubs.length >= webhookPlanLimit) {
\t\t\t\t\t\treturn json({
\t\t\t\t\t\t\terror:       'PLAN_LIMIT_EXCEEDED',
\t\t\t\t\t\t\tmessage:     \`Your \${subAuth.plan} plan allows up to \${webhookPlanLimit} webhook subscription(s). Delete an existing webhook to add a new one, or upgrade at headlessoracle.com/upgrade.\`,
\t\t\t\t\t\t\tplan:        subAuth.plan,
\t\t\t\t\t\t\tlimit:       webhookPlanLimit,
\t\t\t\t\t\t\tcurrent:     existingSubs.length,
\t\t\t\t\t\t\tupgrade_url: 'https://headlessoracle.com/upgrade',
\t\t\t\t\t\t}, 403);
\t\t\t\t\t}
\t\t\t\t}

\t\t\t\tlet body: { url?: unknown; mics?: unknown; secret?: unknown };"""

assert old_after_sandbox in src, 'CHANGE 5 FAILED: sandbox check block not found'
src = src.replace(old_after_sandbox, new_after_sandbox, 1)

# ─── Change 6: Track webhook_count KV on subscribe ───────────────────────────
# After writing to per-MIC fan-out index, add webhook_count increment.

old_subscribe_return = """\
\t\t\t\treturn await withMigrationNotice(json({ subscription_id: subscription.subscription_id, mics, status: 'active', secret }));
\t\t\t}

\t\t\t// ── DELETE /v5/webhooks/unsubscribe — remove a subscription ──────────"""

new_subscribe_return = """\
\t\t\t\t// Increment webhook_count in ORACLE_TELEMETRY for plan-limit tracking
\t\t\t\tconst wkCountKey = `webhook_count:${keyHash}`;
\t\t\t\tconst wkCountRaw = await env.ORACLE_TELEMETRY.get(wkCountKey).catch(() => null);
\t\t\t\tconst wkCount = wkCountRaw ? parseInt(wkCountRaw, 10) : 0;
\t\t\t\tawait env.ORACLE_TELEMETRY.put(wkCountKey, String(wkCount + 1)).catch(() => {});

\t\t\t\treturn await withMigrationNotice(json({
\t\t\t\t\twebhook_id:  subscription.subscription_id,
\t\t\t\t\turl:         subscription.url,
\t\t\t\t\tmics,
\t\t\t\t\tevents:      ['status_change'],
\t\t\t\t\tcreated_at:  subscription.created_at,
\t\t\t\t\tstatus:      'active',
\t\t\t\t\tsecret,
\t\t\t\t}));
\t\t\t}

\t\t\t// ── GET /v5/webhooks — list all webhooks for this API key ────────────
\t\t\tif (url.pathname === '/v5/webhooks' && request.method === 'GET') {
\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\tif (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
\t\t\t\tconst listAuth = await checkApiKey(apiKey, env);
\t\t\t\tif (!listAuth.allowed) return json({ error: listAuth.error, message: listAuth.message }, listAuth.status);
\t\t\t\tconst listKeyHash = listAuth.keyHash ?? await sha256Hex(apiKey);
\t\t\t\tconst subs = await getWebhookSubscriptions(listKeyHash, env);
\t\t\t\tconst result = subs.map((s) => ({
\t\t\t\t\twebhook_id:  s.subscription_id,
\t\t\t\t\turl:         s.url,
\t\t\t\t\tmics:        s.mics,
\t\t\t\t\tevents:      ['status_change'],
\t\t\t\t\tcreated_at:  s.created_at,
\t\t\t\t\tstatus:      'active',
\t\t\t\t}));
\t\t\t\treturn await withMigrationNotice(json({ webhooks: result, count: result.length }));
\t\t\t}

\t\t\t// ── DELETE /v5/webhooks/:webhook_id — delete a specific webhook ───────
\t\t\t{
\t\t\t\tconst webhookDeleteMatch = url.pathname.match(/^\\/v5\\/webhooks\\/([^/]+)$/);
\t\t\t\tif (webhookDeleteMatch && request.method === 'DELETE' && url.pathname !== '/v5/webhooks/unsubscribe') {
\t\t\t\t\tconst webhookId = webhookDeleteMatch[1];
\t\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\t\tif (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
\t\t\t\t\tconst delAuth = await checkApiKey(apiKey, env);
\t\t\t\t\tif (!delAuth.allowed) return json({ error: delAuth.error, message: delAuth.message }, delAuth.status);
\t\t\t\t\tconst delKeyHash = delAuth.keyHash ?? await sha256Hex(apiKey);
\t\t\t\t\tconst delExisting = await getWebhookSubscriptions(delKeyHash, env);
\t\t\t\t\tconst delSub = delExisting.find((s) => s.subscription_id === webhookId);
\t\t\t\t\tif (!delSub) return json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'No webhook with that id found for this key' }, 404);
\t\t\t\t\t// Remove from subscriber record
\t\t\t\t\tconst delUpdated = delExisting.filter((s) => s.subscription_id !== webhookId);
\t\t\t\t\tawait env.ORACLE_API_KEYS.put(`webhooks:${delKeyHash}`, JSON.stringify(delUpdated));
\t\t\t\t\t// Remove from per-MIC fan-out index
\t\t\t\t\tfor (const mic of delSub.mics) {
\t\t\t\t\t\tconst micTargets = await getWebhooksByMic(mic, env);
\t\t\t\t\t\tconst filtered   = micTargets.filter((t) => t.subscription_id !== webhookId);
\t\t\t\t\t\tawait env.ORACLE_API_KEYS.put(`webhooks_by_mic:${mic}`, JSON.stringify(filtered));
\t\t\t\t\t}
\t\t\t\t\t// Decrement webhook_count
\t\t\t\t\tconst wkDelCountKey = `webhook_count:${delKeyHash}`;
\t\t\t\t\tconst wkDelCountRaw = await env.ORACLE_TELEMETRY.get(wkDelCountKey).catch(() => null);
\t\t\t\t\tconst wkDelCount = wkDelCountRaw ? parseInt(wkDelCountRaw, 10) : 0;
\t\t\t\t\tif (wkDelCount > 0) await env.ORACLE_TELEMETRY.put(wkDelCountKey, String(wkDelCount - 1)).catch(() => {});
\t\t\t\t\treturn new Response(null, { status: 204, headers: { 'X-Oracle-Version': 'v5' } });
\t\t\t\t}
\t\t\t}

\t\t\t// ── POST /v5/webhooks/test/:webhook_id — send a synthetic test delivery ─
\t\t\t{
\t\t\t\tconst webhookTestMatch = url.pathname.match(/^\\/v5\\/webhooks\\/test\\/([^/]+)$/);
\t\t\t\tif (webhookTestMatch && request.method === 'POST') {
\t\t\t\t\tconst webhookId = webhookTestMatch[1];
\t\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\t\tif (!apiKey) return json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401);
\t\t\t\t\tconst testAuth = await checkApiKey(apiKey, env);
\t\t\t\t\tif (!testAuth.allowed) return json({ error: testAuth.error, message: testAuth.message }, testAuth.status);
\t\t\t\t\tconst testKeyHash = testAuth.keyHash ?? await sha256Hex(apiKey);
\t\t\t\t\tconst testSubs = await getWebhookSubscriptions(testKeyHash, env);
\t\t\t\t\tconst testSub = testSubs.find((s) => s.subscription_id === webhookId);
\t\t\t\t\tif (!testSub) return json({ error: 'SUBSCRIPTION_NOT_FOUND', message: 'No webhook with that id found for this key' }, 404);
\t\t\t\t\t// Build a synthetic test receipt (using the first MIC in the subscription)
\t\t\t\t\tconst testMic = testSub.mics[0] ?? 'XNYS';
\t\t\t\t\tconst testNow = new Date();
\t\t\t\t\tconst testExpiresAt = new Date(testNow.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
\t\t\t\t\tconst { receipt: testReceipt } = await buildSignedReceipt(testMic, env, testNow, testExpiresAt, 'live');
\t\t\t\t\tconst testPayload = {
\t\t\t\t\t\tevent:           'test',
\t\t\t\t\t\twebhook_id:      testSub.subscription_id,
\t\t\t\t\t\tmic:             testMic,
\t\t\t\t\t\tprevious_status: null,
\t\t\t\t\t\tcurrent_status:  testReceipt['status'],
\t\t\t\t\t\treceipt:         testReceipt,
\t\t\t\t\t\tdelivered_at:    testNow.toISOString(),
\t\t\t\t\t};
\t\t\t\t\tconst testTarget: WebhookDeliveryTarget = {
\t\t\t\t\t\tsubscription_id: testSub.subscription_id,
\t\t\t\t\t\tkey_hash:        testKeyHash,
\t\t\t\t\t\turl:             testSub.url,
\t\t\t\t\t\tsecret:          testSub.secret,
\t\t\t\t\t};
\t\t\t\t\tconst testResult = await deliverWebhook(testTarget, testPayload);
\t\t\t\t\treturn await withMigrationNotice(json({
\t\t\t\t\t\twebhook_id:   webhookId,
\t\t\t\t\t\turl:          testSub.url,
\t\t\t\t\t\tdelivered:    testResult.ok,
\t\t\t\t\t\tstatus:       testResult.status ?? null,
\t\t\t\t\t\terror:        testResult.error ?? null,
\t\t\t\t\t\tpayload_sent: testPayload,
\t\t\t\t\t}));
\t\t\t\t}
\t\t\t}

\t\t\t// ── DELETE /v5/webhooks/unsubscribe — remove a subscription ──────────"""

assert old_subscribe_return in src, f'CHANGE 6 FAILED: subscribe return line not found'
src = src.replace(old_subscribe_return, new_subscribe_return, 1)

# ─── Change 7: Add WebhookDispatcher DO class before end of file ──────────────

old_end = """\
// ─── StreamCoordinator Durable Object ────────────────────────────────────────"""

new_end = """\
// ─── WebhookDispatcher Durable Object ────────────────────────────────────────
// Handles alarm-based state-change detection and webhook fan-out delivery.
// One global instance (keyed by "global") runs an alarm every 60 seconds.
// Reads subscriptions from ORACLE_API_KEYS KV (compatible with REST endpoints).
// Each alarm cycle: compute status for all MICs → compare vs stored last state
// → if changed, fan out signed receipts to all registered subscribers.
//
// Bootstrap: the main worker's cron handler ensures the alarm is scheduled on
// first run. After that the DO self-reschedules its alarm after each cycle.
export class WebhookDispatcher {
\tconstructor(
\t\tprivate readonly state: DurableObjectState,
\t\tprivate readonly env: Env,
\t) {}

\tasync fetch(request: Request): Promise<Response> {
\t\tconst url = new URL(request.url);
\t\tif (url.pathname === '/bootstrap') {
\t\t\t// Ensure the alarm is scheduled. Called by the cron handler to bootstrap.
\t\t\tconst existing = await this.state.storage.getAlarm();
\t\t\tif (existing === null) {
\t\t\t\tawait this.state.storage.setAlarm(Date.now() + 60_000);
\t\t\t}
\t\t\treturn new Response(JSON.stringify({ scheduled: true }), { headers: { 'Content-Type': 'application/json' } });
\t\t}
\t\treturn new Response('not found', { status: 404 });
\t}

\tasync alarm(): Promise<void> {
\t\tconst now = new Date();
\t\tconst deliveries: Promise<unknown>[] = [];

\t\tfor (const [mic] of Object.entries(MARKET_CONFIGS)) {
\t\t\tlet currentStatus: string;
\t\t\ttry {
\t\t\t\tconst result = getScheduleStatus(mic, now);
\t\t\t\t// Check for active KV override
\t\t\t\tconst overrideRaw = await this.env.ORACLE_OVERRIDES.get(mic);
\t\t\t\tif (overrideRaw) {
\t\t\t\t\ttry {
\t\t\t\t\t\tconst ov = JSON.parse(overrideRaw) as { status?: string; expires?: string };
\t\t\t\t\t\tcurrentStatus = (ov.expires && new Date(ov.expires) > now)
\t\t\t\t\t\t\t? (ov.status ?? result.status)
\t\t\t\t\t\t\t: result.status;
\t\t\t\t\t} catch { currentStatus = result.status; }
\t\t\t\t} else {
\t\t\t\t\tcurrentStatus = result.status;
\t\t\t\t}
\t\t\t} catch { continue; }

\t\t\t// Read last known state from DO storage
\t\t\tconst stateKey = `last_state:${mic}`;
\t\t\tconst lastState = await this.state.storage.get<string>(stateKey);

\t\t\t// Always write current state back (establishes baseline on first run)
\t\t\tawait this.state.storage.put(stateKey, currentStatus);

\t\t\tif (lastState === undefined || lastState === currentStatus) continue;

\t\t\t// State changed — build signed receipt and fan out to subscribers
\t\t\tconst targets = await getWebhooksByMic(mic, this.env);
\t\t\tif (targets.length === 0) continue;

\t\t\tconst expiresAt = new Date(now.getTime() + RECEIPT_TTL_SECONDS * 1000).toISOString();
\t\t\tconst { receipt } = await buildSignedReceipt(mic, this.env, now, expiresAt, 'live');

\t\t\tfor (const target of targets) {
\t\t\t\tconst payload = {
\t\t\t\t\tevent:           'status_change',
\t\t\t\t\twebhook_id:      target.subscription_id,
\t\t\t\t\tmic,
\t\t\t\t\tprevious_status: lastState,
\t\t\t\t\tcurrent_status:  currentStatus,
\t\t\t\t\treceipt,
\t\t\t\t\tdelivered_at:    now.toISOString(),
\t\t\t\t};
\t\t\t\tdeliveries.push(deliverWebhook(target, payload));
\t\t\t}

\t\t\tconsole.log(JSON.stringify({
\t\t\t\tevent:            'WEBHOOK_DO_STATE_CHANGE',
\t\t\t\tmic,
\t\t\t\tprevious_status:  lastState,
\t\t\t\tcurrent_status:   currentStatus,
\t\t\t\tsubscriber_count: targets.length,
\t\t\t\ttimestamp:        now.toISOString(),
\t\t\t}));
\t\t}

\t\tawait Promise.allSettled(deliveries);

\t\t// Reschedule for 60 seconds from now
\t\tawait this.state.storage.setAlarm(Date.now() + 60_000);
\t}
}

// ─── StreamCoordinator Durable Object ────────────────────────────────────────"""

assert old_end in src, 'CHANGE 7 FAILED: StreamCoordinator class header not found'
src = src.replace(old_end, new_end, 1)

# ─── Write updated src/index.ts ───────────────────────────────────────────────

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(src)

print('src/index.ts updated successfully')

# ─── Update wrangler.toml ─────────────────────────────────────────────────────

old_toml_do = """\
[[durable_objects.bindings]]
name = "STREAM_COORDINATOR"
class_name = "StreamCoordinator"

# Migration required to create the DO class on first deploy.
[[migrations]]
tag = "v1"
new_classes = ["StreamCoordinator"]"""

new_toml_do = """\
[[durable_objects.bindings]]
name = "STREAM_COORDINATOR"
class_name = "StreamCoordinator"

[[durable_objects.bindings]]
name = "WEBHOOK_DISPATCHER"
class_name = "WebhookDispatcher"

# Migration required to create the DO class on first deploy.
[[migrations]]
tag = "v1"
new_classes = ["StreamCoordinator"]

[[migrations]]
tag = "v2"
new_classes = ["WebhookDispatcher"]"""

assert old_toml_do in toml, 'TOML CHANGE FAILED: DO bindings block not found'
toml = toml.replace(old_toml_do, new_toml_do, 1)

with open('wrangler.toml', 'w', encoding='utf-8') as f:
    f.write(toml)

print('wrangler.toml updated successfully')
print('All changes applied.')
