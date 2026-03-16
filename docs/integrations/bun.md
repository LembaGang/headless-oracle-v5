# Bun Integration

Use Headless Oracle in a Bun TypeScript runtime: fetch and verify signed receipts with native `fetch`, gate a `Bun.serve()` webhook on market status, and schedule periodic checks with a cron-style pattern. `@headlessoracle/verify` uses the Web Crypto API which Bun provides natively — no polyfills required.

## Prerequisites

```bash
bun add @headlessoracle/verify
```

## Complete Example

```typescript
// oracle-gate.ts
import { verify } from "@headlessoracle/verify";

const ORACLE_BASE = "https://headlessoracle.com";
const ORACLE_KEY = Bun.env.ORACLE_KEY!;

// Cache the public key after first fetch to avoid a network round-trip per receipt.
// The key at /v5/keys rotates infrequently — safe to hold in memory for a process lifetime.
let cachedPublicKey: string | null = null;

async function getPublicKey(): Promise<string> {
  if (cachedPublicKey) return cachedPublicKey;
  const res = await fetch(`${ORACLE_BASE}/v5/keys`);
  const data = await res.json() as { keys: Array<{ public_key: string }> };
  cachedPublicKey = data.keys[0].public_key;
  return cachedPublicKey;
}

interface OracleResult {
  mic: string;
  status: string;
  safeToTrade: boolean;
  reason: string;
  expiresAt: string | null;
}

export async function checkMarket(mic: string): Promise<OracleResult> {
  try {
    const res = await fetch(`${ORACLE_BASE}/v5/status?mic=${mic}`, {
      headers: { "X-Oracle-Key": ORACLE_KEY },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return { mic, status: "UNKNOWN", safeToTrade: false,
               reason: `HTTP ${res.status}`, expiresAt: null };
    }

    const receipt = await res.json() as Record<string, unknown>;
    const publicKey = await getPublicKey();

    // Pass the cached key — skips the /v5/keys fetch inside verify()
    const result = await verify(receipt, { publicKey });

    if (!result.valid) {
      return { mic, status: "UNKNOWN", safeToTrade: false,
               reason: `Verification failed: ${result.reason}`, expiresAt: null };
    }

    const isOpen = receipt.status === "OPEN";
    return {
      mic,
      status: receipt.status as string,
      safeToTrade: isOpen,
      reason: isOpen ? "Verified OPEN." : `Market is ${receipt.status}.`,
      expiresAt: receipt.expires_at as string,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { mic, status: "UNKNOWN", safeToTrade: false,
             reason: `Error: ${message}`, expiresAt: null };
  }
}


// --- Webhook server: gate trade signals on market status ---

const server = Bun.serve({
  port: 3000,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/trade-signal") {
      const body = await req.json() as { mic: string; symbol: string; action: string };
      const { mic, symbol, action } = body;

      // Gate every incoming trade signal on live Oracle check
      const oracle = await checkMarket(mic);

      if (!oracle.safeToTrade) {
        return Response.json(
          { accepted: false, reason: oracle.reason, mic, oracle_status: oracle.status },
          { status: 422 }
        );
      }

      // Market is verified OPEN — process the signal
      console.log(`[trade] ${action} ${symbol} on ${mic} — Oracle verified OPEN`);
      return Response.json({ accepted: true, mic, oracle_status: oracle.status });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const oracle = await checkMarket("XNYS");
      return Response.json({ oracle });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Webhook server listening on http://localhost:${server.port}`);


// --- Scheduled market check (cron-style) ---
// Bun does not have a built-in cron scheduler; use setInterval for periodic checks.
// For production, prefer a Cloudflare Worker Cron or system cron calling this endpoint.

const CHECK_INTERVAL_MS = 60_000; // check every 60 seconds

const MICs = ["XNYS", "XNAS", "XLON"] as const;

async function scheduledMarketCheck() {
  console.log(`[cron] Running market status check for ${MICs.join(", ")}`);
  for (const mic of MICs) {
    const result = await checkMarket(mic);
    if (!result.safeToTrade) {
      console.warn(`[cron] HALT signal: ${mic} — ${result.reason}`);
      // Emit to your alerting system here (e.g. webhook, Slack, PagerDuty)
    } else {
      console.log(`[cron] ${mic} OPEN — verified until ${result.expiresAt}`);
    }
  }
}

// Run immediately on startup, then on interval
scheduledMarketCheck();
setInterval(scheduledMarketCheck, CHECK_INTERVAL_MS);
```

Run with:

```bash
bun run oracle-gate.ts
```

Test the webhook:

```bash
# Should be accepted when NYSE is open
curl -X POST http://localhost:3000/trade-signal \
  -H "Content-Type: application/json" \
  -d '{"mic":"XNYS","symbol":"AAPL","action":"buy"}'

# Should return 422 with oracle_status when closed
curl -X POST http://localhost:3000/trade-signal \
  -H "Content-Type: application/json" \
  -d '{"mic":"XJPX","symbol":"7203.T","action":"buy"}'
```

## Important

- **Cache the public key, not the receipt.** The public key is stable across a process lifetime. The receipt expires in 60 seconds and must never be cached or reused between requests.
- **`AbortSignal.timeout(5000)` is Bun-native.** It works without any polyfill. On timeout, `checkMarket` returns `safeToTrade: false` — fail-closed.
- **Return `422 Unprocessable Entity` (not `200`) for rejected signals.** A 200 response with `accepted: false` in the body is ambiguous for agent callers. A 4xx status is deterministic.
- **`Bun.env` vs `process.env`** — both work in Bun. `Bun.env` is slightly faster as it skips the Node.js compatibility layer. Either is fine for secrets loaded from `.env` via `bun run --env-file .env`.
