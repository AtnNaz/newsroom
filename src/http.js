import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `Newsroom/${VERSION} (+https://github.com/AtnNaz/newsroom)`;

function ipv4Private(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v) || /^2001:db8:/.test(v);
}

const blocked = () => Object.assign(new Error('blocked_address'), { code: 'blocked_address' });

export async function resolveHost(hostname, allowPrivate = false, lookup = dns.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) throw blocked();
    return { address: host, family: net.isIP(host) };
  }
  let addrs = [];
  try {
    addrs = await lookup(host, { all: true, family: 4 });
  } catch (err) {
    if (!['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA'].includes(err.code)) throw err;
  }
  if (!addrs.length) addrs = await lookup(host, { all: true, family: 6 });
  if (!addrs.length) throw Object.assign(new Error('dns'), { code: 'dns' });
  if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw blocked();
  return { address: addrs[0].address, family: addrs[0].family };
}

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

function requestOnce(url, { headers, signal, address }) {
  return new Promise((resolve, reject) => {
    const lookup = (hostname, options, callback) => (options?.all ? callback(null, [address]) : callback(null, address.address, address.family));
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', headers, signal, lookup }, resolve);
    req.on('error', reject);
    req.end();
  });
}

const headerBag = (raw) => {
  const out = new Headers();
  for (const [k, v] of Object.entries(raw)) out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  return out;
};

function decoder(encoding) {
  const e = String(encoding ?? '').trim().toLowerCase();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return null;
}

export async function fetchResource(url, { headers = {}, accept = '*/*', maxBytes = 5_000_000, timeoutMs = 20_000, allowPrivate = false } = {}) {
  let current = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw fail('bad_protocol');
    if (current.username || current.password) throw fail('bad_url');
    const address = await resolveHost(current.hostname, allowPrivate);
    const res = await requestOnce(current, {
      headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Language': 'tr,en;q=0.8,*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      signal,
      address,
    });
    const status = res.statusCode ?? 0;
    const resHeaders = headerBag(res.headers);
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume();
      const location = resHeaders.get('location');
      if (!location) throw fail(`http_${status}`);
      current = new URL(location, current);
      continue;
    }
    if (status === 304) {
      res.resume();
      return { status, url: current.href, headers: resHeaders, body: '' };
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw fail(`http_${status}`, { status });
    }
    if (Number(resHeaders.get('content-length')) > maxBytes) {
      res.destroy();
      throw fail('too_large');
    }
    const unzip = decoder(resHeaders.get('content-encoding'));
    const stream = unzip ? res.pipe(unzip) : res;
    if (unzip) res.on('error', (err) => unzip.destroy(err));
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.byteLength;
        if (size > maxBytes) throw fail('too_large');
        chunks.push(chunk);
      }
    } finally {
      res.destroy();
    }
    return { status, url: current.href, headers: resHeaders, body: decodeBody(Buffer.concat(chunks), resHeaders.get('content-type') ?? '') };
  }
  throw fail('too_many_redirects');
}

export function errorCode(err) {
  if (err?.code && typeof err.code === 'string' && /^[a-z_0-9]+$/.test(err.code)) return err.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  const cause = err?.cause?.code ?? err?.code;
  if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') return 'dns';
  if (cause === 'ECONNREFUSED') return 'refused';
  if (cause === 'UND_ERR_CONNECT_TIMEOUT' || cause === 'UND_ERR_HEADERS_TIMEOUT' || cause === 'ETIMEDOUT') return 'timeout';
  if (cause === 'ECONNRESET' || cause === 'UND_ERR_SOCKET') return 'reset';
  if (cause && /CERT|SSL|TLS/.test(cause)) return 'tls';
  if (/^[a-z_0-9]+$/.test(err?.message ?? '')) return err.message;
  return 'network';
}
