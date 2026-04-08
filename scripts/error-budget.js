#!/usr/bin/env node
/**
 * Error Budget Tracker — Headless Oracle V5
 *
 * Computes SLO availability from status_code KV counters.
 *
 * Usage:
 *   # Fetch data from production KV via wrangler (requires auth)
 *   node scripts/error-budget.js --fetch
 *
 *   # Use cached/manual data from docs/operations/error-budget-data.json
 *   node scripts/error-budget.js
 *
 * The script reads status_code:{YYYY-MM-DD}:{code} counters from
 * ORACLE_TELEMETRY KV. Since direct KV access from scripts requires
 * wrangler remote binding, --fetch mode uses wrangler kv:key list + get.
 *
 * Manual alternative: export status code data from Cloudflare Dashboard
 * (Workers > Metrics > Analytics) and save to error-budget-data.json.
 */

const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

const SLO_TARGET = 0.999; // 99.9%
const DAYS_BACK = 30;
const OUT_DIR = join(process.cwd(), 'docs', 'operations');
const DATA_FILE = join(OUT_DIR, 'error-budget-data.json');
const REPORT_FILE = join(OUT_DIR, 'error-budget.md');

// KV namespace binding name from wrangler.toml
const KV_NAMESPACE = 'ORACLE_TELEMETRY';

function fetchFromKV() {
	console.log('Fetching status code data from production KV...\n');
	const today = new Date();
	const data = {};

	for (let i = 0; i < DAYS_BACK; i++) {
		const date = new Date(today);
		date.setUTCDate(date.getUTCDate() - i);
		const dateStr = date.toISOString().split('T')[0];
		data[dateStr] = {};

		// Common status codes to check
		for (const code of [200, 301, 302, 400, 401, 402, 403, 404, 405, 429, 500, 502, 503]) {
			const key = `status_code:${dateStr}:${code}`;
			try {
				const result = execSync(
					`npx wrangler kv:key get --binding=${KV_NAMESPACE} "${key}" 2>/dev/null`,
					{ encoding: 'utf8', timeout: 10000 },
				).trim();
				if (result && result !== 'null') {
					data[dateStr][String(code)] = parseInt(result, 10) || 0;
				}
			} catch {
				// Key doesn't exist — no requests with that status code on that day
			}
		}
	}

	if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
	console.log(`Data saved to ${DATA_FILE}`);
	return data;
}

