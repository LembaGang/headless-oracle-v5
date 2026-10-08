// Verify a pinned example receipt offline. Zero dependencies (Node 20+ Web Crypto).
//
//   node docs/examples/verify-example.mjs docs/examples/<file>.json
//
// The canonical bytes are built exactly as docs/receipt-spec.md says: the
// example's `signed_fields`, sorted, JSON.stringify with no whitespace, UTF-8.
// It also refuses a receipt whose keys (minus `signature`) differ from
// `signed_fields`, so a field the list does not name cannot ride along unsigned.
// Expiry is NOT checked: every pinned example is past its 60-second TTL, and an
// agent must never act on one. This answers "were these bytes signed by this key".
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node docs/examples/verify-example.mjs <example.json>'); process.exit(2); }
const ex = JSON.parse(readFileSync(file, 'utf8'));
const { receipt, signed_fields: fields, public_key: pubHex, public_key_id: keyId } = ex;

const present = Object.keys(receipt).filter(k => k !== 'signature').sort();
const listed  = [...fields].sort();
if (JSON.stringify(present) !== JSON.stringify(listed)) {
	console.log(`FIELD_SET_MISMATCH receipt=${JSON.stringify(present)} signed_fields=${JSON.stringify(listed)}`);
	process.exit(1);
}
if (receipt.public_key_id !== keyId) { console.log(`KEY_ID_MISMATCH ${receipt.public_key_id} != ${keyId}`); process.exit(1); }

const sorted = {};
for (const k of listed) sorted[k] = receipt[k];
const msg = new TextEncoder().encode(JSON.stringify(sorted));
const hex = h => Uint8Array.from(h.match(/../g).map(b => parseInt(b, 16)));
const key = await crypto.subtle.importKey('raw', hex(pubHex), { name: 'Ed25519' }, false, ['verify']);
const ok  = await crypto.subtle.verify({ name: 'Ed25519' }, key, hex(receipt.signature), msg);
console.log(`${ok ? 'SIGNATURE_VALID' : 'INVALID_SIGNATURE'} ${file} key=${keyId} fields=${listed.length} expiry_not_checked`);
process.exit(ok ? 0 : 1);
