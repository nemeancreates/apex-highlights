// ================================================================
// server/aireel.js — Peak-Abu AI Highlight Reel engine (v0.1.13)
// ================================================================
// v0.1.13: per-tier reel length caps (t3 15min / t4 30min), segment length
//          scaled to target so long reels stay tractable, tier-priority
//          queue, target clamped to available source footage.
// v0.1.12: optional comment overlay via ASS subtitles per segment.
//
// Pipeline:
//   1. PREPARE — ensure selected clips exist locally (pull from CDN if purged)
//   2. ANALYZE — FFmpeg extracts loudness (ebur128) + scene-change density
//                per clip -> per-second "intensity" scores
//   3. EDIT    — Anthropic API (or heuristic fallback) → Edit Decision List
//   4. RENDER  — FFmpeg renders each EDL segment (solo/side/grid), with
//                optional comment overlay, concatenates, serves download
//
// aireel-edit route added: client sends pre-analyzed clip features and
// gets back just the EDL + report, for client-side rendering (no job
// queue, no upload, no server render).
// ================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const { requireAuth, requireAuthAny, requireTier, getEffectiveTier } = require('./auth');
const { users } = require('./stores');
const { TIERS, tiersWithCapability } = require('./config');
const { getCommentsForSession } = require('./routes/comments');
const { generateASS, checkAssFilter, escapeFilterPath } = require('./comment-overlay');
const { initGenerationUsage, checkAndIncrement, getUsage, pruneOldMonths } = require('./generation-usage');

const AIREEL_TIERS = tiersWithCapability('hasAiReel');

const AIREEL_DIR = path.join(os.tmpdir(), 'peak-abu-aireel');
const PROFILE_FILE = path.join(__dirname, 'aiprofiles.json');

const ALLOWED_TARGETS = [15, 30, 60, 90, 120, 180, 300, 600, 900, 1800, 1800];
const MAX_CLIPS = 50;
const OVERLAP_WINDOW_MS = 5000;
const MAX_TILES = 4;
const JOB_TTL_MS = 3 * 60 * 60 * 1000;      // was 1h — a 45min reel can outlive that
const SESSION_COOLDOWN_MS = 2 * 60 * 1000;
const ANALYZE_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;   // was 5min — long segments + concat of a long reel

// Segment length scales with the target. A 45-minute reel built from 8-second
// cuts would be ~340 separate FFmpeg renders and an EDL far past what the
// model can emit in one response. Long targets are session RECAPS — fewer,
// longer holds — which keeps segment count in the same range as a short reel
// no matter how long the output is.
//
// maxClipDur additionally ceilings the bounds: asking for 70s segments from
// 30s source clips makes every clip fail the `duration < segMin` filter and
// the whole reel comes back empty.
function segmentBounds(targetSec, maxClipDur) {
  let b;
  if (targetSec <= 300)      b = { min: 4,  max: 12,  def: 8  };
  else if (targetSec <= 900) b = { min: 12, max: 35,  def: 20 };
  else                       b = { min: 40, max: 120, def: 70 };

  const ceiling = Math.max(4, Math.floor((maxClipDur || 0) * 0.9));
  b.max = Math.min(b.max, ceiling);
  b.min = Math.min(b.min, b.max);
  b.def = Math.max(b.min, Math.min(b.def, b.max));
  return b;
}

let D = null;

const jobs = new Map();
const jobQueue = [];
let jobRunning = false;
const lastRunPerSession = new Map();

function initAiReel(deps) {
  D = deps;
  if (process.env.AIREEL_ENABLED === 'false') {
    D.log('info', 'aireel_disabled', {});
    return;
  }
  if (!fs.existsSync(AIREEL_DIR)) fs.mkdirSync(AIREEL_DIR, { recursive: true });
  initGenerationUsage({ log: D.log });
  sweepOrphanedAireelFiles({ all: true });
  registerRoutes();
  setInterval(cleanupJobs, 15 * 60 * 1000);
  setInterval(sweepOrphanedAireelFiles, 15 * 60 * 1000);
  setInterval(() => pruneOldMonths(3), 24 * 60 * 60 * 1000);
  D.log('info', 'aireel_ready', {
    aiEditor: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.AIREEL_MODEL || 'claude-sonnet-4-6',
    maxTiles: MAX_TILES
  });
}

// ---------- Game profiles ----------
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILE_FILE)) return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  } catch (e) { D.log('warn', 'aireel_profiles_load_failed', { error: e.message }); }
  return { games: {} };
}

function saveProfiles(p) {
  try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2)); }
  catch (e) { D.log('warn', 'aireel_profiles_save_failed', { error: e.message }); }
}

function recordProfileNote(game, styleNotes) {
  if (!game) return;
  const profiles = loadProfiles();
  const key = game.toLowerCase().trim();
  if (!profiles.games[key]) profiles.games[key] = { name: game.trim(), notes: [], lastReport: null, runs: 0 };
  const g = profiles.games[key];
  g.runs += 1;
  if (styleNotes && styleNotes.trim()) {
    g.notes.push({ text: styleNotes.trim().slice(0, 500), at: new Date().toISOString() });
    while (g.notes.length > 25) g.notes.shift();
  }
  saveProfiles(profiles);
}

function recordProfileReport(game, report) {
  if (!game) return;
  const profiles = loadProfiles();
  const key = game.toLowerCase().trim();
  if (profiles.games[key]) {
    profiles.games[key].lastReport = String(report).slice(0, 2000);
    saveProfiles(profiles);
  }
}

function getProfileContext(game) {
  if (!game) return null;
  const profiles = loadProfiles();
  return profiles.games[game.toLowerCase().trim()] || null;
}

