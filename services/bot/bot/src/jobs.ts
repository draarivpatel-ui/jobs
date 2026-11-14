// The bot's work loop on the open jobs board. One job is one durable session ("job-<id>"): every step is saved in
// the session's checkpoint before the next step starts, so a crash, a restart or `flisk down` resumes the job where it
// stopped instead of claiming it twice or losing the result.
import { doWork, KINDS, type Kind, type WorkResult } from './work';

export type Step = 'claiming' | 'claimed' | 'worked' | 'submitted' | 'accepted' | 'rejected' | 'failed' | 'lost';
export const TERMINAL: Step[] = ['accepted', 'rejected', 'failed', 'lost'];

export interface Msg {
  role: 'user' | 'agent';
  content: string;
  at: string;
  /** A step line from the work loop, drawn as a small event instead of a chat bubble. */
  event?: string;
}

export interface Checkpoint {
  sessionId: string;
  messages: Msg[];
  title?: string;
  job?: { id: string; title: string; kind: Kind; input: Record<string, string>; step: Step; tries: number; result?: WorkResult; boardUrl: string };
}

type Maybe<T> = T | Promise<T>;

// Checkpoints live in a folder (Flisk stack, plain processes) or in a D1 table (Cloudflare Worker): both answer
// either way, so every call here awaits.
export interface Store {
  load(id: string): Maybe<Checkpoint>;
  save(c: Checkpoint): Maybe<void>;
  list(): Maybe<{ sessionId: string }[]>;
}

export interface JobsClient {
  base: string;
  key: () => Promise<string>;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
}

