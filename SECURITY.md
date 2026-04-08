# Security Policy

Last updated: 2026-04-08

## Reporting Security Vulnerabilities

If you discover a security vulnerability in Headless Oracle, please
report it responsibly.

**Email:** security@headlessoracle.com
**PGP Key:** Available on request

### Response Timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix target:** within 90 days for critical/high severity

### Safe Harbor

We will not pursue legal action against security researchers who
discover and report vulnerabilities in good faith, following this
policy.

## Scope

**In scope:**
- headlessoracle.com and api.headlessoracle.com
- The `headless-oracle-mcp` npm package
- The Headless Oracle MCP server protocol implementation
- The `@headlessoracle/verify` npm package
- Ed25519 signature verification and receipt signing

**Out of scope:**
- Social engineering attacks
- Denial of service attacks
- Third-party services (Cloudflare, Supabase, Paddle, Coinbase CDP)
- Issues in dependencies maintained by other projects

## What We Ask

- Do not access or modify other users' data
- Do not degrade service availability
- Provide sufficient detail to reproduce the vulnerability
- Allow reasonable time for remediation before disclosure

## Security Architecture

Headless Oracle is designed with security as a first principle:

- **Ed25519 cryptographic signatures** on all market-state receipts
- **Fail-closed architecture**: UNKNOWN status always treated as CLOSED
- **60-second receipt TTL**: prevents stale data from being acted upon
- **No secrets in client responses**: signing keys never leave the server
- **KV-based replay protection** for x402 payments (600s TTL)
- **HMAC-SHA256 webhook signatures** for delivery verification
- **HSTS, CSP, X-Frame-Options** on all HTTP responses

## Disclosure

- `/.well-known/security.txt` — RFC 9116 machine-readable security contact
- This file (`SECURITY.md`) — human-readable security policy
