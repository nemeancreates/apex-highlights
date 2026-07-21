// ================================================================
// server/aireel.js — Peak-Abu AI Highlight Reel engine (v0.1.10)
// ================================================================
// Pipeline:
//   1. PREPARE — ensure selected clips exist locally (pull from CDN if purged)
//   2. ANALYZE — FFmpeg extracts loudness (ebur128) + scene-change density
//                per clip -> per-second "intensity" scores. Genre-agnostic,
//                costs $0, runs entirely on the droplet.
//   3. EDIT    — features (NOT video) go to the Anthropic API which returns
//                an Edit Decision List + a written editor's report. Falls
//                back to a built-in heuristic editor if no API key is set
//                or the AI response is invalid.
//   4. RENDER  — FFmpeg renders each EDL segment (solo full-frame, or
//                side-by-side for synced multi-POV moments with the primary
//                POV's in-game audio), concatenates, serves a download link.
//
// Learning loop: user style notes + editor reports accumulate per-game in
// aiprofiles.json and are fed into future prompts, so the editor improves
// per game over time. The report is surfaced to the user.
//
// Env vars:
//   ANTHROPIC_API_KEY  — optional; enables the AI editor (heuristic otherwise)
//   AIREEL_MODEL       — optional; defaults to 'claude-sonnet-4-6'
//   AIREEL_ENABLED     — set to 'false' to disable the feature entirely
//
// NOTE (monetization): endpoints are open during beta. Before public launch,
// gate POST /sessions/:code/aireel behind requireAuth + user.tier in
// ('t3','t4'). Grep for "TIER GATE" below.
// ================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');

const AIREEL_DIR = path.join(os.tmpdir(), 'peak-abu-aireel');
const PROFILE_FILE = path.join(__dirname, 'aiprofiles.json');

const ALLOWED_TARGETS = [15, 30, 60, 90, 120, 180, 300]; // seconds
const MAX_CLIPS = 30;
const SEG_MIN = 4;
const SEG_MAX = 12;
const SEG_DEFAULT = 8;
const OVERLAP_WINDOW_MS = 5000;
const JOB_TTL_MS = 60 * 60 * 1000;
const SESSION_COOLDOWN_MS = 2 * 60 * 1000;
const ANALYZE_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

let D = null; // injected deps: { app, sessions, sanitizeCode, safeError, log, UPLOADS_DIR, downloadToFile }

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
  registerRoutes();
  setInterval(cleanupJobs, 15 * 60 * 1000);
  D.log('info', 'aireel_ready', {
    aiEditor: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.AIREEL_MODEL || 'claude-sonnet-4-6'
  });
}

// ---------- Game profiles (learning store) ----------
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

  app.post('/sessions/:code/aireel', (req, res) => {
    // TIER GATE: before launch, wrap with requireAuth and check
    // req.user.tier in ('t3','t4'). Open during beta.
    const code = D.sanitizeCode(req.params.code);
    if (!code) return D.safeError(res, 400, 'Invalid session code');

    const session = D.sessions.get(code);
    if (!session) return D.safeError(res, 404, 'Session not found');

    const body = req.body || {};
    const targetSec = Number(body.targetSec);
    if (!ALLOWED_TARGETS.includes(targetSec)) {
      return D.safeError(res, 400, `targetSec must be one of ${ALLOWED_TARGETS.join(', ')}`);
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

    const game = typeof body.game === 'string' ? body.game.trim().slice(0, 60) : '';
    const styleNotes = typeof body.styleNotes === 'string' ? body.styleNotes.trim().slice(0, 500) : '';

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId, code, status: 'queued', progress: 'Waiting in queue',
      createdAt: Date.now(), targetSec, game, styleNotes,
      uploads: selected.map(u => ({
        id: u.id, username: u.username,
        videoFile: u.videoFile, videoUrl: u.videoUrl || null,
        metadataFile: u.metadataFile || null, metadataUrl: u.metadataUrl || null
      })),
      outputPath: path.join(AIREEL_DIR, `reel_${jobId}.mp4`),
      workDir: path.join(AIREEL_DIR, `job_${jobId}`),
      report: null, editorEngine: null, fileSize: null
    };

    jobs.set(jobId, job);
    lastRunPerSession.set(code, Date.now());
    recordProfileNote(game, styleNotes);

    D.log('info', 'aireel_job_created', { jobId, session: code, clips: selected.length, targetSec, game });
    res.status(202).json({ jobId });

    jobQueue.push(job);
    pumpQueue();
  });

  app.get('/sessions/:code/aireel/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return D.safeError(res, 404, 'Job not found');
    res.json({
      status: job.status,
      progress: job.progress,
      report: job.status === 'done' ? job.report : null,
      editorEngine: job.status === 'done' ? job.editorEngine : null,
      fileSize: job.fileSize,
      downloadUrl: job.status === 'done' ? `/aireel/${job.id}/download` : null
    });
  });

  app.get('/aireel/:jobId/download', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'done' || !fs.existsSync(job.outputPath)) {
      return D.safeError(res, 404, 'Reel not ready or expired');
    }
    res.download(job.outputPath, `peak-abu-ai-reel-${job.code}.mp4`);
  });
}

