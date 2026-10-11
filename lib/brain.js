const { completeLmStudio, isLmStudioReachable } = require('./provider');
const { loadConfig } = require('./config');
const { layaVerify, layaHumanScore, isLayaReachable, DEFAULT_CONF_GATE } = require('./laya');

const BRAIN_VERIFY_PROMPT = `
You are the quality-control supervisor of a document rewriting pipeline.
Compare the ORIGINAL text with the REWRITTEN text and check for hallucination.

ORIGINAL:
{{ORIGINAL}}

---

REWRITTEN:
{{REWRITTEN}}

Rules:
1. Flag any invented facts, numbers, names, dates, or claims NOT present in the original.
2. Flag any binary garbage, PDF objects, code snippets, JSON, or non-prose content injected by the rewriting model.
3. Flag anything that contradicts the original meaning.
4. Flag meta-text that is NOT part of a rewrite: "thinking process", numbered analysis steps, explanations of HOW the text was written, "here's my rewrite", apologies, or anything that reads like a chat reply rather than the rewritten prose itself.
5. The rewriting may rephrase and restructure, but ALL factual meaning must be preserved.
6. If the rewritten text is clean, faithful, and is pure prose (no reasoning, no labels), approved must be true.

Return ONLY a JSON object:
{"approved": true or false, "hallucinations": ["concrete issue 1", ...], "drift": "short description or none", "fidelity": <0-100, how faithfully the meaning is kept>}

Keep hallucinations concise: max 3 entries, each under 12 words.`;

const BRAIN_JUDGE_PROMPT = `
Rate how much the text below sounds like it was written by a real human rather than an AI.
0 = unmistakably AI-generated, 100 = indistinguishable from a human writer.

<TEXT>
{{TEXT}}
</TEXT>

Return ONLY this exact JSON object (nothing else):
{"human_score": <integer 0-100>}`;

const CORRECTIVE_FEEDBACK_PROMPT = `
The text you wrote earlier was REJECTED by the quality-control supervisor for these specific problems:

{{ISSUES}}

Fix ONLY these problems. Keep the rest of the text exactly as-is. Do not rewrite the whole thing.

Output ONLY the corrected text — no preamble, no explanation.`;

let brainCache = { reachable: null, checkedAt: 0 };

async function brainAvailable() {
  const now = Date.now();
  if (brainCache.reachable !== null && now - brainCache.checkedAt < 30000) {
    return brainCache.reachable;
  }
  brainCache.reachable = await isLmStudioReachable();
  brainCache.checkedAt = now;
  return brainCache.reachable;
}

function parseJsonStrict(s) {
  let cleaned = String(s || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in response');
  cleaned = cleaned.slice(start, end + 1);
  // Tolerate trailing commas that small local models sometimes emit
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  // Drop a trailing '"..."' that can appear after the JSON object
  cleaned = cleaned.replace(/"\s*[)}]\s*$/, '}');
  return JSON.parse(cleaned);
}

// Attempt to salvage JSON truncated mid-string by closing the dangling string
// and any unbalanced brackets (LM Studio models often stop before closing).
function tolerantParseJson(raw) {
  let s = String(raw || '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  s = s.slice(start);
  s = s.replace(/,\s*([}\]])/g, '$1'); // tolerate trailing commas
  const attempt = x => {
    try { return JSON.parse(x); } catch { return null; }
  };
  let ok = attempt(s);
  if (ok) return ok;
  const closers = new Set(['}', ']']);
  for (let i = s.length - 1; i >= 0; i--) {
    if (closers.has(s[i])) {
      ok = attempt(s.slice(0, i + 1).replace(/,\s*([}\]])/g, '$1'));
      if (ok) return ok;
      // a } without a closing ] before it can break the object; strip the bad tail
      ok = attempt(s.slice(0, i).replace(/,\s*([}\]])/g, '$1') + '}');
      if (ok) return ok;
    }
  }
  if ((s.match(/"/g) || []).length % 2 === 1) s += '"';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') stack.push(ch);
    else if ((ch === '}' || ch === ']') && stack.length) {
      const open = stack[stack.length - 1];
      if ((open === '{' && ch === '}') || (open === '[' && ch === ']')) stack.pop();
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) s += stack[i] === '{' ? '}' : ']';
  return attempt(s);
}

// LM Studio brain calls that return strict JSON: repair parse failures and
// retry once before giving up (LM Studio frequently truncates mid-string).
async function completeLmStudioJson(model, messages, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await completeLmStudio(model, messages, { ...opts, temperature: attempt > 0 ? 0 : (opts.temperature ?? 0.2) });
    try {
      return { raw, parsed: parseJsonStrict(raw) };
    } catch (e) {
      lastErr = e;
      const salvaged = tolerantParseJson(raw);
      if (salvaged) {
        console.error(`  [brain] JSON truncated — salvaged via closure repair`);
        return { raw, parsed: salvaged };
      }
      console.error(`  [brain] JSON parse failed (attempt ${attempt + 1}/2): ${e.message}`);
    }
  }
  throw lastErr;
}

function buildFeedbackCx(issues, notes) {
  if (!issues || issues.length === 0) return '(no specific issues — proceed with the polish instructions below)';
  return `The supervisor flagged these issues:\n${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}${notes ? `\nIt also noted: ${notes}` : ''}`;
}

