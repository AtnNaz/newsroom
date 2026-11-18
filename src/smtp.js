import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import crypto from 'node:crypto';

// Bağımlılıksız küçük bir SMTP istemcisi: doğrudan TLS (465) ya da STARTTLS (587),
// AUTH PLAIN/LOGIN, UTF-8 içerikli multipart/alternative ileti.

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

// RFC 2047 kodlu başlık; uzun metin, karakter ortasından bölünmeyecek parçalara ayrılır.
export function encodeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(w)}?=`).join('\r\n ');
}

const address = (s) => /<([^>]+)>/.exec(s)?.[1] ?? s.trim();

export function buildMessage({ from, fromName = 'Newsroom', to, subject, text, html, date = new Date() }) {
  const boundary = `nr_${crypto.randomBytes(12).toString('hex')}`;
  const domain = address(from).split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${encodeHeader(fromName)} <${address(from)}>`,
    `To: <${address(to)}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body))].join('\r\n');
  const parts = [part('text/plain', text)];
  if (html) parts.push(part('text/html', html));
  return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...parts, `--${boundary}--`, ''].join('\r\n');
}

// Sunucu yanıtlarını satır satır okur; "250-" ile devam eden çok satırlı yanıtları birleştirir.
function responseReader() {
  let buf = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;
  const deliver = () => {
    while (ready.length && waiting.length) waiting.shift().resolve(ready.shift());
    if (failure) while (waiting.length) waiting.shift().reject(failure);
  };
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!/^\d{3}/.test(line)) continue;
      lines.push(line.slice(4));
      if (line[3] !== '-') {
        ready.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    deliver();
  };
  const onEnd = (err) => {
    failure ??= err instanceof Error ? err : Object.assign(new Error('smtp_closed'), { code: 'smtp_closed' });
    deliver();
  };
  let socket = null;
  return {
    attach(s) {
      if (socket) {
        socket.off('data', onData);
        socket.off('error', onEnd);
        socket.off('close', onEnd);
      }
      socket = s;
      s.on('data', onData);
      s.on('error', onEnd);
      s.on('close', onEnd);
    },
    next() {
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        deliver();
      });
    },
  };
}

export async function sendMail({ host, port, security = 'starttls', user = '', pass = '', from, to, subject, text, html, timeoutMs = 30_000, tlsOptions = {}, clientName = 'newsroom.localdomain' }) {
  const sender = from || user;
  if (!host || !to || !sender) throw Object.assign(new Error('email_incomplete'), { code: 'email_incomplete' });
  // 465 numaralı port her zaman doğrudan TLS ister; orada STARTTLS seçilmişse iki taraf da
  // karşı tarafın konuşmasını bekler ve bağlantı zaman aşımına düşer. Bu yaygın karışıklık düzeltilir.
  if (Number(port) === 465 && security === 'starttls') security = 'tls';
  let socket = security === 'tls' ? tls.connect({ host, port, servername: host, ...tlsOptions }) : net.connect({ host, port });
  const reader = responseReader();
  reader.attach(socket);
  let greeted = false;
  const timer = setTimeout(() => {
    const code = greeted ? 'timeout' : 'no_greeting';
    socket.destroy(Object.assign(new Error(code), { code }));
  }, timeoutMs);
  // Sunucu karşılama satırını göndermezse port ile güvenlik türü büyük olasılıkla uyuşmuyordur.
  const greetTimer = setTimeout(() => {
    if (!greeted) socket.destroy(Object.assign(new Error('no_greeting'), { code: 'no_greeting' }));
  }, Math.min(15_000, timeoutMs));
  const step = async (line, expect) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const res = await reader.next();
    if (!expect.includes(res.code)) throw Object.assign(new Error(`smtp_${res.code}`), { code: `smtp_${res.code}`, detail: res.lines.join(' ').slice(0, 200) });
    return res;
  };
  try {
    await once(socket, security === 'tls' ? 'secureConnect' : 'connect');
    await step(null, [220]);
    greeted = true;
    let ehlo = await step(`EHLO ${clientName}`, [250]);
    if (security === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw Object.assign(new Error('starttls_unsupported'), { code: 'starttls_unsupported' });
      await step('STARTTLS', [220]);
      socket = tls.connect({ socket, servername: host, ...tlsOptions });
      reader.attach(socket);
      await once(socket, 'secureConnect');
      ehlo = await step(`EHLO ${clientName}`, [250]);
    }
    if (user) {
      const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? '';
      if (/\bLOGIN\b/i.test(auth) && !/\bPLAIN\b/i.test(auth)) {
        await step('AUTH LOGIN', [334]);
        await step(b64(user), [334]);
        await step(b64(pass), [235]);
      } else await step(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235]);
    }
    await step(`MAIL FROM:<${address(sender)}>`, [250]);
    await step(`RCPT TO:<${address(to)}>`, [250, 251]);
    await step('DATA', [354]);
    const message = buildMessage({ from: sender, to, subject, text, html });
    await step(`${message.replace(/^\./gm, '..')}\r\n.`, [250]);
    await step('QUIT', [221]).catch(() => {});
  } finally {
    clearTimeout(timer);
    clearTimeout(greetTimer);
    socket.destroy();
  }
}
