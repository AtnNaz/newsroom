import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Testler internete çıkmaz: beslemeler, haber sayfaları ve Ollama yerel sahte sunuculardır.

export async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((r) => server.close(r)) };
}

export function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'newsroom-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const rss = (base, items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Örnek Haber</title><link>${base}/</link>
${items
  .map(
    (i) => `<item><title><![CDATA[${i.title}]]></title><link>${base}${i.path}</link><guid isPermaLink="false">${i.guid ?? i.path}</guid>
<pubDate>${new Date(i.published ?? Date.now()).toUTCString()}</pubDate><description><![CDATA[${i.summary ?? ''}]]></description>
${i.image ? `<media:content url="${i.image}" medium="image"/>` : ''}</item>`,
  )
  .join('\n')}
</channel></rss>`;

export const articlePage = (title, paragraphs) => `<!doctype html><html lang="tr"><head><title>${title} | Örnek</title>
<meta property="og:title" content="${title}"><meta property="og:image" content="/img/${encodeURIComponent(title)}.jpg">
<meta property="article:published_time" content="2026-11-17T08:00:00Z"></head>
<body><header><nav><a href="/">Ana sayfa</a></nav></header>
<article><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</article>
<aside class="related"><p>İlgili haberler listesi burada yer alıyor ve ana metne girmemeli.</p></aside>
<footer><p>Telif hakkı Örnek Haber 2026, tüm hakları saklıdır ve bu metin alınmamalı.</p></footer></body></html>`;

// Sahte Ollama: başlıkta "yapay zeka" geçen haberlere yüksek ilgi verir, gömme vektörü olarak
// başlıktaki anahtar kelimeleri kullanır.
export async function fakeOllama({ models = ['test-model:7b', 'embed-model'] } = {}) {
  const calls = { chat: 0, embed: 0 };
  const srv = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (o, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/api/tags') return json({ models: models.map((name) => ({ name, size: 1e9, details: { family: 'test', parameter_size: '7B' } })) });
    if (req.url === '/api/chat') {
      calls.chat++;
      if (!models.includes(body.model)) return json({ error: 'model not found' }, 404);
      const user = body.messages.at(-1).content;
      if (body.format?.properties?.intro) return json({ message: { content: JSON.stringify({ intro: 'Günün öne çıkan gelişmeleri.' }) } });
      const title = /Original title: (.*)/.exec(user)?.[1] ?? '';
      const ai = /yapay zeka/i.test(title);
      const keys = Object.keys(body.format.properties.interests?.properties ?? {});
      const out = {
        title: `${title} (özet)`,
        summary: `${title} hakkında kısa özet.`,
        category: ai ? 'ai' : 'world',
        tags: ai ? ['yapay zeka'] : [],
        reason: ai ? 'Yapay zekâ ile ilgili.' : 'yok',
        ...(keys.length ? { interests: Object.fromEntries(keys.map((k, i) => [k, ai && i === 0 ? 9 : 0])) } : { importance: 5 }),
      };
      return json({ message: { content: JSON.stringify(out) } });
    }
    if (req.url === '/api/embed') {
      calls.embed++;
      const v = /çip/i.test(body.input) ? [1, 0, 0] : /yapay/i.test(body.input) ? [0, 1, 0] : [0, 0, 1];
      return json({ embeddings: [v] });
    }
    json({ error: 'not found' }, 404);
  });
  return { ...srv, calls };
}
