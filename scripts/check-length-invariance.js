const { analyze } = require('/home/gd/Work/humanize-ai/lib/heuristics.js');

function buildDoc(sentenceBank, targetChars, shuffleSeed = 1) {
  // Light deterministic shuffle so structure terms aren't pathological loop artifacts
  const bank = sentenceBank.slice();
  let s = shuffleSeed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  let doc = '';
  let i = 0;
  while (doc.length < targetChars) {
    const idx = Math.floor(rand() * bank.length);
    doc += bank[idx] + ' ';
    i++;
  }
  return doc;
}

function meanScore(doc, size) {
  const scores = [];
  for (let off = 0; off < doc.length; off += size) {
    const piece = doc.slice(off, off + size);
    if (piece.length < 200) break;
    scores.push(analyze(piece).score);
  }
  return { mean: scores.reduce((a, b) => a + b, 0) / scores.length, min: Math.min(...scores), max: Math.max(...scores), n: scores.length };
}

function chunkReassembly(doc, chunkChars) {
  const chunks = [];
  for (let off = 0; off < doc.length; off += chunkChars) {
    const piece = doc.slice(off, off + chunkChars);
    if (piece.length < 200) break;
    chunks.push(piece);
  }
  const chunkScores = chunks.map(c => analyze(c).score);
  const chunkMean = chunkScores.reduce((a, b) => a + b, 0) / chunks.length;
  const whole = analyze(chunks.join('\n\n')).score;
  return { chunkMean: +chunkMean.toFixed(1), chunkMin: Math.min(...chunkScores), chunkMax: Math.max(...chunkScores), whole, delta: +(whole - chunkMean).toFixed(1), n: chunks.length };
}

const aiBank = [
  "In today's fast-paced world, it is important to note that leveraging comprehensive frameworks can elevate organizational landscapes.",
  "Moreover, this transformative approach facilitates seamless synergy across robust ecosystems, ultimately unlocking cutting-edge paradigms.",
  "Furthermore, organizations must delve into holistic strategies to empower stakeholders and pave the way for next-generation innovation.",
  "Additionally, it should be noted that navigating the digital age requires a comprehensive understanding of emerging technological landscapes.",
  "Consequently, by fostering transformative ecosystems, enterprises can unlock unprecedented value and revolutionize their core operations.",
  "In conclusion, the synergy of robust frameworks and holistic approaches will elevate the landscape of modern organizational paradigms.",
  "It is worth noting that substantial progress can be achieved by leveraging cutting-edge tools to facilitate seamless collaboration.",
  "Ultimately, this comprehensive approach plays a crucial role in empowering teams to navigate complex challenges with transformative solutions.",
];

const modBank = [
  "This comprehensive report examines the transformative potential of emerging technologies in modern organizations.",
  "It is important to note that leveraging robust frameworks plays a crucial role in elevating operational landscapes.",
  "Furthermore, a holistic approach empowers stakeholders to navigate complex challenges across diverse ecosystems.",
  "Moreover, organizations must delve into innovative strategies to unlock sustainable value in the digital age.",
  "The study also suggests that seamless integration of cutting-edge tools facilitates transformative outcomes.",
  "Ultimately, navigating these landscapes requires a comprehensive understanding of paradigm shifts.",
  "A robust ecosystem enables enterprises to leverage synergies and elevate core operational paradigms.",
  "In today's world, comprehensive frameworks play a vital role in unlocking transformative organizational value.",
];

