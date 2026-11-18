#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, isLoopback } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createServer } from '../src/server.js';
import { setStoredPassword } from '../src/auth.js';
import { addSource, importOpml } from '../src/sources.js';
import { renderDigestEmail } from '../src/mail.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `Newsroom ${VERSION} — yerel yapay zekâ ile kişisel haber özeti

Kullanım: newsroom <komut> [--config dosya]

Komutlar:
  serve              Web arayüzünü ve zamanlayıcıyı başlatır
  password           Giriş şifresini belirler (veritabanına scrypt özeti yazılır)
  add <adres>        Kaynak ekler (RSS/Atom adresi ya da sitenin ana sayfası)
  import <opml>      OPML dosyasındaki kaynakları ekler
  refresh            Kaynakları bir kez yeniler ve kuyruğu işler
  digest [--email]   Bugünün özetini hazırlar ve yazdırır; --email ile gönderir
  version            Sürümü yazdırır

Ayar dosyası: --config, yoksa NEWSROOM_CONFIG, yoksa ./config.json`;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const configPath = flag('--config') ?? process.env.NEWSROOM_CONFIG ?? path.resolve('config.json');
const emailFlag = args.includes('--email');
const rest = args.filter((a) => a !== '--email');
const [command = 'help', ...params] = rest;

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`${stamp()} ${m}`);

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (d) => (data += d));
      input.on('end', () => resolve(data.split(/\r?\n/)[0]));
      input.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') {
          input.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') return console.log(HELP);
  if (command === 'version' || command === '--version') return console.log(VERSION);

  const config = loadConfig(configPath);
  const app = createApp(config, { log });

  switch (command) {
    case 'serve': {
      if (!app.auth.required() && !isLoopback(config.host)) {
        console.error(`Şifre belirlenmemiş ve sunucu ${config.host} adresinde dinleyecek.\nÖnce şifre belirleyin: newsroom password --config ${configPath}\n(ya da NEWSROOM_PASSWORD ortam değişkenini verin)`);
        process.exit(1);
      }
      const server = createServer(app);
      server.listen(config.port, config.host, () => {
        log(`Newsroom ${VERSION} http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port} adresinde`);
        if (!app.auth.required()) log('Uyarı: şifre yok; yalnızca bu makineden erişilebilir.');
        app.start();
      });
      const shutdown = () => {
        server.close();
        app.stop();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      return;
    }
    case 'password': {
      const a = await readSecret('Yeni şifre: ');
      if (a.length < 8) throw new Error('Şifre en az 8 karakter olmalı.');
      if (process.stdin.isTTY) {
        const b = await readSecret('Tekrar: ');
        if (a !== b) throw new Error('Şifreler aynı değil.');
      }
      setStoredPassword(app.db, a);
      console.log('Şifre kaydedildi; açık oturumlar kapatıldı.');
      break;
    }
    case 'add': {
      if (!params[0]) throw new Error('Kullanım: newsroom add <adres>');
      const out = await addSource(app.db, params[0], { net: app.net });
      if (out.candidates) {
        console.log('Bu sayfada birden fazla besleme var, birini seçip tekrar çalıştırın:');
        for (const c of out.candidates) console.log(`  ${c.url}${c.title ? `  (${c.title})` : ''}`);
      } else console.log(`Eklendi: ${out.source.title} — ${out.source.url}`);
      break;
    }
    case 'import': {
      if (!params[0]) throw new Error('Kullanım: newsroom import <dosya.opml>');
      const out = importOpml(app.db, readFileSync(params[0], 'utf8'));
      console.log(`${out.added} yeni kaynak eklendi (${out.total} besleme okundu).`);
      break;
    }
    case 'refresh': {
      const r = await app.pipeline.refreshAll();
      log(`${r.added} yeni haber`);
      await app.pipeline.work();
      log(`kuyruk: ${JSON.stringify(app.pipeline.queue())}`);
      break;
    }
    case 'digest': {
      const digest = await app.makeDigest({ email: false });
      const s = app.settings.all();
      console.log(renderDigestEmail(digest, { language: s.language, baseUrl: config.baseUrl }).text);
      if (emailFlag) {
        await app.sendDigest(digest.day);
        console.log(`\nE-posta gönderildi: ${s.email.to}`);
      }
      break;
    }
    default:
      console.error(`Bilinmeyen komut: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
  app.stop();
}

main().catch((err) => {
  console.error(err.code ? `Hata: ${err.code}${err.detail ? ` — ${err.detail}` : ''}` : `Hata: ${err.message}`);
  process.exit(1);
});
