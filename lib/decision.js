const crypto = require('crypto');
const { loadConfig } = require('./config');
const { robustAnalyze } = require('./analyzer');
const { callWorker, sanitizeLlmOutput, HUMANIZE_PROMPT, REFINEMENT_PROMPT, VOICE_POLISH_PROMPT, styleBlockText } = require('./humanizer');
const { brainVerify, rememberModelResult } = require('./brain');
const { isLmStudioReachable } = require('./provider');

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_WALL_CLOCK_MS = 20 * 60 * 1000;
const DEFAULT_MIN_TRUST_WORDS = 50;
const CHUNK_MAX_CHARS = 16000;
const GROQ_ITPM_CEILING = 7000;

const STRATEGY_REGISTRY = [
  { id: 'arm-lm', workerMode: 'lmstudio-first', temperature: 0.9, promptId: 'humanize', label: 'arm rewrite (LM Studio first)' },
  { id: 'arm-or', workerMode: 'openrouter-only', temperature: 0.9, promptId: 'humanize', label: 'arm rewrite (Groq/OpenRouter)' },
  { id: 'refine-lm', workerMode: 'lmstudio-first', temperature: 0.7, promptId: 'refine', label: 'corrective polish (LM first)' },
  { id: 'refine-or', workerMode: 'openrouter-only', temperature: 0.7, promptId: 'refine', label: 'corrective polish (OpenRouter)' },
  { id: 'polish-lm', workerMode: 'lmstudio-first', temperature: 0.85, promptId: 'polish', label: 'voice polish (LM first)' },
  { id: 'polish-or', workerMode: 'openrouter-only', temperature: 0.85, promptId: 'polish', label: 'voice polish (OpenRouter)' },
];

let lastDecision = null;
let budgetSnapshot = { maxAttempts: DEFAULT_MAX_ATTEMPTS, wallClockMs: DEFAULT_WALL_CLOCK_MS };

function strategyKey(s) {
  return `${s.workerMode}|${s.promptId}|${s.temperature}`;
}

function promptFor(promptId, text, feedback, style) {
  const sb = styleBlockText(style);
  if (promptId === 'refine') {
    return REFINEMENT_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text) + (feedback ? `\n\n${feedback}` : '');
  }
  if (promptId === 'polish') {
    return VOICE_POLISH_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text) + (feedback ? `\n\n${feedback}` : '');
  }
  return HUMANIZE_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text);
}

function systemFor(promptId) {
  if (promptId === 'refine') return 'You are a meticulous copy editor who fixes specific problems without rewriting everything.';
  if (promptId === 'polish') return 'You are a human writer who refines the voice of a text without rebuilding it. Keep every fact — only the phrasing and rhythm change.';
  return 'You are a skilled human editor who makes AI text read like a real person wrote it — refine the voice, keep every fact.';
}

// Ground the next refinement attempt in real detector evidence (Clever-style
// self-review: "reads naturally? no → refine, using the concrete flags").
function detectorFeedback(g, threshold) {
  if (!g?.analysis) return '';
  const h = g.analysis.heuristic || {};
  const m = g.analysis.model || {};
  const lines = [];
  lines.push(`DETECTOR FEEDBACK — the last attempt still scored AI ${g.combined ?? 'n/a'}% (target ≤ ${threshold ?? 'n/a'}%). Be specific; fix only what is listed here, then recheck.`);
  const hints = [];
  if (h.topPhrases?.length) hints.push(`repeated AI phrasing: ${h.topPhrases.slice(0, 5).join(', ')}`);
  if (h.repetitiveStarts) hints.push('sentences keep starting the same way');
  if (h.sentenceLengthCV != null && h.sentenceLengthCV < 0.45) hints.push(`sentence rhythm too uniform (length CV ${h.sentenceLengthCV})`);
  if (h.repetitiveStructure > 0) hints.push('repetitive parallel sentence structure');
  if (h.passiveVoiceCount > 0) hints.push(`passive voice still present (${h.passiveVoiceCount})`);
  if (h.nominalizationCount > 0) hints.push(`hedged/nominalized phrasing (${h.nominalizationCount})`);
  if (h.grammarlyFlags?.length) hints.push(`formal filler still present (${h.grammarlyFlags.slice(0, 4).join(', ')})`);
  if (h.metaFlags?.length) hints.push(`machine-reasoning text present (${h.metaFlags.join(', ')})`);
  for (const k of (m.ai_flags || [])) hints.push(`detector note: ${k}`);
  if (hints.length) lines.push(`${hints.length === 1 ? 'Signal' : 'Signals'} found: ${hints.join('; ')}.`);
  else lines.push('No specific pattern detected — rework sentence rhythm and flat tone directly.');
  return lines.join('\n');
}

