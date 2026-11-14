import { expect, test } from 'bun:test';
import { handle } from '../../jobs/src/app';
import { sqliteDb } from '../../jobs/src/store';
import { advance, jobsClient, tick, type Checkpoint } from '../src/jobs';
import { parseAsk, type Kind } from '../src/work';

// The real jobs board, in memory, reached through a fake fetch: the bot's HTTP calls run the board's own code.
async function world() {
  const ctx = { db: await sqliteDb(':memory:'), now: () => Date.now(), probe: async () => 200 };
  const f = (async (url: string, init?: RequestInit) => handle(new Request(url, init), ctx, 'http://jobs.test')) as typeof fetch;
  const call = async (method: string, path: string, body?: unknown, key?: string) =>
    (await f(`http://jobs.test${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const files = new Map<string, Checkpoint>();
  const store = {
    load: (id: string) => structuredClone(files.get(id)) ?? { sessionId: id, messages: [] },
    save: (c: Checkpoint) => void files.set(c.sessionId, structuredClone(c)),
    list: () => [...files.keys()].map((sessionId) => ({ sessionId })),
  };
  let key: string | null = null;
  const bot = jobsClient('http://jobs.test', 'Flisk Bot', () => key, (k) => (key = k), f);
  const queue = async (_id: string, op: () => Promise<void>) => op();
  let calls = 0;
  const work = async (kind: Kind, input: Record<string, string>) => {
    calls++;
    return { url: kind === 'readme-score' ? `https://readme.flisk.si/r/${input.repo}` : `https://citable.flisk.si/check?url=${encodeURIComponent(input.url)}`, score: 80, grade: 'B', summary: 'scored 80', fixes: ['Add an overview'] };
  };
  return { call, store, files, bot, queue, work, calls: () => calls };
}

test('the bot finds a job, claims it, does it, submits it and records each step in one session', async () => {
  const w = await world();
  const poster = (await w.call('POST', '/api/agents', { name: 'poster' })).key;
  const id = (await w.call('POST', '/api/jobs', { title: 'Score flisk-sh/pages', kind: 'readme-score', input: { repo: 'flisk-sh/pages' }, autoAccept: true }, poster)).job.id;
  await tick(w.bot, w.store, w.queue, w.work);
  const c = w.files.get(`job-${id}`)!;
  expect(c.job?.step).toBe('accepted');
  expect(c.messages.map((m) => m.event)).toEqual(['found', 'claimed', 'working', 'worked', 'submitted', 'accepted']);
  const board = await w.call('GET', `/api/jobs/${id}`);
  expect(board.job.status).toBe('accepted');
  expect(board.events.map((e: { kind: string }) => e.kind)).toEqual(['posted', 'claimed', 'submitted', 'checked', 'accepted']);
});

test('a failure after the claim resumes the same job on the next pass, without a second claim', async () => {
  const w = await world();
  const poster = (await w.call('POST', '/api/agents', { name: 'poster' })).key;
  const id = (await w.call('POST', '/api/jobs', { title: 'Check a page', kind: 'ai-findable', input: { url: 'https://pages.flisk.si' } }, poster)).job.id;
  // First life: the work call dies (the process is killed mid-job). Nothing after the claim is saved.
  const dying = async () => {
    throw Object.assign(new Error('killed'), { status: 0 });
  };
  await tick(w.bot, w.store, w.queue, dying as never).catch(() => {});
  expect(w.files.get(`job-${id}`)?.job?.step).toBe('claimed');
  // Second life: a fresh tick resumes from the checkpoint.
  await tick(w.bot, w.store, w.queue, w.work);
  const c = w.files.get(`job-${id}`)!;
  expect(c.job?.step).toBe('submitted'); // not auto-accept: waits for the poster
  const board = await w.call('GET', `/api/jobs/${id}`);
  expect(board.events.filter((e: { kind: string }) => e.kind === 'claimed')).toHaveLength(1);
  // The poster accepts; the next pass records it.
  await w.call('POST', `/api/jobs/${id}/accept`, { note: 'good' }, poster);
  await tick(w.bot, w.store, w.queue, w.work);
  expect(w.files.get(`job-${id}`)?.job?.step).toBe('accepted');
});

test('a rejection is recorded and the bot does not take the same job again', async () => {
  const w = await world();
  const poster = (await w.call('POST', '/api/agents', { name: 'poster' })).key;
  const id = (await w.call('POST', '/api/jobs', { title: 'Score', kind: 'readme-score', input: { repo: 'a/b' } }, poster)).job.id;
  await tick(w.bot, w.store, w.queue, w.work);
  await w.call('POST', `/api/jobs/${id}/reject`, { note: 'wrong repo' }, poster);
  await tick(w.bot, w.store, w.queue, w.work);
  expect(w.files.get(`job-${id}`)?.job?.step).toBe('rejected');
  expect(w.files.get(`job-${id}`)?.messages.at(-1)?.content).toContain('wrong repo');
  const calls = w.calls();
  await tick(w.bot, w.store, w.queue, w.work);
  expect(w.calls()).toBe(calls);
  expect((await w.call('GET', `/api/jobs/${id}`)).job.status).toBe('open'); // free for another agent
});

test('three failed tries release the claim so another agent can take the job', async () => {
  const w = await world();
  const poster = (await w.call('POST', '/api/agents', { name: 'poster' })).key;
  const id = (await w.call('POST', '/api/jobs', { title: 'Score', kind: 'readme-score', input: { repo: 'a/b' } }, poster)).job.id;
  const broken = async () => {
    throw new Error('README Score is down');
  };
  for (let i = 0; i < 4; i++) await tick(w.bot, w.store, w.queue, broken as never);
  expect(w.files.get(`job-${id}`)?.job?.step).toBe('failed');
  const board = await w.call('GET', `/api/jobs/${id}`);
  expect(board.job.status).toBe('open');
  expect(board.events.at(-1).kind).toBe('released');
});

test('the bot never takes free-text jobs or its own', async () => {
  const w = await world();
  const poster = (await w.call('POST', '/api/agents', { name: 'poster' })).key;
  await w.call('POST', '/api/jobs', { title: 'Write a poem', body: 'About Flisk', doneWhen: 'A link to the poem' }, poster);
  await tick(w.bot, w.store, w.queue, w.work);
  expect(w.files.size).toBe(0);
  const mine = await w.bot.call('POST', '/api/jobs', { title: 'Mine', kind: 'readme-score', input: { repo: 'a/b' } });
  await tick(w.bot, w.store, w.queue, w.work);
  expect(w.files.has(`job-${mine.job.id}`)).toBe(false);
});

test('advance does nothing on a finished job', async () => {
  const w = await world();
  const c: Checkpoint = { sessionId: 'job-x', messages: [], job: { id: 'x', title: 't', kind: 'readme-score', input: { repo: 'a/b' }, step: 'accepted', tries: 0, boardUrl: '' } };
  expect(await advance(c, w.bot, w.store, w.work)).toBe(false);
});

test('chat input is read as a repo or a page', () => {
  expect(parseAsk('flisk-sh/pages')).toEqual({ kind: 'readme-score', input: { repo: 'flisk-sh/pages' } });
  expect(parseAsk('score https://github.com/flisk-sh/flisk.git please')).toEqual({ kind: 'readme-score', input: { repo: 'flisk-sh/flisk' } });
  expect(parseAsk('can AI find https://pages.flisk.si/docs?')).toEqual({ kind: 'ai-findable', input: { url: 'https://pages.flisk.si/docs?' } });
  expect(parseAsk('hello')).toBeNull();
});

// The Flisk agent contract on the real server: idle sweep, DELETE /session, the fields of GET /sessions.
test('the server sweeps idle chats but keeps job sessions, and DELETE /session removes one', async () => {
  const { mkdtempSync, writeFileSync, utimesSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bot-sweep-'));
  const put = (id: string, ageMs: number) => {
    const f = join(dir, id + '.json');
    writeFileSync(f, JSON.stringify({ sessionId: id, messages: [] }));
    const t = new Date(Date.now() - ageMs);
    utimesSync(f, t, t);
  };
  put('chat-old', 3_600_000);
  put('chat-new', 0);
  put('job-old', 3_600_000);
  const port = 38000 + Math.floor(Math.random() * 1000);
  const p = Bun.spawn(['bun', 'src/index.ts'], { cwd: join(import.meta.dir, '..'), env: { ...process.env, PORT: String(port), AGENT_STATE_DIR: dir, SESSION_IDLE_TIMEOUT_MS: '60000', SESSION_CLEANUP_INTERVAL_MS: '200', JOBS_URL: '' }, stdout: 'ignore', stderr: 'ignore' });
  try {
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await Bun.sleep(100); }
    await Bun.sleep(700);
    const list = await (await fetch(base + '/sessions')).json();
    expect(list.sessions.map((s: any) => s.sessionId).sort()).toEqual(['chat-new', 'job-old']);
    expect(list.total).toBe(2);
    expect(list.sessions[0].status).toBe('idle');
    expect(typeof list.sessions[0].checkpointBytes).toBe('number');
    expect((await fetch(base + '/session', { method: 'DELETE' })).status).toBe(400);
    expect(await (await fetch(base + '/session', { method: 'DELETE', headers: { 'x-session-id': 'chat-new' } })).json()).toEqual({ deleted: 'chat-new' });
    expect(existsSync(join(dir, 'chat-new.json'))).toBe(false);
  } finally {
    p.kill();
  }
});
