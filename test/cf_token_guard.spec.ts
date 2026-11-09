// The deploy-token guard (scripts/cf-token-guard-core.mjs). On 2026-11-09 HO's
// CLOUDFLARE_API_TOKEN was removed from the laptop by another project's session and
// wrangler fell back, with only a deprecation warning, to that project's CF_API_TOKEN.
// The guard makes every hov5 deploy path refuse unless the token in use is HO's own,
// identified by the id Cloudflare's verify endpoint returns.
import { describe, it, expect } from 'vitest';
import { checkCloudflareToken } from '../scripts/cf-token-guard-core.mjs';

const EXPECTED = '4bfa83d2a7477d4bb9aa65ea12b0cc61';
const HO_TOKEN = 'ho-token-value-under-test-0001';
const OTHER_TOKEN = 'other-project-token-value-0002';

// Flat view of the result union so each test can read the fields it asserts on.
type R = { ok: boolean; code?: string; message?: string; tokenId?: string; childEnv?: Record<string, string | undefined> };

function verifyReturning(id: string | null, status = 'active', httpStatus = 200) {
	const calls: string[] = [];
	const verify = async (token: string) => {
		calls.push(token);
		return {
			httpStatus,
			body: id ? { success: true, result: { id, status }, errors: [] } : { success: false, result: null, errors: [{ code: 1000, message: 'Invalid API Token' }] },
		};
	};
	return { verify, calls };
}

function noTokenLeak(result: unknown) {
	const text = JSON.stringify(result);
	expect(text).not.toContain(HO_TOKEN);
	expect(text).not.toContain(OTHER_TOKEN);
}

describe('cf token guard: refuses', () => {
	it('when CLOUDFLARE_API_TOKEN is missing, without calling verify', async () => {
		const { verify, calls } = verifyReturning(EXPECTED);
		const r: R = await checkCloudflareToken({ env: {}, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('TOKEN_MISSING');
		expect(calls.length).toBe(0);
	});

	it('when only CF_API_TOKEN is set (the silent fallback of 2026-11-09)', async () => {
		const { verify, calls } = verifyReturning(EXPECTED);
		const r: R = await checkCloudflareToken({ env: { CF_API_TOKEN: OTHER_TOKEN }, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('TOKEN_MISSING');
		expect(calls.length).toBe(0);
		noTokenLeak(r);
	});

	it('when the token verifies to a different id', async () => {
		const { verify } = verifyReturning('ffffffffffffffffffffffffffffffff');
		const r: R = await checkCloudflareToken({ env: { CLOUDFLARE_API_TOKEN: OTHER_TOKEN }, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('TOKEN_ID_MISMATCH');
		noTokenLeak(r);
	});

	it('when Cloudflare rejects the token (401)', async () => {
		const { verify } = verifyReturning(null, 'active', 401);
		const r: R = await checkCloudflareToken({ env: { CLOUDFLARE_API_TOKEN: HO_TOKEN }, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('VERIFY_FAILED');
		noTokenLeak(r);
	});

	it('when the verify call itself fails (network down is not a pass)', async () => {
		const verify = async () => {
			throw new Error('network down');
		};
		const r: R = await checkCloudflareToken({ env: { CLOUDFLARE_API_TOKEN: HO_TOKEN }, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('VERIFY_FAILED');
	});

	it('when the right id is not active', async () => {
		const { verify } = verifyReturning(EXPECTED, 'disabled');
		const r: R = await checkCloudflareToken({ env: { CLOUDFLARE_API_TOKEN: HO_TOKEN }, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('TOKEN_NOT_ACTIVE');
	});

	it('when no expected id is configured', async () => {
		const { verify, calls } = verifyReturning(EXPECTED);
		const r: R = await checkCloudflareToken({ env: { CLOUDFLARE_API_TOKEN: HO_TOKEN }, expectedId: '', verify });
		expect(r.ok).toBe(false);
		expect(r.code).toBe('EXPECTED_ID_MISSING');
		expect(calls.length).toBe(0);
	});
});

describe('cf token guard: passes', () => {
	it('with HO token id, and the child env carries no CF_API_TOKEN', async () => {
		const { verify, calls } = verifyReturning(EXPECTED);
		const env = { CLOUDFLARE_API_TOKEN: HO_TOKEN, CF_API_TOKEN: OTHER_TOKEN, PATH: '/bin' };
		const r: R = await checkCloudflareToken({ env, expectedId: EXPECTED, verify });
		expect(r.ok).toBe(true);
		expect(calls).toEqual([HO_TOKEN]);
		expect(r.childEnv?.CLOUDFLARE_API_TOKEN).toBe(HO_TOKEN);
		expect('CF_API_TOKEN' in (r.childEnv ?? {})).toBe(false);
		expect(r.childEnv?.PATH).toBe('/bin');
		// the caller's env is not mutated
		expect(env.CF_API_TOKEN).toBe(OTHER_TOKEN);
		expect(r.tokenId).toBe(EXPECTED);
	});
});