function chunkForRewrite(text, maxChars = CHUNK_MAX_CHARS) {
  if (!text || text.length <= maxChars) return [text];
  const parts = [];
  let buf = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((buf + '\n\n' + para).length > maxChars && buf) {
      parts.push(buf);
      buf = para;
    } else {
      buf = buf ? buf + '\n\n' + para : para;
    }
    while (buf.length > maxChars) {
      parts.push(buf.slice(0, maxChars));
      buf = buf.slice(maxChars);
    }
  }
  if (buf) parts.push(buf);
  return parts.length ? parts : [text];
}

async function gate(text, model, opts = {}) {
  const cfg = loadConfig();
  const analysis = await robustAnalyze(text, model, opts);
  const combined = analysis.combined.ai_likelihood;
  const threshold = opts.aiThreshold ?? cfg.aiThreshold;
  return {
    combined,
    heuristic: analysis.heuristic.score,
    modelAi: analysis.model.ai_likelihood,
    provider: analysis.provider,
    plagiarism: analysis.combined.plagiarism_likelihood,
    threshold,
    pass: combined <= threshold,
    analysis,
  };
}

async function gateOriginal(text, model, opts = {}) {
  const cfg = loadConfig();
  const words = (text || '').split(/\s+/).filter(Boolean).length;
  const minTrust = opts.minTrustWords ?? cfg.decision?.minTrustWords ?? DEFAULT_MIN_TRUST_WORDS;
  const threshold = opts.aiThreshold ?? cfg.aiThreshold;
  const started = Date.now();

  if (!text || words < minTrust) {
    const verdict = 'undecidable';
    lastDecision = {
      at: new Date().toISOString(), kind: 'gate-original', verdict, reason: `too short (${words} words < ${minTrust})`,
      words, chars: (text || '').length, threshold, combined: null, heuristic: null, elapsedMs: Date.now() - started,
    };
    console.error(`  [decision] gate → undecidable (${words} words < minTrust ${minTrust})`);
    return { verdict, reason: lastDecision.reason, words, threshold, combined: null, heuristic: null };
  }

  const g = await (opts.gate || gate)(text, model, opts);
  let verdict;
  let reason;
  if (g.modelAi == null) {
    verdict = 'undecidable';
    reason = 'model eval unavailable — measurement not trustworthy';
  } else if (g.pass) {
    verdict = 'skip';
    reason = `already within threshold (${g.combined}% ≤ ${g.threshold}%)`;
  } else {
    verdict = 'humanize';
    reason = `above threshold (${g.combined}% > ${g.threshold}%)`;
  }

  lastDecision = {
    at: new Date().toISOString(), kind: 'gate-original', verdict, reason,
    words, chars: (text || '').length, threshold,
    combined: g.combined, heuristic: g.heuristic, modelAi: g.modelAi, provider: g.provider,
    elapsedMs: Date.now() - started,
  };
  console.error(`  [decision] gate → ${verdict}: ${reason} [heuristic ${g.heuristic}%, model ${g.modelAi ?? 'n/a'}%]`);
  return { verdict, reason, words, threshold, combined: g.combined, heuristic: g.heuristic, modelAi: g.modelAi, provider: g.provider };
}

function historyFor(memory, key) {
  return memory?.rejectedModels?.[`${key}:strategy`] || null;
}

function roster(cfg = loadConfig(), memory = null, lmUp = null) {
  return STRATEGY_REGISTRY.map(s => {
    let effective = { ...s };
    let note = '';
    if (s.workerMode.includes('lmstudio') && lmUp === false) {
      effective.workerMode = 'openrouter-only';
      note = 'LM down → OpenRouter';
    }
    const key = strategyKey(effective);
    return {
      id: s.id, label: s.label, key,
      workerMode: effective.workerMode, promptId: s.promptId, temperature: s.temperature,
      note, history: historyFor(memory, key),
    };
  });
}

