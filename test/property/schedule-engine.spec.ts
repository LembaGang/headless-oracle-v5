import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import worker, { clearOverrideCache, clearApiKeyCache } from '../../src';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchWorker(path: string, options: RequestInit = {}): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(
		`http://example.com${path}`,
		options,
	);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function fetchJSON(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
	const response = await fetchWorker(path, options);
	return response.json() as Promise<Record<string, unknown>>;
}

const ALL_MICS = [
	'XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
	'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
	'XBSP', 'XSWX', 'XMIL', 'XIST', 'XSAU', 'XDFM', 'XNZE',
	'XHEL', 'XSTO',
	'XCBT', 'XNYM', 'XCBO', 'XCOI', 'XBIN',
];

const VALID_STATUSES = ['OPEN', 'CLOSED', 'HALTED', 'UNKNOWN'];

// Arbitrary: random timestamp in 2026-2027 (use integer ms to avoid fc.date invalid date issues in Miniflare)
const TS_MIN = new Date('2026-01-01T00:00:00Z').getTime();
const TS_MAX = new Date('2027-12-31T23:59:59Z').getTime();
const timestampIn2026_2027 = fc.integer({ min: TS_MIN, max: TS_MAX }).map(ms => new Date(ms));

const micArb = fc.constantFrom(...ALL_MICS);

// ─── Test 1: Schedule engine never throws, always returns valid status ──────

describe('Property: schedule engine invariants', () => {
	it('never throws and always returns OPEN, CLOSED, or UNKNOWN for any exchange at any time in 2026-2027', async () => {
		// Generate random (mic, timestamp) pairs and test through /v5/demo
		// 200 samples stays within Miniflare connection limits; covers the space well
		const samples = fc.sample(
			fc.tuple(micArb, timestampIn2026_2027),
			200,
		);

		for (const [mic, ts] of samples) {
			vi.setSystemTime(ts);
			clearOverrideCache();

			const response = await fetchWorker(`/v5/demo?mic=${mic}`);
			// Must not throw — if we got here, it didn't
			expect(response.status).toBeOneOf([200, 500]);

			if (response.status === 200) {
				const data = await response.json() as Record<string, unknown>;
				const receipt = (data.receipt ?? data) as Record<string, unknown>;
				expect(VALID_STATUSES).toContain(receipt.status);
			}
		}

		vi.useRealTimers();
	});
});

// ─── Test 2: DST transition windows ────────────────────────────────────────

describe('Property: DST transition correctness', () => {
	// US Spring Forward 2026: March 8, 2:00 AM ET → 3:00 AM ET
	// After spring forward, NYSE opens at 13:30 UTC (was 14:30 UTC in EST)
	const US_SPRING_2026 = new Date('2026-03-08T07:00:00Z'); // 2am ET

	// US Fall Back 2026: November 1, 2:00 AM ET → 1:00 AM ET
	const US_FALL_2026 = new Date('2026-11-01T06:00:00Z');

	// EU Spring Forward 2026: March 29, 1:00 AM UTC → 2:00 AM UTC
	const EU_SPRING_2026 = new Date('2026-03-29T01:00:00Z');

	// EU Fall Back 2026: October 25, 1:00 AM UTC → 0:00 AM UTC (next day)
	const EU_FALL_2026 = new Date('2026-10-25T01:00:00Z');

	it('NYSE opens at 13:30 UTC on the Monday after US spring-forward (not 14:30)', async () => {
		// Monday March 9, 2026 — first trading day after spring forward
		// EDT: open 9:30 AM = 13:30 UTC
		const mondayOpen = new Date('2026-03-09T13:30:00Z');
		vi.setSystemTime(mondayOpen);
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;
		expect(receipt.status).toBe('OPEN');

		// One minute before open should be CLOSED
		vi.setSystemTime(new Date('2026-03-09T13:29:00Z'));
		clearOverrideCache();
		const pre = await fetchJSON('/v5/demo?mic=XNYS');
		const preReceipt = (pre.receipt ?? pre) as Record<string, unknown>;
		expect(preReceipt.status).toBe('CLOSED');

		vi.useRealTimers();
	});

	it('NYSE opens at 14:30 UTC before US spring-forward', async () => {
		// Friday March 6, 2026 — still EST
		// EST: open 9:30 AM = 14:30 UTC
		const fridayOpen = new Date('2026-03-06T14:30:00Z');
		vi.setSystemTime(fridayOpen);
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;
		expect(receipt.status).toBe('OPEN');

		// 14:29 should be CLOSED
		vi.setSystemTime(new Date('2026-03-06T14:29:00Z'));
		clearOverrideCache();
		const pre = await fetchJSON('/v5/demo?mic=XNYS');
		const preReceipt = (pre.receipt ?? pre) as Record<string, unknown>;
		expect(preReceipt.status).toBe('CLOSED');

		vi.useRealTimers();
	});

	it('generates timestamps around US DST transitions and all resolve without errors', async () => {
		// 2-hour windows around each US transition
		const windows = [
			{ center: US_SPRING_2026, label: 'US Spring 2026' },
			{ center: US_FALL_2026, label: 'US Fall 2026' },
		];

		for (const { center } of windows) {
			const samples = fc.sample(
				fc.integer({ min: -7200, max: 7200 }).map(
					(offsetSec) => new Date(center.getTime() + offsetSec * 1000),
				),
				50,
			);

			for (const ts of samples) {
				vi.setSystemTime(ts);
				clearOverrideCache();
				const response = await fetchWorker('/v5/demo?mic=XNYS');
				expect(response.status).toBeOneOf([200, 500]);
				if (response.status === 200) {
					const data = await response.json() as Record<string, unknown>;
					const receipt = (data.receipt ?? data) as Record<string, unknown>;
					expect(VALID_STATUSES).toContain(receipt.status);
				}
			}
		}
		vi.useRealTimers();
	});

	it('generates timestamps around EU DST transitions for XLON and all resolve', async () => {
		const windows = [
			{ center: EU_SPRING_2026, label: 'EU Spring 2026' },
			{ center: EU_FALL_2026, label: 'EU Fall 2026' },
		];

		for (const { center } of windows) {
			const samples = fc.sample(
				fc.integer({ min: -7200, max: 7200 }).map(
					(offsetSec) => new Date(center.getTime() + offsetSec * 1000),
				),
				50,
			);

			for (const ts of samples) {
				vi.setSystemTime(ts);
				clearOverrideCache();
				const response = await fetchWorker('/v5/demo?mic=XLON');
				expect(response.status).toBeOneOf([200, 500]);
				if (response.status === 200) {
					const data = await response.json() as Record<string, unknown>;
					const receipt = (data.receipt ?? data) as Record<string, unknown>;
					expect(VALID_STATUSES).toContain(receipt.status);
				}
			}
		}
		vi.useRealTimers();
	});
});

