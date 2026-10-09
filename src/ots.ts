// OpenTimestamps: just enough of the format to build a detached .ots proof for
// one 32-byte SHA-256 digest from public calendar responses, and to upgrade it.
//
// Byte format as the reference implementation (python-opentimestamps,
// opentimestamps/core/{serialize,op,notary,timestamp}.py) reads it. The proof
// this module writes is accepted only if the stock `ots` client accepts it; the
// H6 acceptance run (scripts/ots-acceptance.ts) checks that against live
// calendars. No Worker-specific imports, so Node can run this file directly.

import { sha256 } from '@noble/hashes/sha2.js';
import { sha1, ripemd160 } from '@noble/hashes/legacy.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const OTS_CALENDARS = [
	'https://alice.btc.calendar.opentimestamps.org',
	'https://bob.btc.calendar.opentimestamps.org',
	'https://finney.calendar.eternitywall.com',
];

const HEADER_MAGIC = new Uint8Array([
	0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00,
	0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
const MAJOR_VERSION = 1;
const OP_SHA256 = 0x08;
const BINARY_OPS = new Set([0xf0, 0xf1]); // append, prepend
const UNARY_OPS = new Set([0x02, 0x03, 0x08, 0x67, 0xf2, 0xf3]);
const TAG_PENDING = '83dfe30d2ef90c8e';
const TAG_BITCOIN = '0588960d73d71901';
const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;
const MAX_DEPTH = 256;

export interface OtsAttestation { tag: Uint8Array; payload: Uint8Array }
export interface OtsOp { tag: number; arg?: Uint8Array }
export interface OtsNode { msg: Uint8Array; attestations: OtsAttestation[]; ops: { op: OtsOp; child: OtsNode }[] }

export function toHexBytes(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) { out.set(p, at); at += p.length; }
	return out;
}
function cmpBytes(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
	return cmpBytes(a, b) === 0;
}

function varuint(n: number): Uint8Array {
	const out: number[] = [];
	do {
		let b = n & 0x7f;
		n = Math.floor(n / 128);
		if (n > 0) b |= 0x80;
		out.push(b);
	} while (n > 0);
	return new Uint8Array(out);
}
function varbytes(b: Uint8Array): Uint8Array {
	return concat(varuint(b.length), b);
}

class Reader {
	at = 0;
	readonly b: Uint8Array;
	constructor(b: Uint8Array) { this.b = b; }
	bytes(n: number): Uint8Array {
		if (this.at + n > this.b.length) throw new Error('ots: truncated');
		const out = this.b.slice(this.at, this.at + n);
		this.at += n;
		return out;
	}
	byte(): number { return this.bytes(1)[0]; }
	varuint(): number {
		let n = 0;
		let shift = 1;
		for (;;) {
			const b = this.byte();
			n += (b & 0x7f) * shift;
			if (!(b & 0x80)) return n;
			shift *= 128;
			if (shift > 2 ** 49) throw new Error('ots: varuint too long');
		}
	}
	varbytes(max: number, min = 0): Uint8Array {
		const n = this.varuint();
		if (n > max || n < min) throw new Error('ots: varbytes length out of range');
		return this.bytes(n);
	}
	eof(): boolean { return this.at === this.b.length; }
}

export function applyOp(op: OtsOp, msg: Uint8Array): Uint8Array {
	let out: Uint8Array;
	switch (op.tag) {
		case 0xf0: out = concat(msg, op.arg!); break;
		case 0xf1: out = concat(op.arg!, msg); break;
		case 0xf2: out = msg.slice().reverse(); break;
		case 0xf3: out = new TextEncoder().encode(toHexBytes(msg)); break;
		case 0x02: out = sha1(msg); break;
		case 0x03: out = ripemd160(msg); break;
		case 0x08: out = sha256(msg); break;
		case 0x67: out = keccak_256(msg); break;
		default: throw new Error(`ots: unknown op 0x${op.tag.toString(16)}`);
	}
	if (out.length > MAX_MSG) throw new Error('ots: op result too long');
	return out;
}

function readOp(r: Reader, tag: number): OtsOp {
	if (BINARY_OPS.has(tag)) return { tag, arg: r.varbytes(MAX_MSG, 1) };
	if (UNARY_OPS.has(tag)) return { tag };
	throw new Error(`ots: unknown op tag 0x${tag.toString(16)}`);
}

function readNode(r: Reader, msg: Uint8Array, depth: number): OtsNode {
	if (depth > MAX_DEPTH) throw new Error('ots: recursion limit');
	const node: OtsNode = { msg, attestations: [], ops: [] };
	const item = (tag: number) => {
		if (tag === 0x00) {
			node.attestations.push({ tag: r.bytes(8), payload: r.varbytes(MAX_PAYLOAD) });
		} else {
			const op = readOp(r, tag);
			const child = readNode(r, applyOp(op, msg), depth + 1);
			node.ops.push({ op, child });
		}
	};
	let tag = r.byte();
	while (tag === 0xff) {
		item(r.byte());
		tag = r.byte();
	}
	item(tag);
	return node;
}

// A serialized Timestamp (what a calendar returns) for the message `msg`.
export function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): OtsNode {
	const r = new Reader(bytes);
	const node = readNode(r, msg, 0);
	if (!r.eof()) throw new Error('ots: trailing bytes');
	return node;
}

