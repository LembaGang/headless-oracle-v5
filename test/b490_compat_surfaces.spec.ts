// B-490 (4): the default (v5.0) bytes of the webhook deliveries and the SSE
// stream are the parent's, byte for byte. The fixture is the output of
// captureSurfaces (test/b490_compat_capture.ts) run at ae81d4d, the parent of
// B-490, with the same fixed time and receipt_id. Rev 3: one test per case;
// rev 4: one test per surface of each case (captureCase with `only`), so no
// test runs long; see the note on captureCase.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { captureCase, CASES, SURFACES } from './b490_compat_capture';
import { StreamCoordinator } from '../src';
import PARENT from './fixtures/b490_compat_surfaces.json';

afterEach(() => { vi.useRealTimers(); });

describe('B-490 (4): webhook and SSE default bytes equal the parent\'s', () => {
	it('the fixture holds every surface of every case, and only those', () => {
		const want = CASES.flatMap(([mic, entry]) => SURFACES.map((x) => `${x}.${mic}.${entry}`)).sort();
		expect(Object.keys(PARENT).sort()).toEqual(want);
		expect(want.length).toBe(20);
	});
	for (const [mic, entry] of CASES) {
		for (const surface of SURFACES) {
			it(`${surface}, byte for byte: ${mic} with entry ${entry}`, async () => {
				const got = await captureCase(mic, entry, surface);
				console.log(`B490_COMPAT ${JSON.stringify(got)}`); // the kit counts the surfaces these lines hold
				const k = `${surface}.${mic}.${entry}`;
				expect(Object.keys(got)).toEqual([k]);
				expect(got[k], k).toBe((PARENT as Record<string, string>)[k]);
				expect(got[k].length, `${k} is not empty`).toBeGreaterThan(40);
			});
		}
	}
	it('rev 3: after the client cancels, the SSE loop ends at once (it slept up to 30 s and built one more receipt before; red on the parent)', async () => {
		vi.setSystemTime(new Date('2026-04-07T15:00:00Z')); // XJPX CLOSED: the loop goes to its 30 s wait after the first event
		const st = { storage: { get: async () => undefined, put: async () => {} } } as never;
		const co = new StreamCoordinator(st, env as never);
		const r = await co.fetch(new Request('https://headlessoracle.com/v5/stream?mic=XJPX'));
		const rd = r.body!.getReader();
		await rd.read();
		await rd.cancel();
		const loop = (co as unknown as { lastStream?: Promise<void> | null }).lastStream;
		expect(loop).toBeInstanceOf(Promise);
		vi.useRealTimers();
		let bound: ReturnType<typeof setTimeout> | undefined;
		const ended = await Promise.race([loop!.then(() => 'ended'), new Promise((res) => { bound = setTimeout(() => res('still running after 2 s'), 2000); })]);
		clearTimeout(bound);
		expect(ended).toBe('ended');
	});
	it('each surface delivered a receipt, and the receipts are v5.0 without the v5.1 fields', () => {
		for (const [k, v] of Object.entries(PARENT as Record<string, string>)) {
			expect(v, k).toContain('"schema_version":"v5.0"');
			expect(v, k).not.toContain('session_phase');
			expect(v, k).not.toContain('closure_reason');
		}
	});
});
