// ================================
// COMPOSITE — server-side Combined View export, plus the three HTTP
// endpoints that drive it.
//
// v4 (10-10-26): ONE GRID PER HIGHLIGHT, PLAYED IN ORDER.
//
// v3 put every selected clip into a single grid and delayed each one by
// its real start time. Marking clips from several highlights therefore
// gave one frame with all of them on screen at once, most tiles waiting
// their turn, and an output as long as the gap between the first and last
// highlight. The canvas was also just "grid size", so 2 clips came out
// 32:9 and 5-6 clips 8:3.
//
// Now:
//   1. Selected clips are grouped into highlights the same way the web
//      player groups them (clusterHighlights: moment timestamps within
//      HIGHLIGHT_GAP_MS).
//   2. Each highlight is rendered as its own synced grid on a fixed 16:9
//      canvas.
//   3. The grids are joined back to back, oldest highlight first.
//
// Each clip is first shrunk to its tile on its own (one full-size decode
// at a time), then the small tiles are stacked. Memory no longer grows
// with the number of POVs: measured on six 1440p60 clips, one-pass
// stacking peaked at 342 MB and took 84 s on one core; shrink-then-stack
// peaked at 242 MB and took 64 s. Source downloads are deleted as soon as
// their tile exists, so disk use is bounded too.
//
// Still true from v3: every path out of a job writes a terminal status
// (no floating promises, -nostdin, bounded downloads, a hard cap and an
// idle guard on every ffmpeg run, real progress from -progress pipe:1).
// ================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { log } = require('./logger');
const { sanitizeCode, downloadToFile } = require('./utils');
const { UPLOADS_DIR, tiersWithCapability } = require('./config');
const { sessions } = require('./stores');
const access = require('./session-access');
const { requireAuth, requireAuthAny, requireTier } = require('./auth');
const { getCommentsForSession } = require('./routes/comments');
const { generateASS, checkAssFilter, escapeFilterPath } = require('./comment-overlay');

// Paid tiers allowed to generate/download combined-view exports.
const EXPORT_TIERS = tiersWithCapability('hasExport');

const compositeJobs = new Map();
const COMPOSITE_DIR = path.join(os.tmpdir(), 'peak-abu-composites');
if (!fs.existsSync(COMPOSITE_DIR)) fs.mkdirSync(COMPOSITE_DIR, { recursive: true });

// --- Bounds. Every one of these exists to guarantee a terminal status. ---
const DOWNLOAD_IDLE_MS = 30 * 1000;       // no bytes for this long => abort that clip
const DOWNLOAD_TOTAL_MS = 180 * 1000;     // whole-clip transfer cap
const META_CONCURRENCY = 3;               // parallel sidecar reads
const ENCODE_HARD_CAP_MS = 15 * 60 * 1000;// absolute ceiling on one ffmpeg run
const ENCODE_IDLE_MS = 90 * 1000;         // no progress line for this long => hung
const PROGRESS_POLL_MS = 15 * 1000;       // how often the idle guard checks
// Whole-job ceiling. The web player waits one minute longer than this
// (COMPOSITE_CLIENT_DEADLINE_MS in web-player/index.html); keep them together.
const JOB_HARD_CAP_MS = 45 * 60 * 1000;

// --- What one export may contain. ---
// A grid holds up to 9 POVs (3x3). A highlight with more plays as several
// grids of that moment, one after another.
const MAX_POVS_PER_GRID = 9;
// Across all the highlights in one export.
const MAX_COMPOSITE_CLIPS = 30;
// Total footage to process: the sum of every selected clip's length. This is
// what the render time follows (each clip is decoded once at full size).
const MAX_TOTAL_CLIP_SEC = 20 * 60;
// Clips whose moment timestamps are within this of the highlight's first
// clip are the same highlight. Same rule and value as clusterHighlights()
// in web-player/index.html; keep them together.
const HIGHLIGHT_GAP_MS = 5000;

const OUT_FPS = 30;

// Refuse new renders below this much free space. A full disk does not just
// fail one export — it stops SQLite writing, stops uploads landing, and
// takes the API down with it. Failing one export loudly is the cheap outcome.
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;  // 3GB

