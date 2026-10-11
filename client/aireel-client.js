// ================================================================
// client/aireel-client.js — Local AI Reel render engine (client-side)
// ================================================================
// Runs entirely on the user's PC: reads clips already saved locally,
// measures their loudness with bundled FFmpeg, has reel-editor.js build
// the cut, renders each shot (NVENC first, x264 fallback), joins them and
// writes the finished reel to CLIPS_DIR. Nothing here uploads or contacts
// the server.
//
// v2 (10-10-26): the cut comes from reel-editor.js (the same file the
// server uses; see it for what changed and why). Analysis is audio-only,
// so it no longer decodes every video frame. Each clip's sidecar .json
// supplies its frame rate and whether its highlight is starred.
//
// Not here: comment overlay and comment directions (comments live on the
// server), and the AI editor (server tiers only).
//
// Pure Node — no `electron` import — so it's independently testable.
// ================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const editor = require('./reel-editor');

const ANALYZE_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const NVENC_FAIL_RE = /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i;

function setBelowNormalPriority(pid) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
  catch (e) { /* best-effort — never fatal */ }
}

// ---------- FFmpeg process helpers ----------
function runFFCollect(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-nostats', ...args], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']
    });
    if (p.pid) setBelowNormalPriority(p.pid);
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 4e6) err = err.slice(-2e6); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, stderr: err }); });
  });
}
function runFF(ffmpegPath, args, timeoutMs) {
  return runFFCollect(ffmpegPath, args, timeoutMs).then(r => ({ ok: r.code === 0, stderr: r.stderr }));
}

// ---------- ANALYZE ----------
// Loudness over time, plus length and frame rate from ffmpeg's description
// of the file. Only the audio track is read.
async function analyzeClip(ffmpegPath, clip) {
  const loud = await runFFCollect(ffmpegPath,
    ['-i', clip.path, '-map', '0:a:0', '-filter:a', 'ebur128', '-f', 'null', '-'], ANALYZE_TIMEOUT_MS);
  const durMatch = loud.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (durMatch) clip.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]);
  const fpsMatch = loud.stderr.match(/Video:.*?([\d.]+)\s*fps/);
  if (fpsMatch && !clip.fps) clip.fps = parseFloat(fpsMatch[1]) || 0;
  const loudRe = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = loudRe.exec(loud.stderr)) !== null) {
    const val = parseFloat(m[2]);
    if (isFinite(val)) clip.loudness.push({ t: parseFloat(m[1]), m: val });
  }
  clip.hasAudio = clip.loudness.length > 0;
}

// What the clip's sidecar (.json beside the .mp4) knows that the reel
// window doesn't pass along.
function readSidecar(videoPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(videoPath.replace(/\.mp4$/i, '.json'), 'utf8'));
    return {
      startTimeUTC: typeof meta.startTimeUTC === 'number' ? meta.startTimeUTC : null,
      fps: Number(meta.frameRate) || 0,
      starred: meta.starred === true
    };
  } catch (e) {
    return { startTimeUTC: null, fps: 0, starred: false };
  }
}

// ---------- RENDER ----------
function encoderArgs(useCpu, threadCap) {
  const audio = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
  if (useCpu) {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-threads', String(threadCap || 4)].concat(audio);
  }
  return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '8M', '-pix_fmt', 'yuv420p'].concat(audio);
}

async function renderSegment(ffmpegPath, seg, clipsById, outPath, opts) {
  const args = editor.segmentArgs(seg, (id) => clipsById.get(id),
    { encoder: encoderArgs(opts.useCpuEncoder, opts.threadCap), outPath });
  if (!args) return { ok: false, nvencFailed: false };
  const result = await runFF(ffmpegPath, args, RENDER_TIMEOUT_MS);
  const nvencFailed = !opts.useCpuEncoder && !result.ok && NVENC_FAIL_RE.test(result.stderr);
  return { ok: result.ok, nvencFailed, stderr: result.stderr };
}

