const { resolveApiKey, resolveProviderKey, loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CFG = {
  lmstudioUrl: process.env.LMSTUDIO_URL || 'http://192.168.29.233:1234/v1',
  lmstudioTimeoutMs: Number(process.env.LMSTUDIO_TIMEOUT_MS || 180000),
};

const OPENROUTER_FREE_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'inclusionai/ling-3.0-flash-sante:free',
  'liquid/lfm-2.5-2.6b:free',
  'dots-studio/dots-3-note-preview:free',
];

const FREE_MODELS_CACHE = path.join(os.homedir(), '.config', 'humanize-ai', 'openrouter-free-models.json');
const FREE_MODELS_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

function getOpenRouterFreeModels() {
  try {
    const stat = fs.statSync(FREE_MODELS_CACHE);
    if (Date.now() - stat.mtimeMs < FREE_MODELS_MAX_AGE_MS) {
      const parsed = JSON.parse(fs.readFileSync(FREE_MODELS_CACHE, 'utf8'));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(id => typeof id === 'string' && id.includes(':free'));
      }
    }
  } catch {}
  return OPENROUTER_FREE_MODELS;
}

let orRotationIndex = 0;
function nextOpenRouterModel() {
  const models = getOpenRouterFreeModels();
  if (!models || models.length === 0) return OPENROUTER_FREE_MODELS[orRotationIndex % OPENROUTER_FREE_MODELS.length];
  orRotationIndex = (orRotationIndex + 1) % models.length;
  return models[orRotationIndex];
}

const FREE_PROVIDERS = [
  { name: 'groq', envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: ['qwen/qwen3.8-27b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'], signupUrl: 'https://console.groq.com' },
  { name: 'gemini', envKey: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.0-flash', 'gemini-2.5-flash'], signupUrl: 'https://aistudio.google.com/apikey' },
  { name: 'cerebras', envKey: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'qwen-2.5-72b-instruct'], signupUrl: 'https://cloud.cerebras.ai' },
  { name: 'mistral', envKey: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'], signupUrl: 'https://console.mistral.ai' },
];

let providerRotationIndex = 0;
let availableProviders = null;

function getAvailableProviders(cfg) {
  if (availableProviders) return availableProviders;
  const providers = [];
  const pcfg = cfg?.providers || {};

  for (const p of FREE_PROVIDERS) {
    const key = resolveProviderKey(p.name, cfg);
    const enabled = pcfg[p.name]?.enabled !== false;
    if (enabled && key) {
      providers.push({ ...p, apiKey: key });
    }
  }
  availableProviders = providers;
  return providers;
}

function resetProviderCache() {
  availableProviders = null;
}

function nextFreeProvider() {
  const providers = availableProviders || [];
  if (providers.length === 0) return null;
  providerRotationIndex = (providerRotationIndex + 1) % providers.length;
  return providers[providerRotationIndex];
}

function setLmStudioUrl(url) {
  CFG.lmstudioUrl = url;
}

function providerFor(model) {
  if (/^openrouter\//.test(model)) return 'openrouter';
  if (/^lmstudio\//.test(model)) return 'lmstudio';
  if (/^groq\//.test(model)) return 'groq';
  if (/^gemini\//.test(model)) return 'gemini';
  if (/^cerebras\//.test(model)) return 'cerebras';
  if (/^mistral\//.test(model)) return 'mistral';
  if (/^clever\//.test(model)) return 'clever';
  return 'openrouter';
}

async function isLmStudioReachable() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.lmstudioTimeoutMs);
    const res = await fetch(CFG.lmstudioUrl + '/models', {
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    return res.ok;
  } catch {
    return false;
  }
}

async function completeLmStudio(model, messages, opts = {}) {
  const maxRetries = 2;
  for (let retry = 0; retry <= maxRetries; retry++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CFG.lmstudioTimeoutMs);
    try {
      const res = await fetch(CFG.lmstudioUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: model.replace(/^lmstudio\//, ''),
          messages,
          temperature: opts.temperature ?? 0.9,
          max_tokens: opts.maxTokens ?? 8192,
        }),
      }).finally(() => clearTimeout(t));
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const msg = `LM Studio error ${res.status}: ${body.slice(0, 300)}`;
        if (res.status === 400 && retry < maxRetries) {
          console.error(`  [provider] LM Studio 400 (${body.slice(0, 80)}), retry ${retry + 1}/${maxRetries}...`);
          await sleep(2000 * (retry + 1));
          continue;
        }
        throw new Error(msg);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty LM Studio response');
      return content.trim();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('LM Studio request timed out (laptop server not responding)');
      throw e;
    }
  }
}

async function completeOpenRouterSingle(model, messages, opts = {}) {
  const key = resolveApiKey();
  if (!key) throw new Error('No OpenRouter API key found. Run: ori login');
  const actualModel = model.replace(/^openrouter\//, '');
  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://localhost/humanize-ai',
      'X-Title': 'humanize-ai',
    },
    body: JSON.stringify({
      model: actualModel,
      messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 8192,
    }),
  });
  if (res.ok) {
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      const err = new Error('Empty model response');
      err.status = 429;
      throw err;
    }
    return content.trim();
  }
  const body = await res.text().catch(() => '');
  const err = new Error(`API error ${res.status}: ${body.slice(0, 400)}`);
  err.status = res.status;
  err.provider = 'openrouter';
  throw err;
}

async function completeFreeProvider(provider, messages, opts = {}) {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.models[0],
      messages,
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 8192,
    }),
  });
  if (res.ok) {
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    let content = msg?.content || msg?.reasoning || '';
    if (!content || !content.trim()) {
      const err = new Error('Empty response');
      err.status = 429;
      throw err;
    }
    return content.trim();
  }
  const body = await res.text().catch(() => '');
  const err = new Error(`API error ${res.status}: ${body.slice(0, 400)}`);
  err.status = res.status;
  err.provider = provider.name;
  throw err;
}

