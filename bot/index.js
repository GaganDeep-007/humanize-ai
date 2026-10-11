const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TelegramBot } = require('./telegram');
const { loadConfig, saveConfig, resolveProviderKey } = require('../lib/config');
const { robustAnalyze } = require('../lib/analyzer');
const { humanize, sanitizeLlmOutput, callWorker } = require('../lib/humanizer');
const { gateOriginal, pickWorker, runUntilPass, getLastDecision, getBudgetSnapshot, roster, budgetFrom } = require('../lib/decision');
const { loadMemory, saveMemory } = require('../lib/brain');
const { isLmStudioReachable, FREE_PROVIDERS } = require('../lib/provider');
const { detectorStatus, checkAccount } = require('../lib/detector');
const { checkLayaHealth, resetLayaCache, layaUrl, layaToken } = require('../lib/laya');
const { readDocument, writeHumanizedDocx, writeDocx, humanizeDocxPreserve } = require('../lib/docx-handler');

const STORAGE = path.join(__dirname, '..', 'storage');
const STORAGE_MAX_AGE_DAYS = 10;

function cleanupStorage() {
  try {
    if (!fs.existsSync(STORAGE)) return;
    const now = Date.now();
    const maxAge = STORAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(STORAGE);
    const baseIds = new Set();
    for (const f of files) {
      const m = f.match(/^([a-f0-9]+)-/);
      if (m) baseIds.add(m[1]);
    }
    let removed = 0;
    for (const baseId of baseIds) {
      const matchFile = files.find(f => f.startsWith(baseId + '-'));
      if (!matchFile) continue;
      const stat = fs.statSync(path.join(STORAGE, matchFile));
      if (now - stat.mtimeMs > maxAge) {
        for (const f of files) {
          if (f.startsWith(baseId + '-')) {
            fs.unlinkSync(path.join(STORAGE, f));
            removed++;
          }
        }
      }
    }
    if (removed > 0) console.log(`[cleanup] Removed ${removed} files older than ${STORAGE_MAX_AGE_DAYS} days`);
  } catch (e) {
    console.error(`[cleanup] Error: ${e.message}`);
  }
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function looksLikeBinary(text) {
  if (!text) return true;
  // PDF or other binary magic bytes
  if (/^%PDF-[^]{4}/.test(text)) return true;
  // High control-char / non-printable ratio (binary stream content)
  let bad = 0;
  const n = Math.min(text.length, 20000);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) bad++;
  }
  return bad / n > 0.05;
}

