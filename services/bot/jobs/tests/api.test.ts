import { expect, test } from 'bun:test';
import { makeProbe } from '../src/api';
import { handle } from '../src/app';
import { plainPostgresUrl, sqliteDb } from '../src/store';

async function board(probeStatus = 200) {
  let t = Date.parse('2026-11-13T10:00:00Z');
  const probed: string[] = [];
  const ctx = { db: await sqliteDb(':memory:'), now: () => t, probe: async (u: string) => (probed.push(u), probeStatus) };
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const res = await handle(
      new Request(`http://jobs.test${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }),
      ctx,
      'http://jobs.test',
    );
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
  const register = async (name: string) => (await call('POST', '/api/agents', { name })).body.key as string;
  return { call, register, probed, advance: (h: number) => (t += h * 3600e3) };
}

test('any agent registers with one call and gets a key shown once', async () => {
  const b = await board();
  const r = await b.call('POST', '/api/agents', { name: 'Research Bot', homepage: 'https://example.com', about: 'reads things' });
  expect(r.status).toBe(201);
  expect(r.body.key).toMatch(/^fj_[a-z0-9]{32}$/);
  expect(r.body.agent.id).toMatch(/^research-bot-[a-z0-9]{4}$/);
  const me = await b.call('GET', '/api/me', undefined, r.body.key);
  expect(me.body.agent.name).toBe('Research Bot');
  expect(JSON.stringify((await b.call('GET', '/api/agents')).body)).not.toContain('fj_');
  expect((await b.call('POST', '/api/agents', { name: 'x', homepage: 'http://insecure' })).status).toBe(400);
});

test('a free-text job goes open, claimed, submitted, accepted, with an event for each step', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const posted = await b.call('POST', '/api/jobs', { title: 'Translate a page', body: 'To Dutch', doneWhen: 'A link to the Dutch page', priceUsd: 20 }, poster);
  expect(posted.status).toBe(201);
  const id = posted.body.job.id;
  expect(posted.body.job.payment).toBe('not_live');
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, poster)).status).toBe(409); // not your own job
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, worker)).body.job.status).toBe('claimed');
  expect((await b.call('POST', `/api/jobs/${id}/claim`, {}, worker)).status).toBe(200); // a retry is fine
  expect((await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://example.com/nl' }, worker)).body.job.status).toBe('submitted');
  expect((await b.call('POST', `/api/jobs/${id}/accept`, {}, worker)).status).toBe(403); // only the poster decides
  const done = await b.call('POST', `/api/jobs/${id}/accept`, { note: 'thanks' }, poster);
  expect(done.body.job.status).toBe('accepted');
  expect(done.body.events.map((e: { kind: string }) => e.kind)).toEqual(['posted', 'claimed', 'submitted', 'accepted']);
  expect(b.probed).toEqual([]); // free text is checked by the poster, not the board
});

test('a rejection reopens the job and lands on the agent record', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const id = (await b.call('POST', '/api/jobs', { title: 'T', body: 'B', doneWhen: 'D' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${id}/claim`, {}, worker);
  await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://example.com/x' }, worker);
  expect((await b.call('POST', `/api/jobs/${id}/reject`, {}, poster)).status).toBe(400); // a reason is required
  const r = await b.call('POST', `/api/jobs/${id}/reject`, { note: 'wrong language' }, poster);
  expect(r.body.job.status).toBe('open');
  expect(r.body.job.result).toBeNull();
  const workerId = (await b.call('GET', '/api/me', undefined, worker)).body.agent.id;
  expect((await b.call('GET', `/api/agents/${workerId}`)).body.record).toMatchObject({ rejected: 1, accepted: 0, claimed: 1 });
});

test('a claim runs out after 24 hours and the job opens again', async () => {
  const b = await board();
  const poster = await b.register('poster');
  const worker = await b.register('worker');
  const id = (await b.call('POST', '/api/jobs', { title: 'T', body: 'B', doneWhen: 'D' }, poster)).body.job.id;
  await b.call('POST', `/api/jobs/${id}/claim`, {}, worker);
  b.advance(25);
  const d = await b.call('GET', `/api/jobs/${id}`);
  expect(d.body.job.status).toBe('open');
  expect(d.body.events.at(-1).kind).toBe('claim_expired');
});

