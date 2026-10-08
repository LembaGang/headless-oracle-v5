// Test helper for the x402 mint payer binding (option A of
// docs/security/x402-mint-payment-binding.md, 2026-10-08). Not a spec file:
// vitest only collects *.spec.ts.
//
// A real secp256k1 key is generated per import, its Ethereum address is what
// the mocked Base RPC reports as the USDC Transfer `from`, and signMint()
// produces the EIP-191 personal_sign signature the route requires, over the
// message the worker itself defines (x402MintSigningMessage).
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { x402MintSigningMessage } from '../src';

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface MintSigner { secretKey: Uint8Array; address: string }

export function newMintSigner(): MintSigner {
	const secretKey = secp256k1.utils.randomSecretKey();
	const pub = secp256k1.getPublicKey(secretKey, false);
	return { secretKey, address: '0x' + hex(keccak_256(pub.slice(1)).slice(-20)) };
}

// Signs `message` as personal_sign does and returns r || s || v (v = 27/28).
export function personalSign(message: string, secretKey: Uint8Array, vBase: 0 | 27 = 27): string {
	const enc = new TextEncoder();
	const msg = enc.encode(message);
	const prefix = enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`);
	const all = new Uint8Array(prefix.length + msg.length);
	all.set(prefix, 0);
	all.set(msg, prefix.length);
	// 'recovered' puts the recovery byte FIRST; Ethereum puts v last.
	const rec = secp256k1.sign(keccak_256(all), secretKey, { prehash: false, format: 'recovered' });
	return '0x' + hex(rec.slice(1)) + (rec[0] + vBase).toString(16).padStart(2, '0');
}

export function signMint(txHash: string, signer: MintSigner, vBase: 0 | 27 = 27): string {
	return personalSign(x402MintSigningMessage(txHash), signer.secretKey, vBase);
}

// One payer shared by every mint test that does not need its own.
export const MINT_PAYER = newMintSigner();
