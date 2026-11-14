// The bot as one object: the Flisk agent contract over Request/Response, the web view, the work loop and the idle
// sweep. index.ts runs it under Bun (Flisk stack, plain processes) and worker.ts as a Cloudflare Worker.
//
// Contract with Flisk (see docs/agents/ai-agents.md): /health is the process alive, /ready is the checkpoint store
// reachable, POST /turn with x-session-id, GET/DELETE /session, GET /sessions. Idle is healthy, so /health never
// checks the store.
import { jobsClient, tick, TERMINAL, type Checkpoint, type JobsClient } from './jobs';
import type { BotStore } from './stores';
import { doWork, parseAsk } from './work';
import { boardOptions, boardSessions, withHeader } from './rma';
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
  idleTimeoutMs?: number;
  durability?: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_LIST_LIMIT = 500;

export function createBot(cfg: BotConfig, store: BotStore, f: typeof fetch = fetch) {
  const idleMs = cfg.idleTimeoutMs || 86_400_000;
  const durability = cfg.durability || 'files';
  const jobs: JobsClient | null = cfg.jobsUrl ? jobsClient(cfg.jobsUrl, cfg.name, () => store.readKey(), (k) => store.writeKey(k), f, cfg.homepage) : null;
  const loopState = { enabled: !!jobs, lastPass: null as string | null, lastError: null as string | null };
  const activeTurns = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  let draining = false;
  let inFlight = 0;

  const HELP = `I am ${cfg.name}. I do two kinds of work, with Flisk's own tools and no model, so the same input always gives the same answer:
• Send a GitHub repo (owner/name) and I score its README with README Score.
• Send an https:// address and I check whether AI search can find and cite it, with Citable.
I also take these jobs from the open jobs board by myself. Each job gets its own session here, saved after every step.`;

  // A turn in a chat session: check a repo or a page right now. In a job session: say where the job stands.
  async function runTurn(checkpoint: Checkpoint, input: string): Promise<string> {
    const j = checkpoint.job;
    if (j) {
      return `This session is the job "${j.title}" (${j.kind}). Step: ${j.step}${TERMINAL.includes(j.step) ? ' (finished)' : ''}.${j.result ? `\nResult: ${j.result.summary} ${j.result.url}` : ''}\nIts public record: ${cfg.boardUrl}/job/${j.id}`;
    }
    const ask = parseAsk(input);
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
        return await queueSessionOperation(sessionId, async () => {
          const checkpoint = await store.load(sessionId);
          checkpoint.messages.push({ role: 'user', content: input, at: new Date().toISOString() });
          const reply = await runTurn(checkpoint, input);
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
      if ((path === '/api/tasks' || path === '/api/kitchen') && req.method === 'GET') return json(200, { tasks: [], lanes: [] });
      if ((path === '/api/send' || path === '/api/new') && req.method === 'POST') {
        let body: any = {};
        try {
          body = JSON.parse((await req.text()) || '{}');
        } catch {}
        const text = String(body.text ?? '').trim();
        if (!text) return json(400, { error: 'Type a repo (owner/name) or an https:// address first.' });
        if (text.length > 2000) return json(400, { error: 'That message is too long.' });
        const sessionId = path === '/api/new' ? 'chat-' + crypto.randomUUID().slice(0, 8) : String(body.id ?? '');
        if (!ID.test(sessionId)) return json(400, { error: 'Pick a session first.' });
        await queueSessionOperation(sessionId, async () => {
          const checkpoint = await store.load(sessionId);
          checkpoint.messages.push({ role: 'user', content: text, at: new Date().toISOString() });
          const reply = await runTurn(checkpoint, text);
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
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    if (!jobs || draining) return;
    try {
      await tick(jobs, store, queueSessionOperation, doWork, cfg.jobsPerPass);
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
    drain: () => {
      draining = true;
    },
    busy: () => inFlight > 0 || activeTurns.size > 0,
    inFlight: () => inFlight,
  };
}
