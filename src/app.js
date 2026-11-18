import path from 'node:path';
import { openDb, createSettings } from './db.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { createOllama } from './ollama.js';
import { createLlm } from './llm.js';
import { createPipeline } from './pipeline.js';
import { createAuth } from './auth.js';
import { buildDigest, getDigest, localDay, minutesOfDay, parseTime, markEmailed } from './digest.js';
import { emailDigest } from './mail.js';
import { errorCode } from './http.js';

const TICK_MS = 30_000;
const DIGEST_WAIT_MIN = 30;

export function createApp(config, { log = (m) => console.log(m), fetchImpl } = {}) {
  const db = openDb(path.join(config.dataDir, 'newsroom.db'));
  const settings = createSettings(db, DEFAULT_SETTINGS);
  const fetchOpt = fetchImpl ? { fetchImpl } : {};
  const local = createOllama({ url: config.ollamaUrl, ...fetchOpt });
  let cached = { signature: null, client: null };
  const llm = () => {
    const s = settings.all();
    const signature = JSON.stringify([s.provider, s.providerUrl, s.apiKeys?.[s.provider] ?? '']);
    if (cached.signature !== signature) cached = { signature, client: createLlm({ provider: s.provider, providerUrl: s.providerUrl, apiKeys: s.apiKeys, ollamaUrl: config.ollamaUrl, ...fetchOpt }) };
    return cached.client;
  };
  const pipeline = createPipeline({ db, settings, llm, embedder: local, allowPrivate: config.allowPrivateNetworks, log });
  const auth = createAuth({ db, config });
  const net = { allowPrivate: config.allowPrivateNetworks };

  const sched = { timer: null, ticking: false, digestBusy: false, lastCleanup: 0 };

  async function makeDigest({ email = true, now = Date.now() } = {}) {
    sched.digestBusy = true;
    try {
      const digest = await buildDigest({ db, settings, llm: llm(), now, log });
      if (email && settings.get('email').enabled) await sendDigest(digest.day);
      return getDigest(db, digest.day);
    } finally {
      sched.digestBusy = false;
    }
  }

  async function sendDigest(day) {
    const digest = getDigest(db, day);
    if (!digest) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    try {
      await emailDigest(digest, settings, config.baseUrl);
      markEmailed(db, day);
    } catch (err) {
      const code = errorCode(err);
      markEmailed(db, day, code);
      log(`özet e-postası gönderilemedi: ${code}${err.detail ? ` (${err.detail})` : ''}`);
      throw Object.assign(new Error(code), { code });
    }
  }

  function digestDue(now) {
    const s = settings.all();
    if (!s.digestEnabled || sched.digestBusy) return false;
    const minute = minutesOfDay(now);
    const at = parseTime(s.digestTime);
    if (minute < at || getDigest(db, localDay(now))) return false;
    if (!s.model || pipeline.state.llm.ok === false || pipeline.state.llm.limited || minute >= at + DIGEST_WAIT_MIN) return true;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM articles WHERE status IN ('new', 'ready') AND COALESCE(published, fetched) > ?").get(now - 86400_000).n;
    return pending === 0;
  }

  async function tick(now = Date.now()) {
    if (sched.ticking) return;
    sched.ticking = true;
    try {
      const every = settings.get('fetchMinutes') * 60_000;
      if (!pipeline.state.lastRefresh || now - pipeline.state.lastRefresh >= every) await pipeline.refreshAll();
      pipeline.work().catch((err) => log(`kuyruk hatası: ${err.message}`));
      if (digestDue(now)) await makeDigest({ now }).catch((err) => log(`özet hazırlanamadı: ${err.message}`));
      if (now - sched.lastCleanup > 6 * 3600_000) {
        sched.lastCleanup = now;
        const removed = pipeline.cleanup(now);
        if (removed) log(`${removed} eski haber silindi`);
      }
    } catch (err) {
      log(`zamanlayıcı hatası: ${err.message}`);
    } finally {
      sched.ticking = false;
    }
  }

  return {
    config,
    db,
    settings,
    llm,
    local,
    pipeline,
    auth,
    net,
    makeDigest,
    sendDigest,
    tick,
    nextRefresh: () => (pipeline.state.lastRefresh ? pipeline.state.lastRefresh + settings.get('fetchMinutes') * 60_000 : null),
    start() {
      tick();
      sched.timer = setInterval(() => tick(), TICK_MS);
      sched.timer.unref?.();
    },
    stop() {
      clearInterval(sched.timer);
      db.close();
    },
  };
}
