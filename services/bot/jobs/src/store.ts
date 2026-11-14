// The jobs board's record: agents, jobs and an append-only event log.
//
// One small async interface (get, all, run) over three stores: SQLite for tests, the project Postgres in a Flisk
// stack (DATABASE_URL), and Cloudflare D1 later. The SQL is written once with ? placeholders; the Postgres adapter
// numbers them. Every change to a job writes an event, and events are never edited or deleted.
import { Database } from 'bun:sqlite';

export interface Db {
  get<T>(sql: string, ...args: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  run(sql: string, ...args: unknown[]): Promise<{ changes: number }>;
  close(): Promise<void>;
}

// Times are milliseconds since 1970. Postgres keeps them as DOUBLE PRECISION so they come back as plain numbers.
const tables = (t: { time: string; serial: string; real: string }) => [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, about TEXT, key_hash TEXT NOT NULL UNIQUE, created ${t.time} NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, poster TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, done_when TEXT NOT NULL,
    kind TEXT, input TEXT, price_usd ${t.real}, auto_accept INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
    agent_id TEXT, created ${t.time} NOT NULL, claimed_at ${t.time}, submitted_at ${t.time}, closed_at ${t.time},
    result_url TEXT, result_note TEXT)`,
  'CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created)',
  'CREATE INDEX IF NOT EXISTS jobs_agent ON jobs (agent_id)',
  `CREATE TABLE IF NOT EXISTS events (
    id ${t.serial}, job_id TEXT NOT NULL, at ${t.time} NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, note TEXT)`,
  'CREATE INDEX IF NOT EXISTS events_job ON events (job_id, id)',
];

export async function sqliteDb(path: string): Promise<Db> {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  for (const s of tables({ time: 'INTEGER', serial: 'INTEGER PRIMARY KEY AUTOINCREMENT', real: 'REAL' })) db.exec(s);
  return {
    get: async <T>(sql: string, ...a: unknown[]) => (db.query(sql).get(...(a as never[])) as T) ?? null,
    all: async <T>(sql: string, ...a: unknown[]) => db.query(sql).all(...(a as never[])) as T[],
    run: async (sql: string, ...a: unknown[]) => ({ changes: db.query(sql).run(...(a as never[])).changes }),
    close: async () => db.close(),
  };
}

/**
 * Flisk's DATABASE_URL ends in ?schema=public, Prisma's convention. Plain Postgres clients send unknown URL
 * parameters to the server as settings, and Postgres refuses "schema", so take it out and keep it as the search path.
 */
export function plainPostgresUrl(url: string): { url: string; schema: string | null } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema');
  u.searchParams.delete('schema');
  return { url: u.toString(), schema: schema && /^[a-z_][a-z0-9_]*$/i.test(schema) ? schema : null };
}

export async function postgresDb(raw: string): Promise<Db> {
  const { SQL } = await import('bun');
  const { url, schema } = plainPostgresUrl(raw);
  const pg = new SQL(url);
  if (schema) await pg.unsafe(`SET search_path TO "${schema}"`);
  const numbered = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  for (const s of tables({ time: 'DOUBLE PRECISION', serial: 'SERIAL PRIMARY KEY', real: 'DOUBLE PRECISION' })) await pg.unsafe(s);
  return {
    get: async <T>(sql: string, ...a: unknown[]) => ((await pg.unsafe(numbered(sql), a as never[]))[0] as T) ?? null,
    all: async <T>(sql: string, ...a: unknown[]) => [...(await pg.unsafe(numbered(sql), a as never[]))] as T[],
    run: async (sql: string, ...a: unknown[]) => ({ changes: Number((await pg.unsafe(numbered(sql), a as never[])).count ?? 0) }),
    close: async () => pg.close(),
  };
}

export type Status = 'open' | 'claimed' | 'submitted' | 'accepted' | 'cancelled';

export interface AgentRow {
  id: string;
  name: string;
  homepage: string | null;
  about: string | null;
  created: number;
}

export interface JobRow {
  id: string;
  poster: string;
  title: string;
  body: string;
  done_when: string;
  kind: string | null;
  input: string | null;
  price_usd: number | null;
  auto_accept: number;
  status: Status;
  agent_id: string | null;
  created: number;
  claimed_at: number | null;
  submitted_at: number | null;
  closed_at: number | null;
  result_url: string | null;
  result_note: string | null;
}

export interface EventRow {
  id: number;
  job_id: string;
  at: number;
  kind: string;
  actor: string;
  note: string | null;
}
