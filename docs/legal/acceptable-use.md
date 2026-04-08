<!-- DRAFT — Not yet reviewed by legal counsel. Do not publish to
production until reviewed. Last updated: 2026-04-08 -->

# Headless Oracle — Acceptable Use Policy

**Last Updated**: 2026-04-08

This policy supplements the [Terms of Service](terms-of-service.md).

## Prohibited Activities

You may NOT use the Headless Oracle API to:

### Market Manipulation
- Use market-state attestations as part of a scheme to manipulate market prices, create artificial trading volume, or engage in wash trading
- Misrepresent the Service's attestations as real-time exchange feeds for regulatory filings

### Rate Limit Circumvention
- Create multiple accounts, rotate IP addresses, or use proxy networks to bypass free trial limits (3/day per IP)
- Share, resell, or pool API keys to exceed plan rate limits
- Automate key provisioning (sandbox or free tier) beyond reasonable use

### Receipt Redistribution
- Redistribute signed receipts as your own service or product
- Strip, modify, or re-sign receipts and present them as authentic Headless Oracle attestations
- Operate a competing market-state attestation service that proxies Headless Oracle receipts

### Cryptographic Attacks
- Attempt to reverse-engineer, derive, factor, or reconstruct the Ed25519 signing private key
- Submit forged receipts or signatures to downstream systems claiming Headless Oracle origin
- Exploit replay windows beyond the 60-second receipt TTL

### Infrastructure Abuse
- Perform automated scraping beyond published API rate limits
- Send requests designed to exhaust Worker CPU time, KV storage, or Durable Object capacity
- Probe for vulnerabilities without prior written authorization (see [SECURITY.md](/SECURITY.md) for responsible disclosure)

### Legal Violations
- Use the Service for any purpose that violates applicable laws or regulations
- Use the Service to facilitate money laundering, sanctions evasion, or terrorist financing

## Enforcement

Violations may result in:
1. **Warning**: First minor violation — email notification with 7-day remediation window
2. **Rate reduction**: Repeated minor violations — temporary rate limit reduction
3. **Key revocation**: Serious or repeated violations — immediate API key deactivation
4. **Permanent ban**: Egregious violations — permanent block with no refund

We reserve the right to skip escalation steps for serious violations.

## Reporting

Report suspected violations to: legal@headlessoracle.com

## Good Faith Use

Security researchers acting in good faith under our [responsible disclosure policy](/SECURITY.md) are not in violation of this policy, provided they follow the safe harbor guidelines.
