import { decodeEntities, htmlToText, resolveUrl } from './html.js';

export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const src = String(xml ?? '');
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(src))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].toLowerCase();
      const i = stack.findLastIndex((n) => n.name === name);
      if (i > 0) stack.length = i;
    } else if (m[3]) {
      const node = { name: m[3].toLowerCase(), attrs: parseAttrs(m[4] ?? ''), children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decodeEntities(m[6]);
  }
  return root;
}

function parseAttrs(text) {
  const attrs = {};
  for (const a of text.matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
  }
  return attrs;
}

const child = (node, ...names) => node?.children.find((c) => names.includes(c.name)) ?? null;
const children = (node, name) => node?.children.filter((c) => c.name === name) ?? [];
const text = (node) => (node ? (node.text + node.children.map(text).join('')).trim() : '');
const find = (node, name) => {
  if (!node) return null;
  if (node.name === name) return node;
  for (const c of node.children) {
    const hit = find(c, name);
    if (hit) return hit;
  }
  return null;
};

function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

function firstImage(html, base) {
  const src = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html ?? '')?.[1];
  return src ? resolveUrl(src, base) : null;
}

function itemImage(item, html, base) {
  for (const c of item.children) {
    if ((c.name === 'media:content' || c.name === 'media:thumbnail') && c.attrs.url && (c.name === 'media:thumbnail' || !c.attrs.medium || c.attrs.medium === 'image')) return resolveUrl(c.attrs.url, base);
    if (c.name === 'media:group') {
      const inner = itemImage(c, '', base);
      if (inner) return inner;
    }
    if (c.name === 'enclosure' && /^image\//.test(c.attrs.type ?? '') && c.attrs.url) return resolveUrl(c.attrs.url, base);
  }
  return firstImage(html, base);
}

const clean = (s, max) => htmlToText(s).replace(/\s+/g, ' ').trim().slice(0, max);

export function parseFeed(xml, feedUrl) {
  const root = parseXml(xml);
  const top = root.children.find((c) => ['feed', 'rss', 'rdf:rdf'].includes(c.name)) ?? null;
  const atom = top?.name === 'feed' ? top : null;
  const rdf = top?.name === 'rdf:rdf' ? top : null;
  const channel = top && !atom ? find(top, 'channel') : null;
  if (!atom && !channel && !rdf) throw Object.assign(new Error('not_a_feed'), { code: 'not_a_feed' });

  if (atom) {
    const siteLink = children(atom, 'link').find((l) => !l.attrs.rel || l.attrs.rel === 'alternate')?.attrs.href;
    const base = resolveUrl(siteLink ?? '', feedUrl) ?? feedUrl;
    return {
      title: clean(text(child(atom, 'title')), 200),
      link: base,
      items: children(atom, 'entry').map((e) => {
        const links = children(e, 'link');
        const href = (links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? links[0])?.attrs.href;
        const url = href ? resolveUrl(href, base) : null;
        const content = text(child(e, 'content')) || text(child(e, 'media:group')?.children.find((c) => c.name === 'media:description'));
        const summary = text(child(e, 'summary')) || content;
        return {
          guid: text(child(e, 'id')) || url,
          url,
          title: clean(text(child(e, 'title')), 300),
          summary: clean(summary, 2000),
          content: content.length > summary.length ? content : summary,
          published: parseDate(text(child(e, 'published', 'updated'))),
          author: clean(text(child(child(e, 'author'), 'name')), 120) || null,
          image: itemImage(e, content || summary, base),
        };
      }).filter((i) => i.url && i.title),
    };
  }

  const container = channel ?? rdf;
  const base = resolveUrl(text(child(container, 'link')), feedUrl) ?? feedUrl;
  const itemsParent = rdf && !children(channel, 'item').length ? rdf : channel;
  return {
    title: clean(text(child(channel ?? rdf, 'title')), 200),
    link: base,
    items: children(itemsParent, 'item').map((it) => {
      const content = text(child(it, 'content:encoded'));
      const desc = text(child(it, 'description'));
      const guidNode = child(it, 'guid');
      const guidLink = guidNode && guidNode.attrs.ispermalink !== 'false' ? text(guidNode) : '';
      const link = text(child(it, 'link')) || guidLink || it.attrs['rdf:about'];
      const url = link ? resolveUrl(link, base) : null;
      return {
        guid: text(child(it, 'guid')) || url,
        url,
        title: clean(text(child(it, 'title')), 300),
        summary: clean(desc || content, 2000),
        content: content || desc,
        published: parseDate(text(child(it, 'pubdate', 'dc:date', 'published', 'updated'))),
        author: clean(text(child(it, 'dc:creator', 'author')), 120) || null,
        image: itemImage(it, content || desc, base),
      };
    }).filter((i) => i.url && i.title),
  };
}

export function discoverFeeds(html, pageUrl) {
  const out = [];
  for (const m of String(html ?? '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel=["']?alternate/i.test(tag) || !/\btype=["']?application\/(rss|atom|rdf)\+xml/i.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
    const url = href ? resolveUrl(href, pageUrl) : null;
    if (url && !out.some((f) => f.url === url)) out.push({ url, title: decodeEntities(/\btitle=["']([^"']*)["']/i.exec(tag)?.[1] ?? '') || null });
  }
  return out;
}