// ================================
// SCRATCH HYGIENE
//
// The old cleaner iterated compositeJobs — an IN-MEMORY Map. Every restart
// emptied it, so any file it had been tracking became invisible to the only
// code that would ever delete it. Combined with cleanup that ran solely in
// ffmpeg's 'close' handler, a crashed render orphaned every clip it had
// downloaded, permanently. That is how 18GB accumulated in this directory
// and took the whole box down with a full disk.
//
//   - On boot, everything here is dead by definition. No job can be running
//     in a process that has only just started, so it all goes.
//   - On a timer, decide by FILE AGE. A running job's own files are left
//     alone whatever their age (a long export keeps its early segments for
//     the final join); every file name carries its job id.
//
// Deleting an output while someone is downloading it is safe: res.download
// holds an open file descriptor, and unlinking a file with an open handle
// keeps the bytes readable until that transfer finishes. The directory entry
// goes; the in-flight download does not break.
// ================================
const SRC_MAX_AGE_MS = 30 * 60 * 1000;
const OUTPUT_MAX_AGE_MS = 60 * 60 * 1000;  // the retention this already promised
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function sweepScratch(opts = {}) {
  const all = opts.all === true;
  let removed = 0;
  let bytes = 0;

  let names;
  try { names = fs.readdirSync(COMPOSITE_DIR); }
  catch (e) { return { removed, bytes }; }

  const running = [];
  for (const [jobId, job] of compositeJobs) {
    if (job.status === 'processing') running.push(jobId);
  }

  const now = Date.now();
  for (const name of names) {
    if (!all && running.some(id => name.includes(id))) continue;
    const full = path.join(COMPOSITE_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;

    // Sources, tiles, segments and subtitle files are only needed while a
    // render runs. Outputs are needed until the user downloads them.
    const isSource = name.startsWith('src_') || name.startsWith('comments_');
    const maxAge = isSource ? SRC_MAX_AGE_MS : OUTPUT_MAX_AGE_MS;

    if (all || (now - st.mtimeMs) > maxAge) {
      try { fs.unlinkSync(full); removed++; bytes += st.size; } catch (e) {}
    }
  }
  return { removed, bytes };
}

// ================================
// CLIP SYNC DATA
// A clip's start time and moment live in its metadata JSON. Local copy
// first (dev, or a clip whose R2 push hasn't finished), then the R2 copy via
// metadataUrl — uploadToSpaces (spaces.js) deletes the local file once it's
// safely in R2, which is every clip in production. The fetch goes through
// downloadToFile, so it gets the same idle/total timeouts and redirect cap
// as the video pulls, and a stalled CDN can't hang the job. The temp file is
// named src_* so the scratch sweeper treats it as a render input if anything
// goes wrong. Returns the raw JSON text, or null.
// ================================
const META_MAX_BYTES = 256 * 1024;   // real sidecars are a few KB

async function readClipMetadata(upload, sessionDir, jobId) {
  if (upload.metadataFile) {
    const metaPath = path.join(sessionDir, upload.metadataFile);
    if (fs.existsSync(metaPath)) return fs.readFileSync(metaPath, 'utf8');
  }
  if (!upload.metadataUrl) return null;

  const tmp = path.join(COMPOSITE_DIR, `src_meta_${jobId}_${upload.id}.json`);
  try {
    await downloadToFile(upload.metadataUrl, tmp, { idleMs: 10000, totalMs: 15000 });
    const st = fs.statSync(tmp);
    if (st.size > META_MAX_BYTES) {
      log('warn', 'composite_meta_too_large', { jobId, uploadId: upload.id, bytes: st.size });
      return null;
    }
    return fs.readFileSync(tmp, 'utf8');
  } catch (e) {
    log('warn', 'composite_meta_fetch_failed', { jobId, uploadId: upload.id, error: e.message });
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// Free bytes on the volume holding the scratch directory. statfsSync landed
// in Node 18.15 — on anything older we return null and the caller skips the
// check rather than guessing.
function freeBytes(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const st = fs.statfsSync(dir);
    return st.bavail * st.bsize;
  } catch (e) {
    return null;
  }
}

function startCompositeCleanup() {
  const boot = sweepScratch({ all: true });
  if (boot.removed > 0) {
    log('info', 'composite_boot_sweep', {
      files: boot.removed, mb: (boot.bytes / 1024 / 1024).toFixed(1)
    });
  }

  setInterval(() => {
    const swept = sweepScratch();
    if (swept.removed > 0) {
      log('info', 'composite_sweep', {
        files: swept.removed, mb: (swept.bytes / 1024 / 1024).toFixed(1)
      });
    }
    const now = Date.now();
    for (const [jobId, job] of compositeJobs) {
      if (job.status !== 'processing' && now - job.createdAt > OUTPUT_MAX_AGE_MS) compositeJobs.delete(jobId);
    }
  }, SWEEP_INTERVAL_MS);
}

// --- Job state helpers. Nothing else touches a job record directly, so
// there is exactly one place where a status can change. ---

function patchJob(jobId, patch) {
  const job = compositeJobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

// A job that was cancelled, timed out or cleaned up is no longer live; the
// render loop checks this between steps and stops quietly. Also where a
// job that has run past its deadline is failed.
function isLive(jobId) {
  const job = compositeJobs.get(jobId);
  if (job && job.status === 'processing' && job.deadlineAt && Date.now() > job.deadlineAt) {
    failJob(jobId, 'timeout_job', 'Export took too long and was stopped. Try fewer clips.');
  }
  return !!job && job.status === 'processing';
}

// First terminal status wins: a cancel isn't overwritten by the "ffmpeg
// exited" failure its own kill causes.
function failJob(jobId, errorCode, message) {
  const existing = compositeJobs.get(jobId);
  if (existing && existing.status !== 'processing') return existing;
  const job = patchJob(jobId, {
    status: 'failed',
    phase: 'done',
    errorCode,
    pid: null,
    progress: message || 'Compositing failed'
  });
  log('warn', 'composite_failed', { jobId, errorCode, message: message || null });
  return job;
}

// Bounded-concurrency map.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ================================
// LAYOUT
// Every export is 16:9. The canvas is 1280x720 while no grid needs more
// than 2 columns, 1920x1080 otherwise, so a tile is never under 640x360.
// Tiles are 16:9 too; a clip of another shape is fitted inside its tile
// with black bars. A grid that doesn't fill the canvas (2 POVs, 5-6 POVs)
// is centred, and a short last row is centred under the rows above it.
// ================================
function getGridDimensions(count) {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

function canvasFor(maxPovs) {
  return maxPovs <= 4 ? { w: 1280, h: 720 } : { w: 1920, h: 1080 };
}

// -> { cols, tileW, tileH, slots: [{ x, y }] } for `count` POVs on the
// canvas. Passing `cols` keeps a planned grid's tile size while placing a
// different number of tiles (see the render: a clip that can't be read
// leaves no hole, the rest close up around it).
function gridLayout(count, canvas, cols) {
  if (!cols) cols = getGridDimensions(count).cols;
  const rows = Math.ceil(count / cols);
  const tileW = canvas.w / cols;
  const tileH = tileW * 9 / 16;
  const top = Math.round((canvas.h - rows * tileH) / 2);
  const slots = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, count - row * cols);
    const left = Math.round((canvas.w - inRow * tileW) / 2);
    slots.push({ x: left + (i % cols) * tileW, y: top + row * tileH });
  }
  return { cols, tileW, tileH, slots };
}

// ================================
// GROUPING
// clips: [{ upload, momentTs, startTimeUTC, durationSec }] -> an array of
// grids, oldest highlight first, each an array of clips in upload order.
// Same clustering as the web player's clusterHighlights(), so a grid here
// is exactly a highlight there. A clip with no timestamp at all (momentTs
// 0) lands in one leading group, as it does in the player.
// ================================
function groupIntoGrids(clips) {
  const sorted = clips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.momentTs - b.c.momentTs) || (a.i - b.i))
    .map(e => e.c);

  const highlights = [];
  let current = null;
  for (const c of sorted) {
    if (!current || c.momentTs - current.timestamp > HIGHLIGHT_GAP_MS) {
      current = { timestamp: c.momentTs, clips: [c] };
      highlights.push(current);
    } else {
      current.clips.push(c);
    }
  }

  const grids = [];
  for (const h of highlights) {
    for (let i = 0; i < h.clips.length; i += MAX_POVS_PER_GRID) {
      grids.push(h.clips.slice(i, i + MAX_POVS_PER_GRID));
    }
  }
  return grids;
}

