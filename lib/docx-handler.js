const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const DEFAULT_FONT = 'Times New Roman';
const DEFAULT_SIZE = 22;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractTextFromDocx(buffer) {
  const mammoth = require('mammoth');
  return mammoth.extractRawText({ buffer }).then(r => r.value);
}

async function extractTextFromPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}

function extractParagraphText(inner) {
  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let txt = '';
  let m;
  while ((m = tRe.exec(inner))) txt += unescapeXml(m[1]);
  return txt;
}

function replaceRunText(rInner, text) {
  const tRe = /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;
  if (!tRe.test(rInner)) return rInner;
  tRe.lastIndex = 0;
  const escaped = escapeXml(text);
  return rInner.replace(tRe, `<w:t xml:space="preserve">${escaped}</w:t>`);
}

function rebuildParagraph(inner, newText) {
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  const runItems = [];
  const textRuns = [];
  let last = 0;
  let m;
  while ((m = runRe.exec(inner)) !== null) {
    const between = inner.slice(last, m.index);
    const rInner = m[1];
    const openTag = m[0].match(/^<w:r\b[^>]*>/)?.[0] || '<w:r>';
    const hasT = /<w:t\b/.test(rInner);
    runItems.push({ type: 'between', value: between });
    runItems.push({ type: 'run', full: m[0], inner: rInner, openTag, hasT, textLen: hasT ? extractParagraphText(rInner).length : 0 });
    if (hasT) textRuns.push(runItems[runItems.length - 1]);
    last = m.index + m[0].length;
  }
  runItems.push({ type: 'between', value: inner.slice(last) });

  if (textRuns.length === 0) return inner;

  const safeLens = textRuns.map(r => Math.max(r.textLen, 1));
  const total = safeLens.reduce((a, b) => a + b, 0);
  const chunks = [];
  let used = 0;
  for (let i = 0; i < textRuns.length; i++) {
    let len;
    if (i === textRuns.length - 1) len = newText.length - used;
    else len = Math.round((newText.length * safeLens[i]) / total);
    if (len < 0) len = 0;
    chunks.push(newText.slice(used, used + len));
    used += len;
  }

  let chunkIdx = 0;
  let out = '';
  for (const it of runItems) {
    if (it.type === 'between') out += it.value;
    else if (it.hasT) {
      const newInner = replaceRunText(it.inner, chunks[chunkIdx++] ?? '');
      out += it.openTag + newInner + '</w:r>';
    }
    else out += it.full;
  }
  return out;
}

function splitByBlankLine(text) {
  let parts = String(text).split(/\r?\n\s*\r?\n+/).map(s => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = String(text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return parts;
}

function splitEvenly(text, n) {
  if (n <= 0) return [];
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Array(n).fill('');
  const avg = Math.ceil(words.length / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(words.slice(i * avg, (i + 1) * avg).join(' '));
  }
  if (words.length > n * avg) out[n - 1] += ' ' + words.slice(n * avg).join(' ');
  return out;
}

async function humanizeDocxXml(xml, humanizeChunk) {
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const items = [];
  let last = 0;
  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    const between = xml.slice(last, m.index);
    items.push({ type: 'between', value: between });
    const inner = m[1];
    const full = m[0];
    const text = extractParagraphText(inner).trim();
    items.push({ type: 'para', value: full, inner, text });
    last = m.index + full.length;
  }
  items.push({ type: 'between', value: xml.slice(last) });

  const CHUNK_MAX = 2500;
  const paras = items.filter(i => i.type === 'para' && i.text.length > 0);
  const chunks = [];
  let cur = [];
  let curLen = 0;
  let prevWasText = false;
  for (const it of items) {
    if (it.type === 'between') continue;
    if (it.type === 'para') {
      if (it.text.length > 0) {
        if (cur.length && (!prevWasText || curLen + it.text.length > CHUNK_MAX)) {
          chunks.push(cur);
          cur = [];
          curLen = 0;
        }
        cur.push(it);
        curLen += it.text.length;
        prevWasText = true;
      } else {
        if (cur.length) { chunks.push(cur); cur = []; curLen = 0; }
        prevWasText = false;
      }
    }
  }
  if (cur.length) chunks.push(cur);

  let provider = 'unknown';
  let paragraphsProcessed = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const input = chunk.map(p => p.text).join('\n');
    console.error(`  [docx] chunk ${ci + 1}/${chunks.length} (${input.length} chars, ${chunk.length} paragraphs)`);
    let rewritten;
    try {
      const result = await humanizeChunk(input);
      rewritten = typeof result === 'string' ? result : result.text;
      if (result && result.provider) provider = result.provider;
    } catch (e) {
      console.error(`  [docx] chunk ${ci + 1}/${chunks.length} failed: ${e.message}`);
      continue;
    }
    let outParas = splitByBlankLine(rewritten);
    if (outParas.length !== chunk.length) {
      outParas = splitEvenly(rewritten, chunk.length);
    }
    for (let i = 0; i < chunk.length; i++) {
      const newInner = rebuildParagraph(chunk[i].inner, outParas[i] ?? '');
      chunk[i].value = chunk[i].value.replace(chunk[i].inner, newInner);
      paragraphsProcessed++;
    }
  }

  let outXml = '';
  for (const it of items) outXml += it.value;

  return { outXml, provider, chunksProcessed: chunks.length, paragraphsProcessed, totalParagraphs: paras.length };
}

