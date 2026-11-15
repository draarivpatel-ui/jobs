// Flisk Bot under Bun: a Flisk stack (service.json, durability "files") or plain processes (scripts/pod-run.sh).
// The bot itself is in app.ts; the same code runs as a Cloudflare Worker from worker.ts.
//
// Settings from Flisk: AGENT_DURABILITY=files, AGENT_STATE_DIR (a named volume that survives flisk down), PORT.
import { join } from 'node:path';
import { createBot } from './app';
import { fleetComputer, wolfModel } from './brain';
import { fileStore } from './file-store';

const STATE_DIR = process.env.AGENT_STATE_DIR || join(process.cwd(), '.agent-state');
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 3000;
const DRAIN_TIMEOUT_MS = 10_000;
const JOBS_URL = (process.env.JOBS_URL || '').replace(/\/+$/, '');
const POLL_MS = Math.max(5, Number(process.env.BOT_POLL_SECONDS) || 15) * 1000;
// Same settings as the Flisk agent scaffold. A malformed override falls back to the default (a NaN would switch the
// sweep off silently).
const SESSION_IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_TIMEOUT_MS) || 86_400_000;
const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 3_600_000;

const bot = createBot(
  {
    name: process.env.BOT_NAME || 'Flisk Bot',
    boardUrl: (process.env.JOBS_PUBLIC_URL || JOBS_URL).replace(/\/+$/, ''),
    jobsUrl: JOBS_URL,
    homepage: process.env.BOT_HOMEPAGE,
    fleetUrl: process.env.FLEET_URL,
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    // INFERENCE_KEY set: answer with the Flisk Wolf model. FLEET_KEY set as well: run tasks on a fleet computer.
    brain: process.env.INFERENCE_KEY
      ? {
          model: wolfModel({ key: process.env.INFERENCE_KEY, url: process.env.INFERENCE_URL, model: process.env.INFERENCE_MODEL }),
          computer: process.env.FLEET_KEY ? fleetComputer({ key: process.env.FLEET_KEY, url: process.env.FLEET_URL, login: process.env.FLEET_LOGIN }) : null,
          modelCallsPerDay: Number(process.env.MODEL_CALLS_PER_DAY) || undefined,
          computerTasksPerDay: Number(process.env.COMPUTER_TASKS_PER_DAY) || undefined,
          visitorMessagesPerDay: Number(process.env.VISITOR_MESSAGES_PER_DAY) || undefined,
        }
      : undefined,
  },
  fileStore(STATE_DIR),
);

let draining = false;
const server = Bun.serve({ port: PORT, hostname: '0.0.0.0', idleTimeout: 60, fetch: (req) => bot.handle(req) });

async function loop() {
  if (draining) return;
  await bot.pass();
  if (!draining) setTimeout(loop, POLL_MS);
}

console.log('\n🤖 bot agent on http://localhost:' + server.port + ' (durability: files)' + (bot.hasJobs ? ', taking jobs from ' + JOBS_URL : ', no JOBS_URL: chat only') + (bot.hasModel ? ', model on' : ', no model'));
if (bot.hasJobs) setTimeout(loop, 1000);
// unref: a scheduled sweep must never be the reason the process stays alive.
const sweepTimer = setInterval(() => bot.sweep(), SESSION_CLEANUP_INTERVAL_MS);
sweepTimer.unref();

// Drain on SIGTERM (flisk down, hot reload, docker stop): stop taking turns, let in-flight turns finish, then exit 0.
// Checkpoints are written before a turn is answered, so a drained exit loses no acknowledged turn.
function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  bot.drain();
  clearInterval(sweepTimer);
  console.log('[agent] ' + signal + ' received, draining ' + bot.inFlight() + ' in-flight request(s)');
  server.stop();
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const timer = setInterval(() => {
    if (!bot.busy() || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 100);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
