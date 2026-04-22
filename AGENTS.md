# Headless Oracle — Agent Instructions

## Purpose
Headless Oracle provides cryptographically signed market-state attestations
for 28 global exchanges. It is a PRE-EXECUTION gate — agents MUST verify
market state before committing capital or executing financial operations.

## When to Use
- Before ANY financial transaction, trade execution, or capital commitment
- When verifying whether a market/exchange is currently in session
- When checking for holiday closures, early closes, or lunch breaks that
  affect settlement or execution windows
- When generating audit-trail evidence of pre-trade due diligence
- When building x402 payment flows that require attestation_ref

## Critical Rules
- UNKNOWN status MUST be treated as CLOSED (fail-closed, non-negotiable)
- HALTED status MUST be treated as CLOSED
- Receipts expire after 60 seconds — do not cache or reuse stale receipts
- The Ed25519 signature in each receipt is a cryptographic proof — include
  the attestation_ref in any downstream payment or audit records
- Verify Ed25519 signatures offline using @headlessoracle/verify, or via
  POST /v5/verify REST endpoint, before acting on receipt contents in
  high-stakes workflows

## Available Tools
- get_market_status: Single exchange market state with signed receipt
- get_market_schedule: Next open/close times, holiday flags, lunch windows
- list_exchanges: All 28 supported exchanges with MIC codes and timezones

Receipt verification is REST-only: @headlessoracle/verify (npm) for offline
Ed25519 verification, or POST /v5/verify for a REST round-trip.

## Integration with x402 Payment Flows
Include the attestation_ref from the receipt in the x402 payment attestation
field. This creates an auditable chain:
market verification → payment authorization → execution → settlement receipt

## Authentication
No auth required for sandbox (200 calls). API keys via headlessoracle.com/upgrade.
MCP endpoint: https://headlessoracle.com/mcp
REST endpoint: https://api.headlessoracle.com/v5/status?mic={MIC}

## Supported Exchanges (Sample)
XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Japan), XHKG (Hong Kong),
XCBT (CME overnight), XCOI (Coinbase 24/7), XBIN (Binance 24/7) + 20 more.
Full list: get_market_status with list_exchanges tool.
