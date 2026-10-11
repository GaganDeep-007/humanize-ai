const { completeWithFallback, providerFor } = require('./provider');
const { layaHumanWinScore, isLayaReachable, DEFAULT_CONF_GATE } = require('./laya');
const { detect } = require('./detector');

const SCORE_PROMPT = `
You are a forensic analyst who detects AI-generated text. Analyze the text in <TEXT> tags.

Step 1 — score each dimension 0-10 (0 = clearly human, 10 = clearly AI):
- "rhythm": sentence-length variety and irregularity (uniform pacing, mechanical parallel structure = AI)
- "vocabulary": stock formal phrasing and predictable transitions (moreover, crucially, delve, landscape, seamless, "in today's fast-paced world")
- "structure": templated organization — formulaic paragraph scaffolding, symmetric tricolons, intro/body/conclusion pattern
- "specificity": absence of concrete details — no names, numbers, anecdotes, quirks, contractions, opinions
- "voice": neutral hedged stance that applies to everyone, no personal viewpoint

Step 2 — compute ai_likelihood:
- ai_likelihood = round(average(dimension scores) * 10)
- If the text has clear human markers (contractions, informal asides, opinions, concrete specifics), subtract 15.
- If at least 3 dimensions score >= 8, add 10.
- Clamp to 0..100.

Anchors: 0-15 natural human writing | 16-40 human, lightly edited | 41-60 mixed or heavily edited | 61-80 clearly AI-flavored | 81-100 textbook AI output.

plagiarism_likelihood = probability large passages were copied verbatim from a published source. Be conservative: only score above 30 if you recognize specific published phrasing; otherwise 0-15.

Return STRICT JSON only (no markdown fences), with this exact shape:
{
  "ai_likelihood": <integer 0-100>,
  "plagiarism_likelihood": <integer 0-100>,
  "ai_flags": ["dimension: brief reason"],
  "plagiarism_flags": ["brief reason"],
  "verdict": "one-sentence summary"
}
<TEXT>
{{TEXT}}
</TEXT>`;

