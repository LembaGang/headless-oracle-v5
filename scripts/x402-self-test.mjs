/**
 * x402 Self-Test — Headless Oracle
 *
 * Makes a real $0.001 USDC payment to headlessoracle.com/v5/status on Base mainnet
 * using the x402 facilitator path (CDP). Proves the full payment flow end-to-end.
 *
 * Requirements:
 *   - Node.js 18+
 *   - A wallet with USDC on Base mainnet (at least $0.01 USDC to cover 1 request + gas buffer)
 *   - X402_TEST_PRIVATE_KEY env var (64-char hex, no 0x prefix, or with 0x prefix)
 *
 * Setup:
 *   cd /tmp/x402-test && npm init -y
 *   npm install viem x402
 *   X402_TEST_PRIVATE_KEY=<your-key> node x402-self-test.mjs
 *
 * Or from the repo root:
 *   npm install --prefix /tmp/x402-test viem x402
 *   X402_TEST_PRIVATE_KEY=<your-key> node --conditions=import scripts/x402-self-test.mjs
 */

import { createWalletClient, createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createPaymentHeader, selectPaymentRequirements } from 'x402/client';

const ENDPOINT    = 'https://headlessoracle.com/v5/status?mic=XNYS';
const USDC        = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO      = '0x26D4Ffe98017D2f160E2dAaE9d119e3d8b860AD3';
const CHAIN_ID    = 8453;  // Base mainnet
const MIN_USDC    = 0.001; // $0.001 minimum balance needed

// ── Step 0: validate env ──────────────────────────────────────────────────────

const rawKey = process.env.X402_TEST_PRIVATE_KEY;
if (!rawKey) {
  console.error('\nERROR: X402_TEST_PRIVATE_KEY is not set.\n');
  console.error('Wallet requirements:');
  console.error('  Network : Base mainnet (chain ID 8453)');
  console.error('  Token   : USDC at', USDC);
  console.error('  Amount  : At least $0.01 USDC recommended (each request costs $0.001)');
  console.error('  Pay-to  : Payments go to', PAY_TO);
  console.error('');
  console.error('How to get USDC on Base:');
  console.error('  1. Bridge ETH to Base via bridge.base.org');
  console.error('  2. Swap ETH → USDC on Uniswap or Aerodrome on Base');
  console.error('  3. Or use Coinbase to send USDC directly to Base network');
  console.error('');
  console.error('How to export your private key:');
  console.error('  MetaMask : Account Details → Export Private Key');
  console.error('  Coinbase Wallet : Settings → Developer Settings → Show Private Key');
  console.error('');
  console.error('Run:');
  console.error('  X402_TEST_PRIVATE_KEY=<64-hex-chars> node scripts/x402-self-test.mjs');
  process.exit(1);
}

const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  console.error('ERROR: X402_TEST_PRIVATE_KEY must be a 64-character hex string (32 bytes).');
  process.exit(1);
}

// ── Step 1: set up viem wallet client ─────────────────────────────────────────

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({
  account,
  chain:     base,
  transport: http('https://mainnet.base.org'),
});
const publicClient = createPublicClient({
  chain:     base,
  transport: http('https://mainnet.base.org'),
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  x402 Self-Test — Headless Oracle  (Base mainnet)');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Wallet  :', account.address);
console.log('  Endpoint:', ENDPOINT);
console.log('  Pay-to  :', PAY_TO);
console.log('  Amount  : $0.001 USDC (1000 units)');
console.log('');

// ── Step 2: preflight — check ETH and USDC balances ──────────────────────────

console.log('─── Preflight: checking balances ───────────────────────────────');

const [ethBalance, usdcBalance] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.readContract({
    address:  USDC,
    abi:      [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'balanceOf',
    args:     [account.address],
  }),
]);

const ethFmt  = formatUnits(ethBalance,  18);
const usdcFmt = formatUnits(usdcBalance, 6);
console.log(`  ETH  balance: ${parseFloat(ethFmt).toFixed(6)} ETH`);
console.log(`  USDC balance: ${parseFloat(usdcFmt).toFixed(6)} USDC`);

if (parseFloat(ethFmt) < 0.0001) {
  console.error('\nERROR: Insufficient ETH for gas. Need at least 0.0001 ETH on Base mainnet.');
  console.error('Bridge ETH to Base at bridge.base.org');
  process.exit(1);
}
if (parseFloat(usdcFmt) < MIN_USDC) {
  console.error(`\nERROR: Insufficient USDC. Have ${usdcFmt} USDC, need at least ${MIN_USDC} USDC.`);
  console.error('USDC contract on Base:', USDC);
  console.error('Get USDC: bridge from Ethereum via bridge.base.org, or swap on Aerodrome/Uniswap on Base.');
  process.exit(1);
}

console.log('  ✓ Balances sufficient\n');

// ── Step 3: GET endpoint — expect 402 with payment requirements ───────────────

console.log('─── Step 1: GET endpoint (expect 402) ──────────────────────────');
const probeRes = await fetch(ENDPOINT);
console.log(`  HTTP status: ${probeRes.status}`);

