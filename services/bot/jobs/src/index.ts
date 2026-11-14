import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { handle } from './app';
import { makeProbe } from './api';
import { postgresDb, sqliteDb } from './store-bun';

const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : 4001;
// The address agents use to reach this board; llms.txt prints it.
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

// In a Flisk stack the board keeps its record in the project Postgres (DATABASE_URL), which survives restarts and
// rebuilds. Without it, a SQLite file: fine for a quick local run, gone when the container is recreated.
async function open() {
  if (process.env.DATABASE_URL) return { db: await postgresDb(process.env.DATABASE_URL), where: 'postgres' };
  const path = process.env.JOBS_DB || './data/jobs.db';
  mkdirSync(dirname(path), { recursive: true });
  return { db: await sqliteDb(path), where: `sqlite ${path}` };
}

const { db, where } = await open();
const ctx = { db, now: () => Date.now(), probe: makeProbe(fetch) };

const server = Bun.serve({ port: PORT, hostname: '0.0.0.0', fetch: (req) => handle(req, ctx, ORIGIN) });
console.log(`\n📋 jobs board on http://localhost:${server.port} (record in ${where})`);

process.on('SIGTERM', async () => {
  server.stop();
  await db.close();
  process.exit(0);
});
