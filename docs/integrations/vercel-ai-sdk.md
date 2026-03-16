# Vercel AI SDK Integration

Define a Headless Oracle market-status check as a Vercel AI SDK `tool()`. The tool fetches a signed receipt, verifies the Ed25519 signature with `@headlessoracle/verify`, and returns a structured result. Works with `generateText`, `streamText`, and any model that supports tool use.

## Prerequisites

```bash
npm install ai @headlessoracle/verify zod
# plus your model provider, e.g.:
npm install @ai-sdk/openai
```

## Complete Example

```typescript
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { verify } from "@headlessoracle/verify";
import { z } from "zod";

const ORACLE_BASE = "https://headlessoracle.com";
const ORACLE_KEY = process.env.ORACLE_KEY!;

const VALID_MICS = ["XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"] as const;
type Mic = (typeof VALID_MICS)[number];

// --- Tool definition ---

const checkMarketStatus = tool({
  description:
    "Check whether a stock exchange is currently OPEN using a cryptographically " +
    "signed receipt from Headless Oracle. Always call this before executing or " +
    "recommending a trade. If safe_to_trade is false, halt — do not proceed.",
  parameters: z.object({
    mic: z
      .enum(VALID_MICS)
      .describe("ISO 10383 MIC code for the exchange."),
    mode: z
      .enum(["demo", "live"])
      .optional()
      .default("live")
      .describe("Use 'demo' for unauthenticated public receipts, 'live' for authenticated."),
  }),
  execute: async ({ mic, mode = "live" }) => {
    const url =
      mode === "demo"
        ? `${ORACLE_BASE}/v5/demo?mic=${mic}`
        : `${ORACLE_BASE}/v5/status?mic=${mic}`;

    const headers: Record<string, string> =
      mode === "live" ? { "X-Oracle-Key": ORACLE_KEY } : {};

    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });

      if (!res.ok) {
        return {
          mic,
          status: "UNKNOWN" as const,
          safe_to_trade: false,
          reason: `Oracle returned HTTP ${res.status}`,
          receipt: null,
        };
      }

      const receipt = await res.json();

      // verify() checks Ed25519 signature + expires_at TTL
      // Throws with a machine-readable reason on failure
      const result = await verify(receipt);

      if (!result.valid) {
        return {
          mic,
          status: "UNKNOWN" as const,
          safe_to_trade: false,
          reason: `Receipt verification failed: ${result.reason}`,
          receipt: null,
        };
      }

      const isOpen = receipt.status === "OPEN";
      return {
        mic,
        status: receipt.status as string,
        safe_to_trade: isOpen,
        reason: isOpen ? "Market is OPEN — verified." : `Market is ${receipt.status} — do not trade.`,
        expires_at: receipt.expires_at as string,
        receipt_mode: receipt.receipt_mode as string,
        receipt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        mic,
        status: "UNKNOWN" as const,
        safe_to_trade: false,
        reason: `Oracle error: ${message}`,
        receipt: null,
      };
    }
  },
});

// --- Usage with generateText ---

async function main() {
  const { text, toolCalls, toolResults } = await generateText({
    model: openai("gpt-4o"),
    tools: { checkMarketStatus },
    maxSteps: 3,
    system:
      "You are a trading assistant. Before recommending or executing any trade, " +
      "you must call checkMarketStatus to verify the market is open. " +
      "If safe_to_trade is false, inform the user and do not proceed with the trade. " +
      "UNKNOWN status means the market state cannot be verified — treat it as CLOSED.",
    prompt: "Is it safe to trade on the NYSE right now?",
  });

  console.log("Response:", text);
  console.log("Tool results:", JSON.stringify(toolResults, null, 2));
}

main().catch(console.error);


// --- Usage with streamText ---

import { streamText } from "ai";

async function streamExample() {
  const { textStream } = await streamText({
    model: openai("gpt-4o"),
    tools: { checkMarketStatus },
    maxSteps: 3,
    system:
      "You are a trading safety assistant. Always verify market status before acting. " +
      "Treat UNKNOWN as CLOSED.",
    prompt: "Check XNYS and XLON — are both markets open?",
  });

  for await (const delta of textStream) {
    process.stdout.write(delta);
  }
}
```

## Important

- **`verify()` is async** — it fetches the public key from `https://headlessoracle.com/v5/keys` on first call. Pass `publicKey` as an option to skip the fetch in high-throughput scenarios: `verify(receipt, { publicKey: "03dc..." })`.
- **`demo` mode returns public receipts** (no API key needed, `receipt_mode: "demo"`). Suitable for read-only status checks. Use `live` mode for any decision that triggers an action.
- **`AbortSignal.timeout(5000)` is required.** Without a timeout, a hung Oracle request will hang the tool call indefinitely. On timeout, the tool returns `safe_to_trade: false` — fail-closed.
- **Do not call `maxSteps: 1`** if the model needs to act on the Oracle result — it needs at least one step for the tool call and one to generate the final response.
