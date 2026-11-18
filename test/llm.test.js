import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createLlm, strictSchema, extractJson } from '../src/llm.js';
import { createOllama, skipsThinking } from '../src/ollama.js';
import { analysisSchema, analyzeArticle } from '../src/analyze.js';
import { validateSettings, publicSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { openDb, createSettings } from '../src/db.js';
import { createPipeline } from '../src/pipeline.js';
import { listen, tempDir } from './helpers.js';

const RESULT = { title: 'Başlık', summary: 'Kısa özet.', category: 'ai', tags: ['x'], reason: 'İlgili.', interests: { 1: 8 } };

async function fakeApi(handler) {
  const seen = [];
  const srv = await listen(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const [status, out] = handler({ url: req.url, body, headers: req.headers, n: seen.length });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return { ...srv, seen };
}

test('şema katı moda çevrilir: sayı sınırları atılır, her nesne kapatılır', () => {
  const s = strictSchema(analysisSchema(['a', 'b']));
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, Object.keys(s.properties));
  assert.equal(s.properties.interests.additionalProperties, false);
  assert.equal(s.properties.interests.properties['1'].minimum, undefined);
  assert.equal(s.properties.tags.maxItems, undefined);
  const long = strictSchema(analysisSchema(Array.from({ length: 12 }, (_, i) => `i${i}`)));
  assert.equal(long.properties.matches.items.additionalProperties, false);
});

test('yanıttaki JSON düşünme etiketlerinden ve kod bloklarından ayıklanır', () => {
  assert.deepEqual(extractJson('<think>uzun düşünce {x}</think>\n```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sonuç: {"a": {"b": 2}} tamam'), { a: { b: 2 } });
  assert.throws(() => extractJson('json yok'), /invalid_model_output/);
});

test('OpenAI uyumlu: anahtar, katı şema, desteklenmeyince json_object, sıcaklık reddedilince sıcaklıksız', async () => {
  const api = await fakeApi(({ url, body, n }) => {
    if (url === '/v1/models') return [200, { data: [{ id: 'model-b' }, { id: 'model-a' }] }];
    if (body.response_format?.type === 'json_schema') return [400, { error: { message: 'response_format json_schema is not supported' } }];
    if ('temperature' in body) return [400, { error: { message: 'Unsupported value: temperature' } }];
    return [200, { choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(RESULT)}\n\`\`\`` } }] }];
  });
  try {
    const llm = createLlm({ provider: 'custom', providerUrl: `${api.url}/v1`, apiKeys: { custom: 'sk-test' } });
    assert.deepEqual((await llm.models()).map((m) => m.name), ['model-a', 'model-b']);
    const out = await analyzeArticle(llm, { title: 'T', text: 'metin' }, { model: 'model-a', language: 'tr', interests: ['yapay zekâ'] });
    assert.equal(out.relevance, 80);
    const posts = api.seen.filter((r) => r.method === 'POST');
    assert.equal(posts[0].body.response_format.json_schema.strict, true);
    assert.equal(posts[0].headers.authorization, 'Bearer sk-test');
    assert.equal(posts.at(-1).body.response_format.type, 'json_object');
    assert.equal('temperature' in posts.at(-1).body, false);
    assert.match(posts.at(-1).body.messages[0].content, /JSON schema/);
  } finally {
    await api.close();
  }
});

test('Anthropic: başlıklar, output_config ile şema, sıcaklık gönderilmez, effort desteklenmezse çıkarılır', async () => {
  const api = await fakeApi(({ url, body }) => {
    if (url.startsWith('/v1/models')) return [200, { data: [{ id: 'claude-test', display_name: 'Claude Test' }] }];
    if (body.output_config?.effort) return [400, { error: { message: 'effort is not supported on this model' } }];
    return [200, { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(RESULT) }] }];
  });
  try {
    const viaUrl = createLlm({ provider: 'anthropic', apiKeys: { anthropic: 'sk-ant-test' }, fetchImpl: (u, init) => fetch(String(u).replace('https://api.anthropic.com', api.url), init) });
    assert.deepEqual((await viaUrl.models()).map((m) => m.name), ['claude-test']);
    const out = await viaUrl.chatJson({ model: 'claude-test', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], schema: analysisSchema(['a']) });
    assert.equal(out.title, 'Başlık');
    const posts = api.seen.filter((r) => r.method === 'POST');
    assert.equal(posts[0].headers['x-api-key'], 'sk-ant-test');
    assert.equal(posts[0].headers['anthropic-version'], '2026-10-21');
    assert.equal(posts[0].body.system, 'S');
    assert.deepEqual(posts[0].body.messages, [{ role: 'user', content: 'U' }]);
    assert.equal(posts[0].body.output_config.format.type, 'json_schema');
    assert.equal(posts[0].body.output_config.format.schema.additionalProperties, false);
    assert.equal('temperature' in posts[0].body, false);
    assert.equal(posts[1].body.output_config.effort, undefined);
  } finally {
    await api.close();
  }
});

test('Ollama Cloud: Bearer anahtar, şema istemde, yanıttan JSON ayıklanır', async () => {
  const api = await fakeApi(({ url }) => {
    if (url === '/api/tags') return [200, { models: [{ name: 'gpt-oss:120b' }] }];
    return [200, { message: { content: `Tamam:\n${JSON.stringify(RESULT)}` } }];
  });
  try {
    const llm = createLlm({ provider: 'ollama-cloud', apiKeys: { 'ollama-cloud': 'olk-test' }, fetchImpl: (u, init) => fetch(String(u).replace('https://ollama.com', api.url), init) });
    assert.deepEqual((await llm.models()).map((m) => m.name), ['gpt-oss:120b']);
    const out = await llm.chatJson({ model: 'gpt-oss:120b', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], schema: analysisSchema(['a']) });
    assert.equal(out.summary, 'Kısa özet.');
    const post = api.seen.find((r) => r.method === 'POST');
    assert.equal(post.headers.authorization, 'Bearer olk-test');
    assert.equal(post.body.format, undefined);
    assert.match(post.body.messages[0].content, /JSON schema/);
  } finally {
    await api.close();
  }
});

