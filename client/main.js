const { app, BrowserWindow, globalShortcut, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const NTPClient = require('ntp-time').Client;
const FormData = require('form-data');
const https = require('https');

function getFFmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  return path.join(__dirname, 'ffmpeg', 'ffmpeg.exe');
}

// Default paths (will be overridden by user preferences)
const DEFAULT_BUFFER_DIR = path.join(os.tmpdir(), 'apex-highlights-buffer');
const DEFAULT_CLIPS_DIR = path.join(app.getPath('videos'), 'PeakAbu');
const USER_PREFS_PATH = path.join(app.getPath('userData'), 'user-preferences.json');
const CHUNK_SECONDS = 10;

// User-configurable paths (loaded from preferences)
let BUFFER_DIR = DEFAULT_BUFFER_DIR;
let CLIPS_DIR = DEFAULT_CLIPS_DIR;

// Settings (adjustable from UI)
let maxChunks = 18;
let recordFps = 30;
let recordResolution = null; // null = native, or { width, height }
let customHotkey = 'F9';
let captureHdr = false;      // HDR monitor fix — tonemaps HDR desktop to correct SDR colors

let clockOffset = 0;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let audioBuffers = [];
let authToken = null;
let useCpuEncoder = false;
let currentMonitor = null;
let videoStartTime = null;
let audioFirstChunkTime = null;
let bufferReadyWatcher = null;
let recordingStartTime = null;
let lastHighlightBoundary = 0;

// ================================
// CAPTURE ENGINE LADDER
// ================================
// Ordered list of capture+encode strategies. On early FFmpeg failure we
// automatically advance to the next engine, so users always end up with
// a working recording even on unusual GPU/driver/monitor setups.
//
//   dda-nvenc      ddagrab -> h264_nvenc, frames never leave the GPU (fastest, lowest game impact)
//   dda-nvenc-vf   ddagrab -> hwdownload -> scale -> nvenc (used when downscaling to 720/480)
//   dda-hdr-nvenc  ddagrab 10-bit -> HDR->SDR tonemap -> nvenc (fixes washed-out HDR monitors)
//   dda-hdr-x264   same tonemap chain, CPU encode
//   dda-x264       ddagrab -> hwdownload -> libx264 (DDA capture is still much lighter than gdigrab)
//   gdi-nvenc      legacy gdigrab -> nvenc (previous default — safety net)
//   gdi-x264       legacy gdigrab -> libx264 (final safety net, works everywhere)
//
// Requires an FFmpeg build that includes the ddagrab and zscale filters
// (gyan.dev "full" build). If the bundled build lacks them, the ladder
// simply falls through to the gdigrab engines.
let engineLadder = [];
let engineIndex = 0;
let stoppingIntentionally = false;

const ENGINE_LABELS = {
  'dda-nvenc':     'GPU capture + GPU encode (zero-copy)',
  'dda-nvenc-vf':  'GPU capture + GPU encode (scaled)',
  'dda-hdr-nvenc': 'GPU capture + HDR tonemap + GPU encode',
  'dda-hdr-x264':  'GPU capture + HDR tonemap + CPU encode',
  'dda-x264':      'GPU capture + CPU encode',
  'gdi-nvenc':     'Legacy capture + GPU encode',
  'gdi-x264':      'Legacy capture + CPU encode'
};

function buildEngineLadder() {
  const l = [];
  if (captureHdr) {
    if (!useCpuEncoder) l.push('dda-hdr-nvenc');
    l.push('dda-hdr-x264');
    if (!useCpuEncoder) l.push('gdi-nvenc');
    l.push('gdi-x264');
  } else {
    if (!useCpuEncoder) {
      if (!recordResolution) l.push('dda-nvenc'); // zero-copy path is native-res only
      l.push('dda-nvenc-vf');
      l.push('gdi-nvenc');
    }
    l.push('dda-x264');
    l.push('gdi-x264');
  }
  return l;
}

// Nudge FFmpeg below normal priority so a capture spike never steals frame
// time from the game. (wmic is deprecated on Win11 — use PowerShell instead.)
function setBelowNormalPriority(pid) {
  try {
    spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `(Get-Process -Id ${pid}).PriorityClass='BelowNormal'`
    ], { windowsHide: true });
  } catch (e) {
    console.log('Priority adjust skipped:', e.message);
  }
}

