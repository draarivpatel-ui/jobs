import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../../jobs/src/app';
import { sqliteDb } from '../../jobs/src/store-bun';
import { createBot, type BrainConfig } from '../src/app';
import { parseAction, type ChatMsg, type Computer, type FleetAnswer } from '../src/brain';
import { fileStore } from '../src/file-store';

// A model that replies with the next line of a script, and a computer that records what was done on it.
function fakes(script: string[]) {
  const asked: ChatMsg[][] = [];
  const model = async (messages: ChatMsg[]) => {
    asked.push(structuredClone(messages));
    const text = script.shift();
    return text === undefined ? { error: 'script ended' } : { text };
  };
  const log: string[] = [];
  const ok = (data: unknown = {}): FleetAnswer => ({ status: 200, data, error: null });
  const computer: Computer = {
    start: async () => (log.push('start'), ok({ id: 'pod_1', provider: 'fake' })),
    run: async (_id, command) => (log.push(`run ${command}`), ok({ exitCode: 0, stdout: '4\n', stderr: '' })),
    write: async (_id, path) => (log.push(`write ${path}`), ok()),
    read: async (_id, path) => (log.push(`read ${path}`), ok({ content: 'hello', encoding: 'utf8' })),
    stop: async (id) => (log.push(`stop ${id}`), ok()),
  };
  return { model, computer, log, asked };
}

function bot(brain: BrainConfig | undefined, extra: Partial<Parameters<typeof createBot>[0]> = {}, f?: typeof fetch) {
  const store = fileStore(mkdtempSync(join(tmpdir(), 'bot-brain-')));
  const b = createBot({ name: 'Flisk Bot', boardUrl: '', jobsUrl: '', brain, ...extra }, store, f);
  const turn = async (id: string, input: string, ip = '1.1.1.1') =>
    (await b.handle(new Request('http://bot.test/turn', { method: 'POST', headers: { 'x-session-id': id, 'cf-connecting-ip': ip }, body: JSON.stringify({ input }) }))).json();
  return { b, store, turn };
}

test('the model reply is read as one action', () => {
  expect(parseAction('{"say": "hi"}')).toEqual({ type: 'say', text: 'hi' });
  expect(parseAction('```json\n{"run": "ls"}\n```')).toEqual({ type: 'run', command: 'ls' });
  expect(parseAction('{"write": {"path": "/tmp/a", "content": "x"}}')).toEqual({ type: 'write', path: '/tmp/a', content: 'x' });
  expect(parseAction('{"read": "/tmp/a"}')).toEqual({ type: 'read', path: '/tmp/a' });
  expect(parseAction('{"cannot": "no access"}')).toEqual({ type: 'cannot', why: 'no access' });
  expect(parseAction('Just a plain answer.')).toEqual({ type: 'say', text: 'Just a plain answer.' });
  expect(parseAction('{"run": "ls')).toEqual({ type: 'say', text: '{"run": "ls' }); // no closing brace: nothing to run
  expect(parseAction('{"run": ls}')).toEqual({ type: 'bad' });
});

test('without a model the bot answers as before and says it has no model', async () => {
  const { turn } = bot(undefined);
  expect((await turn('chat-a', 'what is 2+2?')).reply).toContain('no model');
});