function isRefusalText(text) {
  const trimmed = (text || '').trim().slice(0, 300).toLowerCase();
  const re = /(no readable language|cannot (?:rewrite|humanize|process|be rewritten)|can'?t (?:rewrite|process)|not able to (?:rewrite|process)|inable to rewrite|not text|is binary|looks like (?:a )?(?:pdf|binary)|unable to rewrite|this (?:is|looks like) (?:a )?pdf|no content to rewrite|nothing to rewrite)/;
  return re.test(trimmed);
}

function isAllowed(fromId, cfg) {
  const allowed = cfg.bot.allowedIds || [];
  return allowed.length === 0 || allowed.includes(Number(fromId));
}

function routingOpts(cfg) {
  return {
    mode: cfg.routingMode || 'lmstudio-first',
    lmModel: cfg.lmModel,
    orModel: cfg.orModel,
    lmstudioUrl: cfg.lmstudioUrl,
    aiThreshold: cfg.aiThreshold,
    style: cfg.style || 'normal',
  };
}

function latestStoredDoc() {
  if (!fs.existsSync(STORAGE)) return null;
  const files = fs.readdirSync(STORAGE)
    .filter(f => /-orig\.txt$/.test(f))
    .map(f => ({ f, mtime: fs.statSync(path.join(STORAGE, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.f || null;
}

function formatDetection(analysis, label) {
  const c = analysis.combined;
  const h = analysis.heuristic;
  const p = analysis.provider || 'unknown';
  const lines = [];
  lines.push(`${label} — AI likelihood: <b>${c.ai_likelihood}%</b>`);
  if (c.plagiarism_likelihood != null) {
    lines.push(`Plagiarism overlap: <b>${c.plagiarism_likelihood}%</b>`);
  }
  lines.push(`Heuristic: ${h.score}% (model: ${p})`);
  if (h.grammarlyFlags?.length) {
    lines.push(`Grammarly flags: ${h.grammarlyFlags.slice(0, 3).join(', ')}`);
  }
  return lines.join('\n');
}

function verdictLine(c, thresholds) {
  const aiFail = c.ai_likelihood >= thresholds.aiThreshold;
  const plgFail = c.plagiarism_likelihood != null && c.plagiarism_likelihood >= thresholds.plagiarismThreshold;
  const status = (fail) => (fail ? '⚠️ NEEDS WORK' : '✅ OK');
  const lines = [];
  lines.push(`<b>Thresholds</b> — AI ≤ ${thresholds.aiThreshold}% ${status(!aiFail)}`);
  if (c.plagiarism_likelihood != null) {
    lines.push(`         — Plagiarism ≤ ${thresholds.plagiarismThreshold}% ${status(!plgFail)}`);
  }
  lines.push(`<b>Verdict:</b> ${(aiFail || (plgFail && c.plagiarism_likelihood != null)) ? 'Needs humanizing' : 'Looks good 👍'}`);
  return lines.join('\n');
}

async function runAnalysis(text) {
  const cfg = loadConfig();
  const o = routingOpts(cfg);
  return robustAnalyze(text, cfg.model, o);
}

async function handleDocument(bot, msg, cfg) {
  const doc = msg.document;
  const chatId = msg.chat.id;
  const replyTo = msg.message_id;
  const origName = doc.file_name || 'document';

  const statusMsg = await bot.sendMessage(chatId, `📥 Received <b>${htmlEscape(origName)}</b>. Reading and scoring…`, { reply_to_message_id: replyTo });

  let file;
  try {
    file = await bot.downloadFile(doc.file_id);
  } catch (e) {
    await bot.editMessageText(chatId, statusMsg.message_id, `❌ Could not download file: ${htmlEscape(e.message)}`);
    return;
  }

  let text, formatting;
  const ext = path.extname(origName).toLowerCase();

  try {
    if (ext === '.docx') {
      const result = await readDocumentFromBuffer(file.buffer, origName);
      text = result.text;
      formatting = result.formatting;
    } else if (ext === '.pdf') {
      const { extractTextFromPdf } = require('../lib/docx-handler');
      text = await extractTextFromPdf(file.buffer);
      formatting = { font: 'Times New Roman', sizePt: 11, sizeHalfPt: 22 };
    } else {
      text = file.buffer.toString('utf8').trim();
      formatting = { font: 'Times New Roman', sizePt: 11, sizeHalfPt: 22 };
    }
  } catch (e) {
    await bot.editMessageText(chatId, statusMsg.message_id, `❌ Could not read file: ${htmlEscape(e.message)}`);
    return;
  }

  if (!text) {
    await bot.editMessageText(chatId, statusMsg.message_id, '❌ The file appears to be empty or not readable as text.');
    return;
  }

  if (looksLikeBinary(text)) {
    console.error(`[bot] rejected binary/non-text upload: ${origName}`);
    await bot.editMessageText(chatId, statusMsg.message_id, '❌ This file is <b>binary</b> (looks like a PDF or a non-text file). I can only read <b>.docx</b> or plain <b>.txt</b>/<b>.text</b> files. Export/convert it to .docx or copy the text into a .txt file and upload again.');
    return;
  }

  const srcId = crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(STORAGE, { recursive: true });

  const safeBase = srcId + '-' + Date.now();
  const srcPath = path.join(STORAGE, `${safeBase}-orig.txt`);
  fs.writeFileSync(srcPath, text);

  if (ext === '.docx' || ext === '.pdf') {
    fs.writeFileSync(path.join(STORAGE, `${safeBase}-orig${ext}`), file.buffer);
  }

  const fmtPath = path.join(STORAGE, `${safeBase}-format.json`);
  fs.writeFileSync(fmtPath, JSON.stringify({ font: formatting.font, sizePt: formatting.sizePt, sizeHalfPt: formatting.sizeHalfPt, originalName: origName }));

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  try {
    await bot.editMessageText(chatId, statusMsg.message_id, `📖 ${wordCount} words from <b>${htmlEscape(origName)}</b>. Scoring with dual analysis…`);

    const analysis = await runAnalysis(text);

    const lines = [];
    lines.push(formatDetection(analysis, '📊 <b>Result</b>'));
    lines.push('');
    lines.push(verdictLine(analysis.combined, cfg));
    lines.push('');
    if (analysis.heuristic.topPhrases.length) {
      lines.push(`Top AI phrases: ${analysis.heuristic.topPhrases.slice(0, 5).join(', ')}`);
    }
    lines.push('');
    lines.push('Reply <b>humanize</b> to get rewritten text in chat.');

    await bot.editMessageText(chatId, statusMsg.message_id, lines.join('\n'));
  } catch (e) {
    await bot.editMessageText(chatId, statusMsg.message_id, `❌ Scoring failed: ${htmlEscape(e.message)}`);
  }
}

async function readDocumentFromBuffer(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx') {
    const { extractFormattingFromDocx } = require('../lib/docx-handler');
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const formatting = await extractFormattingFromDocx(buffer);
    return {
      text: result.value,
      format: 'docx',
      formatting: {
        font: formatting.font,
        sizePt: formatting.size / 2,
        sizeHalfPt: formatting.size,
      },
    };
  }
  return {
    text: buffer.toString('utf8').trim(),
    format: 'txt',
    formatting: { font: 'Times New Roman', sizePt: 11, sizeHalfPt: 22 },
  };
}

async function handleHumanize(bot, msg, cfg, replyToId) {
  const chatId = msg.chat.id;
  const files = fs.existsSync(STORAGE) ? fs.readdirSync(STORAGE) : [];
  const filesForChat = files
    .filter(f => /-orig\.txt$/.test(f))
    .map(f => ({ f, mtime: fs.statSync(path.join(STORAGE, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const latest = filesForChat[0]?.f;
  if (!latest) {
    await bot.sendMessage(chatId, '❌ No earlier file found to humanize. Send a document first.');
    return;
  }
  const text = fs.readFileSync(path.join(STORAGE, latest), 'utf8');

  const baseId = latest.replace('-orig.txt', '');
  const fmtPath = path.join(STORAGE, `${baseId}-format.json`);
  let formatting = { font: 'Times New Roman', sizePt: 11, sizeHalfPt: 22 };
  try {
    formatting = JSON.parse(fs.readFileSync(fmtPath, 'utf8'));
  } catch {}

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const origDocxPath = path.join(STORAGE, `${baseId}-orig.docx`);
  const origPdfPath = path.join(STORAGE, `${baseId}-orig.pdf`);
  const providerName = await isLmStudioReachable() ? 'LM Studio (laptop)' : 'Groq/OpenRouter';

  const statusMsg = await bot.sendMessage(chatId,
    `✍️ <b>Process Started</b>\n` +
    `📄 <b>${htmlEscape(formatting.originalName || 'document')}</b>\n` +
    `📝 ${wordCount} words | ${fs.existsSync(origDocxPath) ? 'DOCX' : fs.existsSync(origPdfPath) ? 'PDF' : 'TXT'}\n` +
    `⚡ Primary worker: ${providerName}\n` +
    `⏳ Working... this may take a minute or two`,
    { reply_to_message_id: replyToId });

  const cfg2 = loadConfig();
  const o = routingOpts(cfg2);
  const memory = loadMemory(baseId);
  let chunksDone = 0;
  try {
    console.error(`[bot] humanize for base ${baseId} (in-place docx: ${fs.existsSync(origDocxPath)}, text length: ${text.length})`);
    let out;
    if (fs.existsSync(origDocxPath)) {
      let aggPasses = 0;
      const chunkCallback = async (chunk) => {
        chunksDone++;
        console.error(`[bot] docx chunk ${chunksDone} of ${chunk.length} chars → humanize()…`);
        const t0 = Date.now();
        const r = await humanize(chunk, cfg2.model, { ...o, memory });
        const clean = sanitizeLlmOutput(r.text);
        aggPasses += r.passes || 0;
        console.error(`[bot] chunk ${chunksDone} done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${clean.length} chars${r.brain?.used ? ' (brain-verified)' : ' (no brain)'}`);
        saveMemory(baseId, memory);
        return clean;
      };
      out = await humanizeDocxPreserve(fs.readFileSync(origDocxPath), chunkCallback);
      out.passes = aggPasses;
      const chunkedDocxPath = path.join(STORAGE, `${baseId}-humanized.docx`);
      try {
        fs.writeFileSync(chunkedDocxPath, out.buffer);
        console.error(`[bot] humanized docx saved (chunked): ${chunkedDocxPath}`);
      } catch (e) {
        console.error(`[bot] save humanized docx failed: ${e.message}`);
      }
      console.error(`[bot] in-place rewrite done (${out.chunksProcessed} chunks, ${out.paragraphsProcessed}/${out.totalParagraphs} paragraphs)`);
    } else {
      out = await humanize(text, cfg2.model, { ...o, memory });
      out.text = sanitizeLlmOutput(out.text);
      saveMemory(baseId, memory);
    }

    if (isRefusalText(out.text)) {
      throw new Error('The worker refused to rewrite (input may be binary/non-text). Remove the PDF/raw file from the chat and upload a .docx or .txt instead.');
    }
    let after = await runAnalysis(out.text);
    console.error(`[bot] post humanize analysis: AI ${after.combined.ai_likelihood}%, plagiarism ${after.combined.plagiarism_likelihood ?? 'n/a'}%`);

    if (after.combined.ai_likelihood > cfg2.aiThreshold) {
      console.error(`[bot] FINAL VERIFICATION FAILED: AI ${after.combined.ai_likelihood}% > threshold ${cfg2.aiThreshold}%`);

      if (cfg2.decision?.enabled !== false) {
        await bot.editMessageText(chatId, statusMsg.message_id,
          `⚠️ <b>Quality Check Failed</b>\n\n` +
          `The humanized text still scores <b>${after.combined.ai_likelihood}%</b> AI (threshold: ${cfg2.aiThreshold}%).\n\n` +
          `Running remaining decision-engine strategies on the full text…`);

        const retry = await runUntilPass(out.text, cfg2.model, {
          ...o, memory, cfg: cfg2,
          triedKeys: out.run?.triedKeys || [],
        });
        saveMemory(baseId, memory);

        if (retry.passed || (retry.combined != null && retry.combined < after.combined.ai_likelihood)) {
          if (retry.text !== out.text) out.buffer = null;
          out.text = retry.text;
          out.passes = (out.passes || 0) + retry.passes;
          after = await runAnalysis(out.text);
          console.error(`[bot] decision retry improved: AI ${after.combined.ai_likelihood}% (${retry.stopReason})`);
        } else {
          console.error(`[bot] decision retry no gain (${retry.stopReason}, best ${retry.combined ?? 'n/a'}%)`);
        }
      } else {
        await bot.editMessageText(chatId, statusMsg.message_id,
          `⚠️ <b>Quality Check Failed</b>\n\n` +
          `The humanized text still scores <b>${after.combined.ai_likelihood}%</b> AI (threshold: ${cfg2.aiThreshold}%).\n\n` +
          `Attempting one more voice polish pass...`);

        const polishSystem = { role: 'system', content: 'You are a human writer who refines the voice of a text without rebuilding it. Keep every fact — only the phrasing and rhythm change.' };
        const polishFeedback = () => `DETECTOR FEEDBACK — the text still scores ${bestScore}% AI (target ≤ ${cfg2.aiThreshold}%). Rework sentence rhythm (uniform pacing is the #1 flag) and flat tone into a natural, concrete voice. Keep meaning identical. Remove AI filler phrases.`;
        let bestText = out.text;
        let bestScore = after.combined.ai_likelihood;

        const tryAggressive = async (label, workerOpts) => {
          try {
            let rewritten;
            let provider = 'unknown';
            const feedbackBlock = '\n\n' + polishFeedback();
            if (out.text.length > 16000) {
              const pieces = chunkTextForRewrite(out.text);
              const parts = [];
              for (const piece of pieces) {
                const r = await callWorker([polishSystem, { role: 'user', content: piece + feedbackBlock }], workerOpts);
                provider = r.provider;
                parts.push(sanitizeLlmOutput(r.text));
              }
              rewritten = parts.join('\n\n');
            } else {
              const r = await callWorker([polishSystem, { role: 'user', content: out.text + feedbackBlock }], workerOpts);
              provider = r.provider;
              rewritten = sanitizeLlmOutput(r.text);
            }
            const t = rewritten;
            const s = await runAnalysis(t);
            console.error(`[bot] voice polish pass (${label}, ${provider}): AI ${s.combined.ai_likelihood}%`);
            if (s.combined.ai_likelihood < bestScore) {
              bestText = t;
              bestScore = s.combined.ai_likelihood;
              console.error(`[bot] voice polish pass (${label}) IMPROVED to ${bestScore}%`);
            } else {
              console.error(`[bot] voice polish pass (${label}) backfired (${s.combined.ai_likelihood}% >= ${bestScore}%)`);
            }
          } catch (e) {
            console.error(`[bot] voice polish pass (${label}) failed: ${e.message}`);
          }
        };

        await tryAggressive('lmstudio', { ...cfg2, model: cfg2.model, temperature: 0.85 });
        if (bestScore > cfg2.aiThreshold) {
          await bot.editMessageText(chatId, statusMsg.message_id,
            `⚠️ <b>Quality Check Failed</b>\n\n` +
            `Primary worker still scores <b>${bestScore}%</b> AI.\n` +
            `Trying alternate worker (Groq/OpenRouter)...`);
          await tryAggressive('groq/openrouter', { ...cfg2, model: cfg2.model, temperature: 0.95, workerMode: 'openrouter-only' });
        }

        if (bestText !== out.text) out.buffer = null;
        out.text = bestText;
        after = await runAnalysis(out.text);
        console.error(`[bot] final verification: AI ${after.combined.ai_likelihood}%`);

        if (after.combined.ai_likelihood > cfg2.aiThreshold) {
          console.error(`[bot] WARNING: Still above threshold after voice polish pass`);
        }
      }
    }

    if (fs.existsSync(origDocxPath) && !out.buffer) {
      const finalDocxPath = path.join(STORAGE, `${baseId}-humanized.docx`);
      try {
        await writeHumanizedDocx(out.text, origDocxPath, finalDocxPath);
        console.error(`[bot] humanized docx saved (final text): ${finalDocxPath}`);
      } catch (e) {
        console.error(`[bot] save humanized docx (final) failed: ${e.message}`);
      }
    }

    const lines = [];
    lines.push(out.skipped
      ? '⏸ <b>No rewrite needed</b> — original already within threshold.'
      : '✅ <b>Humanized</b> — rewritten to sound naturally human.');
    lines.push(out.skipped
      ? `Heuristic score: ${out.heuristicScore ?? 'n/a'}%`
      : `📝 ${out.passes ?? 'in-place'} attempt(s) completed, heuristic score: ${out.heuristicScore ?? 'n/a'}%`);
    lines.push('');
    lines.push(formatDetection(after, '📊 <b>After</b>'));
    lines.push('');
    lines.push(verdictLine(after.combined, cfg2));

    await bot.editMessageText(chatId, statusMsg.message_id, lines.join('\n'));

    const humanizedText = out.text || '';
    const sections = formatForChat(humanizedText);
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const prefix = i === 0 ? '📄 <b>Humanized Content:</b>\n\n' : '';
      await bot.sendMessage(chatId, prefix + section, { parse_mode: 'HTML' });
    }

  } catch (e) {
    console.error(`[bot] humanize failed: ${e.message}\n${e.stack}`);
    await bot.editMessageText(chatId, statusMsg.message_id, `❌ Humanizing failed: ${htmlEscape(e.message)}`);
  }
}

// Split text into rewrite-sized pieces (≤ ~4k tokens each) so free providers
// (Groq's 7000 ITPM ceiling, etc.) never reject the whole document.
function chunkTextForRewrite(text, maxChars = 16000) {
  const paragraphs = String(text || '').split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  for (const p of paragraphs) {
    const next = cur ? cur + '\n\n' + p : p;
    if (next.length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [String(text || '')];
}

function formatForChat(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentSection = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    const isHeading = /^#{1,3}\s/.test(trimmed) || 
                     /^\d+\.\s/.test(trimmed) || 
                     /^\d+\.\d+[\.\d]*\s/.test(trimmed) || 
                     /^[IVXLC]+\.\s/.test(trimmed) ||
                     /^[A-Z]\.\s/.test(trimmed) ||
                     (trimmed.length > 0 && trimmed.length < 80 && 
                      /^[A-Z][A-Z\s]{5,}$/.test(trimmed)) ||
                     /^\*\*[^*]+\*\*$/.test(trimmed) ||
                     /^<b>[^<]+<\/b>$/.test(trimmed);
    
    if (isHeading && currentSection.length > 0) {
      sections.push(currentSection.join('\n'));
      currentSection = [];
    }
    
    if (isHeading) {
      let headingText = trimmed
        .replace(/^#+\s*/, '')
        .replace(/^\*\*([^*]+)\*\*$/, '$1')
        .replace(/^<b>([^<]+)<\/b>$/, '$1');
      currentSection.push(`<b>📌 ${headingText}</b>`);
    } else {
      currentSection.push(trimmed);
    }
  }
  
  if (currentSection.length > 0) {
    sections.push(currentSection.join('\n'));
  }
  
  const formattedSections = sections.map(s => s.trim()).filter(s => s.length > 0);
  
  const maxTelegramLength = 4000;
  const result = [];
  
  for (const section of formattedSections) {
    if (section.length <= maxTelegramLength) {
      result.push(section);
    } else {
      const words = section.split(' ');
      let chunk = '';
      for (const word of words) {
        if ((chunk + ' ' + word).length > maxTelegramLength && chunk.length > 0) {
          result.push(chunk);
          chunk = word;
        } else {
          chunk = chunk ? chunk + ' ' + word : word;
        }
      }
      if (chunk) result.push(chunk);
    }
  }
  
  return result.length > 0 ? result : [text.slice(0, 4000)];
}

async function handleCommand(bot, msg, cfg) {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const lower = text.toLowerCase();

  if (/^\/start/.test(lower)) {
    await bot.sendMessage(chatId,
      '👋 <b>Humanize / AI-score bot</b>\n\n' +
      'Drop a <b>text file or .docx</b> and I\'ll score its AI-likelihood and plagiarism overlap.\n\n' +
      'Commands:\n' +
      '• /threshold — show current acceptable %\n' +
      '• /threshold ai 30 — set AI threshold to 30%\n' +
      '• /threshold plagiarism 15 — set plagiarism threshold\n' +
      '• /model — show current routing/models\n' +
      '• /route auto|lmstudio|openrouter — set routing mode\n' +
      '• /status — check LM Studio laptop reachability\n' +
      '• /laya — check Laya decision layer status\n' +
      '• /layacfg url token — point gates at a Laya endpoint (Colab/Space)\n' +
      '• /providers — check free API provider keys\n' +
      '• /detector — AI-detector (judge) status / set key\n' +
      '• /style — rewrite voice: normal or clear-structured\n' +
      '• /decide — run the decision gate on the last document\n' +
      '• /why — show the last decision (verdict, attempts, stop reason)\n' +
      '• /roster — show rewrite strategies + rejection history\n' +
      '• /budget — show persistence budget (attempts / time)\n\n' +
      'After a scan, reply <b>humanize</b> to get a .docx rewrite.');
    return;
  }

  if (/^\/threshold/.test(lower)) {
    const parts = lower.split(/\s+/);
    const kind = parts[1];
    const val = Number(parts[2]);
    if ((kind === 'ai' || kind === 'plagiarism') && Number.isFinite(val) && val >= 0 && val <= 100) {
      const patch = {};
      if (kind === 'ai') patch.aiThreshold = val;
      else patch.plagiarismThreshold = val;
      const final = saveConfig(patch);
      await bot.sendMessage(chatId,
        `✅ ${kind === 'ai' ? 'AI' : 'Plagiarism'} threshold set to <b>${val}%</b>\n\n` +
        `Current: AI ≤ ${final.aiThreshold}%, Plagiarism ≤ ${final.plagiarismThreshold}%`);
    } else {
      await bot.sendMessage(chatId,
        `📏 <b>Current thresholds</b>\n\nAI likelihood: <b>${cfg.aiThreshold}%</b>\nPlagiarism: <b>${cfg.plagiarismThreshold}%</b>\n\n` +
        'To change: /threshold ai 30 or /threshold plagiarism 15');
    }
    return;
  }

  if (/^\/model/.test(lower)) {
    await bot.sendMessage(chatId,
      `🧠 <b>Models / routing</b>\n\n` +
      `Routing mode: <b>${cfg.routingMode}</b>\n` +
      `LM Studio: <b>${cfg.lmstudioUrl}</b> (${cfg.lmModel})\n` +
      `OpenRouter: <b>${cfg.orModel}</b>\n\n` +
      `Read fallback providers with /providers`);
    return;
  }

  if (/^\/route/.test(lower)) {
    const mode = lower.split(/\s+/)[1];
    const valid = ['lmstudio-first', 'openrouter-first', 'lmstudio-only', 'openrouter-only', 'auto'];
    const normalized = mode === 'auto' ? 'lmstudio-first' : mode;
    if (valid.includes(normalized)) {
      saveConfig({ routingMode: normalized });
      await bot.sendMessage(chatId, `✅ Routing mode set to <b>${normalized}</b>.`);
    } else {
      await bot.sendMessage(chatId, `❌ Valid modes: lmstudio-first, openrouter-first, lmstudio-only, openrouter-only, auto`);
    }
    return;
  }

  if (/^\/style/.test(lower)) {
    const v = (text.split(/\s+/)[1] || '').toLowerCase();
    if (v === 'normal' || v === 'clear-structured') {
      saveConfig({ style: v });
      await bot.sendMessage(chatId, `✅ Rewrite style set to <b>${v}</b>. Next humanization will use it.`);
    } else {
      await bot.sendMessage(chatId,
        `🎨 <b>Rewrite style</b>\n\nCurrent: <b>${cfg.style || 'normal'}</b>\n\n` +
        `• /style normal — plain, friendly, conversational (like a person explaining an idea)\n` +
        `• /style clear-structured — tidy, professional, keeps outlines/headings\n\n` +
        `Clever-style: refinement, not rewriting — every fact stays, only the voice changes.`);
    }
    return;
  }

  if (/^\/status/.test(lower)) {
    const up = await isLmStudioReachable();
    await bot.sendMessage(chatId,
      `🔌 <b>LM Studio (laptop) status</b>\n\n` +
      `URL: ${cfg.lmstudioUrl}\n` +
      `Reachable: <b>${up ? '✅ yes' : '❌ no'}</b>\n\n` +
      `Mode: ${cfg.routingMode}`);
    return;
  }

  if (/^\/providers/.test(lower)) {
    const lines = ['🔗 <b>Free API providers</b>\n'];
    for (const p of FREE_PROVIDERS) {
      const key = resolveProviderKey(p.name, cfg);
      const enabled = cfg.providers?.[p.name]?.enabled !== false;
      const status = !enabled ? '❌ disabled' : key ? '✅ key set' : '⚠️ no key — signup needed';
      lines.push(`<b>${p.name}</b>: ${status}`);
      lines.push(`  Models: ${p.models.join(', ')}`);
      lines.push('');
    }
    const clever = cfg.providers?.clever;
    if (clever) {
      lines.push(`<b>clever</b> (humanizer): ${clever.enabled ? (clever.available ? '✅ ready' : '⚠️ API coming soon') : '❌ disabled'}`);
      lines.push('  cleverhumanizer.ai/api — POST /v1/detect · /v1/humanize (not public yet)');
      lines.push('');
    }
    lines.push('Keys can be added via ~/.config/humanize-ai/config.json → providers.<name>.apiKey');
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if (/^\/detector/.test(lower)) {
    const parts = text.split(/\s+/).slice(1);
    const sub = (parts[0] || '').toLowerCase();
    if (sub === 'set' && parts[1]) {
      const provider = (cfg.detector?.provider || 'sapling').toLowerCase();
      const fieldMap = {
        gptzero: 'gptzeroApiKey',
        huggingface: 'hfToken',
        kiprio: 'kiprioApiKey',
        wasitai: 'wasitaiApiKey',
        contentdetector: 'contentdetectorApiKey',
        sapling: 'saplingApiKey',
      };
      const field = fieldMap[provider] || 'saplingApiKey';
      saveConfig({ detector: { [field]: parts[1], enabled: true } });
      await bot.sendMessage(chatId, `✅ Detector key saved for <b>${htmlEscape(provider)}</b>. Restart the bot to load it:\n<code>systemctl --user restart humanize-bot</code>`);
      return;
    }
    if (sub === 'provider' && parts[1]) {
      const provider = parts[1].toLowerCase();
      if (!['sapling', 'huggingface', 'contentdetector', 'kiprio', 'wasitai', 'gptzero'].includes(provider)) {
        await bot.sendMessage(chatId, '❌ Valid providers: sapling, huggingface, contentdetector, kiprio, wasitai, gptzero.');
        return;
      }
      saveConfig({ detector: { provider } });
      await bot.sendMessage(chatId, `✅ Detector provider set to <b>${htmlEscape(provider)}</b>. Send /detector set &lt;key&gt; if you haven\'t added one.`);
      return;
    }
    if (sub === 'check') {
      const acct = await checkAccount(cfg);
      if (acct.error) { await bot.sendMessage(chatId, `❌ ${htmlEscape(acct.error)}`); return; }
      if (acct.ok) {
        const detail = acct.probeAi != null
          ? `Live probe scored sample text ${acct.probeAi}% AI.`
          : `Usage: ${acct.usage?.chars_this_month ?? '?'}/${acct.usage?.monthly_quota_chars ?? '∞'} chars this month.`;
        await bot.sendMessage(chatId, `✅ Detector key works.\n${detail}\n\nEnable with /detector (then restart) or <code>humanize-ai detector --enable</code>.`);
        return;
      }
      await bot.sendMessage(chatId,
        `🔎 <b>Detector account check</b>\n\n` +
        `Blocked: <b>${htmlEscape(acct.blockedReason || 'unknown')}</b>\n` +
        `${acct.message ? htmlEscape(acct.message) + '\n' : ''}\n` +
        `${acct.subscription ? `Plan: active=${acct.subscription.active}, trial_only=${acct.subscription.trial_only}, key_expired=${acct.subscription.key_expired}\n\n` : ''}` +
        `Fix on Sapling's side: resubscribe / buy credits at https://sapling.ai/api_settings#billing (or support@sapling.ai).`);
      return;
    }
    const st = detectorStatus(cfg);
    await bot.sendMessage(chatId,
      `🔎 <b>AI detector</b> (judge/eval signal)\n\n` +
      `Enabled: <b>${st.enabled ? 'yes' : 'no'}</b>\n` +
      `Provider: <b>${htmlEscape(st.provider)}</b>\n` +
      `API key: ${st.keySet ? (st.keyOptional ? '✅ not needed (free, no key)' : '✅ set ' + htmlEscape(st.keyMasked)) : '❌ not set — auto-fallback'}\n` +
      `Weight: ${st.weight} base blend (→ ~0.8 when detector is decisive: 0 or 100)\n` +
      `Fallback: <b>${st.fallback ? 'auto-failover on' : 'off'}</b>\n` +
      `Chain: <code>${htmlEscape(st.chain.join(' → '))}</code>\n\n` +
      `<b>sapling</b> — free dev key (expires ~1 mo): https://sapling.ai/api_settings\n` +
      `<b>huggingface</b> — free HF read token (long-lived): https://huggingface.co/settings/tokens\n` +
      `<b>contentdetector</b> — FREE, no key needed: https://contentdetector.net/api\n` +
      `<b>kiprio</b> — free tier (key optional): https://kiprio.com/ai-detect-api\n` +
      `<b>wasitai</b> — free 1,000 credits: https://www.wasitaigenerated.com/ai-detector-api\n` +
      `<b>gptzero</b> — paid Professional API key: https://gptzero.me/developers\n\n` +
      `Set key: /detector set &lt;api_key&gt;\n` +
      `Switch: /detector provider sapling|huggingface|contentdetector|kiprio|wasitai|gptzero\n` +
      `Verify: /detector check`);
    return;
  }

  if (/^\/layacfg/.test(lower)) {
    const parts = text.split(/\s+/).slice(1);
    const url = (parts[0] || '').trim().replace(/\/+$/, '');
    const token = (parts[1] || '').trim();
    if (!/^https?:\/\/.+/i.test(url)) {
      await bot.sendMessage(chatId, '❌ Usage: /layacfg https://your-space.hf.space [auth_token]');
      return;
    }
    const probe = await checkLayaHealth({ url, token, timeoutMs: 15000 });
    if (!probe.ok) {
      await bot.sendMessage(chatId,
        `❌ Could not reach Laya at <b>${htmlEscape(url)}</b>\n\n` +
        `Reason: ${htmlEscape(probe.error || 'unreachable')}\n\n` +
        `Nothing changed in config. Check the space/Colab is running and the token matches.`);
      return;
    }
    saveConfig({ layaUrl: url, layaToken: token });
    resetLayaCache();
    await bot.sendMessage(chatId,
      `✅ <b>Decision layer updated</b>\n\n` +
      `URL: <b>${htmlEscape(url)}</b>\n` +
      `Device: <b>${probe.device || 'unknown'}</b>\n` +
      `Routing: ${probe.routing ? 'ready' : 'not loaded'}\n\n` +
      `Gates (verify/judge/backfire) now try this Laya endpoint first, confidence-gated, with LLM fallback.`);
    return;
  }

  if (/^\/laya/.test(lower)) {
    const cfgNow = loadConfig();
    const st = await checkLayaHealth();
    const tok = layaToken(cfgNow);
    await bot.sendMessage(chatId,
      `🔮 <b>Laya decision layer</b>\n\n` +
      `URL: <b>${htmlEscape(layaUrl(cfgNow))}</b>\n` +
      `Auth: ${tok ? '<b>enabled</b> (masked)' : '<i>none</i>'}\n` +
      `Reachable: <b>${st.ok ? '✅ yes' : '❌ no'}</b>\n` +
      (st.ok ? `Device: ${st.device || 'unknown'}\n` : '') +
      (st.ok ? `Routing: ${st.routing ? 'ready' : 'not loaded'}\n` : '') +
      `\nTo point it elsewhere: /layacfg url token`);
    return;
  }

  if (/^\/decide/.test(lower)) {
    const latest = latestStoredDoc();
    if (!latest) {
      await bot.sendMessage(chatId, '❌ No stored document. Send a file first, then /decide.');
      return;
    }
    const text = fs.readFileSync(path.join(STORAGE, latest), 'utf8');
    const status = await bot.sendMessage(chatId, '🧠 Running decision gate (heuristic + model eval)…');
    try {
      const g = await gateOriginal(text, cfg.model, routingOpts(cfg));
      const next = await pickWorker({ cfg, triedKeys: [], inputLength: text.length, memory: loadMemory(latest.replace('-orig.txt', '')) });
    const lines = [];
      lines.push(`🧠 <b>Decision gate</b> — verdict: <b>${g.verdict.toUpperCase()}</b>`);
      lines.push(`Reason: ${htmlEscape(g.reason || '—')}`);
      if (g.combined != null) {
        lines.push(`Combined: ${g.combined}% (heuristic ${g.heuristic}%, model ${g.modelAi ?? 'n/a'}%, threshold ${g.threshold}%)`);
      }
      lines.push('');
      lines.push(next
        ? `Next strategy if humanizing: <b>${htmlEscape(next.label)}</b> (T=${next.temperature})${next.lmCollapsed ? ' — LM down, collapsed to OpenRouter' : ''}`
        : 'No distinct strategies left in the roster.');
      await bot.editMessageText(chatId, status.message_id, lines.join('\n'));
    } catch (e) {
      await bot.editMessageText(chatId, status.message_id, `❌ Gate failed: ${htmlEscape(e.message)}`);
    }
    return;
  }

  if (/^\/why/.test(lower)) {
    const d = getLastDecision();
    if (!d) {
      await bot.sendMessage(chatId, 'ℹ️ No decision recorded yet this session. Run /decide or humanize something.');
      return;
    }
    const lines = [`🧭 <b>Last decision</b> — ${d.kind} @ ${d.at}`];
    lines.push(`Verdict: <b>${d.verdict}</b>${d.reason ? ` — ${htmlEscape(d.reason)}` : ''}`);
    if (d.combined != null) lines.push(`Combined ${d.combined}% (heuristic ${d.heuristic ?? 'n/a'}%, threshold ${d.threshold}%)`);
    if (d.stopReason) lines.push(`Stop reason: ${d.stopReason} after ${d.attempts} attempt(s) in ${(d.elapsedMs / 1000).toFixed(1)}s`);
    if (d.bestStrategy) lines.push(`Best strategy: ${htmlEscape(d.bestStrategy)}`);
    if (d.triedKeys?.length) lines.push(`Tried: ${d.triedKeys.map(htmlEscape).join('\n')}`);
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if (/^\/roster/.test(lower)) {
    const lmUp = await isLmStudioReachable().catch(() => false);
    const latest = latestStoredDoc();
    const memory = latest ? loadMemory(latest.replace('-orig.txt', '')) : null;
    const rows = roster(cfg, memory, lmUp);
    const lines = [`🎲 <b>Strategy roster</b> — LM Studio: ${lmUp ? '✅ up' : '❌ down'}\n`];
    for (const r of rows) {
      const h = r.history;
      const hist = h ? `${(h.ok || 0)} ok / ${(h.rejects || 0)} rejected${h.lastReason ? ` (${htmlEscape(h.lastReason)})` : ''}` : 'no history';
      lines.push(`<b>${htmlEscape(r.label)}</b>`);
      lines.push(`  <code>${htmlEscape(r.key)}</code>${r.note ? ` — ${r.note}` : ''}`);
      lines.push(`  ${hist}`);
      lines.push('');
    }
    lines.push('Distinct keys only — a strategy is never repeated within a run.');
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if (/^\/budget/.test(lower)) {
    const b = budgetFrom(cfg);
    const snap = getBudgetSnapshot();
    const d = getLastDecision();
    const lines = ['⏱ <b>Persistence budget</b>'];
    lines.push(`Max distinct strategies/run: <b>${b.maxAttempts}</b>`);
    lines.push(`Wall clock: <b>${(b.wallClockMs / 60000).toFixed(0)} min</b>/run`);
    lines.push(`Min words for a trusted gate: ${b.minTrustWords}`);
    lines.push(`AI threshold: ${cfg.aiThreshold}% (fixed — never loosened)`);
    lines.push(`Engine: ${cfg.decision?.enabled !== false ? '✅ enabled' : '❌ disabled (legacy ladder)'}`);
    if (d?.kind === 'run-until-pass') {
      lines.push('');
      lines.push(`Last run: ${d.attempts} attempt(s), ${(d.elapsedMs / 1000).toFixed(1)}s → ${d.verdict} (${d.stopReason})`);
    }
    if (snap && (snap.maxAttempts !== b.maxAttempts || snap.wallClockMs !== b.wallClockMs)) {
      lines.push(`Last run used: ${snap.maxAttempts} attempts / ${(snap.wallClockMs / 60000).toFixed(0)} min`);
    }
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  if (/^humanize/.test(lower) && !/^\//.test(text)) {
    await handleHumanize(bot, msg, cfg, msg.message_id);
    return;
  }

  await bot.sendMessage(chatId, '🤔 Try /start to see what I can do. Or drop a text file.');
}

async function main() {
  const cfg = loadConfig();
  const token = cfg.bot.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('No bot token. Add bot.token to ~/.config/humanize-ai/config.json or set TELEGRAM_BOT_TOKEN.');
    process.exit(1);
  }

  const bot = new TelegramBot(token);
  const me = await bot.getMe();
  console.log(`Logged in as @${me.username}`);

  cleanupStorage();

  if ((cfg.bot.allowedIds || []).length === 0) {
    console.warn('WARNING: no allowedIds configured — bot is open to anyone. Add allowed user IDs to config.');
  }

  console.log('Listening for updates (long polling)…');
  for (;;) {
    let updates;
    try {
      updates = await bot.getUpdates();
    } catch (e) {
      console.error(`Polling error: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    for (const u of updates) {
      await bot.acknowledge(u.update_id);
      const msg = u.message;
      if (!msg) continue;

      const fromId = msg.from?.id;
      if (!isAllowed(fromId, cfg)) {
        try {
          await bot.sendMessage(msg.chat.id, '⛔ You are not authorized to use this bot.');
        } catch {}
        continue;
      }

      try {
        if (msg.document) {
          await handleDocument(bot, msg, cfg);
        } else if (msg.text) {
          await handleCommand(bot, msg, cfg);
        }
      } catch (e) {
        console.error(`Handler error: ${e.message}`);
        try {
          await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
        } catch {}
      }
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
