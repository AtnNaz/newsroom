import { createOllama } from './ollama.js';
import { providerById } from '../public/providers.js';

const ANTHROPIC_VERSION = '2026-10-21';
const UNSUPPORTED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern']);

export function strictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED.has(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, strictSchema(s)])) : strictSchema(v);
  }
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

export function extractJson(text) {
  const cleaned = String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw Object.assign(new Error('invalid_model_output'), { code: 'invalid_model_output' });
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('invalid_model_output'), { code: 'invalid_model_output' });
  }
}

const withSchemaInstruction = (messages, schema) => {
  const note = `Answer with a single JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(strictSchema(schema))}`;
  const [first, ...rest] = messages;
  return first?.role === 'system' ? [{ ...first, content: `${first.content}\n\n${note}` }, ...rest] : [{ role: 'system', content: note }, ...messages];
};

function httpError(status, detail) {
  const code = status === 401 || status === 403 ? 'auth_failed' : status === 404 ? 'model_missing' : status === 429 ? 'rate_limited' : status === 402 ? 'quota' : `llm_http_${status}`;
  return Object.assign(new Error(code), { code, status, detail: String(detail ?? '').slice(0, 300) });
}

function jsonClient(fetchImpl, timeoutMs) {
  return async function call(url, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetchImpl(url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
    }
  };
}

function openaiClient({ url, key, fetchImpl, timeoutMs }) {
  const call = jsonClient(fetchImpl, timeoutMs);
  const base = url.replace(/\/+$/, '');
  const auth = key ? { Authorization: `Bearer ${key}` } : {};
  return {
    async models() {
      const data = await call(`${base}/models`, { headers: auth });
      return (data.data ?? data.models ?? []).map((m) => ({ name: m.id ?? m.name })).filter((m) => m.name).sort((a, b) => a.name.localeCompare(b.name));
    },
    async chatJson({ model, messages, schema, temperature = 0.2 }) {
      const attempts = [
        { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: strictSchema(schema) } }, messages },
        { response_format: { type: 'json_object' }, messages: withSchemaInstruction(messages, schema) },
        { messages: withSchemaInstruction(messages, schema) },
      ];
      let useTemperature = true;
      let lastError;
      for (let i = 0; i < attempts.length; i++) {
        try {
          const data = await call(`${base}/chat/completions`, { method: 'POST', headers: auth, body: { model, ...attempts[i], ...(useTemperature ? { temperature } : {}) } });
          const choice = data.choices?.[0];
          if (choice?.message?.refusal) throw Object.assign(new Error('llm_refusal'), { code: 'llm_refusal' });
          return extractJson(choice?.message?.content);
        } catch (err) {
          lastError = err;
          if (err.status !== 400 && err.status !== 422) throw err;
          if (useTemperature && /temperature/i.test(err.detail)) {
            useTemperature = false;
            i--;
          }
        }
      }
      throw lastError;
    },
  };
}

function anthropicClient({ url, key, fetchImpl, timeoutMs }) {
  const call = jsonClient(fetchImpl, timeoutMs);
  const base = url.replace(/\/+$/, '');
  const headers = { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
  return {
    async models() {
      const data = await call(`${base}/v1/models?limit=100`, { headers });
      return (data.data ?? []).map((m) => ({ name: m.id, label: m.display_name ?? null }));
    },
    async chatJson({ model, messages, schema }) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages.filter((m) => m.role !== 'system');
      let outputConfig = { format: { type: 'json_schema', schema: strictSchema(schema) }, effort: 'low' };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await call(`${base}/v1/messages`, { method: 'POST', headers, body: { model, max_tokens: 16000, system, messages: rest, output_config: outputConfig } });
          if (data.stop_reason === 'refusal') throw Object.assign(new Error('llm_refusal'), { code: 'llm_refusal' });
          const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          return extractJson(text);
        } catch (err) {
          if (attempt === 0 && err.status === 400 && /effort/i.test(err.detail)) {
            const { effort, ...format } = outputConfig;
            outputConfig = format;
            continue;
          }
          throw err;
        }
      }
      throw Object.assign(new Error('invalid_model_output'), { code: 'invalid_model_output' });
    },
  };
}

function ollamaCloudClient({ url, key, fetchImpl, timeoutMs }) {
  const call = jsonClient(fetchImpl, timeoutMs);
  const base = url.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${key}` };
  return {
    async models() {
      const data = await call(`${base}/api/tags`, { headers });
      return (data.models ?? []).map((m) => ({ name: m.name ?? m.model, size: m.size ?? null })).filter((m) => m.name);
    },
    async chatJson({ model, messages, schema, temperature = 0.2 }) {
      const body = { model, messages: withSchemaInstruction(messages, schema), stream: false, think: false, options: { temperature, num_predict: 3072 } };
      try {
        const data = await call(`${base}/api/chat`, { method: 'POST', headers, body });
        return extractJson(data.message?.content);
      } catch (err) {
        if (err.status !== 400) throw err;
        const { think, ...rest } = body;
        const data = await call(`${base}/api/chat`, { method: 'POST', headers, body: rest });
        return extractJson(data.message?.content);
      }
    },
  };
}

export function createLlm({ provider, providerUrl, apiKeys = {}, ollamaUrl, fetchImpl = fetch, timeoutMs = 3 * 60_000 }) {
  const p = providerById(provider);
  const key = apiKeys[p.id] ?? '';
  if (p.key === 'required' && !key) {
    const missing = async () => {
      throw Object.assign(new Error('api_key_missing'), { code: 'api_key_missing' });
    };
    return { provider: p, models: missing, chatJson: missing };
  }
  const url = p.custom ? providerUrl : p.url;
  if (p.custom && !url) {
    const missing = async () => {
      throw Object.assign(new Error('provider_url_missing'), { code: 'provider_url_missing' });
    };
    return { provider: p, models: missing, chatJson: missing };
  }
  let client;
  if (p.kind === 'ollama') client = createOllama({ url: ollamaUrl, fetchImpl, timeoutMs });
  else if (p.kind === 'ollama-cloud') client = ollamaCloudClient({ url, key, fetchImpl, timeoutMs });
  else if (p.kind === 'anthropic') client = anthropicClient({ url, key, fetchImpl, timeoutMs });
  else client = openaiClient({ url, key, fetchImpl, timeoutMs });
  return { provider: p, models: () => client.models(), chatJson: (args) => client.chatJson(args) };
}
