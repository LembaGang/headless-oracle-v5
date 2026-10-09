// H6: the daily-record freshness rule the health check applies to GET /record.
// Pure, no I/O, so the unit suite can run it against mutated bodies.
//
// From 10:00 UTC (an hour after the 0 9 * * * cron) the newest record must be
// yesterday's, and no failed step may be recorded for yesterday. Before 10:00
// nothing is required. Returns the problems found; empty means healthy.

export const RECORD_CHECK_FROM_UTC_HOUR = 10;

export function recordProblems(body, now = new Date()) {
	if (now.getUTCHours() < RECORD_CHECK_FROM_UTC_HOUR) return [];
	const y = new Date(now);
	y.setUTCDate(y.getUTCDate() - 1);
	const yesterday = y.toISOString().slice(0, 10);
	if (typeof body !== 'object' || body === null) return ['GET /record did not return a JSON object'];
	const problems = [];
	const newest = body.newest && typeof body.newest === 'object' ? body.newest.date : null;
	if (newest !== yesterday) problems.push(`newest record is ${newest ?? 'none'}, expected ${yesterday}`);
	if (!Array.isArray(body.failed_steps)) {
		problems.push('failed_steps is missing');
	} else {
		for (const f of body.failed_steps) {
			if (f && f.date === yesterday) problems.push(`failed step for ${yesterday}: ${f.step}: ${f.message}`);
		}
	}
	return problems;
}
