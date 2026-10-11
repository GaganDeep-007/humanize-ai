// Pluggable AI-detector layer — the "judge" model used by robustAnalyze.
//
// Providers, all plain REST (zero deps, global fetch). Free ones first:
//   • sapling         — free developer key (50k chars/day, 250k/month; trail keys EXPIRE in 1 month)
//   • huggingface     — free HF read token (long-lived), hostable text-classification models
//   • contentdetector — FREE, NO KEY (https://contentdetector.net/api) — keyless anchor
//   • kiprio          — FREE, key optional (https://kiprio.com/v1/ai-detect/)
//   • wasitai         — free 1,000 credits (bearer key)
//   • gptzero         — x-api-key, API access bundled with a paid plan
//
// Zero-maintenance: detect() walks a fallback CHAIN (configured provider first,
// then any other available provider, ending at the keyless contentdetector) so
// an expired/absent key never takes the detector down — it silently degrades to
// the next provider. When every provider in the chain fails (or the chain is
// empty because nothing is configured), detect() returns null and the caller
// falls back to the LLM judge. With `fallback:false` (or opts.noFallback) the
// old single-provider semantics apply: missing key → null, provider error → throw.

const { loadConfig } = require('./config');

const SAPLING_ENDPOINT = 'https://api.sapling.ai/api/v1/aidetect';
const GPTZERO_ENDPOINT = 'https://api.gptzero.me/v2/predict/text';
const SAPLING_STATUS_ENDPOINT = 'https://api.sapling.ai/api/v1/account/status';
const HF_ENDPOINT_BASE = 'https://router.huggingface.co/hf-inference/models/';
const CONTENTDETECTOR_ENDPOINT = 'https://contentdetector.net/api/detect.php';
const KIPRIO_ENDPOINT = 'https://kiprio.com/v1/ai-detect/'; // trailing slash required — bare path 301s and drops the POST body
const WASITAI_ENDPOINT = 'https://www.wasitaigenerated.com/api/v1/detect/text';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CHARS = 80000;
const HF_DEFAULT_MODEL = 'Hello-SimpleAI/chatgpt-detector-roberta';
const HF_MAX_CHARS = 1800;   // roberta window (~512 tokens)
const HF_MAX_WINDOWS = 6;    // evenly-spaced samples across a long document
const PROVIDERS = ['sapling', 'huggingface', 'contentdetector', 'kiprio', 'wasitai', 'gptzero'];
const KEY_OPTIONAL = new Set(['contentdetector', 'kiprio']);
// Preferred total order for the fallback chain (configured provider is hoisted to
// the front). Keyless providers come before keyed ones they'd otherwise shadow.
const DEFAULT_CHAIN = ['sapling', 'huggingface', 'contentdetector', 'kiprio', 'wasitai', 'gptzero'];

function resolveDetectorKey(name, cfg) {
  const det = (cfg && cfg.detector) || {};
  if (name === 'sapling') return process.env.SAPLING_API_KEY || det.saplingApiKey || det.apiKey || null;
  if (name === 'gptzero') return process.env.GPTZERO_API_KEY || det.gptzeroApiKey || det.apiKey || null;
  if (name === 'huggingface') return process.env.HF_TOKEN || process.env.HUGGINGFACE_API_KEY || det.hfToken || det.apiKey || null;
  if (name === 'kiprio') return process.env.KIPRIO_API_KEY || det.kiprioApiKey || null;
  if (name === 'wasitai') return process.env.WASITAI_API_KEY || det.wasitaiApiKey || null;
  if (name === 'contentdetector') return det.contentdetectorApiKey || null;
  return det.apiKey || null;
}

function detectorEndpoint(provider, det) {
  if (provider === 'gptzero') return GPTZERO_ENDPOINT;
  if (provider === 'huggingface') return HF_ENDPOINT_BASE + (det.hfModel || HF_DEFAULT_MODEL);
  if (provider === 'contentdetector') return CONTENTDETECTOR_ENDPOINT;
  if (provider === 'kiprio') return KIPRIO_ENDPOINT;
  if (provider === 'wasitai') return WASITAI_ENDPOINT;
  return SAPLING_ENDPOINT;
}

