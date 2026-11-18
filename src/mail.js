import { t, LOCALES } from '../public/i18n.js';
import { sendMail } from './smtp.js';

// Günlük özetin e-posta hâli. E-posta istemcileri harici CSS desteklemediği için biçim satır
// içi stillerle verilir; görseller gömülmez, yalnızca bağlantılar vardır.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');

export function formatDay(day, language) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(LOCALES[language] ?? 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function renderDigestEmail(digest, { language = 'tr', baseUrl = '' } = {}) {
  const L = (k, v) => t(language, k, v);
  const date = formatDay(digest.day, language);
  const time = new Date(digest.created).toLocaleTimeString(LOCALES[language] ?? 'en-GB', { hour: '2-digit', minute: '2-digit' });
  const subject = L('email.subject', { date });
  const serif = "Georgia,'Times New Roman',serif";
  const sans = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

  const textParts = [subject, ''];
  if (digest.intro) textParts.push(digest.intro, '');
  const htmlSections = [];
  for (const section of digest.sections) {
    const heading = L(`cat.${section.category}`);
    textParts.push(heading.toLocaleUpperCase(LOCALES[language]), '');
    const items = section.items.map((i) => {
      textParts.push(`• ${i.title}`, `  ${i.summary}`, `  ${i.source} — ${i.url}`, '');
      const also = i.others?.length ? ` · ${esc(L('article.sources', { n: i.others.length + 1 }))}` : '';
      return `<tr><td style="padding:0 0 18px 0">
        <a href="${esc(safeUrl(i.url))}" style="font-family:${serif};font-size:19px;line-height:1.3;color:#141414;text-decoration:none;font-weight:bold">${esc(i.title)}</a>
        <p style="margin:6px 0 4px 0;font-family:${serif};font-size:15px;line-height:1.55;color:#333">${esc(i.summary)}</p>
        <p style="margin:0;font-family:${sans};font-size:12px;color:#777">${esc(i.source)}${also}</p>
      </td></tr>`;
    });
    htmlSections.push(`<tr><td style="padding:10px 0 12px 0;border-top:1px solid #141414">
      <p style="margin:0;font-family:${sans};font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a3241b;font-weight:bold">${esc(heading)}</p>
    </td></tr>${items.join('')}`);
  }
  const open = baseUrl ? `<p style="margin:8px 0 0 0;font-family:${sans};font-size:13px"><a href="${esc(baseUrl)}" style="color:#a3241b">${esc(L('email.open'))}</a></p>` : '';
  if (baseUrl) textParts.push(`${L('email.open')}: ${baseUrl}`, '');
  textParts.push(L('email.footer', { time }));

  const html = `<!doctype html><html lang="${esc(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fffdf8;border:1px solid #e2ddd1"><tr><td style="padding:28px 28px 8px 28px">
  <p style="margin:0;font-family:${serif};font-size:30px;font-weight:bold;color:#141414">Newsroom</p>
  <p style="margin:4px 0 18px 0;font-family:${sans};font-size:13px;color:#666">${esc(date)}</p>
  ${digest.intro ? `<p style="margin:0 0 22px 0;font-family:${serif};font-size:17px;line-height:1.6;color:#222;font-style:italic">${esc(digest.intro)}</p>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${htmlSections.join('')}</table>
</td></tr><tr><td style="padding:12px 28px 24px 28px;border-top:1px solid #e2ddd1">
  <p style="margin:0;font-family:${sans};font-size:12px;color:#888">${esc(L('email.footer', { time }))}</p>${open}
</td></tr></table>
</td></tr></table></body></html>`;

  return { subject, text: textParts.join('\n'), html };
}

export async function emailDigest(digest, settings, baseUrl) {
  const s = settings.all();
  const mail = renderDigestEmail(digest, { language: s.language, baseUrl });
  await sendMail({ ...s.email, ...mail });
}

export async function sendTestEmail(settings) {
  const s = settings.all();
  const L = (k) => t(s.language, k);
  await sendMail({ ...s.email, subject: L('email.testSubject'), text: L('email.testBody'), html: null });
}
