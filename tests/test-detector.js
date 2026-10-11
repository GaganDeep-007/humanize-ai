// Offline unit tests for the pluggable detector fallback chain (lib/detector.js).
// Network is stubbed via a fake global.fetch keyed by URL substring.
const assert = require('assert');

function makeResponse(status, json, opts = {}) {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (opts.headers && opts.headers[k]) || null },
    text: async () => text,
    json: async () => (typeof json === 'string' ? JSON.parse(json) : json),
    clone: function () { return this; },
  };
}

function stubFetch(routes) {
  global.fetch = async (url, init) => {
    for (const [key, spec] of Object.entries(routes)) {
      if (String(url).includes(key)) {
        const body = typeof spec === 'function' ? spec(url, init) : spec;
        return makeResponse(body.status ?? 200, body.json, body);
      }
    }
    throw new Error('no stub route for ' + url);
  };
}

function resetFetch() { delete global.fetch; }

const { detect, detectorStatus, buildDetectorChain, checkAccount, KIPRIO_ENDPOINT, PROVIDERS, DEFAULT_CHAIN } = require('../lib/detector');

const KEY = 'k'.repeat(32); // any non-empty key is fine (fetch is stubbed)

function cfg(over = {}) {
  return { detector: Object.assign({
    enabled: true, provider: 'huggingface', apiKey: '',
    saplingApiKey: '', gptzeroApiKey: '', hfToken: '', kiprioApiKey: '',
    wasitaiApiKey: '', contentdetectorApiKey: '', weight: 0.3, fallback: true, chain: [],
  }, over) };
}

const SAMPLE = 'The quick brown fox jumps over the lazy dog while the sun sets over the hills. I read a good book yesterday and drank coffee in the garden.';

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); })
    .catch(e => { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message); });
}