test('a structured job is checked by the board and auto-accepted only when the link opens', async () => {
  const b = await board(200);
  const poster = await b.register('poster');
  const bot = await b.register('bot');
  const id = (await b.call('POST', '/api/jobs', { title: 'Score my README', kind: 'readme-score', input: { repo: 'https://github.com/flisk-sh/pages' }, autoAccept: true }, poster)).body.job.id;
  expect((await b.call('GET', `/api/jobs/${id}`)).body.job.input).toEqual({ repo: 'flisk-sh/pages' });
  await b.call('POST', `/api/jobs/${id}/claim`, {}, bot);
  expect((await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://evil.example/score' }, bot)).status).toBe(400);
  const r = await b.call('POST', `/api/jobs/${id}/submit`, { resultUrl: 'https://readme.flisk.si/r/flisk-sh/pages' }, bot);
  expect(r.body.job.status).toBe('accepted');
  expect(r.body.events.map((e: { kind: string }) => e.kind)).toEqual(['posted', 'claimed', 'submitted', 'checked', 'accepted']);

  const b2 = await board(404);
  const p2 = await b2.register('poster');
  const w2 = await b2.register('bot');
  const id2 = (await b2.call('POST', '/api/jobs', { title: 'Score', kind: 'readme-score', input: { repo: 'a/b' }, autoAccept: true }, p2)).body.job.id;
  await b2.call('POST', `/api/jobs/${id2}/claim`, {}, w2);
  const r2 = await b2.call('POST', `/api/jobs/${id2}/submit`, { resultUrl: 'https://readme.flisk.si/r/a/b' }, w2);
  expect(r2.body.job.status).toBe('submitted');
  expect(r2.body.events.at(-1).kind).toBe('check_failed');
});

test('the result check follows same-origin redirects only', async () => {
  const hops: Record<string, [number, string?]> = {
    'https://citable.flisk.si/check?url=x': [303, '/pages.flisk.si'],
    'https://citable.flisk.si/pages.flisk.si': [200],
    'https://readme.flisk.si/r/a': [302, 'https://evil.example/a'],
    'https://readme.flisk.si/loop': [302, '/loop'],
  };
  const f = (async (u: string) => {
    const [status, location] = hops[u] ?? [404];
    return new Response(null, { status, headers: location ? { location } : {} });
  }) as typeof fetch;
  const probe = makeProbe(f);
  expect(await probe('https://citable.flisk.si/check?url=x')).toBe(200);
  expect(await probe('https://readme.flisk.si/r/a')).toBe(302); // another host: not followed
  expect(await probe('https://readme.flisk.si/loop')).toBe(310);
});

test("Flisk's Prisma-style ?schema= is taken out of the Postgres URL", () => {
  expect(plainPostgresUrl('postgresql://u:p@db:5432/app?schema=public')).toEqual({ url: 'postgresql://u:p@db:5432/app', schema: 'public' });
  expect(plainPostgresUrl('postgresql://u:p@db:5432/app?sslmode=disable').schema).toBeNull();
  expect(plainPostgresUrl('postgresql://u:p@db/app?schema=x;drop').schema).toBeNull();
});

test('bad input is refused with a reason', async () => {
  const b = await board();
  const k = await b.register('poster');
  expect((await b.call('POST', '/api/jobs', { title: 'x', kind: 'readme-score', input: { repo: 'not a repo' } }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', kind: 'nope', input: {} }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z', priceUsd: -1 }, k)).status).toBe(400);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z' })).status).toBe(401);
  expect((await b.call('POST', '/api/jobs', { title: 'x', body: 'y', doneWhen: 'z' }, 'fj_wrongwrongwrongwrongwrong')).status).toBe(401);
});

test('MCP lists tools and runs the same flow', async () => {
  const b = await board();
  const init = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  expect(init.body.result.serverInfo.name).toBe('flisk-jobs');
  const tools = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  expect(tools.body.result.tools.map((t: { name: string }) => t.name)).toContain('claim_job');
  const reg = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_agent', arguments: { name: 'mcp-agent' } } });
  const key = reg.body.result.structuredContent.key;
  const post = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'post_job', arguments: { key, title: 'T', body: 'B', doneWhen: 'D' } } });
  expect(post.body.result.structuredContent.job.status).toBe('open');
  const bad = await b.call('POST', '/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'claim_job', arguments: { id: 'zzz' } } });
  expect(bad.body.result.isError).toBe(true);
});

test('llms.txt and the board page are served, and stats say payment is not live', async () => {
  const b = await board();
  expect((await b.call('GET', '/llms.txt')).body).toContain('Payment is not live');
  expect((await b.call('GET', '/')).body).toContain('<title>Flisk Jobs');
  expect((await b.call('GET', '/job/abc')).status).toBe(200);
  expect((await b.call('GET', '/api/stats')).body.payment).toBe('not_live');
});
