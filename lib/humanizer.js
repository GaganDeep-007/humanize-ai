const { completeWithFallback, providerFor } = require('./provider');
const { analyze } = require('./heuristics');
const { loadConfig } = require('./config');
const { brainVerify, brainJudge, buildFeedbackCx, rememberModelResult, CORRECTIVE_FEEDBACK_PROMPT, DEFAULT_CONF_GATE } = require('./brain');
const { layaBackfireCheck } = require('./laya');

function stripThinkingPreamble(text) {
  if (!text) return '';
  let clean = text;

  // Marker + text right after it = usually the real rewritten content
  const introMarkers = [
    /(?:^|\n)(?:here'?s?\s+the\s+|the\s+|a\s+|my\s+|final\s+)?rewritten\s+text\s*:\s*/i,
    /(?:^|\n)(?:here'?s?\s+)?my\s+rewrite\s*:\s*/i,
    /(?:^|\n)(?:here'?s?\s+)?(?:the\s+)?(?:final|corrected|polished)\s+(?:version|text)\s*:\s*/i,
    /(?:^|\n)(?:below\s+is\s+)?the\s+rewritten\s+(?:version|passage|paragraph|text)[\s\S]*?:\s*/i,
    /(?:^|\n)(?:now,?\s+)?(?:here\s+is|[h]ere'?s)\s+(?:the\s+)?(?:rewrite|result|text)\s*:\s*/i,
  ];

  // If output clearly contains a reasoning section, jump to the last intro marker
  if (/thinking\s+process|let me\s+(?:think|analyze)|i\s+will\s+(?:rewrite|provide)/i.test(clean)) {
    for (let i = introMarkers.length - 1; i >= 0; i--) {
      const m = clean.match(introMarkers[i]);
      if (m && m.index !== undefined) {
        clean = clean.slice(m.index + m[0].length);
        break;
      }
    }
  }

  // Simple leading preamble strip even without reasoning markers
  const leading = clean.match(/^(?:sure(?:,|!)?|ok(?:ay)?(?:,|!)?|here's|here is|of course(?:,|!)?|certainly(?:,|!)?)\s+/i);
  if (leading) clean = clean.slice(leading[0].length);

  // Cut numbered "1. Analyze..." analysis block that ends right before real prose
  const m = clean.match(/^(?:\s*\d+[.)]\s+\*{0,3}[A-Z][a-z]+[\s\S]*?\n){2,}[\s\S]*?(\n[A-Z][a-z][^\n]{20,})/);
  if (m) clean = clean.slice(m.index + m[0].indexOf(m[1]));

  return clean.trim();
}

function sanitizeLlmOutput(text) {
  if (!text) return '';
  let clean = stripThinkingPreamble(text);
  // Strip entire PDF content if detected
  if (clean.includes('%PDF-') || clean.includes(' obj\n') || clean.includes(' endobj')) {
    // Remove PDF object blocks: N N obj ... endobj
    clean = clean.replace(/\d+\s+\d+\s+obj[\s\S]*?endobj/g, '');
    // Remove PDF streams
    clean = clean.replace(/stream[\s\S]*?endstream/g, '');
    // Remove PDF trailer/xref
    clean = clean.replace(/(?:xref|trailer|startxref)[\s\S]*/g, '');
    // Remove %PDF header and anything after it if it looks like raw PDF
    clean = clean.replace(/%PDF-[\s\S]*/g, '');
  }
  // Strip PDF dictionary fragments: << /Key /Value ... >>
  clean = clean.replace(/<<[\s\S]*?>>/g, '');
  // Strip individual PDF tokens that hallucinating models inject
  clean = clean.replace(/(?:\/Type|\/Pages?|\/Kids|\/Parent|\/Resources|\/ExtGState|\/Font|\/ProcSet|\/MediaBox|\/Contents|\/Group|\/Tabs|\/StructParents|\/BaseFont|\/Encoding|\/FontDescriptor|\/FirstChar|\/LastChar|\/Widths|\/DescendantFonts|\/ToUnicode|\/Subtype|\/BM|\/Name|\/Filter|\/Length|\/Catalog|\/Info|\/Root|\/Size|\/ID|\/Prev|\/Count|\/W|\/H|\/BitsPerComponent|\/ColorSpace|\/Filter|\/DecodeParms)\b/g, '');
  // Strip PDF numeric references (N N R)
  clean = clean.replace(/\b\d+\s+\d+\s+R\b/g, '');
  // Strip obj/endobj keywords
  clean = clean.replace(/\b(?:obj|endobj|stream|endstream|xref|trailer|startxref)\b/g, '');
  // Strip multiple blank lines left after removal
  clean = clean.replace(/\n{3,}/g, '\n\n');
  return clean.trim();
}

const STYLE_BLOCKS = {
  normal: `
Style target — NORMAL (simple, friendly, human):
- Write like a real person explaining this to a colleague — plain words, natural speech.
- Short, punchy sentences mixed with longer ones. Break strict parallel structure and vary the rhythm.
- Use contractions and the occasional "But"/"So"/"And" opener or brief aside where a person would.
- Clarity over impressiveness. Turn jargon into plain language.`,
  'clear-structured': `
Style target — CLEAR & STRUCTURED (professional, tidy, plain):
- Keep the outline, section logic, and any headings/bullets exactly as they are.
- Write clean, well-organized paragraphs in a plain professional tone.
- Vary sentence length to avoid a robotic rhythm, but keep it formal-leaning.
- No jargon or filler. Precision over flourish — but sound like a careful human editor, not a template.`,
};

function styleBlockText(style) {
  return STYLE_BLOCKS[style] || STYLE_BLOCKS.normal;
}

const HUMANIZE_PROMPT = `
Humanizing is refinement, not rewriting. Every fact, number, name, and idea stays exactly the same; only the voice changes. The text delimited by <TEXT> still reads like AI. Read it like an editor, then:

1. FIND the repetitive patterns — repeated phrasing, uniform sentence rhythm, mechanical parallel structure. Repair them: mix a few 4-word stabs with longer 25-word flows. Rhythm variety is the biggest human tell.
2. REWORK flat, hedged tone into a natural voice: concrete, grounded, a person behind the words.
3. MEANING LOCK — do not add new ideas, do not remove nuance, never invent facts. Only change how it sounds.
4. Remove ALL AI clichés: "delve", "moreover", "furthermore", "in conclusion", "it is important to note", "in today's fast-paced world", "leverage", "comprehensive", "holistic", "robust", "seamless", "landscape", "paradigm", "synergy", "empower", "foster", "navigate", "transformative", "crucial", "ultimately", "notably", "significantly", "additionally", "utilize", "facilitate", "subsequent", "numerous", "indeed".
5. Replace formal constructions: "in order to" → "to", "due to the fact that" → "because", "it should be noted that" → (drop it), "with regard to" → "about", "take into account" → "consider". Cut filler: "it is worth noting", "it goes without saying", "needless to say", "at the end of the day".
6. Prefer active voice and plain words over impressive ones. Reduce passive voice.
7. Do not add markdown headings, bullet points, or summary boxes unless the original had them.
{{STYLE}}
8. Self-review before you answer: read it once as if a real person wrote it. If any sentence still sounds templated or machine-perfect, fix it.
9. Output ONLY the rewritten text — no preamble, no explanation, no title.

<TEXT>
{{TEXT}}
</TEXT>`;

const REFINEMENT_PROMPT = `
The text below was already humanized once. Your job is a LIGHT polish — not a rewrite. Find the LAST signs of AI and remove exactly those:

1. Does any sentence still feel templated, flat, or "too perfect"? Loosen just those sentences.
2. Any repetitive phrasing or uniform rhythm left? Vary it minimally — do not redo the whole paragraph.
3. Any surviving cliché or filler (delve, leverage, moreover, furthermore, it is worth noting, in today's world)? Replace with plain words.
4. Meaning lock: change only the wording — keep every fact, name, number, and the overall structure intact.
{{STYLE}}
Output ONLY the polished text — no preamble, no explanation.

<TEXT>
{{TEXT}}
</TEXT>`;

// Final voice pass — replaces the old "aggressive rewrite" (random word swaps,
// forced imperfections). Refinement, not sledgehammer: same meaning, new voice.
const VOICE_POLISH_PROMPT = `
The text still reads as AI to a detector. One more pass — but a refinement, not a rewrite. Nothing gets rebuilt wholesale; you rework the voice. If heavy restructuring would make it read awkwardly, keep the structure and fix the voice.

1. FIND the pattern that flags it — almost always uniform rhythm or a flat, hedged tone. Target exactly that.
2. REWORK the cadence: read it aloud mentally; where the pacing feels mechanical, break it (a very short sentence, a dropped clause, a plain aside where it fits).
3. Keep every fact and idea identical — meaning lock. Do not add or remove content, never invent numbers, names, or claims.
4. Plain, concrete words. No jargon, no hedging, no AI clichés.
{{STYLE}}
5. Finish by re-reading once — if it now sounds like a real person wrote it, you're done.
6. Output ONLY the polished text — no preamble, no explanation.

<TEXT>
{{TEXT}}
</TEXT>`;

async function callLLM(messages, opts = {}) {
  if (opts.mode && opts.mode !== 'single') {
    return completeWithFallback(opts.lmModel || opts.model, opts.orModel || opts.model, messages, {
      temperature: opts.temperature ?? 0.9,
      maxTokens: opts.maxTokens ?? 8192,
      mode: opts.mode,
      providerTimeoutMs: opts.providerTimeoutMs,
    });
  }
  const { complete } = require('./provider');
  const text = await complete(opts.model, messages, {
    temperature: opts.temperature ?? 0.9,
    maxTokens: opts.maxTokens ?? 8192,
    providerTimeoutMs: opts.providerTimeoutMs,
  });
  return { text, provider: providerFor(opts.model) };
}

// Arms = rewriting workers (LM Studio first, falls back to Groq/OpenRouter/free models).
async function callWorker(messages, opts = {}) {
  const cfg = loadConfig();
  const lmModel = opts.lmModel || cfg.lmModel;
  const orModel = opts.orModel || cfg.orModel || 'openrouter/free';
  const workerMode = opts.workerMode || 'lmstudio-first';
  return completeWithFallback(lmModel, orModel, messages, {
    temperature: opts.temperature ?? 0.9,
    maxTokens: opts.maxTokens ?? 8192,
    mode: workerMode,
    providerTimeoutMs: opts.providerTimeoutMs,
  });
}

async function humanize(text, model, opts = {}) {
  const cfg = loadConfig();
  if (opts.decision !== false && cfg.decision?.enabled !== false) {
    try {
      const { humanizeWithDecision } = require('./decision');
      const res = await humanizeWithDecision(text, model, { ...opts, cfg });
      console.error(`  [humanizer] decision engine: ${res.skipped ? 'SKIP (original within threshold)' : `${res.passes} attempt(s), ${res.passed ? 'PASS' : 'FAIL'}`}`);
      return res;
    } catch (e) {
      console.error(`  [humanizer] decision engine failed (${e.message}) — falling back to legacy pass ladder`);
    }
  }

  const truncated = text.slice(0, 5000);
  const aiThreshold = opts.aiThreshold ?? 5;
  const memory = opts.memory || {};
  const style = styleBlockText(opts.style || cfg.style || 'normal');
  const feedbackCtx = buildFeedbackCx(opts.knownIssues || [], opts.knownDrift);

  console.error('  [humanizer] Pass 1: arm (worker) rewrite...');
  const pass1 = await callWorker([
    { role: 'system', content: 'You are a skilled human editor who refines text without rewriting it. Keep every fact; change the voice.' },
    { role: 'user', content: HUMANIZE_PROMPT.replace('{{STYLE}}', style).replace('{{TEXT}}', truncated) },
  ], { ...opts, model, temperature: 0.9 });

  pass1.text = sanitizeLlmOutput(pass1.text);
  const h1 = analyze(pass1.text);
  console.error(`  [humanizer] Pass 1 heuristic score: ${h1.score}% [${pass1.provider}]`);

  const brain1 = await brainVerify(truncated, pass1.text, opts);
  const hall1 = brain1.issues;
  const proof1 = brain1.used
    ? (h1.score <= aiThreshold && brain1.ok)
    : (h1.score <= aiThreshold && hall1.length === 0);

  if (proof1) {
    console.error('  [humanizer] Pass 1 accepted (heuristic within threshold, brain clean).');
    if (memory) rememberModelResult(memory, pass1.provider, model, false, '');
    return { text: pass1.text, provider: pass1.provider, passes: 1, heuristicScore: h1.score, brain: brain1 };
  }

  const reasons = [];
  if (h1.score > aiThreshold) reasons.push(`AI-style score ${h1.score}% is above the ${aiThreshold}% threshold.`);
  for (const i of hall1) reasons.push(i);
  console.error(`  [humanizer] Pass 1 rejected — brain ${
    brain1.used ? 'issues: ' + hall1.length : 'unavailable (heuristic only)'
  }. ${reasons.join(' ')}`);

  console.error('  [humanizer] Pass 2: arm (worker) corrective rewrite with brain feedback...');
  const corrective = CORRECTIVE_FEEDBACK_PROMPT
    .replace('{{ISSUES}}', feedbackCtx + (reasons.length ? `\nAdditionally:\n${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}` : ''));
  const pass2 = await callWorker([
    { role: 'system', content: 'You are a meticulous copy editor who fixes specific problems without rewriting everything.' },
    { role: 'user', content: REFINEMENT_PROMPT.replace('{{STYLE}}', style).replace('{{TEXT}}', pass1.text) + '\n\n' + corrective },
  ], { ...opts, model, temperature: 0.7 });

  pass2.text = sanitizeLlmOutput(pass2.text);
  const h2 = analyze(pass2.text);
  console.error(`  [humanizer] Pass 2 heuristic score: ${h2.score}% [${pass2.provider}]`);

  const brain2 = await brainVerify(truncated, pass2.text, opts);
  const hall2 = brain2.issues;

  if (memory) rememberModelResult(memory, pass1.provider, model, hall1.length > 0, hall1.slice(0, 2).join('; '));

  let candidate = (h2.score < h1.score || h2.score <= aiThreshold)
    ? { text: pass2.text, provider: pass2.provider, passes: 2, heuristicScore: h2.score, improvement: h1.score - h2.score, brain: brain2 }
    : { text: pass1.text, provider: pass1.provider, passes: 1, heuristicScore: h1.score, brain: brain1 };

  if (candidate.heuristicScore > aiThreshold) {
    console.error(`  [humanizer] Best score ${candidate.heuristicScore}% (Pass 1: ${h1.score}%, Pass 2: ${h2.score}%) still above ${aiThreshold}% — attempting Pass 3 (voice polish)...`);
    const polish = VOICE_POLISH_PROMPT.replace('{{STYLE}}', style) +
      `\n\nDetector feedback — the text still scores ${candidate.heuristicScore}% AI-style (target ≤ ${aiThreshold}%): rework sentence rhythm and flat tone into a natural voice. Keep meaning identical. Remove AI filler phrases.\n\nOriginal text for reference:\n${truncated.slice(0, 2000)}`;

    const pass3 = await callWorker([
      { role: 'system', content: 'You are a human writer who refines the voice of a text without rebuilding it. Keep every fact — only the phrasing and rhythm change.' },
      { role: 'user', content: candidate.text + '\n\n' + polish },
    ], { ...opts, model, temperature: 0.85 });

    pass3.text = sanitizeLlmOutput(pass3.text);
    const h3 = analyze(pass3.text);
    console.error(`  [humanizer] Pass 3 heuristic score: ${h3.score}% [${pass3.provider}]`);

    if (h3.score < candidate.heuristicScore) {
      candidate = { text: pass3.text, provider: pass3.provider, passes: 3, heuristicScore: h3.score, improvement: candidate.heuristicScore - h3.score, brain: candidate.brain };
    } else {
      // Heuristic says no gain — but it's stuck/flat on some docs (6->7%). Ask Laya
      // whether Pass 3 is actually more human before discarding it.
      const layaCheck = await layaBackfireCheck(candidate.text, pass3.text, opts).catch(() => null);
      const confGate = opts.confGate ?? cfg.layaConfGate ?? DEFAULT_CONF_GATE;
      if (layaCheck && layaCheck.improved && layaCheck.confidence >= confGate && h3.score <= aiThreshold) {
        console.error(`  [humanizer] Pass 3 heuristic flat, but LAYA says improved (conf=${layaCheck.confidence.toFixed(2)}) — keeping Pass 3.`);
        candidate = { text: pass3.text, provider: pass3.provider, passes: 3, heuristicScore: h3.score, improvement: candidate.heuristicScore - h3.score, brain: candidate.brain };
      } else {
        console.error(`  [humanizer] Pass 3 backfired (${h3.score}% >= ${candidate.heuristicScore}%) — trying alternate worker (Groq/OpenRouter)...`);
        try {
          const pass3b = await callWorker([
            { role: 'system', content: 'You are a human writer who refines the voice of a text without rebuilding it. Keep every fact — only the phrasing and rhythm change.' },
            { role: 'user', content: candidate.text + '\n\n' + polish },
          ], { ...opts, model, temperature: 0.85, workerMode: 'openrouter-only' });
          pass3b.text = sanitizeLlmOutput(pass3b.text);
          const h3b = analyze(pass3b.text);
          console.error(`  [humanizer] Pass 3 alternate worker score: ${h3b.score}% [${pass3b.provider}]`);
          if (h3b.score < candidate.heuristicScore) {
            candidate = { text: pass3b.text, provider: pass3b.provider, passes: 3, heuristicScore: h3b.score, improvement: candidate.heuristicScore - h3b.score, brain: candidate.brain };
          } else {
            console.error(`  [humanizer] Pass 3 alternate worker also backfired (${h3b.score}%) — keeping previous best.`);
          }
        } catch (e) {
          console.error(`  [humanizer] Pass 3 alternate worker failed: ${e.message}`);
        }
      }
    }
  }

  const finalBrain = await brainJudge(candidate.text, opts).catch(() => null);
  if (finalBrain) candidate.brainJudge = finalBrain;

  if (candidate.heuristicScore <= aiThreshold) {
    console.error(`  [humanizer] Final score ${candidate.heuristicScore}% — within threshold. Hallucination issues: ${hall2.length > 0 ? hall2.length : 0}`);
  } else {
    console.error(`  [humanizer] Final score ${candidate.heuristicScore}% — still above threshold (best effort after two passes).`);
  }
  return candidate;
}

function writeComparableReport(original, humanized, before, after, thresholds) {
  const lines = [];
  const bar = (label, v) => `${label.padEnd(30)} ${String(v ?? 'n/a').padStart(4)}%`;
  const status = (v, t) => (v >= t ? '  NEEDS WORK' : '  OK');

  lines.push('='.repeat(60));
  lines.push('  BEFORE / AFTER AI CONTENT REPORT');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('  -- ORIGINAL --');
  lines.push('');
  lines.push(bar('AI likelihood (heuristic)', before.heuristic.score));
  lines.push(bar('AI likelihood (model)', before.model.ai_likelihood));
  lines.push(bar('AI likelihood (combined)', before.combined.ai_likelihood));
  lines.push(bar('Plagiarism overlap', before.combined.plagiarism_likelihood));
  if (before.heuristic.grammarlyFlags?.length) {
    lines.push(`  Grammarly flags: ${before.heuristic.grammarlyFlags.slice(0, 5).join(', ')}`);
  }
  lines.push('');
  lines.push('  -- AFTER HUMANIZATION --');
  lines.push('');
  lines.push(bar('AI likelihood (heuristic)', after.heuristic.score));
  lines.push(bar('AI likelihood (model)', after.model.ai_likelihood));
  lines.push(bar('AI likelihood (combined)', after.combined.ai_likelihood));
  lines.push(bar('Plagiarism overlap', after.combined.plagiarism_likelihood));
  if (after.heuristic.grammarlyFlags?.length) {
    lines.push(`  Grammarly flags: ${after.heuristic.grammarlyFlags.slice(0, 5).join(', ')}`);
  }
  lines.push('');
  lines.push(`AI threshold (config): ${thresholds.aiThreshold}%  ->  Verdict: ${after.combined.ai_likelihood >= thresholds.aiThreshold ? 'FAIL' : 'PASS'}`);
  lines.push(`Plagiarism threshold: ${thresholds.plagiarismThreshold}%  ->  Verdict: ${after.combined.plagiarism_likelihood >= thresholds.plagiarismThreshold ? 'FAIL' : 'PASS'}`);
  lines.push('');
  lines.push('Top AI phrases in original:');
  const phrases = before.heuristic.topPhrases;
  if (phrases.length) phrases.forEach(p => lines.push('  - ' + p));
  else lines.push('  (none)');
  lines.push('');
  const delta = before.combined.ai_likelihood - after.combined.ai_likelihood;
  lines.push(`RESULT: AI likelihood changed by ${delta >= 0 ? '-' : '+'}${Math.abs(delta)} percentage points.`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { humanize, writeComparableReport, sanitizeLlmOutput, callWorker, HUMANIZE_PROMPT, REFINEMENT_PROMPT, VOICE_POLISH_PROMPT, STYLE_BLOCKS, styleBlockText };
