import dns from 'node:dns/promises';
import net from 'node:net';
import { readFileSync } from 'node:fs';

// Dış kaynaklardan besleme ve haber sayfası indirir. Beslemeler kullanıcı tarafından
// eklense de içlerindeki bağlantılar başkasının elindedir; bu yüzden varsayılan olarak yerel
// ağdaki adreslere (127.0.0.1, 192.168.x.x, bulut meta veri adresi...) istek gönderilmez.

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `Newsroom/${VERSION} (+https://github.com/AtnNaz/newsroom)`;

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v) || /^2001:db8:/.test(v);
}

async function assertPublic(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw Object.assign(new Error('blocked_address'), { code: 'blocked_address' });
}

// Bayt dizisini doğru karakter kümesiyle metne çevirir (HTTP başlığı, BOM, XML bildirimi, meta).
export function decodeBody(buf, contentType = '') {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  const head = Buffer.from(buf.subarray(0, 4096)).toString('latin1');
  const charset =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1] ??
    /<meta[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset.toLowerCase()).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });

// Yönlendirmeler elle izlenir ki her adımda adres yeniden denetlensin. 304 yanıtı gövdesiz döner.
export async function fetchResource(url, { headers = {}, accept = '*/*', maxBytes = 5_000_000, timeoutMs = 20_000, allowPrivate = false, fetchImpl = fetch } = {}) {
  let current = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw fail('bad_protocol');
    if (current.username || current.password) throw fail('bad_url');
    if (!allowPrivate) await assertPublic(current);
    const res = await fetchImpl(current, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'tr,en;q=0.8,*;q=0.5', ...headers },
      redirect: 'manual',
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw fail(`http_${res.status}`);
      current = new URL(location, current);
      continue;
    }
    if (res.status === 304) {
      await res.body?.cancel();
      return { status: 304, url: current.href, headers: res.headers, body: '' };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw fail(`http_${res.status}`, { status: res.status });
    }
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body?.cancel();
      throw fail('too_large');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) throw fail('too_large');
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    return { status: res.status, url: current.href, headers: res.headers, body: decodeBody(buf, res.headers.get('content-type') ?? '') };
  }
  throw fail('too_many_redirects');
}

// Hata kodunu arayüzde gösterilecek kısa bir açıklamaya indirger.
export function errorCode(err) {
  if (err?.code && typeof err.code === 'string' && /^[a-z_0-9]+$/.test(err.code)) return err.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  // fetch hataları sistem kodunu cause içinde, net/tls soketleri doğrudan hatanın üzerinde taşır.
  const cause = err?.cause?.code ?? err?.code;
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return 'dns';
  if (cause === 'ECONNREFUSED') return 'refused';
  if (cause === 'UND_ERR_CONNECT_TIMEOUT' || cause === 'UND_ERR_HEADERS_TIMEOUT' || cause === 'ETIMEDOUT') return 'timeout';
  if (cause === 'ECONNRESET' || cause === 'UND_ERR_SOCKET') return 'reset';
  if (cause && /CERT|SSL|TLS/.test(cause)) return 'tls';
  if (/^[a-z_0-9]+$/.test(err?.message ?? '')) return err.message;
  return 'network';
}
