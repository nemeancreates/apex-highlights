// ================================================================
// client/aireel-client.js — Local AI Reel render engine (client-side)
// ================================================================
// Ported from server/aireel.js's ANALYZE + EDIT(heuristic) + RENDER stages.
// Runs entirely on the user's PC: reads clips already saved locally,
// analyzes them with bundled FFmpeg, builds an edit decision list
// (heuristic — no API call in this phase), renders each segment
// (NVENC first, x264 fallback), concats, writes the finished reel to
// CLIPS_DIR. Nothing here uploads or contacts the server.
//
// NOT ported in this phase: comment overlay (ASS subtitles). Reels built
// here have no on-screen comment bubbles yet — can be added later by
// porting comment-overlay.js the same way.
//
// Pure Node — no `electron` import — so it's independently testable.
// ================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_TILES = 4;
const OVERLAP_WINDOW_MS = 5000;
const ANALYZE_TIMEOUT_MS = 3 * 60 * 1000;
const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const NVENC_FAIL_RE = /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i;

const TILE_W = 640, TILE_H = 360;
const GRID_POS = {
  2: [[0, 180], [640, 180]],
  3: [[0, 0], [640, 0], [320, 360]],
  4: [[0, 0], [640, 0], [0, 360], [640, 360]]
};

function setBelowNormalPriority(pid) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
  catch (e) { /* best-effort — never fatal */ }
}

// ---------- Segment sizing (verbatim from server/aireel.js) ----------
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

function round2(n) { return Math.round(n * 100) / 100; }
function layoutFor(n) { return n >= 3 ? 'grid' : n === 2 ? 'side' : 'solo'; }
function absTime(clip, t) {
  return clip.startTimeUTC != null ? clip.startTimeUTC + t * 1000 : null;
}

