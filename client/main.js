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

const DEFAULT_BUFFER_DIR = path.join(os.tmpdir(), 'apex-highlights-buffer');
const DEFAULT_CLIPS_DIR = path.join(app.getPath('videos'), 'PeakAbu');
const USER_PREFS_PATH = path.join(app.getPath('userData'), 'user-preferences.json');
const CHUNK_SECONDS = 10;

const LATEST_CLIENT_VERSION = {
  version: '0.1.30',
  downloadUrl: 'https://peakbu-media.nyc3.cdn.digitaloceanspaces.com/releases/PeakAbu-Setup-0.1.30.exe',
  releaseNotes: 'Game Window Capture (Beta) added — record a specific game window instead of your whole monitor.'
};

let BUFFER_DIR = DEFAULT_BUFFER_DIR;
let CLIPS_DIR = DEFAULT_CLIPS_DIR;

let maxChunks = 18;
let recordFps = 30;
let recordResolution = null;
let customHotkey = 'F9';
let startupHotkeyRegistered = true;
let captureHdr = false;
let captureAdapter = null;
let captureWindowTitle = null; 
let clockOffset = 0;
let clockUncertaintyMs = null;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let authToken = null;
let useCpuEncoder = false;
let currentMonitor = null;
let videoStartTime = null;
let audioFirstChunkTime = null;
let bufferReadyWatcher = null;
let recordingStartTime = null;
let recordingSessionTag = Date.now();
let lastHighlightBoundary = 0;

let hlAudioPath = null;
let hlMicPath = null;
let hlAudioChunkCount = 0;
let hlMicChunkCount = 0;

let fullSessionMode = false;
let fullSessionDir = null;
let sessionArchiveActive = false;
let diskWatchTimer = null;
let fullSessionAudioChunks = [];
let fullSessionMicChunks = [];
let fullSessionAudioIndex = 0;

const DISK_WARN_BYTES = 20 * 1024 * 1024 * 1024;
const DISK_STOP_BYTES = 10 * 1024 * 1024 * 1024;

// ================================
// WGC (WINDOW GRAPHICS CAPTURE) STATE
// ================================
let wgcCaptureMode = false;
let wgcSourceId = null;
let wgcLastWindowTitle = null;
let wgcFileStreams = {};
let wgcFiles = [];
let wgcRolloverTimer = null;
let wgcSaveInFlight = false;
let wgcMidSessionRestarts = 0;
const WGC_MAX_RESTARTS = 3;

const XINPUT_BUTTON_MAP = [
  0x1000, 0x2000, 0x4000, 0x8000,
  0x0100, 0x0200,
  -1, -2,
  0x0020, 0x0010,
  0x0040, 0x0080,
  0x0001, 0x0002, 0x0004, 0x0008,
  0
];

let xinputProcess = null;
let gamepadPrefs = { buttonIndex: null, triggerMode: 'double' };
let gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
let xinputConnected = false;

function startXInputPoll() {
  if (xinputProcess) return;

  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class XI {',
    '  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, ref XIS s);',
    '  [StructLayout(LayoutKind.Sequential)] public struct XIS { public int P; public XGP G; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct XGP {',
    '    public ushort B; public byte LT; public byte RT;',
    '    public short LX; public short LY; public short RX; public short RY;',
    '  }',
    '}',
    '"@',
    '$s = New-Object XI+XIS',
    'while($true) {',
    '  $r = [XI]::XInputGetState(0,[ref]$s)',
    '  if($r -eq 0) { [Console]::WriteLine("$($s.G.B),$($s.G.LT),$($s.G.RT)") }',
    '  else { [Console]::WriteLine("-1,0,0") }',
    '  Start-Sleep -Milliseconds 50',
    '}'
  ].join('\n');

  xinputProcess = spawn('powershell.exe', [
    '-NoProfile', '-Command', script
  ], { windowsHide: true });

  let lineBuffer = '';
  xinputProcess.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) processXInputLine(line.trim());
    }
  });

  xinputProcess.stderr.on('data', (d) => {
    console.log('XInput poll error:', d.toString().slice(0, 200));
  });

  xinputProcess.on('close', () => {
    xinputProcess = null;
    console.log('XInput poll process exited');
  });

  xinputProcess.on('error', (e) => {
    console.log('XInput poll spawn failed:', e.message);
    xinputProcess = null;
  });

  console.log('XInput OS-level gamepad polling started');
}

function stopXInputPoll() {
  if (xinputProcess) {
    try { xinputProcess.kill(); } catch (e) {}
    xinputProcess = null;
  }
}

