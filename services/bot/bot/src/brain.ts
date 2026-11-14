// The bot's model and its computer. The model is Flisk Inference (inference.flisk.si, OpenAI-compatible); the computer
// is a pod from fleet.flisk.si, started on the first action of a task and always deleted when the task ends. The loop
// is the small version of chat.flisk.si's (flisk-sh/chat src/loop.js): the model replies with one JSON action at a
// time, the bot does it and sends the result back, until the model answers.

type Maybe<T> = T | Promise<T>;
type Fetch = typeof fetch;

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type Model = (messages: ChatMsg[]) => Promise<{ text?: string; error?: string }>;

export interface FleetAnswer {
  status: number;
  data: any;
  error: string | null;
}

export interface Computer {
  start(): Promise<FleetAnswer>;
  run(id: string, command: string): Promise<FleetAnswer>;
  write(id: string, path: string, content: string): Promise<FleetAnswer>;
  read(id: string, path: string): Promise<FleetAnswer>;
  stop(id: string): Promise<FleetAnswer>;
}

export interface ModelConfig {
  key: string;
  url?: string;
  model?: string;
  /** A Cloudflare service binding to the inference Worker: a Worker cannot call it by its public address (error 1033). */
  binding?: { fetch: Fetch };
}

export function wolfModel(o: ModelConfig, f: Fetch = fetch): Model {
  const url = o.url || 'https://inference.flisk.si/v1/chat/completions';
  const model = o.model || 'flisk-wolf-chat';
  const call: Fetch = o.binding ? (((u: any, init: any) => o.binding!.fetch(u, init)) as Fetch) : f;
  return async (messages) => {
    try {
      const res = await call(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.key}`, 'user-agent': 'flisk-bot' },
        body: JSON.stringify({ model, messages, max_tokens: 1024, temperature: 0 }),
        signal: AbortSignal.timeout(60_000),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || (body?.error && !body?.choices)) {
        const why = typeof body?.error === 'string' ? body.error : body?.error?.message;
        return { error: String(why || `HTTP ${res.status}`).slice(0, 200) };
      }
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return { text };
      // Workers AI hands back a JSON-looking answer already parsed.
      if (text && typeof text === 'object') return { text: JSON.stringify(text) };
      return { error: 'the model sent an empty answer' };
    } catch (e) {
      return { error: `the model did not answer: ${String((e as Error)?.message || e).slice(0, 150)}` };
    }
  };
}

export interface FleetConfig {
  /** A fleet key, or fleet's trusted-site secret together with `login`. */
  key: string;
  url?: string;
  /** Sent as X-On-Behalf-Of: the fleet login the bot's computers belong to (with the trusted-site secret). */
  login?: string;
}

export function fleetComputer(o: FleetConfig, f: Fetch = fetch): Computer {
  const base = (o.url || 'https://fleet.flisk.si').replace(/\/+$/, '');
  const call = async (method: string, path: string, body?: unknown): Promise<FleetAnswer> => {
    try {
      const res = await f(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', 'user-agent': 'flisk-bot', ...(o.login ? { 'x-on-behalf-of': o.login } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const data: any = await res.json().catch(() => ({}));
      return { status: res.status, data, error: res.status >= 400 ? String(data?.error || `fleet answered ${res.status}`) : null };
    } catch (e) {
      return { status: 0, data: {}, error: `fleet did not answer: ${String((e as Error)?.message || e).slice(0, 150)}` };
    }
  };
  const id = encodeURIComponent;
  return {
    start: () => call('POST', '/v1/pods', { cpu: 2, ram: 4 }),
    run: (pod, command) => call('POST', `/v1/pods/${id(pod)}/run`, { command, timeout: 60 }),
    write: (pod, path, content) => call('PUT', `/v1/pods/${id(pod)}/files`, { path, content }),
    read: (pod, path) => call('GET', `/v1/pods/${id(pod)}/files?path=${id(path)}`),
    stop: (pod) => call('DELETE', `/v1/pods/${id(pod)}`),
  };
}

export type Action =
  | { type: 'say'; text: string }
  | { type: 'cannot'; why: string }
  | { type: 'run'; command: string }
  | { type: 'write'; path: string; content: string }
  | { type: 'read'; path: string }
  | { type: 'bad' };

/** Reads the model's reply as one action. Plain text with no JSON in it is the answer itself. */
export function parseAction(text: string): Action {
  const s = String(text ?? '')
    .replace(/<\|[^|]+\|>/g, '')
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const a = JSON.parse(s.slice(start, end + 1));
      if (typeof a?.run === 'string' && a.run.trim()) return { type: 'run', command: a.run.trim() };
      if (a?.write && typeof a.write.path === 'string' && typeof a.write.content === 'string') return { type: 'write', path: a.write.path, content: a.write.content };
      if (typeof a?.read === 'string' && a.read.trim()) return { type: 'read', path: a.read.trim() };
      if (typeof a?.cannot === 'string' && a.cannot.trim()) return { type: 'cannot', why: a.cannot.trim() };
      if (typeof a?.say === 'string' && a.say.trim()) return { type: 'say', text: a.say.trim() };
    } catch {}
    // It tried to send an action and the JSON is broken: ask again instead of showing the person raw JSON.
    if (/^\s*\{\s*"(run|write|read|say|cannot)"\s*:/.test(s.slice(start))) return { type: 'bad' };
  }
  return s ? { type: 'say', text: s } : { type: 'bad' };
}

export interface TaskStep {
  kind: 'run' | 'write' | 'read';
  /** The command, or the file path. */
  what: string;
  output: string;
  ok: boolean;
}

export interface TaskResult {
  /** What to tell the person. Always set, also when the task failed. */
  text: string;
  steps: TaskStep[];
  modelCalls: number;
  usedComputer: boolean;
  /** The model said it cannot do the task truthfully. */
  cannot?: string;
  /** The model or the computer failed. */
  error?: string;
}

export interface TaskOptions {
  task: string;
  model: Model;
  /** Earlier turns of the same conversation. */
  history?: ChatMsg[];
  computer?: Computer | null;
  /** Most actions on the computer in one task (default 5). */
  maxActions?: number;
  name?: string;
  /** A job from the board: the model may give it back with {"cannot": "..."}. */
  job?: boolean;
  /** Called with the pod id when a computer starts and with null when it is gone, so a crash leaves a record to clean up. */
  onPod?: (id: string | null) => Maybe<void>;
  onStep?: (step: TaskStep) => Maybe<void>;
  /** Asked before a computer is started (the day's allowance). */
  mayStart?: () => Maybe<boolean>;
}

const clip = (s: unknown, n = 1500) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more characters)` : t;
};

export function systemPrompt(o: { name?: string; computer: boolean; maxActions: number; job?: boolean }): string {
  return [
    `You are ${o.name || 'Flisk Bot'} (bot.flisk.si), made by Flisk. You answer questions and do small tasks. Reply with exactly one JSON object and nothing else.`,
    'To answer: {"say": "your answer, plain text, short and concrete"}',
    ...(o.computer
      ? [
          'You can also use a fresh Linux computer. It starts empty, has internet access, and is deleted when you answer. Use it only when the task needs something run, built, fetched or measured; answer plain questions directly with "say".',
          'Run one shell command (up to 60 seconds): {"run": "command"}',
          'Write a file: {"write": {"path": "/tmp/name", "content": "text"}}',
          'Read a file: {"read": "/tmp/name"}',
          `After each action you get its result and send the next action. You have at most ${o.maxActions} actions, so be direct. Then answer with "say": state the result with the real output, never a guess.`,
        ]
      : ['You have no computer here, so you cannot run commands or open web pages. Say so when a task needs that.']),
    ...(o.job ? ['This task is a job from a public jobs board. If you cannot do it truthfully with what you have, reply {"cannot": "why"} and the job goes back to the board.'] : []),
    'Never invent output, links or results. For a GitHub repo README score or an AI search check of a web page, tell the person to send just the repo (owner/name) or the https:// address.',
  ].join('\n');
}

/** One task: ask the model, do its actions on a computer, return its answer. The computer is always deleted. */
export async function runTask(o: TaskOptions): Promise<TaskResult> {
  const maxActions = o.maxActions ?? 5;
  const computer = o.computer ?? null;
  const messages: ChatMsg[] = [{ role: 'system', content: systemPrompt({ name: o.name, computer: !!computer, maxActions, job: o.job }) }, ...(o.history ?? []), { role: 'user', content: o.task }];
  const steps: TaskStep[] = [];
  let modelCalls = 0;
  let podId: string | null = null;
  let usedComputer = false;
  let nudges = 0;
  const done = (text: string, extra: Partial<TaskResult> = {}): TaskResult => ({ text, steps, modelCalls, usedComputer, ...extra });
  const next = (reply: string, note: string) => messages.push({ role: 'assistant', content: reply }, { role: 'user', content: note });
  try {
    // Every action costs one model call; a few more are allowed for a retry and for the closing answer.
    while (modelCalls < maxActions + 4) {
      let r = await o.model(messages);
      modelCalls++;
      if (r.error) {
        r = await o.model(messages);
        modelCalls++;
      }
      if (r.error || !r.text) return done(`The model did not answer (${r.error ?? 'empty answer'}). Try again in a minute.`, { error: r.error ?? 'empty answer' });
      const a = parseAction(r.text);
      if (a.type === 'say') return done(a.text);
      if (a.type === 'cannot') return o.job ? done(a.why, { cannot: a.why }) : done(a.why);
      const stop = a.type === 'bad' ? 'That was not one valid JSON object. Reply with exactly one JSON object.' : !computer ? 'Error: there is no computer here. Answer with {"say": "..."}.' : steps.length >= maxActions ? 'You are out of actions. Reply with {"say": "..."} now, with what you found.' : null;
      if (stop) {
        if (++nudges > 2) break;
        next(r.text, stop);
        continue;
      }
      if (a.type === 'bad' || !computer) break; // unreachable: both are answered above
      if (!podId) {
        if (o.mayStart && !(await o.mayStart())) {
          if (++nudges > 2) break;
          next(r.text, "Error: today's free computer time is used up. Answer with {\"say\": \"...\"} without it, and say that a computer was not available.");
          continue;
        }
        const made = await computer.start();
        if (made.error || !made.data?.id) return done(`I could not start a computer: ${made.error ?? 'fleet sent no computer'}.`, { error: made.error ?? 'no computer' });
        podId = String(made.data.id);
        usedComputer = true;
        await o.onPod?.(podId);
      }
      let step: TaskStep;
      let note: string;
      if (a.type === 'run') {
        const x = await computer.run(podId, a.command);
        const out = x.error ? `Error: ${x.error}` : `Exit code ${x.data.exitCode}\nstdout:\n${clip(x.data.stdout) || '(empty)'}${x.data.stderr ? `\nstderr:\n${clip(x.data.stderr, 600)}` : ''}`;
        step = { kind: 'run', what: a.command, output: out, ok: !x.error && x.data.exitCode === 0 };
        note = out;
      } else if (a.type === 'write') {
        const x = await computer.write(podId, a.path, a.content);
        step = { kind: 'write', what: a.path, output: x.error ? `Error: ${x.error}` : `Wrote ${a.path} (${a.content.length} characters)`, ok: !x.error };
        note = step.output;
      } else {
        const x = await computer.read(podId, a.path);
        const out = x.error ? `Error: ${x.error}` : x.data.encoding && x.data.encoding !== 'utf8' ? 'Error: that file is not text' : `Content:\n${clip(x.data.content)}`;
        step = { kind: 'read', what: a.path, output: out, ok: !x.error };
        note = out;
      }
      steps.push(step);
      await o.onStep?.(step);
      next(r.text, `${note}\n\nNext action as JSON only.`);
    }
    return done('I ran out of steps before I had an answer. Ask for something smaller.', { error: 'ran out of steps' });
  } finally {
    if (podId && computer) {
      const gone = await computer.stop(podId).catch(() => null);
      // Keep the record when the delete failed, so the next pass tries again.
      if (gone && (!gone.error || gone.status === 404)) await Promise.resolve(o.onPod?.(null)).catch(() => {});
    }
  }
}
