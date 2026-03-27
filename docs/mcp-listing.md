## MCP Directory Listing — Headless Oracle

Use this block for submissions to Smithery, MCP.so, and any other MCP registry.

---

```yaml
name: Headless Oracle
description: Real-time market status (OPEN/CLOSED/HALTED/UNKNOWN) for 28 global exchanges (equities,
  derivatives, and 24/7 crypto) with Ed25519-signed receipts. Designed for AI agents and automated
  trading systems. Fail-closed: UNKNOWN always means CLOSED. Handles DST, holidays, lunch breaks,
  early closes, and circuit breakers.
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
        description: MIC code — XNYS, XNAS, XLON, XJPX, XPAR, XHKG, XSES, XASX, XBOM, XNSE, XSHG, XSHE, XKRX, XJSE, XBSP, XSWX, XMIL, XIST, XSAU, XDFM, XNZE, XHEL, XSTO, XCBT, XNYM, XCBO, XCOI, XBIN
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
      List all 28 supported exchanges (equities, derivatives, and 24/7 crypto) with MIC codes,
      names, timezones, mic_type (iso|convention), and trading hours.
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
  - { mic: XNYS, name: New York Stock Exchange, timezone: America/New_York, mic_type: iso }
  - { mic: XNAS, name: NASDAQ, timezone: America/New_York, mic_type: iso }
  - { mic: XLON, name: London Stock Exchange, timezone: Europe/London, mic_type: iso }
  - { mic: XJPX, name: Japan Exchange Group, timezone: Asia/Tokyo, mic_type: iso }
  - { mic: XPAR, name: Euronext Paris, timezone: Europe/Paris, mic_type: iso }
  - { mic: XHKG, name: Hong Kong Exchanges and Clearing, timezone: Asia/Hong_Kong, mic_type: iso }
  - { mic: XSES, name: Singapore Exchange, timezone: Asia/Singapore, mic_type: iso }
  - { mic: XASX, name: ASX Australia, timezone: Australia/Sydney, mic_type: iso }
  - { mic: XBOM, name: BSE India, timezone: Asia/Kolkata, mic_type: iso }
  - { mic: XNSE, name: NSE India, timezone: Asia/Kolkata, mic_type: iso }
  - { mic: XSHG, name: Shanghai Stock Exchange, timezone: Asia/Shanghai, mic_type: iso }
  - { mic: XSHE, name: Shenzhen Stock Exchange, timezone: Asia/Shanghai, mic_type: iso }
  - { mic: XKRX, name: Korea Exchange, timezone: Asia/Seoul, mic_type: iso }
  - { mic: XJSE, name: Johannesburg Stock Exchange, timezone: Africa/Johannesburg, mic_type: iso }
  - { mic: XBSP, name: B3 Brazil, timezone: America/Sao_Paulo, mic_type: iso }
  - { mic: XSWX, name: SIX Swiss Exchange, timezone: Europe/Zurich, mic_type: iso }
  - { mic: XMIL, name: Borsa Italiana, timezone: Europe/Rome, mic_type: iso }
  - { mic: XIST, name: Borsa Istanbul, timezone: Europe/Istanbul, mic_type: iso }
  - { mic: XSAU, name: Saudi Exchange (Tadawul), timezone: Asia/Riyadh, mic_type: iso }
  - { mic: XDFM, name: Dubai Financial Market, timezone: Asia/Dubai, mic_type: iso }
  - { mic: XNZE, name: New Zealand Exchange, timezone: Pacific/Auckland, mic_type: iso }
  - { mic: XHEL, name: Nasdaq Helsinki, timezone: Europe/Helsinki, mic_type: iso }
  - { mic: XSTO, name: Nasdaq Stockholm, timezone: Europe/Stockholm, mic_type: iso }
  - { mic: XCBT, name: CME Futures (overnight), timezone: America/Chicago, mic_type: iso }
  - { mic: XNYM, name: NYMEX (overnight), timezone: America/Chicago, mic_type: iso }
  - { mic: XCBO, name: Cboe Options, timezone: America/Chicago, mic_type: iso }
  - { mic: XCOI, name: Coinbase (24/7), timezone: UTC, mic_type: convention }
  - { mic: XBIN, name: Binance (24/7), timezone: UTC, mic_type: convention }
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