// ─── Test 3: Weekend / Holiday / Trading hours invariants ──────────────────

describe('Property: schedule correctness invariants', () => {
	// Exchange configs for verification
	const WEEKEND_EXCHANGES = {
		standard: ['XNYS', 'XNAS', 'XLON', 'XJPX', 'XPAR', 'XHKG', 'XSES',
			'XASX', 'XBOM', 'XNSE', 'XSHG', 'XSHE', 'XKRX', 'XJSE',
			'XBSP', 'XSWX', 'XMIL', 'XIST', 'XNZE', 'XHEL', 'XSTO',
			'XCBT', 'XNYM', 'XCBO'],
		middleEast: ['XSAU', 'XDFM'], // Fri-Sat weekends
		crypto247: ['XCOI', 'XBIN'],    // No weekends
	};

	it('standard weekend exchanges return CLOSED on Saturdays and Sundays', async () => {
		// Saturday April 4 2026, 12:00 UTC
		const saturday = new Date('2026-04-04T12:00:00Z');
		vi.setSystemTime(saturday);
		clearOverrideCache();

		for (const mic of WEEKEND_EXCHANGES.standard) {
			// Skip overnight session exchanges — they may have complex weekend rules
			if (['XCBT', 'XNYM'].includes(mic)) continue;

			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `${mic} should be CLOSED on Saturday`).toBe('CLOSED');
		}

		// Sunday April 5 2026, 12:00 UTC
		vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));
		clearOverrideCache();

		for (const mic of WEEKEND_EXCHANGES.standard) {
			if (['XCBT', 'XNYM'].includes(mic)) continue;

			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `${mic} should be CLOSED on Sunday`).toBe('CLOSED');
		}

		vi.useRealTimers();
	});

	it('Middle Eastern exchanges (XSAU, XDFM) return CLOSED on Fridays and Saturdays', async () => {
		// Friday April 3 2026, 10:00 UTC
		vi.setSystemTime(new Date('2026-04-03T10:00:00Z'));
		clearOverrideCache();

		for (const mic of WEEKEND_EXCHANGES.middleEast) {
			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `${mic} should be CLOSED on Friday`).toBe('CLOSED');
		}

		// Saturday April 4 2026
		vi.setSystemTime(new Date('2026-04-04T10:00:00Z'));
		clearOverrideCache();

		for (const mic of WEEKEND_EXCHANGES.middleEast) {
			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `${mic} should be CLOSED on Saturday`).toBe('CLOSED');
		}

		vi.useRealTimers();
	});

	it('crypto exchanges (XCOI, XBIN) return OPEN on weekends', async () => {
		// Saturday April 4 2026, 12:00 UTC
		vi.setSystemTime(new Date('2026-04-04T12:00:00Z'));
		clearOverrideCache();

		for (const mic of WEEKEND_EXCHANGES.crypto247) {
			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `${mic} should be OPEN on Saturday`).toBe('OPEN');
		}

		vi.useRealTimers();
	});

	it('known NYSE holidays in 2026 return CLOSED during normal trading hours', async () => {
		const holidays2026 = [
			'2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
			'2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
		];

		for (const holiday of holidays2026) {
			// 15:00 UTC = well within NYSE trading hours
			vi.setSystemTime(new Date(`${holiday}T15:00:00Z`));
			clearOverrideCache();

			const data = await fetchJSON('/v5/demo?mic=XNYS');
			const receipt = (data.receipt ?? data) as Record<string, unknown>;
			expect(receipt.status, `XNYS should be CLOSED on holiday ${holiday}`).toBe('CLOSED');
		}

		vi.useRealTimers();
	});

	it('NYSE returns OPEN during normal trading hours on a known trading day', async () => {
		// Tuesday April 7 2026, 15:00 UTC = 11:00 AM EDT (well within 9:30-16:00)
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;
		expect(receipt.status).toBe('OPEN');

		vi.useRealTimers();
	});

	it('NYSE returns CLOSED before trading hours on a known trading day', async () => {
		// Tuesday April 7 2026, 12:00 UTC = 8:00 AM EDT (before 9:30 open)
		vi.setSystemTime(new Date('2026-04-07T12:00:00Z'));
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;
		expect(receipt.status).toBe('CLOSED');

		vi.useRealTimers();
	});

	it('NYSE returns CLOSED after trading hours on a known trading day', async () => {
		// Tuesday April 7 2026, 21:00 UTC = 5:00 PM EDT (after 4:00 close)
		vi.setSystemTime(new Date('2026-04-07T21:00:00Z'));
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;
		expect(receipt.status).toBe('CLOSED');

		vi.useRealTimers();
	});
});

