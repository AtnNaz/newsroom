import { t as translate, LOCALES } from './i18n.js';
import { PROVIDERS, providerById } from './providers.js';

const state = { lang: 'tr', session: null, status: null, settings: null, feed: { sort: 'score', category: '', q: '' } };
const t = (k, v) => translate(state.lang, k, v);
const $app = document.getElementById('app');
const $reader = document.getElementById('reader');

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const ICONS = {
  up: 'M12 5l7 8h-4.5v6h-5v-6H5z',
  down: 'M12 19l-7-8h4.5V5h5v6H19z',
  save: 'M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${name}`);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    state.session = { ...state.session, authenticated: false };
    renderLogin();
    throw Object.assign(new Error('auth'), { code: 'auth' });
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `http_${res.status}`), { code: data.error, fields: data.fields, detail: data.detail, status: res.status });
  return data;
}

const locale = () => LOCALES[state.lang] ?? 'en-GB';
function relTime(ms) {
  if (!ms) return t('common.never');
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return t('time.now');
  if (s < 3600) return t('time.min', { n: Math.round(s / 60) });
  if (s < 86400) return t('time.hour', { n: Math.round(s / 3600) });
  return t('time.day', { n: Math.round(s / 86400) });
}
const longDate = (d) => d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const errMessage = (code) => (t(`err.${code}`) !== `err.${code}` ? t(`err.${code}`) : null);
const errText = (err) => {
  if (err.fields) return t('settings.invalid', { fields: err.fields.join(', ') });
  const known = errMessage(err.code);
  if (known) return known;
  return `${t('common.error')}: ${err.code ?? err.message}${err.detail ? ` (${err.detail})` : ''}`;
};

const MAIL_PROVIDERS = {
  gmail: { host: 'smtp.gmail.com', port: 587, security: 'starttls', help: 'https://myaccount.google.com/apppasswords', user: 'ad@gmail.com' },
  icloud: { host: 'smtp.mail.me.com', port: 587, security: 'starttls', help: 'https://account.apple.com/', user: 'ad@icloud.com' },
  yandex: { host: 'smtp.yandex.com', port: 465, security: 'tls', help: 'https://id.yandex.com/security/app-passwords', user: 'ad@yandex.com' },
};
const providerOf = (host) => Object.keys(MAIL_PROVIDERS).find((k) => MAIL_PROVIDERS[k].host === host) ?? (host ? 'custom' : 'gmail');

function toast(text, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 4200);
}

function renderLogin(message = '') {
  stopPolling();
  document.documentElement.lang = state.lang;
  const input = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, autofocus: true });
  const err = h('p', { class: 'form-error', role: 'alert' }, message);
  const form = h(
    'form',
    {
      class: 'login',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', 'login', { password: input.value });
          await boot();
        } catch (ex) {
          err.textContent = ex.code === 'limited' ? t('login.limited') : t('login.wrong');
          input.select();
        }
      },
    },
    h('h1', { class: 'masthead-title' }, 'Newsroom'),
    h('label', { for: 'pw' }, t('login.password')),
    input,
    err,
    h('button', { class: 'btn btn-primary', type: 'submit' }, t('login.submit')),
  );
  $app.replaceChildren(h('main', { class: 'login-wrap' }, form));
  input.focus();
}

const VIEWS = [
  ['today', '#/'],
  ['feed', '#/feed'],
  ['saved', '#/saved'],
  ['sources', '#/sources'],
  ['settings', '#/settings'],
];

let $main;
let $status;
function renderShell() {
  document.documentElement.lang = state.lang;
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Newsroom' },
    VIEWS.map(([key, href]) => h('a', { href, 'data-view': key }, t(`nav.${key}`))),
  );
  $main = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  $status = h('span', { class: 'status-line' });
  const logout = state.session.authRequired
    ? h(
        'button',
        {
          class: 'link-btn',
          onclick: async () => {
            await api('POST', 'logout', {}).catch(() => {});
            renderLogin();
          },
        },
        t('common.logout'),
      )
    : null;
  $app.replaceChildren(
    h('header', { class: 'masthead' }, h('div', { class: 'masthead-date' }, longDate(new Date())), h('a', { class: 'masthead-title', href: '#/' }, 'Newsroom'), nav),
    $main,
    h('footer', { class: 'footer' }, $status, h('span', { class: 'footer-right' }, h('span', { class: 'muted' }, `v${state.session.version}`), logout)),
  );
}

function setActiveNav(view) {
  for (const a of document.querySelectorAll('.nav a')) a.toggleAttribute('aria-current', a.dataset.view === view);
}

