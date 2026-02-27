Back to Headless Oracle
Terms of Service
Beta
Version 5.0-BETA (Interim)
Effective: 16 February 2026
Last Updated: 27 February 2026
Contents
Nature of Service
Key Definitions
Acceptance of Terms
No Liability for Execution
The Fail-Closed Obligation
Cryptographic Verification
Acceptable Use
Data Accuracy & Limitations
Intellectual Property
Privacy & Data Collection
Beta Disclaimer
Indemnification
Limitation of Liability
Termination
Governing Law
Changes to Terms
Contact
01
Nature of Service
Headless Oracle provides a defensive execution layer for automated systems. The Service delivers cryptographically signed attestations regarding the observed operational status of specific financial market venues. Each response constitutes a signed observation — a timestamped, verifiable record that the Service observed a particular market status at a particular moment.

CRITICAL DISTINCTION: This Service is a tool for procedural diligence. It does not constitute financial advice, legal advice, investment guidance, or a guarantee of market liquidity, settlement capability, or clearing availability. Headless Oracle is an information publisher, not an execution venue, broker-dealer, exchange, or investment adviser.
The Service operates under the Publisher's Exclusion doctrine. It broadcasts identical, impersonal market observations to all subscribers without regard to any subscriber's individual positions, portfolio, risk tolerance, or investment objectives. The Service does not accept, process, or consider any user-specific financial data.

02
Key Definitions
"Attestation" or "Receipt"
A JSON payload returned by the API containing a market status observation and its corresponding Ed25519 digital signature. An Attestation is a record of observation, not a guarantee of fact.
"Agent" or "You"
Any person, entity, autonomous software system, trading bot, AI agent, smart contract, or automated process that accesses the Headless Oracle API.
"Defensive Execution Layer"
A pre-trade validation service that provides verifiable market state data as one input in a multi-factor decision pipeline. Not a replacement for independent due diligence.
"Fail-Closed"
A safety design pattern in which system uncertainty defaults to the most restrictive state. In context: any ambiguous, missing, or unverifiable API response must be treated as equivalent to "market CLOSED."
"Procedural Diligence"
The practice of taking documented, verifiable steps to validate pre-conditions before automated execution. Headless Oracle provides evidence of such steps; it does not guarantee the sufficiency of those steps for any regulatory or legal purpose.
"UNKNOWN" Status
A response indicating the Service cannot determine market state with confidence. This is a safety signal, not an error. Agents MUST treat UNKNOWN identically to CLOSED.
"Public Key"
The Ed25519 public key published by Headless Oracle for signature verification. Current and historical keys are maintained at our public key repository.
03
Acceptance of Terms
By accessing the Headless Oracle API — whether via direct HTTP request, SDK, integration library, or any automated system — You agree to be bound by these Terms of Service. For autonomous agents and automated systems, the operator, developer, or deployer of that system is bound by these Terms on behalf of the system.

These Terms constitute a binding agreement between You and Headless Oracle. If You do not agree to these Terms, You must immediately cease all use of the Service. Continued use after any modification to these Terms constitutes acceptance of the modified Terms.

FOR AI AGENTS: Machine-readable terms are available at /llms.txt on this domain. Every API response includes an X-Legal-Terms header linking to these Terms. By consuming API responses, your system acknowledges these Terms programmatically.
04
No Liability for Execution
CRITICAL — READ CAREFULLY: You acknowledge that Headless Oracle is an information publisher providing attestations of observed market status. We are NOT an execution venue, broker, counterparty, or guarantor.
Headless Oracle expressly disclaims all liability for:

Trading losses of any kind, including but not limited to losses from executions made in reliance on Service data.
Slippage, failed settlements, or partial fills on any trading venue, centralised or decentralised.
Gas fees, transaction costs, or network fees incurred on any blockchain, Layer 1, or Layer 2 network.
Losses resulting from UNKNOWN, SYSTEM_ERROR, or timeout states, including losses from halting execution in response to such states.
Opportunity costs from not executing trades due to Service data indicating a market is closed or halted.
Losses from data latency, including any gap between actual market state changes and Service reporting of those changes.
Third-party losses incurred by any end-user, liquidity provider, counterparty, or downstream system relying on your use of Service data.
You expressly agree that the Service is one component of a prudent pre-trade validation pipeline and that You bear sole responsibility for all execution decisions. The existence of an Attestation does not constitute advice to trade, permission to trade, or confirmation that trading is safe.

05
The Fail-Closed Obligation
You agree to implement and maintain fail-closed behaviour in any system that consumes data from the Headless Oracle API. Specifically, You agree to programme your automated systems to default to a "Safety Halt" state under ANY of the following conditions:

