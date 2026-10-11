const AI_PHRASES = [
  'delve', 'delves', 'delve into',
  'moreover', 'furthermore', 'additionally',
  'in conclusion', 'in summary', 'to summarize', 'to sum up',
  'it is important to note', 'it is worth noting', 'it is worth mentioning',
  'it is crucial to note', 'it should be noted', 'it must be noted',
  'in today\'s fast-paced world', 'in today\'s world', 'in the modern era',
  'in the digital age', 'as technology continues to evolve',
  'landscape', 'ecosystem', 'paradigm', 'synergy', 'nexus',
  'unlock', 'unleash', 'elevate', 'leverage', 'leverages', 'leveraging',
  'seamless', 'seamlessly', 'robust', 'cutting-edge', 'cutting edge',
  'state-of-the-art', 'state of the art', 'next-generation',
  'game-changer', 'game changer', 'revolutionize', 'revolutionizing',
  'transformative', 'transformative approach',
  'at its core', 'at the core', 'in the realm of',
  'when it comes to', 'in terms of',
  'firstly', 'secondly', 'thirdly', 'lastly', 'overall',
  'notably', 'crucially', 'significantly', 'indeed',
  'a comprehensive approach', 'comprehensive', 'holistic',
  'key takeaway', 'in essence', 'essentially',
  'in order to', 'utilize', 'utilizes', 'utilizing',
  'prior to', 'subsequent', 'subsequently', 'numerous',
  'facilitate', 'facilitates', 'facilitating',
  'Moreover,', 'Furthermore,', 'Additionally,',
  'Notably,', 'Crucially,', 'Significantly,',
  'In conclusion,', 'In summary,',
  'It is important to note that', 'It is worth noting that',
  'It is crucial to note that', 'It should be noted that',
];

const GRAMMARLY_PATTERNS = [
  { pattern: /\b(very|really|extremely|incredibly)\s+(good|bad|important|significant|complex)\b/gi, label: 'weak intensifier + generic adjective', weight: 2 },
  { pattern: /\bmake sure\b/gi, label: 'make sure (AI filler)', weight: 1 },
  { pattern: /\bplay a (crucial|vital|key|significant|important) role\b/gi, label: 'play a ... role (AI cliché)', weight: 3 },
  { pattern: /\bprovide(s|d)?\s+a\s+(comprehensive|thorough|detailed|in-depth)\b/gi, label: 'provide a comprehensive... (AI)', weight: 2 },
  { pattern: /\bthe\s+ability\s+to\b/gi, label: 'the ability to (nominalization)', weight: 1 },
  { pattern: /\bin\s+this\s+(context|regard|case|situation)\b/gi, label: 'in this context/regard (AI filler)', weight: 2 },
  { pattern: /\bhas\s+the\s+potential\s+to\b/gi, label: 'has the potential to (AI)', weight: 2 },
  { pattern: /\bby\s+leveraging\b/gi, label: 'by leveraging (AI)', weight: 3 },
  { pattern: /\bin\s+a\s+ nutshell\b/gi, label: 'in a nutshell (AI)', weight: 1 },
  { pattern: /\btake\s+into\s+account\b/gi, label: 'take into account (formal AI)', weight: 1 },
  { pattern: /\bwith\s+regard\s+to\b/gi, label: 'with regard to (AI)', weight: 2 },
  { pattern: /\bin\s+light\s+of\b/gi, label: 'in light of (AI)', weight: 1 },
  { pattern: /\bat\s+the\s+end\s+of\s+the\s+day\b/gi, label: 'at the end of the day (AI filler)', weight: 1 },
  { pattern: /\bit\s+goes\s+without\s+saying\b/gi, label: 'it goes without saying (AI filler)', weight: 2 },
  { pattern: /\bthe\s+purpose\s+of\s+this\b/gi, label: 'the purpose of this (AI)', weight: 2 },
  { pattern: /\bas\s+a\s+result\b/gi, label: 'as a result (formal)', weight: 1 },
  { pattern: /\bdue\s+to\s+the\s+fact\s+that\b/gi, label: 'due to the fact that (wordy AI)', weight: 2 },
  { pattern: /\bin\s+order\s+to\b/gi, label: 'in order to (wordy)', weight: 1 },
  { pattern: /\bat\s+a\s+(rapid|significantly|considerably)\s+pace\b/gi, label: 'at a rapid pace (AI)', weight: 2 },
  { pattern: /\blandscape\b/gi, label: 'landscape (AI buzzword)', weight: 3 },
  { pattern: /\bnavigate\b/gi, label: 'navigate (AI buzzword)', weight: 2 },
  { pattern: /\bfoster\b/gi, label: 'foster (AI buzzword)', weight: 2 },
  { pattern: /\bempower\b/gi, label: 'empower (AI buzzword)', weight: 3 },
  { pattern: /\bpave\s+the\s+way\b/gi, label: 'pave the way (AI cliché)', weight: 2 },
  { pattern: /\bshed\s+light\b/gi, label: 'shed light (AI cliché)', weight: 1 },
  { pattern: /\bcrucial\b/gi, label: 'crucial (overused AI word)', weight: 1 },
  { pattern: /\bultimately\b/gi, label: 'ultimately (AI hedge)', weight: 1 },
];