async function humanizeDocxPreserve(buffer, humanizeChunk) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('Not a valid .docx (no word/document.xml)');
  const xml = await entry.async('string');
  const { outXml, provider, chunksProcessed, paragraphsProcessed, totalParagraphs } = await humanizeDocxXml(xml, humanizeChunk);
  zip.file('word/document.xml', outXml);
  const outBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return { buffer: outBuffer, provider, chunksProcessed, paragraphsProcessed, totalParagraphs, text: await extractTextFromDocx(outBuffer) };
}

function extractFormattingFromDocx(buffer) {
  return new Promise(async (resolve) => {
    try {
      const zip = await JSZip.loadAsync(buffer);
      const docXml = await zip.file('word/document.xml')?.async('string');
      if (!docXml) return resolve({ font: DEFAULT_FONT, size: DEFAULT_SIZE, paragraphs: [] });

      const fontCounts = new Map();
      const sizeCounts = new Map();

      const pRegex = /<w:p[^>]*>([\s\S]*?)<\/w:p>/g;
      let pMatch;
      while ((pMatch = pRegex.exec(docXml)) !== null) {
        const pContent = pMatch[1];
        const runRegex = /<w:r[^>]*>([\s\S]*?)<\/w:r>/g;
        let rMatch;
        while ((rMatch = runRegex.exec(pContent)) !== null) {
          const runXml = rMatch[1];
          const text = extractParagraphText(runXml);
          const fontMatch = runXml.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/);
          if (fontMatch) fontCounts.set(fontMatch[1], (fontCounts.get(fontMatch[1]) || 0) + text.length);
          const sizeMatch = runXml.match(/<w:sz[^>]*w:val="(\d+)"/);
          if (sizeMatch) sizeCounts.set(parseInt(sizeMatch[1]), (sizeCounts.get(parseInt(sizeMatch[1])) || 0) + text.length);
        }
      }

      let topFont = DEFAULT_FONT;
      let topSize = DEFAULT_SIZE;
      if (fontCounts.size > 0) topFont = [...fontCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (sizeCounts.size > 0) topSize = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

      resolve({ font: topFont, size: topSize, paragraphs: [] });
    } catch {
      resolve({ font: DEFAULT_FONT, size: DEFAULT_SIZE, paragraphs: [] });
    }
  });
}

async function readDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (ext === '.docx') {
    const text = await extractTextFromDocx(buffer);
    const formatting = await extractFormattingFromDocx(buffer);
    return {
      text,
      format: 'docx',
      formatting: {
        font: formatting.font,
        sizePt: formatting.size / 2,
        sizeHalfPt: formatting.size,
      },
    };
  }

  const text = buffer.toString('utf8');
  return {
    text,
    format: 'txt',
    formatting: {
      font: DEFAULT_FONT,
      sizePt: DEFAULT_SIZE / 2,
      sizeHalfPt: DEFAULT_SIZE,
    },
  };
}

async function writeDocx(text, outputPath, formatting = {}) {
  const { Document, Packer, Paragraph, TextRun } = require('docx');

  const font = formatting.font || DEFAULT_FONT;
  const sizeHalfPt = formatting.sizeHalfPt || DEFAULT_SIZE;

  const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
  const docParagraphs = [];
  for (const para of paragraphs) {
    const lines = para.split(/\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      docParagraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line.trim(), font, size: sizeHalfPt })],
          spacing: { after: 200 },
        })
      );
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children: docParagraphs,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function writeHumanizedDocx(humanizedText, originalPath, outputPath) {
  let formatting = {};
  const ext = path.extname(originalPath).toLowerCase();
  if (ext === '.docx' && fs.existsSync(originalPath)) {
    try {
      const buffer = fs.readFileSync(originalPath);
      const fmt = await extractFormattingFromDocx(buffer);
      formatting = { font: fmt.font, sizeHalfPt: fmt.size, sizePt: fmt.size / 2 };
    } catch {}
  }
  return writeDocx(humanizedText, outputPath, formatting);
}

module.exports = {
  readDocument,
  writeDocx,
  writeHumanizedDocx,
  extractFormattingFromDocx,
  extractTextFromDocx,
  extractTextFromPdf,
  humanizeDocxPreserve,
  escapeXml,
  unescapeXml,
};