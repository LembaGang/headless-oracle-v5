import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

export interface Env {
	SUPABASE_URL: string;
	SUPABASE_KEY: string;
	ED25519_PRIVATE_KEY: string;
	MASTER_API_KEY: string;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, X-Oracle-Key',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// API Key Gating — gate /v5/status but allow /v5/demo without auth
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');
				if (!apiKey || apiKey !== env.MASTER_API_KEY) {
					return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Invalid or missing X-Oracle-Key' }), {
						status: 401,
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				}
			}

			// Routing
			if (url.pathname === '/v5/status' || url.pathname === '/v5/demo') {
				const mic = url.searchParams.get('mic') || 'XNYS';

				const status = 'CLOSED';
				const source = 'SCHEDULE';

				const payload = {
					receipt_id: crypto.randomUUID(),
					issued_at: new Date().toISOString(),
					mic: mic,
					status: status,
					source: source,
					terms_hash: 'v5.0-beta',
					public_key_id: 'key_2026_v1',
				};

				const canonicalString = JSON.stringify(payload);
				const msgBytes = new TextEncoder().encode(canonicalString);
				const privKeyBytes = fromHex(env.ED25519_PRIVATE_KEY);
				const signature = await ed.sign(msgBytes, privKeyBytes);

				const receipt = {
					...payload,
					signature: toHex(signature),
				};

				return new Response(JSON.stringify(receipt), {
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				});
			}

			return new Response(JSON.stringify({ error: 'Not Found' }), {
				status: 404,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : 'Internal server error';
			return new Response(JSON.stringify({ error: 'Internal Server Error', details: message }), {
				status: 500,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			});
		}
	},
};