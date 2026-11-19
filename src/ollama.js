import { extractJson, withSchemaInstruction } from './json.js';

export const skipsThinking = (model) => /(^|\/)deepseek-r1/i.test(String(model ?? ''));

export function createOllama({ url, fetchImpl = fetch, timeoutMs = 3 * 60_000 }) {
  const api = (p) => new URL(p, url.endsWith('/') ? url : `${url}/`);

  async function post(p, body, ms = timeoutMs) {
    const res = await fetchImpl(api(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(res.status === 404 ? 'model_missing' : `ollama_http_${res.status}`), { status: res.status, detail: text.slice(0, 300) });
    }
    return res.json();
  }

  return {
    async models() {
      const res = await fetchImpl(api('api/tags'), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`ollama_http_${res.status}`);
      const data = await res.json();
      return (data.models ?? []).map((m) => ({ name: m.name, size: m.size ?? null, family: m.details?.family ?? null, parameterSize: m.details?.parameter_size ?? null }));
    },
    async chatJson({ model, messages, schema, temperature = 0.2, numCtx = 8192, maxTokens = 3072 }) {
      if (skipsThinking(model)) {
        const prefilled = [...withSchemaInstruction(messages, schema), { role: 'assistant', content: '<think>\n\n</think>\n\n' }];
        const data = await post('api/chat', { model, messages: prefilled, stream: false, keep_alive: '10m', options: { temperature, num_ctx: numCtx, num_predict: maxTokens } });
        return extractJson(data?.message?.content);
      }
      const body = { model, messages, stream: false, think: false, format: schema, keep_alive: '10m', options: { temperature, num_ctx: numCtx, num_predict: maxTokens } };
      let data;
      try {
        data = await post('api/chat', body);
      } catch (err) {
        if (err.status !== 400) throw err;
        const { think, ...rest } = body;
        data = await post('api/chat', rest);
      }
      const content = String(data?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '');
      try {
        return JSON.parse(content);
      } catch {
        throw new Error('invalid_model_output');
      }
    },
    async embed({ model, input, gpu = false }) {
      const data = await post('api/embed', { model, input, keep_alive: '10m', ...(gpu ? {} : { options: { num_gpu: 0 } }) }, 20_000);
      const v = data?.embeddings?.[0];
      if (!Array.isArray(v) || !v.length) throw new Error('invalid_embedding');
      return v;
    },
  };
}