function processXInputLine(line) {
  const parts = line.split(',');
  if (parts.length < 3) return;

  const buttons = parseInt(parts[0]);
  const lt = parseInt(parts[1]);
  const rt = parseInt(parts[2]);

  const connected = buttons !== -1;
  if (connected !== xinputConnected) {
    xinputConnected = connected;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('xinput-connection', connected);
    }
    console.log(`XInput controller ${connected ? 'connected' : 'disconnected'}`);
  }

  if (!connected) return;
  if (gamepadPrefs.buttonIndex === null) return;

  const btnIdx = gamepadPrefs.buttonIndex;
  if (btnIdx >= XINPUT_BUTTON_MAP.length) return;
  const mask = XINPUT_BUTTON_MAP[btnIdx];

  let pressed = false;
  if (mask === -1) pressed = lt > 200;
  else if (mask === -2) pressed = rt > 200;
  else if (mask > 0) pressed = (buttons & mask) !== 0;

  const now = Date.now();
  const st = gpState;

  if (gamepadPrefs.triggerMode === 'long') {
    if (pressed) {
      if (!st.isHeld) { st.isHeld = true; st.holdStart = now; st.fired = false; }
      else if (!st.fired && (now - st.holdStart) >= 800) {
        st.fired = true;
        console.log('Gamepad long-press save triggered');
        onHotkeyPressed();
      }
    } else {
      st.isHeld = false;
      st.fired = false;
    }
  } else {
    if (pressed) {
      if (!st.isHeld) {
        st.isHeld = true;
        if (now - st.lastPressTime < 400) {
          st.lastPressTime = 0;
          st.fired = true;
          console.log('Gamepad double-press save triggered');
          onHotkeyPressed();
        } else {
          st.lastPressTime = now;
        }
      }
    } else {
      st.isHeld = false;
    }
  }
}

let engineLadder = [];
let engineIndex = 0;
let stoppingIntentionally = false;
let midSessionRestarts = 0;
const MAX_MID_SESSION_RESTARTS = 3;

const ENGINE_LABELS = {
  'dda-nvenc':     'GPU capture + GPU encode (zero-copy)',
  'dda-nvenc-vf':  'GPU capture + GPU encode (scaled)',
  'dda-hdr-nvenc': 'GPU capture + HDR tonemap + GPU encode',
  'dda-hdr-x264':  'GPU capture + HDR tonemap + CPU encode',
  'dda-x264':      'GPU capture + CPU encode',
  'gdi-nvenc':     'Legacy capture + GPU encode',
  'gdi-x264':      'Legacy capture + CPU encode',
  'wgc-window':    'Window capture (Game Window Beta)',
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
      if (!recordResolution) l.push('dda-nvenc');
      l.push('dda-nvenc-vf');
      l.push('gdi-nvenc');
    }
    l.push('dda-x264');
    l.push('gdi-x264');
  }
  return l;
}

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

function killFFmpegTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const pid = proc.pid;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

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

    try {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.write('q');
      }
    } catch (e) {
      console.log('Graceful quit write failed, will force-kill:', e.message);
    }
  });
}