let pollTimer = null;
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
async function pollStatus() {
  try {
    state.status = await api('GET', 'status');
  } catch {
    return;
  }
  const s = state.status;
  const pending = s.queue.new + s.queue.ready;
  const parts = [];
  if (s.current) parts.push(t('feed.analyzing', { title: s.current.title }));
  else if (pending && s.model) parts.push(t('feed.queue', { n: pending }));
  const providerName = providerLabel(s.provider);
  if (s.llm.limited) parts.push(t('status.limited', { n: s.dailyLimit }));
  else if (s.llm.ok === false) parts.push(t('settings.providerDown', { provider: providerName, error: llmError(s.llm.error) }));
  parts.push(`${t('status.lastRefresh')}: ${s.refreshing ? t('sources.refreshing') : relTime(s.lastRefresh)}`);
  $status.textContent = parts.join(' · ');
  $status.classList.toggle('status-warn', s.llm.ok === false || s.llm.limited);
}

const NET_CODES = ['refused', 'dns', 'timeout', 'network', 'reset', 'tls'];
const llmError = (code) => (NET_CODES.includes(code) ? t('err.llm_unreachable') : errMessage(code) ?? code);
const providerLabel = (id) => (id === 'ollama' ? t('settings.providerLocal') : providerById(id).label);

function sourcesLine(item) {
  const n = (item.others?.length ?? 0) + 1;
  return h('span', { class: 'meta' }, h('span', { class: 'meta-source' }, item.source?.title ?? item.source), ' · ', relTime(item.published), n > 1 ? h('span', { class: 'meta-count' }, ` · ${t('article.sources', { n })}`) : null);
}

function feedbackButtons(item, onChange) {
  const setFb = async (value) => {
    const next = item.feedback === value ? 0 : value;
    await api('PATCH', `articles/${item.id}`, { feedback: next });
    item.feedback = next;
    onChange?.();
  };
  const toggleSave = async () => {
    await api('PATCH', `articles/${item.id}`, { saved: !item.saved });
    item.saved = !item.saved;
    onChange?.();
  };
  return h(
    'div',
    { class: 'actions' },
    h('button', { class: 'icon-btn', 'aria-pressed': String(item.feedback === 1), title: t('article.like'), 'aria-label': t('article.like'), onclick: () => setFb(1) }, icon('up')),
    h('button', { class: 'icon-btn', 'aria-pressed': String(item.feedback === -1), title: t('article.dislike'), 'aria-label': t('article.dislike'), onclick: () => setFb(-1) }, icon('down')),
    h('button', { class: 'icon-btn', 'aria-pressed': String(item.saved), title: item.saved ? t('article.unsave') : t('article.save'), 'aria-label': item.saved ? t('article.unsave') : t('article.save'), onclick: toggleSave }, icon('save')),
  );
}

function thumb(src, cls = 'thumb') {
  if (!src) return null;
  const img = h('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function articleCard(item) {
  const card = h('article', { class: `card${item.read ? ' is-read' : ''}${item.feedback === -1 ? ' is-down' : ''}` });
  const draw = () => {
    card.className = `card${item.read ? ' is-read' : ''}${item.feedback === -1 ? ' is-down' : ''}`;
    card.replaceChildren(
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'kicker' }, item.category ? t(`cat.${item.category}`) : t('article.notAnalyzed')),
        h('h2', { class: 'card-title' }, h('a', { href: `#/article/${item.id}`, onclick: (e) => (e.preventDefault(), openReader(item.id, item)) }, item.title)),
        item.summary ? h('p', { class: 'card-summary' }, item.summary) : null,
        h('div', { class: 'card-foot' }, sourcesLine(item), feedbackButtons(item, draw)),
      ),
      ...[thumb(item.image)].filter(Boolean),
    );
  };
  draw();
  return card;
}

