#!/usr/bin/env python3
"""Fix remaining Task 1 items: AGENT_JSON.skills and server-card description."""

import sys, os
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

# AGENT_JSON.skills — 3 tabs indentation
replace_once(
    "\t\t\tdescription: 'Returns a cryptographically signed receipt for one exchange: OPEN, CLOSED, HALTED, or UNKNOWN. Ed25519-signed, 60-second TTL. Treat UNKNOWN as CLOSED \u2014 halt all execution.',",
    "\t\t\tdescription: 'Pre-trade verification gate: returns Ed25519-signed market-state receipt (OPEN/CLOSED/HALTED/UNKNOWN) for any of 28 global exchanges. Use before any financial execution, capital commitment, or market-dependent workflow. UNKNOWN and HALTED must be treated as CLOSED (fail-closed). Receipt includes attestation_ref (signature) for x402 payment flows and audit trails. 60-second TTL.',",
    'AGENT_JSON.skills get_market_status'
)

replace_once(
    "\t\t\tdescription: 'Returns next open and close times in UTC for a given exchange, including lunch break windows and 2026\u20132027 holiday coverage.',",
    "\t\t\tdescription: 'Returns holiday-aware trading session schedule: next open/close UTC times, market hours, trading hours, exchange operating hours, holiday calendar, lunch break windows (XJPX/XHKG/XSHG/XSHE), and session status across 28 exchanges.',",
    'AGENT_JSON.skills get_market_schedule'
)

replace_once(
    "\t\t\tdescription: 'Returns all 28 supported exchanges with MIC codes, names, and timezones. Use to discover supported markets before calling get_market_status.',",
    "\t\t\tdescription: 'Returns directory of all 28 supported exchanges with MIC codes, names, IANA timezones, and exchange operating hours metadata. Use at agent startup to discover supported markets before calling get_market_status or get_market_schedule.',",
    'AGENT_JSON.skills list_exchanges'
)

replace_once(
    "\t\t\tdescription: 'Verifies an Ed25519-signed receipt against the Headless Oracle public key. Allows downstream agents to independently confirm receipt authenticity without trusting the caller.',",
    "\t\t\tdescription: 'Verifies Ed25519 cryptographic proof on a Signed Market Attestation receipt \u2014 confirms genuine pre-trade verification attestation (attestation_ref), receipt authenticity, and signature validity for audit trails and x402 payment flows.',",
    'AGENT_JSON.skills verify_receipt'
)

# server-card.json description — 5 tabs for description, 6 tabs for continuation
replace_once(
    "\t\t\t\t\tdescription:    'Cryptographically signed market-state receipts for AI agents. ' +\n"
    "\t\t\t\t\t\t'Ed25519 signatures, fail-closed architecture, 28 global exchanges (equities, derivatives, and 24/7 crypto). ' +\n"
    "\t\t\t\t\t\t'Treat UNKNOWN or HALTED as CLOSED \u2014 halt all execution.',",

    "\t\t\t\t\tdescription:    'Cryptographically signed market-state attestations for pre-trade verification and pre-execution gating. ' +\n"
    "\t\t\t\t\t\t'Ed25519 signatures, fail-closed architecture, 28 global exchanges (equities, derivatives, 24/7 crypto). ' +\n"
    "\t\t\t\t\t\t'Use as a pre-trade check before any financial execution or capital commitment. ' +\n"
    "\t\t\t\t\t\t'UNKNOWN and HALTED MUST be treated as CLOSED. Receipts include attestation_ref for x402 payment flows and audit trails.',",

    'server-card.json description'
)

with open('src/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\n{changes}/5 changes applied.')
sys.exit(0 if changes == 5 else 1)
