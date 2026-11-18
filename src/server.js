import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COOKIE } from './auth.js';
import { validateSettings, publicSettings, CATEGORIES } from './settings.js';
import { loadAffinity, groupClusters, scoreParts } from './rank.js';
import { getDigest, listDigests, localDay } from './digest.js';
import { addSource, exportOpml, importOpml, SUGGESTIONS } from './sources.js';
import { sendTestEmail } from './mail.js';
import { errorCode } from './http.js';
import { collectStats } from './stats.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const DAY = 86400_000;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const httpError = (status, code) => Object.assign(new Error(code), { status, code });

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(data);
}

async function readJson(req, limit = 2_000_000) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw httpError(415, 'json_required');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, 'too_large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw httpError(400, 'bad_json');
  }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));

function loadStatic() {
  const files = new Map();
  for (const name of ['index.html', 'app.js', 'i18n.js', 'providers.js', 'style.css', 'favicon.svg', 'manifest.webmanifest']) {
    const p = path.join(PUBLIC, name);
    if (!existsSync(p)) continue;
    const body = readFileSync(p);
    files.set(`/${name}`, { body, type: TYPES[path.extname(name)], etag: `"${VERSION}-${body.length}"` });
  }
  files.set('/', files.get('/index.html'));
  return files;
}

const tags = (s) => {
  try {
    return JSON.parse(s ?? '[]');
  } catch {
    return [];
  }
};

function articleOut(a, extra = {}) {
  return {
    id: a.id,
    url: a.url,
    title: a.title_local || a.title,
    originalTitle: a.title,
    summary: a.summary || a.feed_summary || '',
    category: a.category,
    tags: tags(a.tags),
    relevance: a.relevance,
    reason: a.reason,
    image: a.image,
    published: a.published ?? a.fetched,
    source: { id: a.source_id, title: a.source_title },
    status: a.status,
    feedback: a.feedback,
    saved: Boolean(a.saved),
    read: Boolean(a.read_at),
    ...extra,
  };
}

const ARTICLE_COLS = `a.id, a.source_id, a.url, a.title, a.title_local, a.summary, a.feed_summary, a.category, a.tags, a.relevance, a.reason,
  a.image, a.published, a.fetched, a.cluster_id, a.status, a.feedback, a.saved, a.read_at, s.title AS source_title`;

