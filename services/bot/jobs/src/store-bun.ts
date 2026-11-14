// Bun-only adapters for the jobs board: SQLite (tests, plain processes) and the Flisk stack's Postgres.
// Kept apart from store.ts so the Cloudflare Worker bundle never imports bun or bun:sqlite.
import { Database } from 'bun:sqlite';
import { type Db, plainPostgresUrl, tables } from './store';

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
