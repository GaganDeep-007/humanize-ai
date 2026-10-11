const assert = require('assert');
const { loadConfig } = require('../lib/config');
const { HUMANIZE_PROMPT, REFINEMENT_PROMPT, VOICE_POLISH_PROMPT, styleBlockText, STYLE_BLOCKS } = require('../lib/humanizer');
const d = require('../lib/decision');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  PASS ${name}`); };

const promptFor = (id, text, feedback, style) => {
  const sb = styleBlockText(style);
  if (id === 'refine') return REFINEMENT_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text) + (feedback ? `\n\n${feedback}` : '');
  if (id === 'polish') return VOICE_POLISH_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text) + (feedback ? `\n\n${feedback}` : '');
  return HUMANIZE_PROMPT.replace('{{STYLE}}', sb).replace('{{TEXT}}', text);
};

const txt = 'In today is fast-paced world, we must leverage synergy.';

t('config default style is normal', () => {
  const defs = /style: 'normal'/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'config.js'), 'utf8'));
  const cfg = loadConfig();
  assert(defs);
  assert.strictEqual(cfg.style || 'normal', 'normal');
});

for (const style of ['normal', 'clear-structured']) {
  t(`humanize prompt renders with ${style} style (refinement-first, meaning lock, style block, no placeholders)`, () => {
    const p = promptFor('humanize', txt, '', style);
    assert(p.includes('refinement, not rewriting'));
    assert(p.includes('MEANING LOCK'));
    assert(p.includes('FIND the repetitive patterns'));
    assert(p.includes('REWORK flat, hedged tone'));
    assert(p.includes(style === 'clear-structured' ? 'CLEAR & STRUCTURED' : 'NORMAL (simple'));
    assert(p.includes(txt));
    assert(!p.includes('{{STYLE}}') && !p.includes('{{TEXT}}'));
  });

  t(`refine prompt renders with ${style} style + appends feedback`, () => {
    const p = promptFor('refine', txt, 'DETECTOR FEEDBACK — x', style);
    assert(p.includes('DETECTOR FEEDBACK'));
    assert(p.includes('LIGHT polish'));
    assert(!p.includes('{{STYLE}}') && !p.includes('{{TEXT}}'));
  });

  t(`polish prompt is refinement not sledgehammer (${style})`, () => {
    const p = promptFor('polish', txt, '', style);
    assert(p.includes('refinement, not a rewrite'));
    assert(!p.includes('Add natural human imperfections'));
    assert(!p.includes('Completely rewrite every sentence structure'));
    assert(!p.includes('{{STYLE}}') && !p.includes('{{TEXT}}'));
  });
}

t('unknown style falls back to normal block', () => {
  assert.strictEqual(styleBlockText('bogus'), STYLE_BLOCKS.normal);
});

t('strategy registry uses polish, no aggressive strategy left', () => {
  assert(!d.STRATEGY_REGISTRY.some(s => s.promptId === 'aggressive'));
  assert.strictEqual(d.STRATEGY_REGISTRY.filter(s => s.promptId === 'polish').length, 2);
});

t('detectorFeedback surfaces score + concrete flags', () => {
  const g = {
    combined: 42,
    analysis: {
      heuristic: { score: 55, topPhrases: ['moreover (2)'], repetitiveStarts: true, sentenceLengthCV: 0.3, passiveVoiceCount: 2, grammarlyFlags: ['in order to (1)'], metaFlags: [] },
      model: { ai_likelihood: 45, ai_flags: ['contentdetector detector (1 window(s))', 'label=AI'] },
    },
  };
  const fb = d.detectorFeedback(g, 5);
  assert(fb.includes('still scored AI 42%'));
  assert(fb.includes('moreover (2)'));
  assert(fb.includes('rhythm too uniform (length CV 0.3)'));
  assert(fb.includes('label=AI'));
});

t('detectorFeedback is null-safe and empty-analysis safe', () => {
  assert.strictEqual(d.detectorFeedback(null, 5), '');
  assert.strictEqual(d.detectorFeedback({}, 5), '');
});

t('detectorFeedback degrades gracefully with no hints', () => {
  const fb = d.detectorFeedback({ combined: 20, analysis: { heuristic: {}, model: {} } }, 5);
  assert(fb.includes('No specific pattern detected'));
});

console.log(`\n${passed} passed, 0 failed`);