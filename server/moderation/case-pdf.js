// ================================
// CASE PDF — a plain, text-only PDF case file for staff.
//
// Hand-built (no PDF library) to keep the dependency list short: one font
// (Helvetica, built into every PDF reader), US Letter pages, automatic page
// breaks and word wrap. That's all a case file needs.
//
// NEVER put images or video frames in here. A case file can be about apparent
// child sexual abuse material, and copying that material into a document or
// a Discord channel is itself unlawful distribution. Case files carry
// metadata only — where the content is, who uploaded it, when — so staff
// can file a report without anyone redistributing it.
// ================================

const PAGE_W = 612, PAGE_H = 792;          // US Letter, points
const MARGIN = 54;
const BODY = 10, SMALL = 8.5, H1 = 16, H2 = 12;

// Helvetica glyph widths (per 1000 em) for printable ASCII 32..126.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,
  722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,
  667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,
  222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,
  260,334,584];
const BOLD_SCALE = 1.06;                   // close enough for wrapping bold text

function textWidth(str, size, bold) {
  let w = 0;
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    w += (c >= 32 && c <= 126) ? W[c - 32] : 556;
  }
  return w / 1000 * size * (bold ? BOLD_SCALE : 1);
}

// PDF standard fonts are Latin-1; anything else becomes '?'. Usernames and
// codes are already ASCII; this mostly catches emoji in free-text reasons.
function clean(str) {
  return String(str == null ? '' : str)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\x20-\x7E]/g, '?');
}

function esc(str) { return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

function wrap(str, size, bold, maxW) {
  const out = [];
  for (const para of clean(str).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const trial = line ? line + ' ' + word : word;
      if (textWidth(trial, size, bold) <= maxW) { line = trial; continue; }
      if (line) out.push(line);
      // A single word longer than the line (a long file key) gets hard-split.
      let w = word;
      while (textWidth(w, size, bold) > maxW) {
        let cut = w.length - 1;
        while (cut > 1 && textWidth(w.slice(0, cut), size, bold) > maxW) cut--;
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

// Builds the document from a list of blocks:
//   { h1: 'text' } { h2: 'text' } { p: 'text' } { small: 'text' }
//   { kv: [['Label', 'value'], ...] }   { rule: true }   { gap: 8 }
function buildPdf(blocks, { footer } = {}) {
  const pages = [];
  let ops = [];
  let y = PAGE_H - MARGIN;
  const usable = PAGE_W - MARGIN * 2;

  function newPage() {
    if (ops.length) pages.push(ops);
    ops = [];
    y = PAGE_H - MARGIN;
  }
  function need(h) { if (y - h < MARGIN + 18) newPage(); }
  function line(str, x, size, bold, color) {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color || '0 0 0'} rg ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(str)}) Tj ET`);
  }

  for (const b of blocks) {
    if (b.gap) { y -= b.gap; continue; }
    if (b.rule) {
      need(10); y -= 4;
      ops.push(`0.7 0.7 0.7 RG 0.6 w ${MARGIN} ${y.toFixed(1)} m ${PAGE_W - MARGIN} ${y.toFixed(1)} l S`);
      y -= 8; continue;
    }
    if (b.h1 || b.h2) {
      const size = b.h1 ? H1 : H2;
      const lines = wrap(b.h1 || b.h2, size, true, usable);
      need(size * 1.5 * lines.length + 6);
      y -= b.h1 ? 4 : 8;
      for (const l of lines) { y -= size * 1.25; line(l, MARGIN, size, true, b.color); }
      y -= 4; continue;
    }
    if (b.p || b.small) {
      const size = b.p ? BODY : SMALL;
      for (const l of wrap(b.p || b.small, size, !!b.bold, usable)) {
        need(size * 1.45);
        y -= size * 1.45;
        line(l, MARGIN, size, !!b.bold, b.color || (b.small ? '0.35 0.35 0.35' : null));
      }
      y -= 3; continue;
    }
    if (b.kv) {
      const labelW = b.labelWidth || 130;
      for (const [k, v] of b.kv) {
        const vals = wrap(v == null || v === '' ? '-' : String(v), BODY, false, usable - labelW);
        need(BODY * 1.45 * vals.length);
        vals.forEach((vl, i) => {
          y -= BODY * 1.45;
          if (i === 0) line(clean(k), MARGIN, BODY, true, '0.25 0.25 0.25');
          line(vl, MARGIN + labelW, BODY, false);
        });
      }
      y -= 4; continue;
    }
  }
  newPage();

  // --- Serialize ---
  const total = pages.length;
  const objs = [];
  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  const kids = [];
  pages.forEach((pOps, i) => {
    const foot = `BT /F1 ${SMALL} Tf 0.45 0.45 0.45 rg ${MARGIN} 30 Td (${esc(clean((footer || '') + '   Page ' + (i + 1) + ' of ' + total))}) Tj ET`;
    const content = pOps.concat([foot]).join('\n');
    const pageNum = 5 + i * 2, contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    objs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objs[contentNum] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${total} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { buildPdf };
