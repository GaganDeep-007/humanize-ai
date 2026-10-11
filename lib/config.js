const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.HUMANIZE_CONFIG_DIR || path.join(process.env.HOME || '.', '.config', 'humanize-ai');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const ORI_CREDENTIALS = path.join(process.env.HOME || '.', '.ori', 'credentials.json');

const DEFAULTS = {
  model: 'openrouter/free',
  orModel: 'openrouter/free',
  lmModel: 'lmstudio/qwen/qwen2.5-vl-7b',
  evalModel: '',
  routingMode: 'lmstudio-first',
  lmstudioUrl: 'http://192.168.29.233:1234/v1',
  layaUrl: 'http://192.168.29.233:8094',
  layaEnabled: false,
  layaToken: '',
  layaTimeoutMs: 15000,
  layaConfGate: 0.7,
  aiThreshold: 25,
  plagiarismThreshold: 15,
  // Rewrite voice (Clever-style): "normal" (simple, friendly, conversational) or
  // "clear-structured" (tidy, professional, keeps outlines/headings).
  style: 'normal',
  providerTimeoutMs: 120000,
  decision: {
    enabled: true,
    maxAttempts: 6,
    wallClockMs: 20 * 60 * 1000,
    minTrustWords: 50,
  },
  // Pluggable AI detector used as the judge/eval signal in robustAnalyze.
  // providers: sapling (free dev key — EXPIRES in ~1 month) | huggingface (free
  //            token, long-lived) | contentdetector (free, NO key) | kiprio (free,
  //            key optional) | wasitai (free tier) | gptzero (paid API).
  // Zero-maintenance: `fallback:true` walks an ordered chain (configured provider
  // first, then any other available provider, ending at the keyless contentdetector)
  // so an expired/absent key silently degrades to the next provider — never to
  // nothing. If every provider fails it still falls back to the LLM judge.
  detector: {
    enabled: true,
    provider: 'huggingface',
    apiKey: '',
    saplingApiKey: '',
    gptzeroApiKey: '',
    hfToken: '',
    hfModel: 'Hello-SimpleAI/chatgpt-detector-roberta',
    kiprioApiKey: '',
    wasitaiApiKey: '',
    contentdetectorApiKey: '',
    weight: 0.3,
    timeoutMs: 30000,
    maxChars: 80000,
    fallback: true,
    chain: [],
  },
  providers: {
    groq: { enabled: true, apiKey: '', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'qwen-qwq-32b', 'gemma2-9b-it'] },
    gemini: { enabled: true, apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-2.5-flash'] },
    cerebras: { enabled: true, apiKey: '', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'qwen-2.5-72b-instruct'] },
    mistral: { enabled: true, apiKey: '', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'] },
    // Clever AI Humanizer — public API is "coming soon" (cleverhumanizer.ai/api).
    // Stub: disabled until enabled + apiKey + available=true are set in config.
    clever: { enabled: false, available: false, apiKey: '', baseUrl: 'https://cleverhumanizer.ai/v1', models: ['clever-humanizer'] },
  },
  bot: {
    token: '',
    allowedIds: [],
  },
};

function loadConfig() {
  let cfg = { ...DEFAULTS };
  try {
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    Object.assign(cfg, user);
    if (user.providers) {
      cfg.providers = { ...DEFAULTS.providers, ...user.providers };
      for (const k of Object.keys(DEFAULTS.providers)) {
        if (!cfg.providers[k]) cfg.providers[k] = DEFAULTS.providers[k];
        cfg.providers[k] = { ...DEFAULTS.providers[k], ...cfg.providers[k] };
      }
    }
    cfg.decision = { ...DEFAULTS.decision, ...(user.decision || {}) };
    cfg.detector = { ...DEFAULTS.detector, ...(user.detector || {}) };
  } catch {}
  return cfg;
}

function resolveApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const ori = JSON.parse(fs.readFileSync(ORI_CREDENTIALS, 'utf8'));
    if (ori.key) return ori.key;
  } catch {}
  if (process.env.ORI_API_KEY) return process.env.ORI_API_KEY;
  return null;
}

function resolveProviderKey(name, cfg) {
  const envMap = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', cerebras: 'CEREBRAS_API_KEY', mistral: 'MISTRAL_API_KEY', clever: 'CLEVER_API_KEY' };
  if (envMap[name] && process.env[envMap[name]]) return process.env[envMap[name]];
  const providers = cfg?.providers || {};
  if (providers[name]?.apiKey) return providers[name].apiKey;
  const keyFiles = {
    groq: path.join(process.env.HOME || '.', '.groq', 'credentials.json'),
    gemini: path.join(process.env.HOME || '.', '.gemini', 'credentials.json'),
    cerebras: path.join(process.env.HOME || '.', '.cerebras', 'credentials.json'),
    mistral: path.join(process.env.HOME || '.', '.mistral', 'credentials.json'),
    clever: path.join(process.env.HOME || '.', '.clever', 'credentials.json'),
  };
  if (keyFiles[name]) {
    try {
      const data = JSON.parse(fs.readFileSync(keyFiles[name], 'utf8'));
      if (data.key) return data.key;
    } catch {}
  }
  return null;
}

function saveConfig(patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  const merged = {
    ...current,
    ...patch,
    bot: { ...(current.bot || {}), ...(patch.bot || {}) },
    providers: { ...(current.providers || {}), ...(patch.providers || {}) },
    decision: { ...(current.decision || {}), ...(patch.decision || {}) },
    detector: { ...(current.detector || {}), ...(patch.detector || {}) },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { loadConfig, resolveApiKey, resolveProviderKey, saveConfig, CONFIG_PATH, DEFAULTS };