// ---------- Job queue ----------
async function pumpQueue() {
  if (jobRunning || jobQueue.length === 0) return;
  jobRunning = true;
  const job = jobQueue.shift();
  try { await runJob(job); }
  catch (e) {
    job.status = 'failed';
    job.progress = 'Internal error';
    D.log('error', 'aireel_job_crashed', { jobId: job.id, error: e.message });
  } finally {
    try { fs.rmSync(job.workDir, { recursive: true, force: true }); } catch (e) {}
    jobRunning = false;
    pumpQueue();
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

// ---------- Pipeline ----------
async function runJob(job) {
  fs.mkdirSync(job.workDir, { recursive: true });
  const sessionDir = path.join(D.UPLOADS_DIR, job.code);

  // 1. PREPARE
  job.status = 'preparing';
  job.progress = 'Fetching clips';
  const clips = [];
  for (const up of job.uploads) {
    let localPath = path.join(sessionDir, up.videoFile);
    if (!fs.existsSync(localPath)) {
      if (!up.videoUrl) { D.log('warn', 'aireel_clip_missing', { jobId: job.id, file: up.videoFile }); continue; }
      const tmp = path.join(job.workDir, `src_${up.id}.mp4`);
      try {
        await D.downloadToFile(up.videoUrl, tmp);
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

  if (clips.length === 0) {
    job.status = 'failed';
    job.progress = 'No usable clips (files missing locally and on CDN)';
    return;
  }

  // 2. ANALYZE
  job.status = 'analyzing';
  for (let i = 0; i < clips.length; i++) {
    job.progress = `Analyzing clip ${i + 1}/${clips.length} (${clips[i].username})`;
    await analyzeClip(clips[i]);
    scoreClip(clips[i]);
  }

  const analyzable = clips.filter(c => c.duration > 2);
  if (analyzable.length === 0) {
    job.status = 'failed';
    job.progress = 'Clips could not be analyzed';
    return;
  }

  // 3. EDIT
  job.status = 'editing';
  job.progress = 'AI editor building the cut';
  let edl, report, engine;
  const aiResult = await tryAnthropicEdl(job, analyzable);
  if (aiResult) { edl = aiResult.edl; report = aiResult.report; engine = 'ai'; }
  else {
    const h = heuristicEdl(job, analyzable);
    edl = h.edl; report = h.report; engine = 'heuristic';
  }

  if (edl.length === 0) {
    job.status = 'failed';
    job.progress = 'No high-action moments found in the selected clips';
    return;
  }

  // 4. RENDER
  job.status = 'rendering';
  const segFiles = [];
  for (let i = 0; i < edl.length; i++) {
    job.progress = `Rendering segment ${i + 1}/${edl.length}`;
    const segPath = path.join(job.workDir, `seg_${String(i).padStart(2, '0')}.mp4`);
    const ok = await renderSegment(edl[i], clips, segPath);
    if (ok) segFiles.push(segPath);
    else D.log('warn', 'aireel_segment_failed', { jobId: job.id, seg: i });
  }

  if (segFiles.length === 0) {
    job.status = 'failed';
    job.progress = 'Rendering failed for all segments';
    return;
  }

  job.progress = 'Stitching final reel';
  const listPath = path.join(job.workDir, 'concat.txt');
  fs.writeFileSync(listPath, segFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

  const concatOk = await runFF([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', '-y', job.outputPath
  ], RENDER_TIMEOUT_MS);

  if (!concatOk || !fs.existsSync(job.outputPath)) {
    job.status = 'failed';
    job.progress = 'Final stitch failed';
    return;
  }

  job.fileSize = fs.statSync(job.outputPath).size;
  job.report = report;
  job.editorEngine = engine;
  job.status = 'done';
  job.progress = 'Ready';
  recordProfileReport(job.game, report);
  D.log('info', 'aireel_done', {
    jobId: job.id, session: job.code, engine,
    segments: segFiles.length, sizeMB: (job.fileSize / 1024 / 1024).toFixed(1)
  });
}

// ---------- Analysis ----------
function runFFCollect(args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-nostats', ...args]);
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, stderr: err }); });
  });
}
function runFF(args, timeoutMs) { return runFFCollect(args, timeoutMs).then(r => r.code === 0); }