async function brainVerify(original, rewritten, opts = {}) {
  try {
    const cfg = loadConfig();
    const confGate = opts.confGate ?? cfg.layaConfGate ?? DEFAULT_CONF_GATE;
    const laya = await layaVerify(original, rewritten, opts);
    if (laya.used && laya.confidence >= confGate) {
      console.error(`  [brain] verify via LAYA → approved=${laya.ok}, conf=${laya.confidence.toFixed(2)}`);
      return {
        used: true,
        ok: laya.ok,
        issues: laya.issues,
        drift: laya.ok ? 'none' : laya.issues.join('; ') || 'laya issues',
        fidelity: laya.fidelity,
        judge: 'laya',
      };
    }
    if (laya.used && laya.confidence < confGate) {
      console.error(`  [brain] Laya low confidence (${laya.confidence.toFixed(2)} < ${confGate}) — falling back to LLM brain`);
    }
    if (!(await brainAvailable())) {
      console.error('  [brain] local brain unavailable (LM Studio down) — skipping verification');
      return { used: false, ok: true, issues: [], score: null, fidelity: null };
    }
    const lmModel = opts.lmModel || cfg.lmModel || 'lmstudio/qwen/qwen2.5-vl-7b';
    const { parsed } = await completeLmStudioJson(lmModel, [
      { role: 'system', content: 'You output strict JSON only.' },
      { role: 'user', content: BRAIN_VERIFY_PROMPT.replace('{{ORIGINAL}}', original).replace('{{REWRITTEN}}', rewritten) },
    ], { temperature: 0.2, maxTokens: 1500 });
    const issues = Array.isArray(parsed.hallucinations) ? parsed.hallucinations : [];
    console.error(`  [brain] verify → approved=${parsed.approved}, issues=${issues.length}, fidelity=${parsed.fidelity ?? '?'}`);
    return {
      used: true,
      ok: parsed.approved !== false,
      issues,
      drift: parsed.drift || 'none',
      fidelity: parsed.fidelity ?? null,
    };
  } catch (e) {
    console.error(`  [brain] verify failed, proceeding without brain: ${e.message}`);
    return { used: false, ok: true, issues: [], score: null, fidelity: null };
  }
}

async function brainJudge(text, opts = {}) {
  try {
    const cfg = loadConfig();
    const confGate = opts.confGate ?? cfg.layaConfGate ?? DEFAULT_CONF_GATE;
    const laya = await layaHumanScore(text, opts);
    if (laya && laya.confidence >= confGate) {
      console.error(`  [brain] judge via LAYA → human_score=${laya.human_score}`);
      return { human_score: laya.human_score, remaining: [], notes: 'laya' };
    }
    if (laya && laya.confidence < confGate) {
      console.error(`  [brain] Laya judge low confidence (${laya.confidence.toFixed(2)}) — trying LLM brain`);
    }
    if (!(await brainAvailable())) return null;
    const lmModel = opts.lmModel || cfg.lmModel || 'lmstudio/qwen/qwen2.5-vl-7b';
    const { parsed } = await completeLmStudioJson(lmModel, [
      { role: 'system', content: 'You output strict JSON only.' },
      { role: 'user', content: BRAIN_JUDGE_PROMPT.replace('{{TEXT}}', text) },
    ], { temperature: 0.2, maxTokens: 1000 });
    console.error(`  [brain] judge → human_score=${parsed.human_score}`);
    return {
      human_score: Number(parsed.human_score) || 0,
      remaining: Array.isArray(parsed.remaining_ai_words) ? parsed.remaining_ai_words : [],
      notes: parsed.notes || '',
    };
  } catch (e) {
    console.error(`  [brain] judge failed: ${e.message}`);
    return null;
  }
}

function loadMemory(sessionKey) {
  try {
    const fs = require('fs');
    const base = process.env.HUMANIZE_STORAGE || require('path').join(require('path').dirname(__dirname), 'storage');
    const p = require('path').join(base, `${sessionKey}-brain-memory.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return { glossary: [], rejectedModels: {}, sessions: [] };
}

function saveMemory(sessionKey, mem) {
  try {
    const fs = require('fs');
    const path = require('path');
    const base = process.env.HUMANIZE_STORAGE || path.join(path.dirname(__dirname), 'storage');
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, `${sessionKey}-brain-memory.json`), JSON.stringify(mem, null, 2));
  } catch (e) {
    console.error(`  [brain] memory save failed: ${e.message}`);
  }
}

function rememberModelResult(mem, provider, model, rejected, reason) {
  if (!mem) return mem;
  if (!mem.rejectedModels) mem.rejectedModels = {};
  const key = `${provider}:${model}`;
  if (!mem.rejectedModels[key]) mem.rejectedModels[key] = { rejects: 0, ok: 0, lastReason: '' };
  if (rejected) {
    mem.rejectedModels[key].rejects++;
    mem.rejectedModels[key].lastReason = reason || '';
  } else {
    mem.rejectedModels[key].ok++;
  }
  return mem;
}

module.exports = {
  brainVerify,
  brainJudge,
  brainAvailable,
  buildFeedbackCx,
  loadMemory,
  saveMemory,
  rememberModelResult,
  tolerantParseJson,
  BRAIN_VERIFY_PROMPT,
  BRAIN_JUDGE_PROMPT,
  CORRECTIVE_FEEDBACK_PROMPT,
  DEFAULT_CONF_GATE,
};