test('with a model, a question gets the model answer and the session remembers the conversation', async () => {
  const x = fakes(['{"say": "Four."}', '{"say": "Eight."}']);
  const { turn, store } = bot({ model: x.model, computer: x.computer });
  expect((await turn('chat-a', 'what is 2+2?')).reply).toBe('Four.');
  expect((await turn('chat-a', 'and doubled?')).reply).toBe('Eight.');
  expect(x.log).toEqual([]); // a plain question starts no computer
  expect(x.asked[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  expect((await store.load('chat-a')).modelCalls).toBe(2);
});

test('a task runs on a computer, every step is saved in the session, and the computer is deleted', async () => {
  const x = fakes(['{"run": "echo $((2+2))"}', '{"say": "It printed 4."}']);
  const { turn, store } = bot({ model: x.model, computer: x.computer });
  expect((await turn('chat-a', 'run a command that adds 2 and 2 and tell me what it printed')).reply).toBe('It printed 4.');
  expect(x.log).toEqual(['start', 'run echo $((2+2))', 'stop pod_1']);
  const c = await store.load('chat-a');
  expect(c.pod).toBeUndefined();
  expect(c.messages.map((m) => m.event ?? m.role)).toEqual(['user', 'run', 'agent']);
  expect(c.messages[1].content).toContain('$ echo $((2+2))');
  expect(x.asked[1].at(-1)?.content).toContain('Exit code 0'); // the model saw the real output
});

test('a computer left by a cut-off task is deleted on the next pass', async () => {
  const x = fakes([]);
  const { b, store } = bot({ model: x.model, computer: x.computer });
  await store.save({ sessionId: 'chat-cut', messages: [], pod: 'pod_9' });
  await b.pass();
  expect(x.log).toEqual(['stop pod_9']);
  expect((await store.load('chat-cut')).pod).toBeUndefined();
});

test('daily caps: a visitor, the model and the computers each stop at their limit', async () => {
  const a = fakes(['{"say": "one"}', '{"say": "two"}', '{"say": "other visitor"}']);
  const v = bot({ model: a.model, visitorMessagesPerDay: 2 });
  await v.turn('chat-a', 'first question for the model');
  await v.turn('chat-a', 'second question for the model');
  expect((await v.turn('chat-a', 'third question for the model')).reply).toContain('used up');
  expect((await v.turn('chat-b', 'a question from someone else', '2.2.2.2')).reply).toBe('other visitor');
  expect(await v.store.readUsage()).not.toContain('1.1.1.1'); // only a hash of the address is kept

  const m = fakes(['{"say": "one"}']);
  const capped = bot({ model: m.model, modelCallsPerDay: 1 });
  await capped.turn('chat-a', 'first question for the model');
  expect((await capped.turn('chat-b', 'a question from someone else', '2.2.2.2')).reply).toContain('used up');
  expect(m.asked.length).toBe(1);

  const c = fakes(['{"run": "true"}', '{"say": "done"}', '{"run": "true"}', '{"say": "No computer was available."}']);
  const pods = bot({ model: c.model, computer: c.computer, computerTasksPerDay: 1 });
  await pods.turn('chat-a', 'run the true command on a computer');
  expect((await pods.turn('chat-a', 'run the true command once more')).reply).toBe('No computer was available.');
  expect(c.log.filter((l) => l === 'start').length).toBe(1);
});

test('a short message with just a repo still goes to the tool, not the model', async () => {
  const x = fakes(['{"say": "from the model"}']);
  const { turn } = bot({ model: x.model });
  await turn('chat-a', 'flisk-sh/pages'); // README Score is not reachable in tests: the reply does not matter
  expect(x.asked.length).toBe(0);
  expect((await turn('chat-a', 'please compare the READMEs of flisk-sh/pages and flisk-sh/flisk for me')).reply).toBe('from the model');
});

// The real jobs board in memory, with the bot reaching it through a fake fetch.
async function board() {
  const ctx = { db: await sqliteDb(':memory:'), now: () => Date.now(), probe: async () => 200 };
  const f = (async (url: string, init?: RequestInit) => handle(new Request(url, init), ctx, 'http://jobs.test')) as typeof fetch;
  const call = async (method: string, path: string, body?: unknown, key?: string) =>
    (await f(`http://jobs.test${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const poster = (await call('POST', '/api/agents', { name: 'poster' })).key as string;
  return { f, call, poster };
}
const onBoard = { jobsUrl: 'http://jobs.test', boardUrl: 'http://jobs.test', homepage: 'https://bot.test' };

test('a free-text job is claimed, done with the model on a computer, and submitted with a public result page', async () => {
  const w = await board();
  const id = (await w.call('POST', '/api/jobs', { title: 'Add two numbers', body: 'What is 2+2? <b>Run it</b>.', doneWhen: 'A link with the number' }, w.poster)).job.id;
  const x = fakes(['{"run": "echo $((2+2))"}', '{"say": "2+2 is 4 <checked>."}']);
  const { b, store } = bot({ model: x.model, computer: x.computer }, onBoard, w.f);
  await b.pass();
  const c = await store.load(`job-${id}`);
  expect(c.job?.step).toBe('submitted');
  expect(c.messages.map((m) => m.event)).toEqual(['found', 'claimed', 'working', 'run', 'worked', 'submitted']);
  expect(x.log).toEqual(['start', 'run echo $((2+2))', 'stop pod_1']);
  expect(x.asked[0].at(-1)?.content).toContain('Done when: A link with the number');
  const job = (await w.call('GET', `/api/jobs/${id}`)).job;
  expect(job.status).toBe('submitted');
  expect(job.result.url).toBe(`https://bot.test/result/${id}`);
  const page = await b.handle(new Request(`https://bot.test/result/${id}`));
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('2+2 is 4 &lt;checked&gt;.'); // the answer, escaped
  expect(html).toContain('$ echo $((2+2))');
  expect((await b.handle(new Request('https://bot.test/result/nope'))).status).toBe(404);
});

test('a job the model cannot do truthfully goes back to the board at once', async () => {
  const w = await board();
  const id = (await w.call('POST', '/api/jobs', { title: 'Log in to my bank', body: 'Use my password', doneWhen: 'A screenshot' }, w.poster)).job.id;
  const x = fakes(['{"cannot": "I have no access to that account."}']);
  const { b, store } = bot({ model: x.model, computer: x.computer }, onBoard, w.f);
  await b.pass();
  const c = await store.load(`job-${id}`);
  expect(c.job?.step).toBe('failed');
  expect(c.messages.at(-1)?.content).toContain('I have no access to that account.');
  const after = await w.call('GET', `/api/jobs/${id}`);
  expect(after.job.status).toBe('open');
  expect(after.events.at(-1).kind).toBe('released');
  await b.pass();
  expect(x.asked.length).toBe(1); // never taken twice
});

test('free-text jobs are left alone without a model, without an https address, and when the day is used up', async () => {
  for (const [brain, extra] of [
    [undefined, onBoard],
    [{ model: fakes(['{"say": "x"}']).model }, { ...onBoard, homepage: 'http://localhost:3000' }],
    [{ model: fakes(['{"say": "x"}']).model, modelCallsPerDay: 5 }, onBoard],
  ] as const) {
    const w = await board();
    const id = (await w.call('POST', '/api/jobs', { title: 'Write a poem', body: 'About Flisk', doneWhen: 'A link to the poem' }, w.poster)).job.id;
    const { b } = bot(brain, extra, w.f);
    await b.pass();
    expect((await w.call('GET', `/api/jobs/${id}`)).job.status).toBe('open');
  }
});