// ---------- ORCHESTRATION ----------
// clips: [{ id, username, path, startTimeUTC }] — path must exist on disk.
// Returns { ok, outputPath, report, ... } or { ok: false, error }.
// Never throws — every failure mode returns a structured result so the
// caller (main.js IPC handler) always has something safe to send back.
async function buildReelLocally({
  ffmpegPath, workDir, outputPath,
  clips: clipsInput, targetSec, game, styleNotes,
  threadCap = 4, onProgress = () => {}
}) {
  try {
    if (!Array.isArray(clipsInput) || clipsInput.length === 0) {
      return { ok: false, error: 'No clips provided' };
    }
    if (!Number.isFinite(targetSec) || targetSec <= 0) {
      return { ok: false, error: 'Invalid target length' };
    }
    fs.mkdirSync(workDir, { recursive: true });

    const clips = clipsInput.filter(c => c && c.path && fs.existsSync(c.path)).map(c => {
      const side = readSidecar(c.path);
      return {
        id: c.id, username: c.username, path: c.path,
        startTimeUTC: typeof c.startTimeUTC === 'number' ? c.startTimeUTC : side.startTimeUTC,
        fps: side.fps, starred: side.starred,
        duration: 0, hasAudio: false, loudness: []
      };
    });
    if (clips.length === 0) {
      return { ok: false, error: 'None of the selected clips exist on disk' };
    }

    // ANALYZE
    onProgress({ stage: 'analyzing', detail: `0/${clips.length}` });
    for (let i = 0; i < clips.length; i++) {
      onProgress({ stage: 'analyzing', detail: `${i + 1}/${clips.length} (${clips[i].username})` });
      await analyzeClip(ffmpegPath, clips[i]);
    }

    const analyzable = clips.filter(c => c.duration > 2);
    if (analyzable.length === 0) {
      return { ok: false, error: 'Clips could not be analyzed (unreadable or corrupt video)' };
    }

    // EDIT
    onProgress({ stage: 'editing' });
    const ctx = editor.prepare({
      targetSec, game, styleNotes, localOnly: true,
      clips: analyzable.map(c => ({
        id: c.id, player: c.username, duration: c.duration, startTimeUTC: c.startTimeUTC,
        hasAudio: c.hasAudio, fps: c.fps, starred: c.starred, loudness: c.loudness
      }))
    });
    const { edl, report } = editor.buildPlan(ctx);
    const clamped = ctx.uniqueSec < targetSec - 1;
    if (edl.length === 0) {
      return { ok: false, error: 'No usable moments found in the selected clips' };
    }

    // RENDER
    const clipsById = new Map(clips.map(c => [c.id, c]));
    let useCpuEncoder = false;
    const segFiles = [];

    for (let i = 0; i < edl.length; i++) {
      onProgress({ stage: 'rendering', detail: `${i + 1}/${edl.length}` });
      const segPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);

      let result = await renderSegment(ffmpegPath, edl[i], clipsById, segPath, { useCpuEncoder, threadCap });

      // First NVENC failure on any segment: fall back to CPU for the WHOLE
      // reel (segments are joined without re-encoding, so they must all come
      // from the same encoder) and start the render over.
      if (!result.ok && result.nvencFailed) {
        useCpuEncoder = true;
        onProgress({ stage: 'encoder-fallback', detail: 'GPU encode unavailable — switching to CPU' });
        segFiles.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
        segFiles.length = 0;
        i = -1;
        continue;
      }

      if (result.ok) segFiles.push(segPath);
      // else: skip this segment and keep going — a partial reel still beats none
    }

    if (segFiles.length === 0) {
      return { ok: false, error: 'Rendering failed for every segment — check FFmpeg build / GPU driver' };
    }

    onProgress({ stage: 'stitching' });
    const listPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(listPath, segFiles.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));

    const concat = await runFF(ffmpegPath, [
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', '-y', outputPath
    ], RENDER_TIMEOUT_MS);

    if (!concat.ok || !fs.existsSync(outputPath)) {
      return { ok: false, error: 'Final stitch failed' };
    }

    return {
      ok: true,
      outputPath,
      report,
      fileSize: fs.statSync(outputPath).size,
      segmentsRendered: segFiles.length,
      segmentsRequested: edl.length,
      usedCpuFallback: useCpuEncoder,
      clamped
    };
  } catch (e) {
    return { ok: false, error: `Unexpected error: ${e.message}` };
  }
}

module.exports = { buildReelLocally, analyzeClip };