async function openReader(id, preview) {
  $reader.replaceChildren(h('p', { class: 'muted pad' }, t('common.loading')));
  if (!$reader.open) $reader.showModal();
  let a;
  try {
    a = await api('GET', `articles/${id}`);
  } catch (err) {
    if (preview?.url) window.open(preview.url, '_blank', 'noopener');
    $reader.close();
    return;
  }
  if (!a.read) api('PATCH', `articles/${id}`, { read: true }).catch(() => {});
  if (preview) preview.read = true;
  const why = a.why
    ? h(
        'details',
        { class: 'why' },
        h('summary', {}, `${t('article.why')} · ${t('article.relevance')} ${a.relevance ?? '—'}`),
        a.reason ? h('p', {}, a.reason) : null,
        h('p', { class: 'muted small' }, Object.entries(a.why).filter(([, v]) => Math.round(v) !== 0).map(([k, v]) => `${t(`why.${k}`)} ${v > 0 ? '+' : ''}${Math.round(v)}`).join(' · ')),
      )
    : null;
  const paragraphs = (a.text || '').split(/\n{2,}/).filter(Boolean).slice(0, 80);
  $reader.replaceChildren(
    h(
      'div',
      { class: 'reader' },
      h('div', { class: 'reader-top' }, h('span', { class: 'kicker' }, a.category ? t(`cat.${a.category}`) : ''), h('button', { class: 'link-btn', onclick: () => $reader.close(), autofocus: true }, t('common.close'))),
      h('h1', { id: 'reader-title', class: 'reader-title' }, a.title),
      a.originalTitle !== a.title ? h('p', { class: 'reader-original', lang: '' }, a.originalTitle) : null,
      h('div', { class: 'reader-meta' }, sourcesLine(a), feedbackButtons(a)),
      a.summary ? h('p', { class: 'reader-summary' }, a.summary) : null,
      a.tags?.length ? h('p', { class: 'tags' }, a.tags.map((tag) => h('span', { class: 'tag' }, tag))) : null,
      why,
      h('p', {}, h('a', { class: 'btn', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, t('article.original'), ' ', icon('ext'))),
      a.others?.length
        ? h('section', { class: 'also' }, h('h2', { class: 'section-label' }, t('article.alsoAt')), h('ul', {}, a.others.map((o) => h('li', {}, h('a', { href: o.url, target: '_blank', rel: 'noopener noreferrer' }, o.source), ' — ', o.title))))
        : null,
      h('section', { class: 'reader-text' }, h('h2', { class: 'section-label' }, t('article.fullText')), paragraphs.length ? paragraphs.map((p) => h('p', {}, p)) : h('p', { class: 'muted' }, t('article.noText'))),
    ),
  );
}
$reader.addEventListener('click', (e) => {
  if (e.target === $reader) $reader.close();
});

async function viewToday(day) {
  const data = await api('GET', `digests/${day ?? 'today'}`);
  const list = await api('GET', 'digests');
  const d = data.digest;
  const previous = list.items.filter((x) => x.day !== d?.day).slice(0, 14);
  const prevNav = previous.length
    ? h('aside', { class: 'previous' }, h('h2', { class: 'section-label' }, t('today.previous')), h('ul', {}, previous.map((x) => h('li', {}, h('a', { href: `#/day/${x.day}` }, dayDate(x.day).toLocaleDateString(locale(), { day: 'numeric', month: 'long', weekday: 'short' })), h('span', { class: 'muted' }, ` · ${t('today.stories', { n: x.count })}`)))))
    : null;

  const buildBtn = (label) =>
    h(
      'button',
      {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = t('today.building');
          try {
            await api('POST', 'digests/build', {});
            route();
          } catch (err) {
            toast(errText(err), 'error');
            e.target.disabled = false;
            e.target.textContent = label;
          }
        },
      },
      label,
    );

  if (!d) {
    const time = state.status?.digest.time ?? '07:00';
    return [h('section', { class: 'empty' }, h('p', { class: 'empty-title' }, t('today.empty')), h('p', { class: 'muted' }, t('today.emptyHint', { time })), buildBtn(t('today.build'))), prevNav];
  }

  const emailLine = d.emailedAt ? t('today.emailed', { time: new Date(d.emailedAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }) : d.emailError ? t('today.emailError', { error: errMessage(d.emailError) ?? d.emailError }) : null;
  const sendBtn = state.settings?.email.enabled
    ? h(
        'button',
        {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api('POST', `digests/${d.day}/email`, {});
              toast(t('settings.emailSent'));
              route();
            } catch (err) {
              toast(errText(err), 'error');
              e.target.disabled = false;
            }
          },
        },
        t('today.sendEmail'),
      )
    : null;

  const sections = d.sections.map((s) => {
    const [lead, ...rest] = s.items;
    const story = (i, isLead) =>
      h(
        'article',
        { class: isLead ? 'story story-lead' : 'story' },
        h(
          'div',
          { class: 'story-text' },
          h('h3', { class: 'story-title' }, h('a', { href: `#/article/${i.id}`, onclick: (e) => (e.preventDefault(), openReader(i.id, i)) }, i.title)),
          h('p', { class: 'story-summary' }, i.summary),
          h('p', { class: 'meta' }, h('span', { class: 'meta-source' }, i.source), i.others?.length ? ` · ${t('article.sources', { n: i.others.length + 1 })}` : ''),
        ),
        isLead ? thumb(i.image, 'story-image') : null,
      );
    return h('section', { class: 'digest-section' }, h('h2', { class: 'section-label' }, t(`cat.${s.category}`)), story(lead, true), rest.length ? h('div', { class: 'story-grid' }, rest.map((i) => story(i, false))) : null);
  });

  return [
    h(
      'div',
      { class: 'digest-head' },
      day ? h('p', { class: 'digest-day' }, longDate(dayDate(d.day))) : null,
      d.intro ? h('p', { class: 'digest-intro' }, d.intro) : !d.model ? h('p', { class: 'muted' }, t('today.noModel')) : null,
    ),
    ...sections,
    h('div', { class: 'digest-tools' }, emailLine ? h('span', { class: 'muted small' }, emailLine) : null, sendBtn, !day ? buildBtn(t('today.rebuild')) : null),
    prevNav,
  ];
}

