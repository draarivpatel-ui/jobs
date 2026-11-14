// The Flisk agent contract's "files" durability: one JSON checkpoint per session in a folder. Used in a Flisk stack and
// by plain processes (Bun); the Cloudflare Worker uses the D1 store in stores.ts instead.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotStore, SessionSummary } from './stores';

// One JSON checkpoint per session, written atomically (temp file, then rename), so a kill mid-write leaves the
// previous checkpoint intact. The board key sits next to them but is not a .json file, so it is never listed.
export function fileStore(dir: string): BotStore {
  const keyFile = join(dir, 'board.key');
  const store: BotStore = {
    ready() {
      try {
        mkdirSync(dir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    },
    load(sessionId) {
      const file = join(dir, sessionId + '.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { sessionId, messages: [] };
    },
    list() {
      if (!existsSync(dir)) return [];
      // Only finished checkpoints: an in-progress write is still a .tmp file.
      return readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .flatMap((file) => {
          try {
            const stat = statSync(join(dir, file));
            return [{ sessionId: file.slice(0, -'.json'.length), lastActivity: stat.mtime.toISOString(), checkpointBytes: stat.size }];
          } catch {
            return []; // removed between the directory read and the stat
          }
        });
    },
    recent(limit) {
      const rows = (store.list() as SessionSummary[]).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, limit);
      return rows.map((s) => ({ ...s, c: store.load(s.sessionId) as Checkpoint }));
    },
    save(c) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, c.sessionId + '.json');
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, JSON.stringify(c));
      renameSync(tmp, file);
    },
    delete(sessionId) {
      try {
        unlinkSync(join(dir, sessionId + '.json'));
      } catch (err) {
        // Already gone is the goal state, so only a real failure is worth a line.
        if ((err as { code?: string }).code !== 'ENOENT') console.error('[agent] delete checkpoint failed:', err);
      }
    },
    sweep(before, busy) {
      let n = 0;
      for (const s of store.list() as SessionSummary[]) {
        if (s.sessionId.startsWith('job-') || busy(s.sessionId)) continue;
        if (new Date(s.lastActivity).getTime() >= before) continue;
        store.delete(s.sessionId);
        n++;
      }
      return n;
    },
    readKey() {
      return existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() || null : null;
    },
    writeKey(k) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(keyFile, k, { mode: 0o600 });
    },
  };
  return store;
}
