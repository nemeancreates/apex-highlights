const { app, BrowserWindow, globalShortcut, ipcMain, dialog } = require('electron');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const FormData = require('form-data');
const https = require('https');
const { checkForUpdates } = require('./updater');

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


// ================================
// CLIENT VERSION CONFIG
// ================================
// Update this whenever a new client build is uploaded to the CDN.
const LATEST_CLIENT_VERSION = {
  version: '0.1.25',
  downloadUrl: 'https://peakbu-media.nyc3.cdn.digitaloceanspaces.com/releases/PeakAbu-Setup-0.1.25.exe',
  releaseNotes: 'Auto-updater added. The app now checks for updates on launch.'
};


// User-configurable paths (loaded from preferences)
let BUFFER_DIR = DEFAULT_BUFFER_DIR;
let CLIPS_DIR = DEFAULT_CLIPS_DIR;

// Settings (adjustable from UI)
let maxChunks = 18;
let recordFps = 30;
let recordResolution = null; // null = native, or { width, height }
let customHotkey = 'F9';
let startupHotkeyRegistered = true;
let captureHdr = false;      // HDR monitor fix — tonemaps HDR desktop to correct SDR colors
let captureAdapter = null;
let captureWindowTitle = null;
let clockOffset = 0;
let clockUncertaintyMs = null;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let authToken = null;
let currentMonitor = null;
let videoStartTime = null;
let audioFirstChunkTime = null;
let bufferReadyWatcher = null;
let recordingStartTime = null;
let recordingSessionTag = Date.now();  // unique per recording session — chunk filenames never repeat
let lastHighlightBoundary = 0;

// ================================
// CPU CLASS DETECTION — x264 settings that respect budget hardware
// ================================
// os.cpus() counts LOGICAL cores. A 4c/8t budget chip reports 8; an
// 8c/16t enthusiast chip reports 16. On <= 8 logical cores, x264
// 'veryfast' with unlimited threads visibly fights the game for CPU
// time — drop to 'superfast' and cap threads to roughly half the
// logical cores so the game always keeps headroom.
const LOGICAL_CORES = os.cpus().length;
const X264_PRESET = LOGICAL_CORES <= 8 ? 'superfast' : 'veryfast';
const X264_THREADS = Math.max(2, Math.floor(LOGICAL_CORES / 2));
console.log(`CPU class: ${LOGICAL_CORES} logical cores — x264 ${X264_PRESET}, ${X264_THREADS} threads`);

// ================================
// HARDWARE ENCODER PROBE
// ================================
// Probed once at launch with a real 1-second trial encode per encoder —
// this catches runtime failures (missing driver DLLs, unsupported GPU
// generation) that a static -encoders list would miss. Recording waits
// on encoderProbePromise, so hitting Start immediately after launch is
// safe; the probe itself takes ~1-3s in parallel.
//
//   nvenc — NVIDIA (h264_nvenc)
//   qsv   — Intel iGPU / Arc (h264_qsv)
//   amf   — AMD dGPU / APU (h264_amf)
//
// If an encoder passes the probe but fails during real capture (driver
// weirdness, session limits), the failure detector below blacklists it
// in failedEncoders for the rest of the app run and the ladder advances.
let hwEncoders = { nvenc: false, qsv: false, amf: false };
let encoderProbePromise = null;
const failedEncoders = new Set(); // encoders proven broken this app run

function probeEncoder(encName) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const p = spawn(getFFmpegPath(), [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30',
        '-frames:v', '30', '-c:v', encName, '-f', 'null', '-'
      ], { windowsHide: true });
      const timer = setTimeout(() => { try { p.kill(); } catch (e) {} done(false); }, 8000);
      p.on('close', (code) => { clearTimeout(timer); done(code === 0); });
      p.on('error', () => { clearTimeout(timer); done(false); });
    } catch (e) {
      done(false);
    }
  });
}

