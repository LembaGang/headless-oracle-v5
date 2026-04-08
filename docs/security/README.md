# Security Documentation

Last updated: 2026-04-08

## Index

| Document | Purpose |
|----------|---------|
| [/SECURITY.md](/SECURITY.md) | Responsible disclosure policy |
| [dependency-audit.md](dependency-audit.md) | npm audit results and risk assessment |
| [license-policy.md](license-policy.md) | Approved/prohibited licenses for dependencies |
| [sbom.json](sbom.json) | CycloneDX Software Bill of Materials |
| [secret-scan-results.md](secret-scan-results.md) | Secret detection scan results |

## Quick Summary

- **Production dependencies:** 3 packages, all MIT/0BSD
- **Copyleft licenses:** None in production tree
- **npm audit (production):** 0 vulnerabilities
- **npm audit (dev):** 4 high (all in test tooling, not deployed)
- **Secrets in git:** None found (test-only keys in CI are non-secret)
- **SBOM format:** CycloneDX JSON

## Security Architecture

See [/SECURITY.md](/SECURITY.md) for the full security policy and
responsible disclosure process.

The worker deploys with:
- HSTS, CSP, X-Frame-Options on all responses
- Ed25519 cryptographic signing on all receipts
- Fail-closed architecture (UNKNOWN = CLOSED)
- 60-second receipt TTL
- HMAC-SHA256 webhook delivery signatures
- x402 replay protection via KV
