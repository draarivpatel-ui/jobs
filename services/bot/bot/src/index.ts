import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jobsClient, tick, TERMINAL, type Checkpoint } from './jobs';
import { doWork, parseAsk } from './work';
import { page, overview } from './ui';

// Contract with Flisk (see docs/agents/ai-agents.md):
//   AGENT_DURABILITY  files   (set by flisk from service.json agent.durability)
//   AGENT_STATE_DIR   where files-durability checkpoints live (a named volume that survives flisk down)
//   PORT              port to listen on
// /health: the process is alive. /ready: the checkpoint store is reachable. Idle is healthy, so /health never checks the store.
//
// Flisk Bot adds a work loop on the open jobs board (JOBS_URL): one job is one session, saved after every step.

const DURABILITY = 'files';
const STATE_DIR = process.env.AGENT_STATE_DIR || join(process.cwd(), '.agent-state');
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 3000;
const DRAIN_TIMEOUT_MS = 10_000;
const JOBS_URL = (process.env.JOBS_URL || '').replace(/\/+$/, '');
const BOARD_URL = (process.env.JOBS_PUBLIC_URL || JOBS_URL).replace(/\/+$/, '');
const POLL_MS = Math.max(5, Number(process.env.BOT_POLL_SECONDS) || 15) * 1000;
const BOT_NAME = process.env.BOT_NAME || 'Flisk Bot';

interface SessionSummary {
  sessionId: string;
  lastActivity: string;
  checkpointBytes: number;
}

// Session store. files: one JSON checkpoint per session, written atomically (temp file, then rename), so a kill
// mid-write leaves the previous checkpoint intact.
const store = {
  ready(): boolean {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
  load(sessionId: string): Checkpoint {
    const file = join(STATE_DIR, sessionId + '.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { sessionId, messages: [] };
  },
  list(): SessionSummary[] {
    if (!existsSync(STATE_DIR)) return [];
    return readdirSync(STATE_DIR)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        try {
          const stat = statSync(join(STATE_DIR, file));
          return [{ sessionId: file.slice(0, -'.json'.length), lastActivity: stat.mtime.toISOString(), checkpointBytes: stat.size }];
        } catch {
          return [];
        }
      });
  },
  save(checkpoint: Checkpoint): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const file = join(STATE_DIR, checkpoint.sessionId + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(checkpoint));
    renameSync(tmp, file);
  },
};

// The board key lives next to the checkpoints (same volume), but not as a .json file, so it is never listed as a session.
const KEY_FILE = join(STATE_DIR, 'board.key');
const jobs = JOBS_URL
  ? jobsClient(JOBS_URL, BOT_NAME, () => (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() || null : null), (k) => {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(KEY_FILE, k, { mode: 0o600 });
    })
  : null;

const HELP = `I am ${BOT_NAME}. I do two kinds of work, with Flisk's own tools and no model, so the same input always gives the same answer:
• Send a GitHub repo (owner/name) and I score its README with README Score.
• Send an https:// address and I check whether AI search can find and cite it, with Citable.
I also take these jobs from the open jobs board by myself. Each job gets its own session here, saved after every step.`;

