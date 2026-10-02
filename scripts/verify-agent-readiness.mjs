#!/usr/bin/env node
// Post-deploy verification for the 2026-10-01 agent-readiness change set
// (handoff CC_HANDOFF_2026-10-01_hov5-agent-readiness_rev2, W1 to W6).
//
// Node 18+, no dependencies. Prints one PASS/FAIL line per check (plus INFO and
// WARN lines that never fail the run) and exits 1 if any check FAILs.
// It makes no payment: it sends no X-Payment or Payment-Signature header and
// never calls a facilitator's /verify or /settle. Check 3 calls CDP's public
// /validate endpoint, which simulates and does not settle.
//
//   node scripts/verify-agent-readiness.mjs
//   HEADLESS_ORACLE_BASE_URL=https://staging.example node scripts/verify-agent-readiness.mjs

const BASE = (process.env.HEADLESS_ORACLE_BASE_URL || 'https://headlessoracle.com').replace(/\/$/, '');
const CDP_VALIDATE = 'https://api.cdp.coinbase.com/platform/v2/x402/validate';
const SCAN_URL = 'https://isitagentready.com/api/scan';
const HOMEPAGE_CANONICAL = '<link rel="canonical" href="https://headlessoracle.com/">';
const TIMEOUT_MS = 30_000;

// --only N[,N...] runs only the named checks, for example --only 10.
const onlyAt = process.argv.indexOf('--only');
const ONLY = onlyAt > -1 ? new Set(String(process.argv[onlyAt + 1] ?? '').split(',').map(Number)) : null;
if (ONLY && (ONLY.size === 0 || [...ONLY].some((n) => !Number.isInteger(n) || n < 1 || n > 10))) {
	console.log('usage: node scripts/verify-agent-readiness.mjs [--only N[,N...]] with N from 1 to 10');
	process.exit(2);
}

let failed = 0;
const pass = (n, msg) => console.log(`PASS ${n} ${msg}`);
const fail = (n, msg) => { failed++; console.log(`FAIL ${n} ${msg}`); };
const info = (n, msg) => console.log(`INFO ${n} ${msg}`);
const warn = (n, msg) => console.log(`WARN ${n} ${msg}`);

const get = (path, init = {}) => fetch(path.startsWith('http') ? path : `${BASE}${path}`, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });

async function check(n, fn) {
	if (ONLY && !ONLY.has(n)) return;
	try { await fn(); } catch (err) { fail(n, `threw: ${err instanceof Error ? err.message : String(err)}`); }
}

