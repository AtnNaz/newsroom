import { parseFeed } from './feeds.js';
import { extractArticle, htmlToText } from './html.js';
import { fetchResource, errorCode } from './http.js';
import { analyzeArticle, embeddingText } from './analyze.js';
import { chooseCluster, toBlob, CLUSTER_WINDOW_MS } from './cluster.js';

const DAY = 24 * 3600_000;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';
const FIRST_FETCH_LIMIT = 20;
const FULL_TEXT_MIN = 1200;
export const ANALYZE_WINDOW = 7 * DAY;
const EMBED_PAUSE_MS = 15 * 60_000;
const STOP_CODES = ['model_missing', 'refused', 'dns', 'timeout', 'network', 'reset', 'tls', 'auth_failed', 'rate_limited', 'quota', 'api_key_missing', 'provider_url_missing'];

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function createPipeline({ db, settings, llm, embedder, allowPrivate = false, log = () => {} }) {
  const currentLlm = typeof llm === 'function' ? llm : () => llm;
  const net = { allowPrivate };
  const st = {
    sourceById: db.prepare('SELECT * FROM sources WHERE id = ?'),
    enabledSources: db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY id'),
    sourceOk: db.prepare('UPDATE sources SET last_fetch = ?, last_ok = ?, last_error = NULL, etag = ?, last_modified = ?, title = COALESCE(NULLIF(title, \'\'), ?), site_url = COALESCE(site_url, ?) WHERE id = ?'),
    sourceNotModified: db.prepare('UPDATE sources SET last_fetch = ?, last_ok = ?, last_error = NULL WHERE id = ?'),
    sourceFail: db.prepare('UPDATE sources SET last_fetch = ?, last_error = ? WHERE id = ?'),
    sourceCount: db.prepare('UPDATE sources SET item_count = (SELECT COUNT(*) FROM articles WHERE source_id = ?) WHERE id = ?'),
    hasGuid: db.prepare('SELECT 1 FROM articles WHERE source_id = ? AND guid = ? LIMIT 1'),
    insert: db.prepare(
      `INSERT OR IGNORE INTO articles (source_id, guid, url, title, author, image, published, fetched, feed_summary, text, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    nextExtract: db.prepare(
      `SELECT a.*, s.full_text FROM articles a JOIN sources s ON s.id = a.source_id
       WHERE a.status = 'new' ORDER BY COALESCE(a.published, a.fetched) DESC LIMIT ?`,
    ),
    extracted: db.prepare("UPDATE articles SET status = 'ready', text = ?, image = COALESCE(image, ?), published = COALESCE(published, ?), lang = ?, error = NULL, attempts = 0 WHERE id = ?"),
    extractFail: db.prepare("UPDATE articles SET attempts = attempts + 1, error = ?, status = CASE WHEN attempts + 1 >= 2 THEN 'ready' ELSE status END WHERE id = ?"),
    nextAnalyze: db.prepare(
      `SELECT a.*, s.title AS source_title FROM articles a JOIN sources s ON s.id = a.source_id
       WHERE a.status = 'ready' AND COALESCE(a.published, a.fetched) > ? ORDER BY COALESCE(a.published, a.fetched) DESC LIMIT 1`,
    ),
    analyzed: db.prepare(
      `UPDATE articles SET status = 'done', title_local = ?, summary = ?, category = ?, tags = ?, relevance = ?, reason = ?,
       analyzed_at = ?, model = ?, provider = ?, embedding = ?, error = NULL, attempts = 0 WHERE id = ?`,
    ),
    analyzeFail: db.prepare("UPDATE articles SET attempts = attempts + 1, error = ?, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END WHERE id = ?"),
    clusterCandidates: db.prepare(
      `SELECT id, title, title_local, tags, embedding, cluster_id FROM articles
       WHERE status = 'done' AND id != ? AND COALESCE(published, fetched) BETWEEN ? AND ?`,
    ),
    setCluster: db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM articles GROUP BY status'),
  };

  const state = {
    refreshing: false,
    working: false,
    lastRefresh: null,
    current: null,
    llm: { ok: null, error: null, checked: null, limited: false },
    embedPausedUntil: 0,
    started: Date.now(),
    timings: [],
  };

  async function refreshSource(source, now = Date.now()) {
    const conditional = {};
    if (source.etag) conditional['If-None-Match'] = source.etag;
    if (source.last_modified) conditional['If-Modified-Since'] = source.last_modified;
    try {
      const res = await fetchResource(source.url, { ...net, headers: conditional, accept: FEED_ACCEPT, maxBytes: 8_000_000, timeoutMs: 45_000 });
      if (res.status === 304) {
        st.sourceNotModified.run(now, now, source.id);
        return { added: 0, notModified: true };
      }
      const feed = parseFeed(res.body, res.url);
      const retention = settings.get('retentionDays') * DAY;
      let items = feed.items.filter((i) => !i.published || i.published > now - retention);
      if (!source.last_ok) items = items.sort((a, b) => (b.published ?? 0) - (a.published ?? 0)).slice(0, FIRST_FETCH_LIMIT);
      let added = 0;
      db.exec('BEGIN');
      try {
        for (const item of items) {
          if (item.guid && st.hasGuid.get(source.id, item.guid)) continue;
          const text = htmlToText(item.content || item.summary).slice(0, 50_000);
          const status = source.full_text && text.length < FULL_TEXT_MIN ? 'new' : 'ready';
          const published = item.published ? Math.min(item.published, now) : null;
          const r = st.insert.run(source.id, item.guid ?? null, item.url, item.title, item.author, item.image, published, now, item.summary || null, text || null, status);
          added += Number(r.changes);
        }
        st.sourceOk.run(now, now, res.headers.get('etag'), res.headers.get('last-modified'), feed.title || null, feed.link || null, source.id);
        st.sourceCount.run(source.id, source.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { added };
    } catch (err) {
      const code = errorCode(err);
      st.sourceFail.run(now, code, source.id);
      log(`kaynak ${source.id} indirilemedi: ${code}`);
      return { added: 0, error: code };
    }
  }

  async function refreshAll() {
    if (state.refreshing) return { skipped: true };
    state.refreshing = true;
    let added = 0;
    try {
      await mapLimit(st.enabledSources.all(), 4, async (s) => {
        added += (await refreshSource(s)).added;
      });
      state.lastRefresh = Date.now();
    } finally {
      state.refreshing = false;
    }
    return { added };
  }

  async function extractOne(a) {
    try {
      const res = await fetchResource(a.url, { ...net, accept: 'text/html,application/xhtml+xml', maxBytes: 4_000_000, timeoutMs: 40_000 });
      const page = extractArticle(res.body, res.url);
      const text = page.text.length > (a.text?.length ?? 0) ? page.text : a.text;
      st.extracted.run(text?.slice(0, 50_000) ?? null, page.image, page.published, page.lang, a.id);
    } catch (err) {
      st.extractFail.run(errorCode(err), a.id);
    }
  }

  async function extractPending() {
    for (;;) {
      const batch = st.nextExtract.all(16);
      if (!batch.length) return;
      await mapLimit(batch, 4, extractOne);
    }
  }

  function assignCluster(id, publishedOrFetched) {
    const row = db.prepare('SELECT id, title, title_local, tags, embedding FROM articles WHERE id = ?').get(id);
    const candidates = st.clusterCandidates.all(id, publishedOrFetched - CLUSTER_WINDOW_MS, publishedOrFetched + CLUSTER_WINDOW_MS);
    st.setCluster.run(chooseCluster(row, candidates), id);
  }

  async function analyzeOne(a, s) {
    const startedAt = Date.now();
    const result = await analyzeArticle(currentLlm(), a, s);
    let embedding = null;
    if (s.embedModel && embedder && Date.now() >= state.embedPausedUntil) {
      try {
        embedding = toBlob(await embedder.embed({ model: s.embedModel, gpu: Boolean(s.embedOnGpu), input: embeddingText({ ...a, title_local: result.title, summary: result.summary }) }));
      } catch (err) {
        const code = errorCode(err);
        state.embedPausedUntil = Date.now() + EMBED_PAUSE_MS;
        log(`gömme alınamadı (${code}); benzerlik modeli 15 dakika atlanacak, kümeleme başlıklarla sürüyor`);
      }
    }
    st.analyzed.run(result.title, result.summary, result.category, JSON.stringify(result.tags), result.relevance, result.reason, Date.now(), s.model, s.provider ?? 'ollama', embedding, a.id);
    assignCluster(a.id, a.published ?? a.fetched);
    state.timings.push(Date.now() - startedAt);
    if (state.timings.length > 50) state.timings.shift();
  }

  function analyzedToday(provider) {
    return db.prepare('SELECT COUNT(*) AS n FROM articles WHERE provider = ? AND analyzed_at > ?').get(provider, Date.now() - DAY).n;
  }

  async function analyzePending({ limit = Infinity } = {}) {
    let done = 0;
    while (done < limit) {
      const s = settings.all();
      if (!s.model) return done;
      if ((s.provider ?? 'ollama') !== 'ollama' && s.dailyLimit > 0 && analyzedToday(s.provider) >= s.dailyLimit) {
        state.llm = { ...state.llm, limited: true };
        return done;
      }
      state.llm.limited = false;
      const a = st.nextAnalyze.get(Date.now() - ANALYZE_WINDOW);
      if (!a) return done;
      state.current = { id: a.id, title: a.title };
      try {
        await analyzeOne(a, s);
        state.llm = { ok: true, error: null, checked: Date.now(), limited: false };
        done++;
      } catch (err) {
        const code = errorCode(err);
        if (STOP_CODES.includes(code) || /^(ollama|llm)_http_5/.test(code)) {
          state.llm = { ok: false, error: code, checked: Date.now(), limited: false };
          log(`yapay zekâ: ${code}`);
          return done;
        }
        st.analyzeFail.run(code, a.id);
      } finally {
        state.current = null;
      }
    }
    return done;
  }

  async function work() {
    if (state.working) return false;
    state.working = true;
    try {
      await extractPending();
      await analyzePending();
    } finally {
      state.working = false;
    }
    return true;
  }

  function requeue(sinceMs) {
    const r = db.prepare("UPDATE articles SET status = 'ready', attempts = 0 WHERE status IN ('done', 'failed') AND COALESCE(published, fetched) > ?").run(Date.now() - sinceMs);
    return Number(r.changes);
  }

  function cleanup(now = Date.now()) {
    const days = settings.get('retentionDays');
    const r = db.prepare('DELETE FROM articles WHERE saved = 0 AND fetched < ?').run(now - days * DAY);
    db.prepare('UPDATE sources SET item_count = (SELECT COUNT(*) FROM articles WHERE source_id = sources.id)').run();
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    return Number(r.changes);
  }

  function queue() {
    const out = { new: 0, ready: 0, done: 0, failed: 0 };
    for (const r of st.counts.all()) out[r.status] = r.n;
    return out;
  }

  return { state, refreshSource, refreshAll, extractPending, analyzePending, work, requeue, cleanup, queue, sourceById: (id) => st.sourceById.get(id) };
}
