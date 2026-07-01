const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sntp = require('sntp');
const FormData = require('form-data');
const http = require('http');

const BUFFER_DIR = path.join(os.tmpdir(), 'apex-highlights-buffer');
const CLIPS_DIR = path.join(app.getPath('videos'), 'PeakAbu');
const CHUNK_SECONDS = 10;

// Settings (adjustable from UI)
let maxChunks = 18;          // default 3 minutes (18 × 10sec)
let recordFps = 30;          // default 30fps
let recordResolution = null; // null = native, or { width, height }

let clockOffset = 0;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let audioBuffers = []; // in-memory rolling buffer of audio chunks

function ensureFolders() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

async function syncClock() {
  try {
    const time = await sntp.time({ host: 'pool.ntp.org', timeout: 5000 });
    clockOffset = time.t;
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
    fs.unlinkSync(path.join(BUFFER_DIR, oldest.name));
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

  ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
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

function saveHighlight() {
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

  const saveTimeUTC = getPreciseUTC();
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
    sessionId: currentSession ? currentSession.code : null
  };

  const videoListPath = path.join(BUFFER_DIR, 'filelist.txt');
  const videoContent = videoFiles
    .map(f => `file '${f.path.replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(videoListPath, videoContent);

  if (hasAudio) {
    // Combine all in-memory audio chunks into one valid WebM file
    const combinedAudio = Buffer.concat(audioBuffers.map(c => c.data));
    const tempAudioPath = path.join(BUFFER_DIR, 'temp_audio.webm');
    fs.writeFileSync(tempAudioPath, combinedAudio);
    console.log(`Combined audio: ${audioBuffers.length} chunks -> ${(combinedAudio.length / 1024).toFixed(0)}KB`);

    // Concat video chunks first
    const tempVideoPath = path.join(BUFFER_DIR, 'temp_video.mp4');
    const concatVideo = spawn('ffmpeg', [
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

      // Merge video + audio into final file
      const merge = spawn('ffmpeg', [
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
          // Audio merge failed, save video only
          console.log('Audio merge failed, saving video only');
          const concatOnly = spawn('ffmpeg', [
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
    // No audio - just concat video
    const concat = spawn('ffmpeg', [
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

function uploadHighlight(videoPath, metadataPath) {
  if (!currentSession) {
    console.log('No active session, skipping upload');
    return;
  }

  console.log(`Uploading highlight to session ${currentSession.code}...`);

  const form = new FormData();
  form.append('video', fs.createReadStream(videoPath));

  if (metadataPath && fs.existsSync(metadataPath)) {
    form.append('metadata', fs.createReadStream(metadataPath));
  }

  const options = {
    hostname: 'localhost',
    port: 3000,
    path: `/sessions/${currentSession.code}/upload`,
    method: 'POST',
    headers: {
      ...form.getHeaders(),
      'x-username': currentSession.username
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        if (res.statusCode === 201) {
          console.log('Upload successful:', result.uploadId);
          mainWindow.webContents.send('upload-complete', result.uploadId);
        } else {
          console.log('Upload failed:', result.error);
          mainWindow.webContents.send('upload-error', result.error);
        }
      } catch (err) {
        console.log('Upload response parse error:', err.message);
      }
    });
  });

  req.on('error', (err) => {
    console.log('Upload connection error:', err.message);
    mainWindow.webContents.send('upload-error', 'Could not reach server');
  });

  form.pipe(req);
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
  mainWindow.webContents.openDevTools();

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.handle('get-desktop-sources', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  ipcMain.on('save-highlight', () => saveHighlight());

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
    // Clear audio buffers on new recording
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
  });

  ipcMain.on('save-audio-chunk', (event, buffer) => {
    const timestamp = Date.now();
    audioBuffers.push({ data: Buffer.from(buffer), time: timestamp });
    console.log(`Audio chunk buffered: ${buffer.byteLength} bytes (${audioBuffers.length} chunks in memory)`);

    // Keep only the last 20 chunks in memory
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
}

app.whenReady().then(async () => {
  await syncClock();
  createWindow();

  const registered = globalShortcut.register('F9', () => {
    console.log('F9 pressed');
    saveHighlight();
  });

  if (registered) {
    console.log('F9 hotkey registered successfully');
  } else {
    console.log('WARNING: F9 hotkey registration FAILED - another app may be using it');
  }
});

app.on('window-all-closed', () => {
  if (ffmpegProcess) ffmpegProcess.kill();
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});