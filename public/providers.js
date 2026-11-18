export const PROVIDERS = [
  { id: 'ollama', kind: 'ollama', label: 'Ollama', local: true },
  { id: 'ollama-cloud', kind: 'ollama-cloud', label: 'Ollama Cloud', url: 'https://ollama.com', key: 'required', keyUrl: 'https://ollama.com/settings/keys' },
  { id: 'openai', kind: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', key: 'required', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic (Claude)', url: 'https://api.anthropic.com', key: 'required', keyUrl: 'https://platform.claude.com/settings/keys' },
  { id: 'gemini', kind: 'openai', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', kind: 'openai', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', key: 'required', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', kind: 'openai', label: 'Groq', url: 'https://api.groq.com/openai/v1', key: 'required', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', kind: 'openai', label: 'DeepSeek', url: 'https://api.deepseek.com', key: 'required', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'mistral', kind: 'openai', label: 'Mistral', url: 'https://api.mistral.ai/v1', key: 'required', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'custom', kind: 'openai', label: 'OpenAI uyumlu (LM Studio, vLLM, llama.cpp…)', key: 'optional', custom: true },
];

export const providerById = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
