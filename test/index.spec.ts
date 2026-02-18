import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('Headless Oracle V5 Worker', () => {
	describe('CORS', () => {
		it('OPTIONS returns CORS headers', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/demo', {
				method: 'OPTIONS',
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
			expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Oracle-Key');
		});
	});

	describe('GET /v5/demo', () => {
		it('returns a signed receipt without auth', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/demo');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('receipt_id');
			expect(body).toHaveProperty('issued_at');
			expect(body).toHaveProperty('mic', 'XNYS');
			expect(body).toHaveProperty('status');
			expect(body).toHaveProperty('source');
			expect(body).toHaveProperty('terms_hash', 'v5.0-beta');
			expect(body).toHaveProperty('public_key_id');
			expect(body).toHaveProperty('signature');
			// Signature should be 128-char hex (64 bytes)
			expect((body.signature as string).length).toBe(128);
		});
	});

	describe('GET /v5/status', () => {
		it('returns 401 without API key', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/status?mic=XNYS');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(401);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'API_KEY_REQUIRED');
		});

		it('returns 403 with invalid API key', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/status?mic=XNYS', {
				headers: { 'X-Oracle-Key': 'invalid_key' },
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(403);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('error', 'INVALID_API_KEY');
		});
	});

	describe('GET /v5/keys', () => {
		it('returns public key without auth', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/v5/keys');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(200);
			const body = await response.json() as Record<string, unknown>;
			expect(body).toHaveProperty('keys');
			const keys = body.keys as Array<Record<string, unknown>>;
			expect(keys.length).toBe(1);
			expect(keys[0]).toHaveProperty('key_id');
			expect(keys[0]).toHaveProperty('algorithm', 'Ed25519');
			expect(keys[0]).toHaveProperty('format', 'spki-pem');
			expect(keys[0]).toHaveProperty('public_key');
		});
	});

	describe('404', () => {
		it('returns 404 for unknown routes', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/unknown');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(404);
		});
	});
});
