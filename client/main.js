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
let maxChunks = 18;          // default 3 minutes (18 × 10sec)
let recordFps = 30;          // default 30fps
let recordResolution = null; // null = native, or { width, height }
let customHotkey = 'F9';     // default, can be overridden from preferences

let clockOffset = 0;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let audioBuffers = []; // in-memory rolling buffer of audio chunks

function ensureFolders() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// --- User Preferences Management ---
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

// Validate hotkey format (Electron accelerator format)
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

function getPreciseUTC() {
  return Date.now() + clockOffset;
}

function pruneOldChunks() {
  const files = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs
    }))
    .sort((a, b) => a.time - b.time);

  while (files.length > maxChunks) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(BUFFER_DIR, oldest.name));
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') {
        console.log('Skipping locked chunk:', oldest.name);
      } else {
        console.log('Prune error:', err.message);
      }
    }
  }
}

function startRecording(monitor) {
  ensureFolders();

  const screen = require('electron').screen;
  const displays = screen.getAllDisplays();
  const target = monitor !== undefined ? displays[monitor] : displays[0];
  const { x, y, width, height } = target.bounds;

  console.log(`Recording monitor ${monitor}: ${width}x${height} at (${x},${y})`);
  console.log(`Settings: ${recordFps}fps, resolution: ${recordResolution ? recordResolution.width + 'x' + recordResolution.height : 'native'}, buffer: ${maxChunks * CHUNK_SECONDS}s`);

  const chunkPattern = path.join(BUFFER_DIR, 'chunk_%03d.mp4');

  const ffmpegArgs = [
    '-f', 'gdigrab',
    '-framerate', String(recordFps),
    '-offset_x', String(x),
    '-offset_y', String(y),
    '-video_size', `${width}x${height}`,
    '-i', 'desktop'
  ];

  if (recordResolution) {
    ffmpegArgs.push('-vf', `scale=${recordResolution.width}:${recordResolution.height}`);
  }

  ffmpegArgs.push(
    '-c:v', 'h264_nvenc',
    '-preset', 'p4',
    '-tune', 'hq',
    '-b:v', recordResolution ? (recordResolution.height <= 480 ? '3M' : '5M') : '8M',
    '-g', String(recordFps),
    '-keyint_min', String(recordFps),
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-an',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    '-y',
    chunkPattern
  );

  ffmpegProcess = spawn(getFFmpegPath(), ffmpegArgs, {
    windowsHide: true
  });

  ffmpegProcess.stderr.on('data', (data) => {
    console.log('FFmpeg:', data.toString());
    pruneOldChunks();
  });

  ffmpegProcess.on('close', (code) => {
    console.log('FFmpeg stopped with code', code);
  });
}

