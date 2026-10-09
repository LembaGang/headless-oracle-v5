// H6 step 3: build a real .ots proof against the live calendars with the same
// module the worker uses (src/ots.ts), so the stock `ots` client can be run on it.
//
//   node scripts/ots-acceptance.ts <64-hex sha256> <out.ots>
//   ots info <out.ots>
//
// Node 22.6+ runs this TypeScript file directly (type stripping).

import { writeFileSync } from 'node:fs';
import { OTS_CALENDARS, submitDigest, proofFromSubmissions, parseDetachedFile, pendingAttestations } from '../src/ots.ts';

const [hex, out] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(hex ?? '') || !out) {
	console.error('usage: node scripts/ots-acceptance.ts <64-hex sha256> <out.ots>');
	process.exit(2);
}
const digest = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const subs = await submitDigest(digest, OTS_CALENDARS, fetch);
for (const s of subs) console.log(`${s.calendar}: ${s.ok ? 'ok' : `FAILED ${s.error}`}`);
const proof = proofFromSubmissions(digest, subs);
if (!proof) {
	console.error('no calendar answered');
	process.exit(1);
}
writeFileSync(out, proof);
const parsed = parseDetachedFile(proof);
console.log(`wrote ${out} (${proof.length} bytes) for ${hex}`);
for (const p of pendingAttestations(parsed.node)) console.log(`pending ${p.uri} commitment ${p.commitment}`);