function parseJsonStrict(s) {
  let cleaned = String(s || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in response');
  cleaned = cleaned.slice(start, end + 1);
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1'); // tolerate trailing commas
  return JSON.parse(cleaned);
}

// Laya-backed model assessment for the full document (multi-window, calibrated).
// Returns the model-source fields robustAnalyze expects; null when Laya can't fire.
async function evaluateLaya(text, opts = {}) {
  const cfg = opts.cfg || (opts.configLoader ? opts.configLoader() : require('./config').loadConfig());
  const confGate = opts.confGate ?? cfg.layaConfGate ?? DEFAULT_CONF_GATE;
  const win = await layaHumanWinScore(text, opts);
  if (!win) return null;
  if (win.confidence < confGate) {
    console.error(`  [analyzer] Laya eval low confidence (${win.confidence.toFixed(2)}) — falling back to LLM eval`);
    return null;
  }
  const ai = 100 - win.human_score;
  console.error(`  [analyzer] model eval via LAYA → ai_likelihood=${ai} (conf ${win.confidence.toFixed(2)})`);
  return {
    ai_likelihood: ai,
    plagiarism_likelihood: null,
    ai_flags: [`laya (${win.windows} windows), conf ${win.confidence.toFixed(2)}`],
    plagiarism_flags: [],
    verdict: `laya: human ${win.human_score}%`,
    provider: 'laya',
  };
}

// Pluggable external-detector assessment (Sapling/GPTZero). Preferred judge:
// returns the model-source fields robustAnalyze expects, or null when the layer
// is disabled / unconfigured / errored (caller then falls back to Laya → LLM).
async function evaluateDetector(text, opts = {}) {
  const cfg = opts.cfg || (opts.configLoader ? opts.configLoader() : require('./config').loadConfig());
  if (cfg.detector?.enabled === false) return null;
  try {
    const d = await detect(text, { ...opts, cfg });
    if (!d || d.ai_likelihood == null) return null;
    console.error(`  [analyzer] model eval via DETECTOR(${d.provider}) → ai_likelihood=${d.ai_likelihood}`);
    return d;
  } catch (e) {
    console.error(`  [analyzer] detector failed (${e.message}) — falling back to judge`);
    return null;
  }
}

function windowOffsets(len, size, maxW) {
  if (len <= size) return [0];
  const n = Math.min(Math.max(maxW, 1), Math.ceil(len / size));
  const offs = [];
  for (let i = 0; i < n; i++) {
    offs.push(Math.floor((i * (len - size)) / Math.max(n - 1, 1)));
  }
  return offs;
}

// Model assessment over evenly-spaced windows of the document (the previous
// behavior only scored the first 4000 chars, which biased whole-doc verdicts).
// Returns the averaged model-source fields robustAnalyze expects.
async function evaluateModel(text, model, opts = {}) {
  try {
    const size = opts.windowSize ?? 4000;
    const maxW = opts.maxWindows ?? 4;
    const offs = windowOffsets(text.length, size, maxW);
    const results = [];
    let lastErr;
    const evalModel = opts.evalModel !== undefined
      ? opts.evalModel
      : (opts.configLoader ? opts.configLoader().evalModel : require('./config').loadConfig().evalModel);
    for (const off of offs) {
      const windowText = text.slice(off, off + size);
      const messages = [
        { role: 'system', content: 'You output strict JSON only.' },
        { role: 'user', content: SCORE_PROMPT.replace('{{TEXT}}', windowText) },
      ];
      const callDefault = () => {
        if (opts.mode && opts.mode !== 'single') {
          return completeWithFallback(opts.lmModel || model, opts.orModel || model, messages, { temperature: 0.2, maxTokens: 1500, mode: opts.mode }).then(r => ({ raw: r.text, provider: r.provider }));
        }
        const { complete } = require('./provider');
        return complete(model, messages, { temperature: 0.2, maxTokens: 1500 }).then(raw => ({ raw, provider: providerFor(model) }));
      };
      const call = async () => {
        if (evalModel) {
          try {
            const { completeJudge } = require('./provider');
            const r = await completeJudge(evalModel, messages, { temperature: 0.2, maxTokens: opts.evalMaxTokens ?? 600 });
            return { raw: r.text, provider: r.provider };
          } catch (e) {
            console.error(`  [analyzer] evalModel ${evalModel} failed (${e.message}) — falling back to default routing`);
          }
        }
        return callDefault();
      };
      let r;
      let parsed;
      let perr;
      for (let attempt = 0; attempt < 2; attempt++) {
        r = await call();
        if (attempt > 0) console.error(`  [analyzer] model eval window ${off} retry ${attempt}`);
        try {
          parsed = parseJsonStrict(r.raw);
          break;
        } catch (e) {
          perr = e;
          console.error(`  [analyzer] model eval JSON parse failed (window ${off}): ${e.message}`);
        }
      }
      if (!parsed) {
        lastErr = perr;
        continue;
      }
      results.push({ parsed, provider: r.provider });
    }
    if (results.length === 0) throw lastErr;
    const valids = results.filter(x => Number.isFinite(Number(x.parsed.ai_likelihood)));
    if (valids.length === 0) throw lastErr;
    const ai = Math.round(valids.reduce((s, x) => s + Number(x.parsed.ai_likelihood), 0) / valids.length);
    const plgValid = results.filter(x => Number.isFinite(Number(x.parsed.plagiarism_likelihood)));
    const plagiarism = plgValid.length
      ? Math.round(plgValid.reduce((s, x) => s + Number(x.parsed.plagiarism_likelihood), 0) / plgValid.length)
      : null;
    return {
      ai_likelihood: ai,
      plagiarism_likelihood: plagiarism,
      ai_flags: [`model eval averaged across ${results.length} window(s)`],
      plagiarism_flags: [],
      verdict: `model eval (${results.length} windows)`,
      provider: [...new Set(results.map(x => x.provider))].join('+'),
    };
  } catch (e) {
    return { ai_likelihood: null, plagiarism_likelihood: null, ai_flags: [`model eval failed: ${e.message}`], plagiarism_flags: [], verdict: 'unavailable', provider: 'unknown' };
  }
}

// Free, zero-maintenance scoring. When a live detector is the judge it is the
// most trustworthy signal, so we weight it proportionally to how decisive it is:
// 0/100 → up to 80%, 50 (unclear) → the configured base blend (default 0.3).
// Laya/LLM-judge evals and an explicit opts.modelWeight always use the base.
function adaptDetectorWeight(base, aiModel) {
  if (aiModel == null) return base;
  const decisiveness = Math.min(1, Math.abs(aiModel - 50) / 50);
  return base + Math.max(0, 0.8 - base) * decisiveness;
}

async function robustAnalyze(text, model, opts = {}) {
  const cfg = opts.cfg || (opts.configLoader ? opts.configLoader() : require('./config').loadConfig());
  const local = require('./heuristics').analyze(text);
  const detectorEval = await evaluateDetector(text, { ...opts, cfg });
  const layaEval = detectorEval ? null : await evaluateLaya(text, { ...opts, cfg });
  const modelEval = detectorEval || layaEval || (await evaluateModel(text, model, opts));

  const ai = local.score;
  const aiModel = modelEval.ai_likelihood;
  const explicit = Number.isFinite(opts.modelWeight);
  const baseWeight = explicit ? opts.modelWeight : (cfg.detector?.weight != null ? Number(cfg.detector.weight) : 0.3);
  const weight = (!explicit && String(modelEval.provider || '').startsWith('detector:'))
    ? adaptDetectorWeight(baseWeight, aiModel)
    : baseWeight;
  const combined = aiModel != null ? Math.round(ai * (1 - weight) + aiModel * weight) : ai;

  return {
    heuristic: local,
    model: modelEval,
    combined: {
      ai_likelihood: combined,
      plagiarism_likelihood: modelEval.plagiarism_likelihood,
      provider: modelEval.provider,
    },
    provider: modelEval.provider,
  };
}

module.exports = { robustAnalyze, evaluateModel, evaluateLaya, evaluateDetector, windowOffsets, adaptDetectorWeight };
