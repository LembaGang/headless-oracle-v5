// B-498 (2): served text agrees with the corrected calendars.
//
// B-498 (1) corrected MARKET_CONFIGS (the signed data) from the exchanges' own
// calendars: XDFM trades Monday to Friday and its continuous session ends at
// 14:45; XSES has a 12:00 to 13:00 mid-day break; XJPX closes at 15:30. The
// documentation the worker serves to agents (/llms-full.txt, the MCP tool list,
// /.well-known/agent.json, /v5/compliance) still said otherwise. These tests read
// the served text and compare it with MARKET_CONFIGS, so the two cannot drift
// apart again for these venues without a red test.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { getScheduleStatus, scheduleConfigFor, scheduleMics } from '../src';

async function call(path: string, init?: RequestInit): Promise<Response> {
	const ctx = createExecutionContext();
	const res = await worker.fetch(new Request(`http://example.com${path}`, init) as never, env as never, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}
const hm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const weekendsOf = (mic: string) => scheduleConfigFor(mic)!.weekends ?? ['Sat', 'Sun'];
const lunchOf = (mic: string) => {
	const lb = scheduleConfigFor(mic)!.lunchBreak;
	return lb ? `${hm(lb.startHour, lb.startMinute)}-${hm(lb.endHour, lb.endMinute)}` : null;
};
const dashless = (s: string) => s.replace(/[\u2013\u2014-]/g, '-');

async function scheduleToolDescription(): Promise<string> {
	const res = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
	const body = (await res.json()) as { result: { tools: { name: string; description: string }[] } };
	return body.result.tools.find((t) => t.name === 'get_market_schedule')!.description;
}

describe('B-498 (2): the /llms-full.txt session table agrees with MARKET_CONFIGS', () => {
	for (const mic of ['XDFM', 'XSES', 'XJPX']) {
		it(`${mic}: open, close, lunch break and weekend in the served table row equal the signed data`, async () => {
			const text = await (await call('/llms-full.txt')).text();
			const row = text.split('\n').find((l) => l.startsWith(`| ${mic} |`));
			expect(row, `${mic} row`).toBeDefined();
			const cells = row!.split('|').slice(1, -1).map((c) => c.trim());
			const [, , , open, close, lunch, weekend] = cells;
			const c = scheduleConfigFor(mic)!;
			expect(open).toBe(hm(c.openHour, c.openMinute));
			expect(close).toBe(hm(c.closeHour, c.closeMinute));
			expect(lunch === '\u2014' ? null : dashless(lunch)).toBe(lunchOf(mic));
			expect(weekend.split('/')).toEqual(weekendsOf(mic));
		});
	}

	it('XDFM: the exchange list states the DFM weekend as the signed data has it', async () => {
		const text = await (await call('/llms-full.txt')).text();
		const entry = text.match(/XDFM \(Dubai, [^)]*\)/)![0];
		expect(entry).toBe(`XDFM (Dubai, Asia/Dubai, ${weekendsOf('XDFM').join('/')} weekends)`);
	});

	it('the /SKILL.md lunch-break row names every venue that has a lunch break', async () => {
		const withLunch = scheduleMics().filter((m) => scheduleConfigFor(m)!.lunchBreak);
		expect(withLunch).toContain('XSES');
		const text = await (await call('/SKILL.md')).text();
		const row = text.split('\n').find((l) => l.includes('Lunch break windows ('))!;
		for (const m of withLunch) expect(row, m).toContain(m);
	});
});

describe('B-498 (2): the MCP get_market_schedule description agrees with MARKET_CONFIGS', () => {
	for (const mic of ['XSES', 'XJPX']) {
		it(`${mic}: the lunch-break window it gives equals the signed data${mic === 'XJPX' ? ' (unchanged; right at B-498 (1) too)' : ''}`, async () => {
			const d = dashless(await scheduleToolDescription());
			const at = d.indexOf(mic);
			expect(at, `${mic} named`).toBeGreaterThan(-1);
			const window = d.slice(at).match(/\((\d\d:\d\d-\d\d:\d\d)/)![1];
			expect(window).toBe(lunchOf(mic));
		});
	}

	it('XDFM: it gives the Monday to Friday week and the 14:45 close, and does not put XDFM on a Friday weekend', async () => {
		const d = await scheduleToolDescription();
		expect(weekendsOf('XDFM')).toEqual(['Sat', 'Sun']);
		const c = scheduleConfigFor('XDFM')!;
		expect(d).toContain(`Dubai Financial Market (XDFM) trades Monday to Friday, ${hm(c.openHour, c.openMinute)} to ${hm(c.closeHour, c.closeMinute)} GST`);
		expect(d).not.toMatch(/XDFM\)[^.;]*Fri[\u2013\u2014-]Sat/);
	});
});

