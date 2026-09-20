// ================================
// COMPOSITE — server-side multi-POV grid rendering (FFmpeg xstack)
// plus the three HTTP endpoints that drive it.
//
// v2: optional comment overlay via ASS subtitles when includeComments
// is true (the default). Requires libass in FFmpeg.
//
// v3 (Stage 1a): the job can no longer get stuck in 'processing'.
// Every path out of runComposite() now writes a terminal status. See
// FAILURE MODES below for what was actually wrong.
//
// FAILURE MODES THIS FIXES
// ------------------------
// 1. runComposite() was called as a floating promise with no .catch().
//    Anything that threw before the ffmpeg Promise — a download error, a
//    missing job record, checkAssFilter(), the ASS writeFileSync — became
//    an unhandled rejection and left status === 'processing' FOREVER,
//    with no ffmpeg process running at all. This is the "stitching for 15
//    minutes" case where nothing is actually stitching.
// 2. compositeJobs.get(jobId).status = 'failed' (old line 93) threw if
//    the job had already been cleaned up — turning a handled failure into
//    cause #1.
// 3. downloadToFile() had no timeout and ran serially per clip. A stalled
//    CDN socket blocked the whole job before ffmpeg was spawned. Now
//    bounded (see utils.js) and run with bounded concurrency.
// 4. spawn() used default stdio, handing ffmpeg an open stdin it reads
//    for interactive commands — a classic never-exits hang. Now -nostdin
//    with stdin explicitly ignored.
// 5. No watchdog. A genuinely hung ffmpeg ran until the heat death of the
//    droplet. Now a hard wall-clock cap plus an idle-progress guard.
// 6. No real progress. The client could not distinguish "slow" from
//    "hung", and neither could the logs. Now -progress pipe:1 is parsed
//    into a true percentage against known clip durations.
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
const DOWNLOAD_CONCURRENCY = 3;           // parallel CDN pulls
const ENCODE_HARD_CAP_MS = 15 * 60 * 1000;// absolute ceiling on one ffmpeg run
const ENCODE_IDLE_MS = 90 * 1000;         // no progress line for this long => hung
const PROGRESS_POLL_MS = 15 * 1000;       // how often the idle guard checks

// THE BIG ONE. This route used to composite session.uploads — EVERY clip in
// the session — while the button that calls it is labelled with the current
// highlight's POV count. A session with 88 uploads therefore built a
// 4x22 grid: a 2560x7920 canvas, 88 simultaneous ffmpeg inputs, an 88-input
// xstack and an 88-input amix. That OOMs the box, which is why the symptom
// was a 502 and a job that never finished — the process was dying, not
// stitching. A combined view is one synced moment, not a whole session.
const MAX_COMPOSITE_CLIPS = 9;            // 3x3 => 1920x1080 canvas ceiling

function startCompositeCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of compositeJobs) {
      if (now - job.createdAt > 3600000) {
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          try { fs.unlinkSync(job.outputPath); } catch (e) {}
        }
        if (job.assPath && fs.existsSync(job.assPath)) {
          try { fs.unlinkSync(job.assPath); } catch (e) {}
        }
        compositeJobs.delete(jobId);
      }
    }
  }, 3600000);
}

// --- Job state helpers. Nothing else touches a job record directly, so
// there is exactly one place where a status can change. ---

