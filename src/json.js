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

export const withSchemaInstruction = (messages, schema) => {
  const note = `Answer with a single JSON object and nothing else. It must match this JSON schema:\n${JSON.stringify(strictSchema(schema))}`;
  const [first, ...rest] = messages;
  return first?.role === 'system' ? [{ ...first, content: `${first.content}\n\n${note}` }, ...rest] : [{ role: 'system', content: note }, ...messages];
};
