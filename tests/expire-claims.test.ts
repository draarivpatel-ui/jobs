import { expect, test } from 'bun:test';
import { CLAIM_HOURS, expireClaims } from '../src/api';
import type { Db, JobRow } from '../src/store';
import { sqliteDb } from '../src/store-bun';

const now = Date.parse('2026-11-24T10:00:00Z');
const stale = now - CLAIM_HOURS * 3600e3 - 1;
const context = (db: Db) => ({ db, now: () => now, probe: async () => 200 });

async function seedClaim(db: Db) {
  await db.run(
    "INSERT INTO jobs (id, poster, title, body, done_when, status, agent_id, created, claimed_at) VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?)",
    'job', 'poster', 'Task', 'Instructions', 'A result', 'old-agent', stale, stale,
  );
}

const expirations = (db: Db) => db.all("SELECT subject FROM events WHERE kind = 'claim_expired'");
const claim = (db: Db) => db.get<Pick<JobRow, 'status' | 'agent_id' | 'claimed_at'>>(
  "SELECT status, agent_id, claimed_at FROM jobs WHERE id = 'job'",
);

test('concurrent expiration scans record a claim expiration only once', async () => {
  const db = await sqliteDb(':memory:');
  try {
    await seedClaim(db);
    await Promise.all([expireClaims(context(db)), expireClaims(context(db))]);

    expect(await claim(db)).toEqual({ status: 'open', agent_id: null, claimed_at: null });
    expect(await expirations(db)).toEqual([{ subject: 'old-agent' }]);
  } finally {
    await db.close();
  }
});

test('an expiration scan with a stale snapshot leaves a fresh claim alone', async () => {
  const db = await sqliteDb(':memory:');
  try {
    await seedClaim(db);
    const delayedScan: Db = {
      ...db,
      all: async <T>(sql: string, ...args: unknown[]) => {
        const rows = await db.all<T>(sql, ...args);
        await expireClaims(context(db));
        await db.run("UPDATE jobs SET status = 'claimed', agent_id = ?, claimed_at = ? WHERE id = ?", 'new-agent', now, 'job');
        return rows;
      },
    };

    await expireClaims(context(delayedScan));

    expect(await claim(db)).toEqual({ status: 'claimed', agent_id: 'new-agent', claimed_at: now });
    expect(await expirations(db)).toEqual([{ subject: 'old-agent' }]);
  } finally {
    await db.close();
  }
});