const HEDGES = [
  'it is important to', 'it should be noted', 'it can be argued',
  'please note', 'one might', 'one could', 'it is essential to',
  'it is crucial to', 'it goes without saying', 'needless to say',
  'it is worth noting', 'it bears mentioning',
];

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
}

function words(s) {
  return s.split(/\s+/).filter(Boolean);
}

function frequency(text) {
  const freq = new Map();
  for (const w of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (!w) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return freq;
}

function passiveVoiceCount(text) {
  const passivePattern = /\b(is|are|was|were|been|being|be)\s+(being\s+)?\w+ed\b/gi;
  const matches = text.match(passivePattern) || [];
  return matches.length;
}

function nominalizationCount(text) {
  const nomPatterns = /\b\w+(tion|sion|ment|ence|ance|ness|ity|ure|ism|ist)\b/gi;
  return (text.match(nomPatterns) || []).length;
}

function repetitiveStructureScore(sentencesList) {
  if (sentencesList.length < 3) return 0;
  let score = 0;
  const lengths = sentencesList.map(s => words(s).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const stdev = Math.sqrt(variance);
  if (stdev < 3 && mean > 12) score += 5;
  let consecutiveSimilar = 0;
  for (let i = 1; i < lengths.length; i++) {
    if (Math.abs(lengths[i] - lengths[i - 1]) <= 3) consecutiveSimilar++;
    else consecutiveSimilar = 0;
    if (consecutiveSimilar >= 3) { score += 4; break; }
  }
  const starts = sentencesList.map(s => {
    const w = s.split(/\s+/)[0]?.toLowerCase() || '';
    return w;
  });
  const startCounts = new Map();
  for (const w of starts) {
    if (w.length > 2) startCounts.set(w, (startCounts.get(w) || 0) + 1);
  }
  for (const [, n] of startCounts.values ? startCounts.entries() : []) {
    if (n >= sentencesList.length * 0.25) score += 3;
  }
  return Math.min(score, 15);
}

const REF_WORDS = 800;

function densityScale(totalWords) {
  return REF_WORDS / Math.max(1, totalWords);
}

function grammarlyScore(text, totalWords) {
  let raw = 0;
  const flags = [];
  for (const { pattern, label, weight } of GRAMMARLY_PATTERNS) {
    const matches = text.match(pattern) || [];
    if (matches.length > 0) {
      raw += matches.length * weight;
      flags.push(`${label} (${matches.length})`);
    }
  }
  const passives = passiveVoiceCount(text);
  raw += passives * 2;
  if (passives > 3) flags.push(`passive voice (${passives})`);
  const score = Math.min(40, Math.round(raw * densityScale(totalWords) * 10) / 10);
  return { score, flags };
}

function metaTextScore(text) {
  // Detects chain-of-thought / meta-reply garbage that isn't the actual rewrite
  let score = 0;
  const flags = [];
  const re = /(thinking\s+process|step\s*\d+|analy(?:ze|se)\s+the\s+(?:request|original|text)|rewrite\s+strategy|here(?:'| i)?s\s+my\s+rewrit|below\s+is\s+the\s+rewrit|i\s+have\s+rewritten|i\s+will\s+rewrite|let me\s+\w+\s+(?:this|it)\b|the\s+rewritten\s+(?:text|version)\s*(?:is|:)){1}/gi;
  const m = text.match(re);
  if (m) {
    score += 40;
    flags.push('meta/reasoning text present');
  }
  // Numbered list of analysis steps (typical CoT leak)
  if (/(^|\n)\s*\d+[.)]\s+\*{0,2}(?:analy|rewrit|step|understand)/i.test(text)) {
    score += 50;
    flags.push('numbered analysis steps');
  }
  // Non-prose tokens: arrow bullets, bold markers at line starts, XML-ish tags
  if (/(^|\n)\s*\*\*[^*]+\*\*/g.test(text)) {
    score += 15;
    flags.push('markdown bold markers');
  }
  return { score: Math.min(score, 90), flags };
}

function analyze(text) {
  const sen = sentences(text);
  const senLen = sen.map(s => words(s).length);
  const totalWords = words(text).length;
  const lower = text.toLowerCase();

  let aiPhrases = 0;
  const found = [];
  for (const phrase of AI_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = lower.match(re);
    if (matches) {
      aiPhrases += matches.length;
      found.push(`${phrase} (${matches.length})`);
    }
  }

  let hedges = 0;
  for (const h of HEDGES) {
    const m = lower.match(new RegExp(h, 'gi'));
    if (m) hedges += m.length;
  }

  const mean = senLen.length ? senLen.reduce((a, b) => a + b, 0) / senLen.length : 0;
  const variance = senLen.length ? senLen.reduce((a, b) => a + (b - mean) ** 2, 0) / senLen.length : 0;
  const stdev = Math.sqrt(variance);
  const cv = mean > 0 ? stdev / mean : 0;

  const starts = sen.map(s => s.trim()[0]).filter(Boolean);
  const startCounts = new Map();
  for (const c of starts) startCounts.set(c, (startCounts.get(c) || 0) + 1);
  let repetitiveStarts = 0;
  for (const n of startCounts.values()) if (n > sen.length * 0.3) repetitiveStarts++;

  const emDashes = (text.match(/—|–/g) || []).length;
  const semicolons = (text.match(/;/g) || []).length;

  const freq = frequency(text);
  let repeatedTop = 0;
  const topWords = [...freq.entries()].filter(([w]) => w.length > 4).sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [, n] of topWords) if (n >= totalWords * 0.06) repeatedTop++;

  const gl = grammarlyScore(text, totalWords);
  const repScore = repetitiveStructureScore(sen);
  const meta = metaTextScore(text);

  let score = 0;
  score += Math.min(25, aiPhrases / Math.max(1, totalWords / 100) * 3.5);
  score += Math.min(12, hedges * 2.5 * densityScale(totalWords));
  if (cv > 0 && cv < 0.45) score += 6; else if (cv >= 0.45 && cv <= 0.7) score += 2;
  if (emDashes > totalWords / 50) score += 3;
  if (semicolons > totalWords / 120) score += 2;
  if (repetitiveStarts > 0) score += 5;
  if (repeatedTop > 1) score += 4;
  score += gl.score;
  score += repScore;
  score += meta.score;
  score = Math.max(0, Math.min(99, Math.round(score)));

  return {
    score,
    words: totalWords,
    sentenceCount: sen.length,
    avgSentenceLength: Math.round(mean * 10) / 10,
    sentenceLengthCV: Math.round(cv * 100) / 100,
    aiPhraseHits: Math.round(aiPhrases),
    hedgeCount: hedges,
    emDashCount: emDashes,
    semicolonCount: semicolons,
    repetitiveStarts: repetitiveStarts > 0,
    repeatedLongWords: repeatedTop,
    topPhrases: found.slice(0, 10),
    grammarlyFlags: gl.flags,
    grammarlyScore: gl.score,
    metaFlags: meta.flags,
    metaScore: meta.score,
    passiveVoiceCount: passiveVoiceCount(text),
    nominalizationCount: nominalizationCount(text),
    repetitiveStructure: repScore,
  };
}

module.exports = { analyze, GRAMMARLY_PATTERNS, AI_PHRASES, REF_WORDS, densityScale };
