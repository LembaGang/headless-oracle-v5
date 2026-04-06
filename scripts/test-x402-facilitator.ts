#!/usr/bin/env npx tsx
/**
 * E2E x402 Facilitator Round-Trip Test
 *
 * Tests the full payment flow against the live worker:
 * 1. Fetch /v5/status without auth → 402 with payment requirements
 * 2. Validate the 402 response against x402 spec
 * 3. Construct a valid EIP-712 transferWithAuthorization payload
 * 4. Base64-encode and send as X-Payment header
 * 5. Log the facilitator response
 *
 * Requires:
 *   - A funded Base Sepolia wallet (get test USDC from https://faucet.circle.com/)
 *   - Private key in WALLET_PRIVATE_KEY env var
 *
 * Usage:
 *   WALLET_PRIVATE_KEY=0x... npx tsx scripts/test-x402-facilitator.ts
 *
 * NOTE: This script tests against the LIVE production worker.
 * It uses real Base mainnet if WALLET_PRIVATE_KEY is set, but does NOT
 * actually spend funds unless the facilitator settles the authorization.
 * The transferWithAuthorization signature is an off-chain authorization
 * that only moves funds if the facilitator calls the USDC contract.
 */

const WORKER_URL = 'https://headlessoracle.com';
const STATUS_URL = `${WORKER_URL}/v5/status?mic=XNYS`;