function patchJob(jobId, patch) {
  const job = compositeJobs.get(jobId);
  if (!job) return null;                      // fix for failure mode #2
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

function failJob(jobId, errorCode, message) {
  const job = patchJob(jobId, {
    status: 'failed',
    phase: 'done',
    errorCode,
    progress: message || 'Compositing failed'
  });
  log('warn', 'composite_failed', { jobId, errorCode, message: message || null });
  return job;
}

function getGridDimensions(count) {
  if (count === 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

// Bounded-concurrency map. Serial downloads were a large part of why two
// clips could take many minutes; three at a time saturates the droplet's
// downlink without thrashing it.
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

async function runComposite(uploads, code, outputPath, jobId, includeComments) {
  const sessionDir = path.join(UPLOADS_DIR, code);

  patchJob(jobId, { phase: 'downloading', progress: 'Fetching clips…', pct: 0 });

  const tempDownloads = [];

  // Resolve every clip to a local path first, in parallel. A clip that
  // cannot be fetched is skipped, exactly as before — but a stalled fetch
  // now fails fast instead of hanging the job.
  const resolved = await mapLimit(uploads, DOWNLOAD_CONCURRENCY, async (upload) => {
    const localPath = path.join(sessionDir, upload.videoFile);
    if (fs.existsSync(localPath)) return { upload, videoPath: localPath };

    if (!upload.videoUrl) return null;

    const tempPath = path.join(COMPOSITE_DIR, `src_${jobId}_${upload.videoFile}`);
    try {
      await downloadToFile(upload.videoUrl, tempPath, {
        idleMs: DOWNLOAD_IDLE_MS,
        totalMs: DOWNLOAD_TOTAL_MS
      });
      tempDownloads.push(tempPath);
      return { upload, videoPath: tempPath };
    } catch (e) {
      log('warn', 'composite_download_failed', {
        jobId, file: upload.videoFile, error: e.message
      });
      return null;
    }
  });

  const cleanupTemps = () => {
    tempDownloads.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
  };

  // Read metadata for sync offsets.
  const clipData = [];
  let earliestStart = Infinity;

  for (const entry of resolved) {
    if (!entry) continue;
    const { upload, videoPath } = entry;

    let startTimeUTC = null;
    if (upload.metadataFile) {
      try {
        const metaPath = path.join(sessionDir, upload.metadataFile);
        const metaRaw = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : null;
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          startTimeUTC = meta.startTimeUTC || null;
          if (startTimeUTC) earliestStart = Math.min(earliestStart, startTimeUTC);
        }
      } catch (e) {}
    }

    clipData.push({
      videoPath,
      startTimeUTC,
      username: upload.username,
      uploadId: upload.id,
      durationSec: upload.durationMs ? upload.durationMs / 1000 : 0
    });
  }

  if (clipData.length === 0) {
    cleanupTemps();
    failJob(jobId, 'no_clips', 'No clips could be fetched for this session');
    return;
  }

  clipData.forEach(c => {
    c.offsetSec = (earliestStart !== Infinity && c.startTimeUTC)
      ? (c.startTimeUTC - earliestStart) / 1000
      : 0;
  });

  // Expected output length, used to turn ffmpeg's out_time into a real
  // percentage. Zero when durations are unknown — pct then stays null
  // rather than lying.
  const totalDurationSec = clipData.reduce(
    (max, c) => Math.max(max, (c.offsetSec || 0) + (c.durationSec || 0)), 0
  );

  const count = clipData.length;
  const { cols, rows } = getGridDimensions(count);
  const cellW = 640;
  const cellH = 360;
  const canvasW = cols * cellW;
  const canvasH = rows * cellH;

  // --- Comment overlay (ASS subtitle file) ---
  let assPath = null;
  if (includeComments) {
    const canAss = await checkAssFilter();
    if (canAss) {
      const comments = getCommentsForSession(code);
      if (comments.length > 0) {
        const tileMap = {};
        clipData.forEach((c, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          tileMap[c.uploadId] = {
            x: col * cellW, y: row * cellH,
            w: cellW, h: cellH,
            offsetSec: c.offsetSec
          };
        });
        const result = generateASS(comments, tileMap, canvasW, canvasH);
        if (result.count > 0) {
          assPath = path.join(COMPOSITE_DIR, `comments_${jobId}.ass`);
          fs.writeFileSync(assPath, result.ass, 'utf8');
          log('info', 'composite_comments_overlay', { jobId, comments: result.count });
        }
      }
    } else {
      log('warn', 'composite_no_libass', { jobId });
    }
  }

  patchJob(jobId, { assPath, phase: 'encoding', progress: 'Stitching…', pct: 0 });

  const ffmpegArgs = [
    // Failure mode #4: without this ffmpeg keeps reading stdin for
    // interactive keys and can sit there indefinitely.
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error'
  ];

  clipData.forEach(c => {
    if (c.offsetSec > 0) ffmpegArgs.push('-itsoffset', String(c.offsetSec.toFixed(3)));
    ffmpegArgs.push('-i', c.videoPath);
  });

  let filterComplex = '';

  clipData.forEach((_, i) => {
    filterComplex += `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[v${i}];`;
  });

  // Video label before optional ASS pass
  const preLabel = assPath ? '[xraw]' : '[out]';

  if (count === 1) {
    // 'null' instead of 'copy' so ASS can chain onto it (copy is bitstream, not filterable)
    filterComplex += `[v0]null${preLabel}`;
  } else {
    const layoutPositions = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r * cols + c >= count) break;
        layoutPositions.push(`${c * cellW}_${r * cellH}`);
      }
    }
    const scaledRefs = clipData.map((_, i) => `[v${i}]`).join('');
    filterComplex += `${scaledRefs}xstack=inputs=${count}:layout=${layoutPositions.join('|')}${preLabel}`;
  }

  if (assPath) {
    filterComplex += `;[xraw]ass=${escapeFilterPath(assPath)}[out]`;
  }

  const audioRefs = clipData.map((_, i) => `[${i}:a]`).join('');
  filterComplex += `;${audioRefs}amix=inputs=${count}:duration=longest:normalize=0[aout]`;

  ffmpegArgs.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-threads', '0',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-progress', 'pipe:1',   // machine-readable progress on stdout
    '-y',
    outputPath
  );

  return new Promise((resolve) => {
    let finished = false;
    let lastProgressAt = Date.now();
    let hardTimer = null;
    let idleTimer = null;

    // stdin explicitly ignored (belt to -nostdin's braces); stdout carries
    // -progress output; stderr carries real errors only at -loglevel error.
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    patchJob(jobId, { pid: ffmpeg.pid });

    const clearTimers = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearInterval(idleTimer);
    };

    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearTimers();
      cleanupTemps();
      if (assPath) { try { fs.unlinkSync(assPath); } catch (e) {} }
      fn();
      resolve();
    };

    const kill = (errorCode, message) => {
      if (finished) return;
      try { ffmpeg.kill('SIGKILL'); } catch (e) {}
      finish(() => failJob(jobId, errorCode, message));
    };

    hardTimer = setTimeout(
      () => kill('timeout_hard', 'Render exceeded the time limit and was stopped'),
      ENCODE_HARD_CAP_MS
    );

    idleTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > ENCODE_IDLE_MS) {
        kill('timeout_idle', 'Render stopped responding and was stopped');
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
        if (key === 'out_time_ms' && totalDurationSec > 0) {
          const doneSec = Number(value) / 1e6;
          if (Number.isFinite(doneSec)) {
            const pct = Math.max(0, Math.min(99, Math.round((doneSec / totalDurationSec) * 100)));
            patchJob(jobId, { pct, progress: `Stitching… ${pct}%` });
          }
        }
      }
    });

    ffmpeg.stderr.on('data', d => {
      lastProgressAt = Date.now();
      const line = d.toString().trim();
      if (line) log('warn', 'composite_ffmpeg_stderr', { jobId, line: line.slice(0, 500) });
    });

    ffmpeg.on('close', (exitCode) => {
      finish(() => {
        if (exitCode === 0 && fs.existsSync(outputPath)) {
          const fileSize = fs.statSync(outputPath).size;
          patchJob(jobId, {
            status: 'done', phase: 'done', pct: 100,
            progress: 'Ready', fileSize
          });
          log('info', 'composite_done', {
            jobId, sizeMB: (fileSize / 1024 / 1024).toFixed(1)
          });
        } else {
          failJob(jobId, 'ffmpeg_exit_' + exitCode, 'Compositing failed — try again');
        }
      });
    });

    ffmpeg.on('error', (err) => {
      finish(() => failJob(jobId, 'ffmpeg_spawn_failed', err.message));
    });
  });
}

