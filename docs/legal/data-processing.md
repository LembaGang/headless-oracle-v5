<!-- DRAFT — Not yet reviewed by legal counsel. Do not publish to
production until reviewed. Last updated: 2026-04-08 -->

# Headless Oracle — Data Processing Addendum

**Last Updated**: 2026-04-08

This Data Processing Addendum ("DPA") supplements the [Terms of Service](terms-of-service.md) and applies to enterprise customers requiring a formal data processing agreement.

## 1. Definitions

- **Controller**: The customer using the Headless Oracle API
- **Processor**: Michael Msebenzi / LembaGang, operating the Headless Oracle service
- **Personal Data**: Any data relating to an identified or identifiable natural person processed through the Service
- **Sub-processor**: A third party engaged by the Processor to process Personal Data

## 2. Scope of Processing

The Processor processes the following categories of Personal Data on behalf of the Controller:

| Category | Data Elements | Purpose |
|---|---|---|
| Technical identifiers | Hashed IP addresses, API key hashes | Authentication, rate limiting |
| Contact information | Email address (if provided) | Key delivery, service communication |
| Usage data | Request timestamps, tool call counts | Service delivery, abuse prevention |
| Client metadata | User agent, ASN, country | Telemetry, service improvement |

## 3. Processing Instructions

The Processor shall process Personal Data only:
- To provide the Service as described in the Terms of Service
- As documented in this DPA
- As required by applicable law

## 4. Sub-processors

The following sub-processors are authorized:

| Sub-processor | Location | Purpose | Data Processed |
|---|---|---|---|
| Cloudflare, Inc. | Global (300+ PoPs) | Infrastructure, CDN, Workers runtime, KV storage | Request metadata, hashed IPs |
| Supabase, Inc. | US (AWS) | API key management database | Key hashes, email, plan data |
| Paddle.com Market Ltd | UK | Billing and subscription management | Email, transaction records |
| Coinbase, Inc. | US | x402 payment facilitation | Transaction hashes (public blockchain data) |
| Resend, Inc. | US | Transactional email delivery | Email addresses |

The Processor will notify the Controller at least 30 days before engaging a new sub-processor, providing an opportunity to object.

## 5. Data Location

- **Primary processing**: Cloudflare Workers edge network (300+ locations globally, request routed to nearest PoP)
- **KV storage**: Cloudflare global network (replicated)
- **Durable storage**: Supabase (US region, AWS infrastructure)
- **Billing data**: Paddle (UK/EU)

## 6. Security Measures

### Encryption
- **In transit**: TLS 1.3 on all connections
- **At rest**: Cloudflare KV encrypted at rest by Cloudflare's infrastructure
- **Signing keys**: Ed25519 private key stored as Cloudflare Worker secret (encrypted, never logged)

### Access Control
- Single-operator system (sole founder access)
- Cloudflare dashboard access via 2FA
- Supabase access via service role key (stored as Worker secret)
- No shared credentials

### Data Minimization
- IP addresses hashed before storage (SHA-256, not reversible)
- No payment card data touches our infrastructure (Paddle handles PCI compliance)
- Telemetry counters aggregate by day — no per-request logs retained beyond 48h

## 7. Data Subject Rights

The Processor will assist the Controller in responding to data subject requests (access, rectification, erasure, portability, restriction, objection) within the timeframes required by applicable law.

Contact for data subject requests: privacy@headlessoracle.com

## 8. Data Breach Notification

The Processor will notify the Controller of any personal data breach without undue delay, and in any event within 72 hours of becoming aware of the breach, providing:
- Nature of the breach
- Categories and approximate number of data subjects affected
- Likely consequences
- Measures taken or proposed to address the breach

## 9. International Transfers

Where Personal Data is transferred outside the EEA, such transfers are made on the basis of:
- EU Standard Contractual Clauses (Module 2: Controller to Processor)
- Cloudflare's Data Processing Addendum (incorporating SCCs)
- Supabase's Data Processing Agreement

## 10. Audit Rights

The Controller may audit the Processor's compliance with this DPA, subject to:
- 30 days' written notice
- Reasonable scope and duration
- Confidentiality obligations
- Costs borne by the Controller

## 11. Term and Termination

This DPA is effective for the duration of the service agreement. Upon termination:
- Active Personal Data deleted within 30 days
- KV telemetry data expires automatically (25h–90 day TTL)
- Backup retention as required by law

## 12. Contact

Data protection inquiries: legal@headlessoracle.com
Data subject requests: privacy@headlessoracle.com
