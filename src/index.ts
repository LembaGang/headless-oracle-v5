import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

export interface Env {
	ED25519_PRIVATE_KEY: string;
	ED25519_PUBLIC_KEY: string;
	MASTER_API_KEY: string;
	BETA_API_KEYS: string;
	PUBLIC_KEY_ID: string;
}

// ─── Hex Helpers ────────────────────────────────────────────────────────────

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

// ─── NYSE Schedule ──────────────────────────────────────────────────────────

const NYSE_HOLIDAYS_2026 = [
	'2026-01-01', // New Year's Day
	'2026-01-19', // MLK Day
	'2026-02-16', // Presidents' Day
	'2026-04-03', // Good Friday
	'2026-05-25', // Memorial Day
	'2026-06-19', // Juneteenth
	'2026-07-03', // Independence Day (observed)
	'2026-09-07', // Labor Day
	'2026-11-26', // Thanksgiving
	'2026-12-25', // Christmas
];

function getMarketStatus(mic: string): { status: string; source: string } {
	if (mic !== 'XNYS' && mic !== 'XNAS') {
		return { status: 'UNKNOWN', source: 'SCHEDULE' };
	}

	const now = new Date();
	const etParts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		weekday: 'short',
		hour12: false,
	}).formatToParts(now);

	const get = (type: Intl.DateTimeFormatPartTypes) => etParts.find((p) => p.type === type)!.value;

	const weekday = get('weekday');
	const year = get('year');
	const month = get('month');
	const day = get('day');
	const hour = parseInt(get('hour'), 10);
	const minute = parseInt(get('minute'), 10);

	// Weekend check
	if (weekday === 'Sat' || weekday === 'Sun') {
		return { status: 'CLOSED', source: 'SCHEDULE' };
	}

	// Holiday check
	const dateStr = `${year}-${month}-${day}`;
	if (NYSE_HOLIDAYS_2026.includes(dateStr)) {
		return { status: 'CLOSED', source: 'SCHEDULE' };
	}

	// Market hours: 9:30 AM – 4:00 PM ET
	const timeMinutes = hour * 60 + minute;
	if (timeMinutes >= 570 && timeMinutes < 960) {
		// 570 = 9:30, 960 = 16:00
		return { status: 'OPEN', source: 'SCHEDULE' };
	}

	return { status: 'CLOSED', source: 'SCHEDULE' };
}

// ─── Signing ────────────────────────────────────────────────────────────────

async function signPayload(payload: Record<string, string>, privKeyHex: string): Promise<string> {
	const canonicalString = JSON.stringify(payload);
	const msgBytes = new TextEncoder().encode(canonicalString);
	const privKeyBytes = fromHex(privKeyHex);
	const signature = await ed.sign(msgBytes, privKeyBytes);
	return toHex(signature);
}

// ─── API Key Validation ─────────────────────────────────────────────────────

function isValidApiKey(key: string, env: Env): boolean {
	// Check master key first
	if (key === env.MASTER_API_KEY) return true;

	// Check beta keys (comma-separated list)
	if (env.BETA_API_KEYS) {
		const betaKeys = env.BETA_API_KEYS.split(',').map((k) => k.trim());
		if (betaKeys.includes(key)) return true;
	}

	return false;
}