// A turn in a chat session: check a repo or a page right now. In a job session: say where the job stands.
async function runTurn(checkpoint: Checkpoint, input: string): Promise<string> {
  const j = checkpoint.job;
  if (j) {
    const link = `${BOARD_URL}/job/${j.id}`;
    return `This session is the job "${j.title}" (${j.kind}). Step: ${j.step}${TERMINAL.includes(j.step) ? ' (finished)' : ''}.${j.result ? `\nResult: ${j.result.summary} ${j.result.url}` : ''}\nIts public record: ${link}`;
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

let draining = false;
let inFlight = 0;
const activeTurns = new Map<string, number>();
const sessionOperationQueues = new Map<string, Promise<void>>();
const SESSION_LIST_LIMIT = 500;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_000) throw new SyntaxError('too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function queueSessionOperation(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const currentQueue = sessionOperationQueues.get(sessionId) ?? Promise.resolve();
  const run = currentQueue.then(async () => {
    activeTurns.set(sessionId, (activeTurns.get(sessionId) ?? 0) + 1);
    try {
      await operation();
    } finally {
      const left = (activeTurns.get(sessionId) ?? 1) - 1;
      if (left > 0) activeTurns.set(sessionId, left);
      else activeTurns.delete(sessionId);
    }
  });
  sessionOperationQueues.set(sessionId, run.catch(() => {}));
  return run;
}

const server = createServer(async (req, res) => {
  inFlight++;
  res.on('close', () => inFlight--);
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }

  try {
    if (url.pathname === '/health') return sendJson(res, 200, { status: 'ok', service: 'bot', draining });

    if (url.pathname === '/ready') {
      const ok = !draining && store.ready();
      return sendJson(res, ok ? 200 : 503, { ready: ok, durability: DURABILITY });
    }

    if (url.pathname === '/turn' && req.method === 'POST') {
      if (draining) return sendJson(res, 503, { error: 'draining' });
      const sessionId = String(req.headers['x-session-id'] ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        return sendJson(res, 400, { error: 'x-session-id header is required (1-128 letters, digits, - or _)' });
      }
      let body: any;
      try {
        body = await readJson(req);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return sendJson(res, 400, { error: 'invalid_json' });
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid_json' });
      if (typeof body.input !== 'string' || body.input.length === 0 || body.input.length > 2000) {
        return sendJson(res, 400, { error: 'input_required', hint: 'send {"input": "..."} (up to 2000 characters)' });
      }
      const input: string = body.input;
      return await queueSessionOperation(sessionId, async () => {
        const checkpoint = store.load(sessionId);
        checkpoint.messages.push({ role: 'user', content: input, at: new Date().toISOString() });
        const reply = await runTurn(checkpoint, input);
        checkpoint.messages.push({ role: 'agent', content: reply, at: new Date().toISOString() });
        store.save(checkpoint);
        sendJson(res, 200, { sessionId, reply, turns: checkpoint.messages.filter((m) => m.role === 'user').length });
      });
    }

    if (url.pathname === '/session' && req.method === 'GET') {
      const sessionId = String(req.headers['x-session-id'] ?? url.searchParams.get('id') ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return sendJson(res, 400, { error: 'x-session-id header is required' });
      const checkpoint = store.load(sessionId);
      return sendJson(res, 200, { ...checkpoint, turns: checkpoint.messages.filter((m) => m.role === 'user').length, status: activeTurns.has(sessionId) ? 'active' : 'idle' });
    }

    if (url.pathname === '/sessions' && req.method === 'GET') {
      const all = store.list().sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      const sessions = all.slice(0, SESSION_LIST_LIMIT).map((s) => ({ ...s, status: activeTurns.has(s.sessionId) ? 'active' : 'idle' }));
      return sendJson(res, 200, { sessions, total: all.length });
    }

    // The web view (bot.flisk.si): the same sessions, drawn like the Run My Agents app.
    if (url.pathname === '/api/overview' && req.method === 'GET') {
      const list = store.list().sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, 200);
      return sendJson(res, 200, overview(list.map((s) => ({ ...s, c: store.load(s.sessionId), active: activeTurns.has(s.sessionId) })), { name: BOT_NAME, board: BOARD_URL, loop: loopState }));
    }
    if (url.pathname === '/' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
      return res.end(page(BOT_NAME, String(req.headers['x-forwarded-prefix'] ?? '')));
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[agent] request failed:', error);
    if (!res.headersSent) return sendJson(res, 500, { error: 'internal_error' });
  }
});

// The work loop. A failed pass (the board is down, the network is out) is logged and tried again next time.
const loopState = { enabled: !!jobs, lastPass: null as string | null, lastError: null as string | null };
async function loop() {
  if (!jobs || draining) return;
  try {
    await tick(jobs, store, queueSessionOperation);
    loopState.lastError = null;
  } catch (e) {
    loopState.lastError = (e as Error).message;
    console.error('[bot] pass failed:', (e as Error).message);
  }
  loopState.lastPass = new Date().toISOString();
  if (!draining) setTimeout(loop, POLL_MS);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🤖 bot agent on http://localhost:' + PORT + ' (durability: ' + DURABILITY + ')' + (jobs ? ', taking jobs from ' + JOBS_URL : ', no JOBS_URL: chat only'));
  setTimeout(loop, 1000);
});

function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  console.log('[agent] ' + signal + ' received, draining ' + inFlight + ' in-flight request(s)');
  server.close();
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const timer = setInterval(() => {
    if ((inFlight === 0 && activeTurns.size === 0) || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 100);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
