import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 8077,
  dataDir: './data',
  ollamaUrl: 'http://127.0.0.1:11434',
  baseUrl: '',
  passwordHash: '',
  trustProxy: false,
  allowPrivateNetworks: false,
};

const ENV = {
  NEWSROOM_HOST: 'host',
  NEWSROOM_PORT: 'port',
  NEWSROOM_DATA_DIR: 'dataDir',
  NEWSROOM_OLLAMA_URL: 'ollamaUrl',
  OLLAMA_URL: 'ollamaUrl',
  NEWSROOM_BASE_URL: 'baseUrl',
  NEWSROOM_PASSWORD_HASH: 'passwordHash',
  NEWSROOM_TRUST_PROXY: 'trustProxy',
  NEWSROOM_ALLOW_PRIVATE_NETWORKS: 'allowPrivateNetworks',
};

const httpUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

export function loadConfig(file, env = process.env) {
  let fromFile = {};
  if (file && existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json okunamadı (${file}): ${err.message}`);
    }
  }
  const c = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) if (k in fromFile) c[k] = fromFile[k];
  for (const [name, key] of Object.entries(ENV)) {
    if (env[name] === undefined || env[name] === '') continue;
    c[key] = typeof DEFAULT_CONFIG[key] === 'boolean' ? /^(1|true|yes)$/i.test(env[name]) : typeof DEFAULT_CONFIG[key] === 'number' ? Number(env[name]) : env[name];
  }
  c.password = env.NEWSROOM_PASSWORD || '';

  const errors = [];
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) errors.push('port');
  if (typeof c.host !== 'string' || !c.host) errors.push('host');
  if (!httpUrl(c.ollamaUrl)) errors.push('ollamaUrl');
  if (c.baseUrl && !httpUrl(c.baseUrl)) errors.push('baseUrl');
  if (c.passwordHash && !/^scrypt\$/.test(c.passwordHash)) errors.push('passwordHash');
  if (errors.length) throw new Error(`Geçersiz ayar: ${errors.join(', ')}`);

  c.baseUrl = c.baseUrl.replace(/\/+$/, '');
  c.dataDir = path.resolve(file ? path.dirname(path.resolve(file)) : process.cwd(), c.dataDir);
  return c;
}

export const isLoopback = (host) => host === '127.0.0.1' || host === '::1' || host === 'localhost';
