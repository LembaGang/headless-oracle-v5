## MCP Directory Listing — Headless Oracle

Use this block for submissions to Smithery, MCP.so, and any other MCP registry.

---

```yaml
name: Headless Oracle
description: Real-time market status (OPEN/CLOSED/HALTED/UNKNOWN) for 7 global stock exchanges
  with Ed25519-signed receipts. Designed for AI agents and automated trading systems. Fail-closed:
  UNKNOWN always means CLOSED. Handles DST, holidays, lunch breaks, early closes, and circuit breakers.
endpoint: https://headlessoracle.com/mcp
protocol: MCP 2024-11-05
transport: Streamable HTTP (POST)
tools:
  - name: get_market_status
    description: >
      Get the current operational status of a specific exchange. Returns a cryptographically
      signed receipt with OPEN, CLOSED, HALTED, or UNKNOWN status. HALTED means a circuit
      breaker override is active. UNKNOWN means the oracle cannot determine state — treat as CLOSED.
    inputs:
      - name: mic
        type: string
        required: true
        description: ISO 10383 MIC code — XNYS, XNAS, XLON, XJPX, XPAR, XHKG, or XSES
  - name: get_market_schedule
    description: >
      Get the next open/close times for a specific exchange. Returns times in UTC, plus
      holiday flags, early-close (half-day) details, and lunch break windows where applicable.
      Includes data_coverage_years so agents know when holiday data runs out.
    inputs:
      - name: mic
        type: string
        required: true
        description: ISO 10383 MIC code
  - name: list_exchanges
    description: >
      List all 7 supported exchanges with MIC codes, names, timezones, and trading hours.
      Use this to discover which exchanges are supported before calling get_market_status.
    inputs: []
auth: None required for MCP tools (uses /v5/demo internally — public, no API key)
category: Finance / Trading / Market Data
tags:
  - market-status
  - trading
  - defi
  - rwa
  - ed25519
  - cryptographic-signatures
  - fail-closed
  - market-hours
  - exchange-calendar
  - ai-agents
exchanges:
  - mic: XNYS
    name: New York Stock Exchange
    timezone: America/New_York
  - mic: XNAS
    name: NASDAQ
    timezone: America/New_York
  - mic: XLON
    name: London Stock Exchange
    timezone: Europe/London
  - mic: XJPX
    name: Japan Exchange Group (Tokyo)
    timezone: Asia/Tokyo
  - mic: XPAR
    name: Euronext Paris
    timezone: Europe/Paris
  - mic: XHKG
    name: Hong Kong Exchanges and Clearing
    timezone: Asia/Hong_Kong
  - mic: XSES
    name: Singapore Exchange
    timezone: Asia/Singapore
safety_guarantees:
  - fail_closed: true
    description: UNKNOWN status means CLOSED — the oracle never fails open
  - signed_receipts: true
    description: Every response is Ed25519-signed; verifiable without trusting the operator
  - receipt_ttl_seconds: 60
    description: Receipts expire after 60 seconds to prevent stale-data decisions
  - portable: true
    description: Receipts are bearer attestations — any agent can verify without calling the API
website: https://headlessoracle.com
documentation: https://headlessoracle.com/docs
openapi: https://headlessoracle.com/openapi.json
llms_txt: https://headlessoracle.com/llms.txt
agent_json: https://headlessoracle.com/.well-known/agent.json
key_registry: https://headlessoracle.com/v5/keys
well_known: https://headlessoracle.com/.well-known/oracle-keys.json
github: https://github.com/LembaGang/headless-oracle-v5
npm: "@headlessoracle/verify"
npm_url: https://www.npmjs.com/package/@headlessoracle/verify
license:
  api: Proprietary
  verify_sdk: MIT
```

---

## Smithery Submission

File already created at `smithery.yaml` in the repo root. Submit at https://smithery.ai/new.

## Notes for Reviewers

- The MCP endpoint is public (no API key required for the three tools listed above).
- Production `/v5/status` receipts require an `X-Oracle-Key` header — this is a REST-only concern,
  not exposed through MCP tools, which use the demo path internally.
- Signed receipts can be verified independently using `@headlessoracle/verify` (npm) or via
  the Web Crypto API with the public key from `/.well-known/oracle-keys.json`.
