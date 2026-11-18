import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const SESSION_DAYS = 30;
export const COOKIE = 'nr_session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || r > 32 || p > 16) return false;
  const expected = Buffer.from(parts[5], 'base64');
  const key = crypto.scryptSync(String(password).normalize('NFC'), Buffer.from(parts[4], 'base64'), expected.length, { N, r, p, maxmem: 256 * N * r });
  return expected.length > 0 && crypto.timingSafeEqual(key, expected);
}

const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function storedPasswordHash(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'auth.password'").get();
  return row ? JSON.parse(row.value) : '';
}

export function setStoredPassword(db, password) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('auth.password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(hashPassword(password)));
  db.prepare('DELETE FROM sessions').run();
}

export function createAuth({ db, config }) {
  const envHash = config.password ? hashPassword(config.password) : '';
  const currentHash = () => envHash || config.passwordHash || storedPasswordHash(db);
  const attempts = new Map();

  return {
    required: () => Boolean(currentHash()),
    limited(ip, now = Date.now()) {
      const a = attempts.get(ip);
      return Boolean(a && a.reset > now && a.count >= 10);
    },
    login(password, ip, now = Date.now()) {
      if (typeof password !== 'string' || password.length > 1024) return null;
      if (!verifyPassword(password, currentHash())) {
        const a = attempts.get(ip);
        if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + 15 * 60_000 });
        else a.count++;
        if (attempts.size > 10_000) attempts.clear();
        return null;
      }
      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (token_hash, created, expires) VALUES (?, ?, ?)').run(digest(token), now, now + SESSION_DAYS * 86400_000);
      return token;
    },
    check(token, now = Date.now()) {
      if (!token || token.length > 100) return false;
      const row = db.prepare('SELECT expires FROM sessions WHERE token_hash = ?').get(digest(token));
      if (!row || row.expires < now) return false;
      if (row.expires - now < (SESSION_DAYS - 1) * 86400_000) db.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?').run(now + SESSION_DAYS * 86400_000, digest(token));
      return true;
    },
    logout(token) {
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
    },
    maxAge: SESSION_DAYS * 86400,
  };
}