async function analyzeClip(clip) {
  const loud = await runFFCollect(['-i', clip.path, '-map', '0:a:0', '-filter:a', 'ebur128', '-f', 'null', '-'], ANALYZE_TIMEOUT_MS);
  const durMatch = loud.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (durMatch) clip.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]);
  const loudRe = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = loudRe.exec(loud.stderr)) !== null) {
    const val = parseFloat(m[2]);
    if (isFinite(val)) clip.loudness.push({ t: parseFloat(m[1]), m: val });
  }
  clip.hasAudio = clip.loudness.length > 0;

  const scene = await runFFCollect(['-i', clip.path, '-vf', "select='gt(scene,0.30)',showinfo", '-f', 'null', '-'], ANALYZE_TIMEOUT_MS);
  if (!clip.duration) {
    const d2 = scene.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (d2) clip.duration = (+d2[1]) * 3600 + (+d2[2]) * 60 + (+d2[3]);
  }
  const sceneRe = /pts_time:([\d.]+)/g;
  while ((m = sceneRe.exec(scene.stderr)) !== null) clip.scenes.push(parseFloat(m[1]));
}

function scoreClip(clip) {
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
    if (picked.some(p => Math.abs(p.t - cand.t) < SEG_MAX)) continue;
    picked.push(cand);
    if (picked.length >= 18) break;
  }
  clip.moments = picked.sort((a, b) => a.t - b.t);
}

// ---------- Heuristic editor ----------
function absTime(clip, t) {
  return clip.startTimeUTC != null
    ? clip.startTimeUTC + t * 1000
    : Number.MIN_SAFE_INTEGER + Math.random() * 1e6;
}

