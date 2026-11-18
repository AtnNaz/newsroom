// HTML ve XML metinleri için küçük yardımcılar: varlık çözme, etiket ayıklama, düz metne çevirme.
// Ek paket kullanılmaz; amaç haber sayfalarından okunur bir metin çıkarmaktır, tam bir HTML
// ayrıştırıcısı değil.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷',
  ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', scedil: 'ş', Scedil: 'Ş', iacute: 'í',
  eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', auml: 'ä', Auml: 'Ä', szlig: 'ß', ntilde: 'ñ', oacute: 'ó',
  uacute: 'ú', acirc: 'â', icirc: 'î', ucirc: 'û', ocirc: 'ô', ecirc: 'ê', gbreve: 'ğ', Gbreve: 'Ğ', inodot: 'ı',
  Idot: 'İ', zwj: '', zwnj: '', shy: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : m;
  });
}

const BLOCK = /<\/?(p|div|br|li|ul|ol|h[1-6]|blockquote|section|article|tr|figure|figcaption|pre|hr)\b[^>]*>/gi;

// HTML parçasını paragraflı düz metne çevirir.
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
      .replace(BLOCK, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const stripTags = (html) => htmlToText(html).replace(/\s+/g, ' ').trim();

// <meta property="og:image" content="..."> ve <meta name="..."> değerleri
export function metaTags(html) {
  const out = {};
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in out)) out[key] = decodeEntities(content[1] ?? content[2]).trim();
  }
  return out;
}

export function resolveUrl(href, base) {
  try {
    const u = new URL(decodeEntities(href).trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const NOISE = /<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select|figure)\b[\s\S]*?<\/\1>/gi;
const NOISE_CLASS = /\b(comment|share|social|related|newsletter|subscribe|advert|promo|cookie|footer|sidebar|breadcrumb|tags?|author-box|recommend)/i;

// Haber sayfasından başlık, ana metin, görsel ve yayın zamanı çıkarır.
// Yöntem: gürültülü bölümler atılır, <p> paragrafları sıralarına göre kümelenir ve en çok
// metin içeren küme ana metin sayılır. <article> varsa önce onun içine bakılır.
export function extractArticle(html, pageUrl) {
  const source = String(html ?? '');
  const meta = metaTags(source);
  const title = meta['og:title'] || meta['twitter:title'] || decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? '').trim();
  const imageRaw = meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'];
  const publishedRaw = meta['article:published_time'] || meta['og:article:published_time'] || meta['datepublished'] || meta['date'] || /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(source)?.[1];
  const lang = /<html\b[^>]*\blang=["']([a-z]{2})/i.exec(source)?.[1]?.toLowerCase() ?? null;

  let body = source.replace(/<!--[\s\S]*?-->/g, '').replace(NOISE, ' ');
  const articles = [...body.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  const best = articles.sort((a, b) => stripTags(b).length - stripTags(a).length)[0];
  if (best && stripTags(best).length > 400) body = best;

  const paragraphs = [];
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
    if (NOISE_CLASS.test(m[1])) continue;
    const text = stripTags(m[2]);
    if (text.length < 40) continue;
    paragraphs.push({ at: m.index, text });
  }
  // Birbirine yakın paragraflar aynı kümeye girer (aradaki HTML 3500 karakterden kısaysa).
  const clusters = [];
  for (const p of paragraphs) {
    const last = clusters.at(-1);
    if (last && p.at - last.end < 3500) {
      last.items.push(p.text);
      last.end = p.at + p.text.length;
      last.size += p.text.length;
    } else clusters.push({ items: [p.text], end: p.at + p.text.length, size: p.text.length });
  }
  const main = clusters.sort((a, b) => b.size - a.size)[0];
  const text = main ? main.items.join('\n\n') : '';

  const published = publishedRaw ? Date.parse(publishedRaw) : NaN;
  return {
    title: title || null,
    text,
    excerpt: meta['og:description'] || meta.description || null,
    image: imageRaw ? resolveUrl(imageRaw, pageUrl) : null,
    published: Number.isFinite(published) ? published : null,
    siteName: meta['og:site_name'] || null,
    lang,
  };
}