function opBytes(op: OtsOp): Uint8Array {
	return op.arg ? concat(new Uint8Array([op.tag]), varbytes(op.arg)) : new Uint8Array([op.tag]);
}
function attBytes(a: OtsAttestation): Uint8Array {
	return concat(a.tag, varbytes(a.payload));
}

// python-opentimestamps orders ops by (tag, argument bytes) and attestations
// by (tag, then the URI for pending or the height for Bitcoin): the length
// prefix is not part of either key.
function cmpOps(a: OtsOp, b: OtsOp): number {
	return a.tag !== b.tag ? a.tag - b.tag : cmpBytes(a.arg ?? new Uint8Array(0), b.arg ?? new Uint8Array(0));
}
function cmpAtts(a: OtsAttestation, b: OtsAttestation): number {
	const byTag = cmpBytes(a.tag, b.tag);
	if (byTag !== 0) return byTag;
	const t = toHexBytes(a.tag);
	if (t === TAG_PENDING) return cmpBytes(new Reader(a.payload).varbytes(1000), new Reader(b.payload).varbytes(1000));
	if (t === TAG_BITCOIN) return new Reader(a.payload).varuint() - new Reader(b.payload).varuint();
	return cmpBytes(a.payload, b.payload);
}

// The reference client's ordering: attestations, then ops, each sorted; every
// item but the last carries a 0xff prefix; an attestation item is 0x00 + body.
export function serializeTimestamp(node: OtsNode): Uint8Array {
	const atts = [...node.attestations].sort(cmpAtts);
	const ops = [...node.ops].sort((a, b) => cmpOps(a.op, b.op));
	const items: Uint8Array[] = [
		...atts.map((a) => concat(new Uint8Array([0x00]), attBytes(a))),
		...ops.map(({ op, child }) => concat(opBytes(op), serializeTimestamp(child))),
	];
	if (items.length === 0) throw new Error('ots: empty timestamp');
	return concat(...items.map((it, i) => (i < items.length - 1 ? concat(new Uint8Array([0xff]), it) : it)));
}

// Union of two timestamps for the same message. A shared op is merged
// recursively; an attestation already present is not repeated.
export function mergeInto(into: OtsNode, from: OtsNode): void {
	if (!eqBytes(into.msg, from.msg)) throw new Error('ots: merge of different messages');
	for (const a of from.attestations) {
		if (!into.attestations.some((b) => eqBytes(attBytes(a), attBytes(b)))) into.attestations.push(a);
	}
	for (const { op, child } of from.ops) {
		const same = into.ops.find((o) => eqBytes(opBytes(o.op), opBytes(op)));
		if (same) mergeInto(same.child, child);
		else into.ops.push({ op, child });
	}
}

export function detachedFile(digest: Uint8Array, node: OtsNode): Uint8Array {
	if (digest.length !== 32 || !eqBytes(node.msg, digest)) throw new Error('ots: digest mismatch');
	return concat(HEADER_MAGIC, varuint(MAJOR_VERSION), new Uint8Array([OP_SHA256]), digest, serializeTimestamp(node));
}

export function parseDetachedFile(bytes: Uint8Array): { digest: Uint8Array; node: OtsNode } {
	const r = new Reader(bytes);
	if (!eqBytes(r.bytes(HEADER_MAGIC.length), HEADER_MAGIC)) throw new Error('ots: bad magic');
	if (r.varuint() !== MAJOR_VERSION) throw new Error('ots: unsupported major version');
	if (r.byte() !== OP_SHA256) throw new Error('ots: file hash op is not sha256');
	const digest = r.bytes(32);
	const node = readNode(r, digest, 0);
	if (!r.eof()) throw new Error('ots: trailing bytes');
	return { digest, node };
}

export interface OtsPending { uri: string; commitment: string }

// Every pending attestation in the tree, with the message it commits to.
export function pendingAttestations(node: OtsNode): OtsPending[] {
	const out: OtsPending[] = [];
	const walk = (n: OtsNode) => {
		for (const a of n.attestations) {
			if (toHexBytes(a.tag) !== TAG_PENDING) continue;
			const uri = new TextDecoder().decode(new Reader(a.payload).varbytes(1000));
			out.push({ uri, commitment: toHexBytes(n.msg) });
		}
		for (const { child } of n.ops) walk(child);
	};
	walk(node);
	return out;
}