// ---------- Routes ----------
function registerRoutes() {
  const { app } = D;

  app.get('/account/aireel-usage', requireAuth, (req, res) => {
    // requireAuth sets req.user ONLY — req.userTier is set by requireTier(),
    // which this route deliberately does not use, because it has to answer
    // for every tier rather than 403 the ones without credits.
    //
    // Reading req.userTier here meant TIERS[undefined] || TIERS.t1, so this
    // route reported Free to everyone and always answered
    // { applicable: false } — even for Pro and Founder. Resolve the tier the
    // way requireTier does: from the store, never from the JWT, so a
    // redemption takes effect immediately.
    const user = users.get((req.user.username || '').toLowerCase());
    const tier = getEffectiveTier(user);
    const tierCfg = TIERS[tier] || TIERS.t1;
    if (!tierCfg.hasAiReelPro) return res.json({ applicable: false, tier });
    const usage = getUsage(req.user.username, tierCfg.aiReelProMonthlyCap);
    res.json({ applicable: true, tier, ...usage });
  });

  app.post('/sessions/:code/aireel', requireAuth, requireTier(AIREEL_TIERS), (req, res) => {
    const code = D.sanitizeCode(req.params.code);
    if (!code) return D.safeError(res, 400, 'Invalid session code');

    const session = D.sessions.get(code);
    if (!session) return D.safeError(res, 404, 'Session not found');

    const body = req.body || {};
    const targetSec = Number(body.targetSec);
    if (!ALLOWED_TARGETS.includes(targetSec)) {
      return D.safeError(res, 400, `targetSec must be one of ${ALLOWED_TARGETS.join(', ')}`);
    }

    // Per-tier length ceiling. requireTier already resolved the effective
    // tier onto req.userTier (re-read from the store, not the JWT).
    const tierCfg = TIERS[req.userTier] || TIERS.t1;
    const maxSec = tierCfg.aiReelMaxSec || 0;
    if (targetSec > maxSec) {
      return D.safeError(res, 403,
        `${tierCfg.label} reels cap at ${Math.floor(maxSec / 60)} minutes. Pick a shorter length or upgrade.`);
    }

    const requestedIds = Array.isArray(body.uploadIds) ? body.uploadIds.map(String) : [];
    if (requestedIds.length === 0) return D.safeError(res, 400, 'Select at least one clip');
    if (requestedIds.length > MAX_CLIPS) return D.safeError(res, 400, `Maximum ${MAX_CLIPS} clips per reel (v1)`);

    const selected = session.uploads.filter(u => requestedIds.includes(u.id));
    if (selected.length === 0) return D.safeError(res, 400, 'No matching uploads in this session');

    const last = lastRunPerSession.get(code) || 0;
    if (Date.now() - last < SESSION_COOLDOWN_MS) {
      return D.safeError(res, 429, 'A reel was just generated for this session. Wait 2 minutes.');
    }
    if (jobQueue.length >= 3) {
      return D.safeError(res, 503, 'Reel queue is full. Try again in a few minutes.');
    }

    // Disk guard. Sweep first — the space may already be reclaimable — and
    // refuse only if it is still short afterwards.
    const free = freeBytes(AIREEL_DIR);
    if (free !== null && free < minFreeBytes()) {
      sweepOrphanedAireelFiles();
      const after = freeBytes(AIREEL_DIR);
      D.log('warn', 'aireel_low_disk', {
        freeMB: Math.round(free / 1048576),
        afterMB: after === null ? null : Math.round(after / 1048576)
      });
      if (after !== null && after < minFreeBytes()) {
        return D.safeError(res, 507, 'The server is low on disk space right now — try again in a few minutes.');
      }
    }

    let aiCreditsWarning = null;
    if (tierCfg.hasAiReelPro) {
      const usage = getUsage(req.user.username, tierCfg.aiReelProMonthlyCap);
      if (usage.remaining <= 0) {
        aiCreditsWarning = `You're out of AI Reel credits this month (${usage.used}/${usage.cap}). ` +
          `This reel will use the standard editor instead of the AI-powered one.`;
      }
    }

    const game = typeof body.game === 'string' ? body.game.trim().slice(0, 60) : '';
    const styleNotes = typeof body.styleNotes === 'string' ? body.styleNotes.trim().slice(0, 500) : '';
    const includeComments = body.includeComments !== false; // default true

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId, code, status: 'queued', progress: 'Waiting in queue',
      createdAt: Date.now(), targetSec, game, styleNotes, includeComments,
      tier: req.userTier,
      userId: req.user.username,
      priority: tierCfg.reelPriority || 0,
      effectiveTarget: targetSec,   // clamped in runJob once real durations are known
      seg: null,                    // segment bounds, computed after analysis
      uploads: selected.map(u => ({
        id: u.id, username: u.username,
        videoFile: u.videoFile, videoUrl: u.videoUrl || null,
        metadataFile: u.metadataFile || null, metadataUrl: u.metadataUrl || null
      })),
      outputPath: path.join(AIREEL_DIR, `reel_${jobId}.mp4`),
      workDir: path.join(AIREEL_DIR, `job_${jobId}`),
      report: null, editorEngine: null, fileSize: null,
      sessionComments: null // populated in runJob if includeComments
    };

    jobs.set(jobId, job);
    lastRunPerSession.set(code, Date.now());
    recordProfileNote(game, styleNotes);

    D.log('info', 'aireel_job_created', {
      jobId, session: code, clips: selected.length, targetSec,
      tier: req.userTier, priority: job.priority, game, includeComments
    });
    res.status(202).json({ jobId, aiCreditsWarning });

    // Higher-tier jobs jump the queue. The worker is single-threaded, so on a
    // busy droplet this is the difference between a Pro user waiting 2 minutes
    // and waiting behind somebody else's 45-minute recap.
    jobQueue.push(job);
    jobQueue.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    pumpQueue();
  });

  app.get('/sessions/:code/aireel/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    // 404 means the job is gone — a server restart emptied the in-memory map,
    // or it aged out. That is a terminal answer the client must act on, not a
    // state to keep polling through (which is what greyed the button out).
    if (!job) return res.status(404).json({ error: 'Job not found', status: 'lost' });
    res.json({
      status: job.status, progress: job.progress,
      pct: job.status === 'done' ? 100 : (job.pct || 0),
      errorCode: job.errorCode || null,
      queuePosition: job.status === 'queued' ? jobQueue.indexOf(job) + 1 : 0,
      report: job.status === 'done' ? job.report : null,
      editorEngine: job.status === 'done' ? job.editorEngine : null,
      fileSize: job.fileSize,
      downloadUrl: job.status === 'done' ? `/aireel/${job.id}/download` : null
    });
  });

  // Cancel. A queued job is simply removed; a running one has its ffmpeg
  // killed and the worker released immediately for the next reel.
  app.delete('/sessions/:code/aireel/:jobId', requireAuth, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return D.safeError(res, 404, 'Job not found');
    if (job.userId !== req.user.username) return D.safeError(res, 403, 'Not your reel');
    if (isTerminal(job)) return res.json({ status: job.status, message: 'Already finished' });

    const qi = jobQueue.indexOf(job);
    if (qi !== -1) {
      jobQueue.splice(qi, 1);
      job.cancelled = true;
      failJob(job, 'cancelled', 'Cancelled');
      // Never started, cost nothing — don't make the user sit out the
      // session cooldown to retry with different settings.
      lastRunPerSession.delete(job.code);
    } else {
      abortJob(job, 'cancelled', 'Cancelled');
    }
    D.log('info', 'aireel_cancelled', { jobId: job.id, wasQueued: qi !== -1 });
    res.json({ status: 'cancelled' });
  });

  app.get('/aireel/:jobId/download', requireAuthAny, requireTier(AIREEL_TIERS), (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'done' || !fs.existsSync(job.outputPath)) {
      return D.safeError(res, 404, 'Reel not ready or expired');
    }
    res.download(job.outputPath, `peak-abu-ai-reel-${job.code}.mp4`);
  });

  // Slim edit-only route for client-side render: client sends pre-analyzed
  // clip features, gets back just the EDL + report. No upload, no render,
  // no job queue — the heavy work stays on the user's PC.
  app.post('/sessions/:code/aireel-edit', requireAuth, requireTier(AIREEL_TIERS), (req, res) => {
    const code = D.sanitizeCode(req.params.code);
    if (!code) return D.safeError(res, 400, 'Invalid session code');
    const session = D.sessions.get(code);
    if (!session) return D.safeError(res, 404, 'Session not found');

    const body = req.body || {};
    const targetSec = Number(body.targetSec);
    if (!ALLOWED_TARGETS.includes(targetSec)) {
      return D.safeError(res, 400, `targetSec must be one of ${ALLOWED_TARGETS.join(', ')}`);
    }

    const tierCfg = TIERS[req.userTier] || TIERS.t1;
    const maxSec = tierCfg.aiReelMaxSec || 0;
    if (targetSec > maxSec) {
      return D.safeError(res, 403,
        `${tierCfg.label} reels cap at ${Math.floor(maxSec / 60)} minutes. Pick a shorter length or upgrade.`);
    }
    if (!tierCfg.hasAiReelPro) {
      return D.safeError(res, 403, `${tierCfg.label} does not include AI-powered editing. Upgrade to use this feature.`);
    }

    const genKind = body.isReedit === true ? 'reedit' : 'fresh';
    const usageCheck = checkAndIncrement(req.user.username, genKind, tierCfg.aiReelProMonthlyCap);
    if (!usageCheck.ok) {
      return D.safeError(res, 429,
        `Monthly AI Reel limit reached (${usageCheck.usage.used}/${usageCheck.usage.cap}). Resets next calendar month.`);
    }

    const clips = Array.isArray(body.clips) ? body.clips : [];
    if (clips.length === 0) return D.safeError(res, 400, 'No clip data provided');
    if (clips.length > MAX_CLIPS) return D.safeError(res, 400, `Maximum ${MAX_CLIPS} clips per reel (v1)`);

    const maxClipDur = Math.max(0, ...clips.map(c => Number(c.durationSec) || 0));
    if (maxClipDur <= 0) return D.safeError(res, 400, 'Clip data missing valid durations');
    const seg = segmentBounds(targetSec, maxClipDur);

    const game = typeof body.game === 'string' ? body.game.trim().slice(0, 60) : '';
    const styleNotes = typeof body.styleNotes === 'string' ? body.styleNotes.trim().slice(0, 500) : '';

    buildEdl({
      game, targetSec, seg, styleNotes,
      clips: clips.map(c => ({
        clipId: c.clipId, player: c.player,
        durationSec: c.durationSec, startTimeUTC: c.startTimeUTC,
        hasAudio: c.hasAudio, topMoments: c.topMoments,
        id: c.clipId, duration: Number(c.durationSec) || 0
      }))
    }).then(result => {
      if (!result) return D.safeError(res, 502, 'AI editor unavailable — try again shortly');
      recordProfileNote(game, styleNotes);
      recordProfileReport(game, result.report);
      res.json({ edl: result.edl, report: result.report });
    }).catch(e => {
      D.log('error', 'aireel_edit_route_failed', { code, error: e.message });
      D.safeError(res, 500, 'Edit generation failed');
    });
  });
}

