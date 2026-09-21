// ================================
// UTILS — pure helpers with no Peak-Abu module dependencies.
// Everything in here is trivially unit-testable: input in, output out.
// ================================
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// --- Input sanitization ---
function sanitizeUsername(input) {
  if (typeof input !== 'string') return null;
  const clean = input.trim().replace(/[^a-zA-Z0-9 _\-]/g, '');
  if (clean.length < 1 || clean.length > 24) return null;
  return clean;
}

function sanitizeCode(input) {
  if (typeof input !== 'string') return null;
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
}

// --- Generic error responses (never leak internals) ---
function safeError(res, status, message) {
  res.status(status).json({ error: message });
}

// --- Session code generation ---

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(crypto.randomInt(chars.length));
  }
  return code;
}

// --- Monthly quota period ---
//
// THE single definition of "which month is it" for every monthly counter:
// AI Reel edit credits, sessions per month, bandwidth per month. There used
// to be two — auth.js computed it in UTC while generation-usage.js used local
// server time — so AI credits and session quotas rolled over on different
// clocks. Identical on a UTC host, up to a day apart on any other, and the
// kind of thing that only bites after someone changes the server timezone.
//
// UTC on purpose: deployment-independent and immune to DST, so the boundary
// never moves and never occurs twice.
function getMonthKey(date) {
  return (date || new Date()).toISOString().slice(0, 7);   // e.g. "2026-09"
}

// The key N whole months before `date`, for retention pruning. Uses UTC
// arithmetic so it can't drift across a boundary the way setMonth() can.
function monthKeyBefore(months, date) {
  const d = new Date(date || new Date());
  d.setUTCDate(1);                       // avoid Jan 31 -> Mar 3 style overflow
  d.setUTCMonth(d.getUTCMonth() - months);
  return getMonthKey(d);
}

// --- Content-type verification: real MP4 bytes, not just extension ---
const MP4_SIGNATURES = [
  Buffer.from([0x66, 0x74, 0x79, 0x70]), // ftyp
  Buffer.from([0x6D, 0x6F, 0x6F, 0x76]), // moov
  Buffer.from([0x66, 0x72, 0x65, 0x65]), // free
  Buffer.from([0x6D, 0x64, 0x61, 0x74]), // mdat
];

function verifyMP4(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const boxType = buf.slice(4, 8);
    return MP4_SIGNATURES.some(sig => sig.equals(boxType));
  } catch (e) {
    return false;
  }
}

// --- Metadata JSON structure validation ---
function verifyJSON(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (parsed.version === undefined) return false;
    if (typeof parsed.saveTimeUTC !== 'number') return false;
    if (typeof parsed.startTimeUTC !== 'number') return false;
    const MIN_TS = 1577836800000; // 2020-01-01
    const MAX_TS = 4102444800000; // 2100-01-01
    if (parsed.saveTimeUTC < MIN_TS || parsed.saveTimeUTC > MAX_TS) return false;
    if (parsed.startTimeUTC < MIN_TS || parsed.startTimeUTC > MAX_TS) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// --- Download a CDN object to a local file ---
//
// v2 — bounded. The previous version used a bare https.get() with no timeout
// of any kind. If the connection stalled after headers (socket open, body
// never finishing) neither 'finish' nor 'error' ever fired and the promise
// hung forever. In composite.js that await sat in a serial loop BEFORE ffmpeg
// was even spawned, so the job stayed 'processing' indefinitely with nothing
// running — the "stitching forever" symptom with no ffmpeg process to find.
//
// Three bounds now:
//   idleMs  — no bytes for this long => abort (catches the stalled socket)
//   totalMs — whole transfer cap     => abort (catches the infinitely slow one)
//   redirects — followed up to a small limit; CDNs 302 more than you'd think,
//               and the old code treated any non-200 as a hard failure.
function downloadToFile(url, destPath, opts = {}) {
  const idleMs = opts.idleMs || 30000;
  const totalMs = opts.totalMs || 180000;
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 3;

  return new Promise((resolve, reject) => {
    let settled = false;
    let file = null;
    let req = null;
    let totalTimer = null;

    const cleanup = () => {
      if (totalTimer) clearTimeout(totalTimer);
      if (req) { try { req.destroy(); } catch (e) {} }
      if (file) { try { file.close(); } catch (e) {} }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      fs.unlink(destPath, () => {});
      reject(err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      resolve();
    };

    totalTimer = setTimeout(
      () => fail(new Error(`CDN download exceeded ${totalMs}ms: ${destPath}`)),
      totalMs
    );

    const go = (targetUrl, redirectsLeft) => {
      let client;
      try {
        client = new URL(targetUrl).protocol === 'http:' ? http : https;
      } catch (e) {
        return fail(new Error('CDN download: malformed URL'));
      }

      req = client.get(targetUrl, (response) => {
        const status = response.statusCode;

        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) return fail(new Error('CDN download: too many redirects'));
          const next = new URL(response.headers.location, targetUrl).toString();
          return go(next, redirectsLeft - 1);
        }

        if (status !== 200) {
          response.resume();
          return fail(new Error('CDN download failed: ' + status));
        }

        file = fs.createWriteStream(destPath);
        file.on('error', fail);

        // Idle guard: resets on every chunk. A socket that goes quiet
        // mid-body is the case the old code could not see.
        response.setTimeout(idleMs, () => {
          fail(new Error(`CDN download stalled (no data for ${idleMs}ms)`));
        });

        response.on('error', fail);
        response.pipe(file);
        file.on('finish', () => file.close(succeed));
      });

      req.on('error', fail);
      req.setTimeout(idleMs, () => {
        fail(new Error(`CDN download: connection timeout after ${idleMs}ms`));
      });
    };

    go(url, maxRedirects);
  });
}

module.exports = {
  sanitizeUsername,
  sanitizeCode,
  safeError,
  generateCode,
  getMonthKey,
  monthKeyBefore,
  verifyMP4,
  verifyJSON,
  downloadToFile
};