// ─── Worker ─────────────────────────────────────────────────────────────────

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
			// ── API Key Gating ───────────────────────────────────────────
			// Gate /v5/status — allow /v5/demo and /v5/keys without auth
			if (url.pathname.startsWith('/v5/status')) {
				const apiKey = request.headers.get('X-Oracle-Key');

				if (!apiKey) {
					return new Response(
						JSON.stringify({
							error: 'API_KEY_REQUIRED',
							message: 'Include X-Oracle-Key header',
						}),
						{
							status: 401,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						}
					);
				}

				if (!isValidApiKey(apiKey, env)) {
					return new Response(
						JSON.stringify({
							error: 'INVALID_API_KEY',
						}),
						{
							status: 403,
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						}
					);
				}
			}

			// ── Route: /v5/keys (Public) ─────────────────────────────────
			if (url.pathname === '/v5/keys') {
				const publicKey = env.ED25519_PUBLIC_KEY || '';
				return new Response(
					JSON.stringify({
						keys: [
							{
								key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
								algorithm: 'Ed25519',
								format: 'spki-pem',
								public_key: publicKey,
							},
						],
					}),
					{
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					}
				);
			}

			// ── Route: /v5/status (Authenticated) & /v5/demo (Public) ───
			if (url.pathname === '/v5/status' || url.pathname === '/v5/demo') {
				const mic = url.searchParams.get('mic') || 'XNYS';

				try {
					// TIER 1: Normal Operation — compute market status, sign receipt
					const { status, source } = getMarketStatus(mic);

					const payload = {
						receipt_id: crypto.randomUUID(),
						issued_at: new Date().toISOString(),
						mic: mic,
						status: status,
						source: source,
						terms_hash: 'v5.0-beta',
						public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
					};

					const signature = await signPayload(payload, env.ED25519_PRIVATE_KEY);

					const receipt = {
						...payload,
						signature: signature,
					};

					return new Response(JSON.stringify(receipt), {
						headers: { ...corsHeaders, 'Content-Type': 'application/json' },
					});
				} catch (tier1Error: unknown) {
					// TIER 2: Fail-Closed Safety Net
					// If anything fails (signing, market status, etc.), return a signed UNKNOWN receipt.
					// Consumers MUST treat UNKNOWN as CLOSED (halt execution).
					const tier1Msg = tier1Error instanceof Error ? tier1Error.message : 'Unknown error';
					console.error(`ORACLE_TIER_1_FAILURE: ${tier1Msg}`);

					try {
						const safePayload = {
							receipt_id: crypto.randomUUID(),
							issued_at: new Date().toISOString(),
							mic: mic,
							status: 'UNKNOWN',
							source: 'SYSTEM',
							terms_hash: 'v5.0-beta',
							public_key_id: env.PUBLIC_KEY_ID || 'key_2026_v1',
						};

						const safeSignature = await signPayload(safePayload, env.ED25519_PRIVATE_KEY);

						const safeReceipt = {
							...safePayload,
							signature: safeSignature,
						};

						return new Response(JSON.stringify(safeReceipt), {
							headers: { ...corsHeaders, 'Content-Type': 'application/json' },
						});
					} catch (tier2Error: unknown) {
						// TIER 3: Catastrophic — even signing the safety receipt failed
						// (private key missing/corrupt). Return unsigned error.
						const tier2Msg = tier2Error instanceof Error ? tier2Error.message : 'Unknown error';
						console.error(`ORACLE_TIER_2_CATASTROPHIC: ${tier2Msg}`);

						return new Response(
							JSON.stringify({
								error: 'CRITICAL_FAILURE',
								message: 'Oracle signature system offline. Treat as UNKNOWN. Halt all execution.',
								status: 'UNKNOWN',
								source: 'SYSTEM',
							}),
							{
								status: 500,
								headers: { ...corsHeaders, 'Content-Type': 'application/json' },
							}
						);
					}
				}
			}

			// ── Default: 404 ─────────────────────────────────────────────
			return new Response(JSON.stringify({ error: 'Not Found' }), {
				status: 404,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
			});
		} catch (err: unknown) {
			// Top-level safety net — should never reach here, but guarantees CORS headers
			const message = err instanceof Error ? err.message : 'Internal server error';
			console.error(`ORACLE_TOP_LEVEL_ERROR: ${message}`);
			return new Response(
				JSON.stringify({
					error: 'CRITICAL_FAILURE',
					message: 'Oracle system error. Treat as UNKNOWN. Halt all execution.',
					status: 'UNKNOWN',
					source: 'SYSTEM',
				}),
				{
					status: 500,
					headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				}
			);
		}
	},
};