// ---------- Job queue ----------
//
// Single worker. v0.1.13 had two ways to wedge it permanently: a runJob that
// awaited forever (an unbounded fetch), and no way to stop a job once it had
// started. Now every job runs under a time budget, can be cancelled, and the
// worker is released exactly once per job whichever of those happens first.

const TERMINAL = new Set(['done', 'failed']);
function isTerminal(job) { return TERMINAL.has(job.status); }

function failJob(job, errorCode, message) {
  if (isTerminal(job)) return;
  job.status = 'failed';
  job.errorCode = errorCode;
  job.progress = message;
}

// Thrown by checkpoint() once a job has been cancelled or timed out, so runJob
// unwinds without overwriting the terminal status that was already set.
class JobStopped extends Error {
  constructor() { super('job stopped'); this.code = 'JOB_STOPPED'; }
}
function checkpoint(job) { if (job.cancelled) throw new JobStopped(); }

// Progress only ever moves forward, and only reaches 100 on 'done'.
function setPct(job, pct) {
  const v = Math.max(0, Math.min(99, Math.round(pct)));
  if (v > (job.pct || 0)) job.pct = v;
}

// Deliberately generous — a backstop against a wedged worker, not a speed
// target. Scales with requested length, and stays under the TTL so the
// periodic sweep can never delete a workdir that is still in use.
// AIREEL_MAX_JOB_MS optionally tightens it for small droplets.
function jobBudgetMs(job) {
  const computed = 20 * 60 * 1000 + (job.targetSec || 60) * 4000;
  const ceiling = JOB_TTL_MS - 15 * 60 * 1000;
  const envCap = Number(process.env.AIREEL_MAX_JOB_MS) || Infinity;
  return Math.min(computed, ceiling, envCap);
}

// Stop a job from outside the pipeline (cancel, watchdog). Marks it terminal,
// kills its ffmpeg, and frees the worker now rather than whenever runJob
// next notices. Returns false if the job had already finished.
function abortJob(job, errorCode, message) {
  if (isTerminal(job)) return false;
  job.cancelled = true;
  failJob(job, errorCode, message);
  killJobChildren(job);
  if (typeof job._release === 'function') job._release();
  return true;
}