async function completeOpenRouter(model, messages, opts = {}) {
  const cfg = loadConfig();
  const providers = getAvailableProviders(cfg);
  const maxAttempts = 7;
  const providerTimeoutMs = Number(opts.providerTimeoutMs || process.env.PROVIDER_TIMEOUT_MS || cfg.providerTimeoutMs || 120000);
  let lastErr;

  const isFreeModel = model === 'openrouter/free' || model === 'free';

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let currentModel = model;
    let currentProvider = null;

    if (attempt === 0 && !isFreeModel) {
      currentModel = model;
    } else if (providers.length > 0) {
      currentProvider = nextFreeProvider();
      currentModel = null;
    } else {
      currentModel = nextOpenRouterModel();
    }

    try {
      let result;
      if (currentProvider) {
        result = await Promise.race([
          completeFreeProvider(currentProvider, messages, opts),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), providerTimeoutMs)),
        ]);
        console.error(`  [provider] ${currentProvider.name} succeeded`);
      } else {
        result = await Promise.race([
          completeOpenRouterSingle(currentModel, messages, opts),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), providerTimeoutMs)),
        ]);
        console.error(`  [provider] OpenRouter ${currentModel} succeeded`);
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (e.status === 429 || e.status === 404 || e.status === 403 || e.status >= 500 || e.message === 'timeout') {
        const who = currentProvider ? currentProvider.name : 'openrouter';
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
        const jitter = Math.floor(Math.random() * 1000);
        console.error(`  [provider] ${e.status || 'timeout'} on ${who} (attempt ${attempt + 1}/${maxAttempts + 1}), retrying in ${((backoff + jitter) / 1000).toFixed(1)}s...`);
        await sleep(backoff + jitter);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`All LLM providers timed out/failed after ${maxAttempts + 1} attempts (last: ${lastErr.message || lastErr.status})`);
}