// --- Routes ---
function initCompositeRoutes(app) {
  app.post('/sessions/:code/composite', requireAuth, requireTier(EXPORT_TIERS), (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.uploads.length === 0) return res.status(400).json({ error: 'No uploads yet' });

    // Which clips? The client sends the uploadIds of the highlight currently
    // on screen. Older clients send nothing — for those, fall back to the
    // whole session but ONLY if it is within the cap, so a legacy client can
    // never again ask for an 88-input render.
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
        error: `Combined View supports up to ${MAX_COMPOSITE_CLIPS} clips at once ` +
               `(you selected ${selected.length}). Pick a single highlight, or use an AI Reel for a whole session.`
      });
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
      assPath: null,
      owner: req.user && req.user.username ? req.user.username : null,
      clipCount: selected.length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    log('info', 'composite_started', { jobId, code, clips: selected.length });
    res.status(202).json({ jobId, clipCount: selected.length });

    // Failure mode #1: this was a floating promise. Any throw before the
    // ffmpeg Promise left the job 'processing' forever. It cannot now.
    runComposite(selected, code, outputPath, jobId, includeComments)
      .catch((err) => {
        log('error', 'composite_crashed', { jobId, error: err && err.message });
        failJob(jobId, 'internal_error', 'Compositing failed — try again');
      });
  });

  app.get('/sessions/:code/composite/:jobId', (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    // 404 is still correct, but it is now an expected terminal answer the
    // client must handle (job expired, or server restarted), not a state
    // the client can poll its way out of.
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
    if (job.pid) { try { process.kill(job.pid, 'SIGKILL'); } catch (e) {} }
    patchJob(req.params.jobId, {
      status: 'failed', phase: 'done', errorCode: 'cancelled', progress: 'Cancelled'
    });
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