test('anahtar yoksa ya da geçersizse analiz durur, haberler cezalandırılmaz', async () => {
  await assert.rejects(createLlm({ provider: 'openai', apiKeys: {} }).chatJson({}), /api_key_missing/);
  await assert.rejects(createLlm({ provider: 'custom', providerUrl: '' }).models(), /provider_url_missing/);
  const api = await fakeApi(() => [401, { error: { message: 'invalid api key' } }]);
  const tmp = tempDir();
  const db = openDb(path.join(tmp.dir, 'n.db'));
  try {
    const settings = createSettings(db, DEFAULT_SETTINGS);
    settings.update({ provider: 'custom', providerUrl: api.url, model: 'm' });
    db.prepare("INSERT INTO sources (id, url, created) VALUES (1, 'https://example.com/f', 0)").run();
    db.prepare("INSERT INTO articles (source_id, url, title, fetched, status) VALUES (1, 'https://example.com/1', 'a', ?, 'ready')").run(Date.now());
    const pipeline = createPipeline({ db, settings, llm: createLlm({ provider: 'custom', providerUrl: api.url }) });
    await pipeline.analyzePending();
    assert.equal(pipeline.state.llm.error, 'auth_failed');
    assert.equal(db.prepare('SELECT attempts FROM articles').get().attempts, 0);
  } finally {
    db.close();
    tmp.cleanup();
    await api.close();
  }
});

test('bulut sağlayıcıda günlük analiz sınırı uygulanır', async () => {
  const api = await fakeApi(() => [200, { choices: [{ message: { content: JSON.stringify(RESULT) } }] }]);
  const tmp = tempDir();
  const db = openDb(path.join(tmp.dir, 'n.db'));
  try {
    const settings = createSettings(db, DEFAULT_SETTINGS);
    settings.update({ provider: 'custom', providerUrl: api.url, model: 'm', dailyLimit: 2, interests: ['a'] });
    db.prepare("INSERT INTO sources (id, url, created) VALUES (1, 'https://example.com/f', 0)").run();
    for (let i = 0; i < 4; i++) db.prepare("INSERT INTO articles (source_id, url, title, fetched, status) VALUES (1, ?, 'a', ?, 'ready')").run(`https://example.com/${i}`, Date.now());
    const pipeline = createPipeline({ db, settings, llm: createLlm({ provider: 'custom', providerUrl: api.url }) });
    assert.equal(await pipeline.analyzePending(), 2);
    assert.equal(pipeline.state.llm.limited, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM articles WHERE provider = 'custom'").get().n, 2);
  } finally {
    db.close();
    tmp.cleanup();
    await api.close();
  }
});

test('API anahtarları doğrulanır ve arayüze hiç gönderilmez', () => {
  const current = { ...DEFAULT_SETTINGS, apiKeys: { openai: 'sk-eski', anthropic: 'sk-ant' } };
  const { errors, value } = validateSettings({ provider: 'openai', apiKeys: { openai: '', anthropic: null, groq: ' gsk-yeni ' }, dailyLimit: 300 }, current);
  assert.deepEqual(errors, []);
  assert.deepEqual(value.apiKeys, { openai: 'sk-eski', groq: 'gsk-yeni' });
  assert.deepEqual(validateSettings({ provider: 'bilinmeyen', apiKeys: { yok: 'x' }, providerUrl: 'ftp://x' }).errors.sort(), ['apiKeys.yok', 'provider', 'providerUrl']);
  assert.deepEqual(validateSettings({ apiKeys: { openai: 'iki parça' } }).errors, ['apiKeys.openai']);
  const pub = publicSettings({ ...DEFAULT_SETTINGS, apiKeys: { openai: 'sk-gizli' } });
  assert.equal(JSON.stringify(pub).includes('sk-gizli'), false);
  assert.deepEqual(pub.keysSet, { openai: true });
});

test('deepseek-r1 düşünmeyi atlar: boş düşünme bloğuyla başlar, şema istemde', async () => {
  assert.equal(skipsThinking('deepseek-r1:8b'), true);
  assert.equal(skipsThinking('hf.co/unsloth/DeepSeek-R1-0528-Qwen3-8B-GGUF:Q4_K_M'), true);
  assert.equal(skipsThinking('gemma3:12b'), false);
  const api = await fakeApi(({ body }) => [200, { message: { content: JSON.stringify(RESULT) } }]);
  try {
    const ollama = createOllama({ url: api.url });
    const out = await ollama.chatJson({ model: 'deepseek-r1:8b', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], schema: analysisSchema(['a']) });
    assert.equal(out.title, 'Başlık');
    const body = api.seen[0].body;
    assert.equal(body.format, undefined, 'şemaya bağlı çıktı bu yöntemle birlikte çalışmıyor');
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: '<think>\n\n</think>\n\n' });
    assert.match(body.messages[0].content, /JSON schema/);
    await ollama.chatJson({ model: 'gemma3:12b', messages: [{ role: 'user', content: 'U' }], schema: analysisSchema(['a']) });
    assert.ok(api.seen[1].body.format, 'diğer modellerde şemaya bağlı çıktı sürer');
    assert.equal(api.seen[1].body.messages.at(-1).role, 'user');
  } finally {
    await api.close();
  }
});