async function mcpToolNames() {
	const res = await get('/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	const body = await res.json();
	return body.result.tools.map((t) => t.name);
}

// 1. Liveness.
await check(1, async () => {
	const res = await get('/v5/health');
	res.status === 200 ? pass(1, 'GET /v5/health 200') : fail(1, `GET /v5/health ${res.status}`);
});

// 2. Bazaar extension in the v2 PAYMENT-REQUIRED header, ASCII, header == mirror.
await check(2, async () => {
	const res = await get('/v5/status/x402?mic=XNYS');
	if (res.status !== 402) { fail(2, `GET /v5/status/x402?mic=XNYS ${res.status}, expected 402`); return; }
	const pr = res.headers.get('payment-required') ?? '';
	const prj = res.headers.get('payment-required-json') ?? '';
	let total = 0;
	res.headers.forEach((v, k) => { total += Buffer.byteLength(k, 'latin1') + Buffer.byteLength(v, 'latin1'); });
	info(2, `Payment-Required ${Buffer.byteLength(pr, 'latin1')} B; Payment-Required-Json ${Buffer.byteLength(prj, 'latin1')} B; all response headers ${total} B`);
	if (total > 8192) warn(2, `response headers total ${total} B exceeds 8192 B; an intermediary with an 8 KB header buffer could reject or truncate this 402`);
	const decodedBytes = Buffer.from(pr, 'base64');
	const problems = [];
	let decoded;
	try { decoded = JSON.parse(decodedBytes.toString('utf8')); } catch { problems.push('Payment-Required does not decode to JSON'); }
	if (decoded && decoded?.extensions?.bazaar?.info?.input?.type !== 'http') problems.push('extensions.bazaar.info.input.type is not "http" (extension absent?)');
	if (!decodedBytes.equals(Buffer.from(prj, 'latin1'))) problems.push('base64-decoded Payment-Required differs from Payment-Required-Json');
	if (decodedBytes.some((b) => b >= 0x80)) problems.push('decoded header has a byte >= 0x80');
	problems.length ? fail(2, problems.join('; ')) : pass(2, 'v2 header carries extensions.bazaar, pure ASCII, equals the JSON mirror');
});

// 3. CDP's public validator accepts the listing.
await check(3, async () => {
	const res = await fetch(CDP_VALIDATE, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ resource: `${BASE}/v5/status/x402?mic=XNYS`, method: 'GET' }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const text = await res.text();
	let body;
	try { body = JSON.parse(text); } catch { fail(3, `CDP validate ${res.status}, non-JSON body: ${text.slice(0, 200)}`); return; }
	const failedChecks = Array.isArray(body.preflight) ? body.preflight.filter((p) => p && p.passed === false) : [];
	for (const p of failedChecks) info(3, `preflight failed: ${JSON.stringify(p)}`);
	if (body.rejectionReason) info(3, `rejectionReason: ${body.rejectionReason}`);
	body.valid === true && body?.simulation?.outcome === 'accepted'
		? pass(3, 'CDP validate valid:true, simulation.outcome accepted')
		: fail(3, `CDP validate valid:${body.valid}, simulation.outcome:${body?.simulation?.outcome}`);
});

// 4. ai-catalog.
await check(4, async () => {
	const res = await get('/.well-known/ai-catalog.json');
	const problems = [];
	if (res.status !== 200) { fail(4, `GET /.well-known/ai-catalog.json ${res.status}`); return; }
	if (!(res.headers.get('content-type') ?? '').startsWith('application/json')) problems.push(`content-type ${res.headers.get('content-type')}`);
	if (res.headers.get('access-control-allow-origin') !== '*') problems.push('ACAO is not *');
	const body = await res.json();
	if (!Array.isArray(body.entries) || body.entries.length !== 3) problems.push(`entries ${body.entries?.length}`);
	for (const e of body.entries ?? []) {
		const r = await get(e.url);
		if (r.status !== 200) problems.push(`${e.url} ${r.status}`);
	}
	problems.length ? fail(4, problems.join('; ')) : pass(4, 'ai-catalog 200, application/json, ACAO *, three entries each 200');
});

// 5. auth.md.
await check(5, async () => {
	const res = await get('/auth.md');
	const text = await res.text();
	const problems = [];
	if (res.status !== 200) problems.push(`status ${res.status}`);
	if (!(res.headers.get('content-type') ?? '').startsWith('text/markdown')) problems.push(`content-type ${res.headers.get('content-type')}`);
	if (text.split('\n')[0] !== '# Headless Oracle auth.md') problems.push('first line is not "# Headless Oracle auth.md"');
	if (text.includes('agent_auth')) problems.push('contains agent_auth');
	problems.length ? fail(5, problems.join('; ')) : pass(5, '/auth.md 200 text/markdown with the expected H1, no agent_auth');
});

// 6. Server card: no A2A, tools == tools/list.
await check(6, async () => {
	const card = await (await get('/.well-known/mcp/server-card.json')).json();
	const served = await mcpToolNames();
	const problems = [];
	if ((card.protocols ?? []).includes('A2A')) problems.push('protocols contains A2A');
	const a = [...(card.tools ?? [])].sort().join(','), b = [...served].sort().join(',');
	if (a !== b) problems.push(`card tools [${a}] != tools/list [${b}]`);
	problems.length ? fail(6, problems.join('; ')) : pass(6, `server card: no A2A; tools match tools/list (${served.length})`);
});

// 7. llms surfaces.
await check(7, async () => {
	const problems = [];
	for (const path of ['/llms.txt', '/llms-full.txt']) {
		const text = await (await get(path)).text();
		for (const s of ['August 2026', 'Mythos', 'MTok']) if (text.includes(s)) problems.push(`${path} contains "${s}"`);
	}
	problems.length ? fail(7, problems.join('; ')) : pass(7, '/llms.txt and /llms-full.txt carry no August 2026, Mythos or MTok');
});

// 8. Sitemap: every <loc> is a real page (no homepage soft-404).
await check(8, async () => {
	const xml = await (await get('/sitemap.xml')).text();
	const locs = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1]);
	const problems = [];
	for (const loc of locs) {
		const res = await get(loc);
		const body = await res.text();
		const path = new URL(loc).pathname;
		if (res.status !== 200) problems.push(`${loc} ${res.status}`);
		else if (path !== '/' && body.includes(HOMEPAGE_CANONICAL)) problems.push(`${loc} serves the homepage`);
	}
	problems.length ? fail(8, problems.join('; ')) : pass(8, `sitemap: all ${locs.length} <loc> values 200 and none is the homepage`);
});

// 9. isitagentready scan: ARD asserted, the rest informational until the web deploy.
await check(9, async () => {
	const res = await fetch(SCAN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ url: BASE }),
		signal: AbortSignal.timeout(120_000),
	});
	const scan = await res.json();
	const pick = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), scan);
	for (const p of ['checks.discovery.ard', 'checks.discovery.authMd', 'checks.discovery.a2aAgentCard', 'checks.discoverability.linkHeaders',
		'checks.contentAccessibility.markdownNegotiation', 'checks.discovery.webMcp', 'checks.discoverability.dnsAid']) {
		const c = pick(p);
		info(9, `${p}: status=${c?.status} message=${JSON.stringify(c?.message ?? null)}`);
	}
	pick('checks.discovery.ard')?.status === 'pass' ? pass(9, 'isitagentready ard pass') : fail(9, `isitagentready ard ${pick('checks.discovery.ard')?.status}`);
});