function heuristicEdl(job, clips) {
  const target = job.targetSec;
  const pool = [];
  clips.forEach(c => c.moments.forEach(mm => pool.push({ clip: c, t: mm.t, score: mm.score, abs: absTime(c, mm.t) })));
  pool.sort((a, b) => b.score - a.score);

  const chosen = [];
  let total = 0;
  for (const cand of pool) {
    if (total >= target) break;
    if (chosen.some(ch => ch.clip.id === cand.clip.id && Math.abs(ch.t - cand.t) < SEG_MAX)) continue;
    const dur = Math.min(SEG_DEFAULT, Math.max(SEG_MIN, target - total));
    const start = Math.max(0, Math.min(cand.t - dur * 0.6, cand.clip.duration - dur));
    if (start < 0 || cand.clip.duration < SEG_MIN) continue;
    chosen.push({ clip: cand.clip, t: cand.t, start, duration: dur, score: cand.score, abs: cand.abs });
    total += dur;
  }

  chosen.sort((a, b) => a.abs - b.abs);
  const edl = [];
  const used = new Set();
  for (let i = 0; i < chosen.length; i++) {
    if (used.has(i)) continue;
    const a = chosen[i];
    let partnerIdx = -1;
    for (let j = i + 1; j < chosen.length; j++) {
      if (used.has(j)) continue;
      const b = chosen[j];
      if (b.clip.id !== a.clip.id && Math.abs(b.abs - a.abs) <= OVERLAP_WINDOW_MS) { partnerIdx = j; break; }
    }
    if (partnerIdx >= 0) {
      const b = chosen[partnerIdx];
      used.add(i); used.add(partnerIdx);
      const primary = a.score >= b.score ? a : b;
      const secondary = primary === a ? b : a;
      const dur = Math.max(a.duration, b.duration);
      let secStart = secondary.clip.startTimeUTC != null && primary.clip.startTimeUTC != null
        ? (primary.clip.startTimeUTC + primary.start * 1000 - secondary.clip.startTimeUTC) / 1000
        : secondary.start;
      secStart = Math.max(0, Math.min(secStart, Math.max(0, secondary.clip.duration - dur)));
      edl.push({
        layout: 'side',
        clipId: primary.clip.id, start: round2(primary.start), duration: round2(Math.min(dur, SEG_MAX)),
        partnerClipId: secondary.clip.id, partnerStart: round2(secStart)
      });
    } else {
      used.add(i);
      edl.push({ layout: 'solo', clipId: a.clip.id, start: round2(a.start), duration: round2(a.duration) });
    }
  }

  const soloCount = edl.filter(s => s.layout === 'solo').length;
  const sideCount = edl.length - soloCount;
  const report =
    `Heuristic editor report (${job.game || 'unknown game'}):\n` +
    `Scanned ${clips.length} POV(s) for loudness spikes and on-screen chaos. ` +
    `Selected ${chosen.length} moments totaling ~${Math.round(total)}s against your ${target}s target. ` +
    `${sideCount} moment(s) were captured by multiple squad members at the same real time and were cut side-by-side ` +
    `with the more intense POV leading and carrying the audio; ${soloCount} played solo full-frame. ` +
    `Segments are ordered chronologically. ` +
    `Tip: add style notes ("faster cuts", "hold on clutches longer") — they're saved per game and shape future edits.`;

  return { edl, report };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------- AI editor (Anthropic) ----------
async function tryAnthropicEdl(job, clips) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const profile = getProfileContext(job.game);
  const features = clips.map(c => ({
    clipId: c.id, player: c.username,
    durationSec: round2(c.duration),
    startTimeUTC: c.startTimeUTC,
    hasAudio: c.hasAudio,
    topMoments: c.moments.slice(0, 10).map(m => ({ t: round2(m.t), intensity: round2(m.score) }))
  }));

  const systemPrompt =
    'You are the editing engine for Peak-Abu, a multi-POV gameplay highlight tool. ' +
    'You receive per-clip intensity analysis (loudness + visual chaos scores) and must produce an edit decision list for a highlight reel. ' +
    'Clips from different players that share startTimeUTC-aligned moments show the SAME real play from different POVs — those deserve side-by-side layout with the best POV as primary. ' +
    'Respond with ONLY a JSON object, no markdown fences, no prose, in this exact shape: ' +
    '{"segments":[{"layout":"solo"|"side","clipId":"...","start":<sec>,"duration":<sec 4-12>,"partnerClipId":"...","partnerStart":<sec>}],"report":"<3-6 sentence editor\'s report addressed to the user explaining your choices and what you learned about editing this game>"} ' +
    'Rules: partnerClipId/partnerStart only for layout "side" and must be a different clipId. ' +
    'Total duration must not exceed the target by more than 15%. Order segments for narrative flow (usually chronological, save the best moment for last if it is clearly strongest). ' +
    'start+duration must fit within each clip\'s durationSec. Never invent clipIds.';

  const userPrompt = JSON.stringify({
    game: job.game || 'unknown',
    targetSec: job.targetSec,
    userStyleNotes: job.styleNotes || null,
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
    const edl = validateEdl(parsed.segments, clips, job.targetSec);
    if (!edl || edl.length === 0) throw new Error('EDL failed validation');
    const report = typeof parsed.report === 'string' && parsed.report.trim()
      ? parsed.report.trim().slice(0, 2000)
      : 'AI editor completed the cut.';
    D.log('info', 'aireel_ai_edl_ok', { jobId: job.id, segments: edl.length });
    return { edl, report };
  } catch (e) {
    D.log('warn', 'aireel_ai_fallback', { jobId: job.id, error: e.message });
    return null;
  }
}

function validateEdl(segments, clips, targetSec) {
  if (!Array.isArray(segments)) return null;
  const byId = new Map(clips.map(c => [c.id, c]));
  const out = [];
  let total = 0;
  for (const s of segments) {
    if (!s || typeof s !== 'object') continue;
    const clip = byId.get(String(s.clipId));
    if (!clip) continue;
    let start = Number(s.start), dur = Number(s.duration);
    if (!isFinite(start) || !isFinite(dur)) continue;
    dur = Math.max(SEG_MIN, Math.min(SEG_MAX, dur));
    start = Math.max(0, Math.min(start, Math.max(0, clip.duration - dur)));
    if (clip.duration < SEG_MIN) continue;

    let layout = s.layout === 'side' ? 'side' : 'solo';
    let partnerClipId = null, partnerStart = null;
    if (layout === 'side') {
      const partner = byId.get(String(s.partnerClipId));
      if (partner && partner.id !== clip.id && partner.duration >= SEG_MIN) {
        partnerClipId = partner.id;
        partnerStart = Number(s.partnerStart);
        if (!isFinite(partnerStart)) partnerStart = 0;
        partnerStart = Math.max(0, Math.min(partnerStart, Math.max(0, partner.duration - dur)));
      } else {
        layout = 'solo';
      }
    }

    out.push({ layout, clipId: clip.id, start: round2(start), duration: round2(dur),
               partnerClipId, partnerStart: partnerStart != null ? round2(partnerStart) : null });
    total += dur;
    if (total > targetSec * 1.3) break;
  }
  return out;
}

function anthropicMessage(apiKey, system, user) {
  const body = JSON.stringify({
    model: process.env.AIREEL_MODEL || 'claude-sonnet-4-6',
    max_tokens: 6000,
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

async function renderSegment(seg, clips, outPath) {
  const byId = new Map(clips.map(c => [c.id, c]));
  const clip = byId.get(seg.clipId);
  if (!clip) return false;
  const d = String(seg.duration);

  if (seg.layout === 'side' && seg.partnerClipId) {
    const partner = byId.get(seg.partnerClipId);
    if (!partner) return renderSegment({ ...seg, layout: 'solo' }, clips, outPath);

    const cell = 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,fps=30';
    const args = [
      '-ss', String(seg.start), '-t', d, '-i', clip.path,
      '-ss', String(seg.partnerStart || 0), '-t', d, '-i', partner.path,
      '-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex',
      `[0:v]${cell}[l];[1:v]${cell}[r];[l][r]hstack=inputs=2,pad=1280:720:0:180,format=yuv420p[v]`,
      '-map', '[v]',
      '-map', clip.hasAudio ? '0:a:0' : '2:a:0',
      '-af', 'aresample=async=1000',
      ...ENC, '-shortest', '-y', outPath
    ];
    return runFF(args, RENDER_TIMEOUT_MS);
  }

  const args = [
    '-ss', String(seg.start), '-t', d, '-i', clip.path,
    '-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v]',
    '-map', '[v]',
    '-map', clip.hasAudio ? '0:a:0' : '1:a:0',
    '-af', 'aresample=async=1000',
    ...ENC, '-shortest', '-y', outPath
  ];
  return runFF(args, RENDER_TIMEOUT_MS);
}

// ---------- Util ----------
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('fetch ' + res.statusCode)); }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { initAiReel };