async function pickWorker(ctx = {}) {
  const cfg = ctx.cfg || loadConfig();
  const memory = ctx.memory || null;
  const tried = new Set(ctx.triedKeys || []);
  const inputLength = ctx.inputLength ?? 0;
  const lmUp = ctx.lmUp != null ? ctx.lmUp : await isLmStudioReachable().catch(() => false);

  const rejectBias = (key) => {
    const hist = historyFor(memory, key);
    if (!hist) return 0;
    const total = (hist.ok || 0) + (hist.rejects || 0);
    if (!total) return 0;
    return (hist.rejects || 0) / total;
  };

  const candidates = [];
  for (const s of STRATEGY_REGISTRY) {
    let eff = { ...s };
    if (s.workerMode.includes('lmstudio') && !lmUp) {
      eff.workerMode = 'openrouter-only';
    }
    const key = strategyKey(eff);
    if (tried.has(key)) continue;
    candidates.push({
      ...eff, key, lmCollapsed: eff.workerMode !== s.workerMode,
      rejectBias: rejectBias(key),
      groqItpmRisk: inputLength > (GROQ_ITPM_CEILING * 3.5) ? 1 : 0,
    });
  }

  candidates.sort((a, b) => {
    if (a.rejectBias !== b.rejectBias) return a.rejectBias - b.rejectBias;
    if (a.groqItpmRisk !== b.groqItpmRisk) return a.groqItpmRisk - b.groqItpmRisk;
    return STRATEGY_REGISTRY.findIndex(x => x.id === a.id) - STRATEGY_REGISTRY.findIndex(x => x.id === b.id);
  });

  const chosen = candidates[0] || null;
  if (chosen) {
    console.error(`  [decision] pickWorker → ${chosen.id} (${chosen.key})${chosen.lmCollapsed ? ' [LM down, collapsed]' : ''}${chosen.rejectBias > 0.5 ? ` [rejectBias ${chosen.rejectBias.toFixed(2)}]` : ''}`);
  } else {
    console.error('  [decision] pickWorker → none left (all distinct strategies tried)');
  }
  return chosen;
}

function budgetFrom(cfg = loadConfig()) {
  const d = cfg.decision || {};
  return {
    maxAttempts: d.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    wallClockMs: d.wallClockMs || DEFAULT_WALL_CLOCK_MS,
    minTrustWords: d.minTrustWords || DEFAULT_MIN_TRUST_WORDS,
  };
}

async function defaultRewrite(strategy, text, opts) {
  const feedback = opts.feedback || '';
  const messages = [
    { role: 'system', content: systemFor(strategy.promptId) },
    { role: 'user', content: promptFor(strategy.promptId, text, feedback, opts.style) },
  ];
  return callWorker(messages, {
    ...opts,
    temperature: strategy.temperature,
    workerMode: strategy.workerMode,
  });
}

