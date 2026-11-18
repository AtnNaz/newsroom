import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { sendMail, buildMessage, encodeHeader } from '../src/smtp.js';
import { renderDigestEmail } from '../src/mail.js';

// Tek bağlantılık sahte SMTP sunucusu; konuşmayı ve iletinin gövdesini kaydeder.
async function fakeSmtp({ auth = 'PLAIN LOGIN', starttls = false } = {}) {
  const log = [];
  let data = '';
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    const say = (s) => sock.write(`${s}\r\n`);
    say('220 test.local ESMTP');
    sock.on('data', (d) => {
      buf += d.toString();
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        say('250 queued');
      }
      let i;
      while (!inData && (i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        log.push(line);
        if (/^EHLO/.test(line)) sock.write(`250-test.local\r\n${auth ? `250-AUTH ${auth}\r\n` : ''}${starttls ? '250-STARTTLS\r\n' : ''}250 SIZE 1000000\r\n`);
        else if (/^AUTH PLAIN /.test(line)) say(Buffer.from(line.slice(11), 'base64').toString() === '\0deniz@example.com\0parola' ? '235 ok' : '535 bad');
        else if (/^(MAIL|RCPT)/.test(line)) say('250 ok');
        else if (line === 'DATA') {
          say('354 go');
          inData = true;
          sock.emit('data', Buffer.alloc(0));
        } else if (line === 'QUIT') {
          say('221 bye');
          sock.end();
        } else say('500 unknown');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, log, data: () => data, close: () => server.close() };
}

test('başlık kodlaması ve MIME iletisi', () => {
  assert.equal(encodeHeader('Hello'), 'Hello');
  const enc = encodeHeader('Newsroom · 18 Kasım 2026 Çarşamba günün öne çıkan haberleri');
  assert.match(enc, /^=\?UTF-8\?B\?/);
  const decoded = enc.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString()).join('');
  assert.equal(decoded, 'Newsroom · 18 Kasım 2026 Çarşamba günün öne çıkan haberleri');
  const msg = buildMessage({ from: 'bot@example.com', to: 'deniz@example.com', subject: 'Özet', text: 'metin', html: '<p>html</p>' });
  assert.match(msg, /multipart\/alternative/);
  assert.match(msg, /Message-ID: <[0-9a-f-]+@example\.com>/);
  assert.ok(msg.split('\r\n').every((l) => l.length <= 998));
});

test('SMTP: AUTH PLAIN ile gönderim', async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail({ host: '127.0.0.1', port: srv.port, security: 'none', user: 'deniz@example.com', pass: 'parola', to: 'deniz@example.com', subject: 'Deneme', text: '.nokta ile başlayan satır', html: '<p>x</p>' });
    assert.ok(srv.log.includes('MAIL FROM:<deniz@example.com>'));
    assert.ok(srv.log.includes('RCPT TO:<deniz@example.com>'));
    const body = srv.data();
    assert.match(body, /Subject: Deneme/);
    const plain = /charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(body)[1];
    assert.equal(Buffer.from(plain.replace(/\r\n/g, ''), 'base64').toString(), '.nokta ile başlayan satır');
  } finally {
    srv.close();
  }
});

test('SMTP: STARTTLS istenip sunucu desteklemiyorsa şifre gönderilmez', async () => {
  const srv = await fakeSmtp();
  try {
    await assert.rejects(sendMail({ host: '127.0.0.1', port: srv.port, security: 'starttls', user: 'u', pass: 'p', to: 'a@example.com', subject: 's', text: 't' }), /starttls_unsupported/);
    assert.ok(!srv.log.some((l) => l.startsWith('AUTH')));
  } finally {
    srv.close();
  }
});

test('SMTP: hatalı şifre anlaşılır bir hata verir', async () => {
  const srv = await fakeSmtp();
  try {
    await assert.rejects(sendMail({ host: '127.0.0.1', port: srv.port, security: 'none', user: 'deniz@example.com', pass: 'yanlış', to: 'a@example.com', subject: 's', text: 't' }), /smtp_535/);
  } finally {
    srv.close();
  }
});

test('özet e-postası metin ve HTML üretir, içerik kaçışlanır', () => {
  const digest = {
    day: '2026-11-18',
    created: Date.parse('2026-11-18T07:00:00'),
    intro: 'Günün <b>özeti</b>.',
    sections: [{ category: 'ai', items: [{ id: 1, title: 'Başlık <script>', summary: 'Özet', url: 'https://example.com/1', source: 'Örnek', others: [{ source: 'Diğer', url: 'https://example.org/1' }] }] }],
  };
  const mail = renderDigestEmail(digest, { language: 'tr', baseUrl: 'https://haber.example' });
  assert.match(mail.subject, /^Newsroom · 18 Kasım 2026/);
  assert.match(mail.html, /Başlık &lt;script&gt;/);
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.html, /2 kaynak/);
  assert.match(mail.text, /YAPAY ZEKÂ/);
  assert.match(mail.text, /https:\/\/haber\.example/);
  const en = renderDigestEmail(digest, { language: 'en' });
  assert.match(en.subject, /Wednesday, 18 November 2026/);
});
