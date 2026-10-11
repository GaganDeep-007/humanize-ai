#!/usr/bin/env node
// Periodic maintenance for humanize-ai (runs every ~10 days via systemd timer).
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveApiKey, loadConfig } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const STORAGE = path.join(ROOT, 'storage');
const RETENTION_DAYS = Number(process.env.HUMANIZE_RETENTION_DAYS || 10);
const FREE_MODELS_CACHE = path.join(os.homedir(), '.config', 'humanize-ai', 'openrouter-free-models.json');
const report = [];

function log(msg) {
  const line = `[maintenance ${new Date().toISOString()}] ${msg}`;
  report.push(line);
  console.log(line);
}

function cleanupStorage() {
  if (!fs.existsSync(STORAGE)) {
    log('storage: directory missing, skipping');
    return;
  }
  const now = Date.now();
  const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(STORAGE);
  const baseIds = new Set();
  for (const f of files) {
    const m = f.match(/^([a-f0-9]+)-/);
    if (m) baseIds.add(m[1]);
  }
  const graveyard = [];
  for (const baseId of baseIds) {
    const matchFile = files.find(f => f.startsWith(baseId + '-'));
    if (!matchFile) continue;
    const stat = fs.statSync(path.join(STORAGE, matchFile));
    if (now - stat.mtimeMs > maxAge) {
      for (const f of files) {
        if (f.startsWith(baseId + '-')) graveyard.push(f);
      }
    }
  }
  let removed = 0;
  const before = files.length;
  for (const f of graveyard) {
    try { fs.unlinkSync(path.join(STORAGE, f)); removed++; } catch (e) { log(`storage: could not delete ${f}: ${e.message}`); }
  }
  log(`storage: ${before} files, removed ${removed} older than ${RETENTION_DAYS}d (${graveyard.length} matched)`);
}

async function refreshFreeModels() {
  const key = resolveApiKey();
  if (!key) {
    log('openrouter: no API key, skipping model list refresh');
    return;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const free = (data.data || [])
      .map(m => m.id)
      .filter(id => typeof id === 'string' && id.includes(':free'))
      .sort();
    if (free.length === 0) throw new Error('no free models returned');
    fs.mkdirSync(path.dirname(FREE_MODELS_CACHE), { recursive: true });
    fs.writeFileSync(FREE_MODELS_CACHE, JSON.stringify(free, null, 2));
    log(`openrouter: refreshed free model list (${free.length} models) -> ${FREE_MODELS_CACHE}`);
  } catch (e) {
    log(`openrouter: refresh FAILED: ${e.message}`);
  }
}

async function checkLmStudio() {
  const cfg = loadConfig();
  const base = (cfg.lmstudioUrl || 'http://192.168.29.233:1234/v1').replace(/\/+$/, '');
  const nativeApi = base.replace(/\/v1$/, '') + '/api/v0/models';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(nativeApi, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const loaded = (data.data || [])
      .filter(m => m.state === 'loaded' && (m.type === 'llm' || m.type === 'vlm'))
      .map(m => `${m.id} (ctx ${m.loaded_context_length || m.max_context_length || '?'})`);
    log(`lmstudio: reachable${loaded.length ? ` - loaded: ${loaded.join(', ')}` : ' - NO MODEL LOADED'}`);
  } catch (e) {
    log(`lmstudio: NOT REACHABLE: ${e.message}`);
  }
}

async function checkLaya() {
  const { checkLayaHealth } = require('../lib/laya');
  const r = await checkLayaHealth();
  if (r.ok) {
    log(`laya: reachable (device=${r.device || '?'}, routing=${r.routing ? 'ready' : 'not-loaded'})`);
  } else {
    const { loadConfig: cfgLoader } = require('../lib/config');
    const cfg = cfgLoader();
    log(`laya: NOT REACHABLE at ${cfg.layaUrl}: ${r.error}`);
  }
}

async function main() {
  log(`starting (retention ${RETENTION_DAYS}d)`);
  cleanupStorage();
  await refreshFreeModels();
  await checkLmStudio();
  await checkLaya();
  log('done');
  try {
    fs.appendFileSync(path.join(STORAGE, '.maintenance.log'), report.join('\n') + '\n');
  } catch {}
}

main().catch(e => { console.error(`[maintenance] fatal: ${e.message}`); process.exit(1); });