import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb, createSettings } from '../src/db.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { createOllama } from '../src/ollama.js';
import { createPipeline } from '../src/pipeline.js';
import { buildDigest, getDigest } from '../src/digest.js';
import { fetchResource } from '../src/http.js';
import { listen, tempDir, rss, articlePage, fakeOllama } from './helpers.js';

const LONG = (s) => [`${s} hakkında ilk paragraf yeterince uzun bir açıklama içeriyor ve okunabilir.`, `${s} ile ilgili ikinci paragraf da en az kırk karakterden oluşan bir metindir.`];

async function newsSite() {
  const hits = { feed: 0, notModified: 0, pages: 0 };
  const now = Date.now();
  const items = [
    { title: 'Yapay zeka çipi tanıtıldı', path: '/h/1', published: now - 3600_000, summary: 'Kısa giriş.' },
    { title: 'Yeni yapay zeka çipi duyuruldu', path: '/h/2', published: now - 2 * 3600_000, summary: 'Kısa giriş.' },
    { title: 'Belediye meclisi toplandı', path: '/h/3', published: now - 3 * 3600_000, summary: 'Kısa giriş.' },
  ];
  const site = await listen((req, res) => {
    if (req.url === '/feed.xml') {
      hits.feed++;
      if (req.headers['if-none-match'] === '"v1"') {
        hits.notModified++;
        res.writeHead(304);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8', ETag: '"v1"' });
      return res.end(rss(site.url, items));
    }
    if (req.url === '/' || req.url === '/ana') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>site</body></html>`);
    }
    if (req.url === '/eski') {
      res.writeHead(301, { Location: '/feed.xml' });
      return res.end();
    }
    const item = items.find((i) => i.path === req.url);
    if (item) {
      hits.pages++;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(articlePage(item.title, LONG(item.title)));
    }
    res.writeHead(404);
    res.end();
  });
  return { ...site, hits };
}

test('yerel adreslere varsayılan olarak istek gönderilmez', async () => {
  const site = await newsSite();
  try {
    await assert.rejects(fetchResource(`${site.url}/feed.xml`), /blocked_address/);
    const r = await fetchResource(`${site.url}/eski`, { allowPrivate: true });
    assert.equal(r.url, `${site.url}/feed.xml`);
  } finally {
    await site.close();
  }
});

test('indir → tam metin → analiz → kümele → günlük özet', async () => {
  const site = await newsSite();
  const ollama = await fakeOllama();
  const tmp = tempDir();
  const db = openDb(path.join(tmp.dir, 'n.db'));
  try {
    const settings = createSettings(db, DEFAULT_SETTINGS);
    settings.update({ model: 'test-model:7b', embedModel: 'embed-model', interests: ['yapay zekâ', 'uzay'] });
    db.prepare('INSERT INTO sources (url, title, created) VALUES (?, ?, ?)').run(`${site.url}/feed.xml`, '', Date.now());
    const pipeline = createPipeline({ db, settings, ollama: createOllama({ url: ollama.url }), allowPrivate: true });

    assert.equal((await pipeline.refreshAll()).added, 3);
    const src = db.prepare('SELECT * FROM sources').get();
    assert.equal(src.title, 'Örnek Haber');
    assert.equal(src.etag, '"v1"');
    assert.deepEqual(pipeline.queue(), { new: 3, ready: 0, done: 0, failed: 0 });

    await pipeline.work();
    assert.equal(site.hits.pages, 3);
    const rows = db.prepare('SELECT * FROM articles ORDER BY id').all();
    assert.ok(rows.every((r) => r.status === 'done'));
    assert.match(rows[0].text, /ilk paragraf/);
    assert.ok(rows[0].image.endsWith('.jpg'));
    assert.equal(rows[0].relevance, 90);
    assert.equal(rows[2].relevance, 0);
    assert.equal(rows[2].reason, '');
    assert.equal(rows[0].cluster_id, rows[1].cluster_id, 'aynı olay aynı kümede');
    assert.notEqual(rows[2].cluster_id, rows[0].cluster_id);
    assert.equal(ollama.calls.embed, 3);
    assert.deepEqual(ollama.calls.embedOptions, { num_gpu: 0 }, 'benzerlik modeli ekran kartını analiz modeline bırakır');

    assert.equal((await pipeline.refreshAll()).added, 0);
    assert.equal(site.hits.notModified, 1);

    const digest = await buildDigest({ db, settings, ollama: createOllama({ url: ollama.url }) });
    assert.equal(digest.intro, 'Günün öne çıkan gelişmeleri.');
    const items = digest.sections.flatMap((s) => s.items);
    assert.equal(items.length, 2, 'küme tek haber olarak girer');
    assert.equal(digest.sections[0].category, 'ai');
    assert.equal(items[0].others.length, 1);
    assert.deepEqual(getDigest(db, digest.day).sections, digest.sections);

    assert.equal(pipeline.requeue(86400_000), 3);
    assert.equal(pipeline.queue().ready, 3);
  } finally {
    db.close();
    tmp.cleanup();
    await site.close();
    await ollama.close();
  }
});

test('Ollama yoksa haberler cezalandırılmaz, model bulunamazsa kuyruk bekler', async () => {
  const site = await newsSite();
  const ollama = await fakeOllama();
  const tmp = tempDir();
  const db = openDb(path.join(tmp.dir, 'n.db'));
  try {
    const settings = createSettings(db, DEFAULT_SETTINGS);
    db.prepare('INSERT INTO sources (url, title, created, full_text) VALUES (?, ?, ?, 0)').run(`${site.url}/feed.xml`, 'x', Date.now());
    const pipeline = createPipeline({ db, settings, ollama: createOllama({ url: ollama.url }), allowPrivate: true });
    await pipeline.refreshAll();
    assert.equal(pipeline.queue().ready, 3, 'tam metin kapalıyken sayfa indirilmez');
    await pipeline.work();
    assert.equal(pipeline.queue().ready, 3, 'model seçilmemişken analiz yapılmaz');

    settings.update({ model: 'olmayan-model' });
    await pipeline.work();
    assert.equal(pipeline.state.ollama.error, 'model_missing');
    assert.equal(db.prepare('SELECT MAX(attempts) AS n FROM articles').get().n, 0);

    settings.update({ model: 'test-model:7b', embedModel: 'embed-model' });
    let embedCalls = 0;
    const slowEmbed = { ...createOllama({ url: ollama.url }), embed: async () => { embedCalls++; throw Object.assign(new Error('timeout'), { code: 'timeout' }); } };
    const paused = createPipeline({ db, settings, ollama: slowEmbed, allowPrivate: true, log: () => {} });
    await paused.analyzePending();
    assert.equal(embedCalls, 1, 'benzerlik modeli zaman aşımına düşünce sonraki haberlerde denenmez');
    assert.equal(paused.queue().done, 3, 'analiz benzerlik modeli olmadan sürer');
    paused.requeue(86400_000);
    settings.update({ model: '', embedModel: '' });

    const dead = createPipeline({ db, settings: { ...settings, all: () => ({ ...settings.all(), model: 'test-model:7b' }) }, ollama: createOllama({ url: 'http://127.0.0.1:9' }), allowPrivate: true });
    await dead.analyzePending();
    assert.equal(dead.state.ollama.ok, false);
    assert.equal(db.prepare('SELECT MAX(attempts) AS n FROM articles').get().n, 0);
  } finally {
    db.close();
    tmp.cleanup();
    await site.close();
    await ollama.close();
  }
});

test('saklama süresi dolan haberler silinir, kaydedilenler kalır', () => {
  const tmp = tempDir();
  const db = openDb(path.join(tmp.dir, 'n.db'));
  try {
    const settings = createSettings(db, DEFAULT_SETTINGS);
    const pipeline = createPipeline({ db, settings, ollama: null });
    db.prepare("INSERT INTO sources (id, url, created) VALUES (1, 'https://example.com/f', 0)").run();
    const old = Date.now() - 40 * 86400_000;
    db.prepare("INSERT INTO articles (source_id, url, title, fetched, saved) VALUES (1, 'https://example.com/1', 'a', ?, 0), (1, 'https://example.com/2', 'b', ?, 1), (1, 'https://example.com/3', 'c', ?, 0)").run(old, old, Date.now());
    assert.equal(pipeline.cleanup(), 1);
    assert.deepEqual(db.prepare('SELECT title FROM articles ORDER BY id').all().map((r) => r.title), ['b', 'c']);
  } finally {
    db.close();
    tmp.cleanup();
  }
});
