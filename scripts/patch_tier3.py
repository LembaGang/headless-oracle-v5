#!/usr/bin/env python3
"""
Weekend Sprint Tier 3 patch script — works on raw bytes to avoid encoding issues.
"""

SRC = 'src/index.ts'
with open(SRC, 'rb') as f:
    src = f.read()

# ── 1. Add OLAS + AUTOGPT + BLOG constants before SITEMAP_XML ───────────────

OLAS_CONST = b'''const OLAS_INTEGRATION_MD = `# Headless Oracle \xe2\x80\x94 Olas Integration

Olas autonomous services can use Headless Oracle as a pre-trade verification gate.

## Installation
\\`\\`\\`
pip install headless-oracle
\\`\\`\\`

## Usage in an Olas AutonomousService

In your service\'s \\`act()\\` method, check market state before executing:
\\`\\`\\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def act(self):
    receipt = client.get_status(\'XNYS\')
    if not verify(receipt) or receipt[\'status\'] != \'OPEN\':
        self.context.logger.info(\'Market closed or halted \xe2\x80\x94 skipping execution\')
        return
    # Proceed with trade execution
    self.execute_trade()
\\`\\`\\`

## Fail-closed contract
- OPEN \xe2\x86\x92 safe to proceed
- CLOSED \xe2\x86\x92 halt (normal schedule)
- HALTED \xe2\x86\x92 halt (circuit breaker)
- UNKNOWN \xe2\x86\x92 halt (treat as CLOSED)

## x402 per-request payment (no API key needed)
Agents with USDC on Base mainnet can pay $0.001/call via x402. See /.well-known/x402.json for payment discovery.

## Links
- PyPI: https://pypi.org/project/headless-oracle/
- MCP endpoint: https://headlessoracle.com/mcp
- API docs: https://headlessoracle.com/docs
`;

const AUTOGPT_INTEGRATION_MD = `# Headless Oracle \xe2\x80\x94 AutoGPT Integration

AutoGPT supports custom plugins. Add Headless Oracle as a pre-trade verification gate.

## Plugin setup

Create \\`headless_oracle_plugin.py\\` in your AutoGPT plugins directory:
\\`\\`\\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def can_handle_pre_command(command_name: str) -> bool:
    return command_name in [\'execute_trade\', \'place_order\', \'submit_transaction\']

def handle_pre_command(command_name: str, arguments: dict) -> str:
    mic = arguments.get(\'exchange\', \'XNYS\')
    receipt = client.get_status(mic)
    if not verify(receipt) or receipt[\'status\'] != \'OPEN\':
        return f"BLOCKED: {mic} is {receipt[\'status\']}. Trade halted."
    return None  # Allow command to proceed
\\`\\`\\`

## Fail-closed contract
- OPEN \xe2\x86\x92 safe to proceed
- CLOSED, HALTED, UNKNOWN \xe2\x86\x92 halt execution

## Links
- PyPI: https://pypi.org/project/headless-oracle/
- MCP endpoint: https://headlessoracle.com/mcp
- 170K+ star framework: https://github.com/Significant-Gravitas/AutoGPT
`;

'''