async function pumpQueue() {
  if (jobRunning || jobQueue.length === 0) return;
  jobRunning = true;
  const job = jobQueue.shift();

  let released = false;
  let watchdog = null;
  job._release = () => {
    if (released) return;
    released = true;
    if (watchdog) clearTimeout(watchdog);
    try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    jobRunning = false;
    setImmediate(pumpQueue);
  };

  const budget = jobBudgetMs(job);
  watchdog = setTimeout(() => {
    if (abortJob(job, 'timeout', 'Reel took too long and was stopped — try fewer clips or a shorter length')) {
      D.log('warn', 'aireel_job_timeout', { jobId: job.id, budgetMin: +(budget / 60000).toFixed(1) });
    }
  }, budget);

  try {
    await runJob(job);
    // runJob returning without a terminal status would be a bug. Never leave
    // a job looking alive after the worker has moved on from it.
    if (!isTerminal(job)) failJob(job, 'internal_error', 'Internal error');
  } catch (e) {
    if (!(e && e.code === 'JOB_STOPPED')) {
      failJob(job, 'internal_error', 'Internal error');
      D.log('error', 'aireel_job_crashed', { jobId: job.id, error: e && e.message });
    }
  } finally {
    job._release();
  }
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      try { if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch (e) {}
      try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
      jobs.delete(id);
    }
  }
}

// Runs once at boot. A crash mid-render (OOM, etc.) skips pumpQueue()'s
// finally block, so job_* workdirs and reel_*.mp4 outputs from before the
// crash never get cleaned up and the in-memory `jobs` Map that cleanupJobs()
// relies on starts empty on every fresh boot anyway. This sweeps anything
// stale left in AIREEL_DIR that nothing currently tracks.
//
// On BOOT ({ all: true }) everything goes regardless of age. The jobs Map is
// empty in a fresh process, so the download route cannot serve any reel left
// here — keeping files "still within TTL" after a restart only held disk
// hostage for up to three hours. On the timer, the age rule still applies.
function sweepOrphanedAireelFiles(opts) {
  const all = !!(opts && opts.all === true);
  let entries;
  try { entries = fs.readdirSync(AIREEL_DIR, { withFileTypes: true }); }
  catch (e) { return; }

  const cutoff = all ? Infinity : Date.now() - JOB_TTL_MS;
  let swept = 0, bytesFreed = 0;

  for (const entry of entries) {
    const isJobDir = entry.isDirectory() && entry.name.startsWith('job_');
    const isReelFile = entry.isFile() && entry.name.startsWith('reel_') && entry.name.endsWith('.mp4');
    if (!isJobDir && !isReelFile) continue;

    const fullPath = path.join(AIREEL_DIR, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= cutoff) continue; // still within TTL, leave it

      if (isJobDir) {
        // du -sh style sum before removal, so the log line is useful
        bytesFreed += dirSize(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        bytesFreed += stat.size;
        fs.unlinkSync(fullPath);
      }
      swept++;
    } catch (e) {
      D.log('warn', 'aireel_sweep_entry_failed', { entry: entry.name, error: e.message });
    }
  }

  if (swept > 0) {
    D.log('info', 'aireel_startup_sweep', { swept, mbFreed: (bytesFreed / 1024 / 1024).toFixed(1) });
  }
}

// Free bytes on the volume holding AIREEL_DIR, or null where statfsSync is
// unavailable (Node < 18.15), in which case the guard is skipped, not guessed.
function freeBytes(dir) {
  if (typeof fs.statfsSync !== 'function') return null;
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize; }
  catch (e) { return null; }
}

// A full disk does not fail one reel — it stops SQLite, uploads and the API
// all at once. Refusing one reel loudly is the cheap outcome.
function minFreeBytes() {
  return Number(process.env.AIREEL_MIN_FREE_BYTES) || 3 * 1024 * 1024 * 1024;
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (e) {}
  return total;
}