function saveHighlight(coordinatedTimestamp = null) {
  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
    .map(f => ({
      name: f,
      path: path.join(BUFFER_DIR, f),
      time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs,
      size: fs.statSync(path.join(BUFFER_DIR, f)).size
    }))
    .filter(f => f.size > 100000)
    .sort((a, b) => a.time - b.time);

  const videoFiles = allVideoFiles.slice(0, -1);

  if (videoFiles.length === 0) {
    console.log('No completed chunks yet');
    mainWindow.webContents.send('highlight-error', 'Buffer not ready yet, wait a few more seconds');
    return;
  }

  const hasAudio = audioBuffers.length > 0;
  console.log(`Saving highlight: ${videoFiles.length} video chunks, ${audioBuffers.length} audio chunks in memory`);

  const saveTimeUTC = coordinatedTimestamp || getPreciseUTC();
  const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

  const oldestChunkTime = videoFiles[0].time;
  const chunkAgeMs = Date.now() - oldestChunkTime;
  const startTimeUTC = saveTimeUTC - chunkAgeMs;

  const metadata = {
    version: 1,
    saveTimeUTC,
    startTimeUTC,
    endTimeUTC: saveTimeUTC,
    durationMs: chunkAgeMs,
    frameRate: recordFps,
    clockOffsetMs: clockOffset,
    userId: null,
    sessionId: currentSession ? currentSession.code : null,
    coordinated_timestamp: coordinatedTimestamp || null
  };

  const videoListPath = path.join(BUFFER_DIR, 'filelist.txt');
  const videoContent = videoFiles
    .map(f => `file '${f.path.replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(videoListPath, videoContent);

  if (hasAudio) {
    const combinedAudio = Buffer.concat(audioBuffers.map(c => c.data));
    const tempAudioPath = path.join(BUFFER_DIR, 'temp_audio.webm');
    fs.writeFileSync(tempAudioPath, combinedAudio);
    console.log(`Combined audio: ${audioBuffers.length} chunks -> ${(combinedAudio.length / 1024).toFixed(0)}KB`);

    const tempVideoPath = path.join(BUFFER_DIR, 'temp_video.mp4');
    const concatVideo = spawn(getFFmpegPath(), [
      '-f', 'concat', '-safe', '0',
      '-i', videoListPath,
      '-c', 'copy', '-y',
      tempVideoPath
    ]);

    concatVideo.stderr.on('data', d => console.log('ConcatVideo:', d.toString()));

    concatVideo.on('close', (videoCode) => {
      if (videoCode !== 0) {
        mainWindow.webContents.send('highlight-error', 'Failed to concat video');
        return;
      }

      const merge = spawn(getFFmpegPath(), [
        '-i', tempVideoPath,
        '-i', tempAudioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-y',
        outputPath
      ]);

      merge.stderr.on('data', d => console.log('Merge:', d.toString()));

      merge.on('close', (code) => {
        if (code === 0) {
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          console.log('Highlight saved to', outputPath);
          console.log('Metadata saved to', metadataPath);
          mainWindow.webContents.send('highlight-saved', outputPath);
          uploadHighlight(outputPath, metadataPath);
        } else {
          console.log('Audio merge failed, saving video only');
          const concatOnly = spawn(getFFmpegPath(), [
            '-f', 'concat', '-safe', '0',
            '-i', videoListPath,
            '-c', 'copy', '-y',
            outputPath
          ]);
          concatOnly.stderr.on('data', d => console.log('ConcatOnly:', d.toString()));
          concatOnly.on('close', (c) => {
            if (c === 0) {
              fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
              mainWindow.webContents.send('highlight-saved', outputPath);
              uploadHighlight(outputPath, metadataPath);
            } else {
              mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
            }
          });
        }
      });
    });
  } else {
    const concat = spawn(getFFmpegPath(), [
      '-f', 'concat', '-safe', '0',
      '-i', videoListPath,
      '-c', 'copy', '-y',
      outputPath
    ]);

    concat.stderr.on('data', d => console.log('Concat:', d.toString()));

    concat.on('close', (code) => {
      if (code === 0) {
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        console.log('Highlight saved to', outputPath);
        mainWindow.webContents.send('highlight-saved', outputPath);
        uploadHighlight(outputPath, metadataPath);
      } else {
        mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
      }
    });
  }
}

// ================================
// UPLOAD HIGHLIGHT
// Uses form.submit() to handle Content-Length, streaming, and headers correctly.
// ================================
function uploadHighlight(videoPath, metadataPath) {
  if (!currentSession) {
    console.log('No active session, skipping upload');
    return;
  }

  // Diagnostic: confirm file exists and has real content before we try to send
  console.log('=== UPLOAD START ===');
  console.log('videoPath:', videoPath);
  console.log('exists:', fs.existsSync(videoPath));
  if (!fs.existsSync(videoPath)) {
    console.log('ABORT: video file does not exist on disk');
    mainWindow.webContents.send('upload-error', 'Video file missing on disk');
    return;
  }
  const videoStats = fs.statSync(videoPath);
  console.log('size:', videoStats.size);
  console.log('basename:', path.basename(videoPath));
  if (videoStats.size === 0) {
    console.log('ABORT: video file is empty');
    mainWindow.webContents.send('upload-error', 'Video file is empty');
    return;
  }

  console.log(`Uploading highlight to session ${currentSession.code}...`);
  mainWindow.webContents.send('upload-progress', 0);

  const form = new FormData();
  form.append('video', fs.createReadStream(videoPath), {
    filename: path.basename(videoPath),
    contentType: 'video/mp4'
  });
  if (metadataPath && fs.existsSync(metadataPath)) {
    form.append('metadata', fs.createReadStream(metadataPath), {
      filename: path.basename(metadataPath),
      contentType: 'application/json'
    });
  }

  // form.submit() handles Content-Length calculation, headers, streaming,
  // and request lifecycle in one call. Much more reliable than manual pipe.
  form.submit({
    protocol: 'https:',
    host: 'peakabu.app',
    port: 443,
    path: `/sessions/${currentSession.code}/upload`,
    method: 'POST',
    headers: {
      'x-username': currentSession.username
    }
  }, (err, res) => {
    if (err) {
      console.log('Upload connection error:', err.message);
      mainWindow.webContents.send('upload-progress', -1);
      mainWindow.webContents.send('upload-error', 'Could not reach server');
      return;
    }

    console.log('=== UPLOAD RESPONSE ===');
    console.log('statusCode:', res.statusCode);
    console.log('headers:', JSON.stringify(res.headers));

    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log('body:', body);
      try {
        const result = JSON.parse(body);
        if (res.statusCode === 201) {
          console.log('Upload successful:', result.uploadId);
          mainWindow.webContents.send('upload-progress', 100);
          mainWindow.webContents.send('upload-complete', result.uploadId);
        } else {
          console.log('Upload failed:', result.error);
          mainWindow.webContents.send('upload-progress', -1);
          mainWindow.webContents.send('upload-error', result.error);
        }
      } catch (parseErr) {
        console.log('Upload response parse error:', parseErr.message);
        console.log('Raw body was:', body);
        mainWindow.webContents.send('upload-progress', -1);
        mainWindow.webContents.send('upload-error', 'Server returned invalid response');
      }
      // Resume the response stream to make sure it's consumed
      res.resume();
    });
  });
}

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      experimentalFeatures: true
    }
  });

  mainWindow.loadFile('index.html');
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.handle('get-desktop-sources', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  // IPC: Pick storage directory
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
      console.log(`Storage directory set to: ${CLIPS_DIR}`);
      return { success: true, path: CLIPS_DIR };
    }

    return { success: false };
  });

  // IPC: Get current storage directory
  ipcMain.handle('get-storage-directory', () => {
    return CLIPS_DIR;
  });

  // IPC: First launch check
  ipcMain.handle('is-first-launch', () => {
    const prefs = loadUserPreferences();
    return !prefs.hasLaunched;
  });

  ipcMain.handle('mark-first-launch-done', () => {
    const prefs = loadUserPreferences();
    prefs.hasLaunched = true;
    saveUserPreferences(prefs);
  });

  ipcMain.handle('get-install-path', () => {
    return app.isPackaged
      ? path.dirname(process.execPath)
      : path.join(__dirname);
  });

  // IPC: Save highlight (local hotkey press)
  ipcMain.on('save-highlight', () => saveHighlight());

  // IPC: Broadcast save highlight
  ipcMain.on('broadcast-save-highlight', (event, { coordinated_timestamp }) => {
    console.log(`Received broadcast save-highlight with timestamp: ${coordinated_timestamp}`);
    saveHighlight(coordinated_timestamp);
  });

  // IPC: Set socket.io connection
  ipcMain.on('set-socket-io', (event, socketId) => {
    console.log('Socket.IO connection noted in main process');
  });

  ipcMain.on('session-connected', (event, { code, username }) => {
    currentSession = { code, username };
    console.log(`Session tracked in main: ${code} as ${username}`);
  });

  ipcMain.on('session-disconnected', () => {
    currentSession = null;
    console.log('Session cleared in main');
  });

  ipcMain.on('start-recording', (event, { monitorIndex }) => {
    if (ffmpegProcess) {
      ffmpegProcess.kill();
      ffmpegProcess = null;
    }
    audioBuffers = [];
    startRecording(monitorIndex);
    mainWindow.webContents.send('recording-started', monitorIndex);
  });

  ipcMain.on('stop-recording', () => {
    if (ffmpegProcess) {
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
      console.log(`Buffer length set to ${settings.bufferSeconds}s (${maxChunks} chunks)`);
    }

    if (settings.fps && [30, 60].includes(settings.fps)) {
      recordFps = settings.fps;
      console.log(`Framerate set to ${recordFps}fps`);
    }

    const resMap = {
      'native': null,
      '720': { width: 1280, height: 720 },
      '480': { width: 854, height: 480 }
    };
    if (settings.resolution && settings.resolution in resMap) {
      recordResolution = resMap[settings.resolution];
      console.log(`Resolution set to ${settings.resolution}`);
    }

    if (settings.hotkey && isValidHotkey(settings.hotkey)) {
      if (customHotkey) {
        globalShortcut.unregister(customHotkey);
      }
      customHotkey = settings.hotkey;
      const registered = globalShortcut.register(customHotkey, () => {
        console.log(`${customHotkey} pressed`);
        saveHighlight();
      });
      if (registered) {
        console.log(`Hotkey changed to: ${customHotkey}`);
        const prefs = loadUserPreferences();
        prefs.hotkey = customHotkey;
        saveUserPreferences(prefs);
      } else {
        console.log(`WARNING: Could not register hotkey ${customHotkey}`);
        mainWindow.webContents.send('hotkey-error', `Failed to register ${customHotkey}. Another app may be using it.`);
      }
    }
  });

  ipcMain.on('save-audio-chunk', (event, buffer) => {
    const timestamp = Date.now();
    audioBuffers.push({ data: Buffer.from(buffer), time: timestamp });
    console.log(`Audio chunk buffered: ${buffer.byteLength} bytes (${audioBuffers.length} chunks in memory)`);

    while (audioBuffers.length > 20) {
      audioBuffers.shift();
    }
  });

  ipcMain.on('get-monitors', (event) => {
    const screen = require('electron').screen;
    const displays = screen.getAllDisplays();
    const monitorList = displays.map((d, i) => ({
      index: i,
      width: d.bounds.width,
      height: d.bounds.height,
      x: d.bounds.x,
      y: d.bounds.y,
      primary: d.bounds.x === 0 && d.bounds.y === 0
    }));
    event.reply('monitors-list', monitorList);
  });

  ipcMain.handle('get-current-hotkey', () => {
    return customHotkey;
  });
}

app.whenReady().then(async () => {
  await syncClock();

  loadUserPreferences();
  ensureFolders();

  createWindow();

  const registered = globalShortcut.register(customHotkey, () => {
    console.log(`${customHotkey} pressed`);
    saveHighlight();
  });

  if (registered) {
    console.log(`${customHotkey} hotkey registered successfully`);
  } else {
    console.log(`WARNING: ${customHotkey} hotkey registration FAILED - another app may be using it`);
  }
});

app.on('window-all-closed', () => {
  if (ffmpegProcess) ffmpegProcess.kill();
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});