async function viewList(view) {
  const f = state.feed;
  const listEl = h('div', { class: 'list' });
  const moreBtn = h('button', { class: 'btn more', hidden: true }, t('common.more'));
  let offset = 0;
  async function load(reset) {
    if (reset) {
      offset = 0;
      listEl.replaceChildren(h('p', { class: 'muted pad' }, t('common.loading')));
    }
    const qs = new URLSearchParams({ view, sort: f.sort, offset: String(offset), limit: '30' });
    if (view === 'feed' && f.category) qs.set('category', f.category);
    if (view === 'feed' && f.q) qs.set('q', f.q);
    const data = await api('GET', `articles?${qs}`);
    if (reset) listEl.replaceChildren();
    if (!data.items.length && offset === 0) listEl.append(h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, view === 'saved' ? t('saved.empty') : t('feed.empty')), view === 'feed' && !state.status?.sources ? h('p', { class: 'muted' }, h('a', { href: '#/sources' }, t('feed.emptyHint'))) : null));
    listEl.append(...data.items.map(articleCard));
    offset += data.items.length;
    moreBtn.hidden = !data.more;
  }
  moreBtn.onclick = () => load(false);

  if (view === 'saved') {
    await load(true);
    return [listEl, moreBtn];
  }
  const chips = h(
    'div',
    { class: 'chips', role: 'group' },
    ['', 'ai', 'tech', 'software', 'hardware', 'science', 'space', 'security', 'games', 'business', 'economy', 'politics', 'world', 'turkey', 'health', 'sports', 'culture', 'auto', 'other'].map((c) =>
      h(
        'button',
        {
          class: 'chip',
          'aria-pressed': String(f.category === c),
          onclick: (e) => {
            f.category = c;
            for (const b of chips.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            load(true);
          },
        },
        c ? t(`cat.${c}`) : t('common.all'),
      ),
    ),
  );
  const sortBtns = h(
    'div',
    { class: 'segmented', role: 'group' },
    [
      ['score', t('feed.sortScore')],
      ['new', t('feed.sortNew')],
    ].map(([k, label]) =>
      h(
        'button',
        {
          'aria-pressed': String(f.sort === k),
          onclick: (e) => {
            f.sort = k;
            for (const b of sortBtns.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
            load(true);
          },
        },
        label,
      ),
    ),
  );
  let timer;
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: t('common.search'),
    'aria-label': t('common.search'),
    value: f.q,
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        f.q = e.target.value.trim();
        load(true);
      }, 300);
    },
  });
  await load(true);
  return [h('div', { class: 'toolbar' }, sortBtns, search), chips, listEl, moreBtn];
}

