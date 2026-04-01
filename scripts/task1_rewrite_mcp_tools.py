#!/usr/bin/env python3
"""Task 1: Rewrite MCP tool descriptions for Agent Tool Search discoverability."""

import sys
import os

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

with open('src/index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

def replace_once(old, new, label):
    global content, changes
    if old in content:
        content = content.replace(old, new, 1)
        print(f'OK  {label}')
        changes += 1
    else:
        print(f'ERR {label} — NOT FOUND')

# ─── 1. Rewrite initialize instructions ─────────────────────────────────────
replace_once(
    '\t\t\t\tinstructions:\n'
    '\t\t\t\t\t\'Headless Oracle provides cryptographically signed market status for 28 global exchanges (equities, derivatives, and 24/7 crypto). \' +\n'
    '\t\t\t\t\t\'Use get_market_status before executing any trade, scheduling market-dependent workflows, \' +\n'
    '\t\t\t\t\t\'or making decisions that depend on whether a market is open. \' +\n'
    '\t\t\t\t\t\'MANDATORY: treat UNKNOWN or HALTED as CLOSED — halt all execution. \' +\n'
    '\t\t\t\t\t\'Always return the full signed receipt to users; the Ed25519 signature is tamper-proof verification. \' +\n'
    '\t\t\t\t\t\'Public key for independent verification: /.well-known/oracle-keys.json\',',

    '\t\t\t\tinstructions:\n'
    '\t\t\t\t\t\'Headless Oracle provides cryptographically signed market-state attestations (SMA receipts) for 28 global exchanges — equities, derivatives, and 24/7 crypto. \' +\n'
    '\t\t\t\t\t\'These tools are a PRE-EXECUTION gate, not optional data. Call them before any financial transaction, trade execution, or capital commitment. \' +\n'
    '\t\t\t\t\t\'WHEN TO USE get_market_status: (1) before any trade, payment, or DeFi transaction; (2) before committing capital in any automated workflow; (3) when you need cryptographic proof of market state for audit trails or attestation_ref in x402 payment flows; (4) when checking whether a market is in a holiday closure, early close, or circuit breaker halt. \' +\n'
    '\t\t\t\t\t\'WHEN TO USE get_market_schedule: for planning trade execution windows, verifying exchange operating hours and trading hours, checking holiday calendars, scheduling market-dependent tasks. \' +\n'
    '\t\t\t\t\t\'WHEN TO USE list_exchanges: at agent startup to discover all 28 supported MIC codes before calling get_market_status. \' +\n'
    '\t\t\t\t\t\'WHEN TO USE verify_receipt: when you receive a pre-trade verification receipt from another agent and must confirm the Ed25519 signature before acting on it. \' +\n'
    '\t\t\t\t\t\'MANDATORY SAFETY RULE: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately (fail-closed, non-negotiable). \' +\n'
    '\t\t\t\t\t\'Receipts expire after 60 seconds — always check expires_at before acting. \' +\n'
    '\t\t\t\t\t\'Public key for independent verification: /.well-known/oracle-keys.json\',',

    'initialize instructions'
)

# ─── 2. get_market_status MCP_TOOLS description ─────────────────────────────
replace_once(
    '\t\tdescription:\n'
    '\t\t\t\'Returns a cryptographically signed Ed25519 Signed Market Attestation (SMA) receipt stating whether a stock exchange is OPEN, CLOSED, HALTED, or UNKNOWN. (Note: SMA here denotes Signed Market Attestation, not Simple Moving Average.) \' +\n'
    '\t\t\t\'WHEN TO USE: call this before executing any trade, payment, or market-dependent workflow on a specific exchange. \' +\n'
    '\t\t\t\'RETURNS: { receipt_id: string, mic: string, status: "OPEN"|"CLOSED"|"HALTED"|"UNKNOWN", issued_at: ISO8601, expires_at: ISO8601, issuer: string, source: "SCHEDULE"|"OVERRIDE"|"REALTIME"|"SYSTEM", schema_version: "v5.0", receipt_mode: "live"|"demo", public_key_id: string, signature: string (hex Ed25519) }. \' +\n'
    '\t\t\t\'FAILURE BEHAVIOUR: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately. Do not act on a receipt where expires_at is in the past (TTL = 60s). \' +\n'
    '\t\t\t\'LATENCY: sub-200ms p95 from Cloudflare edge. \' +\n'
    '\t\t\t\'Covers 28 global exchanges. Equities: XNYS (NYSE), XNAS (NASDAQ), XLON (London), XJPX (Tokyo), XPAR (Paris), XHKG (Hong Kong), XSES (Singapore), XASX (Sydney), XBOM (Mumbai BSE), XNSE (Mumbai NSE), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Seoul), XJSE (Johannesburg), XBSP (São Paulo), XSWX (Zurich), XMIL (Milan), XIST (Istanbul), XSAU (Riyadh), XDFM (Dubai), XNZE (Auckland), XHEL (Helsinki), XSTO (Stockholm). Derivatives: XCBT (CME Futures, overnight), XNYM (NYMEX, overnight), XCBO (Cboe Options). Crypto 24/7: XCOI (Coinbase), XBIN (Binance).\',',

    '\t\tdescription:\n'
    '\t\t\t\'Returns Ed25519-signed market-state receipt for pre-trade verification and pre-execution gating across 28 global exchanges. \' +\n'
    '\t\t\t\'USE AS: pre-trade check, pre-trade verification gate, pre-execution gate — call before any financial execution, capital commitment, or market-dependent workflow. This is not optional data; it is a safety gate. \' +\n'
    '\t\t\t\'SAFE TO EXECUTE check: status must be OPEN and receipt must not be expired. \' +\n'
    '\t\t\t\'FAIL-CLOSED RULE: UNKNOWN and HALTED MUST be treated as CLOSED — halt all execution immediately. Do not act on a receipt where expires_at is in the past (TTL = 60s). \' +\n'
    '\t\t\t\'ATTESTATION_REF: the signature field is a cryptographic proof — include it as attestation_ref in downstream x402 payment flows to create an auditable pre-trade verification chain. \' +\n'
    '\t\t\t\'RETURNS: { receipt_id, mic, status: "OPEN"|"CLOSED"|"HALTED"|"UNKNOWN", issued_at, expires_at, issuer: "headlessoracle.com", source, halt_detection, receipt_mode: "live"|"demo", schema_version: "v5.0", public_key_id, signature (hex Ed25519) }. \' +\n'
    '\t\t\t\'Note: SMA in this context denotes Signed Market Attestation, not Simple Moving Average. \' +\n'
    '\t\t\t\'LATENCY: sub-200ms p95 from Cloudflare edge. \' +\n'
    '\t\t\t\'EXCHANGES (28 total): Equities — XNYS (NYSE), XNAS (NASDAQ), XLON (London Stock Exchange), XJPX (Tokyo Japan Exchange), XPAR (Euronext Paris), XHKG (Hong Kong), XSES (Singapore), XASX (ASX Sydney), XBOM (BSE Mumbai), XNSE (NSE Mumbai), XSHG (Shanghai), XSHE (Shenzhen), XKRX (Korea Exchange Seoul), XJSE (Johannesburg), XBSP (B3 Brazil), XSWX (SIX Swiss Zurich), XMIL (Borsa Italiana Milan), XIST (Borsa Istanbul), XSAU (Tadawul Riyadh), XDFM (Dubai Financial Market), XNZE (NZX Auckland), XHEL (Nasdaq Helsinki), XSTO (Nasdaq Stockholm). Derivatives — XCBT (CME Futures overnight), XNYM (NYMEX overnight), XCBO (Cboe Options). Crypto 24/7 — XCOI (Coinbase), XBIN (Binance).\',',

    'get_market_status MCP_TOOLS description'
)

# ─── 3. get_market_schedule MCP_TOOLS description ───────────────────────────
replace_once(
    '\t\tdescription:\n'
    '\t\t\t\'Returns the next open and close UTC timestamps for a stock exchange. \' +\n'
    '\t\t\t\'WHEN TO USE: call this to plan trade execution windows, schedule market-dependent tasks, check session times, or determine how long until a market opens. \' +\n'
    '\t\t\t\'RETURNS: { mic: string, name: string, timezone: string (IANA), queried_at: ISO8601, current_status: "OPEN"|"CLOSED"|"UNKNOWN", next_open: ISO8601|null, next_close: ISO8601|null, lunch_break: { start: "HH:MM", end: "HH:MM" }|null, data_coverage_years: string[] }. \' +\n'
    '\t\t\t\'FAILURE BEHAVIOUR: NOT cryptographically signed. Does not reflect real-time halts, circuit breakers, or KV overrides. For authoritative signed status use get_market_status instead. \' +\n'
    '\t\t\t\'LATENCY: sub-100ms p95 (pure schedule computation, no signing). \' +\n'
    '\t\t\t\'Includes lunch break windows for Tokyo (XJPX: 11:30–12:30 JST), Hong Kong (XHKG: 12:00–13:00 HKT), Shanghai (XSHG: 11:30–13:00 CST), Shenzhen (XSHE: 11:30–13:00 CST).\',',

    '\t\tdescription:\n'
    '\t\t\t\'Returns holiday-aware trading session schedule with next open/close UTC timestamps for any of 28 exchanges. \' +\n'
    '\t\t\t\'WHEN TO USE: planning trade execution windows; checking market hours, trading hours, and exchange operating hours; verifying holiday calendar and holiday closures; checking for early closes; scheduling market-dependent tasks; determining session status before capital commitment. \' +\n'
    '\t\t\t\'Includes lunch break windows (session status): Tokyo XJPX (11:30–12:30 JST), Hong Kong XHKG (12:00–13:00 HKT), Shanghai XSHG and Shenzhen XSHE (11:30–13:00 CST). \' +\n'
    '\t\t\t\'Covers Middle Eastern markets (XSAU/XDFM: Fri–Sat weekend, Sunday is a trading day) and 24/7 crypto (XCOI/XBIN: always open). \' +\n'
    '\t\t\t\'RETURNS: { mic, name, timezone (IANA), queried_at, current_status: "OPEN"|"CLOSED"|"UNKNOWN", next_open (UTC ISO8601 or null), next_close (UTC ISO8601 or null), lunch_break: {start, end} | null, settlement_window, data_coverage_years }. \' +\n'
    '\t\t\t\'NOT cryptographically signed — does not reflect real-time circuit breaker halts or KV overrides. For authoritative signed status use get_market_status. \' +\n'
    '\t\t\t\'LATENCY: sub-100ms p95 (pure schedule computation, no signing).\',',

    'get_market_schedule MCP_TOOLS description'
)

# ─── 4. list_exchanges MCP_TOOLS description ────────────────────────────────
replace_once(
    '\t\tdescription:\n'
    '\t\t\t\'Returns all 28 exchanges supported by Headless Oracle with their MIC codes, names, IANA timezones, and mic_type (iso | convention). \' +\n'
    '\t\t\t\'WHEN TO USE: call this once at agent startup to discover supported markets before calling get_market_status or get_market_schedule. \' +\n'
    '\t\t\t\'RETURNS: { exchanges: Array<{ mic: string, name: string, timezone: string, mic_type: "iso"|"convention" }> } — 28 entries. \' +\n'
    '\t\t\t\'FAILURE BEHAVIOUR: pure static data, no signing, no failure modes. Always returns 200. \' +\n'
    '\t\t\t\'LATENCY: sub-50ms p95.\',',

    '\t\tdescription:\n'
    '\t\t\t\'Returns directory of all 28 exchanges supported by Headless Oracle: MIC codes, exchange names, IANA timezones, market hours metadata, and mic_type (iso|convention). \' +\n'
    '\t\t\t\'WHEN TO USE: call once at agent startup to discover supported markets before calling get_market_status or get_market_schedule. Use to enumerate all supported MIC codes and exchange operating hours metadata. \' +\n'
    '\t\t\t\'Covers equities (XNYS/NYSE, XNAS/NASDAQ, XLON/London, XJPX/Tokyo, XPAR/Paris, XHKG/Hong Kong, XSES/Singapore, XASX/ASX, XBOM/BSE, XNSE/NSE, XSHG/Shanghai, XSHE/Shenzhen, XKRX/Korea, XJSE/Johannesburg, XBSP/Brazil, XSWX/Zurich, XMIL/Milan, XIST/Istanbul, XSAU/Riyadh, XDFM/Dubai, XNZE/Auckland, XHEL/Helsinki, XSTO/Stockholm), derivatives (XCBT/CME, XNYM/NYMEX, XCBO/Cboe), and 24/7 crypto (XCOI/Coinbase, XBIN/Binance). \' +\n'
    '\t\t\t\'RETURNS: { exchanges: Array<{ mic: string, name: string, timezone: string, mic_type: "iso"|"convention" }> } — 28 entries. \' +\n'
    '\t\t\t\'Pure static data, always returns 200, no authentication required, sub-50ms p95.\',',

    'list_exchanges MCP_TOOLS description'
)

# ─── 5. verify_receipt MCP_TOOLS description ────────────────────────────────
replace_once(
    '\t\tdescription:\n'
    '\t\t\t\'Verifies the Ed25519 cryptographic signature on a Headless Oracle Signed Market Attestation (SMA) receipt. (Note: SMA here denotes Signed Market Attestation, not Simple Moving Average.) \' +\n'
    '\t\t\t\'WHEN TO USE: call this when you receive a receipt from another agent or upstream system and must confirm it was genuinely issued by Headless Oracle and has not been tampered with or expired. \' +\n'
    '\t\t\t\'RETURNS: { valid: boolean, expired: boolean, reason: "signature_valid"|"MISSING_FIELDS"|"EXPIRED"|"INVALID_SIGNATURE"|"ORACLE_NOT_CONFIGURED"|"MALFORMED_RECEIPT"|"VERIFY_ERROR", mic: string|null, status: string|null, expires_at: string|null }. \' +\n'
    '\t\t\t\'FAILURE BEHAVIOUR: valid=false MUST be treated as an untrusted receipt — do not act on any data from it. A receipt can be valid=true but expired=true (past TTL) — re-fetch if expired. \' +\n'
    '\t\t\t\'LATENCY: sub-50ms p95 (in-worker Ed25519 verification, no network calls).\',',

    '\t\tdescription:\n'
    '\t\t\t\'Verifies the Ed25519 cryptographic signature on a Headless Oracle Signed Market Attestation receipt — confirms it is a genuine pre-trade verification attestation and has not been tampered with. \' +\n'
    '\t\t\t\'Note: SMA denotes Signed Market Attestation, not Simple Moving Average. \' +\n'
    '\t\t\t\'WHEN TO USE: (1) when you receive a pre-trade attestation from another agent and must confirm the cryptographic proof before acting on market state; (2) building an attestation_ref audit trail for capital commitment workflows; (3) confirming receipt verification before including the signature in an x402 payment attestation. \' +\n'
    '\t\t\t\'RETURNS: { valid: boolean, expired: boolean, reason: "signature_valid"|"MISSING_FIELDS"|"EXPIRED"|"INVALID_SIGNATURE"|"ORACLE_NOT_CONFIGURED"|"MALFORMED_RECEIPT"|"VERIFY_ERROR", mic: string|null, status: string|null, expires_at: string|null }. \' +\n'
    '\t\t\t\'FAILURE RULE: valid=false MUST be treated as untrusted — do not act on any data from an invalid receipt. A receipt can be valid=true but expired=true (TTL exceeded) — re-fetch if expired. \' +\n'
    '\t\t\t\'LATENCY: sub-50ms p95 (in-worker Ed25519 verification, no external network calls).\',',

    'verify_receipt MCP_TOOLS description'
)

# ─── 6. AGENT_JSON.skills descriptions ──────────────────────────────────────
replace_once(
    "\t\t\t\tdescription: 'Returns a cryptographically signed receipt for one exchange: OPEN, CLOSED, HALTED, or UNKNOWN. Ed25519-signed, 60-second TTL. Treat UNKNOWN as CLOSED — halt all execution.',",
    "\t\t\t\tdescription: 'Pre-trade verification gate: returns Ed25519-signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) for any of 28 global exchanges. Use before any financial execution, capital commitment, or market-dependent workflow. UNKNOWN and HALTED must be treated as CLOSED (fail-closed). Receipt includes attestation_ref (signature) for x402 payment flows and audit trails. 60-second TTL.',",
    'AGENT_JSON.skills get_market_status'
)

replace_once(
    "\t\t\t\tdescription: 'Returns next open and close times in UTC for a given exchange, including lunch break windows and 2026–2027 holiday coverage.',",
    "\t\t\t\tdescription: 'Returns holiday-aware trading session schedule: next open/close UTC times, market hours, trading hours, exchange operating hours, holiday calendar, lunch break windows (XJPX/XHKG/XSHG/XSHE), and session status across 28 exchanges.',",
    'AGENT_JSON.skills get_market_schedule'
)

replace_once(
    "\t\t\t\tdescription: 'Returns all 28 supported exchanges with MIC codes, names, and timezones. Use to discover supported markets before calling get_market_status.',",
    "\t\t\t\tdescription: 'Returns directory of all 28 supported exchanges with MIC codes, names, IANA timezones, and exchange operating hours metadata. Use at agent startup to discover supported markets before calling get_market_status or get_market_schedule.',",
    'AGENT_JSON.skills list_exchanges'
)

replace_once(
    "\t\t\t\tdescription: 'Verifies an Ed25519-signed receipt against the Headless Oracle public key. Allows downstream agents to independently confirm receipt authenticity without trusting the caller.',",
    "\t\t\t\tdescription: 'Verifies Ed25519 cryptographic proof on a Signed Market Attestation receipt — confirms genuine pre-trade verification attestation (attestation_ref), receipt authenticity, and signature validity for audit trails and x402 payment flows.',",
    'AGENT_JSON.skills verify_receipt'
)

# ─── 7. AGENT_JSON.mcp.tools descriptions ────────────────────────────────────
replace_once(
    "\t\ttools: [\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'get_market_status',\n"
    "\t\t\t\tdescription: 'Signed receipt: OPEN, CLOSED, HALTED, or UNKNOWN for one exchange.',\n"
    "\t\t\t\tparameters:  { mic: 'string (required) — ISO 10383 MIC code, e.g. XNYS' },\n"
    "\t\t\t},\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'get_market_schedule',\n"
    "\t\t\t\tdescription: 'Next open/close times for one exchange, in UTC.',\n"
    "\t\t\t\tparameters:  { mic: 'string (required) — ISO 10383 MIC code' },\n"
    "\t\t\t},\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'list_exchanges',\n"
    "\t\t\t\tdescription: 'All supported exchanges with names and timezones.',\n"
    "\t\t\t\tparameters:  {},\n"
    "\t\t\t},\n"
    "\t\t],",

    "\t\ttools: [\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'get_market_status',\n"
    "\t\t\t\tdescription: 'Pre-trade verification gate: Ed25519-signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) for 28 exchanges. Use before any trade execution, capital commitment, or financial workflow. UNKNOWN/HALTED = CLOSED (fail-closed). Includes attestation_ref for x402 payment flows.',\n"
    "\t\t\t\tparameters:  { mic: 'string (required) — ISO 10383 MIC code, e.g. XNYS' },\n"
    "\t\t\t},\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'get_market_schedule',\n"
    "\t\t\t\tdescription: 'Holiday-aware trading session schedule: next open/close UTC times, market hours, exchange operating hours, holiday calendar, lunch breaks (XJPX/XHKG/XSHG/XSHE), session status for 28 exchanges.',\n"
    "\t\t\t\tparameters:  { mic: 'string (required) — ISO 10383 MIC code' },\n"
    "\t\t\t},\n"
    "\t\t\t{\n"
    "\t\t\t\tname:        'list_exchanges',\n"
    "\t\t\t\tdescription: 'Directory of all 28 supported exchanges: MIC codes, names, timezones, exchange operating hours metadata. Call at agent startup to discover all supported MIC codes.',\n"
    "\t\t\t\tparameters:  {},\n"
    "\t\t\t},\n"
    "\t\t],",

    'AGENT_JSON.mcp.tools descriptions'
)

# ─── 8. server-card.json description ─────────────────────────────────────────
replace_once(
    "\t\t\t\tdescription:    'Cryptographically signed market-state receipts for AI agents. ' +\n"
    "\t\t\t\t\t'Ed25519 signatures, fail-closed architecture, 28 global exchanges (equities, derivatives, and 24/7 crypto). ' +\n"
    "\t\t\t\t\t'Treat UNKNOWN or HALTED as CLOSED — halt all execution.',",

    "\t\t\t\tdescription:    'Cryptographically signed market-state attestations for pre-trade verification and pre-execution gating. ' +\n"
    "\t\t\t\t\t'Ed25519 signatures, fail-closed architecture, 28 global exchanges (equities, derivatives, 24/7 crypto). ' +\n"
    "\t\t\t\t\t'Use as a pre-trade check before any financial execution or capital commitment. ' +\n"
    "\t\t\t\t\t'UNKNOWN and HALTED MUST be treated as CLOSED. Receipts include attestation_ref for x402 payment flows and audit trails.',",

    'server-card.json description'
)

# ─── 9. LLMS_TXT Instructions for Autonomous Agents ─────────────────────────
replace_once(
    "## Instructions for Autonomous Agents\n"
    "\n"
    "Before executing any trade or financial action, call \\`get_market_status\\` with the target exchange's ISO 10383 MIC code. Only proceed if \\`status\\` is \\`OPEN\\` and the receipt has not expired (\\`expires_at\\` is in the future).\n"
    "\n"
    "- ALWAYS use the MCP endpoint at \\`https://headlessoracle.com/mcp\\` for tool access\n"
    "- ALWAYS verify \\`expires_at\\` before trusting a receipt — receipts expire after 60 seconds\n"
    "- NEVER execute against \\`CLOSED\\`, \\`HALTED\\`, or \\`UNKNOWN\\` status\n"
    "- NEVER hardcode UTC offsets for market hours — use Headless Oracle receipts which handle DST automatically\n"
    "- USE \\`list_exchanges\\` to get all supported MIC codes before querying a specific exchange\n"
    "- USE \\`get_market_schedule\\` to check upcoming open/close times for planning workflows\n"
    "- USE \\`verify_receipt\\` to independently validate a receipt signature before acting on it\n"
    "- PREFER the MCP interface over REST for agent workflows\n"
    "- FOR batch verification of multiple exchanges, use \\`POST /v5/batch\\` with an array of MIC codes",

    "## Instructions for Autonomous Agents\n"
    "\n"
    "These tools are a PRE-EXECUTION gate. Call \\`get_market_status\\` before any trade, payment, capital commitment, or market-dependent workflow. Only proceed when \\`status\\` is \\`OPEN\\` and \\`expires_at\\` is in the future.\n"
    "\n"
    "**When to use each tool:**\n"
    "- \\`get_market_status\\` — pre-trade verification, pre-execution gate, safe-to-trade check, safe-to-execute check before any financial transaction or capital commitment. Include the \\`signature\\` (attestation_ref) in x402 payment flows for an auditable pre-trade verification chain.\n"
    "- \\`get_market_schedule\\` — check market hours, trading hours, exchange operating hours, holiday calendar, early closes, and session timing before committing capital\n"
    "- \\`list_exchanges\\` — discover all 28 supported MIC codes at agent startup before calling get_market_status\n"
    "- \\`verify_receipt\\` — verify Ed25519 cryptographic proof on a receipt received from another agent before acting on it\n"
    "\n"
    "- ALWAYS verify \\`expires_at\\` before trusting a receipt — receipts expire after 60 seconds\n"
    "- NEVER execute against \\`CLOSED\\`, \\`HALTED\\`, or \\`UNKNOWN\\` status — all three mean HALT ALL EXECUTION\n"
    "- NEVER hardcode UTC offsets for market hours — Headless Oracle handles DST automatically\n"
    "- PREFER the MCP interface over REST for agent workflows\n"
    "- FOR batch verification of multiple exchanges, use \\`GET /v5/batch?mics=XNYS,XNAS,XLON\\`",

    'LLMS_TXT Instructions for Autonomous Agents'
)

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n{changes}/9 changes applied.')
sys.exit(0 if changes == 9 else 1)