function detectorStatus(cfg = loadConfig()) {
  const det = cfg.detector || {};
  const provider = (det.provider || 'sapling').toLowerCase();
  const key = resolveDetectorKey(provider, cfg);
  const fallback = det.fallback !== false;
  const chain = fallback
    ? buildDetectorChain(cfg, {}).map(c => c.provider)
    : providerKey(provider, cfg, {}) == null ? [] : [provider];
  return {
    enabled: det.enabled !== false,
    provider,
    keySet: KEY_OPTIONAL.has(provider) ? true : !!key,
    keyMasked: key ? `…${String(key).slice(-4)}` : null,
    keyOptional: KEY_OPTIONAL.has(provider),
    weight: det.weight != null ? det.weight : 0.3,
    endpoint: detectorEndpoint(provider, det),
    providers: PROVIDERS,
    fallback,
    chain,
  };
}

function windowText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  for (let i = 0; i < text.length; i += maxChars) parts.push(text.slice(i, i + maxChars));
  return parts;
}

// Evenly-spaced windows of `size` across the document (bounded by maxW) — used
// for small-context detectors (Hugging Face roberta) instead of covering every
// byte, which would be far too many requests.
function windowOffsets(len, size, maxW) {
  if (len <= size) return [0];
  const n = Math.min(Math.max(maxW, 1), Math.ceil(len / size));
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(Math.floor((i * (len - size)) / Math.max(n - 1, 1)));
  return offs;
}

function chooseWindows(text, maxChars, maxWindows) {
  if (text.length <= maxChars) return [text];
  if (!maxWindows || maxWindows <= 1) return windowText(text, maxChars);
  return windowOffsets(text.length, maxChars, maxWindows).map(o => text.slice(o, o + maxChars));
}

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${String(text).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`detector request timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function detectSapling(text, key, opts) {
  const data = await postJson(SAPLING_ENDPOINT, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  }, { key, text }, opts.timeoutMs);
  const score = Number(data.score ?? data.ai_score ?? data.ai_likelihood);
  if (!Number.isFinite(score)) throw new Error('Sapling: unrecognized response shape');
  const flags = Array.isArray(data.sentence_scores) ? [`${data.sentence_scores.length} sentence scores`] : [];
  return { ai: Math.round(score <= 1 ? score * 100 : score), flags };
}

async function detectGptZero(text, key, opts) {
  const body = { document: text };
  if (opts.version) body.version = opts.version;
  const data = await postJson(GPTZERO_ENDPOINT, {
    'Content-Type': 'application/json',
    'x-api-key': key,
  }, body, opts.timeoutMs);
  const doc = Array.isArray(data.documents) ? data.documents[0] : (data.document || data);
  const cp = (doc && doc.class_probabilities) || {};
  let ai = Number(cp.ai ?? doc?.completely_generated_prob ?? doc?.ai_likelihood);
  if (!Number.isFinite(ai)) throw new Error('GPTZero: unrecognized response shape');
  const flags = Object.keys(cp).length
    ? Object.keys(cp).map(k => `${k}=${Math.round(Number(cp[k]) * 100)}%`)
    : [];
  return { ai: ai <= 1 ? Math.round(ai * 100) : Math.round(ai), flags };
}

// ContentDetector.net — free, NO API key. Heuristic (over-flags short text), so
// it is an opt-in provider, not the default.
async function detectContentDetector(text, key, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  const data = await postJson(CONTENTDETECTOR_ENDPOINT, headers, { text }, opts.timeoutMs);
  const score = Number(data.score ?? (Number(data.ai_probability) * 100));
  if (!Number.isFinite(score)) throw new Error('ContentDetector: unrecognized response shape');
  const flags = [data.label ? `label=${data.label}` : null].filter(Boolean);
  return { ai: Math.round(score <= 1 ? score * 100 : score), flags };
}

// Kiprio — free tier; pass a key via X-API-Key (env KIPRIO_API_KEY).
async function detectKiprio(text, key, opts) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key;
  const data = await postJson(KIPRIO_ENDPOINT, headers, { text }, opts.timeoutMs);
  const score = Number(data.score);
  if (!Number.isFinite(score)) throw new Error('Kiprio: unrecognized response shape');
  const flags = [data.label, data.confidence ? `confidence=${data.confidence}` : null].filter(Boolean);
  return { ai: Math.round(score <= 1 ? score * 100 : score), flags };
}

// WasitAI Generated — free tier (1,000 credits, ~1k words); bearer key.
async function detectWasitai(text, key, opts) {
  const data = await postJson(WASITAI_ENDPOINT, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`,
  }, { content: text }, opts.timeoutMs);
  const score = Number(data.confidence ?? data.score);
  if (!Number.isFinite(score)) throw new Error('WasitAI: unrecognized response shape');
  const flags = [data.isAI != null ? `isAI=${data.isAI}` : null].filter(Boolean);
  return { ai: Math.round(score <= 1 ? score * 100 : score), flags };
}