// ================================
// MIC AUDIO BUFFERS
// ================================
let micBuffers = [];
let micFirstChunkTime = null;
let micVolume = 80;
let micMuted = false;

function ensureFolders() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

function loadUserPreferences() {
  try {
    if (fs.existsSync(USER_PREFS_PATH)) {
      const data = fs.readFileSync(USER_PREFS_PATH, 'utf8');
      const prefs = JSON.parse(data);

      if (prefs.storageDirectory && fs.existsSync(prefs.storageDirectory)) {
        CLIPS_DIR = path.join(prefs.storageDirectory, 'PeakAbu');
        BUFFER_DIR = path.join(prefs.storageDirectory, '.apex-highlights-buffer');
      }

      if (prefs.hotkey && isValidHotkey(prefs.hotkey)) {
        customHotkey = prefs.hotkey;
        console.log(`Loaded user hotkey preference: ${customHotkey}`);
      }

      if (typeof prefs.captureHdr === 'boolean') {
        captureHdr = prefs.captureHdr;
        console.log(`Loaded HDR capture preference: ${captureHdr}`);
      }

      console.log(`Loaded preferences: storageDir=${CLIPS_DIR}`);
      return prefs;
    }
  } catch (err) {
    console.log('Could not load user preferences:', err.message);
  }
  return {};
}

function saveUserPreferences(prefs) {
  try {
    fs.writeFileSync(USER_PREFS_PATH, JSON.stringify(prefs, null, 2));
    console.log('User preferences saved');
  } catch (err) {
    console.log('Could not save user preferences:', err.message);
  }
}

function isValidHotkey(hotkey) {
  if (typeof hotkey !== 'string') return false;
  const parts = hotkey.split('+');
  if (parts.length === 0 || parts.length > 4) return false;
  const modifiers = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl', 'Command', 'Control'];
  for (let i = 0; i < parts.length - 1; i++) {
    if (!modifiers.includes(parts[i])) return false;
  }
  const lastPart = parts[parts.length - 1];
  if (!(/^F([1-9]|1[0-2])$/.test(lastPart) || /^[A-Z0-9]$/.test(lastPart) ||
        ['Backspace', 'Delete', 'Enter', 'Space', 'Tab', 'Up', 'Down', 'Left', 'Right'].includes(lastPart))) {
    return false;
  }
  return true;
}

function onHotkeyPressed() {
  console.log(`${customHotkey} pressed — routing to renderer save path`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-save-pressed');
  } else {
    saveHighlight();
  }
}

function startBufferReadyWatcher() {
  stopBufferReadyWatcher();
  bufferReadyWatcher = setInterval(() => {
    try {
      const chunks = fs.readdirSync(BUFFER_DIR)
        .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
        .map(f => ({ name: f, size: fs.statSync(path.join(BUFFER_DIR, f)).size }));

      const elapsedMs = recordingStartTime ? (Date.now() - recordingStartTime) : 0;
      const ready = elapsedMs >= 15000 &&
        (chunks.length >= 2 || chunks.some(c => c.size > 1000000));

      if (ready) {
        stopBufferReadyWatcher();
        console.log('Buffer ready — first complete chunk detected');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('buffer-ready');
        }
      }
    } catch (e) { /* buffer dir momentarily unreadable */ }
  }, 1000);
}

function stopBufferReadyWatcher() {
  if (bufferReadyWatcher) {
    clearInterval(bufferReadyWatcher);
    bufferReadyWatcher = null;
  }
}

async function syncClock() {
  try {
    const client = new NTPClient('pool.ntp.org', 123, { timeout: 5000 });
    const packet = await client.syncTime();
    const serverTimeMs = (packet.transmitTimestamp - 2208988800) * 1000;
    clockOffset = serverTimeMs - Date.now();
    console.log(`Clock synced. Local offset from true UTC: ${clockOffset.toFixed(2)}ms`);
  } catch (err) {
    console.log('NTP sync failed, using local clock:', err.message);
    clockOffset = 0;
  }
}