// ---------- Pipeline ----------
async function runJob(job) {
  fs.mkdirSync(job.workDir, { recursive: true });
  const sessionDir = path.join(D.UPLOADS_DIR, job.code);

  // Progress bands: prepare 0-5, analyze 5-35, edit 35-40, render 40-95,
  // stitch 95-99, done 100. Each checkpoint() lets a cancel or a watchdog
  // abort unwind the pipeline without overwriting the status it already set.

  // 1. PREPARE
  job.status = 'preparing';
  job.progress = 'Fetching clips';
  const clips = [];
  for (let ui = 0; ui < job.uploads.length; ui++) {
    checkpoint(job);
    setPct(job, 5 * ui / job.uploads.length);
    const up = job.uploads[ui];
    let localPath = path.join(sessionDir, up.videoFile);
    if (!fs.existsSync(localPath)) {
      if (!up.videoUrl) { D.log('warn', 'aireel_clip_missing', { jobId: job.id, file: up.videoFile }); continue; }
      const tmp = path.join(job.workDir, `src_${up.id}.mp4`);
      try {
        // Explicit bounds: reels tolerate a slower pull than a composite does,
        // but a stalled socket must still fail rather than hold the worker.
        await D.downloadToFile(up.videoUrl, tmp, { idleMs: 30000, totalMs: 10 * 60 * 1000 });
        localPath = tmp;
      } catch (e) {
        D.log('warn', 'aireel_download_failed', { jobId: job.id, error: e.message });
        continue;
      }
    }

    let meta = null;
    const metaLocal = up.metadataFile ? path.join(sessionDir, up.metadataFile) : null;
    if (metaLocal && fs.existsSync(metaLocal)) {
      try { meta = JSON.parse(fs.readFileSync(metaLocal, 'utf8')); } catch (e) {}
    } else if (up.metadataUrl) {
      try { meta = JSON.parse(await fetchText(up.metadataUrl)); } catch (e) {}
    }

    clips.push({
      id: up.id, username: up.username, path: localPath,
      startTimeUTC: meta && typeof meta.startTimeUTC === 'number' ? meta.startTimeUTC : null,
      duration: 0, hasAudio: false,
      loudness: [], scenes: [], moments: []
    });
  }

  checkpoint(job);
  if (clips.length === 0) {
    job.status = 'failed';
    job.progress = 'No usable clips (files missing locally and on CDN)';
    return;
  }

  // Fetch comments for overlay (before analysis, which takes time)
  if (job.includeComments) {
    const canAss = await checkAssFilter();
    if (canAss) {
      job.sessionComments = getCommentsForSession(job.code);
      if (job.sessionComments.length > 0) {
        D.log('info', 'aireel_comments_loaded', { jobId: job.id, count: job.sessionComments.length });
      } else {
        job.sessionComments = null;
      }
    } else {
      D.log('warn', 'aireel_no_libass', { jobId: job.id });
    }
  }

  // 2. ANALYZE
  job.status = 'analyzing';
  for (let i = 0; i < clips.length; i++) {
    checkpoint(job);
    setPct(job, 5 + 30 * i / clips.length);
    job.progress = `Analyzing clip ${i + 1}/${clips.length} (${clips[i].username})`;
    await analyzeClip(clips[i], job);
  }
  checkpoint(job);

  const analyzable = clips.filter(c => c.duration > 2);
  if (analyzable.length === 0) {
    job.status = 'failed';
    job.progress = 'Clips could not be analyzed';
    return;
  }

  // A reel can't be longer than the footage it's cut from. Rather than fail a
  // 45-minute request made against 6 minutes of clips, clamp the target and
  // say so in the report.
  const totalSource = analyzable.reduce((sum, c) => sum + c.duration, 0);
  const maxClipDur = Math.max(...analyzable.map(c => c.duration));
  job.effectiveTarget = Math.min(job.targetSec, Math.floor(totalSource * 0.9));
  job.clamped = job.effectiveTarget < job.targetSec;
  job.seg = segmentBounds(job.effectiveTarget, maxClipDur);

  if (job.effectiveTarget < job.seg.min) {
    job.status = 'failed';
    job.progress = 'Not enough usable footage to build a reel — select more clips';
    return;
  }

  // Scoring depends on segment spacing, so it has to come after the bounds.
  const maxMoments = Math.min(60, Math.max(18, Math.ceil(job.effectiveTarget / job.seg.def) + 5));
  for (const c of analyzable) scoreClip(c, job.seg.max, maxMoments);

  D.log('info', 'aireel_plan', {
    jobId: job.id, targetSec: job.targetSec, effectiveTarget: job.effectiveTarget,
    clamped: job.clamped, seg: job.seg, totalSource: Math.round(totalSource)
  });

  // 3. EDIT
  job.status = 'editing';
  job.progress = 'AI editor building the cut';
  setPct(job, 35);
  let edl, report, engine;
  const jobTierCfg = TIERS[job.tier] || TIERS.t1;
  let aiResult = null;
  if (jobTierCfg.hasAiReelPro) {
    const usageCheck = checkAndIncrement(job.userId, 'fresh', jobTierCfg.aiReelProMonthlyCap);
    if (usageCheck.ok) {
      aiResult = await tryAnthropicEdl(job, analyzable);
    } else {
      D.log('info', 'aireel_cap_reached', { jobId: job.id, userId: job.userId, usage: usageCheck.usage });
    }
  }
  if (aiResult) { edl = aiResult.edl; report = aiResult.report; engine = 'ai'; }
  else {
    const h = heuristicEdl(job, analyzable);
    edl = h.edl; report = h.report; engine = 'heuristic';
  }
  checkpoint(job);   // the AI call can take up to a minute; honour a cancel made during it
  setPct(job, 40);

  if (edl.length === 0) {
    job.status = 'failed';
    job.progress = 'No high-action moments found in the selected clips';
    return;
  }

  const tileHist = {};
  edl.forEach(s => { const n = (s.members || []).length || 1; tileHist[n] = (tileHist[n] || 0) + 1; });
  D.log('info', 'aireel_edl_built', { jobId: job.id, engine, segments: edl.length, tiles: tileHist });

  // 4. RENDER
  job.status = 'rendering';
  const segFiles = [];
  for (let i = 0; i < edl.length; i++) {
    checkpoint(job);
    setPct(job, 40 + 55 * i / edl.length);
    job.progress = `Rendering segment ${i + 1}/${edl.length}`;
    const segPath = path.join(job.workDir, `seg_${String(i).padStart(2, '0')}.mp4`);
    const ok = await renderSegment(edl[i], clips, segPath, job);
    if (ok) segFiles.push(segPath);
    else D.log('warn', 'aireel_segment_failed', { jobId: job.id, seg: i, layout: edl[i].layout });
  }

  checkpoint(job);
  if (segFiles.length === 0) {
    job.status = 'failed';
    job.progress = 'Rendering failed for all segments';
    return;
  }

  setPct(job, 95);
  job.progress = 'Stitching final reel';
  const listPath = path.join(job.workDir, 'concat.txt');
  fs.writeFileSync(listPath, segFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

  const concatOk = await runFF([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', '-y', job.outputPath
  ], RENDER_TIMEOUT_MS, job);
  checkpoint(job);

  if (!concatOk || !fs.existsSync(job.outputPath)) {
    job.status = 'failed';
    job.progress = 'Final stitch failed';
    return;
  }

  job.fileSize = fs.statSync(job.outputPath).size;
  job.report = report;
  job.editorEngine = engine;
  job.pct = 100;
  job.status = 'done';
  job.progress = 'Ready';
  recordProfileReport(job.game, report);
  D.log('info', 'aireel_done', {
    jobId: job.id, session: job.code, engine,
    segments: segFiles.length, sizeMB: (job.fileSize / 1024 / 1024).toFixed(1)
  });
}

// ---------- Analysis ----------
// Every ffmpeg the pipeline starts goes through here. Two changes from v0.1.13:
//
//  - -nostdin with stdin ignored. Default stdio hands ffmpeg an open stdin
//    it reads for interactive keys; that is a known way to get a process
//    that never exits. stdout is ignored too — every call here writes to a
//    file or to the null muxer, and stderr carries everything we parse.
//
//  - Children are tracked on the job, so cancel and the watchdog can kill
//    what is actually running instead of waiting out a 20-minute render
//    timeout. A job already cancelled spawns nothing at all.
function runFFCollect(args, timeoutMs, job) {
  return new Promise((resolve) => {
    if (job && job.cancelled) return resolve({ code: -2, stderr: '' });

    const p = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', ...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    if (job) (job._children || (job._children = new Set())).add(p);

    let err = '';
    let settled = false;
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (job && job._children) job._children.delete(p);
      resolve({ code, stderr: err });
    };

    p.stderr.on('data', d => { err += d.toString(); if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('close', (code) => settle(code));
    p.on('error', () => settle(-1));
  });
}
function runFF(args, timeoutMs, job) { return runFFCollect(args, timeoutMs, job).then(r => r.code === 0); }

function killJobChildren(job) {
  if (!job || !job._children) return 0;
  let n = 0;
  for (const p of job._children) { try { p.kill('SIGKILL'); n++; } catch (e) {} }
  return n;
}

async function analyzeClip(clip, job) {
  const loud = await runFFCollect(['-i', clip.path, '-map', '0:a:0', '-filter:a', 'ebur128', '-f', 'null', '-'], ANALYZE_TIMEOUT_MS, job);
  const durMatch = loud.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (durMatch) clip.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]);
  const loudRe = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = loudRe.exec(loud.stderr)) !== null) {
    const val = parseFloat(m[2]);
    if (isFinite(val)) clip.loudness.push({ t: parseFloat(m[1]), m: val });
  }
  clip.hasAudio = clip.loudness.length > 0;

  const scene = await runFFCollect(['-i', clip.path, '-vf', "select='gt(scene,0.30)',showinfo", '-f', 'null', '-'], ANALYZE_TIMEOUT_MS, job);
  if (!clip.duration) {
    const d2 = scene.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (d2) clip.duration = (+d2[1]) * 3600 + (+d2[2]) * 60 + (+d2[3]);
  }
  const sceneRe = /pts_time:([\d.]+)/g;
  while ((m = sceneRe.exec(scene.stderr)) !== null) clip.scenes.push(parseFloat(m[1]));
}