if (probeRes.status !== 402) {
  const body = await probeRes.text();
  console.log('  Unexpected status. Body:', body.slice(0, 300));
  // If 200, we may already have an API key or hit rate limit — still a success path
  if (probeRes.status === 200) {
    console.log('\n  (Endpoint returned 200 without payment — may have free tier remaining.)');
    console.log('  To force x402 path: call without X-Oracle-Key header after free tier exhausted.');
  }
  process.exit(probeRes.status === 200 ? 0 : 1);
}

const paymentTerms = await probeRes.json();
console.log('  Got 402. Payment requirements:');
const req = paymentTerms.accepts?.[0];
if (!req) {
  console.error('  ERROR: No accepts[] array in 402 response. Body:', JSON.stringify(paymentTerms));
  process.exit(1);
}
console.log(`    scheme  : ${req.scheme}`);
console.log(`    network : ${req.network}`);
console.log(`    asset   : ${req.asset}`);
console.log(`    amount  : ${req.maxAmountRequired} units (${parseInt(req.maxAmountRequired) / 1_000_000} USDC)`);
console.log(`    payTo   : ${req.payTo}`);
console.log(`    timeout : ${req.maxTimeoutSeconds}s`);
console.log('');

// ── Step 4: sign the EIP-3009 payment header ──────────────────────────────────

console.log('─── Step 2: sign EIP-3009 TransferWithAuthorization ────────────');
console.log('  Building payment header via x402 client library...');

let xPaymentHeader;
try {
  // The x402 library's createPaymentHeader:
  //   1. Calls preparePaymentHeader: generates nonce, validAfter, validBefore
  //   2. Calls signPaymentHeader: signs EIP-3009 typed data with walletClient.signTypedData
  //   3. Returns base64(JSON.stringify(signedPayload))
  //
  // The CDP facilitator (/platform/v2/x402/settle) then:
  //   1. Verifies the EIP-3009 signature
  //   2. Submits the TransferWithAuthorization to Base mainnet
  //   3. Returns { success: true, txHash: '0x...' }
  xPaymentHeader = await createPaymentHeader(walletClient, 1, req);
  console.log(`  ✓ Payment header created (${xPaymentHeader.length} chars base64)`);
  // Decode and show structure (without exposing private key material)
  const decoded = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
  console.log('  Payload structure:');
  console.log(`    x402Version : ${decoded.x402Version}`);
  console.log(`    scheme      : ${decoded.scheme}`);
  console.log(`    network     : ${decoded.network}`);
  console.log(`    from        : ${decoded.payload?.authorization?.from}`);
  console.log(`    to          : ${decoded.payload?.authorization?.to}`);
  console.log(`    value       : ${decoded.payload?.authorization?.value}`);
  console.log(`    signature   : ${decoded.payload?.signature?.slice(0, 20)}...`);
} catch (err) {
  console.error('\nERROR creating payment header:', err.message);
  console.error('');
  console.error('This usually means:');
  console.error('  - The USDC contract does not support TransferWithAuthorization on this network');
  console.error('  - The wallet client is misconfigured');
  throw err;
}
console.log('');

// ── Step 5: retry request with X-Payment header ───────────────────────────────

console.log('─── Step 3: retry with X-Payment header ────────────────────────');
console.log('  Submitting to CDP facilitator for settlement...');

const paidRes = await fetch(ENDPOINT, {
  headers: { 'X-Payment': xPaymentHeader },
});

console.log(`  HTTP status: ${paidRes.status}`);
const paidBody = await paidRes.json();

if (paidRes.status === 200) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ✓ PAYMENT ACCEPTED — signed receipt returned');
  console.log('═══════════════════════════════════════════════════════════════');

  const receipt = paidBody.receipt ?? paidBody;
  console.log('');
  console.log('  Receipt:');
  console.log(`    mic        : ${receipt.mic}`);
  console.log(`    status     : ${receipt.status}`);
  console.log(`    issued_at  : ${receipt.issued_at}`);
  console.log(`    expires_at : ${receipt.expires_at}`);
  console.log(`    receipt_id : ${receipt.receipt_id}`);
  console.log(`    signature  : ${String(receipt.signature).slice(0, 20)}...`);
  console.log(`    discovery  : ${paidBody.discovery_url ?? '(none)'}`);
  console.log('');
  console.log('  Payment was settled on Base mainnet by the CDP facilitator.');
  console.log('  Check txns for', PAY_TO, 'on basescan.org:');
  console.log('  https://basescan.org/address/' + PAY_TO);
  console.log('');
  console.log('  x402scan listing: https://x402scan.com');
  console.log('  Bazaar auto-catalog: https://bazaar.x402.org');

} else if (paidRes.status === 402) {
  console.error('\n  Payment rejected (still 402). CDP facilitator response:');
  console.error('  ', JSON.stringify(paidBody, null, 2).split('\n').join('\n   '));
  console.error('');
  console.error('  Possible causes:');
  console.error('  1. USDC allowance: EIP-3009 does not require pre-approval,');
  console.error('     but the facilitator may be checking the USDC domain separator.');
  console.error('     Verify USDC contract version supports TransferWithAuthorization.');
  console.error('  2. Clock skew: validAfter/validBefore window may be stale.');
  console.error('  3. Facilitator outage: check https://status.coinbase.com');
  process.exit(1);
} else {
  console.error(`\n  Unexpected status ${paidRes.status}:`, JSON.stringify(paidBody, null, 2));
  process.exit(1);
}