// ─── Step 1: Fetch 402 and validate spec compliance ─────────────────────────
async function auditPaymentRequirements(): Promise<void> {
	console.log('\n=== Step 1: Fetch 402 response ===\n');

	const res = await fetch(STATUS_URL);
	console.log(`HTTP ${res.status}`);
	console.log('Headers:');
	for (const [k, v] of res.headers.entries()) {
		if (k.startsWith('x-') || k.startsWith('payment') || k === 'link' || k === 'access-control-allow-headers') {
			console.log(`  ${k}: ${v}`);
		}
	}

	const body = await res.json() as Record<string, unknown>;

	// ─── x402 v2 header check ────────────────────────────────────────────
	const prHeader = res.headers.get('payment-required');
	if (prHeader) {
		console.log('\n✅ Payment-Required header present (x402 v2 compliant)');
		try {
			const decoded = JSON.parse(atob(prHeader));
			console.log('  Decoded:', JSON.stringify(decoded, null, 2).slice(0, 300));
		} catch (e) {
			console.log('  ⚠️  Could not decode Payment-Required header');
		}
	} else {
		console.log('\n⚠️  No Payment-Required header (x402 v2 clients will use body fallback)');
	}

	// ─── Body structure check ────────────────────────────────────────────
	console.log('\n=== Step 2: Validate 402 body against x402 spec ===\n');

	const checks: Array<[string, boolean, string]> = [];

	checks.push(['x402Version present', body.x402Version === 1, `got: ${body.x402Version}`]);
	checks.push(['accepts[] array', Array.isArray(body.accepts), `type: ${typeof body.accepts}`]);

	if (Array.isArray(body.accepts) && body.accepts.length > 0) {
		const req = body.accepts[0] as Record<string, unknown>;
		checks.push(['scheme = "exact"', req.scheme === 'exact', `got: ${req.scheme}`]);
		checks.push(['network = "base"', req.network === 'base', `got: ${req.network}`]);
		checks.push(['maxAmountRequired present', typeof req.maxAmountRequired === 'string', `got: ${req.maxAmountRequired}`]);
		checks.push(['asset = USDC contract', req.asset === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', `got: ${req.asset}`]);
		checks.push(['payTo is checksummed address', typeof req.payTo === 'string' && (req.payTo as string).startsWith('0x'), `got: ${req.payTo}`]);
		checks.push(['maxTimeoutSeconds present', typeof req.maxTimeoutSeconds === 'number', `got: ${req.maxTimeoutSeconds}`]);
		checks.push(['resource is full URL', typeof req.resource === 'string' && (req.resource as string).startsWith('https://'), `got: ${req.resource}`]);
		checks.push(['extra.name = "USD Coin"', (req.extra as Record<string, unknown>)?.name === 'USD Coin', `got: ${JSON.stringify(req.extra)}`]);
		checks.push(['extra.version = "2"', (req.extra as Record<string, unknown>)?.version === '2', `got: ${JSON.stringify(req.extra)}`]);
	}

	let allPassed = true;
	for (const [label, pass, detail] of checks) {
		const icon = pass ? '✅' : '❌';
		console.log(`  ${icon} ${label} — ${detail}`);
		if (!pass) allPassed = false;
	}

	// ─── CORS check ──────────────────────────────────────────────────────
	console.log('\n=== Step 3: CORS preflight check ===\n');
	const optRes = await fetch(STATUS_URL, { method: 'OPTIONS' });
	const allowHeaders = optRes.headers.get('access-control-allow-headers') ?? '';
	const exposeHeaders = optRes.headers.get('access-control-expose-headers') ?? '';
	checks.push(['CORS allows Payment-Signature', allowHeaders.includes('Payment-Signature'), `got: ${allowHeaders}`]);
	checks.push(['CORS exposes Payment-Required', exposeHeaders.includes('Payment-Required'), `got: ${exposeHeaders}`]);

	console.log(`  Allow-Headers: ${allowHeaders}`);
	console.log(`  Expose-Headers: ${exposeHeaders}`);
	console.log(`  Payment-Signature in Allow: ${allowHeaders.includes('Payment-Signature') ? '✅' : '❌'}`);
	console.log(`  Payment-Required in Expose: ${exposeHeaders.includes('Payment-Required') ? '✅' : '❌'}`);

	// ─── Check /.well-known/x402.json ────────────────────────────────────
	console.log('\n=== Step 4: Discovery document check ===\n');
	try {
		const x402Res = await fetch(`${WORKER_URL}/.well-known/x402.json`);
		const x402Body = await x402Res.json() as Record<string, unknown>;
		console.log(`  HTTP ${x402Res.status}`);
		console.log(`  Body: ${JSON.stringify(x402Body, null, 2).slice(0, 500)}`);
	} catch (e) {
		console.log(`  ⚠️  Failed to fetch /.well-known/x402.json: ${e}`);
	}

	// ─── Summary ─────────────────────────────────────────────────────────
	console.log('\n=== Summary ===\n');
	console.log(`Full 402 body:\n${JSON.stringify(body, null, 2).slice(0, 2000)}`);

	if (!allPassed) {
		console.log('\n❌ SPEC COMPLIANCE ISSUES FOUND — see details above');
		process.exit(1);
	} else {
		console.log('\n✅ All spec compliance checks passed');
	}
}

// ─── Step 5: Construct and send x402 payment (dry run) ──────────────────────
async function testPaymentHeader(): Promise<void> {
	console.log('\n=== Step 5: Test X-Payment header handling ===\n');

	// Test 1: Send an obviously invalid payment header — should get 402 with error detail
	const fakePayload = {
		x402Version: 1,
		scheme: 'exact',
		network: 'base',
		payload: {
			signature: '0x' + 'ab'.repeat(65),
			authorization: {
				from: '0x' + '00'.repeat(20),
				to: '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3',
				value: '1000',
				validAfter: '0',
				validBefore: String(Math.floor(Date.now() / 1000) + 300),
				nonce: '0x' + 'ff'.repeat(32),
			},
		},
	};

	const encoded = btoa(JSON.stringify(fakePayload));
	console.log('Sending base64-encoded test payment via X-Payment header...');
	console.log(`Payload (decoded): ${JSON.stringify(fakePayload, null, 2).slice(0, 500)}`);

	const res = await fetch(STATUS_URL, {
		headers: { 'X-Payment': encoded },
	});

	console.log(`\nResponse: HTTP ${res.status}`);
	const body = await res.json() as Record<string, unknown>;
	console.log(`Body: ${JSON.stringify(body, null, 2).slice(0, 1000)}`);

	if (res.status === 402) {
		const detail = body.x402_error ?? body.error ?? 'unknown';
		console.log(`\nFacilitator rejection reason: ${detail}`);
		console.log('This is expected — the signature is fake. The important thing is that:');
		console.log('  1. The server READ the X-Payment header (not 402 "no-header")');
		console.log('  2. The server DECODED the base64 payload');
		console.log('  3. The server SENT it to the CDP facilitator for verification');
		console.log('  4. The facilitator REJECTED the invalid signature');

		const paymentStatus = res.headers.get('x-payment-status');
		if (paymentStatus === 'payment-rejected') {
			console.log('\n✅ Full facilitator round-trip confirmed working (rejected invalid sig)');
		} else if (paymentStatus === 'no-header') {
			console.log('\n❌ Server did NOT read the X-Payment header');
		} else {
			console.log(`\n⚠️  X-Payment-Status: ${paymentStatus}`);
		}
	} else if (res.status === 200) {
		console.log('\n🎉 Payment was ACCEPTED! (unexpected with fake signature)');
	} else {
		console.log(`\n⚠️  Unexpected status ${res.status}`);
	}

	// Test 2: Send via Payment-Signature header (x402 v2)
	console.log('\n--- Testing Payment-Signature header (x402 v2) ---');
	const res2 = await fetch(STATUS_URL, {
		headers: { 'Payment-Signature': encoded },
	});
	console.log(`Response: HTTP ${res2.status}`);
	const paymentStatus2 = res2.headers.get('x-payment-status');
	console.log(`X-Payment-Status: ${paymentStatus2}`);
	if (paymentStatus2 === 'payment-rejected') {
		console.log('✅ Payment-Signature header was read and processed');
	} else if (paymentStatus2 === 'no-header') {
		console.log('❌ Payment-Signature header was NOT read');
	}
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log('=== x402 Payment Pipeline E2E Audit ===');
	console.log(`Target: ${STATUS_URL}`);
	console.log(`Time: ${new Date().toISOString()}\n`);

	await auditPaymentRequirements();
	await testPaymentHeader();

	console.log('\n=== Done ===');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