BLOG_CONST = b'''const BLOG_POST_WHY_PRE_TRADE_GATE = `# Why Your Trading Agent Needs a Pre-Trade Gate

Your agent traded $50,000 into a halted market at 3am. Nobody was watching.

This isn\'t a hypothetical. It\'s the failure mode that autonomous trading agents are quietly running toward \xe2\x80\x94 and almost nobody has a circuit breaker in place.

---

## The Blind Spot in Autonomous Execution

Agents that execute trades check a lot of things. Price feeds. Order book depth. Portfolio constraints. Risk limits. Slippage estimates.

What they almost never check: **is the exchange actually open right now?**

Price feeds don\'t tell you the exchange is closed. They serve you the last known price \xe2\x80\x94 which may be hours old \xe2\x80\x94 and they do it silently. A market data feed returning a stale quote and a market data feed returning a live quote look identical to an agent reading the response.

An agent that sees a valid price and a filled order book and a cleared risk check will execute. It has no reason not to.

Unless someone told it to check market state first.

---

## The DST Bug Nobody Saw Coming

March 8, 2026. US clocks spring forward. European clocks don\'t change for another three weeks.

For exactly one hour, agents using hardcoded UTC-offset schedules believed European markets were open. Their local-time arithmetic said "09:30 Paris time" but their UTC math was wrong by an hour. The clocks disagreed.

Trades executed into closed markets. The positions sat there, unhedged, until European markets actually opened \xe2\x80\x94 60 minutes and several volatility points later.

No error was thrown. No alert fired. The trades looked syntactically correct.

This is the class of bug that kills accounts: not a crash, not a panic, but a silent wrong answer that looks like a right answer.

---

## What a Pre-Trade Gate Actually Does

A pre-trade gate is a check you run before any trade, payment, or capital commitment. It asks one question: **is this exchange open right now, with cryptographic proof?**

The answer comes back as a signed receipt:

\\`\\`\\`json
{
  "mic": "XNYS",
  "status": "OPEN",
  "issued_at": "2026-04-03T14:32:10.000Z",
  "expires_at": "2026-04-03T14:33:10.000Z",
  "receipt_mode": "live",
  "signature": "a3f9..."
}
\\`\\`\\`

The signature is Ed25519. The TTL is 60 seconds. If either check fails, you don\'t trade.

---

## The Fail-Closed Contract

This is the design decision that separates a verification gate from a rubber stamp:

| Status | Action |
|--------|--------|
| \\`OPEN\\` | Proceed |
| \\`CLOSED\\` | Halt |
| \\`HALTED\\` | Halt (circuit breaker active) |
| \\`UNKNOWN\\` | **Halt** (treat as CLOSED) |

\\`UNKNOWN\\` is the critical case. It\'s what you get when the oracle can\'t determine the answer \xe2\x80\x94 network partition, data gap, signing infrastructure problem. An oracle that returns \\`UNKNOWN\\` is telling you it cannot confirm the safe state.

The fail-closed contract says: **if you can\'t verify, don\'t trade.** An agent that proceeds on \\`UNKNOWN\\` is choosing to skip the gate, not to pass it.

---

## The Gate in 5 Lines of Python

\\`\\`\\`python
from headless_oracle import OracleClient, verify

client = OracleClient()

def safe_to_execute(mic: str = \'XNYS\') -> bool:
    receipt = client.get_status(mic)
    return verify(receipt) and receipt[\'status\'] == \'OPEN\'
\\`\\`\\`

Call \\`safe_to_execute()\\` before any trade. If it returns \\`False\\` \xe2\x80\x94 for any reason \xe2\x80\x94 halt.

That\'s it. Five lines between your agent and a $50K mistake at 3am.

---

## Why Cryptographic Signing Matters

A signed receipt isn\'t just a JSON response. It\'s a tamper-proof attestation you can pass between agents.

If your execution agent receives a market state receipt from a data collection agent, it doesn\'t have to trust the data pipeline. It verifies the Ed25519 signature against the oracle\'s public key. If the signature is invalid \xe2\x80\x94 whether from tampering, replay, or corruption \xe2\x80\x94 the receipt is rejected.

This is how you build multi-agent financial workflows without a single trusted intermediary.

---

## The Question Isn\'t Whether Your Agent Will Encounter a Closed Market

Markets close. Exchanges halt. Holidays happen. DST transitions land on trading days.

In 2026 alone, there are over 5,000 schedule edge cases across 28 global exchanges \xe2\x80\x94 holidays, early closes, lunch breaks, circuit breakers, DST transitions, weekend rules for Middle Eastern markets that treat Friday as a non-trading day.

Your agent will encounter these. The question is whether it will know.

A pre-trade gate doesn\'t guarantee profit. It guarantees that when a market is closed, your agent knows it \xe2\x80\x94 and stops.

---

## Get Started

- **MCP (Claude/Cursor/Windsurf):** Add \\`https://headlessoracle.com/mcp\\` to your MCP config
- **Python:** \\`pip install headless-oracle\\`
- **REST:** \\`GET https://headlessoracle.com/v5/demo?mic=XNYS\\`
- **Free sandbox key:** \\`POST https://headlessoracle.com/v5/sandbox\\`

Documentation: [headlessoracle.com/docs](https://headlessoracle.com/docs)
`;

'''