function scoreClip(clip, segMax, maxMoments) {
  const secs = Math.max(1, Math.ceil(clip.duration));
  const score = new Array(secs).fill(0);

  for (const s of clip.loudness) {
    const idx = Math.min(secs - 1, Math.floor(s.t));
    const norm = Math.max(0, Math.min(1, (s.m + 45) / 30));
    if (norm > score[idx]) score[idx] = norm;
  }
  for (const t of clip.scenes) {
    const idx = Math.min(secs - 1, Math.floor(t));
    score[idx] = Math.min(1, score[idx] + 0.35);
  }
  const smooth = score.map((v, i) => {
    const a = score[i - 1] || 0, b = score[i + 1] || 0;
    return v * 0.6 + a * 0.2 + b * 0.2;
  });

  const order = smooth.map((v, i) => ({ t: i, score: v })).sort((a, b) => b.score - a.score);
  const picked = [];
  for (const cand of order) {
    if (cand.score < 0.15) break;
    if (picked.some(p => Math.abs(p.t - cand.t) < segMax)) continue;
    picked.push(cand);
    if (picked.length >= maxMoments) break;
  }
  clip.moments = picked.sort((a, b) => a.t - b.t);
}

// ---------- Shared helpers ----------
function round2(n) { return Math.round(n * 100) / 100; }
function layoutFor(n) { return n >= 3 ? 'grid' : n === 2 ? 'side' : 'solo'; }

function absTime(clip, t) {
  return clip.startTimeUTC != null ? clip.startTimeUTC + t * 1000 : null;
}

// ---------- Heuristic editor ----------
function heuristicEdl(job, clips) {
  const target = job.effectiveTarget || job.targetSec;
  const SEG = job.seg || { min: 4, max: 12, def: 8 };
  const pool = [];
  clips.forEach(c => c.moments.forEach(mm => pool.push({ clip: c, t: mm.t, score: mm.score, abs: absTime(c, mm.t) })));
  pool.sort((a, b) => b.score - a.score);

  const chosen = [];
  let total = 0;
  for (const cand of pool) {
    if (total >= target) break;
    if (chosen.some(ch => ch.clip.id === cand.clip.id && Math.abs(ch.t - cand.t) < SEG.max)) continue;
    const dur = Math.min(SEG.def, Math.max(SEG.min, target - total));
    const start = Math.max(0, Math.min(cand.t - dur * 0.6, cand.clip.duration - dur));
    if (start < 0 || cand.clip.duration < SEG.min) continue;
    chosen.push({ clip: cand.clip, t: cand.t, start, duration: dur, score: cand.score, abs: cand.abs });
    total += dur;
  }

  chosen.sort((a, b) => (a.abs == null ? 1 : b.abs == null ? -1 : a.abs - b.abs));

  const edl = [];
  const used = new Set();

  for (let i = 0; i < chosen.length; i++) {
    if (used.has(i)) continue;
    const group = [chosen[i]];
    used.add(i);

    for (let j = i + 1; j < chosen.length && group.length < MAX_TILES; j++) {
      if (used.has(j)) continue;
      const b = chosen[j];
      if (group[0].abs == null || b.abs == null) break;
      if (Math.abs(b.abs - group[0].abs) > OVERLAP_WINDOW_MS) break;
      if (group.some(g => g.clip.id === b.clip.id)) continue;
      group.push(b);
      used.add(j);
    }

    group.sort((a, b) => b.score - a.score);
    const primary = group[0];
    const dur = Math.min(SEG.max, Math.max(...group.map(g => g.duration)));

    const members = group.map(g => {
      let s = g.start;
      if (g !== primary && g.clip.startTimeUTC != null && primary.clip.startTimeUTC != null) {
        s = (primary.clip.startTimeUTC + primary.start * 1000 - g.clip.startTimeUTC) / 1000;
      }
      s = Math.max(0, Math.min(s, Math.max(0, g.clip.duration - dur)));
      return { clipId: g.clip.id, start: round2(s) };
    });

    edl.push({
      layout: layoutFor(members.length),
      duration: round2(dur),
      clipId: primary.clip.id,
      start: members[0].start,
      members
    });
  }

  const counts = { solo: 0, side: 0, grid: 0 };
  edl.forEach(s => counts[s.layout]++);
  const clampNote = job.clamped
    ? `Your ${job.targetSec}s request was trimmed to ${target}s — that's all the footage the selected clips hold. `
    : '';
  const report =
    `Heuristic editor report (${job.game || 'unknown game'}):\n` + clampNote +
    `Scanned ${clips.length} POV(s) for loudness spikes and on-screen chaos. ` +
    `Selected ${chosen.length} moments totaling ~${Math.round(total)}s against your ${target}s target ` +
    `at ~${SEG.def}s per cut. ` +
    `${counts.grid} moment(s) had 3-4 squad members recording the same real-world instant and were cut as a grid; ` +
    `${counts.side} were cut side-by-side; ${counts.solo} played solo full-frame. ` +
    `The most intense POV leads each multi-view shot and carries the audio. Segments are ordered chronologically. ` +
    `Tip: add style notes ("prefer 3-up", "hold on clutches longer") — they're saved per game and shape future edits.`;

  return { edl, report };
}

