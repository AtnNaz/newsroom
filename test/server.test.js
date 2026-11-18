import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { hashPassword, verifyPassword, createAuth } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { listen, tempDir, rss, fakeOllama } from './helpers.js';

const PASSWORD = 'deneme-sifre-123';
let tmp, app, server, base, site, ollama;

before(async () => {
  tmp = tempDir();
  ollama = await fakeOllama();
  site = await listen((req, res) => {
    if (req.url === '/rss') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(rss(site.url, [{ title: 'Yapay zeka haberi', path: '/1', summary: 'Uzunca bir giriş metni '.repeat(80) }]));
    }
    if (req.url === '/cok') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<link rel="alternate" type="application/rss+xml" href="/rss"><link rel="alternate" type="application/atom+xml" href="/atom">');
    }
    res.writeHead(404);
    res.end();
  });
  const config = loadConfig(null, { NEWSROOM_DATA_DIR: tmp.dir, NEWSROOM_PASSWORD: PASSWORD, NEWSROOM_OLLAMA_URL: ollama.url, NEWSROOM_ALLOW_PRIVATE_NETWORKS: '1' });
  app = createApp(config, { log: () => {} });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  app.stop();
  await site.close();
  await ollama.close();
  tmp.cleanup();
});

let cookie = '';
const call = (method, p, body, headers = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

test('şifre özeti doğrulanır', () => {
  const h = hashPassword('gizli şifre');
  assert.ok(verifyPassword('gizli şifre', h));
  assert.ok(!verifyPassword('gizli sifre', h));
  assert.ok(!verifyPassword('x', 'scrypt$99999999$8$1$a$b'));
});

test('hatalı denemeler sınırlanır', () => {
  const t = tempDir();
  const db = openDb(`${t.dir}/a.db`);
  try {
    const auth = createAuth({ db, config: { password: 'dogru-sifre', passwordHash: '' } });
    for (let i = 0; i < 10; i++) assert.equal(auth.login('yanlis', '1.2.3.4'), null);
    assert.ok(auth.limited('1.2.3.4'));
    assert.ok(!auth.limited('5.6.7.8'));
    const token = auth.login('dogru-sifre', '5.6.7.8');
    assert.ok(auth.check(token));
    assert.equal(db.prepare('SELECT token_hash FROM sessions').get().token_hash.length, 64, 'yalnızca özet saklanır');
    auth.logout(token);
    assert.ok(!auth.check(token));
  } finally {
    db.close();
    t.cleanup();
  }
});

test('giriş yapmadan API kapalı, statik dosyalar ve güvenlik başlıkları', async () => {
  assert.equal((await call('GET', '/api/articles')).status, 401);
  const s = await (await call('GET', '/api/session')).json();
  assert.deepEqual([s.authenticated, s.authRequired], [false, true]);
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('GET', '/../package.json')).status, 404);
  assert.equal((await call('POST', '/api/login', { password: 'yanlis' })).status, 401);
});

test('giriş, oturum ve başka siteden gelen istek', async () => {
  const res = await call('POST', '/api/login', { password: PASSWORD });
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  assert.match(set, /HttpOnly; SameSite=Lax/);
  cookie = set.split(';')[0];
  assert.equal((await (await call('GET', '/api/session')).json()).authenticated, true);
  assert.equal((await call('PUT', '/api/settings', { language: 'en' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/api/refresh', undefined, {})).status, 415, 'JSON olmayan gövde reddedilir');
});

test('ayarlar: doğrulama, e-posta şifresi gizli', async () => {
  const bad = await call('PUT', '/api/settings', { fetchMinutes: 3, language: 'xx' });
  assert.equal(bad.status, 422);
  assert.deepEqual((await bad.json()).fields.sort(), ['fetchMinutes', 'language']);
  const ok = await (await call('PUT', '/api/settings', { model: 'test-model:7b', interests: ['yapay zekâ'], email: { host: 'smtp.example.com', pass: 'cok-gizli' } })).json();
  assert.equal(ok.rescore, true);
  assert.equal(ok.settings.email.pass, undefined);
  assert.equal(ok.settings.email.passSet, true);
  const models = await (await call('GET', '/api/models')).json();
  assert.equal(models.ok, true);
  assert.deepEqual(models.models.map((m) => m.name), ['test-model:7b', 'embed-model']);
});

test('kaynak ekleme, haber akışı, geri bildirim ve OPML', async () => {
  const many = await (await call('POST', '/api/sources', { url: `${site.url}/cok` })).json();
  assert.equal(many.candidates.length, 2);
  const added = await (await call('POST', '/api/sources', { url: `${site.url}/rss` })).json();
  assert.equal(added.source.title, 'Örnek Haber');
  assert.equal((await call('POST', '/api/sources', { url: `${site.url}/rss` })).status, 409);
  assert.equal((await call('POST', '/api/sources', { url: 'ftp://x' })).status, 422);

  await app.pipeline.refreshAll();
  await app.pipeline.work();
  const feed = await (await call('GET', '/api/articles?view=feed')).json();
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.category, 'ai');
  assert.equal(item.relevance, 90);
  assert.equal((await call('PATCH', `/api/articles/${item.id}`, { feedback: 2 })).status, 400);
  await call('PATCH', `/api/articles/${item.id}`, { feedback: 1, saved: true });
  const saved = await (await call('GET', '/api/articles?view=saved')).json();
  assert.equal(saved.items[0].saved, true);
  const detail = await (await call('GET', `/api/articles/${item.id}`)).json();
  assert.ok(detail.why.topic > 0, 'beğeni konu tercihine yansır');
  assert.equal((await (await call('GET', '/api/articles?view=feed&q=%25')).json()).items.length, 0, 'LIKE joker karakteri kaçışlanır');

  const opml = await (await call('GET', '/api/opml')).text();
  assert.match(opml, /xmlUrl="http:\/\/127\.0\.0\.1:\d+\/rss"/);
  const imported = await (await call('POST', '/api/opml', { xml: opml.replace('/rss"', '/rss2"') })).json();
  assert.equal(imported.added, 1);

  const digest = await (await call('POST', '/api/digests/build', {})).json();
  assert.equal(digest.digest.sections[0].items[0].id, item.id);
  const today = await (await call('GET', '/api/digests/today')).json();
  assert.equal(today.digest.day, digest.digest.day);
  assert.equal((await (await call('GET', '/api/digests')).json()).items.length, 1);
});

test('çıkış oturumu kapatır', async () => {
  await call('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/status')).status, 401);
});

test('istatistik uç noktası kuyruk, hız ve dağılımları verir', async () => {
  await call('POST', '/api/login', { password: PASSWORD }).then((r) => (cookie = r.headers.get('set-cookie').split(';')[0]));
  const st = await (await call('GET', '/api/stats')).json();
  for (const k of ['queue', 'pending', 'analyzed', 'fetched', 'speed', 'llm', 'categories', 'relevance', 'sources', 'errors', 'storage']) assert.ok(k in st, k);
  assert.equal(st.relevance.length, 4);
  assert.ok(st.storage.bytes > 0);
  assert.ok(st.analyzed.total >= 1);
  assert.equal(st.sources.top[0].n >= 1, true);
  assert.equal(st.llm.provider, 'ollama');
});