async function probeHardwareEncoders() {
  const [nvenc, qsv, amf] = await Promise.all([
    probeEncoder('h264_nvenc'),
    probeEncoder('h264_qsv'),
    probeEncoder('h264_amf')
  ]);
  hwEncoders = { nvenc, qsv, amf };
  console.log(`Encoder probe: NVENC=${nvenc} QSV=${qsv} AMF=${amf}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const available = ['nvenc', 'qsv', 'amf'].filter(e => hwEncoders[e]);
    mainWindow.webContents.send('capture-engine',
      available.length > 0
        ? `Hardware encoders detected: ${available.map(e => e.toUpperCase()).join(', ')}`
        : 'No hardware encoder detected — CPU encoding will be used');
  }
}

// Ordered list of usable hw encoders (probe-passed, not blacklisted)
function availableHwEncoders() {
  return ['nvenc', 'qsv', 'amf'].filter(e => hwEncoders[e] && !failedEncoders.has(e));
}

function engineEncoderName(engine) {
  if (engine.includes('nvenc')) return 'nvenc';
  if (engine.includes('qsv')) return 'qsv';
  if (engine.includes('amf')) return 'amf';
  return 'x264';
}

// Per-encoder output args. Bitrate-driven for hw encoders (consistent,
// predictable file sizes per chunk); CRF for x264 (best quality-per-cycle
// when the CPU is doing the work anyway).
function encoderArgs(enc, bitrate) {
  switch (enc) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate];
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', bitrate];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', 'balanced', '-b:v', bitrate];
    case 'x264':
    default:
      return ['-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '23', '-threads', String(X264_THREADS)];
  }
}

// ================================
// ADAPTIVE BITRATE — scaled to output resolution + framerate
// ================================
// A fixed 8M was blocky at 4K60 and wasteful at 480p. Bitrate now tracks
// pixels-per-second of the actual OUTPUT (post-scale) dimensions.
function computeBitrate(monitor) {
  let outHeight;
  if (recordResolution) {
    outHeight = recordResolution.height;
  } else {
    try {
      const screen = require('electron').screen;
      const displays = screen.getAllDisplays();
      const target = (monitor !== undefined && monitor !== null && displays[monitor]) ? displays[monitor] : displays[0];
      outHeight = Math.round(target.bounds.height * (target.scaleFactor || 1));
    } catch (e) {
      outHeight = 1080; // safe default if display enum fails
    }
  }

  let baseMbps;
  if (outHeight <= 480) baseMbps = 3;
  else if (outHeight <= 720) baseMbps = 5;
  else if (outHeight <= 1080) baseMbps = 8;
  else if (outHeight <= 1440) baseMbps = 14;
  else baseMbps = 24; // 4K and above

  const fpsMultiplier = recordFps >= 60 ? 1.5 : 1.0;
  return Math.round(baseMbps * fpsMultiplier) + 'M';
}

// ================================
// CONTINUOUS HIGHLIGHT AUDIO
// ================================
// MediaRecorder webm headers only exist in the FIRST blob — buffered audio
// must live in ONE growing file per recording session, never a pruned array
// of chunks. Pruning middles broke the stream and made every highlight after
// the first reuse the same audio (the "repeating audio" bug).
let hlAudioPath = null;        // desktop audio, appended continuously
let hlMicPath = null;          // mic audio, appended continuously
let hlAudioChunkCount = 0;
let hlMicChunkCount = 0;

// ================================
// FULL SESSION MODE
// ================================
let fullSessionMode = false;           // when true: never prune, archive whole session on stop
let fullSessionDir = null;             // optional override location for archives; null = use CLIPS_DIR
let sessionArchiveActive = false;      // guards concat-on-stop
let diskWatchTimer = null;             // interval that watches free space during recording
let fullSessionAudioChunks = [];   // paths of audio webm files written to disk
let fullSessionMicChunks = [];     // paths of mic webm files written to disk
let fullSessionAudioIndex = 0;     // counter for filenames

const DISK_WARN_BYTES = 20 * 1024 * 1024 * 1024;  // 20GB — warn
const DISK_STOP_BYTES = 10 * 1024 * 1024 * 1024;  // 10GB — hard stop



// ================================
// CAPTURE ENGINE LADDER
// ================================
// Ordered list of capture+encode strategies. On early FFmpeg failure we
// automatically advance to the next engine, so users always end up with
// a working recording on any hardware — NVIDIA, Intel iGPU/Arc, AMD
// dGPU/APU, or pure CPU.
//
//   dda-nvenc      ddagrab -> h264_nvenc, frames never leave the GPU (fastest, lowest game impact)
//   dda-nvenc-vf   ddagrab -> hwdownload -> h264_nvenc (scaled or as CPU-path fallback)
//   dda-qsv-vf     ddagrab -> hwdownload -> h264_qsv (Intel iGPU / Arc)
//   dda-amf-vf     ddagrab -> hwdownload -> h264_amf (AMD)
//   dda-hdr-*      ddagrab 10-bit -> HDR->SDR tonemap -> hw or CPU encode
//   dda-x264       ddagrab -> hwdownload -> libx264 (DDA capture is still much lighter than gdigrab)
//   gdi-nvenc/qsv/amf  legacy gdigrab -> hardware encode (safety net for DDA-hostile setups)
//   gdi-x264       legacy gdigrab -> libx264 (final safety net, works everywhere)
//
// Requires an FFmpeg build that includes the ddagrab and zscale filters
// (gyan.dev "full" build — it also ships h264_qsv and h264_amf). If the
// bundled build lacks them, the ladder simply falls through.
let engineLadder = [];
let engineIndex = 0;
let stoppingIntentionally = false;

const ENGINE_LABELS = {
  'dda-nvenc':     'GPU capture + NVIDIA encode (zero-copy)',
  'dda-nvenc-vf':  'GPU capture + NVIDIA encode (scaled)',
  'dda-qsv-vf':    'GPU capture + Intel QuickSync encode',
  'dda-amf-vf':    'GPU capture + AMD encode',
  'dda-hdr-nvenc': 'GPU capture + HDR tonemap + NVIDIA encode',
  'dda-hdr-qsv':   'GPU capture + HDR tonemap + Intel encode',
  'dda-hdr-amf':   'GPU capture + HDR tonemap + AMD encode',
  'dda-hdr-x264':  'GPU capture + HDR tonemap + CPU encode',
  'dda-x264':      'GPU capture + CPU encode',
  'gdi-nvenc':     'Legacy capture + NVIDIA encode',
  'gdi-qsv':       'Legacy capture + Intel encode',
  'gdi-amf':       'Legacy capture + AMD encode',
  'gdi-x264':      'Legacy capture + CPU encode',
  'gdi-window':    'Window capture (game)',
};

function buildEngineLadder() {
  const l = [];
  const hw = availableHwEncoders();

  if (captureHdr) {
    // Tonemap runs on CPU either way; encoder is the variable.
    for (const e of hw) l.push(`dda-hdr-${e}`);
    l.push('dda-hdr-x264');
    for (const e of hw) l.push(`gdi-${e}`);
    l.push('gdi-x264');
  } else {
    // NVENC zero-copy is the crown jewel — native res only.
    if (hw.includes('nvenc') && !recordResolution) l.push('dda-nvenc');
    for (const e of hw) l.push(`dda-${e}-vf`);
    l.push('dda-x264');
    for (const e of hw) l.push(`gdi-${e}`);
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
// PROCESS SHUTDOWN — graceful FFmpeg quit + hard tree-kill
// ================================
// FFmpeg capturing via ddagrab/gdigrab does not reliably die on a plain
// .kill() (SIGTERM). On Windows it can survive as a detached ffmpeg.exe still
// holding the Desktop Duplication handle and still encoding — invisible because
// we spawn with windowsHide. That orphan is what keeps dropping frames after
// the client is closed. This kills the whole tree, gracefully first.
//
// Returns a promise that resolves once the process is gone (or ~1.5s elapsed).
function killFFmpegTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const pid = proc.pid;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    // Ensure the tree is force-killed even if graceful quit is ignored.
    const forceKill = setTimeout(() => {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch (e) {
        console.log('taskkill failed:', e.message);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
      done();
    }, 1200);

    proc.once('close', () => { clearTimeout(forceKill); done(); });
    proc.once('exit',  () => { clearTimeout(forceKill); done(); });

    // Graceful: FFmpeg quits cleanly and releases the DDA handle on 'q'.
    try {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.write('q');
      }
    } catch (e) {
      console.log('Graceful quit write failed, will force-kill:', e.message);
    }
  });
}

// One-time sweep on launch: kill any orphaned ffmpeg.exe left over from a
// previous crash or hard-close. Scoped to processes whose command line
// references our buffer directory, so we never touch an unrelated ffmpeg.
function sweepOrphanedFFmpeg() {
  if (process.platform !== 'win32') return;
  try {
    const marker = 'apex-highlights-buffer';
    // WMIC is deprecated on Win11; use PowerShell CIM to match on command line.
    const ps = [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ];
    const sweep = spawn('powershell.exe', ps, { windowsHide: true });
    sweep.on('close', () => console.log('Orphaned FFmpeg sweep complete'));
    sweep.on('error', (e) => console.log('Orphan sweep skipped:', e.message));
  } catch (e) {
    console.log('Orphan sweep skipped:', e.message);
  }
}

// ================================
// MIC STATE
// ================================
let micFirstChunkTime = null;
let micVolume = 80;
let micMuted = false;


// Where full-session archives are written. Falls back to the clips dir.
function getArchiveBaseDir() {
  const base = (fullSessionDir && fs.existsSync(fullSessionDir))
    ? fullSessionDir
    : CLIPS_DIR;
  return path.join(base, 'archives');
}

// Which directory to check for free space (the one we're writing chunks + archive into)
function getActiveStorageRoot() {
  if (fullSessionMode && fullSessionDir && fs.existsSync(fullSessionDir)) return fullSessionDir;
  return CLIPS_DIR;
}

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

      if (typeof prefs.captureAdapter === 'number' || prefs.captureAdapter === null) {
        captureAdapter = prefs.captureAdapter;
        console.log(`Loaded capture adapter preference: ${captureAdapter === null ? 'auto' : captureAdapter}`);
      }

      if (typeof prefs.fullSessionMode === 'boolean') {
        fullSessionMode = prefs.fullSessionMode;
        console.log(`Loaded full session mode preference: ${fullSessionMode}`);
      }
      if (prefs.fullSessionDir && fs.existsSync(prefs.fullSessionDir)) {
        fullSessionDir = prefs.fullSessionDir;
        console.log(`Loaded full session archive dir: ${fullSessionDir}`);
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

// clockOffset = Peak-Abu server clock minus this PC's clock.
// Measured by the renderer via socket ping-pong (min-RTT sampling)
// and pushed here. All squad clips are timestamped in the SAME
// server clock domain, so cross-machine offsets cancel out.
ipcMain.on('server-clock-offset', (event, payload) => {
  // v0.1.17+ renderer sends { offset, uncertaintyMs }; older builds sent a bare number.
  const offset = (payload && typeof payload === 'object') ? payload.offset : payload;
  const uncertainty = (payload && typeof payload === 'object') ? payload.uncertaintyMs : null;
  if (typeof offset === 'number' && isFinite(offset) && Math.abs(offset) < 24 * 3600 * 1000) {
    clockOffset = offset;
    if (typeof uncertainty === 'number' && isFinite(uncertainty)) clockUncertaintyMs = uncertainty;
    console.log(`Server clock offset updated: ${offset.toFixed(1)}ms (±${uncertainty === null ? '?' : uncertainty.toFixed(1)}ms)`);
  } else {
    console.log('server-clock-offset: rejected invalid payload:', JSON.stringify(payload));
  }
});

function getPreciseUTC() { return Date.now() + clockOffset; }

function pruneOldChunks() {
  // In full session mode we keep every chunk for the whole session — no pruning.
  if (fullSessionMode) return;

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
  const chunkPattern = path.join(BUFFER_DIR, `chunk_${recordingSessionTag}_%03d.mp4`);
  const fpsStr = String(recordFps);
  const bitrate = computeBitrate(monitor);

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

  const enc = engineEncoderName(engine);
  const encArgs = encoderArgs(enc, bitrate);

  // Output side:
  //   -r + -fps_mode cfr  => CONSTANT frame rate output. ddagrab delivers
  //   frames on the desktop-duplication cadence and gdigrab is even less
  //   regular; without forcing CFR the chunk timestamps wobble slightly and
  //   browsers render that as micro-stutter even with zero real drops.
  //   Duplicate/drop-to-grid at the muxer is what Shadowplay-smooth looks like.
  const segmentArgs = [
    '-g', fpsStr, '-keyint_min', fpsStr,
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-r', fpsStr, '-fps_mode', 'cfr',
    '-an',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1', '-y', chunkPattern
  ];

  const scaleTail = recordResolution ? `,scale=-2:${recordResolution.height}` : '';

  // Desktop Duplication input — GPU capture, no BitBlt, no DWM slow path.
  // On hybrid systems (Intel iGPU + discrete GPU) the display may be driven by
  // one adapter while ddagrab defaults to another — that mismatch forces a
  // cross-adapter GPU->GPU copy every frame and wrecks pacing. captureAdapter
  // lets us pin capture to the GPU the monitor actually lives on.
  const adapterOpt = (captureAdapter !== null && captureAdapter !== undefined)
    ? `:adapter=${captureAdapter}` : '';
  const ddaInput = (tenBit) => [
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${monitor || 0}${adapterOpt}:framerate=${recordFps}${tenBit ? ':output_fmt=10bit' : ''}`
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

  // Window capture mode — use gdigrab targeting a specific window title.
  // Overrides monitor/ddagrab engines entirely. Uses the best available
  // hardware encoder, falling back to CPU.
  if (captureWindowTitle) {
    const winInput = [
      '-f', 'gdigrab', '-framerate', fpsStr,
      '-i', `title=${captureWindowTitle}`
    ];
    const winHw = availableHwEncoders();
    const winEnc = winHw.length > 0 ? winHw[0] : 'x264';
    const winEncArgs = encoderArgs(winEnc, bitrate);
    const winVfParts = [];
    if (recordResolution) winVfParts.push(`scale=-2:${recordResolution.height}`);
    if (winEnc === 'x264') {
      return [
        ...winInput,
        ...(winVfParts.length ? ['-vf', winVfParts.join(',')] : []),
        ...winEncArgs, '-pix_fmt', 'yuv420p', ...segmentArgs
      ];
    }
    winVfParts.push('format=nv12'); // hw encoders want nv12/yuv, not raw bgra
    return [...winInput, '-vf', winVfParts.join(','), ...winEncArgs, ...segmentArgs];
  }

  const isGdi = engine.startsWith('gdi');
  const isHdr = engine.includes('hdr');

  // Zero-copy NVENC — frames never leave the GPU. Native res only.
  if (engine === 'dda-nvenc') {
    return [...ddaInput(false), ...encArgs, ...segmentArgs];
  }

  if (!isGdi && isHdr) {
    return [...ddaInput(true), '-vf', hdrVf, ...encArgs, ...segmentArgs];
  }

  if (!isGdi) {
    // dda-nvenc-vf / dda-qsv-vf / dda-amf-vf / dda-x264
    return [...ddaInput(false), '-vf', ddaCpuVf, ...encArgs, ...segmentArgs];
  }

  // gdi engines
  const gdiVfParts = [];
  if (recordResolution) gdiVfParts.push(`scale=-2:${recordResolution.height}`);
  if (enc === 'x264') {
    return [
      ...gdiInput,
      ...(gdiVfParts.length ? ['-vf', gdiVfParts.join(',')] : []),
      ...encArgs, '-pix_fmt', 'yuv420p', ...segmentArgs
    ];
  }
  gdiVfParts.push('format=nv12'); // QSV/AMF reject raw bgra; NVENC is happier too
  return [...gdiInput, '-vf', gdiVfParts.join(','), ...encArgs, ...segmentArgs];
}

// Returns free bytes on the volume containing `dir`, or null if it can't be read.
function getFreeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir); // Node 18.15+ / 20+
    return stats.bavail * stats.bsize;
  } catch (e) {
    return null; // statfsSync unavailable or path bad — fail open
  }
}

