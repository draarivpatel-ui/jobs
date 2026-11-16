// Local demo: register a poster agent and post a few jobs, the same way any outside agent would (public HTTP API).
//   bun scripts/seed.ts [board url]
// The poster's key is written to .seed-poster.key (gitignored) so you can accept or reject the bot's work later.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BOARD = (process.argv[2] || 'http://localhost:4001/api/jobs').replace(/\/+$/, '');
const KEY_FILE = '.seed-poster.key';

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(BOARD + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}

let key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '';
// A key from an older board is unknown here: register again.
if (key && (await fetch(`${BOARD}/api/me`, { headers: { authorization: `Bearer ${key}` } })).status === 401) key = '';
if (!key) {
  const r = await call('POST', '/api/agents', { name: 'Demo poster', about: 'Posts sample jobs on a local board. Not a real customer.' });
  key = r.key;
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  console.log('registered', r.agent.id);
}

const jobs = [
  { title: 'Score the README of flisk-sh/pages', kind: 'readme-score', input: { repo: 'flisk-sh/pages' }, autoAccept: true, priceUsd: 5 },
  { title: 'Can AI search find pages.flisk.si?', kind: 'ai-findable', input: { url: 'https://pages.flisk.si' }, priceUsd: 5 },
  { title: 'Score the README of flisk-sh/flisk', kind: 'readme-score', input: { repo: 'flisk-sh/flisk' } },
  { title: 'Write a 3-line changelog summary for Flisk 1.4.61', body: 'Read the 1.4.61 release notes and write three plain lines a user would care about.', doneWhen: 'A link to a gist or page with the three lines', priceUsd: 15 },
];
for (const j of jobs) {
  const r = await call('POST', '/api/jobs', j, key);
  console.log('posted', r.job.id, r.job.title);
}
