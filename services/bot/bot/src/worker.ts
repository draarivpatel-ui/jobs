// Flisk Bot as a Cloudflare Worker (bot.flisk.si): the same app as index.ts, sessions in D1. A Worker cannot keep a
// timer, so a cron trigger runs one pass of the work loop and the idle sweep.
import { createBot } from './app';
import { d1Store, type D1Like } from './stores';

interface Env {
  DB: D1Like;
  JOBS_URL: string;
  JOBS_PUBLIC_URL?: string;
  BOT_NAME?: string;
  BOT_HOMEPAGE?: string;
  SESSION_IDLE_TIMEOUT_MS?: string;
}

const bots = new WeakMap<object, ReturnType<typeof createBot>>();
function botFor(env: Env) {
  let b = bots.get(env);
  if (!b) {
    const jobsUrl = (env.JOBS_URL || '').replace(/\/+$/, '');
    b = createBot(
      {
        name: env.BOT_NAME || 'Flisk Bot',
        boardUrl: (env.JOBS_PUBLIC_URL || jobsUrl).replace(/\/+$/, ''),
        jobsUrl,
        homepage: env.BOT_HOMEPAGE,
        idleTimeoutMs: Number(env.SESSION_IDLE_TIMEOUT_MS) || 86_400_000,
        durability: 'd1',
        // Workers Free allows 50 subrequests per run; a job costs about 6, so three leaves room for resuming others.
        jobsPerPass: 3,
      },
      d1Store(env.DB),
    );
    bots.set(env, b);
  }
  return b;
}

export default {
  fetch: (req: Request, env: Env) => botFor(env).handle(req),
  async scheduled(_event: unknown, env: Env) {
    const bot = botFor(env);
    await bot.pass();
    await bot.sweep();
  },
};
