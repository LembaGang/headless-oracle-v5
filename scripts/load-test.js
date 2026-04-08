#!/usr/bin/env node
/**
 * Headless Oracle Load Test
 *
 * Hits GET /v5/demo?mic=XNYS at configurable concurrency levels.
 * Outputs results as JSON and human-readable markdown.
 *
 * Usage:
 *   node scripts/load-test.js              # 10 req/s for 30s (default)
 *   node scripts/load-test.js --rps 100    # 100 req/s for 30s
 *   node scripts/load-test.js --rps 1000   # 1000 req/s for 30s (use with caution)
 *   node scripts/load-test.js --duration 60 --rps 10  # 10 req/s for 60s
 *   node scripts/load-test.js --target http://localhost:8787  # local dev
 */

const DEFAULT_TARGET = 'https://headlessoracle.com';
const DEFAULT_PATH = '/v5/demo?mic=XNYS';
const DEFAULT_RPS = 10;
const DEFAULT_DURATION_S = 30;

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, fallback) {
	const idx = args.indexOf(`--${name}`);
	return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const TARGET = getArg('target', DEFAULT_TARGET);
const PATH = getArg('path', DEFAULT_PATH);
const RPS = parseInt(getArg('rps', String(DEFAULT_RPS)), 10);
const DURATION_S = parseInt(getArg('duration', String(DEFAULT_DURATION_S)), 10);
const URL = `${TARGET}${PATH}`;

console.log(`\n🔧 Load Test Configuration`);
console.log(`   Target:    ${URL}`);
console.log(`   Rate:      ${RPS} req/s`);
console.log(`   Duration:  ${DURATION_S}s`);
console.log(`   Total:     ~${RPS * DURATION_S} requests\n`);

const latencies = [];
let successCount = 0;
let failCount = 0;
const statusCodes = {};

async function sendRequest() {
	const start = performance.now();
	try {
		const response = await fetch(URL, {
			headers: { 'User-Agent': 'headless-oracle-load-test/1.0' },
		});
		const elapsed = performance.now() - start;
		latencies.push(elapsed);
		statusCodes[response.status] = (statusCodes[response.status] || 0) + 1;
		if (response.status === 200) {
			successCount++;
		} else {
			failCount++;
		}
		// Consume body to free connection
		await response.text();
	} catch (err) {
		const elapsed = performance.now() - start;
		latencies.push(elapsed);
		failCount++;
		statusCodes['error'] = (statusCodes['error'] || 0) + 1;
	}
}

function percentile(sorted, p) {
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)];
}

async function run() {
	const intervalMs = 1000 / RPS;
	const totalRequests = RPS * DURATION_S;
	const startTime = performance.now();

	console.log(`⏱  Starting ${totalRequests} requests...`);

	const promises = [];
	for (let i = 0; i < totalRequests; i++) {
		const scheduledAt = i * intervalMs;
		const now = performance.now() - startTime;
		const delay = Math.max(0, scheduledAt - now);

		promises.push(
			new Promise((resolve) => setTimeout(resolve, delay)).then(() => sendRequest()),
		);
	}

	await Promise.all(promises);

	const totalElapsed = (performance.now() - startTime) / 1000;
	const sorted = [...latencies].sort((a, b) => a - b);

	const results = {
		config: {
			target: URL,
			rps_target: RPS,
			duration_seconds: DURATION_S,
			timestamp: new Date().toISOString(),
		},
		summary: {
			total_requests: successCount + failCount,
			successful_200: successCount,
			failed_non_200: failCount,
			status_codes: statusCodes,
			actual_duration_seconds: Math.round(totalElapsed * 100) / 100,
			actual_rps: Math.round((successCount + failCount) / totalElapsed * 100) / 100,
		},
		latency_ms: {
			min: Math.round(sorted[0] * 100) / 100,
			max: Math.round(sorted[sorted.length - 1] * 100) / 100,
			p50: Math.round(percentile(sorted, 50) * 100) / 100,
			p95: Math.round(percentile(sorted, 95) * 100) / 100,
			p99: Math.round(percentile(sorted, 99) * 100) / 100,
			mean: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
		},
	};

	// Write JSON results
	const { writeFileSync, mkdirSync, existsSync } = await import('fs');
	const { join } = await import('path');
	const outDir = join(process.cwd(), 'docs', 'performance');
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

	const jsonPath = join(outDir, 'load-test-results.json');
	writeFileSync(jsonPath, JSON.stringify(results, null, 2));
	console.log(`\n📊 JSON results written to ${jsonPath}`);

	// Print summary
	console.log(`\n── Results ──────────────────────────────────────`);
	console.log(`   Total requests:  ${results.summary.total_requests}`);
	console.log(`   Successful:      ${results.summary.successful_200}`);
	console.log(`   Failed:          ${results.summary.failed_non_200}`);
	console.log(`   Actual RPS:      ${results.summary.actual_rps}`);
	console.log(`   Duration:        ${results.summary.actual_duration_seconds}s`);
	console.log(`\n── Latency (ms) ────────────────────────────────`);
	console.log(`   Min:  ${results.latency_ms.min}`);
	console.log(`   P50:  ${results.latency_ms.p50}`);
	console.log(`   P95:  ${results.latency_ms.p95}`);
	console.log(`   P99:  ${results.latency_ms.p99}`);
	console.log(`   Max:  ${results.latency_ms.max}`);
	console.log(`   Mean: ${results.latency_ms.mean}`);
	console.log(`────────────────────────────────────────────────\n`);

	return results;
}

run().catch(console.error);
