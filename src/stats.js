import { statSync } from 'node:fs';
import { ANALYZE_WINDOW } from './pipeline.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const fileSize = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

export function collectStats({ db, settings, pipeline, dbFile, now = Date.now() }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const s = settings.all();
  const queue = pipeline.queue();
  const pending = one("SELECT COUNT(*) AS n FROM articles WHERE status IN ('new', 'ready') AND COALESCE(published, fetched) > ?", now - ANALYZE_WINDOW);
  const timings = pipeline.state.timings;
  const avgMs = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;
  const lastHour = one("SELECT COUNT(*) AS n FROM articles WHERE status = 'done' AND analyzed_at > ?", now - HOUR);
  const remote = s.provider !== 'ollama';
  const analyzedToday = one('SELECT COUNT(*) AS n FROM articles WHERE provider = ? AND analyzed_at > ?', s.provider, now - DAY);
  const digest = db.prepare('SELECT day, created, emailed_at, email_error FROM digests ORDER BY day DESC LIMIT 1').get();
  const buckets = [
    [0, 19],
    [20, 49],
    [50, 79],
    [80, 100],
  ].map(([lo, hi]) => ({ from: lo, to: hi, n: one("SELECT COUNT(*) AS n FROM articles WHERE status = 'done' AND analyzed_at > ? AND relevance BETWEEN ? AND ?", now - DAY, lo, hi) }));

  return {
    generated: now,
    uptime: Math.round((now - pipeline.state.started) / 1000),
    queue,
    pending,
    stale: queue.new + queue.ready - pending,
    analyzed: { lastHour, last24h: one("SELECT COUNT(*) AS n FROM articles WHERE status = 'done' AND analyzed_at > ?", now - DAY), total: queue.done },
    fetched: { lastHour: one('SELECT COUNT(*) AS n FROM articles WHERE fetched > ?', now - HOUR), last24h: one('SELECT COUNT(*) AS n FROM articles WHERE fetched > ?', now - DAY) },
    speed: { avgSeconds: avgMs == null ? null : Math.round(avgMs / 100) / 10, samples: timings.length },
    eta: s.model && avgMs != null && pending ? Math.round((pending * avgMs) / 1000) : null,
    llm: {
      provider: s.provider,
      model: s.model,
      embedModel: s.embedModel,
      ok: pipeline.state.llm.ok,
      error: pipeline.state.llm.error,
      limited: pipeline.state.llm.limited,
      analyzedToday,
      dailyLimit: remote ? s.dailyLimit : 0,
      current: pipeline.state.current,
      embedPaused: pipeline.state.embedPausedUntil > now,
    },
    embedded24h: one("SELECT COUNT(*) AS n FROM articles WHERE status = 'done' AND analyzed_at > ? AND embedding IS NOT NULL", now - DAY),
    multiSource24h: one('SELECT COUNT(*) AS n FROM (SELECT cluster_id FROM articles WHERE cluster_id IS NOT NULL AND COALESCE(published, fetched) > ? GROUP BY cluster_id HAVING COUNT(*) > 1)', now - DAY),
    categories: all("SELECT category, COUNT(*) AS n FROM articles WHERE status = 'done' AND analyzed_at > ? AND category IS NOT NULL GROUP BY category ORDER BY n DESC", now - DAY),
    relevance: buckets,
    sources: {
      total: one('SELECT COUNT(*) AS n FROM sources'),
      enabled: one('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1'),
      failing: all('SELECT id, title, url, last_error AS error, last_ok AS lastOk FROM sources WHERE enabled = 1 AND last_error IS NOT NULL ORDER BY title COLLATE NOCASE'),
      top: all('SELECT s.id, s.title, COUNT(a.id) AS n FROM sources s JOIN articles a ON a.source_id = s.id WHERE a.fetched > ? GROUP BY s.id ORDER BY n DESC LIMIT 8', now - DAY),
    },
    errors: all("SELECT error, COUNT(*) AS n FROM articles WHERE error IS NOT NULL AND fetched > ? GROUP BY error ORDER BY n DESC LIMIT 8", now - 7 * DAY),
    digest: digest ? { day: digest.day, created: digest.created, emailedAt: digest.emailed_at, emailError: digest.email_error } : null,
    storage: {
      articles: one('SELECT COUNT(*) AS n FROM articles'),
      saved: one('SELECT COUNT(*) AS n FROM articles WHERE saved = 1'),
      digests: one('SELECT COUNT(*) AS n FROM digests'),
      bytes: dbFile ? fileSize(dbFile) + fileSize(`${dbFile}-wal`) : 0,
    },
  };
}