function parseHfClassification(data) {
  let arr = data;
  while (Array.isArray(arr) && arr.length && Array.isArray(arr[0])) arr = arr[0];
  if (!Array.isArray(arr)) return null;
  return arr.filter(x => x && typeof x.label === 'string' && Number.isFinite(Number(x.score)));
}

async function detectHuggingFace(text, key, opts) {
  const model = opts.hfModel || HF_DEFAULT_MODEL;
  const url = HF_ENDPOINT_BASE + model;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
        signal: ctrl.signal,
      });
      if (res.status !== 503) break;
      const retry = await res.clone().json().catch(() => ({}));
      const wait = Math.min(Number(retry.estimated_time || 8), 20);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${String(body).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    let data;
    try { data = JSON.parse(body); } catch { throw new Error('HuggingFace: invalid JSON response'); }
    const items = parseHfClassification(data);
    if (!items || !items.length) throw new Error('HuggingFace: unrecognized response shape');
    const aiItem = items.find(x => /chatgpt|fake|generated|machine|gpt|\bai\b/i.test(x.label) && !/human|real/i.test(x.label));
    const humanItem = items.find(x => /human|real/i.test(x.label));
    let ai;
    if (aiItem) ai = Number(aiItem.score);
    else if (humanItem) ai = 1 - Number(humanItem.score);
    else {
      const idx = opts.aiLabelIndex != null ? opts.aiLabelIndex : 1;
      ai = Number((items[idx] || items[items.length - 1]).score);
    }
    return { ai: Math.round((ai <= 1 ? ai : ai / 100) * 100), flags: items.map(x => `${x.label}=${Math.round(Number(x.score) * 100)}%`) };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`detector request timed out after ${opts.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Resolve the effective key for a provider (opts.apiKey wins for the configured
// one; keyless providers normalize to ''). Returns null = "provider unavailable".
function providerKey(name, cfg, opts = {}) {
  const preferred = String(opts.provider || cfg.detector?.provider || 'sapling').toLowerCase();
  if (opts.apiKey && name === preferred) return opts.apiKey;
  let k = resolveDetectorKey(name, cfg);
  if (k == null && KEY_OPTIONAL.has(name)) k = '';
  return k;
}

// Ordered, available-only provider chain: configured provider first, then the
// default order (keyless contentdetector/kiprio included, so this is never empty
// unless the layer is disabled).
function buildDetectorChain(cfg = loadConfig(), opts = {}) {
  const det = cfg.detector || {};
  const preferred = String(opts.provider || det.provider || 'sapling').toLowerCase();
  const order = Array.isArray(opts.chain) && opts.chain.length ? opts.chain
    : Array.isArray(det.chain) && det.chain.length ? det.chain
    : [preferred, ...DEFAULT_CHAIN.filter(p => p !== preferred)];
  const chain = [];
  for (const raw of order) {
    const name = String(raw || '').toLowerCase();
    if (!PROVIDERS.includes(name) || chain.some(c => c.provider === name)) continue;
    const key = providerKey(name, cfg, opts);
    if (key == null) continue;
    chain.push({ provider: name, key });
  }
  return chain;
}

function windowsFor(provider, text, det, opts) {
  const isHf = provider === 'huggingface';
  const maxChars = opts.maxChars ?? det.maxChars ?? (isHf ? HF_MAX_CHARS : DEFAULT_MAX_CHARS);
  const maxWindows = opts.maxWindows ?? det.maxWindows ?? (isHf ? HF_MAX_WINDOWS : 1);
  return chooseWindows(String(text || ''), maxChars, maxWindows);
}

async function runProviderOnce(provider, text, key, det, opts) {
  const fns = {
    sapling: detectSapling,
    gptzero: detectGptZero,
    huggingface: detectHuggingFace,
    contentdetector: detectContentDetector,
    kiprio: detectKiprio,
    wasitai: detectWasitai,
  };
  const fn = fns[provider];
  if (!fn) throw new Error(`unknown detector provider "${provider}" (expected ${PROVIDERS.join('|')})`);
  const timeoutMs = opts.timeoutMs ?? det.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runOpts = {
    timeoutMs,
    version: opts.version,
    hfModel: opts.hfModel || det.hfModel,
    aiLabelIndex: opts.aiLabelIndex ?? det.aiLabelIndex,
  };
  const windows = windowsFor(provider, text, det, opts);
  const scores = [];
  let flags = [];
  for (const w of windows) {
    const r = await fn(w, key, runOpts);
    scores.push(r.ai);
    if (r.flags?.length) flags = r.flags;
  }
  const ai = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
  return { ai, flags, scores, windowCount: windows.length };
}

// Returns analyzer model-eval fields, or null when disabled / unconfigured.
async function detect(text, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const det = cfg.detector || {};
  if (det.enabled === false) return null;

  const useFallback = opts.noFallback ? false : det.fallback !== false;
  const chain = useFallback
    ? buildDetectorChain(cfg, opts)
    : (() => {
        const name = String(opts.provider || det.provider || 'sapling').toLowerCase();
        if (!PROVIDERS.includes(name)) throw new Error(`unknown detector provider "${name}" (expected ${PROVIDERS.join('|')})`);
        const key = providerKey(name, cfg, opts);
        return key == null ? [] : [{ provider: name, key }];
      })();
  if (!chain.length) return null;

  const str = String(text || '');
  const tried = [];
  const errors = [];
  for (const { provider, key } of chain) {
    tried.push(provider);
    try {
      const r = await runProviderOnce(provider, str, key, det, opts);
      return {
        ai_likelihood: r.ai,
        plagiarism_likelihood: null,
        ai_flags: [`${provider} detector (${r.windowCount} window(s))`].concat(r.flags),
        plagiarism_flags: [],
        verdict: `${provider} detector: ${r.ai}% AI`,
        provider: `detector:${provider}`,
        raw: { windows: r.scores, chainTried: tried.slice() },
      };
    } catch (e) {
      errors.push(`${provider}: ${e.message}`);
      if (!useFallback) throw e;
    }
  }
  throw new Error(`all detectors failed [${errors.join('; ')}]`);
}

// One-shot self-diagnosis. Sapling uses its account-status endpoint (explains
// blocked reasons); every other provider does a tiny live probe.
async function checkAccount(cfg = loadConfig(), opts = {}) {
  const provider = String(opts.provider || cfg.detector?.provider || 'sapling').toLowerCase();
  let key = opts.apiKey || resolveDetectorKey(provider, cfg) || null;
  if (key == null && KEY_OPTIONAL.has(provider)) key = '';
  if (key == null) return { ok: false, provider, error: 'no API key configured' };

  if (provider !== 'sapling') {
    // No dedicated status endpoint — do a tiny live probe.
    try {
      const d = await detect('This is a short, ordinary sentence about my weekend and the weather.', {
        cfg, provider, apiKey: key, maxChars: 100000, maxWindows: 1, noFallback: true,
      });
      if (!d || d.ai_likelihood == null) return { ok: false, provider, error: 'probe returned no score' };
      return { ok: true, provider, probeAi: d.ai_likelihood };
    } catch (e) {
      return { ok: false, provider, error: e.message };
    }
  }

  const timeoutMs = opts.timeoutMs || cfg.detector?.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SAPLING_STATUS_ENDPOINT}?key=${encodeURIComponent(key)}`, { signal: ctrl.signal });
    const body = await res.text();
    let data;
    try { data = JSON.parse(body); } catch { data = { raw: String(body).slice(0, 300) }; }
    if (res.status === 200) {
      return {
        ok: !!data.api_access,
        provider,
        status: res.status,
        blockedReason: data.blocked_reason || null,
        message: data.message || null,
        retryAfter: data.retry_after ?? null,
        subscription: data.subscription || null,
        usage: data.usage || null,
      };
    }
    return { ok: false, provider, status: res.status, error: data.msg || data.message || String(body).slice(0, 200) };
  } catch (e) {
    return { ok: false, provider, error: e.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

module.exports = {
  detect,
  detectorStatus,
  checkAccount,
  buildDetectorChain,
  resolveDetectorKey,
  SAPLING_ENDPOINT,
  GPTZERO_ENDPOINT,
  SAPLING_STATUS_ENDPOINT,
  CONTENTDETECTOR_ENDPOINT,
  KIPRIO_ENDPOINT,
  WASITAI_ENDPOINT,
  PROVIDERS,
  DEFAULT_CHAIN,
};
