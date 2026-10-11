const assert = require('assert');
const { adaptDetectorWeight } = require('../lib/analyzer');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  PASS ${name}`); };

// Adaptive weight = base + (0.8 - base) * decisiveness (|d-50|/50).
const base = 0.3;

t('detector decisive low (0) → high weight 0.8 (base respected)', () => {
  assert.strictEqual(adaptDetectorWeight(base, 0), 0.8);
});
t('detector decisive high (100) → high weight 0.8', () => {
  assert.strictEqual(adaptDetectorWeight(base, 100), 0.8);
});
t('detector mid (50) → stays at configured base blend', () => {
  assert.strictEqual(adaptDetectorWeight(base, 50), 0.3);
});
t('detector near-clean (10) → weight ≈ 0.7', () => {
  assert.ok(Math.abs(adaptDetectorWeight(base, 10) - 0.7) < 1e-9);
});
t('custom base is honored (base 0.7 still caps at 0.8)', () => {
  assert.ok(Math.abs(adaptDetectorWeight(0.7, 0) - 0.8) < 1e-9);
  assert.strictEqual(adaptDetectorWeight(0.7, 50), 0.7);
});
t('null model → base unchanged', () => {
  assert.strictEqual(adaptDetectorWeight(base, null), 0.3);
});

// Simulate the realistic smoke results: detector=0 with heuristic 10 and 22.
t('clean detector result now PASSes strict 5% bar (was 7%/15%)', () => {
  const combined = (h, d, w) => Math.round(h * (1 - w) + d * w);
  for (const h of [10, 22]) {
    const w = adaptDetectorWeight(base, 0);
    const c = combined(h, 0, w);
    assert.ok(c <= 5, `heuristic ${h} + detector 0 → combined ${c}% should be ≤ 5%`);
  }
});
// Heuristic still has teeth: pattern-heavy text at detector 0 with high heuristic fails.
t('heuristic retains a veto via the 20% floor', () => {
  const w = adaptDetectorWeight(base, 0);
  const c = Math.round(30 * (1 - w)); // heuristic 30, detector 0
  assert.ok(c > 5, `heuristic 30 → combined ${c}% should still fail`);
});
// Ambiguous detector mid-range keeps the blend low so we do not over-trust it.
t('ambiguous detector (50) does not over-trust', () => {
  const w = adaptDetectorWeight(base, 50);
  const c = Math.round(20 * (1 - w) + 50 * w);
  assert.ok(c > 5 && w === 0.3, `mid-range keeps base blend (w=${w})`);
});
// High detector score on original text → unambiguous FAIL (humanize trigger).
t('original AI text (detector 100) → decisively above threshold', () => {
  const w = adaptDetectorWeight(base, 100);
  const c = Math.round(94 * (1 - w) + 100 * w);
  assert.ok(c >= 95, `original → combined ${c}% should be ~95%`);
});

console.log(`\n${passed} passed, 0 failed`);