async function viewSources() {
  const [{ items }, { items: suggestions }] = await Promise.all([api('GET', 'sources'), api('GET', 'sources/suggestions')]);
  const urlInput = h('input', { type: 'url', id: 'src-url', placeholder: 'https://', required: true, inputmode: 'url', autocomplete: 'off' });
  const fullText = h('input', { type: 'checkbox', id: 'src-full', checked: true });
  const pick = h('div', { class: 'pick' });
  const addBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, t('sources.add'));

  async function add(url) {
    addBtn.disabled = true;
    addBtn.textContent = t('sources.adding');
    pick.replaceChildren();
    try {
      const out = await api('POST', 'sources', { url, full_text: fullText.checked });
      if (out.candidates) {
        pick.append(h('p', {}, t('sources.pick')), h('ul', {}, out.candidates.map((c) => h('li', {}, h('button', { class: 'link-btn', type: 'button', onclick: () => add(c.url) }, c.title || c.url), h('span', { class: 'muted small' }, ` ${c.url}`)))));
      } else {
        urlInput.value = '';
        route();
      }
    } catch (err) {
      toast(errText(err), 'error');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = t('sources.add');
    }
  }

  const form = h(
    'form',
    { class: 'add-source', onsubmit: (e) => (e.preventDefault(), add(urlInput.value)) },
    h('label', { for: 'src-url' }, t('sources.addHint')),
    h('div', { class: 'row' }, urlInput, addBtn),
    h('label', { class: 'check' }, fullText, t('sources.fullText')),
    pick,
  );

  const have = new Set(items.map((s) => s.url));
  const missing = suggestions.filter((s) => !have.has(s.url));
  const suggest = missing.length && items.length < 8 ? h('div', { class: 'suggest' }, h('h2', { class: 'section-label' }, t('sources.suggested')), h('div', { class: 'chips' }, missing.map((s) => h('button', { class: 'chip', type: 'button', onclick: () => add(s.url) }, `+ ${s.title}`)))) : null;

  const rows = items.map((s) => {
    const toggle = (field, label) =>
      h(
        'label',
        { class: 'check small' },
        h('input', {
          type: 'checkbox',
          checked: s[field],
          onchange: async (e) => {
            try {
              await api('PATCH', `sources/${s.id}`, { [field]: e.target.checked });
            } catch (err) {
              e.target.checked = !e.target.checked;
              toast(errText(err), 'error');
            }
          },
        }),
        label,
      );
    return h(
      'li',
      { class: `source${s.enabled ? '' : ' is-off'}` },
      h(
        'div',
        { class: 'source-main' },
        h('p', { class: 'source-title' }, s.title || hostOf(s.url)),
        h('p', { class: 'muted small source-url' }, s.url),
        h('p', { class: `small ${s.last_error ? 'error-text' : 'muted'}` }, [t('sources.items', { n: s.item_count }), s.last_ok ? t('sources.lastOk', { time: relTime(s.last_ok) }) : null, s.last_error ? t('sources.error', { error: s.last_error }) : null].filter(Boolean).join(' · ')),
      ),
      h(
        'div',
        { class: 'source-tools' },
        toggle('enabled', t('sources.enabled')),
        toggle('full_text', t('sources.fullText')),
        h(
          'button',
          {
            class: 'icon-btn',
            title: t('sources.refreshAll'),
            'aria-label': t('sources.refreshAll'),
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              await api('POST', `sources/${s.id}/refresh`, {}).catch((err) => toast(errText(err), 'error'));
              route();
            },
          },
          icon('refresh'),
        ),
        h(
          'button',
          {
            class: 'link-btn danger',
            onclick: async () => {
              if (!confirm(t('sources.confirmDelete', { title: s.title || s.url }))) return;
              await api('DELETE', `sources/${s.id}`).catch((err) => toast(errText(err), 'error'));
              route();
            },
          },
          t('common.delete'),
        ),
      ),
    );
  });

  const fileInput = h('input', {
    type: 'file',
    accept: '.opml,.xml,text/xml,application/xml',
    hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const out = await api('POST', 'opml', { xml: await file.text() });
        toast(t('sources.imported', { n: out.added }));
        route();
      } catch (err) {
        toast(errText(err), 'error');
      }
    },
  });
  const refreshAll = h(
    'button',
    {
      class: 'btn',
      onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = t('sources.refreshing');
        await api('POST', 'refresh', {}).catch((err) => toast(errText(err), 'error'));
        route();
      },
    },
    t('sources.refreshAll'),
  );

  return [
    form,
    suggest,
    h('div', { class: 'toolbar' }, refreshAll, h('span', { class: 'spacer' }), h('button', { class: 'link-btn', onclick: () => fileInput.click() }, t('sources.import')), fileInput, h('a', { class: 'link-btn', href: '/api/opml', download: 'newsroom.opml' }, t('sources.export'))),
    items.length ? h('ul', { class: 'sources' }, rows) : h('p', { class: 'muted' }, t('sources.empty')),
  ];
}