// ---------- FFmpeg process helpers ----------
function runFFCollect(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-nostats', ...args], { windowsHide: true });
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
async function analyzeClip(ffmpegPath, clip) {
  const loud = await runFFCollect(ffmpegPath,
    ['-i', clip.path, '-map', '0:a:0', '-filter:a', 'ebur128', '-f', 'null', '-'], ANALYZE_TIMEOUT_MS);
  const durMatch = loud.stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (durMatch) clip.duration = (+durMatch[1]) * 3600 + (+durMatch[2]) * 60 + (+durMatch[3]);
  const loudRe = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  let m;
  while ((m = loudRe.exec(loud.stderr)) !== null) {
    const val = parseFloat(m[2]);
    if (isFinite(val)) clip.loudness.push({ t: parseFloat(m[1]), m: val });
  }
  clip.hasAudio = clip.loudness.length > 0;

  const scene = await runFFCollect(ffmpegPath,
    ['-i', clip.path, '-vf', "select='gt(scene,0.30)',showinfo", '-f', 'null', '-'], ANALYZE_TIMEOUT_MS);
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

// ---------- HEURISTIC EDITOR (verbatim logic, parameterized — no `job`) ----------
function heuristicEdl({ target, seg, clips, game, clamped, requestedTargetSec }) {
  const SEG = seg || { min: 4, max: 12, def: 8 };
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
  const clampNote = clamped
    ? `Your ${requestedTargetSec}s request was trimmed to ${target}s — that's all the footage the selected clips hold. `
    : '';
  const report =
    `Local editor report (${game || 'unknown game'}):\n` + clampNote +
    `Scanned ${clips.length} POV(s) for loudness spikes and on-screen chaos. ` +
    `Selected ${chosen.length} moments totaling ~${Math.round(total)}s against your ${target}s target ` +
    `at ~${SEG.def}s per cut. ` +
    `${counts.grid} moment(s) had 3-4 squad members recording the same real-world instant and were cut as a grid; ` +
    `${counts.side} were cut side-by-side; ${counts.solo} played solo full-frame. ` +
    `The most intense POV leads each multi-view shot and carries the audio. Segments are ordered chronologically. ` +
    `Rendered locally on your PC — nothing was uploaded.`;

  return { edl, report };
}

// ---------- RENDER ----------
function encoderArgs(useCpu, threadCap) {
  if (useCpu) {
    return {
      video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', String(threadCap || 4)],
      audio: ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
    };
  }
  return {
    video: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '8M'],
    audio: ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
  };
}

async function renderSegment(ffmpegPath, seg, clipsById, outPath, opts) {
  let rawMembers = seg.members;
  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    rawMembers = [{ clipId: seg.clipId, start: seg.start }];
  }
  const members = rawMembers
    .map(m => ({ start: Number(m.start) || 0, clip: clipsById.get(m.clipId) }))
    .filter(m => m.clip)
    .slice(0, MAX_TILES);
  if (members.length === 0) return { ok: false, nvencFailed: false };

  const d = String(seg.duration);
  const primary = members[0];
  const enc = encoderArgs(opts.useCpuEncoder, opts.threadCap);

  let args;
  if (members.length === 1) {
    args = [
      '-ss', String(primary.start), '-t', d, '-i', primary.clip.path,
      '-f', 'lavfi', '-t', d, '-i', 'anullsrc=r=48000:cl=stereo',
      '-filter_complex',
      `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v]`,
      '-map', '[v]',
      '-map', primary.clip.hasAudio ? '0:a:0' : '1:a:0',
      '-af', 'aresample=async=1000',
      ...enc.video, ...enc.audio, '-shortest', '-y', outPath
    ];
  } else {
    const pos = GRID_POS[members.length];
    const baseIdx = members.length;
    const silentIdx = members.length + 1;
    args = [];
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
      chain.push(`${prev}[t${i}]overlay=${pos[i][0]}:${pos[i][1]}${last ? ',format=yuv420p' : ''}${outLabel}`);
      prev = `[b${i}]`;
    });

    args.push(
      '-filter_complex', chain.join(';'),
      '-map', '[v]',
      '-map', primary.clip.hasAudio ? '0:a:0' : `${silentIdx}:a:0`,
      '-af', 'aresample=async=1000',
      ...enc.video, ...enc.audio, '-shortest', '-y', outPath
    );
  }

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

    const clips = clipsInput.map(c => ({
      id: c.id, username: c.username, path: c.path,
      startTimeUTC: typeof c.startTimeUTC === 'number' ? c.startTimeUTC : null,
      duration: 0, hasAudio: false, loudness: [], scenes: [], moments: []
    }));

    const existing = clips.filter(c => c.path && fs.existsSync(c.path));
    if (existing.length === 0) {
      return { ok: false, error: 'None of the selected clips exist on disk' };
    }

    // ANALYZE
    onProgress({ stage: 'analyzing', detail: `0/${existing.length}` });
    for (let i = 0; i < existing.length; i++) {
      onProgress({ stage: 'analyzing', detail: `${i + 1}/${existing.length} (${existing[i].username})` });
      await analyzeClip(ffmpegPath, existing[i]);
    }

    const analyzable = existing.filter(c => c.duration > 2);
    if (analyzable.length === 0) {
      return { ok: false, error: 'Clips could not be analyzed (unreadable or corrupt video)' };
    }

    // Clamp target to available footage — same 90% rule as the server pipeline.
    const totalSource = analyzable.reduce((sum, c) => sum + c.duration, 0);
    const maxClipDur = Math.max(...analyzable.map(c => c.duration));
    const effectiveTarget = Math.min(targetSec, Math.floor(totalSource * 0.9));
    const clamped = effectiveTarget < targetSec;
    const seg = segmentBounds(effectiveTarget, maxClipDur);

    if (effectiveTarget < seg.min) {
      return {
        ok: false,
        error: `Not enough usable footage to build a reel (need at least ${seg.min}s, ` +
               `have ~${Math.round(totalSource * 0.9)}s across ${analyzable.length} clip(s))`
      };
    }

    const maxMoments = Math.min(60, Math.max(18, Math.ceil(effectiveTarget / seg.def) + 5));
    for (const c of analyzable) scoreClip(c, seg.max, maxMoments);

    // EDIT (heuristic — no API call in this phase)
    onProgress({ stage: 'editing' });
    const { edl, report } = heuristicEdl({
      target: effectiveTarget, seg, clips: analyzable, game, clamped, requestedTargetSec: targetSec
    });

    if (edl.length === 0) {
      return { ok: false, error: 'No high-action moments found in the selected clips' };
    }

    // RENDER
    const clipsById = new Map(clips.map(c => [c.id, c]));
    let useCpuEncoder = false;
    const segFiles = [];

    for (let i = 0; i < edl.length; i++) {
      onProgress({ stage: 'rendering', detail: `${i + 1}/${edl.length}` });
      const segPath = path.join(workDir, `seg_${String(i).padStart(2, '0')}.mp4`);

      let result = await renderSegment(ffmpegPath, edl[i], clipsById, segPath, { useCpuEncoder, threadCap });

      // First NVENC failure on any segment: fall back to CPU for the rest
      // of this render, and retry the failed segment once under x264.
      if (!result.ok && result.nvencFailed) {
        useCpuEncoder = true;
        onProgress({ stage: 'encoder-fallback', detail: 'GPU encode unavailable — switching to CPU' });
        result = await renderSegment(ffmpegPath, edl[i], clipsById, segPath, { useCpuEncoder, threadCap });
      }

      if (result.ok) segFiles.push(segPath);
      // else: skip this segment and keep going — a partial reel still beats none
    }

    if (segFiles.length === 0) {
      return { ok: false, error: 'Rendering failed for every segment — check FFmpeg build / GPU driver' };
    }

    onProgress({ stage: 'stitching' });
    const listPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(listPath, segFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

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

module.exports = { buildReelLocally, segmentBounds, heuristicEdl, scoreClip, analyzeClip };