// ---------- AI editor (Anthropic) ----------

// Job-pipeline wrapper: adapts the internal `job`/`clips` (loudness+scene
// analysis objects) shape into the plain params buildEdl expects, so the
// existing server-render pipeline (runJob) keeps working unchanged.
async function tryAnthropicEdl(job, clips) {
  const result = await buildEdl({
    game: job.game,
    targetSec: job.effectiveTarget || job.targetSec,
    seg: job.seg,
    styleNotes: job.styleNotes,
    clips: clips.map(c => ({
      clipId: c.id, player: c.username,
      durationSec: round2(c.duration),
      startTimeUTC: c.startTimeUTC,
      hasAudio: c.hasAudio,
      topMoments: c.moments.slice(0, 10).map(m => ({ t: round2(m.t), intensity: round2(m.score) })),
      id: c.id, duration: c.duration // validateEdl needs these two field names
    }))
  });
  if (result) D.log('info', 'aireel_ai_edl_ok', { jobId: job.id, segments: result.edl.length });
  else D.log('warn', 'aireel_ai_fallback', { jobId: job.id });
  return result;
}

// Parameterized EDL builder. Used directly by the /aireel-edit route
// (client sends pre-analyzed features, no job object exists) and
// indirectly by tryAnthropicEdl above (server-render job pipeline).
async function buildEdl({ game, targetSec, seg, styleNotes, clips }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const profile = getProfileContext(game);
  const SEG = seg || { min: 4, max: 12, def: 8 };
  const target = targetSec;
  const features = clips; // already shaped: {clipId, player, durationSec, startTimeUTC, hasAudio, topMoments}

  const systemPrompt =
    'You are the editing engine for Peak-Abu, a multi-POV gameplay highlight tool. ' +
    'You receive per-clip intensity analysis (loudness + visual chaos scores) and must produce an edit decision list for a highlight reel. ' +
    'Clips from different players whose startTimeUTC-aligned moments coincide show the SAME real play from different POVs — ' +
    `group them into a single multi-view segment (up to ${MAX_TILES} tiles on screen at once). ` +
    'Respond with ONLY a JSON object, no markdown fences, no prose, in this exact shape: ' +
    `{"segments":[{"clipIds":["primaryId","secondId","thirdId"],"starts":[<sec>,<sec>,<sec>],"duration":<sec ${SEG.min}-${SEG.max}>}],` +
    '"report":"<3-6 sentence editor\'s report addressed to the user explaining your choices and what you learned about editing this game>"} ' +
    `Rules: clipIds has 1-${MAX_TILES} entries, all distinct and all real clipIds from the input. ` +
    'clipIds[0] is the primary POV — it leads the layout and carries the audio; order the rest by intensity. ' +
    'starts is a parallel array, same length as clipIds, giving each clip\'s in-point in ITS OWN timeline — ' +
    'compute non-primary in-points from startTimeUTC so every tile shows the same real-world instant. ' +
    '1 clipId renders full-frame, 2 side-by-side, 3-4 as a grid. ' +
    'Only group clips that genuinely overlap in real time; do not pad a segment with unrelated footage. ' +
    'A clip with a null startTimeUTC cannot be time-aligned and must appear only as a single-clipId segment. ' +
    'If userStyleNotes requests a specific tile count (e.g. "3 POVs at once"), honor it wherever enough overlapping POVs exist. ' +
    'Total duration must not exceed the target by more than 15%. Order segments for narrative flow (usually chronological, save the best moment for last if it is clearly strongest). ' +
    'start+duration must fit within each clip\'s durationSec. Never invent clipIds. ' +
    `Aim for roughly ${SEG.def}s per segment; you have a ${target}s target, so plan on about ` +
    `${Math.max(1, Math.round(target / SEG.def))} segments total. ` +
    (target > 900
      ? 'This is a long-form SESSION RECAP, not a fast montage — hold on each moment, let plays breathe, ' +
        'and favour continuity over rapid cutting.'
      : 'This is a highlight montage — keep the pace tight.');

  const userPrompt = JSON.stringify({
    game: game || 'unknown',
    targetSec: target,
    segmentSecondsMin: SEG.min,
    segmentSecondsMax: SEG.max,
    maxTiles: MAX_TILES,
    userStyleNotes: styleNotes || null,
    gameProfile: profile ? {
      priorRuns: profile.runs,
      accumulatedUserFeedback: profile.notes.slice(-10).map(n => n.text),
      yourLastReport: profile.lastReport
    } : null,
    clips: features
  });

  try {
    const raw = await anthropicMessage(apiKey, systemPrompt, userPrompt);
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const edl = validateEdl(parsed.segments, clips, target, SEG);
    if (!edl || edl.length === 0) throw new Error('EDL failed validation');
    const report = typeof parsed.report === 'string' && parsed.report.trim()
      ? parsed.report.trim().slice(0, 2000)
      : 'AI editor completed the cut.';
    return { edl, report };
  } catch (e) {
    D.log('warn', 'aireel_buildedl_failed', { error: e.message, game: game || 'unknown' });
    return null;
  }
}

function validateEdl(segments, clips, targetSec, SEG) {
  SEG = SEG || { min: 4, max: 12, def: 8 };
  if (!Array.isArray(segments)) return null;
  const byId = new Map(clips.map(c => [c.id, c]));
  const out = [];
  let total = 0;

  for (const s of segments) {
    if (!s || typeof s !== 'object') continue;

    let ids = Array.isArray(s.clipIds) ? s.clipIds.map(String) : [];
    let starts = Array.isArray(s.starts) ? s.starts.map(Number) : [];
    if (ids.length === 0) {
      ids = [String(s.clipId)];
      starts = [Number(s.start)];
      if (s.partnerClipId) { ids.push(String(s.partnerClipId)); starts.push(Number(s.partnerStart)); }
    }

    let dur = Number(s.duration);
    if (!isFinite(dur)) continue;
    dur = Math.max(SEG.min, Math.min(SEG.max, dur));

    const members = [];
    const seen = new Set();
    for (let i = 0; i < ids.length && members.length < MAX_TILES; i++) {
      const clip = byId.get(ids[i]);
      if (!clip || seen.has(clip.id) || clip.duration < SEG.min) continue;
      let st = Number(starts[i]);
      if (!isFinite(st)) st = 0;
      st = Math.max(0, Math.min(st, Math.max(0, clip.duration - dur)));
      seen.add(clip.id);
      members.push({ clipId: clip.id, start: round2(st) });
    }
    if (members.length === 0) continue;

    out.push({
      layout: layoutFor(members.length),
      duration: round2(dur),
      clipId: members[0].clipId,
      start: members[0].start,
      members
    });
    total += dur;
    if (total > targetSec * 1.3) break;
  }
  return out;
}