// ================================
// FFMPEG / FFPROBE
// ================================

// Runs one ffmpeg to completion under the hard cap, the idle guard and the
// job's own deadline. Resolves { ok, code }; never rejects, never hangs.
// onSeconds(sec) reports how much output has been written.
function runFfmpeg(jobId, args, onSeconds) {
  return new Promise((resolve) => {
    let finished = false;
    let lastProgressAt = Date.now();
    let hardTimer = null;
    let idleTimer = null;

    // -nostdin + stdin ignored: an open stdin is a classic never-exits hang.
    // stdout carries -progress output; stderr real errors only.
    const ffmpeg = spawn('ffmpeg',
      ['-nostdin', '-hide_banner', '-loglevel', 'error'].concat(args, ['-progress', 'pipe:1']),
      { stdio: ['ignore', 'pipe', 'pipe'] });

    patchJob(jobId, { pid: ffmpeg.pid });

    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearInterval(idleTimer);
      patchJob(jobId, { pid: null });
      resolve(result);
    };

    const kill = (errorCode, message) => {
      if (finished) return;
      failJob(jobId, errorCode, message);
      try { ffmpeg.kill('SIGKILL'); } catch (e) {}
    };

    hardTimer = setTimeout(
      () => kill('timeout_hard', 'Render exceeded the time limit and was stopped'),
      ENCODE_HARD_CAP_MS
    );

    idleTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > ENCODE_IDLE_MS) {
        kill('timeout_idle', 'Render stopped responding and was stopped');
      } else if (!isLive(jobId)) {
        try { ffmpeg.kill('SIGKILL'); } catch (e) {}   // cancelled, or past the job deadline
      }
    }, PROGRESS_POLL_MS);

    // -progress emits key=value lines; out_time_ms is microseconds despite
    // the name (an old ffmpeg wart), so divide by 1e6 for seconds.
    let stdoutBuf = '';
    ffmpeg.stdout.on('data', d => {
      lastProgressAt = Date.now();
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const [key, value] = line.trim().split('=');
        if (key === 'out_time_ms' && onSeconds) {
          const doneSec = Number(value) / 1e6;
          if (Number.isFinite(doneSec) && doneSec >= 0) onSeconds(doneSec);
        }
      }
    });

    ffmpeg.stderr.on('data', d => {
      lastProgressAt = Date.now();
      const line = d.toString().trim();
      if (line) log('warn', 'composite_ffmpeg_stderr', { jobId, line: line.slice(0, 500) });
    });

    ffmpeg.on('close', (code) => finish({ ok: code === 0, code }));
    ffmpeg.on('error', (err) => {
      log('warn', 'composite_ffmpeg_spawn_failed', { jobId, error: err.message });
      finish({ ok: false, code: 'spawn' });
    });
  });
}