export function createServer(app) {
  const { db, settings, pipeline, auth, config, net } = app;
  const assets = loadStatic();

  function listArticles(q) {
    const now = Date.now();
    const where = ['s.enabled = 1'];
    const args = [];
    const sort = q.get('sort') === 'new' ? 'new' : 'score';
    if (q.get('view') === 'saved') where.push('a.saved = 1');
    else {
      where.push('COALESCE(a.published, a.fetched) > ?');
      args.push(now - (sort === 'score' ? 3 : settings.get('retentionDays')) * DAY);
    }
    const category = q.get('category');
    if (category && CATEGORIES.includes(category)) {
      where.push('a.category = ?');
      args.push(category);
    }
    const source = Number(q.get('source'));
    if (Number.isInteger(source) && source > 0) {
      where.push('a.source_id = ?');
      args.push(source);
    }
    const text = (q.get('q') ?? '').trim().slice(0, 100);
    if (text) {
      where.push("(a.title LIKE ? ESCAPE '\\' OR a.title_local LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\')");
      const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
      args.push(like, like, like);
    }
    const rows = db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a JOIN sources s ON s.id = a.source_id WHERE ${where.join(' AND ')} ORDER BY COALESCE(a.published, a.fetched) DESC LIMIT 2000`).all(...args);
    const affinity = loadAffinity(db, now);
    let groups = groupClusters(rows, affinity, now);
    if (sort === 'new' || q.get('view') === 'saved') groups.sort((x, y) => (y.lead.published ?? y.lead.fetched) - (x.lead.published ?? x.lead.fetched));
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 30));
    groups = groups.slice(offset, offset + limit + 1);
    return {
      items: groups.slice(0, limit).map((g) => articleOut(g.lead, { score: g.lead.score, others: g.others.map((o) => ({ id: o.id, url: o.url, title: o.title_local || o.title, source: o.source_title })) })),
      more: groups.length > limit,
    };
  }

  function articleDetail(id) {
    const a = db.prepare(`SELECT ${ARTICLE_COLS}, a.text FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?`).get(id);
    if (!a) throw httpError(404, 'not_found');
    const related = a.cluster_id ? db.prepare(`SELECT ${ARTICLE_COLS} FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ? AND a.id != ? ORDER BY a.published DESC LIMIT 20`).all(a.cluster_id, a.id) : [];
    const size = related.length + 1;
    return articleOut(a, {
      text: a.text ?? '',
      why: a.status === 'done' ? scoreParts({ ...a, cluster_size: size }, loadAffinity(db), Date.now()) : null,
      others: related.map((o) => ({ id: o.id, url: o.url, title: o.title_local || o.title, source: o.source_title })),
    });
  }

  function updateArticle(id, body) {
    const a = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
    if (!a) throw httpError(404, 'not_found');
    if ('feedback' in body) {
      if (![-1, 0, 1].includes(body.feedback)) throw httpError(400, 'feedback');
      db.prepare('UPDATE articles SET feedback = ? WHERE id = ?').run(body.feedback, id);
    }
    if ('saved' in body) db.prepare('UPDATE articles SET saved = ? WHERE id = ?').run(body.saved ? 1 : 0, id);
    if ('read' in body) db.prepare('UPDATE articles SET read_at = ? WHERE id = ?').run(body.read ? Date.now() : null, id);
    return { ok: true };
  }

  function sourcesOut() {
    return db.prepare('SELECT id, url, title, site_url, enabled, full_text, created, last_fetch, last_ok, last_error, item_count FROM sources ORDER BY title COLLATE NOCASE').all().map((s) => ({ ...s, enabled: Boolean(s.enabled), full_text: Boolean(s.full_text) }));
  }

  async function status() {
    const s = settings.all();
    const today = getDigest(db, localDay());
    return {
      version: VERSION,
      queue: pipeline.queue(),
      current: pipeline.state.current,
      refreshing: pipeline.state.refreshing,
      lastRefresh: pipeline.state.lastRefresh,
      nextRefresh: app.nextRefresh(),
      llm: pipeline.state.llm,
      provider: s.provider,
      model: s.model,
      analyzedToday: db.prepare('SELECT COUNT(*) AS n FROM articles WHERE provider = ? AND analyzed_at > ?').get(s.provider, Date.now() - DAY).n,
      dailyLimit: s.provider === 'ollama' ? 0 : s.dailyLimit,
      digest: { enabled: s.digestEnabled, time: s.digestTime, today: Boolean(today) },
      sources: db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
    };
  }

  async function models() {
    const s = settings.all();
    const settle = (p) => p.then((list) => ({ ok: true, models: list })).catch((err) => ({ ok: false, error: errorCode(err), detail: err.detail, models: [] }));
    const [remote, local] = await Promise.all([settle(app.llm().models()), s.provider === 'ollama' ? null : settle(app.local.models())]);
    pipeline.state.llm = { ...pipeline.state.llm, ok: remote.ok, error: remote.ok ? null : remote.error, checked: Date.now() };
    return { provider: s.provider, ...remote, local: local ?? remote };
  }

  const routes = [
    ['GET', /^\/api\/status$/, () => status()],
    ['GET', /^\/api\/stats$/, () => collectStats({ db, settings, pipeline, dbFile: app.dbFile })],
    ['GET', /^\/api\/articles$/, (req, m, q) => listArticles(q)],
    ['GET', /^\/api\/articles\/(\d+)$/, (req, m) => articleDetail(Number(m[1]))],
    ['PATCH', /^\/api\/articles\/(\d+)$/, async (req, m) => updateArticle(Number(m[1]), await readJson(req))],
    ['GET', /^\/api\/digests$/, () => ({ items: listDigests(db) })],
    ['GET', /^\/api\/digests\/(\d{4}-\d{2}-\d{2}|today)$/, (req, m) => ({ digest: getDigest(db, m[1] === 'today' ? localDay() : m[1]) })],
    ['POST', /^\/api\/digests\/build$/, async (req) => (await readJson(req), { digest: await app.makeDigest({ email: false }) })],
    [
      'POST',
      /^\/api\/digests\/(\d{4}-\d{2}-\d{2})\/email$/,
      async (req, m) => {
        await readJson(req);
        await app.sendDigest(m[1]).catch((err) => {
          throw httpError(err.code === 'not_found' ? 404 : 502, err.code);
        });
        return { digest: getDigest(db, m[1]) };
      },
    ],
    ['GET', /^\/api\/sources$/, () => ({ items: sourcesOut() })],
    ['GET', /^\/api\/sources\/suggestions$/, () => ({ items: SUGGESTIONS[settings.get('language')] ?? SUGGESTIONS.en })],
    [
      'POST',
      /^\/api\/sources$/,
      async (req) => {
        const body = await readJson(req);
        try {
          const out = await addSource(db, body.url, { net, fullText: body.full_text !== false });
          if (out.source) pipeline.refreshSource(out.source).then(() => pipeline.work()).catch(() => {});
          return out;
        } catch (err) {
          throw httpError(err.code === 'exists' ? 409 : 422, err.code ?? 'error');
        }
      },
    ],
    [
      'PATCH',
      /^\/api\/sources\/(\d+)$/,
      async (req, m) => {
        const body = await readJson(req);
        const id = Number(m[1]);
        if (!pipeline.sourceById(id)) throw httpError(404, 'not_found');
        if ('enabled' in body) db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
        if ('full_text' in body) db.prepare('UPDATE sources SET full_text = ? WHERE id = ?').run(body.full_text ? 1 : 0, id);
        if (typeof body.title === 'string' && body.title.trim()) db.prepare('UPDATE sources SET title = ? WHERE id = ?').run(body.title.trim().slice(0, 200), id);
        return { ok: true };
      },
    ],
    [
      'DELETE',
      /^\/api\/sources\/(\d+)$/,
      (req, m) => {
        const r = db.prepare('DELETE FROM sources WHERE id = ?').run(Number(m[1]));
        if (!r.changes) throw httpError(404, 'not_found');
        return { ok: true };
      },
    ],
    [
      'POST',
      /^\/api\/sources\/(\d+)\/refresh$/,
      async (req, m) => {
        await readJson(req);
        const src = pipeline.sourceById(Number(m[1]));
        if (!src) throw httpError(404, 'not_found');
        const out = await pipeline.refreshSource(src);
        pipeline.work().catch(() => {});
        return out;
      },
    ],
    [
      'POST',
      /^\/api\/refresh$/,
      async (req) => {
        await readJson(req);
        const out = await pipeline.refreshAll();
        pipeline.work().catch(() => {});
        return out;
      },
    ],
    ['GET', /^\/api\/opml$/, () => ({ raw: exportOpml(db), type: 'text/x-opml; charset=utf-8', filename: 'newsroom.opml' })],
    [
      'POST',
      /^\/api\/opml$/,
      async (req) => {
        const body = await readJson(req);
        if (typeof body.xml !== 'string') throw httpError(400, 'xml');
        try {
          const out = importOpml(db, body.xml);
          pipeline.refreshAll().then(() => pipeline.work()).catch(() => {});
          return out;
        } catch (err) {
          throw httpError(422, err.code ?? 'bad_opml');
        }
      },
    ],
    ['GET', /^\/api\/settings$/, () => ({ settings: publicSettings(settings.all()) })],
    [
      'PUT',
      /^\/api\/settings$/,
      async (req) => {
        const before = settings.all();
        const { errors, value } = validateSettings(await readJson(req), before);
        if (errors.length) throw Object.assign(httpError(422, 'invalid'), { fields: errors });
        settings.update(value);
        const after = settings.all();
        const rescore = JSON.stringify(before.interests) !== JSON.stringify(after.interests) || before.language !== after.language || (!before.model && after.model);
        pipeline.work().catch(() => {});
        return { settings: publicSettings(after), rescore };
      },
    ],
    [
      'POST',
      /^\/api\/requeue$/,
      async (req) => {
        const body = await readJson(req);
        const hours = Math.min(168, Math.max(1, Number(body.hours) || 48));
        const n = pipeline.requeue(hours * 3600_000);
        pipeline.work().catch(() => {});
        return { requeued: n };
      },
    ],
    ['GET', /^\/api\/models$/, () => models()],
    [
      'POST',
      /^\/api\/email\/test$/,
      async (req) => {
        await readJson(req);
        try {
          await sendTestEmail(settings);
          return { ok: true };
        } catch (err) {
          throw Object.assign(httpError(502, errorCode(err)), { detail: err.detail });
        }
      },
    ],
  ];

  const clientIp = (req) => (config.trustProxy ? (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '';
  const isHttps = (req) => req.socket.encrypted || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
      return o.host === host || (config.baseUrl && origin === new URL(config.baseUrl).origin);
    } catch {
      return false;
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
      const file = assets.get(p);
      if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (req.headers['if-none-match'] === file.etag) return send(res, 304, '', { ETag: file.etag, 'Cache-Control': 'no-cache' });
      return send(res, 200, req.method === 'HEAD' ? '' : file.body, { 'Content-Type': file.type, ETag: file.etag, 'Cache-Control': 'no-cache' });
    }

    if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'origin' });
    const token = cookies(req)[COOKIE];
    const required = auth.required();
    const authed = !required || auth.check(token);

    if (p === '/api/session' && req.method === 'GET') return send(res, 200, { authenticated: authed, authRequired: required, language: settings.get('language'), version: VERSION });
    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (auth.limited(ip)) return send(res, 429, { error: 'limited' });
      const body = await readJson(req, 10_000);
      const t = auth.login(body.password, ip);
      if (!t) return send(res, 401, { error: 'wrong_password' });
      const secure = isHttps(req) ? '; Secure' : '';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${auth.maxAge}${secure}` });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      auth.logout(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }
    if (!authed) return send(res, 401, { error: 'auth' });

    for (const [method, re, fn] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(p);
      if (!m) continue;
      const out = await fn(req, m, url.searchParams);
      if (out?.raw !== undefined) return send(res, 200, out.raw, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"` });
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not_found' });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status >= 500 && !err.code) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.code ?? 'internal', ...(err.fields ? { fields: err.fields } : {}), ...(err.detail ? { detail: err.detail } : {}) });
      else res.destroy();
    });
  });
}
