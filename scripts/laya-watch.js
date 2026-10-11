#!/usr/bin/env node
// always-on watcher for the Laya decision layer (Colab tunnel / HF Space).
// Runs every few minutes via systemd user timer. Alerts the Telegram owner
// when the endpoint flips from up -> down (and logs recovery). Autostart of the
// Colab runtime itself still needs a human to press "Connect"; this makes sure
// they hear about it immediately instead of discovering it on a failed gate.
const fs = require('fs');
const path = require('path');
const os = require('os');

const { checkLayaHealth, layaUrl, layaToken } = require('../lib/laya');
const { loadConfig } = require('../lib/config');

const STATE_FILE = path.join(os.homedir(), '.config', 'humanize-ai', 'laya-watch.json');
const TG = 'https://api.telegram.org';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { wasUp: null, since: new Date().toISOString() };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function notify(text) {
  const cfg = loadConfig();
  const token = cfg.bot?.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const ids = cfg.bot?.allowedIds || [];
  for (const id of ids) {
    try {
      await fetch(TG + `/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML' }),
      });
    } catch {}
  }
}

async function main() {
  const cfg = loadConfig();
  const url = layaUrl(cfg);
  const r = await checkLayaHealth();
  const state = loadState();
  const nowIso = new Date().toISOString();

  if (r.ok) {
    if (state.wasUp === false) {
      console.log(`[laya-watch ${nowIso}] recovered ✅`);
      await notify(`✅ <b>Laya decision layer recovered</b>\nURL: <b>${url}</b>\nDevice: ${r.device || '?'}`);
    }
    saveState({ wasUp: true, since: nowIso });
    console.log(`[laya-watch ${nowIso}] up (${r.device || '?'})`);
    return;
  }

  state.wasUp = false;
  state.since = state.since || nowIso;
  saveState(state);
  console.log(`[laya-watch ${nowIso}] DOWN at ${url}: ${r.error}`);

  if (state.notifiedAt && nowIso - state.notifiedAt < 3600_000) {
    console.log('[laya-watch] already alerted recently, skipping duplicate');
    return;
  }
  state.notifiedAt = nowIso;
  saveState(state);
  const downSince = new Date(state.since);
  await notify(
    `⚠️ <b>Laya decision layer is offline</b>\n` +
      `URL: <b>${url}</b>\n` +
      `Since: ${downSince.toLocaleString()}\n\n` +
      `<code>If this was the Colab runtime, reopen the notebook, keep a tab on it, ` +
      `press Connect, and re-run the laya cell. It will re-post layacfg automatically.</code>`,
  );
}

main().catch(e => {
  console.error(`[laya-watch] fatal: ${e.message}`);
  process.exit(1);
});