describe('B-498 (2): agent card and compliance self-report', () => {
	it('/.well-known/agent.json get_market_schedule names every venue with a lunch break', async () => {
		const card = (await (await call('/.well-known/agent.json')).json()) as { skills: { id: string; description: string }[] };
		const d = card.skills.find((s) => s.id === 'get_market_schedule')!.description;
		for (const m of scheduleMics().filter((x) => scheduleConfigFor(x)!.lunchBreak)) expect(d, m).toContain(m);
	});

	it('/v5/compliance no longer claims 2027 holiday calendars for all 28 exchanges, and its count of 2027 calendars is the data\'s', async () => {
		const body = (await (await call('/v5/compliance')).json()) as { checks: { check: string; evidence: string }[] };
		const ev = body.checks.find((c) => c.check === 'APTS-003')!.evidence;
		expect(ev).not.toMatch(/2026[\u2013\u2014-]2027 for all 28/);
		const with2027 = scheduleMics().filter((m) => scheduleConfigFor(m)!.holidays['2027']).length;
		expect(ev).toContain(`for 2027 at ${with2027} of them`);
		for (const m of scheduleMics().filter((x) => scheduleConfigFor(x)!.lunchBreak)) expect(ev, m).toContain(m);
	});
});

describe('B-498 (2): the XCBO timezone in /llms-full.txt agrees with MARKET_CONFIGS', () => {
	it('XCBO: the session-table row and the exchange-list entry give the timezone the code signs on', async () => {
		const tz = scheduleConfigFor('XCBO')!.timezone;
		const text = await (await call('/llms-full.txt')).text();
		const row = text.split('\n').find((l) => l.startsWith('| XCBO |'))!;
		expect(row.split('|').map((c) => c.trim())[3]).toBe(tz);
		const entry = text.match(/XCBO \(Cboe Options, ([^,]+),/)![1];
		expect(entry).toBe(tz);
	});
});

describe('B-498 (2): the compliance sentence on 2027 calendars matches the data and the engine', () => {
	const without2027 = () => scheduleMics().filter((m) => !scheduleConfigFor(m)!.holidays['2027']);
	it('names exactly the venues that have no 2027 list in MARKET_CONFIGS', async () => {
		const body = (await (await call('/v5/compliance')).json()) as { checks: { check: string; evidence: string }[] };
		const ev = body.checks.find((c) => c.check === 'APTS-003')!.evidence;
		const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
		const m = ev.match(/for the other (\w+) \(([A-Z, ]+)\) no official 2027 calendar had been found by 21 November 2026/);
		expect(m, 'the sentence names the venues').not.toBeNull();
		const named = m![2].split(',').map((x) => x.trim()).sort();
		expect(named).toEqual(without2027().sort());
		expect(m![1]).toBe(words[without2027().length]);
	});
	it('XDFM, one of them: UNKNOWN on a 2027 weekday in session and at 23:00, CLOSED on its own weekend, as the sentence says', () => {
		expect(without2027()).toContain('XDFM');
		expect(getScheduleStatus('XDFM', new Date('2027-01-11T07:00:00Z')).status).toBe('UNKNOWN'); // Mon 11:00 GST
		expect(getScheduleStatus('XDFM', new Date('2027-01-11T19:00:00Z')).status).toBe('UNKNOWN'); // Mon 23:00 GST
		expect(getScheduleStatus('XDFM', new Date('2027-01-10T07:00:00Z')).status).toBe('CLOSED');  // Sun 11:00 GST
	});
});