// -> { durationSec, hasAudio } for a media file, or null if it can't be read.
function probeMedia(filePath) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const end = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let p;
    try {
      p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { resolve(null); return; }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} end(null); }, 20000);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => end(null));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const durationSec = Number(j.format && j.format.duration);
        const streams = Array.isArray(j.streams) ? j.streams : [];
        if (!streams.some(s => s.codec_type === 'video')) return end(null);
        end({
          durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
          hasAudio: streams.some(s => s.codec_type === 'audio')
        });
      } catch (e) { end(null); }
    });
  });
}

// ================================
// THE RENDER
// ================================
async function runComposite(uploads, code, outputPath, jobId, includeComments) {
  const sessionDir = path.join(UPLOADS_DIR, code);
  const scratch = new Set();   // every temp file this job makes
  const tmp = (name) => {
    const p = path.join(COMPOSITE_DIR, name);
    scratch.add(p);
    return p;
  };
  const drop = (p) => { scratch.delete(p); try { fs.unlinkSync(p); } catch (e) {} };

  try {
    patchJob(jobId, { phase: 'preparing', progress: 'Reading clips…', pct: 0 });

    // --- 1. Sync data for every clip, then group into highlights. ---
    const usable = uploads.filter(u => u.videoFile);   // pending deferred uploads have no video yet
    const clips = await mapLimit(usable, META_CONCURRENCY, async (upload) => {
      let meta = null;
      if (upload.metadataFile || upload.metadataUrl) {
        try {
          const raw = await readClipMetadata(upload, sessionDir, jobId);
          if (raw) meta = JSON.parse(raw);
        } catch (e) {}
      }
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0;
      const startTimeUTC = meta ? num(meta.startTimeUTC) : 0;
      if (!startTimeUTC) {
        log('warn', 'composite_no_sync_data', { jobId, uploadId: upload.id, username: upload.username });
      }
      return {
        upload,
        startTimeUTC,
        // The moment this clip belongs to: what the web player clusters on.
        momentTs: (meta && (num(meta.coordinated_timestamp) || num(meta.saveTimeUTC))) ||
          num(upload.coordinatedTimestamp),
        durationSec: num(upload.durationMs) / 1000 || (meta ? num(meta.durationMs) / 1000 : 0)
      };
    });
    if (!isLive(jobId)) return;

    if (clips.length === 0) {
      failJob(jobId, 'no_clips', 'None of those clips have finished uploading yet');
      return;
    }

    const grids = groupIntoGrids(clips);
    const canvas = canvasFor(Math.max(...grids.map(g => g.length)));
    const totalClips = clips.length;

    // Progress: every clip is shrunk once (its length), every grid stacked
    // once (about its length again, but on small tiles: weighted lighter).
    const STACK_WEIGHT = 0.6;
    const estGridSec = (g) => Math.max(...g.map(c => c.durationSec || 30));
    const workTotal = clips.reduce((n, c) => n + (c.durationSec || 30), 0) +
      grids.reduce((n, g) => n + estGridSec(g) * STACK_WEIGHT, 0);
    let workDone = 0;
    const report = (text, partial) => {
      const pct = Math.max(0, Math.min(99, Math.round(((workDone + (partial || 0)) / workTotal) * 100)));
      patchJob(jobId, { pct, progress: `${text} ${pct}%` });
    };

    const canAss = includeComments ? await checkAssFilter() : false;
    if (includeComments && !canAss) log('warn', 'composite_no_libass', { jobId });
    const comments = canAss ? getCommentsForSession(code) : [];

    log('info', 'composite_plan', {
      jobId, clips: totalClips, grids: grids.length,
      sizes: grids.map(g => g.length).join(','), canvas: `${canvas.w}x${canvas.h}`
    });

    const segments = [];   // finished grid videos, in play order
    let clipNo = 0;

    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g];
      const layout = gridLayout(grid.length, canvas);
      const tiles = [];    // { clip, path, durationSec, hasAudio }, then slot + offsetSec

      // --- 2. Shrink each clip of this highlight to its tile. ---
      patchJob(jobId, { phase: 'preparing' });
      for (let i = 0; i < grid.length; i++) {
        const clip = grid[i];
        const upload = clip.upload;
        const clipWork = clip.durationSec || 30;
        clipNo++;
        if (!isLive(jobId)) return;
        report(`Preparing clip ${clipNo} of ${totalClips}…`);

        let srcPath = path.join(sessionDir, upload.videoFile);
        let downloaded = null;
        if (!fs.existsSync(srcPath)) {
          if (!upload.videoUrl) { workDone += clipWork; continue; }
          downloaded = tmp(`src_${jobId}_dl_${g}_${i}.mp4`);
          try {
            await downloadToFile(upload.videoUrl, downloaded, {
              idleMs: DOWNLOAD_IDLE_MS, totalMs: DOWNLOAD_TOTAL_MS
            });
          } catch (e) {
            log('warn', 'composite_download_failed', { jobId, file: upload.videoFile, error: e.message });
            drop(downloaded);
            workDone += clipWork;
            continue;
          }
          srcPath = downloaded;
        }
        if (!isLive(jobId)) return;

        const tilePath = tmp(`src_${jobId}_tile_${g}_${i}.mp4`);
        const { tileW, tileH } = layout;
        const shrink = await runFfmpeg(jobId, [
          '-i', srcPath,
          '-map', '0:v:0', '-map', '0:a:0?',
          // fps first: a 60 fps clip drops to 30 before the (costly) resize.
          '-vf', `fps=${OUT_FPS},scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=bilinear,` +
                 `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
          '-y', tilePath
        ], (sec) => report(`Preparing clip ${clipNo} of ${totalClips}…`, Math.min(sec, clipWork)));
        if (downloaded) drop(downloaded);
        workDone += clipWork;
        if (!isLive(jobId)) return;

        const info = shrink.ok ? await probeMedia(tilePath) : null;
        if (!info || !info.durationSec) {
          // One unreadable clip costs its own tile, not the whole export.
          log('warn', 'composite_clip_skipped', {
            jobId, uploadId: upload.id, username: upload.username, code: shrink.code
          });
          drop(tilePath);
          continue;
        }
        tiles.push({ clip, path: tilePath, durationSec: info.durationSec, hasAudio: info.hasAudio });
      }

      if (tiles.length === 0) {
        log('warn', 'composite_grid_empty', { jobId, grid: g + 1 });
        workDone += estGridSec(grid) * STACK_WEIGHT;
        continue;
      }

      // --- 3. Stack this highlight's tiles, lined up on the moment. ---
      // Placed now, not before: tiles keep their planned size, and the ones
      // that made it fill the grid in order with no gap.
      const placed = gridLayout(tiles.length, canvas, layout.cols);
      tiles.forEach((t, i) => { t.slot = placed.slots[i]; });
      const timed = tiles.filter(t => t.clip.startTimeUTC);
      const earliest = timed.length ? Math.min(...timed.map(t => t.clip.startTimeUTC)) : 0;
      tiles.forEach(t => {
        t.offsetSec = t.clip.startTimeUTC ? (t.clip.startTimeUTC - earliest) / 1000 : 0;
      });
      const gridSec = Math.max(...tiles.map(t => t.offsetSec + t.durationSec));
      const gridDur = gridSec.toFixed(3);

      let assPath = null;
      if (comments.length > 0) {
        const tileMap = {};
        tiles.forEach(t => {
          tileMap[t.clip.upload.id] = {
            x: t.slot.x, y: t.slot.y, w: layout.tileW, h: layout.tileH, offsetSec: t.offsetSec
          };
        });
        const result = generateASS(comments, tileMap, canvas.w, canvas.h);
        if (result.count > 0) {
          assPath = tmp(`comments_${jobId}_${g}.ass`);
          fs.writeFileSync(assPath, result.ass, 'utf8');
          log('info', 'composite_comments_overlay', { jobId, grid: g + 1, comments: result.count });
        }
      }

      const args = [];
      tiles.forEach(t => {
        if (t.offsetSec > 0) args.push('-itsoffset', t.offsetSec.toFixed(3));
        args.push('-i', t.path);
      });
      // The canvas: black, exactly as long as this highlight. A tile shows
      // from its own start to its own end and is black outside that.
      const base = tiles.length;
      args.push('-f', 'lavfi', '-i', `color=c=black:s=${canvas.w}x${canvas.h}:r=${OUT_FPS}:d=${gridDur}`);

      let filter = '';
      let last = `[${base}:v]`;
      tiles.forEach((t, i) => {
        filter += `${last}[${i}:v]overlay=${t.slot.x}:${t.slot.y}:eof_action=pass[b${i}];`;
        last = `[b${i}]`;
      });
      filter += `${last}${assPath ? `ass=${escapeFilterPath(assPath)},` : ''}format=yuv420p[out]`;

      // first_pts=0 pads each POV's sound with silence up to its start, so
      // the mix stays lined up with the pictures.
      const voiced = tiles.map((t, i) => (t.hasAudio ? i : -1)).filter(i => i >= 0);
      if (voiced.length === 0) {
        args.push('-f', 'lavfi', '-t', gridDur, '-i', 'anullsrc=r=48000:cl=stereo');
        filter += `;[${base + 1}:a]anull[aout]`;
      } else {
        voiced.forEach(i => { filter += `;[${i}:a]aresample=48000:async=1:first_pts=0[a${i}]`; });
        const refs = voiced.map(i => `[a${i}]`).join('');
        // whole_dur, not a bare apad: endless padding after amix never lets
        // ffmpeg finish (it stalled the first test render here).
        filter += voiced.length === 1
          ? `;${refs}apad=whole_dur=${gridDur}[aout]`
          : `;${refs}amix=inputs=${voiced.length}:duration=longest:normalize=0,apad=whole_dur=${gridDur}[aout]`;
      }

      const segPath = tmp(`src_${jobId}_seg_${g}.mp4`);
      args.push(
        '-filter_complex', filter,
        '-map', '[out]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', String(OUT_FPS), '-threads', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-t', gridDur,
        '-movflags', '+faststart',
        '-y', segPath
      );

      const label = grids.length > 1 ? `Stitching highlight ${g + 1} of ${grids.length}…` : 'Stitching…';
      patchJob(jobId, { phase: 'encoding' });
      report(label);
      const gridWork = estGridSec(grid) * STACK_WEIGHT;
      const stack = await runFfmpeg(jobId, args,
        (sec) => report(label, Math.min(1, sec / gridSec) * gridWork));
      workDone += gridWork;

      tiles.forEach(t => drop(t.path));
      if (assPath) drop(assPath);
      if (!isLive(jobId)) return;
      if (!stack.ok || !fs.existsSync(segPath)) {
        failJob(jobId, 'ffmpeg_exit_' + stack.code, 'Compositing failed — try again');
        return;
      }
      segments.push(segPath);
    }

    if (segments.length === 0) {
      failJob(jobId, 'no_clips', 'No clips could be fetched for this export');
      return;
    }

    // --- 4. Join the highlights in order. Same encoder settings and frame
    // size in every segment, so this is a copy, not another encode. ---
    if (segments.length === 1) {
      fs.renameSync(segments[0], outputPath);
      scratch.delete(segments[0]);
    } else {
      patchJob(jobId, { phase: 'encoding', progress: 'Joining highlights… 99%', pct: 99 });
      const listPath = tmp(`src_${jobId}_list.txt`);
      fs.writeFileSync(listPath, segments.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n') + '\n', 'utf8');
      const joined = await runFfmpeg(jobId, [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-movflags', '+faststart',
        '-y', outputPath
      ]);
      if (!isLive(jobId)) return;
      if (!joined.ok || !fs.existsSync(outputPath)) {
        failJob(jobId, 'ffmpeg_exit_' + joined.code, 'Compositing failed — try again');
        return;
      }
    }

    const fileSize = fs.statSync(outputPath).size;
    patchJob(jobId, { status: 'done', phase: 'done', pct: 100, progress: 'Ready', fileSize, pid: null });
    log('info', 'composite_done', {
      jobId, grids: segments.length, sizeMB: (fileSize / 1024 / 1024).toFixed(1)
    });
  } finally {
    // Whatever happened, this job's temp files go now. A job that didn't
    // finish doesn't keep a half-written output either.
    for (const p of scratch) { try { fs.unlinkSync(p); } catch (e) {} }
    const job = compositeJobs.get(jobId);
    if (!job || job.status !== 'done') { try { fs.unlinkSync(outputPath); } catch (e) {} }
  }
}

// --- Routes ---
function initCompositeRoutes(app) {
  app.post('/sessions/:code/composite', requireAuth, requireTier(EXPORT_TIERS), (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!access.canView(req, session)) return res.status(403).json({ error: access.MEMBERS_ONLY_MSG });
    if (session.uploads.length === 0) return res.status(400).json({ error: 'No uploads yet' });

    // Which clips? The client sends the uploadIds marked with + (or, with
    // nothing marked, the highlight on screen). Older clients send nothing —
    // for those, fall back to the whole session, under the same limits.
    const body = req.body || {};
    let selected;

    if (Array.isArray(body.uploadIds) && body.uploadIds.length > 0) {
      const wanted = new Set(body.uploadIds.map(String));
      selected = session.uploads.filter(u => wanted.has(String(u.id)));
      if (selected.length === 0) {
        return res.status(400).json({ error: 'None of those clips are in this session' });
      }
    } else {
      selected = session.uploads;
    }

    if (selected.length > MAX_COMPOSITE_CLIPS) {
      return res.status(400).json({
        error: `Combined View supports up to ${MAX_COMPOSITE_CLIPS} clips in one export ` +
               `(you selected ${selected.length}). Pick fewer highlights, or use an AI Reel for a whole session.`
      });
    }

    const totalSec = selected.reduce((n, u) =>
      n + (typeof u.durationMs === 'number' && u.durationMs > 0 ? u.durationMs / 1000 : 0), 0);
    if (totalSec > MAX_TOTAL_CLIP_SEC) {
      return res.status(400).json({
        error: `Combined View supports up to ${Math.round(MAX_TOTAL_CLIP_SEC / 60)} minutes of clips in one export ` +
               `(you selected about ${Math.ceil(totalSec / 60)}). Pick fewer highlights, or use an AI Reel for a whole session.`
      });
    }

    // Disk guard. Sweep first — the space may already be reclaimable — and
    // only refuse if it is still short afterwards.
    const free = freeBytes(COMPOSITE_DIR);
    if (free !== null && free < MIN_FREE_BYTES) {
      const reclaimed = sweepScratch();
      const after = freeBytes(COMPOSITE_DIR);
      log('warn', 'composite_low_disk', {
        freeMB: Math.round(free / 1048576),
        reclaimedMB: Math.round(reclaimed.bytes / 1048576),
        afterMB: after === null ? null : Math.round(after / 1048576)
      });
      if (after !== null && after < MIN_FREE_BYTES) {
        return res.status(507).json({
          error: 'The server is low on disk space right now — try again in a few minutes.'
        });
      }
    }

    // Default: include comments. Only false when client explicitly opts out.
    const includeComments = !(body.includeComments === false);

    const jobId = uuidv4();
    const outputPath = path.join(COMPOSITE_DIR, `composite_${jobId}.mp4`);

    compositeJobs.set(jobId, {
      status: 'processing',
      phase: 'starting',
      pct: 0,
      progress: 'Queued…',
      errorCode: null,
      pid: null,
      outputPath,
      owner: req.user && req.user.username ? req.user.username : null,
      clipCount: selected.length,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deadlineAt: Date.now() + JOB_HARD_CAP_MS
    });

    log('info', 'composite_started', { jobId, code, clips: selected.length });
    res.status(202).json({ jobId, clipCount: selected.length });

    // Never a floating promise: any throw still ends in a terminal status.
    runComposite(selected, code, outputPath, jobId, includeComments)
      .catch((err) => {
        log('error', 'composite_crashed', { jobId, error: err && err.message });
        failJob(jobId, 'internal_error', 'Compositing failed — try again');
      });
  });

  app.get('/sessions/:code/composite/:jobId', (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    // 404 is an expected terminal answer the client must handle (job
    // expired, or server restarted), not a state it can poll its way out of.
    if (!job) return res.status(404).json({ error: 'Job not found', status: 'lost' });

    res.json({
      status: job.status,
      phase: job.phase,
      pct: job.pct,
      progress: job.progress,
      errorCode: job.errorCode,
      downloadUrl: job.status === 'done' ? `/composite/${req.params.jobId}/download` : null,
      fileSize: job.fileSize || null
    });
  });

  // Cancel — kills the render instead of making the user wait it out.
  app.delete('/sessions/:code/composite/:jobId', requireAuth, (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.owner && req.user && job.owner !== req.user.username) {
      return res.status(403).json({ error: 'Not your job' });
    }
    if (job.status !== 'processing') {
      return res.json({ status: job.status, message: 'Already finished' });
    }
    const pid = job.pid;
    // Status first: the render loop sees the job is no longer live and
    // stops before starting its next step.
    patchJob(req.params.jobId, {
      status: 'failed', phase: 'done', errorCode: 'cancelled', progress: 'Cancelled'
    });
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (e) {} }
    log('info', 'composite_cancelled', { jobId: req.params.jobId });
    res.json({ status: 'cancelled' });
  });

  app.get('/composite/:jobId/download', requireAuthAny, requireTier(EXPORT_TIERS), (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });

    res.download(job.outputPath, 'peak-abu-composite.mp4', (err) => {
      if (!err) {
        setTimeout(() => {
          if (fs.existsSync(job.outputPath)) {
            try { fs.unlinkSync(job.outputPath); } catch (e) {}
          }
          compositeJobs.delete(req.params.jobId);
        }, 60000);
      }
    });
  });
}

module.exports = { initCompositeRoutes, startCompositeCleanup };
