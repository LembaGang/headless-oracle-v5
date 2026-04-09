import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		exclude: ['test/integration/**', 'test/property/**', 'node_modules/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
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