The API returns a status of UNKNOWN
The API returns an INTERNAL_ERROR or SYSTEM_ERROR event
The API returns an AUTHENTICATION_REQUIRED (401) error
The API returns any HTTP 5xx server error
The API is unreachable or does not respond within 4,000 milliseconds
The Ed25519 signature on the response fails verification
The public_key_id in the response does not match any known, non-revoked public key
BREACH WARNING: Ignoring an UNKNOWN signal, bypassing signature verification, or continuing execution when the API is unreachable constitutes a material breach of these Terms. Upon breach, Headless Oracle reserves the right to immediately terminate your access.
06
Cryptographic Verification
Every API response on paid tiers includes an Ed25519 digital signature. This signature is the sole mechanism by which an Attestation acquires evidentiary standing. In Version 5.0-BETA, signatures are calculated over the exact UTF-8 encoded string of the JSON payload object, excluding the signature field itself. The signature attests only to the authenticity and origin of the payload — that it was generated by Headless Oracle's systems at the stated timestamp. It does not constitute a guarantee, warranty, or representation as to the financial accuracy, completeness, or real-time currency of the market status contained within the payload.

Verifying the signature of every API response against our published Public Key before using the data for any execution decision.
Monitoring key rotation announcements published at our public key repository and status page.
Rejecting responses where the signature does not verify, the public key ID is unrecognised, or the timestamp falls outside acceptable staleness bounds (recommended: reject attestations older than 60 seconds).
07
Acceptable Use
You agree to use the Service only for lawful purposes consistent with its design as a pre-trade validation layer. You shall NOT:

Redistribute, resell, or sublicense API responses or Attestations to third parties without written consent.
Use the Service to construct or disseminate misleading representations about market conditions.
Attempt to reverse-engineer, decompile, or extract the proprietary logic of the Service.
Exceed your plan's rate limits or circumvent rate limiting through key sharing, distributed requests, or any other mechanism.
Use the Service to facilitate market manipulation, front-running, spoofing, layering, or any activity prohibited under applicable securities or commodities laws.
Present Headless Oracle Attestations as a regulatory certification, compliance guarantee, or legal immunity.
Share, transfer, or expose your API key to unauthorised parties.
08
Data Accuracy & Limitations
Headless Oracle derives market status from a combination of published exchange schedules, official holiday calendars, and manual override inputs. You acknowledge and accept the following limitations:

Third-party sourced. Market schedules, trading hours, public holiday calendars, and halt announcements originate from third-party sources including official exchange publications and regulatory bodies. Headless Oracle does not independently verify the accuracy of data published by those third parties and is not liable for errors, omissions, or delays in third-party source data.
Schedule-based, not real-time feed-based. The Service reports the scheduled operational status of markets based on published calendars. It does not ingest or relay real-time exchange feeds. Unscheduled halts may not be reflected until a manual override is entered.
Latency is non-zero. There is an inherent delay between a real-world market event and its reflection in API responses. This delay may range from seconds to minutes.
Observation, not reality. Every Attestation records what the Service observed at a point in time. It is a signed observation, not a signed guarantee that reality matched the observation.
09
Intellectual Property
The Headless Oracle name, logo, API design, documentation, and all associated intellectual property are owned by Headless Oracle. Your subscription grants a limited, non-exclusive, non-transferable, revocable licence to access the API and use Attestations for your internal operational purposes.

10
Privacy & Data Collection
Headless Oracle is designed with minimal data collection. We collect:

API key identifier — to authenticate requests and enforce rate limits.
Request metadata — timestamp, requested MIC code, response status, stored in our audit log for operational integrity.
Email address — provided at registration for account management.
We do NOT collect portfolio data, trading positions, or financial account information. Full Privacy Policy at /privacy.html.

11
Beta Disclaimer
BETA SERVICE: Headless Oracle is currently in public beta. You acknowledge and accept that service availability may be intermittent and no SLA is in force during the beta period.
12
Indemnification
You agree to indemnify, defend, and hold harmless Headless Oracle from and against any and all claims, damages, losses, and liabilities arising out of your use of the Service or violation of these Terms.

13
Limitation of Liability
TO THE MAXIMUM EXTENT PERMITTED BY LAW: Headless Oracle provides the Service "AS IS". Total aggregate liability is limited to the total fees paid by You to Headless Oracle in the preceding twelve (12) months.

14
Termination
Headless Oracle may terminate or suspend your access immediately for breach of terms or at our sole discretion. Verified receipts remain valid records of historical observations post-termination.

15
Governing Law & Dispute Resolution
These Terms are governed by the laws of England and Wales. Any dispute shall be resolved through binding arbitration administered by the LCIA in London.

16
Changes to These Terms
Headless Oracle reserves the right to modify these Terms. Material changes will be published 30 days in advance of taking effect.

17
Contact
General Enquiries
hello@headlessoracle.com
Legal Notices
legal@headlessoracle.com
Headless Oracle © 2026. All rights reserved.

Home
Terms of Service
Privacy Policy
Machine-Readable Terms
Receipt Verifier