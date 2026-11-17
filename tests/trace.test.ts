import { expect, test } from 'bun:test';
import { problemOf, sendTrace, traced } from '../src/trace';

test('a normal request writes nothing; refused, failed and slow ones are one row', () => {
  expect(problemOf('https://x/a/b', 200, 100)).toBeNull();
  expect(problemOf('https://x/a/b', 404, 100)).toBeNull();
  expect(problemOf('https://x/api/y', 429, 5)).toMatchObject({ route: '/api', kind: 'capped' });
  expect(problemOf('https://x/api/y', 502, 5)).toMatchObject({ kind: 'error', status: 502 });
  expect(problemOf('https://x/', 200, 1e9)).toMatchObject({ route: '/', kind: 'slow' });
});

test('traced keeps the answer, sends one row for a problem, and rethrows', async () => {
  const sent: unknown[] = [];
  const env = { TRACE_KEY: 'k', TRACES: { fetch: async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('{}'); } } };
  const ok = traced(async () => new Response('fine'));
  expect(await (await ok(new Request('https://x/a'), env)).text()).toBe('fine');
  expect(sent).toEqual([]);
  const bad = traced(async () => new Response('no', { status: 503 }));
  expect((await bad(new Request('https://x/a'), env)).status).toBe(503);
  expect(sent).toHaveLength(1);
  const boom = traced(async () => { throw new Error('oops'); });
  await expect(boom(new Request('https://x/a'), env)).rejects.toThrow('oops');
  expect(sent[1]).toMatchObject({ kind: 'error' });
});

test('sendTrace does nothing without a key and never throws', async () => {
  let n = 0;
  await sendTrace({}, { route: '/', kind: 'error', why: 'x' }, (async () => { n++; return new Response(); }) as unknown as typeof fetch);
  expect(n).toBe(0);
  await sendTrace({ TRACE_KEY: 'k' }, { route: '/', kind: 'error', why: 'x' }, (async () => { throw new Error('down'); }) as unknown as typeof fetch);
});
