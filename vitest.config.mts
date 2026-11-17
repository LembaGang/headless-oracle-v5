import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		exclude: ['test/integration/**', 'test/property/**', 'node_modules/**'],
		// B-488: vitest's defaults (5 s per test, 10 s per hook) timed out on the
		// laptop under memory pressure (2026-11-16). A longer limit only waits longer
		// for a slow test; a failing assertion still fails.
		testTimeout: 20_000,
		hookTimeout: 20_000,
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
				// The unit suite never touches the internet. Any fetch a test did not
				// stub itself lands here and gets a fast 503 instead of a real network
				// call. Before this, tests that reached live hosts (the Nasdaq halts
				// feed, Supabase, Pages) took as long as the remote host did, and on a
				// slow link passed vitest's 5s limit at random, on any commit
				// (2026-10-07). A 503 is what a down dependency looks like, and every
				// code path the suite exercises must already fail closed on that.
				miniflare: {
					outboundService: (request: Request) => {
						if (process.env.HO_TEST_LOG_OUTBOUND) console.error(`[test-outbound-blocked] ${request.method} ${new URL(request.url).host}`);
						return new Response('blocked: the unit suite has no network (vitest.config.mts)', { status: 503 });
					},
				},
			},
		},
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'text-summary', 'json-summary', 'json', 'html'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['node_modules/**', 'test/**', '**/*.d.ts'],
		},
	},
});