function sweepOrphanedFFmpeg() {
  if (process.platform !== 'win32') return;
  try {
    const marker = 'apex-highlights-buffer';
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

let micFirstChunkTime = null;
let micVolume = 80;
let micMuted = false;

function getArchiveBaseDir() {
  const base = (fullSessionDir && fs.existsSync(fullSessionDir))
    ? fullSessionDir
    : CLIPS_DIR;
  return path.join(base, 'archives');
}

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

      if (typeof prefs.wgcCaptureMode === 'boolean') {
        wgcCaptureMode = prefs.wgcCaptureMode;
        console.log(`Loaded capture mode preference: ${wgcCaptureMode ? 'Window' : 'Monitor'}`);
      }
      if (prefs.wgcLastWindowTitle) {
        wgcLastWindowTitle = prefs.wgcLastWindowTitle;
        console.log(`Loaded last window title: ${wgcLastWindowTitle}`);
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

ipcMain.on('server-clock-offset', (event, payload) => {
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

function buildCaptureArgs(engine, monitor) {
const chunkPattern = path.join(BUFFER_DIR, `chunk_${recordingSessionTag}_%03d.mp4`);  const fpsStr = String(recordFps);

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

  const adapterOpt = (captureAdapter !== null && captureAdapter !== undefined)
    ? `:adapter=${captureAdapter}` : '';
  const ddaInput = (tenBit) => [
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${monitor || 0}${adapterOpt}:framerate=${recordFps}${tenBit ? ':output_fmt=10bit' : ''}`
  ];

  const ddaCpuVf = `hwdownload,format=bgra${scaleTail},format=yuv420p`;

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

function getFreeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch (e) {
    return null;
  }
}

// ================================
// WGC BUFFER MANAGER
// ================================

function getWgcSpanSeconds() {
  const clipDurationSec = maxChunks * CHUNK_SECONDS;
  return Math.max(120, 3 * clipDurationSec);
}

function wgcFileTag() {
  return `wgc_${recordingSessionTag}`;
}

function wgcStartNewFile(fileId) {
  const filePath = path.join(BUFFER_DIR, `${fileId}.webm`);
  const ws = fs.createWriteStream(filePath, { flags: 'w' });
  ws.on('error', err => console.log(`WGC write stream error [${fileId}]:`, err.message));
  wgcFileStreams[fileId] = ws;
  wgcFiles.push({ fileId, path: filePath, startUTC: null, finalized: false });
  console.log(`WGC buffer file created: ${fileId}`);
  return fileId;
}

function wgcAppendChunk(fileId, buffer) {
  const ws = wgcFileStreams[fileId];
  if (!ws || ws.destroyed) {
    console.log(`WGC chunk dropped — no stream for ${fileId}`);
    return;
  }
  ws.write(Buffer.from(buffer));
}

function wgcSetFileStartUTC(fileId, utc) {
  const entry = wgcFiles.find(f => f.fileId === fileId);
  if (entry) entry.startUTC = utc;
}

function wgcFinalizeFile(fileId) {
  const ws = wgcFileStreams[fileId];
  if (ws && !ws.destroyed) {
    ws.end();
  }
  delete wgcFileStreams[fileId];
  const entry = wgcFiles.find(f => f.fileId === fileId);
  if (entry) entry.finalized = true;
  console.log(`WGC buffer file finalized: ${fileId}`);
}

function wgcCleanupOldFiles() {
  while (wgcFiles.length > 2) {
    const old = wgcFiles.shift();
    if (wgcFileStreams[old.fileId]) {
      wgcFileStreams[old.fileId].end();
      delete wgcFileStreams[old.fileId];
    }
    try { fs.unlinkSync(old.path); } catch (e) {}
    console.log(`WGC buffer file deleted: ${old.fileId}`);
  }
}

function wgcStartRolloverSchedule() {
  wgcStopRolloverSchedule();
  const spanMs = getWgcSpanSeconds() * 1000;
  wgcRolloverTimer = setInterval(() => {
    if (wgcSaveInFlight) {
      console.log('WGC rollover deferred — save in flight');
      return;
    }
    const newFileId = `${wgcFileTag()}_${Date.now() % 100000}`;
    wgcStartNewFile(newFileId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wgc-rollover-request', { newFileId });
    }
    setTimeout(() => wgcCleanupOldFiles(), 2000);
  }, spanMs - 1000);
  console.log(`WGC rollover schedule started: every ${getWgcSpanSeconds()}s`);
}

function wgcStopRolloverSchedule() {
  if (wgcRolloverTimer) {
    clearInterval(wgcRolloverTimer);
    wgcRolloverTimer = null;
  }
}

function wgcCleanupAll() {
  wgcStopRolloverSchedule();
  for (const fileId of Object.keys(wgcFileStreams)) {
    try { wgcFileStreams[fileId].end(); } catch (e) {}
  }
  wgcFileStreams = {};
  for (const f of wgcFiles) {
    try { fs.unlinkSync(f.path); } catch (e) {}
  }
  wgcFiles = [];
  wgcSaveInFlight = false;
  wgcMidSessionRestarts = 0;
  console.log('WGC buffer cleaned up');
}

function wgcFindCoveringFiles(startUTC, endUTC) {
  const candidates = wgcFiles.filter(f => f.startUTC && fs.existsSync(f.path));
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.startUTC - b.startUTC);

  for (const f of candidates) {
    if (f.startUTC <= startUTC) {
      return { mode: 'single', files: [f] };
    }
  }

  if (candidates.length >= 2) {
    const older = candidates[candidates.length - 2];
    const newer = candidates[candidates.length - 1];
    if (older.startUTC <= startUTC && newer.startUTC <= endUTC) {
      return { mode: 'straddle', files: [older, newer] };
    }
  }

  return { mode: 'single', files: [candidates[candidates.length - 1]] };
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
      stopRecordingInternal();
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
  }, 30000);
}

function stopDiskWatcher() {
  if (diskWatchTimer) { clearInterval(diskWatchTimer); diskWatchTimer = null; }
}

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

  if (wgcCaptureMode && wgcSourceId) {
    try {
      const staleWgc = fs.readdirSync(BUFFER_DIR).filter(f => f.startsWith('wgc_'));
      for (const f of staleWgc) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      if (staleWgc.length) console.log(`Cleaned ${staleWgc.length} stale WGC files`);
    } catch (e) {}

    wgcFiles = [];
    wgcFileStreams = {};
    wgcMidSessionRestarts = 0;
    wgcSaveInFlight = false;

    console.log(`Recording window via WGC — sourceId: ${wgcSourceId}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-engine', ENGINE_LABELS['wgc-window']);
      mainWindow.webContents.send('wgc-start-capture', {
        sourceId: wgcSourceId,
        fps: recordFps,
        resolution: recordResolution,
        bitrate: recordResolution
          ? (recordResolution.height <= 480 ? 3000000 : 5000000)
          : 8000000
      });
      mainWindow.webContents.send('buffer-ready');
    }
    recordingStartTime = Date.now();
    videoStartTime = recordingStartTime;
    lastHighlightBoundary = 0;
    audioFirstChunkTime = null;
    micFirstChunkTime = null;
    if (fullSessionMode) startDiskWatcher();
    return;
  }

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

  ffmpegProcess = spawn(getFFmpegPath(), ffmpegArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

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
  lastDropCount = 0;
  lowSpeedStreak = 0;
  audioFirstChunkTime = null;
  micFirstChunkTime = null;
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

      if (engine.includes('nvenc') && /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i.test(stderrTail)) {
        useCpuEncoder = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('encoder-fallback', 'CPU');
        }
      }

      engineIndex++;
      startRecording(currentMonitor);
      return;
    }

    ffmpegProcess = null;
    const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
    fs.appendFileSync(logPath, `\n=== ENGINE [${engine}] DIED MID-SESSION (code ${code}, after ${(ranForMs/1000).toFixed(0)}s) ===\n${stderrTail.slice(-800)}\n`);
    console.log(`Capture died mid-session [${engine}] code ${code} after ${(ranForMs/1000).toFixed(0)}s — tail:`, stderrTail.slice(-400));

    if (midSessionRestarts < MAX_MID_SESSION_RESTARTS) {
      midSessionRestarts++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-engine',
          `⚠ Capture process died — auto-restarting (${midSessionRestarts}/${MAX_MID_SESSION_RESTARTS})`);
      }
      setTimeout(() => {
        if (!stoppingIntentionally) {
          recordingSessionTag = Date.now();
          startRecording(currentMonitor);
        }
      }, 1500);
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error',
          'Recording stopped — capture crashed repeatedly. Check peakabu-ffmpeg.log in your temp folder, then press Start again.');
        mainWindow.webContents.send('recording-stopped');
      }
    }
  });
}

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
    setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp), postDelay);
  } else {
    doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp);
  }
}

function doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs = null, retryCount = 0) {
  if (wgcCaptureMode && wgcFiles.length > 0) {
    wgcSaveInFlight = true;

    const durationSec = durationMs / 1000;
    const windowStartLocal = (saveTimeUTC - clockOffset) - (0.9 * durationMs);
    const windowEndLocal = (saveTimeUTC - clockOffset) + (0.1 * durationMs);

    const covering = wgcFindCoveringFiles(windowStartLocal, windowEndLocal);
    if (!covering) {
      wgcSaveInFlight = false;
      console.log(`WGC save: no covering buffer files, retry=${retryCount}`);
      if (retryCount < 4) {
        if (retryCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('post-capture-started', { postDelay: 3000 });
        }
        setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1), 3000);
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Window capture buffer not ready yet');
      }
      return;
    }

    const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
    const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

    const metadata = {
      clipId: crypto.randomUUID(),
      version: 2,
      saveTimeUTC,
      startTimeUTC: Math.round(windowStartLocal + clockOffset),
      endTimeUTC: Math.round(windowEndLocal + clockOffset),
      durationMs: durationMs,
      clipDurationMs: durationMs,
      frameRate: recordFps,
      clockOffsetMs: clockOffset,
      syncUncertaintyMs: clockUncertaintyMs,
      captureEngine: 'wgc-window',
      userId: null,
      sessionId: currentSession ? currentSession.code : null,
      coordinated_timestamp: coordinatedTs || null
    };

    const encoderArgs = useCpuEncoder
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23']
      : ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v',
         recordResolution ? (recordResolution.height <= 480 ? '3M' : '5M') : '8M'];

    function wgcExtractFail(msg) {
      wgcSaveInFlight = false;
      console.log('WGC save failed:', msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', msg);
      }
    }

    if (covering.mode === 'single') {
      const file = covering.files[0];
      const ssOffset = Math.max(0, (windowStartLocal - file.startUTC) / 1000);

      console.log(`WGC save: single file extract — ss=${ssOffset.toFixed(3)}s, t=${durationSec}s from ${file.fileId}`);

      const extract = spawn(getFFmpegPath(), [
        '-fflags', '+genpts+igndts',
        '-ss', ssOffset.toFixed(3),
        '-t', durationSec.toFixed(3),
        '-i', file.path,
        ...encoderArgs,
        '-fps_mode', 'cfr', '-r', String(recordFps),
        '-movflags', '+faststart',
        '-y', outputPath
      ], { windowsHide: true });

      extract.stderr.on('data', d => console.log('WGC extract:', d.toString()));
      extract.on('close', (code) => {
        wgcSaveInFlight = false;
        if (code === 0 && fs.existsSync(outputPath)) {
          wgcFinishSave(outputPath, metadataPath, metadata, durationMs, windowStartLocal);
        } else {
          wgcExtractFail('Failed to extract window capture clip');
        }
      });
    } else {
      const older = covering.files[0];
      const newer = covering.files[1];
      const olderSs = Math.max(0, (windowStartLocal - older.startUTC) / 1000);
      const splitPoint = Math.max(0.1, (newer.startUTC - windowStartLocal) / 1000);
      const newerDur = Math.max(0.1, durationSec - splitPoint);

      const tempId = Date.now();
      const tempA = path.join(BUFFER_DIR, `wgc_temp_a_${tempId}.mp4`);
      const tempB = path.join(BUFFER_DIR, `wgc_temp_b_${tempId}.mp4`);
      const concatList = path.join(BUFFER_DIR, `wgc_concat_${tempId}.txt`);
      const cleanupParts = () => [tempA, tempB, concatList].forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

      console.log(`WGC save: straddle — older ss=${olderSs.toFixed(3)}s dur=${splitPoint.toFixed(3)}s, newer dur=${newerDur.toFixed(3)}s`);

      const extractA = spawn(getFFmpegPath(), [
        '-fflags', '+genpts+igndts',
        '-ss', olderSs.toFixed(3),
        '-t', splitPoint.toFixed(3),
        '-i', older.path,
        ...encoderArgs,
        '-fps_mode', 'cfr', '-r', String(recordFps),
        '-movflags', '+faststart',
        '-y', tempA
      ], { windowsHide: true });

      extractA.stderr.on('data', d => console.log('WGC extractA:', d.toString()));
      extractA.on('close', (codeA) => {
        if (codeA !== 0) {
          cleanupParts();
          wgcExtractFail('Failed to extract window capture clip (part A)');
          return;
        }

        const extractB = spawn(getFFmpegPath(), [
          '-fflags', '+genpts+igndts',
          '-t', newerDur.toFixed(3),
          '-i', newer.path,
          ...encoderArgs,
          '-fps_mode', 'cfr', '-r', String(recordFps),
          '-movflags', '+faststart',
          '-y', tempB
        ], { windowsHide: true });

        extractB.stderr.on('data', d => console.log('WGC extractB:', d.toString()));
        extractB.on('close', (codeB) => {
          if (codeB !== 0) {
            cleanupParts();
            wgcExtractFail('Failed to extract window capture clip (part B)');
            return;
          }

          fs.writeFileSync(concatList, `file '${tempA.replace(/\\/g, '/')}'\nfile '${tempB.replace(/\\/g, '/')}'`);
          const concat = spawn(getFFmpegPath(), [
            '-f', 'concat', '-safe', '0', '-i', concatList,
            '-c', 'copy', '-movflags', '+faststart',
            '-y', outputPath
          ], { windowsHide: true });

          concat.stderr.on('data', d => console.log('WGC concat:', d.toString()));
          concat.on('close', (codeC) => {
            wgcSaveInFlight = false;
            cleanupParts();
            if (codeC === 0 && fs.existsSync(outputPath)) {
              wgcFinishSave(outputPath, metadataPath, metadata, durationMs, windowStartLocal);
            } else {
              wgcExtractFail('Failed to join window capture clip parts');
            }
          });
        });
      });
    }
    return;
  }

  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
    .map(f => {
      const st = fs.statSync(path.join(BUFFER_DIR, f));
      return {
        name: f, path: path.join(BUFFER_DIR, f),
        time: st.mtimeMs,
        birth: st.birthtimeMs,
        size: st.size
      };
    })
    .filter(f => f.size > 100000)
    .sort((a, b) => a.time - b.time);

  const withoutInProgress = allVideoFiles.slice(0, -1);
  const newSinceLastSave = withoutInProgress.filter(f =>
    f.time > lastHighlightBoundary && f.time > recordingStartTime
  );
  const videoFiles = newSinceLastSave.slice(-clipChunks);

  if (videoFiles.length === 0) {
    const newest = allVideoFiles.length ? allVideoFiles[allVideoFiles.length - 1] : null;
    console.log('No eligible chunks: ' +
      `total=${allVideoFiles.length}, boundary=${lastHighlightBoundary}, ` +
      `recStart=${recordingStartTime}, newestMtime=${newest ? newest.time : 'n/a'}, ` +
      `captureAlive=${!!(ffmpegProcess && ffmpegProcess.exitCode === null)}, retry=${retryCount}`);

    if (retryCount < 4) {
      if (retryCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('post-capture-started', { postDelay: 3000 });
      }
      setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1), 3000);
      return;
    }

    console.log('No completed chunks after retries');
    if (mainWindow && !mainWindow.isDestroyed()) {
      const dead = !(ffmpegProcess && ffmpegProcess.exitCode === null);
      mainWindow.webContents.send('highlight-error', dead
        ? 'Capture is not running — press Start to restart recording'
        : 'Buffer not ready yet, wait a few more seconds');
    }
    return;
  }

  lastHighlightBoundary = videoFiles[videoFiles.length - 1].time;

  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && !micMuted && fs.existsSync(hlMicPath));
  console.log(`Saving highlight: ${videoFiles.length}/${clipChunks} chunks, audio=${hasAudio} (${hlAudioChunkCount} appends), mic=${hasMic} (${hlMicChunkCount} appends) (clip: ${durationMs / 1000}s)`);

  const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

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

        mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '-y', outputPath);

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

