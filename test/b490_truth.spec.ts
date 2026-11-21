// B-490 (5): the served and published descriptions match what is signed. No
// behaviour changes in this commit.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { clearOverrideCache, scheduleMics } from '../src';
import HALT_MONITOR_MD from '../docs/halt-monitor.md';

async function call(path: string): Promise<Response> {
	clearOverrideCache();
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`https://headlessoracle.com${path}`) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
afterEach(async () => { vi.useRealTimers(); await env.ORACLE_OVERRIDES.delete('XNYS'); clearOverrideCache(); });

describe('B-490 (5): the OpenAPI SignedReceipt describes every signed field and no other', () => {
	it('its properties are the v5.1 override field list and the signature; required is the v5.0 receipt field list and the signature (red: coverage was missing)', async () => {
		const spec = await (await call('/openapi.json')).json() as { components: { schemas: { SignedReceipt: { required: string[]; properties: Record<string, unknown> } } } };
		const keys = ((await (await call('/v5/keys')).json()) as { canonical_payload_spec: { receipt_fields: string[]; versions: Record<string, Record<string, string[]>> } }).canonical_payload_spec;
		const sr = spec.components.schemas.SignedReceipt;
		expect(Object.keys(sr.properties).sort()).toEqual([...keys.versions['v5.1'].override_fields, 'signature'].sort());
		expect([...sr.required].sort()).toEqual([...keys.receipt_fields, 'signature'].sort());
	});
});

describe('B-490 (5): docs/halt-monitor.md says what the code signs', () => {
	it('a monitor-detected halt is signed source OVERRIDE, as the receipt shows; the document says so and never that receipts sign source REALTIME (red)', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
		await env.ORACLE_OVERRIDES.put('XNYS', JSON.stringify({ status: 'HALTED', source: 'REALTIME', origin: 'monitor', reason: 'Real-time halt detected by halt monitor (source: polygon)', expires: '2030-01-01T00:00:00Z' }));
		const r = (await (await call('/v5/demo?mic=XNYS')).json() as { receipt: Record<string, string> }).receipt;
		expect([r.status, r.source]).toEqual(['HALTED', 'OVERRIDE']);
		expect(JSON.parse(r.coverage).consulted).toContain('realtime_halt_feed_via_override');
		expect(HALT_MONITOR_MD).toContain("status: 'HALTED', source: 'OVERRIDE'");
		expect(HALT_MONITOR_MD).not.toContain("source: 'REALTIME'`");
		expect(HALT_MONITOR_MD).not.toMatch(/will have `source: 'REALTIME'`|return `status: 'HALTED', source: 'REALTIME'`/);
	});
	// Rev 4: one test per exchange (a demo receipt each), and one for the count,
	// so no test runs long.
	const mapped = [...HALT_MONITOR_MD.matchAll(/^\| (X[A-Z]{3}) \| [a-z]+ +\|$/gm)].map((m) => m[1]);
	it('the Polygon mapping names only exchanges the oracle knows, and the exchange count is right (red: it said 23)', () => {
		for (const m of mapped) expect(scheduleMics(), m).toContain(m);
		expect(HALT_MONITOR_MD).toContain(`All ${scheduleMics().length} exchanges`);
	});
	for (const mic of scheduleMics()) {
		it(`the Polygon mapping lists ${mic} exactly when its receipts sign halt_detection active (red: it listed XASX)`, async () => {
			vi.setSystemTime(new Date('2026-04-07T15:00:00Z'));
			const r = (await (await call(`/v5/demo?mic=${mic}`)).json() as { receipt: Record<string, string> }).receipt;
			expect(mapped.includes(mic), `${mic}: mapped`).toBe(r.halt_detection === 'active');
		});
	}
});