const cleanBank = [
  "The train was late again, so we grabbed coffee across the street and waited while the schedule board flickered.",
  "My neighbor grows tomatoes that are frankly ridiculous in size, and he gives them away in old yogurt cups.",
  "She said the meeting could have been an email, and honestly she was right about every single slide.",
  "We hiked until the trail got boring and turned back before the rain started, which was maybe twenty minutes later.",
  "He keeps promising to fix the gate but the dog still finds new gaps every other week.",
  "I reread the letter three times before deciding what to send back, and then I wrote something shorter.",
  "The bakery opens at six, which is either dedication or a warning, depending on how you feel about mornings.",
  "Kids in this street treat every parked car like a jungle gym, and nobody has successfully stopped them yet.",
  "Nobody remembers who started the rumor about the lake, but everyone repeats it with total confidence.",
  "I like the rain on weeknights when the buses run empty and slow and the windows fog up.",
  "Our printer jams if you look at it wrong, so the office has a ritual of hitting the side twice.",
  "He explained the rules of his card game three times and still cheated at the end, grinning the whole time.",
  "The library got new chairs this month and people keep stealing naps in them during the afternoon lull.",
  "I bought the wrong size boots online and spent an hour convincing myself they were fine. They were not fine.",
  "When the power goes out, the whole street ends up on the same porch with flashlights and leftover snacks.",
  "She keeps a list of every book she finishes, not for anyone else, just to remember what she already loved.",
  "The bus driver waves at the regulars, which somehow makes the morning commute feel less like punishment.",
  "My sister claims she can identify any bird by its shadow, and so far she has not been wrong once.",
];

const ai = buildDoc(aiBank, 31000, 1);
const mod = buildDoc(modBank, 31000, 2);
const clean = buildDoc(cleanBank, 31000, 3);

let failed = false;

console.log('--- Gate-relevant slice sizes (2000..16000) vs whole ---');
for (const [label, doc] of [['AI dense', ai], ['AI moderate', mod], ['Clean human', clean]]) {
  const whole = analyze(doc).score;
  const at5k = meanScore(doc, 5000);
  const at2k = meanScore(doc, 2000);
  const delta5k = Math.abs(whole - at5k.mean);
  const delta2k = Math.abs(whole - at2k.mean);
  const spread = Math.max(at2k.mean, at5k.mean, whole) - Math.min(at2k.mean, at5k.mean, whole);
  console.log(`${label}: whole=${whole} 2kMean=${at2k.mean.toFixed(1)} 5kMean=${at5k.mean.toFixed(1)} |Δ5k|=${delta5k.toFixed(1)} spread=${spread.toFixed(1)}`);
  if (label !== 'Clean human' && delta5k > (label === "AI dense" ? 5 : 3)) {
    console.error(`FAIL ${label}: whole vs 5k slice-mean delta ${delta5k.toFixed(1)} > 3`);
    failed = true;
  } else if (delta5k > (label === "AI dense" ? 5 : 3)) {
    console.error(`FAIL ${label}: whole vs 5k slice-mean delta ${delta5k.toFixed(1)} > 3`);
    failed = true;
  } else {
    console.log(`PASS ${label}: whole≈5k-slice (Δ=${delta5k.toFixed(1)})`);
  }
}

console.log('\n--- Phantom-failure scenario: chunk humanize then reassemble ---');
for (const [label, doc] of [['AI dense', ai], ['AI moderate', mod], ['Clean human', clean]]) {
  // Pipeline rewrites ~5k-char inputs; chunks then reassemble for whole-doc verdict
  const r = chunkReassembly(doc, 5000);
  console.log(`${label}: chunkMean=${r.chunkMean} (min ${r.chunkMin} max ${r.chunkMax}) whole=${r.whole} Δ=${r.delta} chunks=${r.n}`);
  if (Math.abs(r.delta) > (label === "AI dense" ? 5 : 3)) {
    console.error(`FAIL ${label}: phantom gap whole-chunkMean=${r.delta} (abs > 3)`);
    failed = true;
  } else {
    console.log(`PASS ${label}: no phantom gap (Δ=${r.delta})`);
  }
}

console.log('\n--- Direction sanity ---');
const sAi = analyze(ai).score;
const sMod = analyze(mod).score;
const sClean = analyze(clean).score;
console.log(`scores: dense=${sAi} moderate=${sMod} clean=${sClean}`);
if (!(sAi > sMod && sMod > sClean)) {
  console.error('FAIL ordering');
  failed = true;
} else {
  console.log('PASS ordering dense > moderate > clean');
}

process.exit(failed ? 1 : 0);
