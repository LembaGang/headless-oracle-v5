import re

filepath = 'C:/Users/User/headless-oracle-v5/src/index.ts'
content = open(filepath, encoding='utf-8').read()

# ── Step 1: Add buildX402ScanPayload() after build402Payload() ────────────────
# Insert the new function right after the closing brace of build402Payload

old_build402_end = """\tfounder_note: "You're hitting our limits \u2014 that means you're building something real. Reply to hello@headlessoracle.com and I'll set you up with a proper production key. \u2014 Mike",
\t};
}"""

new_build402_end = """\tfounder_note: "You're hitting our limits \u2014 that means you're building something real. Reply to hello@headlessoracle.com and I'll set you up with a proper production key. \u2014 Mike",
\t};
}

// Build an x402scan-compatible 402 payload.
// Format matches the x402 standard (https://x402.org): x402Version, accepts[], error.
// Used when a request arrives with no API key — makes the endpoint x402-native.
function buildX402ScanPayload(paymentAddress: string, resourceUrl: string): Record<string, unknown> {
\treturn {
\t\tx402Version: 1,
\t\taccepts: [
\t\t\t{
\t\t\t\tscheme:             'exact',
\t\t\t\tnetwork:            'eip155:8453',
\t\t\t\tmaxAmountRequired:  '1000',
\t\t\t\tresource:           resourceUrl,
\t\t\t\tdescription:        'Signed market-state receipt for one exchange. OPEN/CLOSED/HALTED/UNKNOWN \u2014 Ed25519 signed, 60s TTL.',
\t\t\t\tmimeType:           'application/json',
\t\t\t\tpayTo:              paymentAddress,
\t\t\t\tmaxTimeoutSeconds:  60,
\t\t\t\tasset:              X402_USDC_CONTRACT,
\t\t\t\textra: {
\t\t\t\t\tname:    'Headless Oracle',
\t\t\t\t\tversion: 'v5.0',
\t\t\t\t},
\t\t\t},
\t\t],
\t\terror: 'X-Payment-Required',
\t};
}"""

if old_build402_end not in content:
    print("ERROR: build402Payload closing not found")
    # Try to find approximate location
    idx = content.find('founder_note:')
    print(f"founder_note at char {idx}")
    print(repr(content[idx:idx+200]))
    exit(1)

content = content.replace(old_build402_end, new_build402_end, 1)
print("Step 1: buildX402ScanPayload() added")

# ── Step 2: Restructure /v5/status auth gate ──────────────────────────────────

old_status_gate = """\t\t\t// \u2500\u2500 Auth gate \u2014 /v5/status requires X-Oracle-Key \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
\t\t\tif (url.pathname.startsWith('/v5/status')) {
\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\tif (!apiKey) {
\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
\t\t\t\t}
\t\t\t\tconst auth = await checkApiKey(apiKey, env);\t\t\t\tif (!auth.allowed) {
\t\t\t\t\tconst authHeaders = auth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
\t\t\t\t\treturn json({ error: auth.error, message: auth.message }, auth.status, authHeaders);
\t\t\t\t}"""

# Let me find the exact text using a search
idx_gate = content.find("\t\t\t// \u2500\u2500 Auth gate \u2014 /v5/status requires X-Oracle-Key")
if idx_gate == -1:
    print("ERROR: auth gate comment not found")
    # Try alternate search
    idx_gate = content.find("Auth gate \u2014 /v5/status")
    print(f"Auth gate at {idx_gate}")
    exit(1)

print(f"Auth gate found at char {idx_gate}")

# Find the end of the if (url.pathname.startsWith('/v5/status')) block
# It ends at the lone closing } on its own line (the one closing the if block)
# Let me find it by counting braces from the if statement

# Find the "if (url.pathname.startsWith('/v5/status')) {" opening
open_brace_idx = content.find("if (url.pathname.startsWith('/v5/status')) {", idx_gate)
print(f"if block opens at char {open_brace_idx}")