function getPreciseUTC() { return Date.now() + clockOffset; }

function pruneOldChunks() {
  const files = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  while (files.length > maxChunks) {
    const oldest = files.shift();
    try { fs.unlinkSync(path.join(BUFFER_DIR, oldest.name)); }
    catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') console.log('Skipping locked chunk:', oldest.name);
      else console.log('Prune error:', err.message);
    }
  }
}

// ================================
// FFMPEG ARG BUILDER — per capture engine
// ================================
function buildCaptureArgs(engine, monitor) {
  const chunkPattern = path.join(BUFFER_DIR, 'chunk_%03d.mp4');
  const fpsStr = String(recordFps);

  // gdigrab geometry (legacy engines only)
  const screen = require('electron').screen;
  const displays = screen.getAllDisplays();
  const target = monitor !== undefined && displays[monitor] ? displays[monitor] : displays[0];
  const scale = target.scaleFactor || 1;
  const gx = Math.round(target.bounds.x * scale);
  const gy = Math.round(target.bounds.y * scale);
  let gw = Math.round(target.bounds.width * scale);
  let gh = Math.round(target.bounds.height * scale);
  gw -= gw % 2; gh -= gh % 2;

  const bitrate = recordResolution
    ? (recordResolution.height <= 480 ? '3M' : '5M')
    : '8M';

  const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate];
  const x264Args  = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];

  const segmentArgs = [
    '-g', fpsStr, '-keyint_min', fpsStr,
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-an',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1', '-y', chunkPattern
  ];

  const scaleTail = recordResolution ? `,scale=-2:${recordResolution.height}` : '';

  // Desktop Duplication input — GPU capture, no BitBlt, no DWM slow path
  const ddaInput = (tenBit) => [
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${monitor || 0}:framerate=${recordFps}${tenBit ? ':output_fmt=10bit' : ''}`
  ];

  const ddaCpuVf = `hwdownload,format=bgra${scaleTail},format=yuv420p`;

  // HDR -> SDR tonemap chain. HDR desktop hands us PQ / BT.2020 pixels;
  // encoding as-is => washed out & gamma-lifted (Cabbam's bug).
  // Tag colors -> linearize -> Hable tonemap -> BT.709 SDR.
  const hdrVf =
    'hwdownload,format=x2bgr10le,' +
    'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,' +
    'zscale=t=linear:npl=200,format=gbrpf32le,zscale=p=bt709,' +
    'tonemap=hable:desat=0,' +
    'zscale=t=bt709:m=bt709:r=tv' +
    scaleTail + ',format=yuv420p';

  const gdiInput = [
    '-f', 'gdigrab', '-framerate', fpsStr,
    '-offset_x', String(gx), '-offset_y', String(gy),
    '-video_size', `${gw}x${gh}`, '-i', 'desktop'
  ];
  const gdiScale = recordResolution ? ['-vf', `scale=-2:${recordResolution.height}`] : [];

  switch (engine) {
    case 'dda-nvenc':
      return [...ddaInput(false), ...nvencArgs, ...segmentArgs];
    case 'dda-nvenc-vf':
      return [...ddaInput(false), '-vf', ddaCpuVf, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-nvenc':
      return [...ddaInput(true), '-vf', hdrVf, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-x264':
      return [...ddaInput(true), '-vf', hdrVf, ...x264Args, ...segmentArgs];
    case 'dda-x264':
      return [...ddaInput(false), '-vf', ddaCpuVf, ...x264Args, ...segmentArgs];
    case 'gdi-nvenc':
      return [...gdiInput, ...gdiScale, ...nvencArgs, ...segmentArgs];
    case 'gdi-x264':
    default:
      return [...gdiInput, ...gdiScale, ...x264Args, '-pix_fmt', 'yuv420p', ...segmentArgs];
  }
}

function startRecording(monitor) {
  ensureFolders();
  currentMonitor = monitor;

  // Skip NVENC engines if the encoder already proved broken this session
  while (
    engineIndex < engineLadder.length &&
    useCpuEncoder &&
    engineLadder[engineIndex].includes('nvenc')
  ) {
    engineIndex++;
  }

  if (engineIndex >= engineLadder.length) {
    console.log('All capture engines exhausted — cannot record');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-error',
        'All capture methods failed. Check GPU drivers and make sure the bundled FFmpeg is a full build (ddagrab/zscale).');
    }
    return;
  }

  const engine = engineLadder[engineIndex];
  const ffmpegArgs = buildCaptureArgs(engine, monitor);

  console.log(`Recording monitor ${monitor} with engine [${engine}] — ${ENGINE_LABELS[engine]}`);
  console.log(`Settings: ${recordFps}fps, resolution: ${recordResolution ? recordResolution.width + 'x' + recordResolution.height : 'native'}, buffer: ${maxChunks * CHUNK_SECONDS}s, HDR fix: ${captureHdr}`);
  console.log('FFmpeg args:', ffmpegArgs.join(' '));

  ffmpegProcess = spawn(getFFmpegPath(), ffmpegArgs, { windowsHide: true });

  if (ffmpegProcess.pid) setBelowNormalPriority(ffmpegProcess.pid);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture-engine', ENGINE_LABELS[engine]);
    if (captureHdr && engine.startsWith('gdi')) {
      mainWindow.webContents.send('capture-engine',
        '⚠ HDR tonemap unavailable in this FFmpeg build — colors may look washed out. Bundle the gyan.dev FULL build.');
    }
  }

  const spawnStartTime = Date.now();
  videoStartTime = spawnStartTime;
  recordingStartTime = spawnStartTime;
  lastHighlightBoundary = 0;
  audioFirstChunkTime = null;
  micFirstChunkTime = null;
  let stderrTail = '';

  startBufferReadyWatcher();

  ffmpegProcess.on('error', (err) => {
    const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
    fs.appendFileSync(logPath, 'SPAWN ERROR: ' + err.message + '\n');
    console.log('FFmpeg spawn error:', err.message);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const text = data.toString();
    console.log('FFmpeg:', text);
    const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
    fs.appendFileSync(logPath, text);
    stderrTail = (stderrTail + text).slice(-3000);
    pruneOldChunks();
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`FFmpeg [${engine}] stopped with code`, code);
    if (stoppingIntentionally) return;

    const ranForMs = Date.now() - spawnStartTime;
    const earlyFailure = code !== 0 && ranForMs < 6000;

    if (earlyFailure) {
      const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
      fs.appendFileSync(logPath, `\n=== ENGINE [${engine}] FAILED (code ${code}, ${ranForMs}ms) — trying next engine ===\n`);
      console.log(`Engine [${engine}] failed early — advancing ladder. Tail:`, stderrTail.slice(-400));

      if (engine.includes('nvenc') && /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i.test(stderrTail)) {
        useCpuEncoder = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('encoder-fallback', 'CPU');
        }
      }

      engineIndex++;
      startRecording(currentMonitor);
    }
  });
}

// ================================
// SAVE HIGHLIGHT
// ================================
function saveHighlight(coordinatedTimestamp = null, clipDurationMs = null) {
  const duration = clipDurationMs || 30000;
  const postDelay = Math.ceil(duration * 0.1);
  const clipChunks = Math.ceil(duration / (CHUNK_SECONDS * 1000));
  const saveTimeUTC = coordinatedTimestamp || getPreciseUTC();

  if (postDelay > 500) {
    console.log(`Post-capture: waiting ${postDelay}ms for remaining footage (${(duration / 1000)}s clip, ${clipChunks} chunks)...`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('post-capture-started', { postDelay });
    }
    setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, duration), postDelay);
  } else {
    doSaveHighlight(saveTimeUTC, clipChunks, duration);
  }
}

function doSaveHighlight(saveTimeUTC, clipChunks, durationMs) {
  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
    .map(f => ({
      name: f, path: path.join(BUFFER_DIR, f),
      time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs,
      size: fs.statSync(path.join(BUFFER_DIR, f)).size
    }))
    .filter(f => f.size > 100000)
    .sort((a, b) => a.time - b.time);

  const withoutInProgress = allVideoFiles.slice(0, -1);
  const newSinceLastSave = withoutInProgress.filter(f => f.time > lastHighlightBoundary);
  const videoFiles = newSinceLastSave.slice(-clipChunks);

  if (videoFiles.length === 0) {
    console.log('No completed chunks yet');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-error', 'Buffer not ready yet, wait a few more seconds');
    }
    return;
  }

  lastHighlightBoundary = videoFiles[videoFiles.length - 1].time;

  const hasAudio = audioBuffers.length > 0;
  const hasMic = micBuffers.length > 0 && !micMuted;
  console.log(`Saving highlight: ${videoFiles.length}/${clipChunks} chunks, ${audioBuffers.length} audio, ${micBuffers.length} mic (clip: ${durationMs / 1000}s)`);

  const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

  const oldestChunkTime = videoFiles[0].time;
  const chunkAgeMs = Date.now() - oldestChunkTime;
  const startTimeUTC = saveTimeUTC - chunkAgeMs;

  const metadata = {
    version: 1,
    saveTimeUTC, startTimeUTC, endTimeUTC: saveTimeUTC,
    durationMs: chunkAgeMs, clipDurationMs: durationMs,
    frameRate: recordFps, clockOffsetMs: clockOffset,
    userId: null,
    sessionId: currentSession ? currentSession.code : null,
    coordinated_timestamp: null
  };

  const videoListPath = path.join(BUFFER_DIR, 'filelist_' + Date.now() + '.txt');
  const videoContent = videoFiles.map(f => `file '${f.path.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(videoListPath, videoContent);

  if (hasAudio) {
    const combinedAudio = Buffer.concat(audioBuffers.map(c => c.data));
    const tempId = Date.now();
    const rawAudioPath = path.join(BUFFER_DIR, 'temp_audio_raw_' + tempId + '.webm');
    const tempAudioPath = path.join(BUFFER_DIR, 'temp_audio_' + tempId + '.webm');
    fs.writeFileSync(rawAudioPath, combinedAudio);

    let rawMicPath = null, tempMicPath = null;
    if (hasMic) {
      const combinedMic = Buffer.concat(micBuffers.map(c => c.data));
      rawMicPath = path.join(BUFFER_DIR, 'temp_mic_raw_' + tempId + '.webm');
      tempMicPath = path.join(BUFFER_DIR, 'temp_mic_' + tempId + '.webm');
      fs.writeFileSync(rawMicPath, combinedMic);
    }

    const tempVideoPath = path.join(BUFFER_DIR, 'temp_video_' + tempId + '.mp4');
    const concatVideo = spawn(getFFmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', videoListPath,
      '-c', 'copy', '-y', tempVideoPath
    ]);
    concatVideo.stderr.on('data', d => console.log('ConcatVideo:', d.toString()));

    concatVideo.on('close', (videoCode) => {
      if (videoCode !== 0) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-error', 'Failed to concat video');
        }
        return;
      }

      const repairAudio = spawn(getFFmpegPath(), [
        '-fflags', '+genpts', '-i', rawAudioPath,
        '-c:a', 'copy', '-y', tempAudioPath
      ]);
      repairAudio.stderr.on('data', d => console.log('RepairAudio:', d.toString()));
      repairAudio.on('close', (repairCode) => {
        if (repairCode !== 0 || !fs.existsSync(tempAudioPath)) {
          try { fs.copyFileSync(rawAudioPath, tempAudioPath); } catch (e) {}
        }

        if (hasMic && rawMicPath) {
          const repairMic = spawn(getFFmpegPath(), [
            '-fflags', '+genpts', '-i', rawMicPath,
            '-c:a', 'copy', '-y', tempMicPath
          ]);
          repairMic.stderr.on('data', d => console.log('RepairMic:', d.toString()));
          repairMic.on('close', (micRepairCode) => {
            if (micRepairCode !== 0 || !fs.existsSync(tempMicPath)) runMerge(false);
            else runMerge(true);
          });
        } else {
          runMerge(false);
        }
      });

      function runMerge(includeMic) {
        const firstChunkNum = parseInt((videoFiles[0].name.match(/chunk_(\d+)\.mp4/) || [])[1] || '0', 10);
        const clipVideoStartMs = videoStartTime + (firstChunkNum * CHUNK_SECONDS * 1000) + 250;
        const deltaSec = audioFirstChunkTime ? (clipVideoStartMs - audioFirstChunkTime) / 1000 : 0;
        const audioSkipSec = Math.max(0, deltaSec);
        const audioDelaySec = Math.max(0, -deltaSec);
        console.log(`Audio sync: skip=${audioSkipSec.toFixed(3)}s delay=${audioDelaySec.toFixed(3)}s`);

        const mergeArgs = ['-i', tempVideoPath];
        mergeArgs.push('-ss', String(audioSkipSec.toFixed(3)), '-itsoffset', String(audioDelaySec.toFixed(3)), '-i', tempAudioPath);

        if (includeMic && tempMicPath) {
          const micDeltaSec = micFirstChunkTime ? (clipVideoStartMs - micFirstChunkTime) / 1000 : 0;
          const micSkipSec = Math.max(0, micDeltaSec);
          const micDelaySec = Math.max(0, -micDeltaSec);
          mergeArgs.push('-ss', String(micSkipSec.toFixed(3)), '-itsoffset', String(micDelaySec.toFixed(3)), '-i', tempMicPath);
          const vol = (micVolume / 100).toFixed(2);
          mergeArgs.push(
            '-map', '0:v:0',
            '-filter_complex',
            `[1:a]aresample=async=1000,volume=1.0[desk];[2:a]aresample=async=1000,volume=${vol}[mic];[desk][mic]amix=inputs=2:normalize=0[aout]`,
            '-map', '[aout]'
          );
        } else {
          mergeArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000');
        }

        mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-y', outputPath);

        const merge = spawn(getFFmpegPath(), mergeArgs);
        merge.stderr.on('data', d => console.log('Merge:', d.toString()));

        merge.on('close', (code) => {
          [rawAudioPath, tempAudioPath, tempVideoPath, videoListPath, rawMicPath, tempMicPath].forEach(p => {
            if (p) try { fs.unlinkSync(p); } catch (e) {}
          });

          if (code === 0) {
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            console.log('Highlight saved to', outputPath);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('highlight-saved', outputPath);
            }
            uploadHighlight(outputPath, metadataPath);
          } else {
            console.log('Audio merge failed, saving video only');
            const concatOnly = spawn(getFFmpegPath(), [
              '-f', 'concat', '-safe', '0', '-i', videoListPath,
              '-c', 'copy', '-y', outputPath
            ]);
            concatOnly.stderr.on('data', d => console.log('ConcatOnly:', d.toString()));
            concatOnly.on('close', (c) => {
              if (c === 0) {
                fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('highlight-saved', outputPath);
                }
                uploadHighlight(outputPath, metadataPath);
              } else {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
                }
              }
            });
          }
        });
      }
    });
  } else {
    const concat = spawn(getFFmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', videoListPath,
      '-c', 'copy', '-y', outputPath
    ]);
    concat.stderr.on('data', d => console.log('Concat:', d.toString()));
    concat.on('close', (code) => {
      try { fs.unlinkSync(videoListPath); } catch (e) {}
      if (code === 0) {
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        console.log('Highlight saved to', outputPath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-saved', outputPath);
        }
        uploadHighlight(outputPath, metadataPath);
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
        }
      }
    });
  }
}