async function runUntilPass(text, model, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const budget = { ...budgetFrom(cfg), ...opts.budget };
  budgetSnapshot = budget;
  const rewrite = opts.rewrite || defaultRewrite;
  const gateFn = opts.gate || ((t) => gate(t, model, opts));
  const memory = opts.memory || null;
  const started = Date.now();
  const triedKeys = [...(opts.triedKeys || [])];
  const attempts = [];
  let best = null;
  let stopReason = 'no-strategies';
  let feedback = '';
  const threshold = opts.aiThreshold ?? cfg.aiThreshold;
  const lmUp = opts.lmUp != null ? opts.lmUp : await isLmStudioReachable().catch(() => false);
  const verifyFn = opts.brainVerify || brainVerify;

  console.error(`  [decision] runUntilPass: budget ${budget.maxAttempts} attempts / ${(budget.wallClockMs / 60000).toFixed(0)} min, input ${text.length} chars`);

  for (;;) {
    if (attempts.length >= budget.maxAttempts) { stopReason = 'budget-attempts'; break; }
    if (Date.now() - started >= budget.wallClockMs) { stopReason = 'budget-time'; break; }

    const strategy = await pickWorker({ cfg, memory, triedKeys, inputLength: text.length, lmUp });
    if (!strategy) { stopReason = 'no-strategies'; break; }
    triedKeys.push(strategy.key);

    const t0 = Date.now();
    let candidateText = '';
    let provider = 'unknown';
    let rewriteErr = null;
    try {
      const pieces = chunkForRewrite(text);
      const parts = [];
      for (const piece of pieces) {
        const r = await rewrite(strategy, piece, { ...opts, memory, style: opts.style, feedback });
        provider = r.provider || provider;
        parts.push(sanitizeLlmOutput(r.text));
      }
      candidateText = parts.join('\n\n');
    } catch (e) {
      rewriteErr = e;
    }
    const rewriteMs = Date.now() - t0;

    if (rewriteErr || !candidateText.trim()) {
      attempts.push({ strategyId: strategy.id, key: strategy.key, provider, error: rewriteErr?.message || 'empty rewrite', ms: rewriteMs });
      if (memory) {
        rememberModelResult(memory, strategy.key, 'strategy', true, rewriteErr?.message || 'empty rewrite');
        rememberModelResult(memory, provider, cfg.model, true, rewriteErr?.message || 'empty rewrite');
      }
      console.error(`  [decision] attempt ${attempts.length} ${strategy.id}: rewrite failed (${rewriteErr?.message})`);
      continue;
    }

    const g = await gateFn(candidateText).catch(e => ({ combined: null, heuristic: null, provider: 'unknown', pass: false, error: e.message }));
    const brain = await verifyFn(text.slice(0, 5000), candidateText, opts).catch(() => ({ used: false, ok: true, issues: [] }));
    const brainOk = brain.ok !== false;
    const passed = g.pass === true && brainOk;
    const ms = Date.now() - t0;

    attempts.push({
      strategyId: strategy.id, key: strategy.key, provider,
      combined: g.combined, heuristic: g.heuristic, modelAi: g.modelAi ?? null,
      brainOk, brainIssues: brain.issues?.length || 0,
      passed, ms, error: g.error || null,
    });
    if (memory) {
      const rejected = !brainOk;
      const reason = brain.issues?.slice(0, 2).join('; ') || '';
      rememberModelResult(memory, strategy.key, 'strategy', rejected, reason);
      rememberModelResult(memory, provider, cfg.model, rejected, reason);
    }

    console.error(`  [decision] attempt ${attempts.length}/${budget.maxAttempts} ${strategy.id} [${provider}]: combined=${g.combined ?? 'n/a'}% heuristic=${g.heuristic ?? 'n/a'}% brain=${brainOk ? 'ok' : 'ISSUES'} → ${passed ? 'PASS' : 'no'} (${ms}ms)`);

    if (!best || (g.combined != null && best.combined != null && g.combined < best.combined) || (best.combined == null && g.combined != null)) {
      best = { text: candidateText, combined: g.combined, heuristic: g.heuristic, provider, strategyId: strategy.id, passed, brainOk };
    }

    if (passed) {
      stopReason = 'pass';
      best = { text: candidateText, combined: g.combined, heuristic: g.heuristic, provider, strategyId: strategy.id, passed: true, brainOk };
      break;
    }

    feedback = detectorFeedback(g, threshold);
  }

  const elapsedMs = Date.now() - started;
  const result = {
    text: best?.text || text,
    passed: stopReason === 'pass',
    stopReason,
    combined: best?.combined ?? null,
    heuristic: best?.heuristic ?? null,
    provider: best?.provider || null,
    strategyId: best?.strategyId || null,
    passes: attempts.length,
    attempts,
    best,
    elapsedMs,
    budget,
    triedKeys,
  };
  lastDecision = {
    at: new Date().toISOString(), kind: 'run-until-pass',
    verdict: result.passed ? 'pass' : 'fail',
    stopReason, combined: result.combined, heuristic: result.heuristic,
    threshold: opts.aiThreshold ?? cfg.aiThreshold,
    attempts: attempts.length, elapsedMs, triedKeys,
    inputChars: text.length, bestStrategy: result.strategyId,
  };
  console.error(`  [decision] runUntilPass → ${result.passed ? 'PASS' : 'FAIL'} (${stopReason}, ${attempts.length} attempt(s), ${(elapsedMs / 1000).toFixed(1)}s, best ${result.combined ?? 'n/a'}%)`);
  return result;
}

async function humanizeWithDecision(text, model, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const gateOriginalResult = await gateOriginal(text, model, opts);

  if (gateOriginalResult.verdict === 'skip') {
    return {
      text, provider: gateOriginalResult.provider || 'none', passes: 0,
      heuristicScore: gateOriginalResult.heuristic, passed: true, skipped: true,
      gate: gateOriginalResult, brain: { used: false, ok: true, issues: [] },
    };
  }

  const tooShort = gateOriginalResult.verdict === 'undecidable'
    && String(gateOriginalResult.reason || '').startsWith('too short');
  const runOpts = tooShort
    ? { ...opts, cfg, budget: { ...(opts.budget || {}), maxAttempts: 2 } }
    : { ...opts, cfg };
  const run = await runUntilPass(text, model, runOpts);
  return {
    text: run.text,
    provider: run.provider,
    passes: run.passes,
    heuristicScore: run.heuristic,
    passed: run.passed,
    skipped: false,
    gate: gateOriginalResult,
    run,
    brain: { used: true, ok: run.best?.brainOk !== false, issues: [] },
  };
}

function getLastDecision() { return lastDecision; }
function getBudgetSnapshot() { return budgetSnapshot; }
function resetLastDecision() { lastDecision = null; }

module.exports = {
  STRATEGY_REGISTRY,
  CHUNK_MAX_CHARS,
  GROQ_ITPM_CEILING,
  strategyKey,
  chunkForRewrite,
  gate,
  gateOriginal,
  pickWorker,
  runUntilPass,
  humanizeWithDecision,
  roster,
  getLastDecision,
  getBudgetSnapshot,
  resetLastDecision,
  budgetFrom,
  detectorFeedback,
  promptFor,
};