function startDiskWatcher() {
  stopDiskWatcher();
  let warned = false;
  diskWatchTimer = setInterval(() => {
    const root = getActiveStorageRoot();
    const free = getFreeBytes(root);
    if (free === null) return;

    if (free <= DISK_STOP_BYTES) {
      console.log(`Disk critical: ${(free / 1e9).toFixed(1)}GB free — auto-stopping recording`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('disk-critical', {
          freeGB: (free / 1e9).toFixed(1),
          path: root
        });
      }
      stopRecordingInternal();     // triggers archive concat + halt
    } else if (free <= DISK_WARN_BYTES && !warned) {
      warned = true;
      console.log(`Disk low: ${(free / 1e9).toFixed(1)}GB free — warning user`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('disk-warning', {
          freeGB: (free / 1e9).toFixed(1),
          path: root
        });
      }
    }
  }, 30000); // check every 30s
}

function stopDiskWatcher() {
  if (diskWatchTimer) { clearInterval(diskWatchTimer); diskWatchTimer = null; }
}

// ================================
// CAPTURE HEALTH TELEMETRY
// ================================
// FFmpeg emits progress lines like:
//   frame= 1234 fps= 59 q=23.0 size=... time=... bitrate=... speed=1.01x drop=0
// speed < ~0.95x or a climbing drop count means capture can't keep up — the
// objective signal behind "the app tanked my FPS". We surface it so testers
// report "engine X, speed 0.7x, 400 drops" instead of a vibe.
let lastDropCount = 0;
let lowSpeedStreak = 0;