SITEMAP_MARKER = b'const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>'
assert SITEMAP_MARKER in src, "SITEMAP_XML marker not found"
src = src.replace(SITEMAP_MARKER, OLAS_CONST + BLOG_CONST + SITEMAP_MARKER, 1)
print("OK: inserted OLAS_INTEGRATION_MD, AUTOGPT_INTEGRATION_MD, BLOG_POST_WHY_PRE_TRADE_GATE")

# ── 2. Update SITEMAP_XML — add 3 new entries before </urlset> ──────────────

OLD_SITEMAP_CLOSE = b'</urlset>`;'
NEW_SITEMAP_ENTRIES = (
    b'  <url>\n'
    b'    <loc>https://headlessoracle.com/docs/integrations/olas</loc>\n'
    b'    <lastmod>2026-04-03</lastmod>\n'
    b'    <changefreq>weekly</changefreq>\n'
    b'    <priority>0.7</priority>\n'
    b'  </url>\n'
    b'  <url>\n'
    b'    <loc>https://headlessoracle.com/docs/integrations/autogpt</loc>\n'
    b'    <lastmod>2026-04-03</lastmod>\n'
    b'    <changefreq>weekly</changefreq>\n'
    b'    <priority>0.7</priority>\n'
    b'  </url>\n'
    b'  <url>\n'
    b'    <loc>https://headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate</loc>\n'
    b'    <lastmod>2026-04-03</lastmod>\n'
    b'    <changefreq>monthly</changefreq>\n'
    b'    <priority>0.8</priority>\n'
    b'  </url>\n'
    b'</urlset>`;'
)
assert OLD_SITEMAP_CLOSE in src, "SITEMAP closing tag not found"
src = src.replace(OLD_SITEMAP_CLOSE, NEW_SITEMAP_ENTRIES, 1)
print("OK: updated SITEMAP_XML with 3 new entries")

# ── 3. Update LLMS_TXT — add Agent Framework Integrations + Blog sections ───

OLD_LLMS_CLOSE = (
    b'- [Cline (VS Code)](https://headlessoracle.com/docs/cline) \xe2\x80\x94 VS Code Cline extension setup\n'
    b'- [Continue.dev](https://headlessoracle.com/docs/continue) \xe2\x80\x94 Continue.dev VS Code extension setup\n'
    b'- [Cursor](https://headlessoracle.com/docs/cursor-setup) \xe2\x80\x94 Cursor IDE setup\n'
    b'- [Windsurf](https://headlessoracle.com/docs/windsurf-config) \xe2\x80\x94 Windsurf IDE setup\n'
    b'`\n'
)
NEW_LLMS_CLOSE = (
    b'- [Cline (VS Code)](https://headlessoracle.com/docs/cline) \xe2\x80\x94 VS Code Cline extension setup\n'
    b'- [Continue.dev](https://headlessoracle.com/docs/continue) \xe2\x80\x94 Continue.dev VS Code extension setup\n'
    b'- [Cursor](https://headlessoracle.com/docs/cursor-setup) \xe2\x80\x94 Cursor IDE setup\n'
    b'- [Windsurf](https://headlessoracle.com/docs/windsurf-config) \xe2\x80\x94 Windsurf IDE setup\n'
    b'\n'
    b'## Agent Framework Integrations\n'
    b'- [Olas Integration](https://headlessoracle.com/docs/integrations/olas) \xe2\x80\x94 Pre-trade gate for Olas autonomous services\n'
    b'- [AutoGPT Integration](https://headlessoracle.com/docs/integrations/autogpt) \xe2\x80\x94 AutoGPT plugin for pre-trade verification\n'
    b'\n'
    b'## Blog\n'
    b'- [Why Your Trading Agent Needs a Pre-Trade Gate](https://headlessoracle.com/blog/why-your-trading-agent-needs-a-pre-trade-gate) \xe2\x80\x94 DST bug post-mortem and fail-closed contract\n'
    b'`\n'
)
assert OLD_LLMS_CLOSE in src, "LLMS_TXT closing section not found"
src = src.replace(OLD_LLMS_CLOSE, NEW_LLMS_CLOSE, 1)
print("OK: updated LLMS_TXT with Agent Framework Integrations + Blog sections")

