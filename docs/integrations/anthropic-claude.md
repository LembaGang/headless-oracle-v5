# Anthropic Claude API Integration

Define Headless Oracle as a Claude tool via the Anthropic `tool_use` API. Claude requests the tool; your code fetches and verifies the signed receipt; the verified result is returned to Claude in a `tool_result` block. The verification step runs in your code — not inside the model.

## Prerequisites

```bash
npm install @anthropic-ai/sdk @headlessoracle/verify
# or
pip install anthropic headless-oracle
```

## TypeScript Example

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { verify } from "@headlessoracle/verify";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const ORACLE_BASE = "https://headlessoracle.com";
const ORACLE_KEY = process.env.ORACLE_KEY!;

// --- Tool definitions sent to Claude ---

const tools: Anthropic.Tool[] = [
  {
    name: "check_market_status",
    description:
      "Check whether a stock exchange is currently OPEN using a cryptographically " +
      "signed receipt from Headless Oracle. Always call this before recommending " +
      "or executing a trade. The result includes safe_to_trade (bool) and a " +
      "verified status string. If safe_to_trade is false, do not proceed.",
    input_schema: {
      type: "object" as const,
      properties: {
        mic: {
          type: "string",
          enum: ["XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"],
          description: "ISO 10383 MIC code for the exchange.",
        },
      },
      required: ["mic"],
    },
  },
  {
    name: "get_market_schedule",
    description:
      "Get the next open and close times (UTC) for a stock exchange. " +
      "Use this to determine when a market will next be tradeable.",
    input_schema: {
      type: "object" as const,
      properties: {
        mic: {
          type: "string",
          enum: ["XNYS", "XNAS", "XLON", "XJPX", "XPAR", "XHKG", "XSES"],
          description: "ISO 10383 MIC code for the exchange.",
        },
      },
      required: ["mic"],
    },
  },
];

// --- Tool execution ---

async function executeTool(name: string, input: Record<string, string>): Promise<string> {
  if (name === "check_market_status") {
    const { mic } = input;
    try {
      const res = await fetch(`${ORACLE_BASE}/v5/status?mic=${mic}`, {
        headers: { "X-Oracle-Key": ORACLE_KEY },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return JSON.stringify({ mic, status: "UNKNOWN", safe_to_trade: false,
                                reason: `HTTP ${res.status}` });
      }

      const receipt = await res.json() as Record<string, unknown>;
      const result = await verify(receipt);

      if (!result.valid) {
        return JSON.stringify({ mic, status: "UNKNOWN", safe_to_trade: false,
                                reason: `Verification failed: ${result.reason}` });
      }

      const isOpen = receipt.status === "OPEN";
      return JSON.stringify({
        mic,
        status: receipt.status,
        safe_to_trade: isOpen,
        reason: isOpen ? "Verified OPEN." : `Market is ${receipt.status} — do not trade.`,
        expires_at: receipt.expires_at,
        receipt_mode: receipt.receipt_mode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ mic, status: "UNKNOWN", safe_to_trade: false,
                              reason: `Oracle error: ${message}` });
    }
  }

  if (name === "get_market_schedule") {
    const { mic } = input;
    try {
      const res = await fetch(`${ORACLE_BASE}/v5/schedule?mic=${mic}`,
                              { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
      return JSON.stringify(await res.json());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: message });
    }
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// --- Tool use loop ---

async function runWithOracle(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const SYSTEM_PROMPT =
    "You are a trading safety assistant. Before recommending or executing any trade, " +
    "you must call check_market_status for the relevant exchange. " +
    "Evaluate the safe_to_trade field — if it is false, halt and explain why. " +
    "UNKNOWN status means the market state cannot be verified cryptographically. " +
    "Treat UNKNOWN as CLOSED. Never recommend a trade when safe_to_trade is false.";

  // Tool use loop: continue until Claude stops requesting tools
  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && textBlock.type === "text" ? textBlock.text : "";
    }

    if (response.stop_reason === "tool_use") {
      // Add Claude's tool_use request to the conversation
      messages.push({ role: "assistant", content: response.content });

      // Execute all requested tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const output = await executeTool(block.name, block.input as Record<string, string>);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }

      // Return results to Claude
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason — return whatever Claude produced
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && textBlock.type === "text" ? textBlock.text : "";
  }
}

// --- Usage ---

async function main() {
  const response = await runWithOracle(
    "I want to buy shares on the NYSE. Is it safe to trade right now?"
  );
  console.log(response);
}

main().catch(console.error);
```

## System Prompt Fragment

Include this in your system prompt whenever Oracle tools are registered. It makes Claude's fail-closed reasoning explicit and consistent:

```
Before recommending or executing any trade, call check_market_status for the
relevant exchange and evaluate safe_to_trade:

- safe_to_trade: true  → market is OPEN with a cryptographically verified receipt
- safe_to_trade: false → market is CLOSED, HALTED, or UNKNOWN — do not trade

UNKNOWN means the Oracle's signing infrastructure could not produce a verified
receipt. This is not a soft signal — treat it as CLOSED. Never infer that a
market is open from context, time of day, or prior messages. Only a verified
receipt with safe_to_trade=true authorizes a trade.
```

## Important

- **Verification runs in your code, not in the model.** Claude cannot verify Ed25519 signatures. The `executeTool` function calls `verify()` before returning `safe_to_trade` to Claude. Claude should never be asked to reason about raw signature bytes.
- **Return `safe_to_trade` as a top-level field.** Claude parses the `tool_result` content string as JSON. A flat, clearly named boolean is more reliable than nesting it inside a receipt object the model must interpret.
- **The tool use loop must handle multiple tool calls per turn.** Claude may call both `check_market_status` and `get_market_schedule` in the same response. The loop above handles all blocks in a single pass before returning results.
- **`AbortSignal.timeout(5000)` prevents a hung Oracle request from stalling the conversation.** On timeout, `safe_to_trade` is `false` — fail-closed — and Claude receives an explanation it can relay to the user.