// 10. A2A: no served surface claims A2A support (handoff
// CC_HANDOFF_2026-10-02_hov5-a2a-claims_rev3). Same rule, surface list and
// allowlist as the suite's 'A2A: no served surface claims A2A support'.
const A2A_CLAIM = /\bA2A\b|\ba2aVersion\b|agent-to-agent|\bagent[ -]?card\b/i;
const A2A_ALLOWED = {
	'/docs/integrations/agentictrading-mcp': ['using MCP tool calling, A2A messaging,'],
	'/v5/changelog': [
		'A2A Agent Card at /.well-known/agent.json',
		'A2A label withdrawn because Headless Oracle does not implement A2A: /.well-known/agent.json is now plain JSON metadata without A2A AgentCard fields, and /.well-known/agent-card.json is no longer served.',
	],
};
const A2A_SURFACES = [
	'/llms.txt', '/llms-full.txt', '/AGENTS.md', '/SKILL.md', '/skill.md', '/auth.md', '/openapi.json',
	'/sitemap.xml', '/robots.txt', '/.well-known/agent.json', '/.well-known/mcp/server-card.json',
	'/.well-known/x402.json', '/.well-known/ai-catalog.json', '/.well-known/api-catalog',
	'/.well-known/agent-skills/index.json', '/.well-known/agent-skills/verify-receipt/SKILL.md',
	'/.well-known/agent-skills/read-market-state/SKILL.md', '/.well-known/agent-skills/subscribe-halts/SKILL.md',
	'/.well-known/agent-skills/pay-with-x402/SKILL.md', '/.well-known/agent-skills/mcp-tool-catalog/SKILL.md',
	'/agent-directory.json', '/.well-known/agent-directory.json', '/v5/changelog', '/v5/pricing',
	'/v5/why-not-free', '/v5/pre-trade-stack', '/v1/verification/multi-oracle-guide',
	'/docs/specifications/pre-trade-stack', '/docs/specifications/cpvr-1',
	'/docs/specifications/multi-oracle-consensus-v1', '/docs/integrations/ampersend',
	'/docs/integrations/korea-investment-mcp', '/docs/integrations/agentictrading-mcp',
	'/docs/integrations/openalgo-zerodha', '/docs/integrations/tradingagents-risk',
	'/docs/integrations/composio-listing',
];
const A2A_ONLY_FIELDS = [
	'capabilities', 'defaultInputModes', 'defaultOutputModes', 'authSchemes',
	'schemaVersion', 'humanReadableId', 'agentVersion', 'protocolVersion',
	'supportedInterfaces', 'preferredTransport', 'additionalInterfaces',
	'securitySchemes', 'supportsAuthenticatedExtendedCard',
];
const a2aHit = (path, text) => {
	for (const allowed of A2A_ALLOWED[path] ?? []) {
		if (!text.includes(allowed)) return `${path} lacks its allowlisted text`;
		text = text.split(allowed).join('');
	}
	const m = A2A_CLAIM.exec(text);
	return m ? `${path}: "${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}"` : null;
};
await check(10, async () => {
	const problems = [];
	const card = await get('/.well-known/agent-card.json');
	if (card.status !== 404) problems.push(`/.well-known/agent-card.json ${card.status}, expected 404`);
	if (!process.env.HEADLESS_ORACLE_BASE_URL) {
		const apiCard = await get('https://api.headlessoracle.com/.well-known/agent-card.json');
		if (apiCard.status !== 404) problems.push(`api.headlessoracle.com/.well-known/agent-card.json ${apiCard.status}, expected 404`);
	}
	const aj = await get('/.well-known/agent.json');
	if (aj.status !== 200) problems.push(`/.well-known/agent.json ${aj.status}`);
	else {
		const body = await aj.json();
		for (const k of A2A_ONLY_FIELDS) if (k in body) problems.push(`agent.json has ${k}`);
		for (const s of body.skills ?? []) for (const k of ['inputModes', 'outputModes']) if (k in s) problems.push(`agent.json skill ${s.id} has ${k}`);
	}
	for (const path of A2A_SURFACES) {
		const res = await get(path);
		if (res.status !== 200) { problems.push(`${path} ${res.status}`); continue; }
		const hit = a2aHit(path, await res.text());
		if (hit) problems.push(hit);
	}
	for (const path of ['/skill.md', '/agent-directory.json', '/.well-known/agent-directory.json']) {
		if ((await (await get(path)).text()).includes('agent_card')) problems.push(`${path} has an agent_card key`);
	}
	const mcp = await get('/mcp', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
	});
	const mcpHit = a2aHit('POST /mcp tools/list', await mcp.text());
	if (mcpHit) problems.push(mcpHit);
	const spec = await (await get('/openapi.json')).json();
	if (Object.keys(spec.paths ?? {}).includes('/.well-known/agent-card.json')) problems.push('openapi.json documents /.well-known/agent-card.json');
	problems.length
		? fail(10, problems.join('; '))
		: pass(10, `no A2A claim on ${A2A_SURFACES.length} surfaces or MCP tools/list; agent-card.json 404; agent.json has no A2A-only field`);
});

console.log(failed ? `RESULT ${failed} check(s) failed` : ONLY ? `RESULT all selected checks passed (${[...ONLY].join(',')})` : 'RESULT all checks passed');
process.exit(failed ? 1 : 0);
