import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  site_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  full_text INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL,
  last_fetch INTEGER,
  last_ok INTEGER,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  item_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid TEXT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT,
  image TEXT,
  published INTEGER,
  fetched INTEGER NOT NULL,
  feed_summary TEXT,
  text TEXT,
  lang TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  title_local TEXT,
  summary TEXT,
  category TEXT,
  tags TEXT,
  relevance INTEGER,
  reason TEXT,
  analyzed_at INTEGER,
  model TEXT,
  embedding BLOB,
  cluster_id INTEGER,
  feedback INTEGER NOT NULL DEFAULT 0,
  saved INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS articles_saved ON articles(saved) WHERE saved = 1;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS articles_time ON articles(fetched);
CREATE INDEX IF NOT EXISTS articles_cluster ON articles(cluster_id);
CREATE INDEX IF NOT EXISTS articles_guid ON articles(source_id, guid);
CREATE TABLE IF NOT EXISTS digests (
  day TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  model TEXT,
  intro TEXT,
  sections TEXT NOT NULL,
  emailed_at INTEGER,
  email_error TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(file) {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const fresh = file === ':memory:' || !existsSync(file);
  const db = new DatabaseSync(file);
  if (fresh && file !== ':memory:') chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const columns = db.prepare('PRAGMA table_info(articles)').all().map((c) => c.name);
  if (!columns.includes('provider')) db.exec('ALTER TABLE articles ADD COLUMN provider TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS articles_analyzed ON articles(analyzed_at)');
  return db;
}

export function createSettings(db, defaults) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    all() {
      const out = structuredClone(defaults);
      for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        if (Object.hasOwn(defaults, row.key)) {
          try {
            out[row.key] = JSON.parse(row.value);
          } catch {}
        }
      }
      return out;
    },
    get(key) {
      const row = get.get(key);
      if (!row) return structuredClone(defaults[key]);
      try {
        return JSON.parse(row.value);
      } catch {
        return structuredClone(defaults[key]);
      }
    },
    update(patch) {
      db.exec('BEGIN');
      try {
        for (const [k, v] of Object.entries(patch)) set.run(k, JSON.stringify(v));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
