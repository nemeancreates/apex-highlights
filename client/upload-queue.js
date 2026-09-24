// ================================
// UPLOAD QUEUE HELPERS — Low Bandwidth Mode building blocks.
//
// Kept out of main.js on purpose: everything here is either pure logic or a
// single network call with its host injectable, so it can be tested outside
// Electron. main.js owns the state (manifest, settings file, fight signals)
// and calls into this.
//
// Background: weak-upload players (15ms ping normally, 300ms+ mid-upload)
// hit bufferbloat — our upload fills their uplink and game packets queue
// behind it. Two levers here:
//   1. Throttle to a share of the player's MEASURED uplink instead of one
//      static cap (the old 6 Mbps cap never engaged for anyone below 6 Mbps).
//   2. In Low Bandwidth Mode, the clip's metadata goes up immediately (locks
//      the POV into the sync timeline) and the video waits for downtime.
// ================================
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { Transform } = require('stream');

const UPLOAD_THROTTLE_CAP_BPS = 750 * 1024;   // ceiling, ~6 Mbps — same as the old static cap
const UPLOAD_THROTTLE_FLOOR_BPS = 32 * 1024;  // never slower than this outside a fight
const UPLOAD_TRICKLE_BPS = 16 * 1024;         // mid-fight: keeps the socket alive (nginx body timeout) at ~0.13 Mbps
const THROTTLE_SHARE = 0.6;                   // use 60% of measured uplink, leave the rest for the game
const THROTTLE_SLICE_BYTES = 16 * 1024;       // pace in small pieces so a trickle is smooth, not 4s bursts
const LOW_BW_THRESHOLD_MBPS = 10;             // Auto mode: Low Bandwidth below this measured upload
const SPEEDTEST_BYTES = 3 * 1024 * 1024;      // server refuses > 4MB
const SPEEDTEST_TIMEOUT_MS = 60 * 1000;
const SPEEDTEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FIGHT_QUIET_MS = 20 * 1000;             // downtime must last this long before a video starts

const UPLOAD_MODES = ['auto', 'on', 'off'];

// --- Settings --------------------------------------------------------------

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: UPLOAD_MODES.includes(s.mode) ? s.mode : 'auto',
    measuredMbps: (typeof s.measuredMbps === 'number' && isFinite(s.measuredMbps) && s.measuredMbps > 0) ? s.measuredMbps : null,
    testedAt: (typeof s.testedAt === 'number' && s.testedAt > 0) ? s.testedAt : null
  };
}

function isLowBandwidth(settings) {
  if (settings.mode === 'on') return true;
  if (settings.mode === 'off') return false;
  return settings.measuredMbps !== null && settings.measuredMbps < LOW_BW_THRESHOLD_MBPS;
}

function speedTestIsStale(settings, now) {
  if (!settings.testedAt || settings.measuredMbps === null) return true;
  return (now - settings.testedAt) > SPEEDTEST_MAX_AGE_MS;
}

// Normal sending rate: 60% of measured uplink, clamped to [floor, cap].
// Unmeasured (test failed / never ran) falls back to the old static cap.
function baseThrottleBps(settings) {
  if (settings.measuredMbps === null) return UPLOAD_THROTTLE_CAP_BPS;
  const bps = (settings.measuredMbps * 1e6 / 8) * THROTTLE_SHARE;
  return Math.round(Math.min(UPLOAD_THROTTLE_CAP_BPS, Math.max(UPLOAD_THROTTLE_FLOOR_BPS, bps)));
}

// Rate right now. Throttling is a Low Bandwidth Mode feature only:
//   LBM on, fight active -> trickle (UPLOAD_TRICKLE_BPS)
//   LBM on, no fight     -> measured throttle (baseThrottleBps)
//   LBM off              -> unthrottled (Infinity) — RateThrottleStream
//     passes data straight through.
// Normal mode used to get the measured throttle too, which capped every
// player at <=6 Mbps and let auto-capture queues fall behind (RAE8X9, 9/23).
function currentThrottleBps(settings, fightActive) {
  if (!isLowBandwidth(settings)) return Infinity;
  if (fightActive) return UPLOAD_TRICKLE_BPS;
  return baseThrottleBps(settings);
}

// --- Throttle stream -------------------------------------------------------
// Replaces the old cumulative-average ThrottleStream. That one computed
// "allowed = rate × time since start", which is fine for a fixed rate but
// bursts everything it "owes" the moment the rate goes back up after a
// trickle. This paces each slice against a moving send slot instead, with
// no banked credit, so rate changes take effect immediately and smoothly.
class RateThrottleStream extends Transform {
  constructor(getBps, onProgress) {
    super();
    this.getBps = typeof getBps === 'function' ? getBps : () => getBps;
    this.onProgress = onProgress || null;
    this.nextAt = 0;
    this.sent = 0;
  }
  _transform(chunk, encoding, callback) {
    let off = 0;
    const step = () => {
      if (off >= chunk.length) return callback();
      const bps = Math.max(1, this.getBps());
      // Unthrottled (Low Bandwidth Mode off): pass the rest of the chunk
      // through in one push. Slicing it would recurse once per 16KB with no
      // wait, which is pointless work and can overflow the stack on a big
      // chunk. The rate is re-read per chunk, so switching modes mid-upload
      // still takes effect on the next chunk.
      if (bps === Infinity) {
        const rest = off === 0 ? chunk : chunk.subarray(off);
        off = chunk.length;
        this.nextAt = 0;
        this.sent += rest.length;
        this.push(rest);
        if (this.onProgress) { try { this.onProgress(this.sent); } catch (e) {} }
        return callback();
      }
      const piece = chunk.subarray(off, off + THROTTLE_SLICE_BYTES);
      off += piece.length;
      const now = Date.now();
      const start = Math.max(now, this.nextAt);
      this.nextAt = start + (piece.length / bps) * 1000;
      const go = () => {
        this.sent += piece.length;
        this.push(piece);
        if (this.onProgress) { try { this.onProgress(this.sent); } catch (e) {} }
        step();
      };
      const wait = start - now;
      if (wait <= 0) go(); else setTimeout(go, wait);
    };
    step();
  }
}