// ================================
// UPLOAD HIGHLIGHT
// ================================
function uploadHighlight(videoPath, metadataPath) {
  if (!currentSession) { console.log('No active session, skipping upload'); return; }

  console.log('=== UPLOAD START ===', videoPath);
  if (!fs.existsSync(videoPath)) {
    mainWindow.webContents.send('upload-error', 'Video file missing on disk');
    return;
  }
  const videoStats = fs.statSync(videoPath);
  if (videoStats.size === 0) {
    mainWindow.webContents.send('upload-error', 'Video file is empty');
    return;
  }

  console.log(`Uploading highlight to session ${currentSession.code}...`);
  mainWindow.webContents.send('upload-progress', 0);

  const form = new FormData();
  form.append('video', fs.createReadStream(videoPath), {
    filename: path.basename(videoPath), contentType: 'video/mp4'
  });
  if (metadataPath && fs.existsSync(metadataPath)) {
    form.append('metadata', fs.createReadStream(metadataPath), {
      filename: path.basename(metadataPath), contentType: 'application/json'
    });
  }

  form.submit({
    protocol: 'https:', host: 'peakabu.app', port: 443,
    path: `/sessions/${currentSession.code}/upload`, method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken }
  }, (err, res) => {
    if (err) {
      console.log('Upload connection error:', err.message);
      mainWindow.webContents.send('upload-progress', -1);
      mainWindow.webContents.send('upload-error', 'Could not reach server');
      return;
    }
    console.log('=== UPLOAD RESPONSE ===', res.statusCode);

    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        if (res.statusCode === 201) {
          console.log('Upload successful:', result.uploadId);
          mainWindow.webContents.send('upload-progress', 100);
          mainWindow.webContents.send('upload-complete', result.uploadId);
        } else {
          mainWindow.webContents.send('upload-progress', -1);
          mainWindow.webContents.send('upload-error', result.error);
        }
      } catch (parseErr) {
        mainWindow.webContents.send('upload-progress', -1);
        mainWindow.webContents.send('upload-error', 'Server returned invalid response');
      }
      res.resume();
    });
  });
}

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 700,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, experimentalFeatures: true
    }
  });

  mainWindow.loadFile('index.html');
  if (!app.isPackaged) mainWindow.webContents.openDevTools();

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.handle('get-auth-state', () => {
    const prefs = loadUserPreferences();
    return { token: prefs.authToken || null, username: prefs.authUsername || null };
  });

  ipcMain.handle('set-auth-state', (event, { token, username }) => {
    const prefs = loadUserPreferences();
    if (token) { prefs.authToken = token; prefs.authUsername = username; }
    else { delete prefs.authToken; delete prefs.authUsername; }
    saveUserPreferences(prefs);
  });

  ipcMain.handle('get-desktop-sources', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  ipcMain.handle('pick-storage-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Video Storage Directory',
      defaultPath: app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const dirPath = result.filePaths[0];
      CLIPS_DIR = path.join(dirPath, 'PeakAbu');
      BUFFER_DIR = path.join(dirPath, '.apex-highlights-buffer');
      const prefs = loadUserPreferences();
      prefs.storageDirectory = dirPath;
      saveUserPreferences(prefs);
      ensureFolders();
      return { success: true, path: CLIPS_DIR };
    }
    return { success: false };
  });

  ipcMain.handle('get-storage-directory', () => CLIPS_DIR);
  ipcMain.handle('is-first-launch', () => !loadUserPreferences().hasLaunched);
  ipcMain.handle('mark-first-launch-done', () => {
    const prefs = loadUserPreferences();
    prefs.hasLaunched = true;
    saveUserPreferences(prefs);
  });
  ipcMain.handle('get-install-path', () =>
    app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname));

  // Current HDR capture setting (for UI restore on launch)
  ipcMain.handle('get-current-hdr', () => captureHdr);

  ipcMain.on('save-highlight', () => saveHighlight());
  ipcMain.on('broadcast-save-highlight', (event, { coordinated_timestamp, clipDuration }) => {
    console.log(`Received broadcast save-highlight: ts=${coordinated_timestamp}, clipDuration=${clipDuration}ms`);
    saveHighlight(coordinated_timestamp, clipDuration);
  });
  ipcMain.on('set-socket-io', () => console.log('Socket.IO connection noted in main process'));

  ipcMain.on('auth-token-updated', (event, token) => { authToken = token; });
  ipcMain.on('session-connected', (event, { code, username }) => {
    currentSession = { code, username };
    console.log(`Session tracked in main: ${code} as ${username}`);
  });
  ipcMain.on('session-disconnected', () => { currentSession = null; });

  ipcMain.on('start-recording', (event, { monitorIndex }) => {
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      ffmpegProcess.kill();
      ffmpegProcess = null;
    }
    audioBuffers = [];
    micBuffers = [];
    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f => f.endsWith('.mp4'));
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleaned: removed ${stale.length} stale chunks`);
    } catch (e) { console.log('Buffer clean skipped:', e.message); }

    // Fresh engine ladder for this recording session
    stoppingIntentionally = false;
    engineLadder = buildEngineLadder();
    engineIndex = 0;
    startRecording(monitorIndex);
  });

  ipcMain.on('stop-recording', () => {
    stopBufferReadyWatcher();
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      ffmpegProcess.kill();
      ffmpegProcess = null;
      console.log('Recording stopped');
      mainWindow.webContents.send('recording-stopped');
    }
  });

  ipcMain.on('update-settings', (event, settings) => {
    const bufferMap = { '30': 3, '60': 6, '180': 18, '300': 30, '600': 60 };
    if (settings.bufferSeconds && bufferMap[settings.bufferSeconds]) {
      maxChunks = bufferMap[settings.bufferSeconds];
    }
    if (settings.fps && [30, 60].includes(settings.fps)) recordFps = settings.fps;

    const resMap = {
      'native': null,
      '720': { width: 1280, height: 720 },
      '480': { width: 854, height: 480 }
    };
    if (settings.resolution && settings.resolution in resMap) {
      recordResolution = resMap[settings.resolution];
    }

    if (typeof settings.hdr === 'boolean' && settings.hdr !== captureHdr) {
      captureHdr = settings.hdr;
      const prefs = loadUserPreferences();
      prefs.captureHdr = captureHdr;
      saveUserPreferences(prefs);
      console.log(`HDR capture fix ${captureHdr ? 'ENABLED' : 'disabled'}`);
    }

    if (settings.hotkey && isValidHotkey(settings.hotkey)) {
      if (customHotkey) globalShortcut.unregister(customHotkey);
      customHotkey = settings.hotkey;
      const registered = globalShortcut.register(customHotkey, onHotkeyPressed);
      if (registered) {
        const prefs = loadUserPreferences();
        prefs.hotkey = customHotkey;
        saveUserPreferences(prefs);
      } else {
        mainWindow.webContents.send('hotkey-error', `Failed to register ${customHotkey}. Another app may be using it.`);
      }
    }
  });

  ipcMain.on('audio-recording-started', (event, wallTime) => {
    audioFirstChunkTime = wallTime;
  });

  ipcMain.on('save-audio-chunk', (event, buffer) => {
    audioBuffers.push({ data: Buffer.from(buffer), time: Date.now() });
    while (audioBuffers.length > 20) audioBuffers.splice(1, 1);
  });

  ipcMain.on('mic-recording-started', (event, wallTime) => {
    micFirstChunkTime = wallTime;
  });

  ipcMain.on('save-mic-chunk', (event, buffer) => {
    micBuffers.push({ data: Buffer.from(buffer), time: Date.now() });
    while (micBuffers.length > 20) micBuffers.splice(1, 1);
  });

  ipcMain.on('update-mic-settings', (event, settings) => {
    if (settings.volume !== undefined) micVolume = settings.volume;
    if (settings.muted !== undefined) micMuted = settings.muted;
  });

  let audioOutputDeviceId = 'default';
  ipcMain.on('update-audio-output', (event, { deviceId }) => {
    audioOutputDeviceId = deviceId || 'default';
    console.log(`Audio output capture device set to: ${audioOutputDeviceId}`);
  });

  ipcMain.on('get-monitors', (event) => {
    const screen = require('electron').screen;
    const displays = screen.getAllDisplays();
    const monitorList = displays.map((d, i) => ({
      index: i,
      width: Math.round(d.bounds.width * (d.scaleFactor || 1)),
      height: Math.round(d.bounds.height * (d.scaleFactor || 1)),
      x: d.bounds.x, y: d.bounds.y,
      primary: d.bounds.x === 0 && d.bounds.y === 0
    }));
    event.reply('monitors-list', monitorList);
  });

  ipcMain.handle('get-current-hotkey', () => customHotkey);
}

app.whenReady().then(async () => {
  loadUserPreferences();
  ensureFolders();
  createWindow();
  syncClock();
  const registered = globalShortcut.register(customHotkey, onHotkeyPressed);
  if (registered) console.log(`${customHotkey} hotkey registered successfully`);
  else console.log(`WARNING: ${customHotkey} hotkey registration FAILED - another app may be using it`);
});

app.on('window-all-closed', () => {
  stopBufferReadyWatcher();
  if (ffmpegProcess) {
    stoppingIntentionally = true;
    ffmpegProcess.kill();
  }
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});