# Find the closing } of the if block by counting braces
depth = 0
scan_start = open_brace_idx
in_block = False
close_idx = None
for i in range(scan_start, len(content)):
    c = content[i]
    if c == '{':
        depth += 1
        in_block = True
    elif c == '}':
        depth -= 1
        if in_block and depth == 0:
            close_idx = i
            break

print(f"if block closes at char {close_idx}: {repr(content[close_idx-5:close_idx+5])}")

# Extract the full old block
old_block = content[idx_gate:close_idx+1]
print(f"Old block length: {len(old_block)} chars")
print("First 200 chars:", repr(old_block[:200]))

# Now build the replacement
new_status_gate = """\t\t\t// \u2500\u2500 Auth gate \u2014 /v5/status requires X-Oracle-Key or x402 payment \u2500\u2500\u2500\u2500\u2500
\t\t\tif (url.pathname.startsWith('/v5/status')) {
\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\tif (apiKey) {
\t\t\t\t\t// Key-based auth path (steps 1\u20133): MASTER \u2192 BETA \u2192 Supabase lookup
\t\t\t\t\tconst auth = await checkApiKey(apiKey, env);
\t\t\t\t\tif (!auth.allowed) {
\t\t\t\t\t\tconst authHeaders = auth.status === 402 ? { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Plans': 'free=https://headlessoracle.com/v5/keys/request,builder=99,pro=299,protocol=500' } : {};
\t\t\t\t\t\treturn json({ error: auth.error, message: auth.message }, auth.status, authHeaders);
\t\t\t\t\t}
\t\t\t\t\t// Update last_used_at for keys tracked in Supabase (non-blocking, best-effort).
\t\t\t\t\tif (auth.keyHash && typeof ctx?.waitUntil === 'function') {
\t\t\t\t\t\tctx.waitUntil(updateKeyUsage(auth.keyHash, env).catch(() => {}));
\t\t\t\t\t}
\t\t\t\t\t// \u2500\u2500 Free tier daily limit + x402 micropayment gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
\t\t\t\t\tif (auth.plan === 'free') {
\t\t\t\t\t\t// Reuse keyHash from auth result \u2014 avoids a redundant sha256 on the hot path.
\t\t\t\t\t\tconst keyHash = auth.keyHash ?? await sha256Hex(apiKey);
\t\t\t\t\t\tconst usage   = await getDailyUsage(keyHash, env);

\t\t\t\t\t\t// Track percent used for soft-limit warning headers on the response.
\t\t\t\t\t\tfreeTierPercentUsed = Math.round((usage / FREE_TIER_DAILY_LIMIT) * 1000) / 10;

\t\t\t\t\t\t// Design partner detection: log once per key per day when usage > 200
\t\t\t\t\t\tif (usage > 200) {
\t\t\t\t\t\t\tconst dpKey    = `design_partner:${keyHash}:${new Date().toISOString().slice(0, 10)}`;
\t\t\t\t\t\t\tconst dpExists = await env.ORACLE_TELEMETRY.get(dpKey).catch(() => null);
\t\t\t\t\t\t\tif (dpExists === null) {
\t\t\t\t\t\t\t\tconst putDp = env.ORACLE_TELEMETRY.put(dpKey, '1', { expirationTtl: 25 * 3600 }).catch(() => {});
\t\t\t\t\t\t\t\tif (typeof ctx?.waitUntil === 'function') ctx.waitUntil(putDp);
\t\t\t\t\t\t\t\tconsole.log(JSON.stringify({
\t\t\t\t\t\t\t\t\tevent:          'DESIGN_PARTNER_CANDIDATE',
\t\t\t\t\t\t\t\t\tkey_hash:       keyHash,
\t\t\t\t\t\t\t\t\trequests_today: usage,
\t\t\t\t\t\t\t\t\tplan:           'free',
\t\t\t\t\t\t\t\t\ttimestamp:      new Date().toISOString(),
\t\t\t\t\t\t\t\t\tnote:           'High-volume free tier user \u2014 potential design partner',
\t\t\t\t\t\t\t\t}));
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}

\t\t\t\t\t\tif (usage >= FREE_TIER_DAILY_LIMIT) {
\t\t\t\t\t\t\tconst paymentHeader = request.headers.get('X-Payment');
\t\t\t\t\t\t\tif (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\t\t\tlet payment: X402Payment;
\t\t\t\t\t\t\t\ttry { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
\t\t\t\t\t\t\t\t\treturn json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\tconst verify = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
\t\t\t\t\t\t\t\tif (!verify.valid) {
\t\t\t\t\t\t\t\t\treturn json({
\t\t\t\t\t\t\t\t\t\terror:   'PAYMENT_VERIFICATION_FAILED',
\t\t\t\t\t\t\t\t\t\tmessage: `Payment verification failed: ${verify.detail ?? 'unknown'}`,
\t\t\t\t\t\t\t\t\t\tx402:    build402Payload(env.ORACLE_PAYMENT_ADDRESS, keyHash).x402,
\t\t\t\t\t\t\t\t\t}, 402, X402_RESPONSE_HEADERS);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t// Valid x402 payment \u2014 proceed without counting against daily usage
\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\tconst credits = await getCreditBalance(keyHash, env);
\t\t\t\t\t\t\t\tif (credits.balance > 0) {
\t\t\t\t\t\t\t\t\tconsumeCredit(keyHash, credits, env, ctx);
\t\t\t\t\t\t\t\t} else if (env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\t\t\t\treturn json(build402Payload(env.ORACLE_PAYMENT_ADDRESS, keyHash), 402, X402_RESPONSE_HEADERS);
\t\t\t\t\t\t\t\t} else {
\t\t\t\t\t\t\t\t\treturn json({ error: 'RATE_LIMITED', message: 'Free tier daily limit reached. Upgrade at headlessoracle.com/pricing' }, 429);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tincrementDailyUsage(keyHash, env, ctx, usage);
\t\t\t\t\t\t}
\t\t\t\t\t// \u2500\u2500 Paid tier daily limits (builder: 50k/day, pro: 200k/day) \u2500\u2500
\t\t\t\t\t} else if (auth.plan === 'builder' || auth.plan === 'pro') {
\t\t\t\t\t\tconst paidKeyHash = auth.keyHash ?? await sha256Hex(apiKey);
\t\t\t\t\t\tconst paidUsage   = await getDailyUsage(paidKeyHash, env);
\t\t\t\t\t\tconst paidLimit   = getPlanDailyLimit(auth.plan)!;
\t\t\t\t\t\tif (paidUsage >= paidLimit) {
\t\t\t\t\t\t\treturn json({ error: 'RATE_LIMITED', message: `${auth.plan} plan daily limit (${paidLimit.toLocaleString()} req/day) reached. Upgrade at headlessoracle.com/pricing` }, 429);
\t\t\t\t\t\t}
\t\t\t\t\t\tincrementDailyUsage(paidKeyHash, env, ctx, paidUsage);
\t\t\t\t\t}
\t\t\t\t} else {
\t\t\t\t\t// No API key \u2014 x402 payment path (step 4) or 402 gate (step 5)
\t\t\t\t\tconst paymentHeader = request.headers.get('X-Payment');
\t\t\t\t\tif (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\t// Keyless x402: verify on-chain payment, then serve receipt
\t\t\t\t\t\tlet payment: X402Payment;
\t\t\t\t\t\ttry { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
\t\t\t\t\t\t\treturn json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
\t\t\t\t\t\t}
\t\t\t\t\t\tconst verified = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
\t\t\t\t\t\tif (!verified.valid) {
\t\t\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;
\t\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
\t\t\t\t\t\t}
\t\t\t\t\t\t// Valid keyless x402 payment \u2014 fall through to serve receipt (no rate limit applied)
\t\t\t\t\t} else if (env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\t// No key, no payment \u2014 return x402scan-compatible 402 so crawlers can register this endpoint
\t\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;
\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
\t\t\t\t\t} else {
\t\t\t\t\t\t// ORACLE_PAYMENT_ADDRESS not configured \u2014 fall back to 401 (dev/test environments)
\t\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}"""

