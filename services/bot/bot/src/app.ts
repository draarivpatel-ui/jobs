// The bot as one object: the Flisk agent contract over Request/Response, the web view, the work loop and the idle
// sweep. index.ts runs it under Bun (Flisk stack, plain processes) and worker.ts as a Cloudflare Worker.
//
// Contract with Flisk (see docs/agents/ai-agents.md): /health is the process alive, /ready is the checkpoint store
// reachable, POST /turn with x-session-id, GET/DELETE /session, GET /sessions. Idle is healthy, so /health never
// checks the store.
import { runTask, type ChatMsg, type Computer, type Model, type TaskStep } from './brain';
import { Cannot, jobsClient, tick, TERMINAL, type Checkpoint, type JobBrain, type JobsClient } from './jobs';
import type { BotStore } from './stores';
import { doWork, parseAsk } from './work';
import { boardOptions, boardSessions, guessRole, withHeader } from './rma';
import { FONTS, PAGE } from './rma.generated';

export interface BotConfig {
  /** Jobs to take in one pass (default 1). A Worker takes a few per cron run. */
  jobsPerPass?: number;
  name: string;
  /** Public address of the board, for links in answers. */
  boardUrl: string;
  /** Address the bot calls the board on. Empty: chat only. */
  jobsUrl: string;
  homepage?: string;
  /** fleet.flisk.si, where the bot's computers come from. The /computers page lists its providers. */
  fleetUrl?: string;
  idleTimeoutMs?: number;
  durability?: string;
  /** The model (Flisk Inference) and the computers (fleet). Absent: the bot only runs Flisk's own tools, as before. */
  brain?: BrainConfig;
}

export interface BrainConfig {
  model: Model;
  /** Absent: the model answers, and says so when a task needs something run. */
  computer?: Computer | null;
  /** Daily caps, so strangers cannot use up the free allowance. A day is a UTC day. */
  modelCallsPerDay?: number;
  computerTasksPerDay?: number;
  /** Messages one visitor may send to the model in a day. */
  visitorMessagesPerDay?: number;
  /** Most actions on the computer in one task. */
  maxActions?: number;
}

interface Usage {
  day: string;
  n: Record<string, number>;
}
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_LIST_LIMIT = 500;

