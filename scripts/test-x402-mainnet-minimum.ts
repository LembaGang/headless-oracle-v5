#!/usr/bin/env npx tsx
/**
 * x402 Mainnet E2E Payment Test — REAL $0.001 USDC on Base Mainnet
 *
 * This script constructs a REAL valid EIP-712 transferWithAuthorization signature
 * for $0.001 USDC on Base mainnet and sends it to the live Headless Oracle worker
 * via the x402 Payment-Signature header.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * HOW TO RUN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. FUND A WALLET:
 *    - Create or use an existing Base mainnet wallet
 *    - Transfer at least 0.01 USDC to it (enough for ~10 test payments)
 *    - USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *    - You also need a tiny amount of ETH on Base for gas (the facilitator
 *      pays the on-chain gas, but viem needs ETH for the RPC connection)
 *    - Get Base USDC: bridge from Ethereum via bridge.base.org, or buy on
 *      Coinbase and withdraw to Base network
 *
 * 2. INSTALL DEPENDENCIES (one-time):
 *    npm install --save-dev viem
 *
 * 3. RUN:
 *    WALLET_PRIVATE_KEY=0x<your-64-hex-char-private-key> npx tsx scripts/test-x402-mainnet-minimum.ts
 *
 * 4. EXPECTED COST:
 *    $0.001 USDC per successful payment. The transferWithAuthorization is an
 *    off-chain signature — funds only move if the CDP facilitator calls the
 *    USDC contract's transferWithAuthorization function on-chain.
 *
 * 5. WHAT SUCCESS LOOKS LIKE:
 *    - HTTP 200 from /v5/status with a signed market receipt
 *    - Payment-Response header in the response (settlement confirmation)
 *    - $0.001 USDC deducted from your wallet
 *    - Console output: "PAYMENT ACCEPTED — receipt received"
 *
 * 6. WHAT FAILURE LOOKS LIKE:
 *    - HTTP 402 with x402_error field (bad signature, insufficient balance, etc.)
 *    - The script logs the rejection reason for debugging
 *    - No funds are deducted on failure (signature is off-chain only)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DRY RUN MODE (default)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * By default, the script constructs and logs the full payment but does NOT send it.
 * To actually send the payment, pass --send:
 *
 *    WALLET_PRIVATE_KEY=0x... npx tsx scripts/test-x402-mainnet-minimum.ts --send
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createWalletClient, http, encodePacked, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// ── Constants ────────────────────────────────────────────────────────────────

const WORKER_URL = 'https://headlessoracle.com';
const STATUS_URL = `${WORKER_URL}/v5/status?mic=XNYS`;

// Base mainnet USDC contract
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// EIP-712 domain for Base mainnet USDC (from USDC contract's EIP-712 domain separator)
const USDC_EIP712_DOMAIN = {
	name: 'USD Coin',
	version: '2',
	chainId: 8453,
	verifyingContract: USDC_CONTRACT,
} as const;

// EIP-3009 TransferWithAuthorization types
const TRANSFER_WITH_AUTH_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(label: string, data?: unknown): void {
	if (data !== undefined) {
		console.log(`\n[${label}]`);
		if (typeof data === 'string') console.log(`  ${data}`);
		else console.log(JSON.stringify(data, null, 2).split('\n').map(l => `  ${l}`).join('\n'));
	} else {
		console.log(`\n[${label}]`);
	}
}

function safeBase64Encode(data: string): string {
	const bytes = new TextEncoder().encode(data);
	const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
	return btoa(binaryString);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const sendMode = process.argv.includes('--send');

	console.log('══════════════════════════════════════════════════════════════');
	console.log('  x402 Mainnet E2E Payment Test');
	console.log(`  Mode: ${sendMode ? 'LIVE — will spend $0.001 USDC' : 'DRY RUN — will NOT send payment'}`);
	console.log(`  Target: ${STATUS_URL}`);
	console.log(`  Time: ${new Date().toISOString()}`);
	console.log('══════════════════════════════════════════════════════════════');

	// ── Step 1: Validate wallet ──────────────────────────────────────────

	const privateKey = process.env.WALLET_PRIVATE_KEY;
	if (!privateKey) {
		console.error('\n❌ WALLET_PRIVATE_KEY env var is required');
		console.error('   Usage: WALLET_PRIVATE_KEY=0x<key> npx tsx scripts/test-x402-mainnet-minimum.ts [--send]');
		process.exit(1);
	}

	const account = privateKeyToAccount(privateKey as `0x${string}`);
	log('WALLET', {
		address: account.address,
		chain: 'Base mainnet (8453)',
		note: 'Ensure this wallet has >= 0.001 USDC on Base',
	});

	// ── Step 2: Fetch 402 from live worker ───────────────────────────────

	log('STEP 1: Fetching 402 payment requirements');
	const res402 = await fetch(STATUS_URL);
	log('RESPONSE', { status: res402.status });

	if (res402.status !== 402) {
		console.error(`\n❌ Expected HTTP 402, got ${res402.status}`);
		console.error('   The endpoint may not require payment (API key set, or ORACLE_PAYMENT_ADDRESS not configured)');
		const body = await res402.text();
		console.error(`   Body: ${body.slice(0, 500)}`);
		process.exit(1);
	}

	const body402 = await res402.json() as Record<string, unknown>;

	// Check for Payment-Required header (x402 v2)
	const prHeader = res402.headers.get('payment-required');
	if (prHeader) {
		log('PAYMENT-REQUIRED HEADER', 'Present (x402 v2 compliant)');
	}

	// Parse payment requirements from body
	const accepts = body402.accepts as Array<Record<string, unknown>> | undefined;
	if (!accepts || accepts.length === 0) {
		console.error('\n❌ No accepts[] in 402 body — cannot determine payment requirements');
		console.error(`   Body: ${JSON.stringify(body402, null, 2).slice(0, 1000)}`);
		process.exit(1);
	}

	const req = accepts[0];
	log('PAYMENT REQUIREMENTS (from 402 body)', {
		scheme: req.scheme,
		network: req.network,
		amount: req.maxAmountRequired ?? req.amount,
		asset: req.asset,
		payTo: req.payTo,
		maxTimeoutSeconds: req.maxTimeoutSeconds,
		extra: req.extra,
	});

	// Extract values we need
	const payTo = req.payTo as string;
	const amount = (req.maxAmountRequired ?? req.amount) as string;
	const maxTimeout = (req.maxTimeoutSeconds as number) ?? 300;
	const extra = req.extra as { name: string; version: string } | undefined;

	if (!payTo || !amount) {
		console.error('\n❌ Missing payTo or amount in payment requirements');
		process.exit(1);
	}

	// Verify EIP-712 domain matches
	if (extra) {
		log('EIP-712 DOMAIN CHECK', {
			expected_name: 'USD Coin',
			got_name: extra.name,
			match: extra.name === 'USD Coin',
			expected_version: '2',
			got_version: extra.version,
			match_version: extra.version === '2',
		});
	}

	// ── Step 3: Construct EIP-712 TransferWithAuthorization ──────────────

	log('STEP 2: Constructing EIP-712 TransferWithAuthorization');

	const nowSec = Math.floor(Date.now() / 1000);
	const validAfter = BigInt(nowSec - 600);   // 10 minutes ago
	const validBefore = BigInt(nowSec + maxTimeout); // maxTimeoutSeconds from now
	const nonce = keccak256(encodePacked(
		['address', 'uint256'],
		[account.address, BigInt(nowSec)],
	));

	const authorization = {
		from: account.address,
		to: payTo as `0x${string}`,
		value: BigInt(amount),
		validAfter,
		validBefore,
		nonce,
	};

	log('AUTHORIZATION', {
		from: authorization.from,
		to: authorization.to,
		value: authorization.value.toString(),
		validAfter: authorization.validAfter.toString(),
		validBefore: authorization.validBefore.toString(),
		nonce: authorization.nonce,
		note: `Window: ${new Date(Number(validAfter) * 1000).toISOString()} → ${new Date(Number(validBefore) * 1000).toISOString()}`,
	});

	// ── Step 4: Sign with EIP-712 ───────────────────────────────────────

	log('STEP 3: Signing EIP-712 typed data');

	const walletClient = createWalletClient({
		account,
		chain: base,
		transport: http(),
	});

	const signature = await walletClient.signTypedData({
		domain: USDC_EIP712_DOMAIN,
		types: TRANSFER_WITH_AUTH_TYPES,
		primaryType: 'TransferWithAuthorization',
		message: {
			from: authorization.from,
			to: authorization.to,
			value: authorization.value,
			validAfter: authorization.validAfter,
			validBefore: authorization.validBefore,
			nonce: authorization.nonce,
		},
	});

	log('SIGNATURE', {
		signature: signature,
		length: signature.length,
		note: 'EIP-712 typed data signature (65 bytes hex-encoded)',
	});

	// ── Step 5: Construct x402 PaymentPayload ───────────────────────────

	log('STEP 4: Constructing x402 PaymentPayload');

	// x402 v1 format (matches our server's x402Version: 1 in 402 response)
	const paymentPayload = {
		x402Version: 1,
		scheme: 'exact',
		network: 'base',
		payload: {
			signature,
			authorization: {
				from: authorization.from,
				to: authorization.to,
				value: authorization.value.toString(),
				validAfter: authorization.validAfter.toString(),
				validBefore: authorization.validBefore.toString(),
				nonce: authorization.nonce,
			},
		},
	};

	log('PAYMENT PAYLOAD (x402 v1)', paymentPayload);

	const encoded = safeBase64Encode(JSON.stringify(paymentPayload));
	log('BASE64 ENCODED', {
		length: encoded.length,
		preview: encoded.slice(0, 80) + '...',
	});

	// ── Step 6: Send or dry-run ─────────────────────────────────────────

	if (!sendMode) {
		log('DRY RUN COMPLETE');
		console.log('\n  The payment payload above is ready to send.');
		console.log('  To execute the payment and spend $0.001 USDC, run:');
		console.log(`\n  WALLET_PRIVATE_KEY=${privateKey.slice(0, 6)}... npx tsx scripts/test-x402-mainnet-minimum.ts --send\n`);

		// Also show what the curl would look like
		console.log('  Equivalent curl:');
		console.log(`  curl -H "Payment-Signature: ${encoded.slice(0, 40)}..." "${STATUS_URL}"\n`);
		return;
	}

	log('STEP 5: SENDING PAYMENT (live — $0.001 USDC will be deducted on success)');

	const payRes = await fetch(STATUS_URL, {
		headers: {
			'Payment-Signature': encoded,
		},
	});

	log('RESPONSE', {
		status: payRes.status,
		payment_status: payRes.headers.get('x-payment-status'),
		payment_response: payRes.headers.get('payment-response'),
	});

	// Log all interesting headers
	const headerLog: Record<string, string> = {};
	for (const [k, v] of payRes.headers.entries()) {
		if (k.startsWith('x-') || k.startsWith('payment') || k === 'content-type') {
			headerLog[k] = v;
		}
	}
	log('RESPONSE HEADERS', headerLog);

	const payBody = await payRes.json() as Record<string, unknown>;
	log('RESPONSE BODY', payBody);

	if (payRes.status === 200) {
		console.log('\n══════════════════════════════════════════════════════════════');
		console.log('  PAYMENT ACCEPTED — signed market receipt received');
		console.log('  $0.001 USDC has been deducted from your wallet');
		console.log('══════════════════════════════════════════════════════════════\n');

		// Verify the receipt has expected fields
		const receipt = (payBody as Record<string, unknown>).receipt ?? payBody;
		const receiptObj = receipt as Record<string, unknown>;
		const checks = [
			['mic', receiptObj.mic === 'XNYS'],
			['status', typeof receiptObj.status === 'string'],
			['signature', typeof receiptObj.signature === 'string'],
			['expires_at', typeof receiptObj.expires_at === 'string'],
			['receipt_mode', receiptObj.receipt_mode === 'live'],
		];
		console.log('Receipt field checks:');
		for (const [field, ok] of checks) {
			console.log(`  ${ok ? '✅' : '❌'} ${field}: ${receiptObj[field as string]}`);
		}
	} else if (payRes.status === 402) {
		const detail = payBody.x402_error ?? payBody.error ?? 'unknown';
		console.log('\n══════════════════════════════════════════════════════════════');
		console.log(`  PAYMENT REJECTED: ${detail}`);
		console.log('  No funds were deducted (signature is off-chain only)');
		console.log('══════════════════════════════════════════════════════════════\n');

		// Common failure reasons and fixes
		const detailStr = String(detail);
		if (detailStr.includes('insufficient')) {
			console.log('  FIX: Your wallet may not have enough USDC on Base mainnet');
			console.log(`  Wallet: ${account.address}`);
			console.log('  Required: 0.001 USDC (1000 units at 6 decimals)');
		} else if (detailStr.includes('signature')) {
			console.log('  FIX: EIP-712 signature may not match domain — check USDC contract EIP-712 name/version');
		} else if (detailStr.includes('timeout') || detailStr.includes('expired')) {
			console.log('  FIX: validBefore window may have passed — try again immediately');
		}
	} else {
		console.log(`\n⚠️  Unexpected status ${payRes.status}`);
	}
}

main().catch((err) => {
	console.error('\nFatal error:', err);
	process.exit(1);
});