function wgcFinishSave(videoOnlyPath, metadataPath, metadata, durationMs, clipVideoStartMs) {
  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && !micMuted && fs.existsSync(hlMicPath));

  function finish(finalPath) {
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    console.log('WGC highlight saved to', finalPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-saved', finalPath);
    }
    uploadHighlight(finalPath, metadataPath);
  }

  if (!hasAudio) { finish(videoOnlyPath); return; }

  const durationSec = durationMs / 1000;
  const clipSpanSec = durationSec + 2;
  const audioDeltaSec = audioFirstChunkTime ? (clipVideoStartMs - audioFirstChunkTime) / 1000 : 0;
  const audioSkipSec = Math.max(0, audioDeltaSec);
  const audioDelaySec = Math.max(0, -audioDeltaSec);
  const micDeltaSec = micFirstChunkTime ? (clipVideoStartMs - micFirstChunkTime) / 1000 : 0;
  const micSkipSec = Math.max(0, micDeltaSec);
  const micDelaySec = Math.max(0, -micDeltaSec);

  const tempId = Date.now();
  const tempAudioPath = path.join(BUFFER_DIR, `wgc_temp_audio_${tempId}.m4a`);
  const tempMicPath = hasMic ? path.join(BUFFER_DIR, `wgc_temp_mic_${tempId}.m4a`) : null;
  const tempMerged = path.join(BUFFER_DIR, `wgc_temp_merged_${tempId}.mp4`);

  console.log(`WGC audio sync: skip=${audioSkipSec.toFixed(3)}s delay=${audioDelaySec.toFixed(3)}s span=${clipSpanSec.toFixed(1)}s`);

  const repairAudio = spawn(getFFmpegPath(), [
    '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
    '-i', hlAudioPath,
    '-af', 'aresample=async=1000:first_pts=0',
    '-ss', audioSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioPath
  ], { windowsHide: true });

  repairAudio.stderr.on('data', d => console.log('WGC RepairAudio:', d.toString()));
  repairAudio.on('close', (repairCode) => {
    if (repairCode !== 0 || !fs.existsSync(tempAudioPath)) {
      try { fs.unlinkSync(tempAudioPath); } catch(e) {}
      finish(videoOnlyPath);
      return;
    }

    function doMerge(includeMic) {
      const mergeArgs = ['-i', videoOnlyPath];
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

      mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '-y', tempMerged);

      const merge = spawn(getFFmpegPath(), mergeArgs, { windowsHide: true });
      merge.stderr.on('data', d => console.log('WGC Merge:', d.toString()));
      merge.on('close', (mergeCode) => {
        [tempAudioPath, tempMicPath].forEach(p => { if (p) try { fs.unlinkSync(p); } catch(e) {} });
        if (mergeCode === 0 && fs.existsSync(tempMerged)) {
          try { fs.unlinkSync(videoOnlyPath); } catch(e) {}
          try { fs.renameSync(tempMerged, videoOnlyPath); } catch(e) {}
        } else {
          try { fs.unlinkSync(tempMerged); } catch(e) {}
        }
        finish(videoOnlyPath);
      });
    }

    if (hasMic && tempMicPath) {
      const repairMic = spawn(getFFmpegPath(), [
        '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
        '-i', hlMicPath,
        '-af', 'aresample=async=1000:first_pts=0',
        '-ss', micSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
        '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
      ], { windowsHide: true });
      repairMic.stderr.on('data', d => console.log('WGC RepairMic:', d.toString()));
      repairMic.on('close', (micCode) => doMerge(micCode === 0 && fs.existsSync(tempMicPath)));
    } else {
      doMerge(false);
    }
  });
}

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

  ipcMain.handle('wgc-list-windows', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources
      .filter(s => s.name && s.name.trim() !== '' && s.name !== 'Peak-Abu')
      .map(s => ({
        id: s.id,
        name: s.name,
        thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : null,
        appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null
      }));
  });

  ipcMain.handle('wgc-get-capture-mode', () => ({
    mode: wgcCaptureMode ? 'window' : 'monitor',
    lastWindowTitle: wgcLastWindowTitle
  }));

  ipcMain.handle('wgc-set-capture-mode', (event, { mode, windowTitle }) => {
    wgcCaptureMode = (mode === 'window');
    if (windowTitle !== undefined) wgcLastWindowTitle = windowTitle || null;
    const prefs = loadUserPreferences();
    prefs.wgcCaptureMode = wgcCaptureMode;
    prefs.wgcLastWindowTitle = wgcLastWindowTitle;
    saveUserPreferences(prefs);
    console.log(`Capture mode set to: ${wgcCaptureMode ? 'Window' : 'Monitor'}, title: ${wgcLastWindowTitle}`);
    return { success: true };
  });

  ipcMain.handle('wgc-init-buffer', () => {
    const fileId = `${wgcFileTag()}_${Date.now() % 100000}`;
    wgcStartNewFile(fileId);
    wgcStartRolloverSchedule();
    return { fileId };
  });

  ipcMain.on('wgc-recorder-started', (event, { fileId, fileStartUTC }) => {
    wgcSetFileStartUTC(fileId, fileStartUTC);
    console.log(`WGC recorder started: ${fileId} at UTC ${fileStartUTC}`);
  });

  ipcMain.on('wgc-chunk', (event, { fileId, buf }) => {
    wgcAppendChunk(fileId, buf);
  });

  ipcMain.on('wgc-recorder-stopped', (event, { fileId }) => {
    wgcFinalizeFile(fileId);
  });

  ipcMain.on('wgc-capture-failed', (event, { reason }) => {
    console.log(`WGC capture failed: ${reason}`);
    if (wgcMidSessionRestarts < WGC_MAX_RESTARTS) {
      wgcMidSessionRestarts++;
      console.log(`WGC auto-restart ${wgcMidSessionRestarts}/${WGC_MAX_RESTARTS}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-restart-capture', {
          attempt: wgcMidSessionRestarts,
          maxAttempts: WGC_MAX_RESTARTS
        });
      }
    } else {
      console.log('WGC max restarts reached — falling back to Monitor mode');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-fallback-to-monitor', {
          reason: 'Window capture failed repeatedly — recording your monitor instead.'
        });
      }
      wgcCleanupAll();
      wgcCaptureMode = false;
      stoppingIntentionally = false;
      midSessionRestarts = 0;
      recordingSessionTag = Date.now();
      engineLadder = buildEngineLadder();
      engineIndex = 0;
      startRecording(currentMonitor);
    }
  });

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
          if (!Array.isArray(parsed)) parsed = [parsed];
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

  ipcMain.handle('get-current-hdr', () => captureHdr);
  ipcMain.handle('get-current-adapter', () => captureAdapter);

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

  ipcMain.on('start-recording', async (event, { monitorIndex, windowTitle }) => {
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      const dying = ffmpegProcess;
      ffmpegProcess = null;
      await killFFmpegTree(dying);
    }

    captureWindowTitle = windowTitle || null;

    if (wgcCaptureMode) {
      wgcSourceId = windowTitle || null;
    }

    fullSessionAudioChunks = [];
    fullSessionMicChunks = [];
    fullSessionAudioIndex = 0;
    ['fs_audio_full.webm', 'fs_mic_full.webm'].forEach(f => {
      try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch(e) {}
    });

    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleaned: removed ${stale.length} stale files`);
    } catch (e) { console.log('Buffer clean skipped:', e.message); }

    stoppingIntentionally = false;
    midSessionRestarts = 0;
    recordingSessionTag = Date.now();

    hlAudioPath = path.join(BUFFER_DIR, `hl_audio_${recordingSessionTag}.webm`);
    hlMicPath = path.join(BUFFER_DIR, `hl_mic_${recordingSessionTag}.webm`);
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;

    engineLadder = buildEngineLadder();
    engineIndex = 0;
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

    stopDiskWatcher();

    if (wgcCaptureMode) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-stop-capture');
        mainWindow.webContents.send('recording-stopped');
      }
      setTimeout(() => wgcCleanupAll(), 1500);
    }

    if (fullSessionMode) {
      setTimeout(() => archiveFullSession(), 1200);
      return;
    }

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

  ipcMain.on('save-audio-chunk', (event, buffer) => {
    const buf = Buffer.from(buffer);

    if (hlAudioPath) {
      try {
        fs.appendFileSync(hlAudioPath, buf);
        hlAudioChunkCount++;
      } catch (e) { console.log('Highlight audio append failed:', e.message); }
    }

    if (fullSessionMode) {
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

  ipcMain.handle('set-user-pref', (event, key, value) => {
    const prefs = loadUserPreferences();
    prefs[key] = value;
    saveUserPreferences(prefs);
    if (key === 'gamepadButton') {
      gamepadPrefs.buttonIndex = (value === null || value === undefined) ? null : parseInt(value);
      gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
    }
    if (key === 'gamepadTriggerMode') {
      gamepadPrefs.triggerMode = value || 'double';
      gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
    }
  });

  ipcMain.handle('get-user-pref', (event, key) => {
    const prefs = loadUserPreferences();
    return prefs[key] !== undefined ? prefs[key] : null;
  });

  ipcMain.handle('get-free-space-gb', () => {
    const free = getFreeBytes(getActiveStorageRoot());
    return free === null ? null : +(free / 1e9).toFixed(1);
  });

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
}

app.whenReady().then(async () => {
  const startupPrefs = loadUserPreferences();
  gamepadPrefs.buttonIndex = (startupPrefs.gamepadButton !== null && startupPrefs.gamepadButton !== undefined) ? parseInt(startupPrefs.gamepadButton) : null;
  gamepadPrefs.triggerMode = startupPrefs.gamepadTriggerMode || 'double';
  startXInputPoll();
  ensureFolders();
  sweepOrphanedFFmpeg();
  createWindow();
  startupHotkeyRegistered = globalShortcut.register(customHotkey, onHotkeyPressed);
  if (startupHotkeyRegistered) console.log(`${customHotkey} hotkey registered successfully`);
  else console.log(`WARNING: ${customHotkey} hotkey registration FAILED - another app may be using it`);
  setTimeout(() => checkForUpdates(mainWindow), 3000);
});

let isCleaningUp = false;

app.on('before-quit', async (event) => {
  if (isCleaningUp) return;
  if (ffmpegProcess) {
    event.preventDefault();
    isCleaningUp = true;
    stoppingIntentionally = true;
    stopBufferReadyWatcher();
    stopXInputPoll();
    const dying = ffmpegProcess;
    ffmpegProcess = null;
    await killFFmpegTree(dying);
    globalShortcut.unregisterAll();
    app.quit();
  } else {
    if (wgcCaptureMode) wgcCleanupAll();
    stopBufferReadyWatcher();
    stopXInputPoll();
    globalShortcut.unregisterAll();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


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

  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const lastSize = (() => { try { return fs.statSync(last.path).size; } catch(e) { return 0; } })();
    const minViableBytes = recordFps * CHUNK_SECONDS * 5000;
    if (lastSize < minViableBytes) {
      const dropped = chunks.pop();
      console.log(`Archive: dropping corrupt final chunk ${dropped.name} (${lastSize} bytes)`);
      try { fs.unlinkSync(dropped.path); } catch(e) {}
    } else {
      console.log(`Archive: keeping final chunk ${last.name} (${lastSize} bytes — looks complete)`);
    }
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
      finalize(outputPath, chunks, null, null);
      return;
    }

    const { spawnSync } = require('child_process');
    let videoDurationSec = 0;

    try {
      const probe = spawnSync(getFFmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', tempVideoPath
      ], { windowsHide: true, encoding: 'utf8' });
      videoDurationSec = parseFloat((probe.stdout || '').trim()) || 0;
    } catch (e) { videoDurationSec = 0; }

    if (videoDurationSec <= 0) {
      try {
        const info = spawnSync(getFFmpegPath(), ['-i', tempVideoPath], {
          windowsHide: true, encoding: 'utf8'
        });
        const errOut = (info.stderr || '') + (info.stdout || '');
        const m = errOut.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          videoDurationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        }
      } catch (e) { videoDurationSec = 0; }
      if (videoDurationSec > 0) console.log('Archive: duration via ffmpeg stderr fallback');
    }

    console.log(`Archive: concatenated video duration = ${videoDurationSec.toFixed(3)}s`);

    const audioSrc = fullSessionAudioChunks[0];
    const tempAudioReenc = path.join(BUFFER_DIR, `fs_temp_audio_${Date.now()}.m4a`);
    const concatAudio = spawn(getFFmpegPath(), [
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', audioSrc,
      '-af', 'aresample=async=1000:first_pts=0',
      ...(videoDurationSec > 0 ? ['-t', videoDurationSec.toFixed(3)] : []),
      '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioReenc
    ], { windowsHide: true });

    let audioErr = '';
    concatAudio.stderr.on('data', d => { audioErr += d.toString(); });

    concatAudio.on('close', (audioCode) => {
      console.log(`=== AUDIO RE-ENCODE exit code: ${audioCode} ===`);
      console.log(audioErr.slice(-2000));
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
        const micResult = spawnSync(getFFmpegPath(), [
          '-fflags', '+genpts+igndts',
          '-err_detect', 'ignore_err',
          '-i', fullSessionMicChunks[0],
          '-af', 'aresample=async=1000:first_pts=0',
          ...(videoDurationSec > 0 ? ['-t', videoDurationSec.toFixed(3)] : []),
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
        '-shortest', '-movflags', '+faststart', '-y', outputPath);

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

    for (const c of videoChunks) { try { fs.unlinkSync(c.path); } catch(e) {} }
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

  if (wgcCaptureMode) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wgc-stop-capture');
    }
    setTimeout(() => wgcCleanupAll(), 1500);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-stopped');
  }

  if (wasRecording && fullSessionMode) {
    setTimeout(() => archiveFullSession(), 1200);
  }
}