(async () => {

  // 1. Chain composition, no keys at all → keyless providers only.
  await t('chain: no keys => [contentdetector, kiprio], ordered by DEFAULT_CHAIN', () => {
    const c = buildDetectorChain(cfg());
    const names = c.map(x => x.provider);
    assert.deepStrictEqual(names, ['contentdetector', 'kiprio']);
  });

  // 2. Chain with an HF token hoists huggingface to front.
  await t('chain: hfToken set => [huggingface, contentdetector, kiprio]', () => {
    const names = buildDetectorChain(cfg({ hfToken: 'hf_x' })).map(x => x.provider);
    assert.deepStrictEqual(names, ['huggingface', 'contentdetector', 'kiprio']);
  });

  // 3. Configured provider (sapling) with key is tried first even when it will fail.
  await t('chain: sapling key present => sapling first', () => {
    const names = buildDetectorChain(cfg({ provider: 'sapling', saplingApiKey: KEY })).map(x => x.provider);
    assert.deepStrictEqual(names, ['sapling', 'contentdetector', 'kiprio']);
  });

  // 4. Explicit detector.chain order is respected and deduped.
  await t('chain: explicit detector.chain overrides', () => {
    const names = buildDetectorChain(cfg({ provider: 'sapling', saplingApiKey: KEY, chain: ['kiprio', 'huggingface', 'kiprio'] })).map(x => x.provider);
    assert.deepStrictEqual(names, ['kiprio']);
  });

  // 5. opts.chain wins over config (still filtered by availability).
  await t('chain: opts.chain wins (availability-filtered)', () => {
    const names = buildDetectorChain(cfg(), { chain: ['gptzero', 'contentdetector'] }).map(x => x.provider);
    assert.deepStrictEqual(names, ['contentdetector']);
  });

  // 6. detect(): expired sapling (402) falls through to contentdetector.
  await t('detect: sapling 402 → contentdetector fallback, marks chainTried', async () => {
    stubFetch({
      'api.sapling.ai/api/v1/aidetect': { status: 402, json: { msg: 'Subscription expired.' } },
      'contentdetector.net': { status: 200, json: { score: 0.05, label: 'Human' } },
      'kiprio.com/v1/ai-detect/': { status: 200, json: { score: 0.04 } },
    });
    const d = await detect(SAMPLE, { cfg: cfg({ provider: 'sapling', saplingApiKey: KEY }) });
    assert.strictEqual(d.provider, 'detector:contentdetector');
    assert.strictEqual(d.ai_likelihood, 5);
    assert.deepStrictEqual(d.raw.chainTried, ['sapling', 'contentdetector']);
    resetFetch();
  });

  // 7. detect(): keyless default (huggingface, no token) → contentdetector answers.
  await t('detect: huggingface no token → contentdetector (zero-maintenance)', async () => {
    stubFetch({ 'contentdetector.net': { status: 200, json: { score: 0.9, label: 'AI' } } });
    const d = await detect(SAMPLE, { cfg: cfg() });
    assert.strictEqual(d.provider, 'detector:contentdetector');
    assert.strictEqual(d.ai_likelihood, 90);
    resetFetch();
  });

  // 8. detect(): noFallback + missing key → null (no network).
  await t('detect: noFallback with no key => null', async () => {
    const d = await detect(SAMPLE, { cfg: cfg(), noFallback: true });
    assert.strictEqual(d, null);
  });

  // 9. detect(): noFallback + provider error → throws (old semantics).
  await t('detect: noFallback provider error => throws', async () => {
    stubFetch({ 'contentdetector.net': { status: 500, json: { error: 'boom' } } });
    await assert.rejects(detect(SAMPLE, { cfg: { detector: { enabled: true, provider: 'contentdetector', fallback: false } }, noFallback: true }));
    resetFetch();
  });

  // 10. detect(): everything fails with fallback → aggregate throw.
  await t('detect: all providers fail => throws aggregate', async () => {
    stubFetch({
      'contentdetector.net': { status: 503, json: {} },
      'kiprio.com/v1/ai-detect/': { status: 500, json: {} },
    });
    await assert.rejects(detect(SAMPLE, { cfg: cfg() }), /^Error: all detectors failed \[contentdetector: HTTP 503: .+?; kiprio: HTTP 500: .+\]$/);
    resetFetch();
  });

  // 11. detect(): disabled → null.
  await t('detect: disabled => null', async () => {
    const d = await detect(SAMPLE, { cfg: cfg({ enabled: false }) });
    assert.strictEqual(d, null);
  });

  // 12. detect(): huggingface with token + HF route parses + averages.
  await t('detect: huggingface token => detector:huggingface, windows averaged', async () => {
    stubFetch({
      'router.huggingface.co': (url, init) => {
        const body = JSON.parse(init.body);
        const human = body.inputs.includes('fox') ? 0.2 : 0.1;
        return { status: 200, json: [[{ label: 'Human', score: human }, { label: 'ChatGPT', score: 1 - human }]] };
      },
    });
    const d = await detect(SAMPLE + '\n' + SAMPLE + ' and a second windowed paragraph.', { cfg: cfg({ hfToken: 'hf_x' }), maxChars: 60, maxWindows: 2 });
    assert.strictEqual(d.provider, 'detector:huggingface');
    assert.ok(d.ai_likelihood >= 75 && d.ai_likelihood <= 95, `got ${d.ai_likelihood}`);
    assert.strictEqual(d.raw.windows.length, 2);
    resetFetch();
  });

  // 13. detect(): kiprio fixed endpoint has trailing slash (POST survives 301).
  await t('kiprio endpoint uses trailing slash', () => {
    assert.ok(KIPRIO_ENDPOINT.endsWith('/ai-detect/'), KIPRIO_ENDPOINT);
  });

  // 14. status: fallback + chain surfaced.
  await t('detectorStatus exposes fallback + chain', () => {
    const st = detectorStatus(cfg());
    assert.strictEqual(st.fallback, true);
    assert.deepStrictEqual(st.chain, ['contentdetector', 'kiprio']);
    assert.strictEqual(st.provider, 'huggingface');
  });

  // 15. status: fallback off + no key => chain empty → LLM judge only.
  await t('detectorStatus: fallback off + no key => chain empty', () => {
    const st = detectorStatus(cfg({ fallback: false }));
    assert.deepStrictEqual(st.chain, []);
  });

  // 16. checkAccount: non-sapling probe must NOT fall back (noFallback honored).
  await t('checkAccount: contentdetector probe does not silently fall through', async () => {
    stubFetch({ 'contentdetector.net': { status: 200, json: { score: 0.12 } } });
    const acct = await checkAccount(cfg());
    assert.strictEqual(acct.provider, 'huggingface');
    assert.strictEqual(acct.error, 'no API key configured');
    resetFetch();
  });

  // 17. detect(): opts.apiKey overrides for the configured provider.
  await t('detect: opts.apiKey used for configured provider (hoists HF first)', async () => {
    stubFetch({
      'router.huggingface.co': { status: 200, json: [[{ label: 'ChatGPT', score: 0.8 }, { label: 'Human', score: 0.2 }]] },
      'contentdetector.net': { status: 200, json: { score: 0.1 } },
    });
    const d = await detect(SAMPLE, { cfg: cfg(), apiKey: KEY }); // provider=huggingface + apiKey => huggingface chain entry
    assert.strictEqual(d.provider, 'detector:huggingface');
    assert.deepStrictEqual(d.raw.chainTried, ['huggingface']);
    resetFetch();
  });

  await t('module sanity: PROVIDERS/DEFAULT_CHAIN exported', () => {
    assert.ok(PROVIDERS.includes('contentdetector'));
    assert.deepStrictEqual(DEFAULT_CHAIN[2], 'contentdetector');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });