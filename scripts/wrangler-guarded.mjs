#!/usr/bin/env node
// Run wrangler only on HO's own Cloudflare token. Usage:
//   node scripts/wrangler-guarded.mjs <wrangler args...>
//   npm run deploy                                   (goes through this)
//   npm run wrangler:guarded -- d1 migrations apply <db> --remote
// Refuses with exit 2, before wrangler starts, unless CLOUDFLARE_API_TOKEN verifies
// to package.json config.cloudflareTokenId. CF_API_TOKEN is removed from wrangler's
// environment. See scripts/cf-token-guard-core.mjs for why. Never prints a token.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCloudflareToken } from './cf-token-guard-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expectedId = pkg.config && pkg.config.cloudflareTokenId;

const verify = async (token) => {
	const r = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15000),
	});
	let body = null;
	try {
		body = await r.json();
	} catch {
		body = null;
	}
	return { httpStatus: r.status, body };
};

// process.exitCode, never process.exit(): on Windows, exiting while the verify
// request's socket is still closing aborts Node with a libuv assertion and exit 127
// (seen 2026-11-09), which would make the refusal code nondeterministic.
const check = await checkCloudflareToken({ env: process.env, expectedId, verify });
if (!check.ok) {
	console.error(`[cf-guard] REFUSED ${check.code}: ${check.message}. wrangler was not run.`);
	process.exitCode = 2;
} else {
	console.error(`[cf-guard] OK: token id ${check.tokenId} active; CF_API_TOKEN removed from wrangler's environment.`);
	// Run the repository's own wrangler with node directly: no shell, so arguments pass through unquoted.
	const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
	const run = spawnSync(process.execPath, [wranglerBin, ...process.argv.slice(2)], { stdio: 'inherit', env: check.childEnv, cwd: root });
	if (run.error) console.error(`[cf-guard] could not start wrangler: ${run.error.message}`);
	process.exitCode = run.error ? 1 : (run.status ?? 1);
}