async function viewSettings() {
  const [{ settings: s }, models] = await Promise.all([api('GET', 'settings'), api('GET', 'models')]);
  state.settings = s;
  const field = (id, label, control, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
  const select = (id, value, options) => h('select', { id }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
  const modelOptions = (list, value) => {
    const names = list.map((m) => m.name);
    if (value && !names.includes(value)) names.unshift(value);
    return [['', t('settings.none')], ...names.map((n) => [n, n])];
  };
  const provider = providerById(s.provider);
  const modelControl = models.ok && models.models.length
    ? select('model', s.model, modelOptions(models.models, s.model))
    : h('input', { id: 'model', type: 'text', value: s.model, autocomplete: 'off', placeholder: t('settings.modelPick') });

  const el = {
    language: select('language', s.language, [
      ['tr', 'Türkçe'],
      ['en', 'English'],
    ]),
    interests: h('textarea', { id: 'interests', rows: 5, value: s.interests.join('\n') }),
    minRelevance: h('input', { id: 'minRelevance', type: 'number', min: 0, max: 90, step: 5, value: s.minRelevance }),
    aiProvider: select('aiProvider', provider.id, PROVIDERS.map((p) => [p.id, p.id === 'ollama' ? t('settings.providerLocal') : p.label])),
    providerUrl: h('input', { id: 'providerUrl', type: 'url', value: s.providerUrl, autocomplete: 'off', placeholder: 'http://127.0.0.1:1234/v1' }),
    apiKey: h('input', { id: 'apiKey', type: 'password', value: '', autocomplete: 'new-password', placeholder: s.keysSet?.[provider.id] ? t('settings.apiKeySet') : '' }),
    dailyLimit: h('input', { id: 'dailyLimit', type: 'number', min: 0, max: 100000, step: 50, value: s.dailyLimit }),
    model: modelControl,
    embedModel: select('embedModel', s.embedModel, modelOptions(models.local?.models ?? [], s.embedModel)),
    fetchMinutes: select('fetchMinutes', s.fetchMinutes, [15, 30, 60, 120, 240].map((n) => [n, n < 60 ? t('settings.minutes', { n }) : t('settings.hours', { n: n / 60 })])),
    retentionDays: select('retentionDays', s.retentionDays, [7, 14, 30, 60, 90].map((n) => [n, t('settings.days', { n })])),
    digestEnabled: h('input', { id: 'digestEnabled', type: 'checkbox', checked: s.digestEnabled }),
    digestTime: h('input', { id: 'digestTime', type: 'time', value: s.digestTime, required: true }),
    digestSize: h('input', { id: 'digestSize', type: 'number', min: 5, max: 40, value: s.digestSize }),
    emailEnabled: h('input', { id: 'emailEnabled', type: 'checkbox', checked: s.email.enabled }),
    provider: select('provider', providerOf(s.email.host), [
      ['gmail', 'Gmail'],
      ['icloud', 'iCloud Mail'],
      ['yandex', 'Yandex Mail'],
      ['custom', t('settings.mailCustom')],
    ]),
    host: h('input', { id: 'host', type: 'text', value: s.email.host, autocomplete: 'off', placeholder: 'smtp.example.com' }),
    port: h('input', { id: 'port', type: 'number', min: 1, max: 65535, value: s.email.port }),
    security: select('security', s.email.port === 465 ? 'tls' : s.email.security, [
      ['tls', 'SSL/TLS (465)'],
      ['starttls', 'STARTTLS (587)'],
      ['none', t('settings.smtpNoTls')],
    ]),
    user: h('input', { id: 'user', type: 'text', value: s.email.user, autocomplete: 'off' }),
    pass: h('input', { id: 'pass', type: 'password', value: '', autocomplete: 'new-password', placeholder: s.email.passSet ? t('settings.smtpPassSet') : '' }),
    from: h('input', { id: 'from', type: 'email', value: s.email.from }),
    to: h('input', { id: 'to', type: 'email', value: s.email.to }),
  };

  const serverFields = h('div', { class: 'row-fields' }, field('host', t('settings.smtpHost'), el.host), field('port', t('settings.smtpPort'), el.port), field('security', t('settings.smtpSecurity'), el.security));
  const providerHint = h('div', { class: 'provider-hint' });
  const applyProvider = (fill) => {
    const id = el.provider.value;
    const p = MAIL_PROVIDERS[id];
    serverFields.hidden = Boolean(p);
    el.user.placeholder = p?.user ?? '';
    providerHint.replaceChildren();
    if (!p) return;
    if (fill) {
      el.host.value = p.host;
      el.port.value = p.port;
      el.security.value = p.security;
    }
    providerHint.append(
      h('p', { class: 'hint' }, t(`settings.mailHint.${id}`)),
      h('p', { class: 'hint' }, h('a', { href: p.help, target: '_blank', rel: 'noopener noreferrer' }, t('settings.appPassword'), ' ', icon('ext'))),
    );
  };
  el.provider.addEventListener('change', () => applyProvider(true));
  el.port.addEventListener('change', () => {
    const port = Number(el.port.value);
    if (port === 465) el.security.value = 'tls';
    else if ((port === 587 || port === 25) && el.security.value === 'tls') el.security.value = 'starttls';
  });
  el.security.addEventListener('change', () => {
    if (el.security.value === 'tls' && Number(el.port.value) === 587) el.port.value = 465;
    if (el.security.value === 'starttls' && Number(el.port.value) === 465) el.port.value = 587;
  });
  applyProvider(!s.email.host);

  const providerLine = h(
    'p',
    { class: `small ${models.ok ? 'muted' : 'error-text'}` },
    models.ok
      ? t('settings.providerOk', { provider: providerLabel(provider.id), n: models.models.length })
      : models.error === 'api_key_missing'
        ? t('settings.modelSaveFirst')
        : t('settings.providerDown', { provider: providerLabel(provider.id), error: llmError(models.error) }),
  );
  const keyField = provider.key
    ? h(
        'div',
        { class: 'field' },
        h('label', { for: 'apiKey' }, t('settings.apiKey'), provider.key === 'optional' ? ` (${t('settings.optional')})` : ''),
        el.apiKey,
        h(
          'p',
          { class: 'hint' },
          provider.keyUrl ? h('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('settings.apiKeyGet'), ' ', icon('ext')) : null,
          s.keysSet?.[provider.id]
            ? [
                provider.keyUrl ? ' · ' : '',
                h(
                  'button',
                  {
                    class: 'link-btn danger',
                    type: 'button',
                    onclick: async () => {
                      await api('PUT', 'settings', { apiKeys: { [provider.id]: null } }).catch((err) => toast(errText(err), 'error'));
                      route();
                    },
                  },
                  t('settings.apiKeyRemove'),
                ),
              ]
            : null,
        ),
      )
    : null;
  el.aiProvider.addEventListener('change', async () => {
    const next = el.aiProvider.value;
    try {
      await api('PUT', 'settings', { provider: next, model: next === s.provider ? s.model : '' });
      route();
    } catch (err) {
      toast(errText(err), 'error');
    }
  });
  const rescoreBox = h('div', { class: 'rescore', hidden: true });
  const requeueBtn = (label) =>
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          const out = await api('POST', 'requeue', { hours: 48 }).catch((err) => (toast(errText(err), 'error'), null));
          if (out) toast(t('settings.requeued', { n: out.requeued }));
          rescoreBox.hidden = true;
          e.target.disabled = false;
        },
      },
      label,
    );

  const payload = () => ({
    language: el.language.value,
    interests: el.interests.value.split('\n').map((x) => x.trim()).filter(Boolean),
    minRelevance: Number(el.minRelevance.value),
    provider: el.aiProvider.value,
    ...(provider.custom ? { providerUrl: el.providerUrl.value.trim() } : {}),
    ...(provider.key && el.apiKey.value.trim() ? { apiKeys: { [provider.id]: el.apiKey.value.trim() } } : {}),
    ...(provider.local ? {} : { dailyLimit: Number(el.dailyLimit.value) }),
    model: el.model.value.trim(),
    embedModel: el.embedModel.value,
    fetchMinutes: Number(el.fetchMinutes.value),
    retentionDays: Number(el.retentionDays.value),
    digestEnabled: el.digestEnabled.checked,
    digestTime: el.digestTime.value,
    digestSize: Number(el.digestSize.value),
    email: { enabled: el.emailEnabled.checked, host: el.host.value.trim(), port: Number(el.port.value), security: el.security.value, user: el.user.value, pass: el.pass.value, from: el.from.value.trim(), to: el.to.value.trim() || (el.provider.value !== 'custom' ? el.user.value.trim() : '') },
  });

  async function save() {
    const out = await api('PUT', 'settings', payload());
    const langChanged = out.settings.language !== state.lang;
    state.settings = out.settings;
    state.lang = out.settings.language;
    const reloadModels = Boolean(el.apiKey.value.trim()) || (provider.custom && el.providerUrl.value.trim() !== s.providerUrl);
    el.pass.value = '';
    el.apiKey.value = '';
    toast(t('common.saved'));
    if (reloadModels) {
      await route();
      return;
    }
    if (langChanged) {
      renderShell();
      await route();
      pollStatus();
      return;
    }
    if (out.rescore && out.settings.model) {
      rescoreBox.replaceChildren(requeueBtn(t('settings.requeue')));
      rescoreBox.hidden = false;
    }
  }

  const form = h(
    'form',
    {
      class: 'settings',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await save();
        } catch (err) {
          toast(errText(err), 'error');
        }
      },
    },
    h(
      'fieldset',
      {},
      h('legend', {}, t('settings.reading')),
      field('language', t('settings.language'), el.language, t('settings.languageHint')),
      field('interests', t('settings.interests'), el.interests, t('settings.interestsHint')),
      field('minRelevance', t('settings.minRelevance'), el.minRelevance),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, t('settings.model')),
      field('aiProvider', t('settings.provider'), el.aiProvider, provider.local ? null : t('settings.cloudNote')),
      provider.custom ? field('providerUrl', t('settings.providerUrl'), el.providerUrl, t('settings.providerUrlHint')) : null,
      keyField,
      providerLine,
      field('model', t('settings.modelName'), el.model, t('settings.modelHint')),
      provider.local ? null : field('dailyLimit', t('settings.dailyLimit'), el.dailyLimit, t('settings.dailyLimitHint', { n: state.status?.analyzedToday ?? 0 })),
      field('embedModel', provider.local ? t('settings.embedModel') : t('settings.embedLocal'), el.embedModel, t('settings.embedHint')),
      rescoreBox,
      h('p', {}, requeueBtn(t('settings.requeue'))),
    ),
    h('fieldset', {}, h('legend', {}, t('settings.fetching')), field('fetchMinutes', t('settings.fetchMinutes'), el.fetchMinutes), field('retentionDays', t('settings.retention'), el.retentionDays)),
    h(
      'fieldset',
      {},
      h('legend', {}, t('settings.digest')),
      h('label', { class: 'check' }, el.digestEnabled, t('settings.digestEnabled')),
      h('div', { class: 'row-fields' }, field('digestTime', t('settings.digestTime'), el.digestTime), field('digestSize', t('settings.digestSize'), el.digestSize)),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, t('settings.email')),
      h('label', { class: 'check' }, el.emailEnabled, t('settings.emailEnabled')),
      field('provider', t('settings.mailProvider'), el.provider),
      providerHint,
      serverFields,
      h('div', { class: 'row-fields' }, field('user', t('settings.smtpUser'), el.user), field('pass', t('settings.smtpPass'), el.pass)),
      h('div', { class: 'row-fields' }, field('from', t('settings.smtpFrom'), el.from, t('settings.smtpFromHint')), field('to', t('settings.smtpTo'), el.to, t('settings.smtpToHint'))),
      h(
        'p',
        {},
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                await save();
                await api('POST', 'email/test', {});
                toast(t('settings.emailSent'));
              } catch (err) {
                toast(errText(err), 'error');
              } finally {
                e.target.disabled = false;
              }
            },
          },
          t('settings.emailTest'),
        ),
      ),
    ),
    h('div', { class: 'sticky-save' }, h('button', { class: 'btn btn-primary', type: 'submit' }, t('common.save'))),
  );
  return [form, h('p', { class: 'muted small about' }, `Newsroom v${state.session.version} · `, h('a', { href: 'https://github.com/AtnNaz/newsroom', target: '_blank', rel: 'noopener noreferrer' }, 'GitHub'))];
}

