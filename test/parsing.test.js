import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, extractArticle, resolveUrl } from '../src/html.js';
import { parseFeed, discoverFeeds } from '../src/feeds.js';
import { decodeBody, isPrivateAddress } from '../src/http.js';
import { normalizeFeedUrl } from '../src/sources.js';
import { articlePage } from './helpers.js';

test('varlıklar ve HTML düz metne çevrilir', () => {
  assert.equal(decodeEntities('&ccedil;ay &amp; &#351;eker &#x011F;'), 'çay & şeker ğ');
  assert.equal(htmlToText('<p>Bir</p><script>alert(1)</script><p>İki&nbsp;üç</p>'), 'Bir\n\nİki üç');
  assert.equal(resolveUrl('javascript:alert(1)', 'https://example.com/'), null);
  assert.equal(resolveUrl('/a?b=1&amp;c=2', 'https://example.com/x/'), 'https://example.com/a?b=1&c=2');
});

test('RSS 2.0: CDATA, guid, görsel ve tarih', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Örnek &amp; Haber</title><link>https://example.com/</link>
  <item><title><![CDATA[Başlık <b>bir</b>]]></title><link>https://example.com/1</link><guid>abc-1</guid>
    <pubDate>Tue, 17 Nov 2026 08:00:00 +0300</pubDate><description><![CDATA[<p>Özet <img src="/i.jpg"></p>]]></description><dc:creator>Deniz</dc:creator></item>
  <item><title>Bağlantısız, guid kalıcı</title><guid isPermaLink="true">https://example.com/2</guid></item>
  <item><title>Kalıcı olmayan guid</title><guid isPermaLink="false">tag:3</guid></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/feed');
  assert.equal(feed.title, 'Örnek & Haber');
  assert.equal(feed.items.length, 2);
  const [a, b] = feed.items;
  assert.equal(a.title, 'Başlık bir');
  assert.equal(a.guid, 'abc-1');
  assert.equal(a.author, 'Deniz');
  assert.equal(a.image, 'https://example.com/i.jpg');
  assert.equal(a.published, Date.parse('2026-11-17T05:00:00Z'));
  assert.equal(b.url, 'https://example.com/2');
});

test('Atom ve RDF beslemeleri', () => {
  const atom = parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><link href="https://a.example/"/>
     <entry><title>Giriş</title><id>urn:1</id><link rel="alternate" href="/yazi"/><updated>2026-11-17T10:00:00Z</updated>
     <content type="html">&lt;p&gt;Uzun içerik&lt;/p&gt;</content><author><name>Ada</name></author></entry></feed>`,
    'https://a.example/feed',
  );
  assert.equal(atom.items[0].url, 'https://a.example/yazi');
  assert.equal(atom.items[0].author, 'Ada');
  assert.match(atom.items[0].content, /Uzun içerik/);

  const rdf = parseFeed(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
     <channel rdf:about="https://r.example/"><title>RDF</title><link>https://r.example/</link></channel>
     <item rdf:about="https://r.example/1"><title>Bir</title><link>https://r.example/1</link></item></rdf:RDF>`,
    'https://r.example/rss',
  );
  assert.equal(rdf.title, 'RDF');
  assert.equal(rdf.items.length, 1);
  assert.throws(() => parseFeed('<html><body>değil</body></html>', 'https://x.example/'), /not_a_feed/);
});

test('sayfadaki besleme bağlantıları bulunur', () => {
  const html = `<link rel="alternate" type="application/rss+xml" title="Tümü" href="/rss.xml"><link rel="alternate" type="application/atom+xml" href="https://b.example/atom">`;
  assert.deepEqual(
    discoverFeeds(html, 'https://b.example/').map((f) => f.url),
    ['https://b.example/rss.xml', 'https://b.example/atom'],
  );
});

test('haber sayfasından ana metin çıkarılır, gürültü atılır', () => {
  const paras = ['Birinci paragraf yeterince uzun bir cümleden oluşuyor ve haberin girişini anlatıyor.', 'İkinci paragraf da en az kırk karakter uzunluğunda olan bir açıklama içeriyor.'];
  const page = extractArticle(articlePage('Deneme haberi', paras), 'https://example.com/haber');
  assert.equal(page.title, 'Deneme haberi');
  assert.equal(page.text, paras.join('\n\n'));
  assert.equal(page.image, 'https://example.com/img/Deneme%20haberi.jpg');
  assert.equal(page.lang, 'tr');
  assert.equal(page.published, Date.parse('2026-11-17T08:00:00Z'));
});

test('karakter kümesi algılanır', () => {
  const latin5 = Buffer.from([0x3c, 0x70, 0x3e, 0xfe, 0xf0, 0xfd]); // <p>şğı (windows-1254)
  assert.equal(decodeBody(latin5, 'text/html; charset=windows-1254'), '<p>şğı');
  const xml = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="ISO-8859-9"?><a>'), Buffer.from([0xdd]), Buffer.from('</a>')]);
  assert.match(decodeBody(xml, 'application/xml'), /İ/);
  assert.equal(decodeBody(Buffer.from('﻿merhaba'), ''), 'merhaba');
});

test('yerel ağ adresleri tanınır', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '192.0.0.8', '192.0.2.1', '198.18.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '172.32.0.1', '100.128.0.1', '192.0.66.2', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('kaynak adresi normalleştirilir', () => {
  assert.equal(normalizeFeedUrl('example.com/rss#x'), 'https://example.com/rss');
  assert.throws(() => normalizeFeedUrl('ftp://example.com/'), /bad_url/);
  assert.throws(() => normalizeFeedUrl('https://user:pw@example.com/'), /bad_url/);
});
