# MCP Registry Submissions — Headless Oracle

Last updated: 2026-04-07

## Status

| Registry | Listed? | Action | Date |
|---|---|---|---|
| Official MCP Registry (GitHub) | YES | Already listed | Pre-launch |
| Smithery (smithery.ai) | YES | Already listed | Pre-launch |
| Glama (glama.ai) | YES | Already listed | Pre-launch |
| npm (headless-oracle-mcp) | YES | Published v1.0.2 | Apr 4 2026 |
| PulseMCP (pulsemcp.com) | YES | Listed as "Official" — ingested from MCP Registry | Feb 17 2026 |
| TensorBlock/awesome-mcp-servers | PENDING | PR submitted 2026-04-07 | Apr 7 2026 |
| mcp.so | PENDING | Manual web submission needed | — |
| mcpserverfinder.com | PENDING | Email submission needed | — |

## Submission Details

### PulseMCP (pulsemcp.com)
- **Status**: Already listed. Description may show outdated "7 exchanges" — verify.
- **Submission URL**: https://www.pulsemcp.com/submit
- **Contact**: hello@pulsemcp.com
- **Action**: Verify listing is current (28 exchanges, x402, 706 tests).

### TensorBlock/awesome-mcp-servers (GitHub)
- **Status**: PR submitted to Finance & Crypto section.
- **Repo**: https://github.com/TensorBlock/awesome-mcp-servers
- **Section**: Finance & Crypto
- **Entry**: `- [LembaGang/headless-oracle-v5](https://github.com/LembaGang/headless-oracle-v5): Cryptographically signed (Ed25519) market-state attestations for 28 global exchanges. Returns OPEN/CLOSED/HALTED/UNKNOWN with 60s TTL receipts. Fail-closed architecture. MCP endpoint: https://headlessoracle.com/mcp with 5 tools.`
- **Action**: Monitor PR for maintainer feedback.

### mcp.so
- **Status**: Not listed (site returns 403 to automated fetches).
- **How to submit manually**:
  1. Visit https://mcp.so in a browser
  2. Look for "Submit" or "Add Server" button in navigation
  3. Use the YAML block from `docs/mcp-listing.md` for all required fields:
     - Name: Headless Oracle
     - URL: https://headlessoracle.com/mcp
     - GitHub: https://github.com/LembaGang/headless-oracle-v5
     - Description: Cryptographically signed market-state attestations for 28 global exchanges
     - Category: Finance
     - Tools: get_market_status, get_market_schedule, list_exchanges, verify_receipt, get_payment_options
  4. Submit and note the listing URL

### mcpserverfinder.com
- **Status**: Not listed. Not in finance, stock-market, or financial-data categories.
- **How to submit**:
  1. Send email to `info@mcpserverfinder.com`
  2. Subject: "MCP Server Submission: Headless Oracle — Signed Market State Attestations"
  3. Body:
     ```
     Name: Headless Oracle
     GitHub: https://github.com/LembaGang/headless-oracle-v5
     MCP Endpoint: https://headlessoracle.com/mcp
     npm: npx headless-oracle-mcp
     Category: finance / stock-market / financial-data
     
     Description: Cryptographically signed (Ed25519) market-state attestations 
     for 28 global exchanges. Returns OPEN/CLOSED/HALTED/UNKNOWN with 60-second 
     TTL receipts. Fail-closed architecture — UNKNOWN is always CLOSED. 
     5 MCP tools. 706 tests. x402 micropayments on Base.
     
     Website: https://headlessoracle.com
     Docs: https://headlessoracle.com/docs
     ```
  4. Wait for confirmation email