// --- Speed test ------------------------------------------------------------
// Times the upload from the moment the socket is connected (TLS done) to the
// server's response, so handshake latency doesn't drag a fast line down.
// agent:false forces a fresh socket — a reused keep-alive socket would never
// fire the connect event we time from. Resolves, never rejects.
function runSpeedTest(opts) {
  const o = Object.assign({
    host: 'peakabu.app', port: 443, transport: https, secure: true,
    path: '/api/speedtest', bytes: SPEEDTEST_BYTES, timeoutMs: SPEEDTEST_TIMEOUT_MS
  }, opts || {});
  return new Promise((resolve) => {
    let t0 = null;
    let settled = false;
    let timer = null;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const body = crypto.randomBytes(o.bytes); // random: nothing along the path can compress it

    const req = o.transport.request({
      host: o.host, port: o.port, path: o.path, method: 'POST', agent: false,
      headers: {
        'Authorization': 'Bearer ' + o.token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const elapsed = Date.now() - (t0 || Date.now());
        if (res.statusCode !== 200) return done({ ok: false, status: res.statusCode });
        let bytes = body.length;
        try { const j = JSON.parse(raw); if (typeof j.bytes === 'number') bytes = j.bytes; } catch (e) {}
        const secs = Math.max(elapsed, 1) / 1000;
        done({ ok: true, status: 200, mbps: +(bytes * 8 / secs / 1e6).toFixed(2), elapsedMs: elapsed });
      });
    });

    req.on('socket', (sock) => {
      sock.once(o.secure ? 'secureConnect' : 'connect', () => { t0 = Date.now(); });
    });
    req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));

    // A test that can't finish in 60s is itself the answer: under
    // 3MB/60s ≈ 0.4 Mbps. Report that upper bound as the measurement.
    timer = setTimeout(() => {
      req.destroy(new Error('speedtest timeout'));
      done({ ok: true, status: 0, timedOut: true, mbps: +(o.bytes * 8 / (o.timeoutMs / 1000) / 1e6).toFixed(2) });
    }, o.timeoutMs);

    req.end(body);
  });
}

// --- Matching local clips to server records --------------------------------
// The server stores files as `${sanitized base}_${Date.now()}${ext}` (multer
// filename() in server/routes/uploads.js). Mirror its sanitizer so a local
// name with a space or odd character still matches its server record.
function serverBaseName(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 100);
}

function findLandedRecord(uploads, videoPath) {
  const base = serverBaseName(videoPath) + '_';
  return (uploads || []).find(u => (u.videoFile || '').startsWith(base)) || null;
}

// A pending record = metadata posted, video not attached yet.
function findPendingRecord(uploads, metadataPath) {
  if (!metadataPath) return null;
  const base = serverBaseName(metadataPath) + '_';
  return (uploads || []).find(u => !u.videoFile && (u.metadataFile || '').startsWith(base)) || null;
}

// --- Sweep decision --------------------------------------------------------
// One manifest entry + the server's current view of its session → what to
// do next. Pure, so every branch is testable.
//
//   drop      — nowhere to send it (session gone / clip deleted). Local file kept.
//   done      — already on the server (a lost response, or a duplicate).
//   adopt     — the server already has this clip's pending record (lost
//               metadata response, or a normal entry that Sync/mode-switch
//               raced). Caller stores uploadId, marks deferred, re-decides.
//   post-meta — deferred, metadata not sent yet. Allowed mid-fight: it's KBs.
//   attach    — deferred, send the video to the pending record.
//   upload    — normal combined upload.
//   skip      — not now (server unreachable, or a fight in Low Bandwidth Mode).
function decideSweepAction(entry, remote, ctx) {
  if (!remote || remote.status === 404) return { action: 'drop', reason: 'session-gone' };
  if (remote.status !== 200) return { action: 'skip', reason: 'unreachable' };
  const uploads = remote.uploads || [];
  const holdForFight = !!(ctx && ctx.lowBandwidth && ctx.fightActive);

  if (findLandedRecord(uploads, entry.videoPath)) return { action: 'done', reason: 'landed' };

  if (entry.deferred && entry.uploadId) {
    const rec = uploads.find(u => u.id === entry.uploadId);
    if (!rec) return { action: 'drop', reason: 'clip-removed' };
    if (rec.videoFile) return { action: 'done', reason: 'landed' };
    if (holdForFight) return { action: 'skip', reason: 'fight' };
    return { action: 'attach' };
  }

  const pend = findPendingRecord(uploads, entry.metadataPath);
  if (pend) return { action: 'adopt', uploadId: pend.id };

  if (entry.deferred) return { action: 'post-meta' };
  if (holdForFight) return { action: 'skip', reason: 'fight' };
  return { action: 'upload' };
}

module.exports = {
  UPLOAD_THROTTLE_CAP_BPS, UPLOAD_THROTTLE_FLOOR_BPS, UPLOAD_TRICKLE_BPS,
  LOW_BW_THRESHOLD_MBPS, SPEEDTEST_BYTES, SPEEDTEST_MAX_AGE_MS, FIGHT_QUIET_MS, UPLOAD_MODES,
  normalizeSettings, isLowBandwidth, speedTestIsStale, baseThrottleBps, currentThrottleBps,
  RateThrottleStream, runSpeedTest,
  serverBaseName, findLandedRecord, findPendingRecord, decideSweepAction
};
