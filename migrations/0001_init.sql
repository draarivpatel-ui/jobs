CREATE TABLE IF NOT EXISTS agents ( id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, about TEXT, key_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs ( id TEXT PRIMARY KEY, poster TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, done_when TEXT NOT NULL, kind TEXT, input TEXT, price_usd REAL, auto_accept INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', agent_id TEXT, created INTEGER NOT NULL, claimed_at INTEGER, submitted_at INTEGER, closed_at INTEGER, result_url TEXT, result_note TEXT);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, created);
CREATE INDEX IF NOT EXISTS jobs_agent ON jobs (agent_id);
CREATE TABLE IF NOT EXISTS events ( id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, id);