export function jobsClient(base: string, name: string, readKey: () => Maybe<string | null>, writeKey: (k: string) => Maybe<void>, f: typeof fetch = fetch, homepage?: string): JobsClient {
  let key: string | null | undefined;
  const raw = async (method: string, path: string, body?: unknown, auth?: string) => {
    const res = await f(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const register = async () => {
    const r = await raw('POST', '/api/agents', { name, homepage: homepage || undefined, about: 'Flisk Bot. Scores GitHub READMEs and checks pages for AI search, with Flisk tools. No model, same input gives the same answer.' });
    if (r.status !== 201) throw new Error(`could not register on the board: ${r.data?.error ?? r.status}`);
    key = r.data.key as string;
    await writeKey(key);
    return key;
  };
  const client: JobsClient = {
    base,
    key: async () => {
      if (key === undefined) key = await readKey();
      return key ?? (await register());
    },
    call: async (method, path, body) => {
      let r = await raw(method, path, body, await client.key());
      if (r.status === 401) r = await raw(method, path, body, await register()); // the board forgot us: join again
      if (r.status >= 400) throw Object.assign(new Error(r.data?.error ?? `HTTP ${r.status}`), { status: r.status });
      return r.data;
    },
  };
  return client;
}

const now = () => new Date().toISOString();
const say = (c: Checkpoint, event: string, content: string) => c.messages.push({ role: 'agent', content, at: now(), event });

/** Moves one job session forward by one step. Returns true when it changed something. */
export async function advance(c: Checkpoint, jobs: JobsClient, store: Store, work = doWork): Promise<boolean> {
  const j = c.job;
  if (!j || TERMINAL.includes(j.step)) return false;
  try {
    if (j.step === 'claiming') {
      // Claiming twice is safe: the board answers 200 when we already hold the claim.
      const d = await jobs.call('POST', `/api/jobs/${j.id}/claim`);
      j.step = 'claimed';
      say(c, 'claimed', `Claimed "${j.title}" from ${d.job.poster}${d.job.priceUsd !== null ? ` (stated price $${d.job.priceUsd}, payment not live)` : ''}. I have 24 hours.`);
      await store.save(c);
      return true;
    }
    if (j.step === 'claimed') {
      say(c, 'working', `Running ${j.kind === 'readme-score' ? 'README Score' : 'Citable'} on ${j.input.repo ?? j.input.url}…`);
      await store.save(c);
      j.result = await work(j.kind, j.input);
      j.step = 'worked';
      say(c, 'worked', [j.result.summary, ...j.result.fixes.map((x) => `• ${x}`), `Result page: ${j.result.url}`].join('\n'));
      await store.save(c);
      return true;
    }
    if (j.step === 'worked' && j.result) {
      const note = [j.result.summary, ...j.result.fixes.map((x) => `- ${x}`)].join('\n');
      const d = await jobs.call('POST', `/api/jobs/${j.id}/submit`, { resultUrl: j.result.url, note });
      j.step = d.job.status === 'accepted' ? 'accepted' : 'submitted';
      say(c, 'submitted', `Submitted the result link to the board.${checked(d)}`);
      if (j.step === 'accepted') say(c, 'accepted', 'Accepted. The job is done and on my public record.');
      await store.save(c);
      return true;
    }
    if (j.step === 'submitted') {
      const d = await jobs.call('GET', `/api/jobs/${j.id}`);
      if (d.job.status === 'accepted') {
        j.step = 'accepted';
        say(c, 'accepted', 'The poster accepted the work. Done, and on my public record.');
      } else if (d.job.status === 'open' || d.job.agent !== (await myId(jobs))) {
        j.step = 'rejected';
        const why = [...d.events].reverse().find((e: any) => e.kind === 'rejected')?.note ?? 'no reason given';
        say(c, 'rejected', `The poster rejected the work: ${why}`);
      } else return false;
      await store.save(c);
      return true;
    }
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 409 || err.status === 404) {
      j.step = 'lost';
      say(c, 'lost', `The board says: ${err.message}. I stopped this job.`);
    } else if (++j.tries >= 3) {
      j.step = 'failed';
      say(c, 'failed', `Gave up after 3 tries: ${err.message}. Releasing the claim so another agent can take it.`);
      await jobs.call('POST', `/api/jobs/${j.id}/release`).catch(() => {});
    } else {
      say(c, 'retry', `Try ${j.tries} of 3 failed: ${err.message}. I will try again on the next pass.`);
      await store.save(c);
      return false; // wait for the next pass instead of retrying at once
    }
    await store.save(c);
    return true;
  }
  return false;
}

function checked(d: any): string {
  const e = [...(d.events ?? [])].reverse().find((x: any) => x.kind === 'checked' || x.kind === 'check_failed');
  return e ? ` The board opened the link itself: ${e.note}.` : '';
}

const ids = new WeakMap<JobsClient, string>();
async function myId(jobs: JobsClient): Promise<string> {
  if (!ids.has(jobs)) ids.set(jobs, (await jobs.call('GET', '/api/me')).agent.id as string);
  return ids.get(jobs) as string;
}

/** One pass of the loop: resume unfinished sessions first, then claim at most one new job. */
export async function tick(jobs: JobsClient, store: Store, queue: (id: string, op: () => Promise<void>) => Promise<void>, work = doWork) {
  for (const { sessionId } of await store.list()) {
    if (!sessionId.startsWith('job-')) continue;
    await queue(sessionId, async () => {
      const c = await store.load(sessionId);
      while (await advance(c, jobs, store, work)) if (c.job?.step === 'submitted') break; // wait for the poster
    });
  }
  const open = await jobs.call('GET', `/api/jobs?status=open&kind=${KINDS.join(',')}`);
  const mine = await myId(jobs);
  // A job the bot already touched is never taken again: the same input gives the same answer, so a rejected result
  // would only be rejected twice.
  const seen = new Set((await store.list()).map((s) => s.sessionId));
  const next = open.jobs.find((x: any) => x.poster !== mine && !seen.has(`job-${x.id}`));
  if (!next) return;
  const sessionId = `job-${next.id}`;
  await queue(sessionId, async () => {
    const c = await store.load(sessionId);
    if (c.job) return;
    // Save the intent before claiming, so a crash right after the claim resumes this job instead of forgetting it.
    c.title = next.title;
    c.job = { id: next.id, title: next.title, kind: next.kind, input: next.input, step: 'claiming', tries: 0, boardUrl: `${jobs.base}/job/${next.id}` };
    say(c, 'found', `Found an open job on the board: "${next.title}".`);
    await store.save(c);
    while (await advance(c, jobs, store, work)) if (c.job?.step === 'submitted') break;
  });
}
