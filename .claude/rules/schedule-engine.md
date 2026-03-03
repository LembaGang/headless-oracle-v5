# Schedule Engine Rules
Core: If we don't know, return UNKNOWN. UNKNOWN = CLOSED under fail-closed.
DST: US (2nd Sun Mar to 1st Sun Nov), UK/EU (last Sun Mar to last Sun Oct), Japan/Singapore/HK have no DST.
Lunch breaks: XJPX 11:30-12:30 JST, XHKG 12:00-13:00 HKT. No other exchange has lunch break.
Year boundary: No holiday data = UNKNOWN. NEVER default to OPEN for unknown years.
Early closes: Vary by exchange. Always check edge case data for specific exchange and date.