let routeSeq = 0;
let lastView = null;
async function route() {
  if (!$main) return;
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, arg] = hash.split('/');
  const seq = ++routeSeq;
  const key = view === 'day' || view === 'article' || !view ? 'today' : view;
  setActiveNav(key);
  $main.replaceChildren(h('p', { class: 'muted pad' }, t('common.loading')));
  try {
    let content;
    if (view === 'feed' || view === 'saved') content = await viewList(view);
    else if (view === 'sources') content = await viewSources();
    else if (view === 'settings') content = await viewSettings();
    else if (view === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(arg ?? '')) content = await viewToday(arg);
    else content = await viewToday();
    if (seq !== routeSeq) return;
    $main.replaceChildren(...[content].flat().filter(Boolean));
    if (view !== lastView) window.scrollTo(0, 0);
    lastView = view;
    if (view === 'article' && /^\d+$/.test(arg ?? '')) openReader(Number(arg));
  } catch (err) {
    if (err.code === 'auth' || seq !== routeSeq) return;
    $main.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, errText(err)), h('button', { class: 'btn', onclick: route }, t('common.retry'))));
  }
}

async function boot() {
  state.session = await fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json());
  state.lang = state.session.language ?? 'tr';
  if (!state.session.authenticated) return renderLogin();
  renderShell();
  api('GET', 'settings')
    .then((r) => (state.settings = r.settings))
    .catch(() => {});
  await pollStatus();
  await route();
  stopPolling();
  pollTimer = setInterval(pollStatus, 15_000);
}

window.addEventListener('hashchange', route);
boot().catch(() => {
  $app.replaceChildren(h('main', { class: 'login-wrap' }, h('p', {}, 'Newsroom sunucusuna ulaşılamıyor.')));
});
