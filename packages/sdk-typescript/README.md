# @headlessoracle/sdk

TypeScript SDK for [Headless Oracle](https://headlessoracle.com) — Ed25519-signed market-state attestations for 28 global exchanges.

## Install

```bash
npm install @headlessoracle/sdk
```

## Quick Start

```typescript
import { HeadlessOracle } from '@headlessoracle/sdk';

const oracle = new HeadlessOracle({ apiKey: 'ho_free_...' });

// Get market status (signed receipt)
const receipt = await oracle.getStatus('XNYS');
if (receipt.status !== 'OPEN') {
  console.log('Market closed, halting execution');
}

// Verify a receipt (server-side)
const result = await oracle.verify(receipt);
console.log(result.valid); // true

// Offline verification (Ed25519 via Web Crypto)
const offline = await oracle.verifyOffline(receipt);
console.log(offline.valid); // true

// Batch check multiple exchanges
const batch = await oracle.batch(['XNYS', 'XLON', 'XHKG']);
if (!batch.summary.all_open) {
  console.log('Not all markets open');
}

// Historical reconstruction
const past = await oracle.historical('XNYS', '2026-03-09T14:30:00Z');
console.log(past.computed_status);

// Self-provision an instant key (zero friction)
const key = await oracle.getInstantKey('my-agent-v1');
console.log(key.api_key); // ho_free_...
```

## Auto-Provisioning

If no `apiKey` is provided, the SDK auto-provisions a free key on the first 402 response:

```typescript
const oracle = new HeadlessOracle(); // no key
const receipt = await oracle.getStatus('XNYS'); // auto-provisions key
```

## Safety Helpers

```typescript
// Single exchange check
if (await oracle.isSafeToExecute('XNYS')) {
  // proceed with trade
}

// Multi-exchange gate
if (await oracle.allOpen(['XNYS', 'XLON', 'XHKG'])) {
  // all markets open — proceed
}
```

## Error Handling

```typescript
import { HeadlessOracle, OracleError } from '@headlessoracle/sdk';

try {
  const receipt = await oracle.getStatus('XNYS');
} catch (err) {
  if (err instanceof OracleError) {
    console.log(err.status); // 429
    console.log(err.code);   // 'RATE_LIMITED'
    console.log(err.body);   // full error response
  }
}
```

The SDK auto-retries on 429 with exponential backoff (configurable via `maxRetries`).

## Options

```typescript
new HeadlessOracle({
  apiKey: 'ho_free_...',           // API key (optional — auto-provisions if omitted)
  baseUrl: 'https://headlessoracle.com',  // Default
  publicKey: '03dc...',            // Ed25519 public key hex (for offline verification)
  maxRetries: 3,                   // Max retries on 429
});
```

## All Methods

| Method | Description |
|--------|-------------|
| `getStatus(mic)` | Signed receipt (authenticated or demo) |
| `getDemo(mic)` | Public demo receipt (never uses API key) |
| `batch(mics)` | Batch signed receipts |
| `historical(mic, at)` | Historical reconstruction (unsigned) |
| `getSchedule(mic)` | Next open/close times |
| `listExchanges()` | All 28 exchanges |
| `health()` | Signed liveness probe |
| `briefing()` | Daily market intelligence snapshot |
| `verify(receipt)` | Server-side signature verification |
| `verifyOffline(receipt)` | Offline Ed25519 verification (Web Crypto) |
| `getInstantKey(agentId)` | Self-provision free API key |
| `getPublicKey()` | Fetch and cache Ed25519 public key |
| `isSafeToExecute(mic)` | Returns true only if OPEN |
| `allOpen(mics)` | Returns true if all exchanges OPEN |

## Critical Rule

**UNKNOWN and HALTED must be treated as CLOSED.** Halt all execution. This is the fail-closed contract — non-negotiable.

## License

MIT
