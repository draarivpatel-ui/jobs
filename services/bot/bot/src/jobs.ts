// The bot's work loop on the open jobs board. One job is one durable session ("job-<id>"): every step is saved in
// the session's checkpoint before the next step starts, so a crash, a restart or `flisk down` resumes the job where it
// stopped instead of claiming it twice or losing the result.
import type { TaskStep } from './brain';
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
  /** "task" is a free-text job: the model does it, on a computer when it needs one. */
  job?: { id: string; title: string; kind: Kind | 'task'; input: Record<string, string>; step: Step; tries: number; result?: JobResult; boardUrl: string };
  /** A computer this session started and has not deleted yet. Cleared when it is gone. */
  pod?: string;
  /** Model calls this session made (0 or missing: only Flisk's own tools were used). */
  modelCalls?: number;
}

/** A free-text job's result also keeps the answer and what was run, for the public result page. */
export type JobResult = WorkResult & { text?: string; steps?: TaskStep[] };

/** The model gave a job back: it cannot do it truthfully. Never retried. */
export class Cannot extends Error {}

/** Does free-text jobs with the model. Absent when no model is connected: the bot then leaves those jobs alone. */
export interface JobBrain {
  /** Is there enough of today's allowance left to start one more job? */
  room(): Maybe<boolean>;
  run(c: Checkpoint): Promise<JobResult>;
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

export function jobsClient(base: string, name: string, readKey: () => Maybe<string | null>, writeKey: (k: string) => Maybe<void>, f: typeof fetch = fetch, homepage?: string, about?: string): JobsClient {
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
    const r = await raw('POST', '/api/agents', { name, homepage: homepage || undefined, about: about || 'Flisk Bot. Scores GitHub READMEs and checks pages for AI search, with Flisk tools. No model, same input gives the same answer.' });
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
export async function advance(c: Checkpoint, jobs: JobsClient, store: Store, work = doWork, brain?: JobBrain): Promise<boolean> {
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
      if (j.kind === 'task') {
        if (!brain) throw new Error('no model is connected to this bot');
        say(c, 'working', 'Working on it with the model…');
        await store.save(c);
        j.result = await brain.run(c);
      } else {
        say(c, 'working', `Running ${j.kind === 'readme-score' ? 'README Score' : 'Citable'} on ${j.input.repo ?? j.input.url}…`);
        await store.save(c);
        j.result = await work(j.kind, j.input);
      }
      j.step = 'worked';
      say(c, 'worked', [j.result.text ?? j.result.summary, ...j.result.fixes.map((x) => `• ${x}`), `Result page: ${j.result.url}`].join('\n'));
      await store.save(c);
      return true;
    }
    if (j.step === 'worked' && j.result) {
      const note = [j.result.text ?? j.result.summary, ...j.result.fixes.map((x) => `- ${x}`)].join('\n').slice(0, 1000);
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
    if (err instanceof Cannot) {
      j.step = 'failed';
      say(c, 'failed', `I cannot do this job truthfully: ${err.message} Releasing the claim so another agent can take it.`);
      await jobs.call('POST', `/api/jobs/${j.id}/release`).catch(() => {});
    } else if (err.status === 409 || err.status === 404) {
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

/**
 * One pass of the loop: resume unfinished sessions first, then claim new jobs, at most `max` of them. A Worker passes a
 * small number (Workers Free allows 50 subrequests per run); a long-running process takes one per pass.
 */
export async function tick(jobs: JobsClient, store: Store, queue: (id: string, op: () => Promise<void>) => Promise<void>, work = doWork, max = 1, brain?: JobBrain) {
  for (const { sessionId } of await store.list()) {
    if (!sessionId.startsWith('job-')) continue;
    await queue(sessionId, async () => {
      const c = await store.load(sessionId);
      while (await advance(c, jobs, store, work, brain)) if (c.job?.step === 'submitted') break; // wait for the poster
    });
  }
  const mine = await myId(jobs);
  const open = await jobs.call('GET', '/api/jobs?status=open');
  // A job the bot already touched is never taken again: the same input gives the same answer, so a rejected result
  // would only be rejected twice.
  const seen = new Set((await store.list()).map((s) => s.sessionId));
  // A job with a kind is done with Flisk's own tools. A job without one is free text: the model does it, so it is
  // taken only when a model is connected and today's allowance has room, and it counts double in the pass (it costs
  // more calls than a tool job).
  const free = !!brain && (await brain.room());
  const fresh: any[] = [];
  let left = Math.max(1, max);
  for (const x of open.jobs) {
    if (left <= 0) break;
    if (x.poster === mine || seen.has(`job-${x.id}`)) continue;
    if (x.kind === null ? !free || fresh.some((y) => y.kind === null) : !KINDS.includes(x.kind)) continue;
    fresh.push(x);
    left -= x.kind === null ? 2 : 1;
  }
  for (const next of fresh) {
    const sessionId = `job-${next.id}`;
    await queue(sessionId, async () => {
      const c = await store.load(sessionId);
      if (c.job) return;
      // Save the intent before claiming, so a crash right after the claim resumes this job instead of forgetting it.
      c.title = next.title;
      c.job = { id: next.id, title: next.title, kind: next.kind ?? 'task', input: next.input ?? { body: String(next.body ?? ''), doneWhen: String(next.doneWhen ?? '') }, step: 'claiming', tries: 0, boardUrl: `${jobs.base}/job/${next.id}` };
      say(c, 'found', `Found an open job on the board: "${next.title}".`);
      await store.save(c);
      while (await advance(c, jobs, store, work, brain)) if (c.job?.step === 'submitted') break;
    });
  }
}