// Clever AI Humanizer (cleverhumanizer.ai) — STUB.
// Their public API is announced as "coming soon" (POST /v1/detect · POST /v1/humanize),
// so this path stays inert until providers.clever is enabled with a key AND
// available:true. Once the API opens, the request/response shape below is the
// documented-anticipated one and can be adjusted in one place.
async function completeClever(model, messages, opts = {}) {
  const cfg = loadConfig();
  const c = cfg.providers?.clever || {};
  if (c.enabled === false) throw new Error('Clever AI Humanizer disabled (providers.clever.enabled=false)');
  const apiKey = resolveProviderKey('clever', cfg);
  if (!apiKey) throw new Error('Clever AI Humanizer: no API key (providers.clever.apiKey)');
  if (c.available !== true) {
    throw new Error('Clever AI Humanizer API is not public yet (cleverhumanizer.ai/api — "coming soon"); set providers.clever.available=true once it opens');
  }
  const userMsg = [...messages].reverse().find(m => m.role === 'user');
  const text = (userMsg && userMsg.content) || '';
  const url = String(c.baseUrl || 'https://cleverhumanizer.ai/v1').replace(/\/+$/, '') + '/humanize';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ text, model: model.replace(/^clever\//, '') || undefined }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Clever API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = data.humanized || data.text || data.result;
  if (!out || !String(out).trim()) throw new Error('Clever API: empty response');
  return String(out).trim();
}

async function complete(model, messages, opts = {}) {
  const prov = providerFor(model);
  if (prov === 'lmstudio') {
    const err = await completeLmStudio(model, messages, opts).catch(e => e);
    if (err instanceof Error) throw err;
    return err;
  }
  if (prov === 'clever') {
    return completeClever(model, messages, opts);
  }
  return completeOpenRouter(model, messages, opts);
}

async function completeJudge(model, messages, opts = {}) {
  const prov = providerFor(model);
  if (prov === 'lmstudio') {
    const text = await completeLmStudio(model, messages, opts);
    return { text, provider: 'lmstudio' };
  }
  if (prov !== 'openrouter') {
    const cfg = loadConfig();
    const g = cfg.providers?.[prov];
    if (!g || g.enabled === false) throw new Error(`judge provider ${prov} disabled`);
    const apiKey = resolveProviderKey(prov, cfg);
    if (!apiKey) throw new Error(`judge provider ${prov}: no API key`);
    const id = model.replace(new RegExp(`^${prov}/`), '') || g.models?.[0];
    if (!id) throw new Error(`judge provider ${prov}: no model id in "${model}"`);
    const base = { name: prov, baseUrl: g.baseUrl, apiKey, models: [id] };
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await completeFreeProvider(base, messages, opts);
        return { text, provider: prov };
      } catch (e) {
        lastErr = e;
        if (e.status === 429 || e.status >= 500) {
          await sleep(attempt === 0 ? 5000 : 15000);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
  const text = await completeOpenRouter(model, messages, opts);
  return { text, provider: 'openrouter' };
}

async function completeWithFallback(lmModel, orModel, messages, opts = {}) {
  const mode = opts.mode ?? 'lmstudio-first';
  if (mode === 'openrouter-only') {
    return { text: await completeOpenRouter(orModel, messages, opts), provider: 'openrouter' };
  }
  if (mode === 'lmstudio-only') {
    return { text: await completeLmStudio(lmModel, messages, opts), provider: 'lmstudio' };
  }
  if (mode === 'openrouter-first') {
    try {
      return { text: await completeOpenRouter(orModel, messages, opts), provider: 'openrouter' };
    } catch (e) {
      console.error(`  [provider] OpenRouter failed, falling back to LM Studio...`);
      return { text: await completeLmStudio(lmModel, messages, opts), provider: 'lmstudio' };
    }
  }
  // default: lmstudio-first
  try {
    return { text: await completeLmStudio(lmModel, messages, opts), provider: 'lmstudio' };
  } catch (e) {
    console.error(`  [provider] LM Studio failed (${e.message}), falling back to OpenRouter/free providers...`);
    return { text: await completeOpenRouter(orModel, messages, opts), provider: 'openrouter' };
  }
}

module.exports = {
  complete,
  completeLmStudio,
  completeOpenRouter,
  completeWithFallback,
  completeJudge,
  completeClever,
  isLmStudioReachable,
  providerFor,
  setLmStudioUrl,
  resetProviderCache,
  CFG,
  OPENROUTER_FREE_MODELS,
  FREE_PROVIDERS,
};