function loadCachedData() {
	if (!existsSync(DATA_FILE)) {
		console.log(`No cached data found at ${DATA_FILE}`);
		console.log('Run with --fetch to pull from production KV, or create the file manually.\n');
		console.log('Expected format:');
		console.log(JSON.stringify({
			'2026-04-08': { '200': 1500, '402': 45, '500': 0 },
			'2026-04-07': { '200': 1200, '402': 30, '500': 1 },
		}, null, 2));
		process.exit(1);
	}
	return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function computeReport(data) {
	const dates = Object.keys(data).sort();
	const startDate = dates[0];
	const endDate = dates[dates.length - 1];

	let totalRequests = 0;
	let successfulRequests = 0; // 200 + 402 (intentional payment gate)
	let serverErrors = 0;       // 5xx only

	for (const [, codes] of Object.entries(data)) {
		for (const [code, count] of Object.entries(codes)) {
			const c = parseInt(code, 10);
			totalRequests += count;
			if (c === 200 || c === 402) {
				successfulRequests += count;
			} else if (c >= 500) {
				serverErrors += count;
			}
		}
	}

	const availability = totalRequests > 0 ? (totalRequests - serverErrors) / totalRequests : 1;
	const errorBudgetTotal = Math.floor(totalRequests * (1 - SLO_TARGET));
	const budgetConsumed = serverErrors;
	const budgetRemaining = Math.max(0, errorBudgetTotal - budgetConsumed);
	const budgetConsumedPct = errorBudgetTotal > 0 ? (budgetConsumed / errorBudgetTotal) * 100 : 0;
	const budgetRemainingPct = 100 - budgetConsumedPct;

	let healthStatus;
	if (budgetConsumedPct < 50) healthStatus = 'HEALTHY';
	else if (budgetConsumedPct < 80) healthStatus = 'WARNING';
	else healthStatus = 'CRITICAL';

	return {
		startDate,
		endDate,
		totalRequests,
		successfulRequests,
		successfulPct: totalRequests > 0 ? (successfulRequests / totalRequests * 100).toFixed(2) : '100.00',
		serverErrors,
		availability: (availability * 100).toFixed(4),
		errorBudgetTotal,
		budgetConsumed,
		budgetConsumedPct: budgetConsumedPct.toFixed(1),
		budgetRemaining,
		budgetRemainingPct: budgetRemainingPct.toFixed(1),
		healthStatus,
		daysInPeriod: dates.length,
	};
}

function generateReport(report) {
	const now = new Date().toISOString();
	return `# Error Budget Report

## Period: ${report.startDate} to ${report.endDate} (${report.daysInPeriod} days)

## SLO: 99.9% availability

| Metric | Value |
|--------|-------|
| Total requests | ${report.totalRequests.toLocaleString()} |
| Successful (200 + 402) | ${report.successfulRequests.toLocaleString()} (${report.successfulPct}%) |
| Server errors (5xx) | ${report.serverErrors} |
| **Availability** | **${report.availability}%** |

## Error Budget

| Metric | Value |
|--------|-------|
| Budget (0.1% of ${report.totalRequests.toLocaleString()}) | ${report.errorBudgetTotal} requests |
| Budget consumed | ${report.budgetConsumed} requests (${report.budgetConsumedPct}%) |
| Budget remaining | ${report.budgetRemaining} requests (${report.budgetRemainingPct}%) |

## Status: ${report.healthStatus}

${report.healthStatus === 'HEALTHY' ? 'Error budget is well within limits. No action needed.' : ''}${report.healthStatus === 'WARNING' ? 'Error budget consumption is elevated. Investigate 5xx errors and consider deploying fixes.' : ''}${report.healthStatus === 'CRITICAL' ? 'Error budget is nearly or fully exhausted. Freeze non-critical deploys and investigate root causes immediately.' : ''}

## Definitions

- **Successful**: HTTP 200 (normal) + HTTP 402 (intentional payment gate) — both are correct behavior
- **Server errors**: HTTP 5xx only — these indicate system failures
- **Error budget**: At 99.9% SLO, 0.1% of total requests are the allowed failure threshold
- **Status thresholds**: HEALTHY (<50% consumed), WARNING (50-80%), CRITICAL (>80%)

## How to Update

\`\`\`bash
# Pull fresh data from production KV
node scripts/error-budget.js --fetch

# Or manually populate docs/operations/error-budget-data.json
# from Cloudflare Dashboard > Workers > Analytics
node scripts/error-budget.js
\`\`\`

Last updated: ${now}
`;
}

// Main
const shouldFetch = process.argv.includes('--fetch');
const data = shouldFetch ? fetchFromKV() : loadCachedData();
const report = computeReport(data);
const markdown = generateReport(report);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(REPORT_FILE, markdown);

console.log(`\n── Error Budget Report ──────────────────────────`);
console.log(`   Period:      ${report.startDate} to ${report.endDate}`);
console.log(`   Requests:    ${report.totalRequests.toLocaleString()}`);
console.log(`   Availability: ${report.availability}%`);
console.log(`   5xx errors:  ${report.serverErrors}`);
console.log(`   Budget:      ${report.budgetConsumed}/${report.errorBudgetTotal} consumed (${report.budgetConsumedPct}%)`);
console.log(`   Status:      ${report.healthStatus}`);
console.log(`────────────────────────────────────────────────`);
console.log(`\nReport written to ${REPORT_FILE}`);
