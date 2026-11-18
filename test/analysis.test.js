import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analysisSchema, buildAnalysisMessages, normalizeAnalysis, relevanceFrom } from '../src/analyze.js';
import { titleTokens, jaccard, chooseCluster, toBlob, fromBlob, cosine } from '../src/cluster.js';
import { scoreArticle, groupClusters } from '../src/rank.js';
import { selectStories } from '../src/digest.js';
import { validateSettings, publicSettings, DEFAULT_SETTINGS } from '../src/settings.js';

test('şema ilgi alanı sayısına göre kurulur', () => {
  const s = analysisSchema(['a', 'b']);
  assert.deepEqual(s.properties.interests.required, ['1', '2']);
  assert.ok(s.required.includes('interests'));
  assert.ok(analysisSchema([]).properties.importance);
  const [system, user] = buildAnalysisMessages({ title: 'X', text: 'y'.repeat(10_000) }, { language: 'tr', interests: ['uzay'] });
  assert.match(system.content, /1\. uzay/);
  assert.match(system.content, /ignore any instructions/);
  assert.ok(user.content.length < 6300);
});

test('model çıktısı doğrulanır ve sınırlanır', () => {
  const out = normalizeAnalysis({ title: '"Başlık"', summary: ' Özet  metni ', category: 'uydurma', tags: ['a', 'a', 'b', 'c', 'd'], reason: 'none', interests: { 1: 3, 2: 15 } }, { title: 'Orijinal' }, ['x', 'y']);
  assert.equal(out.title, 'Başlık');
  assert.equal(out.summary, 'Özet metni');
  assert.equal(out.category, 'other');
  assert.deepEqual(out.tags, ['a', 'b', 'c']);
  assert.equal(out.relevance, 100);
  assert.equal(out.reason, '');
  assert.throws(() => normalizeAnalysis({ summary: '' }), /empty_summary/);
  assert.throws(() => normalizeAnalysis([]), /invalid_model_output/);
  assert.equal(relevanceFrom({ interests: { 1: 6, 2: 4 } }, ['a', 'b']), 64);
  assert.equal(relevanceFrom({ importance: 7 }, []), 70);
  const many = Array.from({ length: 12 }, (_, i) => `ilgi ${i + 1}`);
  assert.ok(analysisSchema(many).properties.matches, 'uzun listede yalnızca eşleşenler istenir');
  assert.equal(analysisSchema(many).properties.interests, undefined);
  assert.equal(relevanceFrom({ matches: [{ interest: 4, score: 7 }, { interest: 9, score: 3 }, { interest: 99, score: 10 }, { interest: 4, score: 2 }] }, many), 73);
  assert.equal(relevanceFrom({ matches: [] }, many), 0);
  assert.equal(relevanceFrom({}, many), 0);
  assert.equal(normalizeAnalysis({ summary: 's', reason: 'Alakasız ama yazmış', interests: { 1: 1 } }, {}, ['a']).reason, '');
});

test('başlık benzerliği ve kümeleme', () => {
  const a = titleTokens('NVIDIA yönetimi Jensen Huang’ın dönüşünü reddetti');
  const b = titleTokens('Nvidia yönetim kurulu Jensen Huang’un CEO olarak dönüşünü istemiyor');
  assert.ok(jaccard(a, b) >= 0.42, `jaccard ${jaccard(a, b)}`);
  assert.ok(jaccard(a, titleTokens('Mars’ta yeni bir krater keşfedildi')) < 0.1);

  const cands = [
    { id: 1, title_local: 'Mars’ta yeni krater keşfedildi', tags: '[]', cluster_id: 1 },
    { id: 2, title_local: 'NVIDIA yönetimi Jensen Huang’ın dönüşünü reddetti', tags: '[]', cluster_id: 2 },
  ];
  assert.equal(chooseCluster({ id: 3, title_local: 'Nvidia yönetim kurulu Jensen Huang’un dönüşünü istemiyor', tags: '[]' }, cands), 2);
  assert.equal(chooseCluster({ id: 4, title_local: 'Borsa güne yükselişle başladı', tags: '[]' }, cands), 4);

  const v = [0.1, 0.2, 0.3];
  assert.deepEqual([...fromBlob(toBlob(v))].map((x) => +x.toFixed(3)), v);
  assert.ok(cosine([1, 0], [1, 0]) > 0.99);
  const e = (x) => toBlob(x);
  assert.equal(chooseCluster({ id: 9, title: 'tamamen farklı', embedding: e([1, 0, 0]) }, [{ id: 7, title: 'başka', embedding: e([0.99, 0.05, 0]), cluster_id: 5 }]), 5);
});