content = content[:idx_gate] + new_status_gate + content[close_idx+1:]
print(f"Step 2: /v5/status auth gate restructured")

open(filepath, 'w', encoding='utf-8').write(content)
# Reload
content = open(filepath, encoding='utf-8').read()

# ── Step 3: Restructure /v5/batch auth gate ───────────────────────────────────
idx_batch = content.find("\t\t\t// \u2500\u2500 GET /v5/batch \u2014 authenticated batch receipt query")
if idx_batch == -1:
    print("ERROR: batch gate comment not found")
    exit(1)
print(f"Batch gate found at char {idx_batch}")

# Find the "if (url.pathname === '/v5/batch') {" block
batch_if_idx = content.find("if (url.pathname === '/v5/batch') {", idx_batch)
print(f"Batch if block at char {batch_if_idx}")

# Find old apiKey guard inside batch block
old_batch_keycheck = """\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\tif (!apiKey) {
\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
\t\t\t\t}
\t\t\t\tconst batchAuth = await checkApiKey(apiKey, env);\t\t\t\tif (!batchAuth.allowed) {"""

new_batch_keycheck = """\t\t\t\tconst apiKey = request.headers.get('X-Oracle-Key');
\t\t\t\tif (!apiKey) {
\t\t\t\t\t// No key \u2014 check x402 payment or return x402scan-compatible 402
\t\t\t\t\tconst paymentHeader = request.headers.get('X-Payment');
\t\t\t\t\tif (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\tlet payment: X402Payment;
\t\t\t\t\t\ttry { payment = JSON.parse(paymentHeader) as X402Payment; } catch {
\t\t\t\t\t\t\treturn json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);
\t\t\t\t\t\t}
\t\t\t\t\t\tconst verified = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);
\t\t\t\t\t\tif (!verified.valid) {
\t\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, 'https://headlessoracle.com/v5/batch'), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
\t\t\t\t\t\t}
\t\t\t\t\t\t// Valid keyless x402 payment \u2014 fall through to serve batch (mics from query param, no plan-based rate limit)
\t\t\t\t\t} else if (env.ORACLE_PAYMENT_ADDRESS) {
\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, 'https://headlessoracle.com/v5/batch'), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
\t\t\t\t\t} else {
\t\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/pricing', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tconst batchAuth = await checkApiKey(apiKey, env);
\t\t\t\tif (!batchAuth.allowed) {"""

if old_batch_keycheck not in content:
    print("ERROR: batch key check not found, trying alternate search")
    idx_tmp = content.find("const batchAuth = await checkApiKey(apiKey, env);")
    print(f"batchAuth at {idx_tmp}")
    print(repr(content[idx_tmp-400:idx_tmp+50]))
    exit(1)

content = content.replace(old_batch_keycheck, new_batch_keycheck, 1)
print("Step 3: /v5/batch auth gate updated")

open(filepath, 'w', encoding='utf-8').write(content)
print("Done. File written.")

# Sanity check
content = open(filepath, encoding='utf-8').read()
assert 'buildX402ScanPayload' in content, "buildX402ScanPayload not in file"
assert 'x402Version: 1' in content, "x402Version not in file"
assert 'eip155:8453' in content, "eip155:8453 not in file"
print(f"Sanity checks passed. buildX402ScanPayload count: {content.count('buildX402ScanPayload')}")
