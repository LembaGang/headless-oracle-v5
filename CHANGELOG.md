# Changelog

All notable changes to Headless Oracle are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Documentation reorganization: architecture/, api/, operations/, legal/, business/ structure
- Legal documents: Terms of Service, Privacy Policy, Acceptable Use, IP Ownership, Data Processing Addendum
- Operational docs: deployment guide, rollback procedure, incident response, monitoring, SLA
- Business docs: pricing strategy, competitive analysis, metrics dashboard
- Professional README.md

## [2026-04-08] — Acquisition Readiness Sprint 1

### Added
- Security headers on ALL responses: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, CSP (725 tests)
- `X-Attestation-Mode` header (demo/trial/live) on all signed receipts
- SECURITY.md responsible disclosure policy (security@headlessoracle.com)
- CI/CD pipeline: GitHub Actions for test, audit, and smoke tests
- Dependabot for weekly npm dependency updates
- CODEOWNERS and PR template
- CycloneDX SBOM (docs/security/sbom.json)
- Dependency audit with license compliance verification
- Architecture Decision Records (6 ADRs in docs/architecture/adr/)
- CONTRIBUTING.md and .env.example
- LICENSE corrected to MIT

### Security
- All production dependencies verified MIT/0BSD (zero copyleft)
- npm audit: 0 production vulnerabilities
- Secret scan: clean (no credentials in codebase)

## [2026-04-08] — Meta-Sprint (Day 42)

### Added
- Live production smoke test suite (11 tests)
- CLAUDE.md rewritten as definitive onboarding document
- Context rule files: business context, architecture map, sprint playbook, telemetry guide

## [2026-04-07] — Distribution Sprint (Day 41)

### Added
- In-memory API key cache with 60s TTL for sub-millisecond auth
- llms.txt spec-compliant index and llms-full.txt comprehensive docs
- MCP clientInfo capture on initialize for distribution analytics
- AGENTS.md rewrite for agent discovery
- `agent_upgrade_paths` on 402 responses (x402, API key, demo options)
- MCP registry submission tracker
- GitHub Action: market-gate for CI/CD pipelines
- Free trial: 3 signed receipts/day per IP on /v5/status
- GET /v5/briefing: daily market intelligence snapshot
- ai-hedge-fund PR: market_state_verification_agent
- dev.to launch post draft

### Fixed
- `free_unlimited` renamed to `free_500_daily` in agent_upgrade_paths

## [2026-04-06] — Payment Friction Sprint (Day 40)

### Added
- Unified `verifyPaymentAnyFormat()` accepting both raw JSON and base64 payment headers
- 402 funnel metrics at 5 distinct exit points
- `buildAgentActions()` helper for consistent 402 response structure
- x402 payment stats tracking (payment count, first/last payment timestamps)

### Fixed
- 5 of 6 X-Payment entry points now accept both formats (was raw JSON only)
- Sandbox crash: `sbPayment is not defined` when minting credit key

### Security
- Removed debug console.log from x402 facilitator (payment header content was leaking)

## [2026-04-05] — Telemetry Sprint (Day 37)

### Added
- Referrer tracking on every request with external Referer header
- GET /v5/referrers: public referrer domain counts
- Status code counters on every response via json() helper
- GET /v5/metrics/public: social proof endpoint
- Convenience redirects: /npm, /pypi, /github

## [2026-04-03] — Weekend Sprint (Day 35-36)

### Added
- 5th MCP tool: get_payment_options (upgrade ladder)
- POST /v5/verify: public REST receipt verification
- GET /x402: x402 Foundation compatibility declaration
- Integration guides: Olas, AutoGPT
- Blog: "Why Your Trading Agent Needs a Pre-Trade Gate"

## [2026-03-30] — Infrastructure Sprint (Day 32-33)

### Added
- MPAS 1.0 spec published
- Credit packs via Paddle
- Webhook CRUD (subscribe, list, delete, test)
- WebhookDispatcher Durable Object
- GET /v5/webhooks/health

### Fixed
- OpenAPI spec: 10 paths correctly nested inside paths object

## [2026-03-25] — Coverage Sprint (Day 28)

### Added
- 5 extended exchanges: XCBT, XNYM (CME overnight), XCBO (Cboe), XCOI (Coinbase 24/7), XBIN (Binance 24/7)
- `mic_type: "iso" | "convention"` on all exchange configs
- /v5/stream: SSE via StreamCoordinator Durable Object
- /v5/conformance-vectors: 5 live-signed test vectors
- Go SDK: github.com/LembaGang/headless-oracle-go
- settlement_window in /v5/schedule (T+1/T+2)