export function bitcoinHeights(node: OtsNode): number[] {
	const out: number[] = [];
	const walk = (n: OtsNode) => {
		for (const a of n.attestations) if (toHexBytes(a.tag) === TAG_BITCOIN) out.push(new Reader(a.payload).varuint());
		for (const { child } of n.ops) walk(child);
	};
	walk(node);
	return out;
}

function findNode(node: OtsNode, msgHex: string): OtsNode | null {
	if (toHexBytes(node.msg) === msgHex) return node;
	for (const { child } of node.ops) {
		const hit = findNode(child, msgHex);
		if (hit) return hit;
	}
	return null;
}

// Grafts a calendar's answer for `commitment` into the tree. The pending
// attestation stays, as the reference client's merge leaves it.
export function applyUpgrade(node: OtsNode, commitmentHex: string, upgrade: OtsNode): void {
	const at = findNode(node, commitmentHex);
	if (!at) throw new Error('ots: commitment not in proof');
	mergeInto(at, upgrade);
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const OTS_HEADERS = { Accept: 'application/vnd.opentimestamps.v1', 'User-Agent': 'headless-oracle-record/1' };
const MAX_CALENDAR_RESPONSE = 10_000;

async function readCapped(res: Response): Promise<Uint8Array> {
	const b = new Uint8Array(await res.arrayBuffer());
	if (b.length > MAX_CALENDAR_RESPONSE) throw new Error('response over 10000 bytes');
	return b;
}

export interface OtsSubmission { calendar: string; ok: boolean; error?: string; timestamp?: OtsNode }

// POST <calendar>/digest with exactly the 32 digest bytes as the body.
export async function submitDigest(digest: Uint8Array, calendars: string[], fetchFn: Fetch): Promise<OtsSubmission[]> {
	if (digest.length !== 32) throw new Error('ots: digest must be 32 bytes');
	return Promise.all(calendars.map(async (calendar): Promise<OtsSubmission> => {
		try {
			const res = await fetchFn(`${calendar}/digest`, {
				method: 'POST',
				headers: { ...OTS_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
				body: digest,
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status !== 200) return { calendar, ok: false, error: `HTTP ${res.status}` };
			return { calendar, ok: true, timestamp: parseTimestamp(await readCapped(res), digest) };
		} catch (err: unknown) {
			return { calendar, ok: false, error: err instanceof Error ? err.message : 'unknown error' };
		}
	}));
}

// The proof for `digest` from the calendars that answered. Null when none did.
export function proofFromSubmissions(digest: Uint8Array, subs: OtsSubmission[]): Uint8Array | null {
	const ok = subs.filter((s) => s.ok && s.timestamp);
	if (ok.length === 0) return null;
	const root: OtsNode = { msg: digest, attestations: [], ops: [] };
	for (const s of ok) mergeInto(root, s.timestamp!);
	return detachedFile(digest, root);
}

export type OtsUpgradeResult = { uri: string; outcome: 'upgraded' | 'pending' | 'error'; detail?: string };

// GET <calendar>/timestamp/<commitment> for each pending attestation, at most
// `maxRequests` of them. A 404 means the calendar has not committed yet. Only
// an answer that reaches a Bitcoin attestation is grafted in.
export async function upgradeProof(proof: Uint8Array, maxRequests: number, fetchFn: Fetch): Promise<{ proof: Uint8Array; results: OtsUpgradeResult[]; requests: number; complete: boolean }> {
	const { digest, node } = parseDetachedFile(proof);
	const results: OtsUpgradeResult[] = [];
	let requests = 0;
	for (const p of pendingAttestations(node)) {
		if (bitcoinHeights(node).length > 0) break;
		if (requests >= maxRequests) break;
		requests++;
		try {
			const res = await fetchFn(`${p.uri}/timestamp/${p.commitment}`, { headers: OTS_HEADERS, signal: AbortSignal.timeout(10_000) });
			if (res.status === 404) { results.push({ uri: p.uri, outcome: 'pending' }); continue; }
			if (res.status !== 200) { results.push({ uri: p.uri, outcome: 'error', detail: `HTTP ${res.status}` }); continue; }
			const commitment = new Uint8Array(p.commitment.match(/../g)!.map((h) => parseInt(h, 16)));
			const answer = parseTimestamp(await readCapped(res), commitment);
			if (bitcoinHeights(answer).length === 0) { results.push({ uri: p.uri, outcome: 'pending' }); continue; }
			applyUpgrade(node, p.commitment, answer);
			results.push({ uri: p.uri, outcome: 'upgraded' });
		} catch (err: unknown) {
			results.push({ uri: p.uri, outcome: 'error', detail: err instanceof Error ? err.message : 'unknown error' });
		}
	}
	return { proof: detachedFile(digest, node), results, requests, complete: bitcoinHeights(node).length > 0 };
}