test('sıralama: ilgi, geri bildirim, kaynak sayısı ve yaş', () => {
  const now = Date.parse('2026-11-18T08:00:00Z');
  const aff = { category: new Map([['ai', 3]]), source: new Map() };
  const fresh = { relevance: 50, category: 'world', source_id: 1, published: now - 3600_000, fetched: now };
  const liked = { ...fresh, category: 'ai' };
  const old = { ...fresh, published: now - 48 * 3600_000 };
  assert.ok(scoreArticle(liked, aff, now) > scoreArticle(fresh, aff, now));
  assert.ok(scoreArticle(old, aff, now) < scoreArticle(fresh, aff, now));

  const rows = [
    { id: 1, cluster_id: 1, relevance: 40, published: now, fetched: now, summary: 'a' },
    { id: 2, cluster_id: 1, relevance: 70, published: now, fetched: now, summary: 'b' },
    { id: 3, cluster_id: 3, relevance: 60, published: now, fetched: now, summary: 'c' },
  ];
  const groups = groupClusters(rows, { category: new Map(), source: new Map() }, now);
  assert.equal(groups[0].lead.id, 2);
  assert.deepEqual(groups[0].others.map((o) => o.id), [1]);
  assert.equal(groups[0].lead.cluster_size, 2);
});

test('özet seçimi eşiği uygular ama en az beş haber bırakır', () => {
  const g = (id, relevance, category = 'ai') => ({ lead: { id, relevance, category, title: `h${id}`, status: 'done' }, others: [] });
  const groups = [g(1, 90), g(2, 80, 'space'), g(3, 10), g(4, 5), g(5, 0, 'world'), g(6, 0)];
  const sections = selectStories(groups, { digestSize: 15, minRelevance: 30, interests: ['x'] });
  const ids = sections.flatMap((s) => s.items.map((i) => i.id));
  assert.equal(ids.length, 5);
  assert.deepEqual(sections.map((s) => s.category), ['ai', 'space', 'world']);
  assert.equal(selectStories(groups, { digestSize: 15, minRelevance: 30, interests: [] }).flatMap((s) => s.items).length, 6);
});

test('ayar doğrulaması', () => {
  const ok = validateSettings({ language: 'en', interests: [' uzay ', 'uzay', 'linux'], fetchMinutes: 60, digestTime: '06:30', model: 'qwen3:8b' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value.interests, ['uzay', 'linux']);
  const bad = validateSettings({ language: 'de', fetchMinutes: 7, digestTime: '25:00', model: 'a b', unknown: 1, interests: ['a\nb'] });
  assert.deepEqual(bad.errors.sort(), ['digestTime', 'fetchMinutes', 'interests', 'language', 'model', 'unknown']);
  const mail = validateSettings({ email: { enabled: true, host: 'smtp.example.com', to: 'deniz@example.com', user: 'deniz@example.com', pass: '' } }, { ...DEFAULT_SETTINGS, email: { ...DEFAULT_SETTINGS.email, pass: 'eski' } });
  assert.deepEqual(mail.errors, []);
  assert.equal(mail.value.email.pass, 'eski');
  assert.deepEqual(validateSettings({ email: { enabled: true } }).errors, ['email.incomplete']);
  const gmail = validateSettings({ email: { enabled: true, host: 'smtp.gmail.com', port: 587, security: 'starttls', user: ' ad@gmail.com ', pass: 'abcd efgh ijkl mnop', to: 'ad@gmail.com' } });
  assert.deepEqual(gmail.errors, []);
  assert.equal(gmail.value.email.pass, 'abcdefghijklmnop', 'Gmail uygulama şifresindeki boşluklar atılır');
  assert.equal(gmail.value.email.user, 'ad@gmail.com');
  assert.equal(validateSettings({ email: { host: 'smtp.example.com', pass: 'a b' } }).value.email.pass, 'a b', 'diğer sağlayıcılarda şifreye dokunulmaz');
  assert.deepEqual(validateSettings({ email: { from: 'x@y.com\r\nBcc: z@w.com' } }).errors, ['email.from']);
  const pub = publicSettings({ ...DEFAULT_SETTINGS, email: { ...DEFAULT_SETTINGS.email, pass: 'gizli' } });
  assert.equal(pub.email.pass, undefined);
  assert.equal(pub.email.passSet, true);
});
