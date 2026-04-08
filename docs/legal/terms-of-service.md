<!-- DRAFT — Not yet reviewed by legal counsel. Do not publish to
production until reviewed. Last updated: 2026-04-08 -->

# Headless Oracle API — Terms of Service

**Effective Date**: [To be set upon legal review]
**Last Updated**: 2026-04-08

## 1. Service Description

Headless Oracle ("the Service") provides Ed25519-signed market-state attestations for 28 global exchanges via REST API and Model Context Protocol (MCP). The Service answers one question: "Is this exchange open right now?" Every response is cryptographically signed.

The Service is operated by Michael Msebenzi / LembaGang ("we", "us", "our") from the Republic of South Africa.

## 2. Acceptance of Terms

By accessing or using the Service, you ("you", "your") agree to be bound by these Terms. If you do not agree, do not use the Service.

## 3. Service Tiers

| Tier | Access | Limit |
|---|---|---|
| Free Trial | No signup | 3 signed receipts/day per IP |
| Free | API key (email signup) | 500 calls/day |
| Sandbox | Instant key | 200 calls, 7-day expiry |
| x402 Per-Request | On-chain USDC payment | Unlimited |
| Credits | One-time purchase | Per balance |
| Builder | $99/month subscription | 50,000 calls/day |
| Pro | $299/month subscription | 200,000 calls/day |
| Protocol | Custom agreement | Unlimited |

## 4. Acceptable Use

You agree NOT to:

- Use the Service to manipulate markets or engage in market manipulation
- Circumvent rate limits, trial restrictions, or authentication mechanisms
- Redistribute signed receipts as your own service or claim to be the originator
- Attempt to reverse-engineer, derive, or reconstruct the signing private key
- Perform automated scraping beyond published API rate limits
- Use the Service for any activity that violates applicable law
- Interfere with or disrupt the Service infrastructure

See also: [Acceptable Use Policy](acceptable-use.md)

## 5. Disclaimers

**THE SERVICE IS NOT INVESTMENT ADVICE.** Market-state attestations indicate whether an exchange's regular trading session is scheduled to be open or closed. They do not constitute investment recommendations, trading signals, or financial advice.

**THE SERVICE DOES NOT GUARANTEE ACCURACY.** While we maintain holiday calendars, lunch break schedules, and DST transition data for 28 exchanges, we do not guarantee that the reported state matches the actual state of any exchange at any given moment. Circuit breakers, unscheduled closures, and exchange-specific anomalies may not be reflected in real time.

**THE SERVICE IS NOT A SUBSTITUTE FOR EXCHANGE DATA FEEDS.** For regulatory or compliance purposes requiring authoritative exchange status, use the exchange's own data feeds.

## 6. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ANY CLAIMS ARISING FROM YOUR USE OF THE SERVICE SHALL NOT EXCEED THE TOTAL FEES PAID BY YOU TO US IN THE 12 MONTHS PRECEDING THE CLAIM.

IN NO EVENT SHALL WE BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, TRADING LOSSES, OR DATA LOSS, REGARDLESS OF THE THEORY OF LIABILITY.

## 7. Assignment

We may assign these Terms without your consent in connection with a merger, acquisition, corporate reorganization, or sale of all or substantially all of our assets. The acquiring entity will assume all obligations under these Terms.

## 8. Data Handling

Our collection and use of data is governed by our [Privacy Policy](privacy-policy.md). By using the Service, you consent to such collection and use.

## 9. Service Level

Service level objectives are documented in our [SLA](../operations/sla.md). SLA credits apply only to Builder plan and above.

## 10. Intellectual Property

All intellectual property rights in the Service, including the signing infrastructure, receipt format, and specifications (SMA Protocol, APTS, MPAS), are owned by Michael Msebenzi / LembaGang. See [IP Ownership](ip-ownership.md).

The receipt format and verification SDKs are published under the MIT license to enable consumer adoption.

## 11. Modification of Terms

We will provide at least 30 days' notice before making material changes to these Terms. Notice will be provided via email (for users with registered API keys) and by posting the updated Terms. Continued use after the notice period constitutes acceptance.

## 12. Termination

Either party may terminate this agreement with 30 days' written notice. We may terminate immediately if you violate the Acceptable Use Policy. Upon termination:
- API keys will be deactivated
- Unused credits are non-refundable
- Active subscriptions will not be renewed

## 13. Governing Law

These Terms are governed by the laws of the Republic of South Africa. Any disputes shall be resolved in the courts of South Africa.

## 14. Contact

For questions about these Terms: legal@headlessoracle.com
