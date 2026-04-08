<!-- DRAFT — Not yet reviewed by legal counsel. Do not publish to
production until reviewed. Last updated: 2026-04-08 -->

# Headless Oracle — Privacy Policy

**Effective Date**: [To be set upon legal review]
**Last Updated**: 2026-04-08

## 1. Who We Are

Headless Oracle is operated by Michael Msebenzi / LembaGang from the Republic of South Africa. Contact: privacy@headlessoracle.com

## 2. What We Collect

### Data We Collect

| Data | Purpose | Storage |
|---|---|---|
| IP address (SHA-256 hashed) | Free trial rate limiting, abuse prevention | KV, 25h TTL |
| Email address | API key delivery (when you request a key) | Supabase |
| MCP client metadata | User agent, ASN organization, country, city | KV, 48h TTL |
| Request timestamps | Telemetry, usage tracking | KV, 25h–90 day TTL |
| API key hash (SHA-256) | Authentication, usage tracking | KV + Supabase |
| Paddle customer ID | Billing management | Supabase |

### Data We Do NOT Collect

- Trading data or portfolio information
- Personal financial information
- Payment card numbers (handled entirely by Paddle)
- Raw IP addresses (always hashed before storage)
- Browser cookies (we are an API-only product)

## 3. How We Use Your Data

- **Service delivery**: Authenticating requests, enforcing rate limits, delivering signed receipts
- **Abuse prevention**: Detecting and blocking excessive usage, trial abuse, replay attacks
- **Telemetry**: Aggregated usage metrics (unique clients, tool call counts, referrer domains) — no individual tracking
- **Communication**: Sending API keys via email, service announcements (if subscribed)

## 4. Data Retention

| Data Type | Retention Period |
|---|---|
| Telemetry counters (KV) | 25 hours (daily counters) |
| MCP client records (KV) | 48 hours |
| Weekly digest summaries | 90 days |
| API key records | While key is active + 30 days after deactivation |
| Billing records | As required by law (typically 7 years) |

## 5. Third-Party Services

We share data with the following service providers, each acting as a data processor:

| Provider | Purpose | Data Shared |
|---|---|---|
| Cloudflare | Infrastructure (Workers, KV, DNS) | Request metadata (IP, headers) |
| Supabase | API key management | Key hash, email, plan, billing IDs |
| Paddle | Billing and subscriptions | Email, transaction data |
| Coinbase CDP | x402 micropayment facilitation | Transaction hash (on-chain, public) |
| Resend | Email delivery | Email address, key content |

No data is sold to third parties. No data is used for advertising.

## 6. Business Transfer

If Headless Oracle is acquired, merged, or its assets are sold, your information may be transferred to the acquiring entity. The acquiring entity will be bound by this Privacy Policy for existing data. We will notify users via email (where available) of any such transfer.

## 7. Data Deletion

To request deletion of your data, email privacy@headlessoracle.com with:
- Your API key prefix (first 8 characters) or the email associated with your key
- What data you want deleted

We will process deletion requests within 30 days. Note: hashed IP data in KV expires automatically within 48 hours.

## 8. Your Rights (GDPR)

If you are in the EEA, you have the right to:
- **Access**: Request a copy of data we hold about you
- **Rectification**: Correct inaccurate data
- **Erasure**: Request deletion of your data
- **Portability**: Receive your data in a structured, machine-readable format
- **Restriction**: Request we limit processing of your data
- **Objection**: Object to processing based on legitimate interests

To exercise these rights: privacy@headlessoracle.com

## 9. Cookies

We do not use cookies. Headless Oracle is an API-only product with no browser-based user interface that sets cookies.

## 10. Children

The Service is not directed at children under 16. We do not knowingly collect data from children.

## 11. Changes to This Policy

We will notify users of material changes via email (for registered users) at least 30 days before changes take effect.

## 12. Contact

Privacy inquiries: privacy@headlessoracle.com
General inquiries: legal@headlessoracle.com