function parseCaptureHealth(text, engine) {
  const speedMatch = text.match(/speed=\s*([\d.]+)x/);
  const dropMatch  = text.match(/drop=\s*(\d+)/);
  const fpsMatch   = text.match(/fps=\s*([\d.]+)/);
  if (!speedMatch && !dropMatch) return;

  const speed = speedMatch ? parseFloat(speedMatch[1]) : null;
  const drop  = dropMatch ? parseInt(dropMatch[1], 10) : null;
  const fps   = fpsMatch ? parseFloat(fpsMatch[1]) : null;

  if (drop !== null && drop > lastDropCount) {
    const newDrops = drop - lastDropCount;
    lastDropCount = drop;
    console.log(`Capture dropped ${newDrops} frame(s) (total ${drop}) on [${engine}]`);
  }

  if (speed !== null) {
    if (speed < 0.95) {
      lowSpeedStreak++;
      // Only warn after a sustained dip (3 consecutive reads) to avoid noise
      // from the first second of startup.
      if (lowSpeedStreak === 3 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-health', {
          status: 'behind', engine, speed, drop, fps,
          message: `Capture is falling behind (${speed.toFixed(2)}x) on ${ENGINE_LABELS[engine] || engine}. ` +
                   `This can drop game FPS. Try a lighter engine, lower FPS, or check for other recorders (Shadowplay/OBS).`
        });
      }
    } else {
      if (lowSpeedStreak >= 3 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-health', { status: 'ok', engine, speed, drop, fps });
      }
      lowSpeedStreak = 0;
    }
  }
}


function startRecording(monitor) {
  ensureFolders();
  currentMonitor = monitor;

  // Skip engines whose encoder is blacklisted (failed earlier this run)
  while (
    engineIndex < engineLadder.length &&
    failedEncoders.has(engineEncoderName(engineLadder[engineIndex])) &&
    engineEncoderName(engineLadder[engineIndex]) !== 'x264'
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
  console.log(`Settings: ${recordFps}fps, resolution: ${recordResolution ? recordResolution.width + 'x' + recordResolution.height : 'native'}, bitrate: ${computeBitrate(monitor)}, buffer: ${maxChunks * CHUNK_SECONDS}s, HDR fix: ${captureHdr}`);
  console.log('FFmpeg args:', ffmpegArgs.join(' '));

  ffmpegProcess = spawn(getFFmpegPath(), ffmpegArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']  // stdin pipe lets us send 'q' for graceful quit
  });

  if (ffmpegProcess.pid) setBelowNormalPriority(ffmpegProcess.pid);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture-engine', ENGINE_LABELS[engine]);
    if (captureHdr && engine.startsWith('gdi')) {
      mainWindow.webContents.send('capture-engine',
        '⚠ HDR tonemap unavailable in this FFmpeg build — colors may look washed out. Bundle the gyan.dev FULL build.');
    }
  }

  // The HDR tonemap chain (float zscale + Hable) is genuinely CPU-heavy.
  // On budget CPUs at 60fps it will not keep real-time — warn up front.
  if (captureHdr && LOGICAL_CORES <= 8 && recordFps >= 60) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-engine',
        `⚠ HDR fix at 60fps is heavy for this CPU (${LOGICAL_CORES} threads) — if capture falls behind, drop to 30fps or disable the HDR fix.`);
    }
  }

  const spawnStartTime = Date.now();
  videoStartTime = spawnStartTime;
  recordingStartTime = spawnStartTime;
  lastHighlightBoundary = 0;
  lastDropCount = 0;
  lowSpeedStreak = 0;
  let stderrTail = '';

  startBufferReadyWatcher();
  if (fullSessionMode) startDiskWatcher();

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
    parseCaptureHealth(text, engine);
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

      // Blacklist the encoder for the rest of this run if stderr points at
      // an encoder-level failure (not a capture-level one) — this skips ALL
      // remaining ladder entries using that encoder rather than trying each.
      const enc = engineEncoderName(engine);
      const encoderFailurePatterns = {
        nvenc: /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i,
        qsv:   /qsv|MFX|mfx session|Error initializing|libmfx|libvpl/i,
        amf:   /amf|AMF|DXGI_ERROR|Failed to initialize/i
      };
      if (enc !== 'x264' && encoderFailurePatterns[enc] && encoderFailurePatterns[enc].test(stderrTail)) {
        failedEncoders.add(enc);
        console.log(`Encoder [${enc}] blacklisted for this run`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const remaining = availableHwEncoders();
          mainWindow.webContents.send('encoder-fallback',
            remaining.length > 0 ? remaining[0].toUpperCase() : 'CPU');
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
  const clipChunks = Math.ceil(duration / (CHUNK_SECONDS * 1000));
  const saveTimeUTC = coordinatedTimestamp || getPreciseUTC();

  // Queued triggers arrive with a timestamp in the past — some or all of the
  // post-capture window has already elapsed, so only wait for the remainder.
  const alreadyElapsed = coordinatedTimestamp ? Math.max(0, getPreciseUTC() - coordinatedTimestamp) : 0;
  const postDelay = Math.max(0, Math.ceil(duration * 0.1) - alreadyElapsed);

  if (postDelay > 500) {
    console.log(`Post-capture: waiting ${postDelay}ms for remaining footage (${(duration / 1000)}s clip, ${clipChunks} chunks)...`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('post-capture-started', { postDelay });
    }
    setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp), postDelay);
  } else {
    doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp);
  }
}

function doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs = null) {
  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
    .map(f => {
      const st = fs.statSync(path.join(BUFFER_DIR, f));
      return {
        name: f, path: path.join(BUFFER_DIR, f),
        time: st.mtimeMs,        // when the chunk FINISHED writing (footage end)
        birth: st.birthtimeMs,   // when the chunk was CREATED (footage start)
        size: st.size
      };
    })
    .filter(f => f.size > 100000)
    .sort((a, b) => a.time - b.time);

  const withoutInProgress = allVideoFiles.slice(0, -1);
  let newSinceLastSave = withoutInProgress.filter(f =>
    f.time > lastHighlightBoundary && f.time > recordingStartTime
  );

  // For timestamp-anchored saves (coordinated or queued), drop chunks whose
  // footage STARTED after the trigger's post-capture window closed — a queued
  // clip should end at its event, not at whenever the queue got drained.
  // Fallback: if that empties the list (event was fully inside the previous
  // clip's window), keep the unfiltered set so we still save something.
  if (coordinatedTs) {
    const localTriggerMs = saveTimeUTC - clockOffset;
    const localCutoff = localTriggerMs + Math.ceil(durationMs * 0.1) + (CHUNK_SECONDS * 1000);
    const trimmed = newSinceLastSave.filter(f => f.birth <= localCutoff);
    if (trimmed.length > 0) newSinceLastSave = trimmed;
  }

  const videoFiles = newSinceLastSave.slice(-clipChunks);

  if (videoFiles.length === 0) {
    console.log('No completed chunks yet');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-error', 'Buffer not ready yet, wait a few more seconds');
    }
    return;
  }

  lastHighlightBoundary = videoFiles[videoFiles.length - 1].time;

  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && audioFirstChunkTime && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && micFirstChunkTime && !micMuted && fs.existsSync(hlMicPath));
  console.log(`Saving highlight: ${videoFiles.length}/${clipChunks} chunks, audio=${hasAudio} (${hlAudioChunkCount} appends), mic=${hasMic} (${hlMicChunkCount} appends) (clip: ${durationMs / 1000}s)`);

  const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

  // v2 timestamps: footage start = birthtime of the first chunk (created the
  // moment FFmpeg muxed its first frame); footage end = mtime of the last
  // chunk (its final write). Both shifted into the shared server clock domain.
  const startTimeUTC = Math.round(videoFiles[0].birth + clockOffset);
  const endTimeUTC = Math.round(videoFiles[videoFiles.length - 1].time + clockOffset);
  const realDurationMs = Math.max(0, endTimeUTC - startTimeUTC);

  const metadata = {
    clipId: crypto.randomUUID(),
    version: 2,
    saveTimeUTC, startTimeUTC, endTimeUTC,
    durationMs: realDurationMs, clipDurationMs: durationMs,
    frameRate: recordFps, clockOffsetMs: clockOffset,
    syncUncertaintyMs: clockUncertaintyMs,
    userId: null,
    sessionId: currentSession ? currentSession.code : null,
    coordinated_timestamp: coordinatedTs || null
  };

  const videoListPath = path.join(BUFFER_DIR, 'filelist_' + Date.now() + '.txt');
  const videoContent = videoFiles.map(f => `file '${f.path.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(videoListPath, videoContent);

  if (hasAudio) {
    const tempId = Date.now();
    const tempVideoPath = path.join(BUFFER_DIR, 'temp_video_' + tempId + '.mp4');
    const tempAudioPath = path.join(BUFFER_DIR, 'temp_audio_' + tempId + '.m4a');
    const tempMicPath = hasMic ? path.join(BUFFER_DIR, 'temp_mic_' + tempId + '.m4a') : null;

    // Where this clip starts relative to the CONTINUOUS audio stream.
    // The continuous file's timeline begins at audioFirstChunkTime (recorder
    // start), so wall-clock deltas map 1:1 onto stream time — the math that
    // was broken when middle chunks were being pruned from the old array.
    const firstChunkNum = parseInt((videoFiles[0].name.match(/chunk_(?:\d+_)?(\d+)\.mp4/) || [])[1] || '0', 10);
    const clipVideoStartMs = videoStartTime + (firstChunkNum * CHUNK_SECONDS * 1000) + 250;
    const clipSpanSec = ((videoFiles[videoFiles.length - 1].time - videoFiles[0].birth) / 1000) + 2;

    const audioDeltaSec = audioFirstChunkTime ? (clipVideoStartMs - audioFirstChunkTime) / 1000 : 0;
    const audioSkipSec = Math.max(0, audioDeltaSec);
    const audioDelaySec = Math.max(0, -audioDeltaSec);

    const micDeltaSec = micFirstChunkTime ? (clipVideoStartMs - micFirstChunkTime) / 1000 : 0;
    const micSkipSec = Math.max(0, micDeltaSec);
    const micDelaySec = Math.max(0, -micDeltaSec);

    function cleanupTemps() {
      // NEVER delete hlAudioPath / hlMicPath here — future saves need them.
      [tempAudioPath, tempVideoPath, videoListPath, tempMicPath].forEach(p => {
        if (p) try { fs.unlinkSync(p); } catch (e) {}
      });
    }

    function finishSuccess() {
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      console.log('Highlight saved to', outputPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-saved', outputPath);
      }
      uploadHighlight(outputPath, metadataPath);
    }

    function finishVideoOnly() {
      console.log('Audio unavailable/merge failed — saving video only');
      try {
        fs.copyFileSync(tempVideoPath, outputPath);
        finishSuccess();
      } catch (e) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
        }
      }
      cleanupTemps();
    }

    const concatVideo = spawn(getFFmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', videoListPath,
      '-c', 'copy', '-y', tempVideoPath
    ]);
    concatVideo.stderr.on('data', d => console.log('ConcatVideo:', d.toString()));

    concatVideo.on('close', (videoCode) => {
      if (videoCode !== 0) {
        cleanupTemps();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-error', 'Failed to concat video');
        }
        return;
      }

      // Extract this clip's slice from the continuous desktop-audio file.
      // genpts+igndts + aresample(first_pts=0) heals the appended-fragment
      // stream (same recipe as the full-session archive), then output-side
      // -ss/-t trims to just the clip window.
      console.log(`Audio sync: skip=${audioSkipSec.toFixed(3)}s delay=${audioDelaySec.toFixed(3)}s span=${clipSpanSec.toFixed(1)}s`);
      const repairAudio = spawn(getFFmpegPath(), [
        '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
        '-i', hlAudioPath,
        '-af', 'aresample=async=1000:first_pts=0',
        '-ss', audioSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
        '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioPath
      ]);
      repairAudio.stderr.on('data', d => console.log('RepairAudio:', d.toString()));
      repairAudio.on('close', (repairCode) => {
        if (repairCode !== 0 || !fs.existsSync(tempAudioPath)) {
          finishVideoOnly();
          return;
        }

        if (hasMic && tempMicPath) {
          const repairMic = spawn(getFFmpegPath(), [
            '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
            '-i', hlMicPath,
            '-af', 'aresample=async=1000:first_pts=0',
            '-ss', micSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
            '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
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
        // The audio temp is already trimmed to start exactly at the clip's
        // first video frame, so no -ss here — only itsoffset for the rare
        // case where audio capture started AFTER the video.
        const mergeArgs = ['-i', tempVideoPath];
        mergeArgs.push('-itsoffset', audioDelaySec.toFixed(3), '-i', tempAudioPath);

        if (includeMic && tempMicPath) {
          mergeArgs.push('-itsoffset', micDelaySec.toFixed(3), '-i', tempMicPath);
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
          if (code === 0) {
            cleanupTemps();
            finishSuccess();
          } else {
            finishVideoOnly();
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

  // Enumerate open windows with visible titles (on-demand, no polling)
  ipcMain.handle('get-windows', async () => {
    return new Promise((resolve) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-Command',
        "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress"
      ], { windowsHide: true });

      let out = '';
      ps.stdout.on('data', d => out += d.toString());
      ps.on('close', () => {
        try {
          let parsed = JSON.parse(out);
          if (!Array.isArray(parsed)) parsed = [parsed]; // single result isn't array
          // Filter out our own window and empties
          const windows = parsed
            .filter(w => w.MainWindowTitle && w.MainWindowTitle.trim() !== '')
            .filter(w => w.MainWindowTitle !== 'Peak-Abu')
            .map(w => ({ processName: w.ProcessName, title: w.MainWindowTitle }));
          resolve(windows);
        } catch (e) {
          console.log('Window enum parse failed:', e.message);
          resolve([]);
        }
      });
      ps.on('error', () => resolve([]));
    });
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
  ipcMain.handle('get-current-adapter', () => captureAdapter);

  // Encoder probe results — for a future "capture engine" readout in Settings
  ipcMain.handle('get-hw-encoders', () => ({
    ...hwEncoders,
    failed: Array.from(failedEncoders),
    cpuCores: LOGICAL_CORES,
    x264Preset: X264_PRESET
  }));

  ipcMain.on('save-highlight', () => saveHighlight());
  // Solo-mode queued save: renderer passes the LOCAL ms timestamp of the
  // original keypress; shift into the server clock domain so the anchored
  // save path treats it like a coordinated timestamp.
  ipcMain.on('save-highlight-at', (event, localTs) => {
    if (typeof localTs !== 'number' || !isFinite(localTs)) return saveHighlight();
    console.log(`Queued solo highlight: anchored ${(Date.now() - localTs) / 1000}s in the past`);
    saveHighlight(localTs + clockOffset);
  });
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

  ipcMain.on('start-recording', async (event, { monitorIndex, windowTitle }) => {
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      const dying = ffmpegProcess;
      ffmpegProcess = null;
      await killFFmpegTree(dying);
    }

    // Make sure the hardware encoder probe has finished — it usually
    // completes within ~2s of launch, so this only ever waits if the user
    // hits Start immediately after opening the app.
    if (encoderProbePromise) {
      try { await encoderProbePromise; } catch (e) {}
    }

    // Set or clear window capture target
    captureWindowTitle = windowTitle || null;

    // Reset full session audio accumulators
    fullSessionAudioChunks = [];
    fullSessionMicChunks = [];
    fullSessionAudioIndex = 0;

    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleaned: removed ${stale.length} stale files`);
    } catch (e) { console.log('Buffer clean skipped:', e.message); }

    stoppingIntentionally = false;
    recordingSessionTag = Date.now();

    // Fresh continuous audio files for this recording session. The renderer
    // restarts its MediaRecorders on start-recording, so the first blob
    // appended to each file carries the WebM header.
    hlAudioPath = path.join(BUFFER_DIR, `hl_audio_${recordingSessionTag}.webm`);
    hlMicPath = path.join(BUFFER_DIR, `hl_mic_${recordingSessionTag}.webm`);
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;
    audioFirstChunkTime = null;
    micFirstChunkTime = null;

    engineLadder = captureWindowTitle ? ['gdi-window'] : buildEngineLadder();
    engineIndex = 0;
    console.log('Engine ladder:', engineLadder.join(' -> '));
    startRecording(monitorIndex);
  });

  ipcMain.on('stop-recording', async () => {
    stopBufferReadyWatcher();
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      const dying = ffmpegProcess;
      ffmpegProcess = null;
      await killFFmpegTree(dying);
      console.log('Recording stopped');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-stopped');
      }
    }
    // Clear stale chunks + continuous audio so an ended session can't leak
    // old footage/audio into a squad save. Runs after killFFmpegTree
    // resolves, so no chunk is still open when we delete.
    hlAudioPath = null;
    hlMicPath = null;
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;
    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleared on stop: removed ${stale.length} files`);
    } catch (e) { console.log('Buffer clear on stop skipped:', e.message); }
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
      // Heads-up on budget CPUs — the tonemap chain is float math on CPU.
      if (captureHdr && LOGICAL_CORES <= 8 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-engine',
          `⚠ HDR fix is CPU-heavy — on this machine (${LOGICAL_CORES} threads) 30fps is recommended.`);
      }
    }

    if ('adapter' in settings) {
      const a = settings.adapter;
      captureAdapter = (a === null || a === '' || a === 'auto') ? null : parseInt(a, 10);
      if (Number.isNaN(captureAdapter)) captureAdapter = null;
      const prefs = loadUserPreferences();
      prefs.captureAdapter = captureAdapter;
      saveUserPreferences(prefs);
      console.log(`Capture adapter set to: ${captureAdapter === null ? 'auto' : captureAdapter}`);
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

  // Desktop audio blob from the renderer's MediaRecorder. WebM headers only
  // exist in the first blob, so every blob is APPENDED to one continuous
  // per-session file — never held in a pruned array (that caused the
  // repeating-audio bug: middle chunks vanished, skip math went stale, and
  // every later highlight was muxed against the same audio).
  ipcMain.on('save-audio-chunk', (event, buffer) => {
    const buf = Buffer.from(buffer);

    if (hlAudioPath) {
      try {
        fs.appendFileSync(hlAudioPath, buf);
        hlAudioChunkCount++;
      } catch (e) { console.log('Highlight audio append failed:', e.message); }
    }

    if (fullSessionMode) {
      // Append into ONE continuous file — headerless fragments only work
      // as a single stream, not as separate concat inputs.
      const audioPath = path.join(BUFFER_DIR, 'fs_audio_full.webm');
      try {
        fs.appendFileSync(audioPath, buf);
        if (fullSessionAudioChunks.length === 0) fullSessionAudioChunks.push(audioPath);
      } catch(e) { console.log('Full session audio append failed:', e.message); }
    }
  });


  ipcMain.on('mic-recording-started', (event, wallTime) => {
    micFirstChunkTime = wallTime;
  });

  ipcMain.on('save-mic-chunk', (event, buffer) => {
    const buf = Buffer.from(buffer);

    if (hlMicPath) {
      try {
        fs.appendFileSync(hlMicPath, buf);
        hlMicChunkCount++;
      } catch (e) { console.log('Highlight mic append failed:', e.message); }
    }

    if (fullSessionMode) {
      const micPath = path.join(BUFFER_DIR, 'fs_mic_full.webm');
      try {
        fs.appendFileSync(micPath, buf);
        if (fullSessionMicChunks.length === 0) fullSessionMicChunks.push(micPath);
      } catch(e) { console.log('Full session mic append failed:', e.message); }
    }
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

 ipcMain.on('set-full-session-mode', (event, enabled) => {
    fullSessionMode = !!enabled;
    const prefs = loadUserPreferences();
    prefs.fullSessionMode = enabled;
    saveUserPreferences(prefs);
    fullSessionMode = !!enabled;
    console.log(`Full Session Mode ${fullSessionMode ? 'ENABLED' : 'disabled'}`);
    event.reply('full-session-mode-set', fullSessionMode);
  });

  ipcMain.handle('get-full-session-mode', () => fullSessionMode);

  // Free space (GB) at the active storage root — for the hover warning
  ipcMain.handle('get-free-space-gb', () => {
    const free = getFreeBytes(getActiveStorageRoot());
    return free === null ? null : +(free / 1e9).toFixed(1);
  });

  // Optional separate archive location for full sessions
  ipcMain.handle('pick-fullsession-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Full Session Archive Location',
      defaultPath: fullSessionDir || CLIPS_DIR,
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      fullSessionDir = result.filePaths[0];
      const prefs = loadUserPreferences();
      prefs.fullSessionDir = fullSessionDir;
      saveUserPreferences(prefs);
      return { success: true, path: fullSessionDir };
    }
    return { success: false };
  });

  ipcMain.handle('get-fullsession-directory', () => fullSessionDir || getArchiveBaseDir());

  ipcMain.handle('clear-fullsession-directory', () => {
    fullSessionDir = null;
    const prefs = loadUserPreferences();
    delete prefs.fullSessionDir;
    saveUserPreferences(prefs);
    return { path: getArchiveBaseDir() };
  });

  ipcMain.handle('get-current-hotkey', () => customHotkey);
  ipcMain.handle('get-hotkey-registered', () => startupHotkeyRegistered);

  ipcMain.handle('set-user-pref', (event, key, value) => {
    const prefs = loadUserPreferences();
    prefs[key] = value;
    saveUserPreferences(prefs);
  });

  ipcMain.handle('get-user-pref', (event, key) => {
    const prefs = loadUserPreferences();
    return prefs[key] !== undefined ? prefs[key] : null;
  });
}

app.whenReady().then(async () => {
  loadUserPreferences();
  ensureFolders();
  sweepOrphanedFFmpeg();
  createWindow();
  encoderProbePromise = probeHardwareEncoders(); // async — start-recording awaits it
  startupHotkeyRegistered = globalShortcut.register(customHotkey, onHotkeyPressed);
  if (startupHotkeyRegistered) console.log(`${customHotkey} hotkey registered successfully`);
  else console.log(`WARNING: ${customHotkey} hotkey registration FAILED - another app may be using it`);
  setTimeout(() => checkForUpdates(mainWindow), 3000);
});

let isCleaningUp = false;

app.on('before-quit', async (event) => {
  if (isCleaningUp) return;          // second pass: let the quit proceed
  if (ffmpegProcess) {
    event.preventDefault();          // hold the quit until FFmpeg is dead
    isCleaningUp = true;
    stoppingIntentionally = true;
    stopBufferReadyWatcher();
    const dying = ffmpegProcess;
    ffmpegProcess = null;
    await killFFmpegTree(dying);
    globalShortcut.unregisterAll();
    app.quit();                      // re-trigger quit; isCleaningUp lets it through
  } else {
    stopBufferReadyWatcher();
    globalShortcut.unregisterAll();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();  // triggers before-quit
});


// Concat every buffered chunk into one full-session file, then clear the buffer.
function archiveFullSession() {
  if (!fullSessionMode) return;
  if (sessionArchiveActive) return;
  sessionArchiveActive = true;

  let chunks;
  try {
    chunks = fs.readdirSync(BUFFER_DIR)
      .filter(f => /^chunk_[\d_]+\.mp4$/.test(f))
      .map(f => ({ name: f, path: path.join(BUFFER_DIR, f), time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs }))
      .sort((a, b) => a.time - b.time);
  } catch (e) {
    console.log('Archive: could not read buffer dir:', e.message);
    sessionArchiveActive = false;
    return;
  }

  if (chunks.length === 0) {
    console.log('Archive: no chunks to archive');
    sessionArchiveActive = false;
    return;
  }

  // The final chunk is usually incomplete (FFmpeg killed mid-write, no moov atom).
  // Drop it if we have more than one chunk to avoid concat corruption.
  if (chunks.length > 1) {
    const dropped = chunks.pop();
    console.log(`Archive: dropping likely-incomplete final chunk ${dropped.name}`);
    try { fs.unlinkSync(dropped.path); } catch(e) {}
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const codePart = currentSession ? currentSession.code : 'solo';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(getArchiveBaseDir(), `${dateStr}_${codePart}`);

  try { fs.mkdirSync(archiveDir, { recursive: true }); }
  catch (e) { console.log('Archive: mkdir failed:', e.message); sessionArchiveActive = false; return; }

  const tempVideoPath = path.join(BUFFER_DIR, `fs_temp_video_${Date.now()}.mp4`);
  const outputPath = path.join(archiveDir, `full_session_${stamp}.mp4`);
  const videoListPath = path.join(BUFFER_DIR, `archive_list_${Date.now()}.txt`);
  const listContent = chunks.map(c => `file '${c.path.replace(/\\/g, '/')}'`).join('\n');

  try { fs.writeFileSync(videoListPath, listContent); }
  catch (e) { console.log('Archive: list write failed:', e.message); sessionArchiveActive = false; return; }

  console.log(`Archiving ${chunks.length} video chunks + ${fullSessionAudioChunks.length} audio chunks`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archive-started', { chunks: chunks.length });
  }

  const hasAudio = fullSessionAudioChunks.length > 0;
  const hasMic = fullSessionMicChunks.length > 0;

  // Step 1: concat video chunks
  const concatVideo = spawn(getFFmpegPath(), [
    '-f', 'concat', '-safe', '0', '-i', videoListPath,
    '-c', 'copy', '-y', hasAudio ? tempVideoPath : outputPath,
    ...(hasAudio ? [] : ['-movflags', '+faststart'])
  ], { windowsHide: true });

  concatVideo.stderr.on('data', d => {
    const line = d.toString();
    if (line.includes('error') || line.includes('Error')) console.log('Archive video concat:', line);
  });

  concatVideo.on('close', (videoCode) => {
    try { fs.unlinkSync(videoListPath); } catch(e) {}

    if (videoCode !== 0) {
      console.log('Archive: video concat failed');
      cleanup(chunks, false);
      return;
    }

    if (!hasAudio) {
      // No audio captured — video-only archive
      finalize(outputPath, chunks, null, null);
      return;
    }

    // Audio is already one continuous appended webm — just re-encode it to m4a
    // (decode fixes the appended-fragment stream), no concat needed.
    const audioSrc = fullSessionAudioChunks[0];
    const tempAudioReenc = path.join(BUFFER_DIR, `fs_temp_audio_${Date.now()}.m4a`);
    const concatAudio = spawn(getFFmpegPath(), [
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', audioSrc,
      '-af', 'aresample=async=1000:first_pts=0',
      '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioReenc
    ], { windowsHide: true });

    let audioErr = '';
    concatAudio.stderr.on('data', d => { audioErr += d.toString(); });

    concatAudio.on('close', (audioCode) => {
      console.log(`=== AUDIO RE-ENCODE exit code: ${audioCode} ===`);
      console.log(audioErr.slice(-2000));  // last 2000 chars of FFmpeg output
      if (audioCode !== 0 || !fs.existsSync(tempAudioReenc)) {
        console.log('Archive: audio concat failed — saving video only');
        try { fs.renameSync(tempVideoPath, outputPath); } catch(e) {}
        finalize(outputPath, chunks, null, null);
        return;
      }

      const mergeArgs = ['-i', tempVideoPath, '-i', tempAudioReenc];
      let tempMicPath = null;

      if (hasMic) {
        tempMicPath = path.join(BUFFER_DIR, `fs_temp_mic_${Date.now()}.m4a`);
        const { spawnSync } = require('child_process');
        const micResult = spawnSync(getFFmpegPath(), [
          '-fflags', '+genpts+igndts',
          '-err_detect', 'ignore_err',
          '-i', fullSessionMicChunks[0],
          '-af', 'aresample=async=1000:first_pts=0',
          '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
        ], { windowsHide: true });
        if (micResult.status !== 0 || !fs.existsSync(tempMicPath)) {
          tempMicPath = null;
        }
      }

      if (tempMicPath) {
        const vol = (micVolume / 100).toFixed(2);
        mergeArgs.push('-i', tempMicPath);
        mergeArgs.push(
          '-map', '0:v:0',
          '-filter_complex',
          `[1:a]aresample=async=1000,volume=1.0[desk];[2:a]aresample=async=1000,volume=${vol}[mic];[desk][mic]amix=inputs=2:normalize=0[aout]`,
          '-map', '[aout]'
        );
      } else {
        mergeArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000');
      }

      mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart', '-y', outputPath);

      const merge = spawn(getFFmpegPath(), mergeArgs, { windowsHide: true });

      let mergeErr = '';
      merge.stderr.on('data', d => { mergeErr += d.toString(); });

      merge.on('close', (mergeCode) => {
        console.log(`=== ARCHIVE MERGE exit code: ${mergeCode} ===`);
        console.log('MERGE ARGS:', mergeArgs.join(' '));
        console.log(mergeErr.slice(-2500));

        [tempVideoPath, tempAudioReenc, tempMicPath].forEach(p => {
          if (p) try { fs.unlinkSync(p); } catch(e) {}
        });
        if (mergeCode === 0 && fs.existsSync(outputPath)) {
          finalize(outputPath, chunks, fullSessionAudioChunks, fullSessionMicChunks);
        } else {
          console.log('Archive: merge failed — leaving temp files for recovery');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('archive-failed', { path: BUFFER_DIR });
          }
          sessionArchiveActive = false;
        }
      });
    });
  });

  function finalize(outPath, videoChunks, audioFiles, micFiles) {
    const sizeMB = fs.existsSync(outPath)
      ? (fs.statSync(outPath).size / 1048576).toFixed(0) : '?';
    console.log(`Full session archived (${sizeMB}MB): ${outPath}`);

    const sidecar = {
      version: 1,
      archivedAt: now.toISOString(),
      sessionCode: currentSession ? currentSession.code : null,
      sessionStartUTC: recordingStartTime ? (recordingStartTime + clockOffset) : null,
      chunkSeconds: CHUNK_SECONDS,
      chunkCount: videoChunks.length,
      frameRate: recordFps,
      hasAudio: !!audioFiles && audioFiles.length > 0,
      hasMic: !!micFiles && micFiles.length > 0
    };
    try {
      fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(sidecar, null, 2));
    } catch(e) {}

    // Clean up video chunks
    for (const c of videoChunks) { try { fs.unlinkSync(c.path); } catch(e) {} }
    // Clean up audio disk chunks
    if (audioFiles) audioFiles.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
    if (micFiles) micFiles.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

    fullSessionAudioChunks = [];
    fullSessionMicChunks = [];

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-complete', { path: outPath, sizeMB });
    }
    sessionArchiveActive = false;
  }

  function cleanup(videoChunks, deleteChunks) {
    if (deleteChunks) for (const c of videoChunks) { try { fs.unlinkSync(c.path); } catch(e) {} }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-failed', { path: BUFFER_DIR });
    }
    sessionArchiveActive = false;
  }
}



function stopRecordingInternal() {
  stopBufferReadyWatcher();
  stopDiskWatcher();

  const wasRecording = !!ffmpegProcess;

  if (ffmpegProcess) {
    stoppingIntentionally = true;
    ffmpegProcess.kill();
    ffmpegProcess = null;
    console.log('Recording stopped');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-stopped');
  }

  // Give FFmpeg a beat to finalize the last chunk before we concat it
  if (wasRecording && fullSessionMode) {
    setTimeout(() => archiveFullSession(), 1200);
  }
}