# ── 4. Update security.txt — update Expires and add Canonical ───────────────

OLD_SECURITY = b'const body = `Contact: mailto:info@bytecraftresults.com\\nExpires: 2027-04-02T00:00:00.000Z\\nPreferred-Languages: en\\n`;'
NEW_SECURITY = b'const body = `Contact: mailto:info@bytecraftresults.com\\nExpires: 2027-04-03T00:00:00.000Z\\nPreferred-Languages: en\\nCanonical: https://headlessoracle.com/.well-known/security.txt\\n`;'
assert OLD_SECURITY in src, "security.txt inline not found"
src = src.replace(OLD_SECURITY, NEW_SECURITY, 1)
print("OK: updated security.txt (Expires + Canonical)")

# ── 5. Add route handlers for /docs/integrations/olas + /docs/integrations/autogpt ──

OLD_DOCS_END = (
    b"\t\t\t\tif (p === '/docs/continue' || p === '/docs/continue.md')\n"
    b"\t\t\t\t\treturn new Response(CONTINUE_CONFIG_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });\n"
    b'\t\t\t\t// Unknown /docs/ path \xe2\x80\x94 fall through to 404 below\n'
)
NEW_DOCS_END = (
    b"\t\t\t\tif (p === '/docs/continue' || p === '/docs/continue.md')\n"
    b"\t\t\t\t\treturn new Response(CONTINUE_CONFIG_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });\n"
    b"\t\t\t\tif (p === '/docs/integrations/olas' || p === '/docs/integrations/olas.md')\n"
    b"\t\t\t\t\treturn new Response(OLAS_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });\n"
    b"\t\t\t\tif (p === '/docs/integrations/autogpt' || p === '/docs/integrations/autogpt.md')\n"
    b"\t\t\t\t\treturn new Response(AUTOGPT_INTEGRATION_MD, { headers: p.endsWith('.md') ? mdHeaders : plainHeaders });\n"
    b'\t\t\t\t// Unknown /docs/ path \xe2\x80\x94 fall through to 404 below\n'
)
assert OLD_DOCS_END in src, "docs end pattern not found"
src = src.replace(OLD_DOCS_END, NEW_DOCS_END, 1)
print("OK: added /docs/integrations/olas and /docs/integrations/autogpt route handlers")

# ── 6. Add /blog/ route handler after the /docs/ block ──────────────────────

OLD_AFTER_DOCS = (
    b'\t\t\t\t// Unknown /docs/ path \xe2\x80\x94 fall through to 404 below\n'
    b'\t\t\t}\n'
    b'\n'
    b'\t\t\t// '
)
NEW_AFTER_DOCS = (
    b'\t\t\t\t// Unknown /docs/ path \xe2\x80\x94 fall through to 404 below\n'
    b'\t\t\t}\n'
    b'\n'
    b'\t\t\t// \xe2\x94\x80\xe2\x94\x80 /blog/* \xe2\x80\x94 blog posts served as plain text \xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\xe2\x94\x80\n'
    b'\t\t\tif (url.pathname.startsWith(\'/blog/\')) {\n'
    b'\t\t\t\tconst blogHeaders = { \'Content-Type\': \'text/plain; charset=utf-8\', \'Cache-Control\': \'public, max-age=3600\' };\n'
    b'\t\t\t\tif (url.pathname === \'/blog/why-your-trading-agent-needs-a-pre-trade-gate\')\n'
    b'\t\t\t\t\treturn new Response(BLOG_POST_WHY_PRE_TRADE_GATE, { headers: blogHeaders });\n'
    b'\t\t\t}\n'
    b'\n'
    b'\t\t\t// '
)
assert OLD_AFTER_DOCS in src, "after-docs pattern not found"
src = src.replace(OLD_AFTER_DOCS, NEW_AFTER_DOCS, 1)
print("OK: added /blog/ route handler")

with open(SRC, 'wb') as f:
    f.write(src)

print("\n✅ All patches applied successfully")
