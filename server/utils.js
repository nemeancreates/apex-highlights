// ================================
// UTILS — pure helpers with no Peak-Abu module dependencies.
// Everything in here is trivially unit-testable: input in, output out.
// ================================
const fs = require('fs');
const https = require('https');
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
function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error('CDN download failed: ' + response.statusCode));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

module.exports = {
  sanitizeUsername,
  sanitizeCode,
  safeError,
  generateCode,
  verifyMP4,
  verifyJSON,
  downloadToFile
};
