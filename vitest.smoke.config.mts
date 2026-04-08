import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/integration/smoke.test.ts'],
		testTimeout: 30_000, // network calls to production
	},
});
