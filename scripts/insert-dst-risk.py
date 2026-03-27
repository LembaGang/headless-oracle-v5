import sys

filepath = r'C:\Users\User\headless-oracle-v5\src\index.ts'
with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

marker = "\t\t\t// \u2500\u2500 GET /v5/traction \u2014 public live metrics snapshot \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"
idx = content.find(marker)
if idx == -1:
    # Try alternative
    marker = "// ── GET /v5/traction — public live metrics snapshot"
    idx = content.find(marker)
    if idx == -1:
        print("Marker not found, searching...")
        for i, line in enumerate(content.split('\n')):
            if 'traction' in line and 'public live metrics' in line:
                print(f"Line {i+1}: {repr(line[:80])}")
        sys.exit(1)
    # Find start of line
    line_start = content.rfind('\n', 0, idx) + 1
    idx = line_start

print(f"Insertion point: {idx}")

# The /v5/dst-risk endpoint implementation
dst_risk_code = '''
\t\t\t// \u2500\u2500 GET /v5/dst-risk \u2014 DST transition risk endpoint (no auth) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
\t\t\t// Educational content about the upcoming EU DST transition (March 29 2026).
\t\t\t// Embeds a live /v5/schedule?mic=XLON result for verification.
\t\t\t// Not signed \u2014 this is educational, not a trading primitive.
\t\t\tif (url.pathname === '/v5/dst-risk') {
\t\t\t\t// Fetch live schedule for XLON to embed as verified_schedule
\t\t\t\tlet xlonSchedule: Record<string, unknown> | null = null;
\t\t\t\ttry {
\t\t\t\t\tconst xlon = MARKET_CONFIGS.find(m => m.mic === 'XLON');
\t\t\t\t\tif (xlon) {
\t\t\t\t\t\tconst { nextOpen, nextClose } = getNextSession(xlon, now);
\t\t\t\t\t\txlonSchedule = {
\t\t\t\t\t\t\tmic: 'XLON',
\t\t\t\t\t\t\tname: xlon.name,
\t\t\t\t\t\t\ttimezone: xlon.timezone,
\t\t\t\t\t\t\tqueried_at: now.toISOString(),
\t\t\t\t\t\t\tcurrent_status: getScheduleStatus(xlon, now).status,
\t\t\t\t\t\t\tnext_open: nextOpen ? nextOpen.toISOString() : null,
\t\t\t\t\t\t\tnext_close: nextClose ? nextClose.toISOString() : null,
\t\t\t\t\t\t\tlunch_break: xlon.lunchBreak ?? null,
\t\t\t\t\t\t\tnote: 'Live schedule computed using IANA timezone Europe/London (DST-aware)',
\t\t\t\t\t\t};
\t\t\t\t\t}
\t\t\t\t} catch (_) {
\t\t\t\t\txlonSchedule = null;
\t\t\t\t}

\t\t\t\treturn json({
\t\t\t\t\tevent: 'EU_DST_SPRING_2026',
\t\t\t\t\ttransition_utc: '2026-03-29T01:00:00Z',
\t\t\t\t\texpires_at: '2026-03-29T02:00:00Z',
\t\t\t\t\tdescription: 'European clocks spring forward on Sunday March 29, 2026. XLON, XPAR, XSWX, XMIL, XHEL, XSTO, XIST shift +1h. Agents using hardcoded UTC offsets will compute incorrect market hours starting Monday March 30.',
\t\t\t\t\taffected_exchanges: [
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XLON',
\t\t\t\t\t\t\tname: 'London Stock Exchange',
\t\t\t\t\t\t\ttimezone: 'Europe/London',
\t\t\t\t\t\t\tshift: 'GMT \u2192 BST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '08:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '07:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Agent using hardcoded UTC+0 will believe market opens at 08:00 UTC. It actually opens at 07:00 UTC after DST. 60-minute window of incorrect state.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XPAR',
\t\t\t\t\t\t\tname: 'Euronext Paris',
\t\t\t\t\t\t\ttimezone: 'Europe/Paris',
\t\t\t\t\t\t\tshift: 'CET \u2192 CEST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '09:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '08:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Same 60-minute error window.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XSWX',
\t\t\t\t\t\t\tname: 'SIX Swiss Exchange',
\t\t\t\t\t\t\ttimezone: 'Europe/Zurich',
\t\t\t\t\t\t\tshift: 'CET \u2192 CEST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '09:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '08:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Same 60-minute error window.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XMIL',
\t\t\t\t\t\t\tname: 'Borsa Italiana',
\t\t\t\t\t\t\ttimezone: 'Europe/Rome',
\t\t\t\t\t\t\tshift: 'CET \u2192 CEST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '09:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '08:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Same 60-minute error window.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XHEL',
\t\t\t\t\t\t\tname: 'Nasdaq Helsinki',
\t\t\t\t\t\t\ttimezone: 'Europe/Helsinki',
\t\t\t\t\t\t\tshift: 'EET \u2192 EEST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '10:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '09:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Same 60-minute error window.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XSTO',
\t\t\t\t\t\t\tname: 'Nasdaq Stockholm',
\t\t\t\t\t\t\ttimezone: 'Europe/Stockholm',
\t\t\t\t\t\t\tshift: 'CET \u2192 CEST',
\t\t\t\t\t\t\tnaive_agent_open_utc: '09:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '08:00',
\t\t\t\t\t\t\terror_minutes: 60,
\t\t\t\t\t\t\trisk: 'Same 60-minute error window.',
\t\t\t\t\t\t},
\t\t\t\t\t\t{
\t\t\t\t\t\t\tmic: 'XIST',
\t\t\t\t\t\t\tname: 'Borsa Istanbul',
\t\t\t\t\t\t\ttimezone: 'Europe/Istanbul',
\t\t\t\t\t\t\tshift: 'TRT (no DST)',
\t\t\t\t\t\t\tnaive_agent_open_utc: '07:00',
\t\t\t\t\t\t\tactual_open_utc_after_dst: '07:00',
\t\t\t\t\t\t\terror_minutes: 0,
\t\t\t\t\t\t\trisk: 'Turkey does not observe DST. No change. Included for completeness.',
\t\t\t\t\t\t},
\t\t\t\t\t],
\t\t\t\t\trisk_window_minutes: 60,
\t\t\t\t\tus_europe_dst_gap_note: 'The US transitioned to DST on March 8. Europe transitions March 29. During the 21-day gap (March 8-29), NY/London offset compressed from 5 hours to 4 hours. Cross-market agents using hardcoded offsets had incorrect overlap windows for 21 days.',
\t\t\t\t\tverified_schedule: xlonSchedule,
\t\t\t\t\tsma_protocol_note: 'Headless Oracle receipts use IANA timezone identifiers (Europe/London, not UTC+0). DST is handled automatically. Agents using SMA receipts are immune to this vulnerability.',
\t\t\t\t\tnote: 'SMA = Signed Market Attestation. Not to be confused with Simple Moving Average.',
\t\t\t\t}, 200, { 'Cache-Control': 'public, max-age=3600' });
\t\t\t}

'''

content = content[:idx] + dst_risk_code + content[idx:]

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print(f"Inserted /v5/dst-risk endpoint ({len(dst_risk_code)} chars) at position {idx}")
