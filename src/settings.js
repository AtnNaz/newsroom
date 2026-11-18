// Arayüzden değiştirilebilen ayarlar ve doğrulamaları. Ollama adresi, sunucu portu ve şifre
// gibi kurulum ayarları config.json'da durur (bkz. config.js).

export const CATEGORIES = ['ai', 'tech', 'software', 'hardware', 'science', 'space', 'security', 'games', 'business', 'economy', 'politics', 'world', 'turkey', 'health', 'sports', 'culture', 'auto', 'other'];
export const LANGUAGES = ['tr', 'en'];
export const FETCH_MINUTES = [15, 30, 60, 120, 240];
export const RETENTION_DAYS = [7, 14, 30, 60, 90];

export const DEFAULT_SETTINGS = {
  language: 'tr',
  interests: [],
  model: '',
  embedModel: '',
  fetchMinutes: 30,
  retentionDays: 30,
  digestEnabled: true,
  digestTime: '07:00',
  digestSize: 15,
  minRelevance: 30,
  email: { enabled: false, host: '', port: 587, security: 'starttls', user: '', pass: '', from: '', to: '' },
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const str = (v, max) => typeof v === 'string' && v.length <= max && !/[\0\r\n]/.test(v);

// Yalnızca bilinen alanlar kabul edilir. pass boş bırakılırsa kayıtlı şifre korunur.
export function validateSettings(input, current = DEFAULT_SETTINGS) {
  const errors = [];
  const value = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['invalid'], value };
  for (const [k, v] of Object.entries(input)) {
    switch (k) {
      case 'language':
        LANGUAGES.includes(v) ? (value[k] = v) : errors.push(k);
        break;
      case 'interests':
        if (Array.isArray(v) && v.length <= 40 && v.every((s) => str(s, 80) && s.trim())) value[k] = [...new Set(v.map((s) => s.trim()))];
        else errors.push(k);
        break;
      case 'model':
      case 'embedModel':
        v === '' || (typeof v === 'string' && MODEL.test(v)) ? (value[k] = v) : errors.push(k);
        break;
      case 'fetchMinutes':
        FETCH_MINUTES.includes(v) ? (value[k] = v) : errors.push(k);
        break;
      case 'retentionDays':
        RETENTION_DAYS.includes(v) ? (value[k] = v) : errors.push(k);
        break;
      case 'digestEnabled':
        typeof v === 'boolean' ? (value[k] = v) : errors.push(k);
        break;
      case 'digestTime':
        typeof v === 'string' && TIME.test(v) ? (value[k] = v) : errors.push(k);
        break;
      case 'digestSize':
        Number.isInteger(v) && v >= 5 && v <= 40 ? (value[k] = v) : errors.push(k);
        break;
      case 'minRelevance':
        Number.isInteger(v) && v >= 0 && v <= 90 ? (value[k] = v) : errors.push(k);
        break;
      case 'email': {
        const e = { ...current.email };
        if (!v || typeof v !== 'object') {
          errors.push(k);
          break;
        }
        for (const [ek, ev] of Object.entries(v)) {
          if (ek === 'enabled' && typeof ev === 'boolean') e.enabled = ev;
          else if (ek === 'host' && (ev === '' || (typeof ev === 'string' && HOST.test(ev)))) e.host = ev;
          else if (ek === 'port' && Number.isInteger(ev) && ev > 0 && ev < 65536) e.port = ev;
          else if (ek === 'security' && ['starttls', 'tls', 'none'].includes(ev)) e.security = ev;
          else if (ek === 'user' && str(ev, 200)) e.user = ev;
          else if (ek === 'pass' && str(ev, 200)) {
            if (ev !== '') e.pass = ev;
          } else if ((ek === 'from' || ek === 'to') && (ev === '' || (typeof ev === 'string' && EMAIL.test(ev)))) e[ek] = ev;
          else errors.push(`email.${ek}`);
        }
        if (e.enabled && (!e.host || !e.to || !(e.from || e.user))) errors.push('email.incomplete');
        value.email = e;
        break;
      }
      default:
        errors.push(k);
    }
  }
  return { errors, value };
}

// Arayüze giden ayarlar: e-posta şifresi gönderilmez, yalnızca kayıtlı olup olmadığı.
export function publicSettings(s) {
  const { pass, ...email } = s.email;
  return { ...s, email: { ...email, passSet: Boolean(pass) } };
}
