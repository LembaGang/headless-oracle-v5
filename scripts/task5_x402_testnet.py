#!/usr/bin/env python3
"""Task 5: Add x402 facilitator-based testnet prototype."""

import sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

with open('src/index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

def replace_once(old, new, label):
    global content, changes
    if old in content:
        content = content.replace(old, new, 1)
        print(f'OK  {label}')
        changes += 1
    else:
        print(f'ERR {label} \u2014 NOT FOUND')

# 1. Add X402_ENABLED and X402_TEST_WALLET to Env interface
replace_once(
    "\t// x402 micropayments \u2014 set via `wrangler secret put ORACLE_PAYMENT_ADDRESS`\n"
    "\tORACLE_PAYMENT_ADDRESS?:     string;  // Base mainnet wallet for USDC micropayments",

    "\t// x402 micropayments \u2014 set via `wrangler secret put ORACLE_PAYMENT_ADDRESS`\n"
    "\tORACLE_PAYMENT_ADDRESS?:     string;  // Base mainnet wallet for USDC micropayments\n"
    "\t// x402 testnet prototype \u2014 Base Sepolia testnet, facilitator-based verification\n"
    "\tX402_ENABLED?:               string;  // Set to 'true' to enable testnet x402 via facilitator (default: off)\n"
    "\tX402_TEST_WALLET?:           string;  // Base Sepolia test wallet address for testnet payments",

    'Env interface x402 testnet vars'
)

# 2. Add testnet constants after X402_USDC_CONTRACT
replace_once(
    "// USDC ERC-20 contract on Base mainnet (chain ID 8453).\n"
    "const X402_USDC_CONTRACT    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';\n"
    "// 0.001 USDC = 1000 units at 6 decimals. Minimum payment per request.\n"
    "const X402_MIN_AMOUNT_UNITS     = BigInt(1000);",

    "// USDC ERC-20 contract on Base mainnet (chain ID 8453).\n"
    "const X402_USDC_CONTRACT    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';\n"
    "// USDC ERC-20 contract on Base Sepolia testnet (chain ID 84532).\n"
    "const X402_SEPOLIA_USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';\n"
    "// x402 facilitator endpoint \u2014 Coinbase-hosted, verifies payments for both mainnet and testnet.\n"
    "const X402_FACILITATOR_URL = 'https://x402.org/facilitator';\n"
    "// 0.001 USDC = 1000 units at 6 decimals. Minimum payment per request.\n"
    "const X402_MIN_AMOUNT_UNITS     = BigInt(1000);",

    'testnet constants'
)

# 3. Add verifyX402ViaFacilitator function after verifyX402Payment
# Find the end of verifyX402Payment function (just before verifyX402MintPayment comment)
replace_once(
    "// Verifies a USDC payment for key minting on Base mainnet.\n"
    "// Separate from verifyX402Payment: uses a different replay namespace (x402_used_tx:),",

    "// Verifies a testnet x402 payment via the official Coinbase facilitator (https://x402.org/facilitator).\n"
    "// Used when X402_ENABLED=true. Posts the raw X-Payment header to the facilitator's /settle endpoint.\n"
    "// Does NOT perform direct on-chain RPC calls \u2014 the facilitator handles EVM verification.\n"
    "async function verifyX402ViaFacilitator(\n"
    "\tpaymentHeader: string,\n"
    "\ttestWallet: string,\n"
    "): Promise<{ valid: boolean; txHash?: string; detail?: string }> {\n"
    "\tconst paymentRequirements = [{\n"
    "\t\tscheme:            'exact',\n"
    "\t\tnetwork:           'eip155:84532',  // Base Sepolia testnet\n"
    "\t\tmaxAmountRequired: '1000',          // 0.001 USDC at 6 decimals\n"
    "\t\tasset:             X402_SEPOLIA_USDC_CONTRACT,\n"
    "\t\tpayTo:             testWallet,\n"
    "\t\tmaxTimeoutSeconds: 300,\n"
    "\t}];\n"
    "\ttry {\n"
    "\t\tconst res = await fetch(`${X402_FACILITATOR_URL}/settle`, {\n"
    "\t\t\tmethod:  'POST',\n"
    "\t\t\theaders: { 'Content-Type': 'application/json' },\n"
    "\t\t\tbody:    JSON.stringify({ x402Version: 1, payment: paymentHeader, paymentRequirements }),\n"
    "\t\t});\n"
    "\t\tif (!res.ok) {\n"
    "\t\t\treturn { valid: false, detail: `FACILITATOR_HTTP_ERROR: ${res.status}` };\n"
    "\t\t}\n"
    "\t\tconst data = await res.json() as { success?: boolean; error?: string; txHash?: string };\n"
    "\t\tif (!data.success) {\n"
    "\t\t\treturn { valid: false, detail: `FACILITATOR_REJECTED: ${data.error ?? 'unknown'}` };\n"
    "\t\t}\n"
    "\t\tconsole.log(JSON.stringify({ event: 'X402_TESTNET_PAYMENT_VERIFIED', tx_hash: data.txHash ?? 'n/a' }));\n"
    "\t\treturn { valid: true, txHash: data.txHash };\n"
    "\t} catch (err) {\n"
    "\t\treturn { valid: false, detail: `FACILITATOR_FETCH_FAILED: ${err instanceof Error ? err.message : 'unknown'}` };\n"
    "\t}\n"
    "}\n"
    "\n"
    "// Build x402scan-compatible 402 payload for Base Sepolia testnet.\n"
    "function buildTestnetX402Payload(testWallet: string, resourceUrl: string): Record<string, unknown> {\n"
    "\treturn {\n"
    "\t\tx402Version: 1,\n"
    "\t\taccepts: [{\n"
    "\t\t\tscheme:            'exact',\n"
    "\t\t\tnetwork:           'eip155:84532',\n"
    "\t\t\tmaxAmountRequired: '1000',\n"
    "\t\t\tasset:             X402_SEPOLIA_USDC_CONTRACT,\n"
    "\t\t\tpayTo:             testWallet,\n"
    "\t\t\tmaxTimeoutSeconds: 300,\n"
    "\t\t\tresource:          resourceUrl,\n"
    "\t\t\tdescription:       'Signed market-state receipt (TESTNET). Ed25519 signed, 60s TTL. $0.001 USDC on Base Sepolia.',\n"
    "\t\t\tmimeType:          'application/json',\n"
    "\t\t}],\n"
    "\t\terror:   'Payment Required',\n"
    "\t\tnetwork: 'testnet',\n"
    "\t};\n"
    "}\n"
    "\n"
    "// Verifies a USDC payment for key minting on Base mainnet.\n"
    "// Separate from verifyX402Payment: uses a different replay namespace (x402_used_tx:),",

    'verifyX402ViaFacilitator + buildTestnetX402Payload functions'
)

# 4. Inject testnet x402 path into "No API key" section
# We need to intercept the "No API key" path BEFORE the existing mainnet path
replace_once(
    "\t\t\t} else {\n"
    "\t\t\t\t// No API key \u2014 x402 payment path (step 4) or 402 gate (step 5)\n"
    "\t\t\t\tconst paymentHeader = request.headers.get('X-Payment');\n"
    "\t\t\t\tif (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {\n"
    "\t\t\t\t\t// Keyless x402: verify on-chain payment, then serve receipt\n"
    "\t\t\t\t\tlet payment: X402Payment;\n"
    "\t\t\t\t\ttry { payment = JSON.parse(paymentHeader) as X402Payment; } catch {\n"
    "\t\t\t\t\t\treturn json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tconst verified = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);\n"
    "\t\t\t\t\tif (!verified.valid) {\n"
    "\t\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;\n"
    "\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status') });\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\t// Valid keyless x402 payment \u2014 fall through to serve receipt (no rate limit applied)\n"
    "\t\t\t\t} else if (env.ORACLE_PAYMENT_ADDRESS) {\n"
    "\t\t\t\t\t// No key, no payment \u2014 return x402scan-compatible 402 so crawlers can register this endpoint\n"
    "\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;\n"
    "\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status') });\n"
    "\t\t\t\t} else {\n"
    "\t\t\t\t\t// ORACLE_PAYMENT_ADDRESS not configured \u2014 fall back to 401 (dev/test environments)\n"
    "\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });\n"
    "\t\t\t\t}\n"
    "\t\t\t}",

    "\t\t\t} else {\n"
    "\t\t\t\t// No API key \u2014 x402 payment path (step 4) or 402 gate (step 5)\n"
    "\t\t\t\tconst paymentHeader = request.headers.get('X-Payment');\n"
    "\t\t\t\t// ── Testnet x402 facilitator path (X402_ENABLED=true gating) ─────────\n"
    "\t\t\t\t// When enabled, accepts Base Sepolia USDC payments via official x402 facilitator.\n"
    "\t\t\t\t// Gated behind X402_ENABLED to avoid affecting production traffic.\n"
    "\t\t\t\tif (env.X402_ENABLED === 'true' && env.X402_TEST_WALLET) {\n"
    "\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;\n"
    "\t\t\t\t\tif (paymentHeader) {\n"
    "\t\t\t\t\t\tconst verified = await verifyX402ViaFacilitator(paymentHeader, env.X402_TEST_WALLET);\n"
    "\t\t\t\t\t\tif (!verified.valid) {\n"
    "\t\t\t\t\t\t\treturn json(buildTestnetX402Payload(env.X402_TEST_WALLET, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-X402-Network': 'testnet', 'X-Payment-Required': 'true' });\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t// Valid testnet payment \u2014 fall through to serve receipt\n"
    "\t\t\t\t\t} else {\n"
    "\t\t\t\t\t\t// No payment \u2014 return testnet 402 with facilitator payment requirements\n"
    "\t\t\t\t\t\treturn json(buildTestnetX402Payload(env.X402_TEST_WALLET, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-X402-Network': 'testnet', 'X-Payment-Required': 'true' });\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t} else if (paymentHeader && env.ORACLE_PAYMENT_ADDRESS) {\n"
    "\t\t\t\t\t// Keyless x402: verify on-chain payment, then serve receipt\n"
    "\t\t\t\t\tlet payment: X402Payment;\n"
    "\t\t\t\t\ttry { payment = JSON.parse(paymentHeader) as X402Payment; } catch {\n"
    "\t\t\t\t\t\treturn json({ error: 'INVALID_PAYMENT', message: 'X-Payment must be valid JSON' }, 402, X402_RESPONSE_HEADERS);\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tconst verified = await verifyX402Payment(payment, env.ORACLE_PAYMENT_ADDRESS, env);\n"
    "\t\t\t\t\tif (!verified.valid) {\n"
    "\t\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;\n"
    "\t\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status') });\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\t// Valid keyless x402 payment \u2014 fall through to serve receipt (no rate limit applied)\n"
    "\t\t\t\t} else if (env.ORACLE_PAYMENT_ADDRESS) {\n"
    "\t\t\t\t\t// No key, no payment \u2014 return x402scan-compatible 402 so crawlers can register this endpoint\n"
    "\t\t\t\t\tconst resource = `https://headlessoracle.com${url.pathname}${url.search}`;\n"
    "\t\t\t\t\treturn json(buildX402ScanPayload(env.ORACLE_PAYMENT_ADDRESS, resource), 402, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...buildX402IndexHeaders(env.ORACLE_PAYMENT_ADDRESS, 'status') });\n"
    "\t\t\t\t} else {\n"
    "\t\t\t\t\t// ORACLE_PAYMENT_ADDRESS not configured \u2014 fall back to 401 (dev/test environments)\n"
    "\t\t\t\t\treturn json({ error: 'API_KEY_REQUIRED', message: 'Include X-Oracle-Key header' }, 401, { 'X-Oracle-Upgrade': 'https://headlessoracle.com/upgrade', 'X-Oracle-Key-Request': 'https://headlessoracle.com/v5/keys/request' });\n"
    "\t\t\t\t}\n"
    "\t\t\t}",

    'inject testnet x402 path into no-API-key section'
)

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n{changes}/4 changes applied.')
sys.exit(0 if changes == 4 else 1)