export function createBot(cfg: BotConfig, store: BotStore, f: typeof fetch = fetch) {
  const idleMs = cfg.idleTimeoutMs || 86_400_000;
  const durability = cfg.durability || 'files';
  const brain = cfg.brain ?? null;
  const caps = { model: brain?.modelCallsPerDay ?? 60, computer: brain?.computerTasksPerDay ?? 10, visitor: brain?.visitorMessagesPerDay ?? 10 };
  const about = brain
    ? `${cfg.name}. Scores GitHub READMEs and checks pages for AI search with Flisk tools, and does small free-text jobs with the Flisk Wolf model${brain.computer ? ' on a throwaway computer' : ''}. Gives a job back when it cannot do it truthfully.`
    : undefined;
  const jobs: JobsClient | null = cfg.jobsUrl ? jobsClient(cfg.jobsUrl, cfg.name, () => store.readKey(), (k) => store.writeKey(k), f, cfg.homepage, about) : null;
  const loopState = { enabled: !!jobs, lastPass: null as string | null, lastError: null as string | null };
  const activeTurns = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  let draining = false;
  let inFlight = 0;
  // fleet's providers, from its public price list, for the /computers page. Cached 5 minutes.
  const fleetBase = (cfg.fleetUrl || 'https://fleet.flisk.si').replace(/\/+$/, '');
  let fleetRows = { at: 0, rows: null as null | { label: string; pricePerHour: number | null; status: string }[] };
  async function fleetProviders() {
    if (fleetRows.rows && Date.now() - fleetRows.at < 300_000) return fleetRows.rows;
    try {
      const res = await f(`${fleetBase}/v1/prices`, { signal: AbortSignal.timeout(3000) });
      const rows = res.ok ? ((await res.json()) as any)?.prices : null;
      if (!Array.isArray(rows)) throw new Error('no prices');
      const clean = rows
        .filter((r: any) => typeof r?.provider === 'string' && r.provider !== 'demo')
        .map((r: any) => ({ label: String(r.label || r.provider).slice(0, 60), pricePerHour: typeof r.pricePerHour === 'number' ? r.pricePerHour : null, status: String(r.status || '') }));
      fleetRows = { at: Date.now(), rows: clean };
      return clean;
    } catch {
      return fleetRows.rows;
    }
  }

  const HELP = brain
    ? `I am ${cfg.name}. Ask me anything and I answer with the Flisk Wolf model${brain.computer ? ', and I can run a small task on a throwaway computer' : ''}. Send just a GitHub repo (owner/name) to score its README, or just an https:// address to check whether AI search can find it.`
    : `I am ${cfg.name}. I do two kinds of work, with Flisk's own tools and no model, so the same input always gives the same answer:
• Send a GitHub repo (owner/name) and I score its README with README Score.
• Send an https:// address and I check whether AI search can find and cite it, with Citable.
I also take these jobs from the open jobs board by myself. Each job gets its own session here, saved after every step.`;

  // Today's use of the model and the computers. One small record; two requests at the same moment may count as one,
  // which is fine for a cap that only has to stop a flood.
  const today = () => new Date().toISOString().slice(0, 10);
  async function usage(): Promise<Usage> {
    try {
      const u = JSON.parse((await store.readUsage()) || 'null') as Usage | null;
      if (u && u.day === today() && u.n && typeof u.n === 'object') return u;
    } catch {}
    return { day: today(), n: {} };
  }
  async function spend(key: string, by = 1) {
    const u = await usage();
    u.n[key] = (u.n[key] ?? 0) + by;
    await store.writeUsage(JSON.stringify(u));
  }
  const used = async (key: string) => (await usage()).n[key] ?? 0;
  const mayStart = async () => {
    if ((await used('computer')) >= caps.computer) return false;
    await spend('computer');
    return true;
  };
  // A visitor is counted by a short hash of their address, never the address itself.
  async function visitorOf(req: Request): Promise<string> {
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`flisk-bot:${ip}`)));
    return 'v:' + [...h.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A computer left behind by a task that was cut off (a closed tab cancels a Worker request): delete it.
  async function dropPod(c: Checkpoint) {
    if (!c.pod || !brain?.computer) return;
    const gone = await brain.computer.stop(c.pod).catch(() => null);
    if (gone && (!gone.error || gone.status === 404)) {
      c.pod = undefined;
      await store.save(c);
    }
  }
  const stepLine = (s: TaskStep) => `${s.kind === 'run' ? `$ ${s.what}` : `${s.kind} ${s.what}`}\n${s.output}`.slice(0, 700);
  // One task with the model: every step is saved in the session as it happens, so the page shows the work.
  async function think(c: Checkpoint, task: string, history: ChatMsg[], job: boolean) {
    await dropPod(c);
    const r = await runTask({
      task,
      model: brain!.model,
      history,
      computer: brain!.computer,
      maxActions: brain!.maxActions,
      name: cfg.name,
      job,
      mayStart,
      onPod: async (id) => {
        c.pod = id ?? undefined;
        await store.save(c);
      },
      onStep: async (s) => {
        c.messages.push({ role: 'agent', content: stepLine(s), at: new Date().toISOString(), event: s.kind });
        await store.save(c);
      },
    });
    c.modelCalls = (c.modelCalls ?? 0) + r.modelCalls;
    await spend('model', r.modelCalls);
    return r;
  }

  // Free-text jobs from the board. The result link must be an https page the poster can open, so the bot needs a
  // public https address of its own.
  const jobBrain: JobBrain | undefined =
    brain && /^https:\/\//.test(cfg.homepage ?? '')
      ? {
          room: async () => (await used('model')) + 9 <= caps.model,
          run: async (c) => {
            const j = c.job!;
            const r = await think(c, `Job: ${j.title}\n\n${j.input.body ?? ''}\n\nDone when: ${j.input.doneWhen ?? ''}`, [], true);
            if (r.cannot) throw new Cannot(r.cannot);
            if (r.error) throw new Error(r.text);
            return { url: `${cfg.homepage!.replace(/\/+$/, '')}/result/${j.id}`, score: 0, grade: '', summary: r.text.slice(0, 200), fixes: [], text: r.text, steps: r.steps };
          },
        }
      : undefined;

  // A turn in a chat session: check a repo or a page right now. In a job session: say where the job stands.
  async function runTurn(checkpoint: Checkpoint, input: string, visitor = 'v:local'): Promise<string> {
    const j = checkpoint.job;
    if (j) {
      return `This session is the job "${j.title}" (${j.kind}). Step: ${j.step}${TERMINAL.includes(j.step) ? ' (finished)' : ''}.${j.result ? `\nResult: ${j.result.summary} ${j.result.url}` : ''}\nIts public record: ${cfg.boardUrl}/job/${j.id}`;
    }
    const found = parseAsk(input);
    // With a model, only a short message that is mostly the repo or the address goes straight to the tool.
    const ask = found && (!brain || input.trim().split(/\s+/).length <= 6) ? found : null;
    if (!ask && brain) {
      if ((await used(visitor)) >= caps.visitor || (await used('model')) >= caps.model) {
        return `Today's free allowance for questions is used up; it starts again at midnight UTC. README scores (send owner/name) and AI search checks (send an https:// address) still work.`;
      }
      await spend(visitor);
      if (!checkpoint.title) checkpoint.title = input.slice(0, 60);
      // The conversation so far: the last few turns, without the step lines and without the message just sent.
      const history = checkpoint.messages
        .slice(0, -1)
        .filter((m) => !m.event)
        .slice(-6)
        .map((m): ChatMsg => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content.slice(0, 2000) }));
      return (await think(checkpoint, input, history, false)).text;
    }
    if (!ask) return HELP;
    if (!checkpoint.title) checkpoint.title = ask.kind === 'readme-score' ? `README of ${ask.input.repo}` : `AI search check of ${ask.input.url}`;
    try {
      const r = await doWork(ask.kind, ask.input);
      return [r.summary, ...r.fixes.map((x) => `• ${x}`), `Full result: ${r.url}`].join('\n');
    } catch (e) {
      return `I could not check that: ${(e as Error).message}`;
    }
  }

  // Turns and loop steps for one session run one after another; activeTurns says which sessions are busy right now.
  function queueSessionOperation<T = void>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const run = (queues.get(sessionId) ?? Promise.resolve()).then(async () => {
      activeTurns.set(sessionId, (activeTurns.get(sessionId) ?? 0) + 1);
      try {
        return await operation();
      } finally {
        const left = (activeTurns.get(sessionId) ?? 1) - 1;
        if (left > 0) activeTurns.set(sessionId, left);
        else activeTurns.delete(sessionId);
      }
    });
    queues.set(sessionId, run.then(() => {}, () => {}));
    return run;
  }

  const statusOf = (id: string) => (activeTurns.has(id) ? ('active' as const) : ('idle' as const));

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  async function handle(req: Request): Promise<Response> {
    inFlight++;
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const idOf = () => String(req.headers.get('x-session-id') ?? url.searchParams.get('id') ?? '');

      if (path === '/health') return json(200, { status: 'ok', service: 'bot', draining });
      if (path === '/ready') {
        const ok = !draining && (await store.ready());
        return json(ok ? 200 : 503, { ready: ok, durability });
      }

      // Session routing: the id comes from the x-session-id header, so several instances can share one route.
      if (path === '/turn' && req.method === 'POST') {
        if (draining) return json(503, { error: 'draining' });
        const sessionId = String(req.headers.get('x-session-id') ?? '');
        if (!ID.test(sessionId)) return json(400, { error: 'x-session-id header is required (1-128 letters, digits, - or _)' });
        let body: any;
        try {
          const raw = await req.text();
          if (raw.length > 16_000) throw new SyntaxError('too large');
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return json(400, { error: 'invalid_json' });
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'invalid_json' });
        if (typeof body.input !== 'string' || body.input.length === 0 || body.input.length > 2000) {
          return json(400, { error: 'input_required', hint: 'send {"input": "..."} (up to 2000 characters)' });
        }
        const input: string = body.input;
        const visitor = await visitorOf(req);
        return await queueSessionOperation(sessionId, async () => {
          const checkpoint = await store.load(sessionId);
          checkpoint.messages.push({ role: 'user', content: input, at: new Date().toISOString() });
          const reply = await runTurn(checkpoint, input, visitor);
          checkpoint.messages.push({ role: 'agent', content: reply, at: new Date().toISOString() });
          await store.save(checkpoint);
          return json(200, { sessionId, reply, turns: checkpoint.messages.filter((m) => m.role === 'user').length });
        });
      }

      if (path === '/session' && req.method === 'GET') {
        const sessionId = idOf();
        if (!ID.test(sessionId)) return json(400, { error: 'x-session-id header is required' });
        const checkpoint = await store.load(sessionId);
        return json(200, { ...checkpoint, turns: checkpoint.messages.filter((m) => m.role === 'user').length, status: statusOf(sessionId) });
      }

      if (path === '/session' && req.method === 'DELETE') {
        const sessionId = idOf();
        if (!ID.test(sessionId)) return json(400, { error: 'x-session-id header is required' });
        if (activeTurns.has(sessionId)) return json(409, { error: 'turn_in_flight' });
        await store.delete(sessionId);
        return json(200, { deleted: sessionId });
      }

      // Read-only list of the stored sessions, most recent first. status is 'active' while this instance runs a turn
      // for the session, otherwise 'idle'. total counts every stored session, also those past the limit.
      if (path === '/sessions' && req.method === 'GET') {
        const all = [...(await store.list())].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
        return json(200, { sessions: all.slice(0, SESSION_LIST_LIMIT).map((s) => ({ ...s, status: statusOf(s.sessionId) })), total: all.length });
      }

      // The web view (bot.flisk.si): the real Run My Agents board page, answered from the bot's own sessions. The page
      // calls these routes with relative URLs. What the bot cannot do (rename, pin, queue, upload) answers with an error
      // the page shows as a message.
      if (path === '/api/sessions' && req.method === 'GET') {
        const rows = (await store.recent(60)).map((s) => ({ ...s, active: activeTurns.has(s.sessionId) }));
        return json(200, boardSessions(rows, cfg.boardUrl || cfg.homepage || 'https://bot.flisk.si'));
      }
      if (path === '/api/options' && req.method === 'GET') return json(200, boardOptions());
      // The page also asks for the kitchen board and the ratings. The bot has neither: empty answers, not 404s.
      if (path === '/api/umux' && req.method === 'GET') return json(200, { ratings: [] });
      if (path === '/api/detect' && req.method === 'GET') return json(200, { role: guessRole(url.searchParams.get('text') ?? ''), agent: null });
      if ((path === '/api/tasks' || path === '/api/kitchen') && req.method === 'GET') return json(200, { tasks: [], lanes: [] });
      if ((path === '/api/send' || path === '/api/new') && req.method === 'POST') {
        let body: any = {};
        try {
          body = JSON.parse((await req.text()) || '{}');
        } catch {}
        const text = String(body.text ?? '').trim();
        if (!text) return json(400, { error: brain ? 'Type a message first.' : 'Type a repo (owner/name) or an https:// address first.' });
        if (text.length > 2000) return json(400, { error: 'That message is too long.' });
        const sessionId = path === '/api/new' ? 'chat-' + crypto.randomUUID().slice(0, 8) : String(body.id ?? '');
        if (!ID.test(sessionId)) return json(400, { error: 'Pick a session first.' });
        const visitor = await visitorOf(req);
        await queueSessionOperation(sessionId, async () => {
          const checkpoint = await store.load(sessionId);
          checkpoint.messages.push({ role: 'user', content: text, at: new Date().toISOString() });
          const reply = await runTurn(checkpoint, text, visitor);
          checkpoint.messages.push({ role: 'agent', content: reply, at: new Date().toISOString() });
          await store.save(checkpoint);
        });
        return json(200, { id: sessionId });
      }
      if (path === '/api/delete' && req.method === 'POST') {
        const id = String(JSON.parse((await req.text()) || '{}').id ?? '');
        if (!ID.test(id)) return json(400, { error: 'Pick a session first.' });
        if (id.startsWith('job-')) return json(400, { error: 'A job session is the bot\'s record of that job, so it stays.' });
        if (activeTurns.has(id)) return json(409, { error: 'That session is busy right now.' });
        await store.delete(id);
        return json(200, {});
      }
      // The public result of a free-text job: what the board's poster opens to judge the work.
      if (path.startsWith('/result/') && req.method === 'GET') {
        const id = path.slice(8);
        const j = ID.test(id) ? (await store.load(`job-${id}`)).job : undefined;
        const page = (status: number, title: string, body: string) =>
          new Response(
            `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111;background:#fafaf7}h1{font-size:24px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-top:32px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #ddd;padding:12px;font:13px/1.5 ui-monospace,monospace}p.m{color:#555;font-size:14px}a{color:#0a6}</style>${body}</html>`,
            { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } },
          );
        if (!j?.result || j.kind !== 'task') return page(404, 'No result here', '<h1>No result here</h1><p>This job has no result from the bot.</p>');
        const steps = (j.result.steps ?? []).map((s) => `<pre>${escHtml(s.kind === 'run' ? `$ ${s.what}` : `${s.kind} ${s.what}`)}\n${escHtml(s.output)}</pre>`).join('');
        return page(
          200,
          `${j.title} · ${cfg.name}`,
          `<h1>${escHtml(j.title)}</h1><p class="m">Done by ${escHtml(cfg.name)} with the Flisk Wolf model${steps ? ' on a throwaway computer' : ', without a computer'}. <a href="${escHtml(j.boardUrl)}">The job on the board</a></p><h2>Answer</h2><pre>${escHtml(j.result.text ?? j.result.summary)}</pre>${steps ? `<h2>What was run</h2>${steps}` : ''}`,
        );
      }
      // The sandbox providers the bot's throwaway computers can come from, live from fleet.
      if (path === '/computers' && req.method === 'GET') {
        const rows = await fleetProviders();
        const fleet = escHtml(fleetBase);
        const list = rows?.length
          ? `<table><tr><th>Provider</th><th>From, per hour</th><th>Status</th></tr>${rows.map((r) => `<tr><td>${escHtml(r.label)}</td><td>${r.pricePerHour == null ? '-' : `$${r.pricePerHour.toFixed(3)}`}</td><td>${escHtml(r.status)}</td></tr>`).join('')}</table>`
          : '<p>fleet did not answer just now, so the list is not here. Try again in a minute.</p>';
        return new Response(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Computers · ${escHtml(cfg.name)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111;background:#fafaf7}h1{font-size:24px}p.m{color:#555;font-size:14px}a{color:#0a6}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd}th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#555}</style>` +
            `<p class="m"><a href="/">${escHtml(cfg.name)}</a></p><h1>Computers</h1><p>When a job needs something run, ${escHtml(cfg.name)} starts a throwaway computer on <a href="${fleet}">fleet</a> and deletes it when the job ends. fleet picks the cheapest of these providers that works. The list is read live from fleet.</p>${list}<p class="m"><a href="${fleet}/v1/prices">fleet's price list</a> · <a href="https://host.flisk.si/rating">which providers need no card</a></p></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" } },
        );
      }
      if (path.startsWith('/fonts/') && req.method === 'GET') {
        const b64 = FONTS[path.slice(7)];
        if (!b64) return json(404, { error: 'not_found' });
        return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), { headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' } });
      }
      if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /api/\nDisallow: /session\nDisallow: /*?\n', { headers: { 'content-type': 'text/plain' } });
      if (path === '/' && req.method === 'GET') {
        return new Response(withHeader(PAGE, cfg.boardUrl || cfg.jobsUrl), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' https://flisk.si; img-src 'self' data: https://flisk.si; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          },
        });
      }
      if (path.startsWith('/api/') && req.method === 'POST') return json(200, { error: 'The bot does not do that yet.' });

      return json(404, { error: 'not_found' });
    } catch (error) {
      console.error('[agent] request failed:', error);
      return json(500, { error: 'internal_error' });
    } finally {
      inFlight--;
    }
  }

  /** One pass of the work loop. A failed pass (the board is down, the network is out) is logged and tried again next time. */
  async function pass() {
    if (draining) return;
    // Computers left behind by a task that was cut off are deleted here, so none keeps running.
    if (brain?.computer) {
      try {
        for (const s of await store.recent(60)) {
          if (s.c.pod && !activeTurns.has(s.sessionId)) await queueSessionOperation(s.sessionId, async () => dropPod(await store.load(s.sessionId)));
        }
      } catch (e) {
        console.error('[bot] computer cleanup failed:', (e as Error).message);
      }
    }
    if (!jobs) return;
    try {
      await tick(jobs, store, queueSessionOperation, doWork, cfg.jobsPerPass, jobBrain);
      loopState.lastError = null;
    } catch (e) {
      loopState.lastError = (e as Error).message;
      console.error('[bot] pass failed:', (e as Error).message);
    }
    loopState.lastPass = new Date().toISOString();
  }

  // Only chat sessions are swept. A job-<id> session is the bot's own record of that job (the loop reads it to resume
  // an unfinished job and to never take a finished one twice), so it stays. A session with a turn in flight is never swept.
  async function sweep(now = Date.now()): Promise<number> {
    if (draining) return 0;
    try {
      const n = await store.sweep(now - idleMs, (id) => activeTurns.has(id));
      if (n > 0) console.log('[agent] swept ' + n + ' idle session(s)');
      return n;
    } catch (err) {
      console.error('[agent] idle sweep failed:', err);
      return 0;
    }
  }

  return {
    handle,
    pass,
    sweep,
    hasJobs: !!jobs,
    hasModel: !!brain,
    drain: () => {
      draining = true;
    },
    busy: () => inFlight > 0 || activeTurns.size > 0,
    inFlight: () => inFlight,
  };
}