function anthropicMessage(apiKey, system, user) {
  const body = JSON.stringify({
    model: process.env.AIREEL_MODEL || 'claude-sonnet-4-6',
    max_tokens: 12000,
    system,
    messages: [{ role: 'user', content: user }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(`API ${res.statusCode}: ${(parsed.error && parsed.error.message) || 'request failed'}`));
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('API timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- Render ----------
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
             '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

const TILE_W = 640, TILE_H = 360;
const GRID_POS = {
  2: [[0, 180], [640, 180]],
  3: [[0, 0], [640, 0], [320, 360]],
  4: [[0, 0], [640, 0], [0, 360], [640, 360]]
};

async function renderSegment(seg, clips, outPath, job) {
  const byId = new Map(clips.map(c => [c.id, c]));

  let rawMembers = seg.members;
  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    rawMembers = [{ clipId: seg.clipId, start: seg.start }];
  }

  const members = rawMembers
    .map(m => ({ start: Number(m.start) || 0, clip: byId.get(m.clipId) }))
    .filter(m => m.clip)
    .slice(0, MAX_TILES);
  if (members.length === 0) return false;

  const d = String(seg.duration);
  const primary = members[0];

  // --- Comment overlay ASS for this segment ---
  let assPath = null;
  if (job && job.sessionComments && job.sessionComments.length > 0) {
    const canvasW = 1280, canvasH = 720;
    const tileMap = {};

    if (members.length === 1) {
      // Solo: full frame
      tileMap[primary.clip.id] = {
        x: 0, y: 0, w: canvasW, h: canvasH,
        offsetSec: -primary.start // shift so comment timestampMs/1000 - clip.start = segment time
      };
    } else {
      // Multi-tile
      const pos = GRID_POS[members.length];
      members.forEach((m, i) => {
        tileMap[m.clip.id] = {
          x: pos[i][0], y: pos[i][1],
          w: TILE_W, h: TILE_H,
          offsetSec: -m.start
        };
      });
    }

    // Filter session comments to just the ones visible in this segment
    const segComments = [];
    for (const c of job.sessionComments) {
      const tile = tileMap[c.uploadId];
      if (!tile) continue;
      const tInSeg = (tile.offsetSec || 0) + c.timestampMs / 1000;
      if (tInSeg >= -0.5 && tInSeg < seg.duration + 0.5) {
        segComments.push(c);
      }
    }

    if (segComments.length > 0) {
      const result = generateASS(segComments, tileMap, 1280, 720);
      if (result.count > 0) {
        assPath = path.join(job.workDir, `cmt_seg_${path.basename(outPath, '.mp4')}.ass`);
        fs.writeFileSync(assPath, result.ass, 'utf8');
      }
    }
  }

  const assChain = assPath ? `,ass=${escapeFilterPath(assPath)}` : '';

  // --- Single POV: full frame ---
  if (members.length === 1) {
    const args = [
      '-ss', String(primary.start), '-t', d, '-i', primary.clip.path,
      '-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex',
      `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p${assChain}[v]`,
      '-map', '[v]',
      '-map', primary.clip.hasAudio ? '0:a:0' : '1:a:0',
      '-af', 'aresample=async=1000',
      ...ENC, '-shortest', '-y', outPath
    ];
    return runFF(args, RENDER_TIMEOUT_MS, job);
  }

  // --- 2-4 POVs: composite ---
  const pos = GRID_POS[members.length];
  const baseIdx = members.length;
  const silentIdx = members.length + 1;

  const args = [];
  members.forEach(m => args.push('-ss', String(m.start), '-t', d, '-i', m.clip.path));
  args.push('-f', 'lavfi', '-t', d, '-i', 'color=c=black:s=1280x720:r=30');
  args.push('-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo');

  const cell = `scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
               `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;

  const chain = members.map((m, i) => `[${i}:v]${cell}[t${i}]`);
  let prev = `[${baseIdx}:v]`;
  members.forEach((m, i) => {
    const last = i === members.length - 1;
    const outLabel = last ? '[v]' : `[b${i}]`;
    chain.push(`${prev}[t${i}]overlay=${pos[i][0]}:${pos[i][1]}${last ? ',format=yuv420p' + assChain : ''}${outLabel}`);
    prev = `[b${i}]`;
  });

  args.push(
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
    '-map', primary.clip.hasAudio ? '0:a:0' : `${silentIdx}:a:0`,
    '-af', 'aresample=async=1000',
    ...ENC, '-shortest', '-y', outPath
  );
  return runFF(args, RENDER_TIMEOUT_MS, job);
}

// ---------- Util ----------
// Bounded. The previous version had no timeout of any kind, and it runs inside
// runJob on a SINGLE-worker queue: one metadata fetch whose socket stalled
// after headers left runJob awaiting forever, jobRunning stuck true, and every
// reel for every user sitting at "Waiting in queue" until a restart.
function fetchText(url, opts = {}) {
  const idleMs = opts.idleMs || 15000;
  const totalMs = opts.totalMs || 30000;
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024;   // metadata is tiny

  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (fn === reject && req) { try { req.destroy(); } catch (e) {} }
      fn(v);
    };
    const totalTimer = setTimeout(
      () => finish(reject, new Error(`fetchText exceeded ${totalMs}ms`)), totalMs);

    let client;
    try { client = new URL(url).protocol === 'http:' ? http : https; }
    catch (e) { return finish(reject, new Error('fetchText: malformed URL')); }

    req = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('fetch ' + res.statusCode));
      }
      let data = '';
      res.setTimeout(idleMs, () => finish(reject, new Error(`fetchText stalled (${idleMs}ms idle)`)));
      res.on('data', c => {
        data += c;
        if (data.length > maxBytes) finish(reject, new Error('fetchText: response too large'));
      });
      res.on('end', () => finish(resolve, data));
      res.on('error', e => finish(reject, e));
    });
    req.on('error', e => finish(reject, e));
    req.setTimeout(idleMs, () => finish(reject, new Error(`fetchText: connect timeout (${idleMs}ms)`)));
  });
}

module.exports = { initAiReel };