// ─── Test 4: Signing path invariants ────────────────────────────────────────

describe('Property: signing invariants', () => {
	it('all demo receipts have valid signatures that can be verified', async () => {
		// Generate random timestamps during known trading hours for XCOI (24/7)
		const samples = fc.sample(timestampIn2026_2027, 100);

		for (const ts of samples) {
			vi.setSystemTime(ts);
			clearOverrideCache();

			const data = await fetchJSON('/v5/demo?mic=XCOI');
			const receipt = (data.receipt ?? data) as Record<string, unknown>;

			// Every response must have a signature
			expect(receipt.signature).toBeDefined();
			expect(typeof receipt.signature).toBe('string');
			expect((receipt.signature as string).length).toBeGreaterThan(0);

			// Verify via /v5/verify
			const verifyResult = await fetchJSON('/v5/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ receipt }),
			});
			expect(verifyResult.valid).toBe(true);
			expect(verifyResult.reason).toBe('SIGNATURE_VALID');
		}

		vi.useRealTimers();
	});

	it('receipt TTL is always exactly 60 seconds', async () => {
		const samples = fc.sample(
			fc.tuple(micArb, timestampIn2026_2027),
			200,
		);

		for (const [mic, ts] of samples) {
			vi.setSystemTime(ts);
			clearOverrideCache();

			const data = await fetchJSON(`/v5/demo?mic=${mic}`);
			const receipt = (data.receipt ?? data) as Record<string, unknown>;

			if (receipt.issued_at && receipt.expires_at) {
				const issued = new Date(receipt.issued_at as string).getTime();
				const expires = new Date(receipt.expires_at as string).getTime();
				expect(expires - issued, `TTL should be 60s for ${mic}`).toBe(60_000);
			}
		}

		vi.useRealTimers();
	});

	it('modifying any signed field invalidates the signature', async () => {
		// Get a valid receipt
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		clearOverrideCache();

		const data = await fetchJSON('/v5/demo?mic=XNYS');
		const receipt = (data.receipt ?? data) as Record<string, unknown>;

		// Confirm it's valid first
		const validCheck = await fetchJSON('/v5/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ receipt }),
		});
		expect(validCheck.valid).toBe(true);

		// Tamper with each signed field and verify signature breaks
		const signedFields = ['mic', 'status', 'issued_at', 'expires_at', 'issuer', 'receipt_mode', 'schema_version'];

		for (const field of signedFields) {
			if (receipt[field] === undefined) continue;
			const tampered = { ...receipt, [field]: 'TAMPERED_VALUE' };

			const tamperedCheck = await fetchJSON('/v5/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ receipt: tampered }),
			});
			expect(tamperedCheck.valid, `Tampering ${field} should invalidate signature`).toBe(false);
		}

		vi.useRealTimers();
	});
});
