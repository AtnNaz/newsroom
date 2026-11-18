import { parseFeed, parseXml, discoverFeeds } from './feeds.js';
import { fetchResource, errorCode } from './http.js';

const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5';
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });

export function normalizeFeedUrl(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 2000) throw fail('bad_url');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw fail('bad_url');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw fail('bad_url');
  u.hash = '';
  return u.href;
}

async function tryFeed(url, net) {
  const res = await fetchResource(url, { ...net, accept: ACCEPT, maxBytes: 8_000_000 });
  try {
    return { url: res.url, feed: parseFeed(res.body, res.url) };
  } catch {
    return { url: res.url, html: res.body };
  }
}

export async function addSource(db, input, { net = {}, fullText = true } = {}) {
  const url = normalizeFeedUrl(input);
  const exists = (u) => db.prepare('SELECT id FROM sources WHERE url = ?').get(u);
  if (exists(url)) throw fail('exists');
  let found;
  try {
    found = await tryFeed(url, net);
    if (!found.feed) {
      const candidates = discoverFeeds(found.html, found.url);
      if (!candidates.length) throw fail('no_feed');
      if (candidates.length > 1) return { candidates };
      found = await tryFeed(candidates[0].url, net);
      if (!found.feed) throw fail('no_feed');
    }
  } catch (err) {
    if (err.code === 'no_feed') throw err;
    throw fail(errorCode(err));
  }
  if (exists(found.url)) throw fail('exists');
  const r = db.prepare('INSERT INTO sources (url, title, site_url, full_text, created) VALUES (?, ?, ?, ?, ?)').run(found.url, found.feed.title || new URL(found.url).hostname, found.feed.link || null, fullText ? 1 : 0, Date.now());
  return { source: db.prepare('SELECT * FROM sources WHERE id = ?').get(r.lastInsertRowid) };
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function exportOpml(db) {
  const rows = db.prepare('SELECT url, title, site_url FROM sources ORDER BY title COLLATE NOCASE').all();
  const outlines = rows.map((s) => `    <outline type="rss" text="${xmlEsc(s.title)}" title="${xmlEsc(s.title)}" xmlUrl="${xmlEsc(s.url)}"${s.site_url ? ` htmlUrl="${xmlEsc(s.site_url)}"` : ''}/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Newsroom</title></head>\n  <body>\n${outlines.join('\n')}\n  </body>\n</opml>\n`;
}

export function importOpml(db, xml) {
  const root = parseXml(xml);
  const urls = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.name === 'outline' && c.attrs.xmlurl) urls.push({ url: c.attrs.xmlurl, title: c.attrs.title || c.attrs.text || null, site: c.attrs.htmlurl || null });
      walk(c);
    }
  };
  walk(root);
  if (!urls.length) throw fail('no_feed');
  const insert = db.prepare('INSERT OR IGNORE INTO sources (url, title, site_url, created) VALUES (?, ?, ?, ?)');
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const o of urls.slice(0, 500)) {
      let url;
      try {
        url = normalizeFeedUrl(o.url);
      } catch {
        continue;
      }
      added += Number(insert.run(url, o.title?.slice(0, 200) ?? null, o.site?.slice(0, 2000) ?? null, Date.now()).changes);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, total: urls.length };
}

export const SUGGESTIONS = {
  tr: [
    { title: 'BBC Türkçe', url: 'https://feeds.bbci.co.uk/turkce/rss.xml' },
    { title: 'Webtekno', url: 'https://www.webtekno.com/rss.xml' },
    { title: 'ShiftDelete.Net', url: 'https://shiftdelete.net/feed' },
    { title: 'DonanımHaber', url: 'https://www.donanimhaber.com/rss/tum/' },
    { title: 'NTV Gündem', url: 'https://www.ntv.com.tr/gundem.rss' },
    { title: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  ],
  en: [
    { title: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
    { title: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { title: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
    { title: 'Hacker News', url: 'https://hnrss.org/frontpage' },
    { title: 'The GitHub Blog', url: 'https://github.blog/feed/' },
    { title: 'NASA', url: 'https://www.nasa.gov/feed/' },
  ],
};
