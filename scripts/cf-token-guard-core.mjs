// Pure check behind scripts/wrangler-guarded.mjs. No Node imports, so the workers
// test suite can import it (test/cf_token_guard.spec.ts).
//
// Why: two Cloudflare tokens live in this laptop's User environment, HO's
// CLOUDFLARE_API_TOKEN and another project's CF_API_TOKEN. When HO's was removed on
// 2026-11-09, wrangler fell back to CF_API_TOKEN with only a deprecation warning, and
// that token failed an HO routes deploy before (2026-10-09). So: CF_API_TOKEN is
// never passed to wrangler, and the token that is passed must verify to HO's id.
// Every refusal is fail-closed, and no message ever contains a token value.

/** Variables wrangler would otherwise fall back to. Removed from the child env. */
export const FALLBACK_TOKEN_VARS = ['CF_API_TOKEN'];

/**
 * @param {{ env: Record<string, string | undefined>, expectedId: string,
 *   verify: (token: string) => Promise<{ httpStatus: number, body: any }> }} args
 * @returns {Promise<{ ok: true, tokenId: string, childEnv: Record<string, string | undefined> }
 *   | { ok: false, code: string, message: string }>}
 */
export async function checkCloudflareToken({ env, expectedId, verify }) {
	if (!expectedId || !/^[0-9a-f]{32}$/.test(expectedId)) {
		return { ok: false, code: 'EXPECTED_ID_MISSING', message: 'package.json config.cloudflareTokenId is missing or not a 32-hex token id' };
	}
	const token = env.CLOUDFLARE_API_TOKEN;
	if (!token) {
		const fallback = FALLBACK_TOKEN_VARS.filter((v) => env[v]);
		return {
			ok: false,
			code: 'TOKEN_MISSING',
			message:
				'CLOUDFLARE_API_TOKEN is not set' +
				(fallback.length ? `; ${fallback.join(', ')} is set but belongs to another project and is never used here` : ''),
		};
	}

	let res;
	try {
		res = await verify(token);
	} catch (e) {
		return { ok: false, code: 'VERIFY_FAILED', message: `token verify request failed: ${e instanceof Error ? e.name : 'error'}` };
	}
	const result = res && res.body && res.body.success === true ? res.body.result : null;
	if (!res || res.httpStatus !== 200 || !result || typeof result.id !== 'string') {
		const codes = (res && res.body && Array.isArray(res.body.errors) ? res.body.errors : []).map((e) => e && e.code).join(',');
		return { ok: false, code: 'VERIFY_FAILED', message: `Cloudflare token verify did not succeed (HTTP ${res ? res.httpStatus : 'none'}${codes ? `, error codes ${codes}` : ''})` };
	}
	if (result.id !== expectedId) {
		// Token ids are not secrets; naming the one seen tells the operator which token is loaded.
		return { ok: false, code: 'TOKEN_ID_MISMATCH', message: `CLOUDFLARE_API_TOKEN verifies to token id ${result.id}, expected ${expectedId}` };
	}
	if (result.status !== 'active') {
		return { ok: false, code: 'TOKEN_NOT_ACTIVE', message: `token ${result.id} status is ${String(result.status)}, not active` };
	}

	const childEnv = { ...env };
	for (const v of FALLBACK_TOKEN_VARS) delete childEnv[v];
	return { ok: true, tokenId: result.id, childEnv };
}
