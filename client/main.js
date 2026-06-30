const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Where we store the rolling buffer chunks
const BUFFER_DIR = path.join(os.tmpdir(), 'apex-highlights-buffer');
const CLIPS_DIR = path.join(app.getPath('videos'), 'ApexHighlights');
const CHUNK_SECONDS = 10;
const MAX_CHUNKS = 18; // 3 minutes worth

let ffmpegProcess = null;
let mainWindow = null;

// Make sure our folders exist
function ensureFolders() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// Delete old chunks beyond our 3 minute limit
function pruneOldChunks() {
  const files = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      name: f,
      time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs
    }))
    .sort((a, b) => a.time - b.time);

  while (files.length > MAX_CHUNKS) {
    const oldest = files.shift();
    fs.unlinkSync(path.join(BUFFER_DIR, oldest.name));
  }
}

// Start the rolling buffer capture
function startRecording(monitor) {
  ensureFolders();

  // Default to primary monitor if none specified
  const screen = require('electron').screen;
  const displays = screen.getAllDisplays();
  const target = monitor !== undefined ? displays[monitor] : displays[0];
  
  const { x, y, width, height } = target.bounds;

  console.log(`Recording monitor ${monitor}: ${width}x${height} at (${x},${y})`);

  const chunkPattern = path.join(BUFFER_DIR, 'chunk_%03d.mp4');

  ffmpegProcess = spawn('ffmpeg', [
    '-f', 'gdigrab',
    '-framerate', '60',
    '-offset_x', String(x),
    '-offset_y', String(y),
    '-video_size', `${width}x${height}`,
    '-i', 'desktop',
    '-c:v', 'h264_nvenc',
    '-preset', 'p4',
    '-tune', 'hq',
    '-b:v', '8M',
    '-g', '60',
    '-keyint_min', '60',
    '-force_key_frames', 'expr:gte(t,n_forced*10)',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    '-y',
    chunkPattern
  ]);

  ffmpegProcess.stderr.on('data', (data) => {
    console.log('FFmpeg:', data.toString());
    pruneOldChunks();
  });

  ffmpegProcess.on('close', (code) => {
    console.log('FFmpeg stopped with code', code);
  });
}

// Save the current buffer as a highlight clip
function saveHighlight() {
  const allFiles = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({
      name: f,
      path: path.join(BUFFER_DIR, f),
      time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs,
      size: fs.statSync(path.join(BUFFER_DIR, f)).size
    }))
    .filter(f => f.size > 100000)
    .sort((a, b) => a.time - b.time);

  // Always skip the newest chunk - FFmpeg is still writing to it
  const files = allFiles.slice(0, -1);

  if (files.length === 0) {
    console.log('No completed chunks yet - wait a few more seconds');
    mainWindow.webContents.send('highlight-error', 'Buffer not ready yet, wait a few more seconds');
    return;
  }

  console.log(`Saving highlight from ${files.length} chunks...`);

  // Create file list for FFmpeg concat
  const listPath = path.join(BUFFER_DIR, 'filelist.txt');
  const fileContent = files
    .map(f => `file '${f.path.replace(/\\/g, '/')}'`)
    .join('\n');
  fs.writeFileSync(listPath, fileContent);

  // Output filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);

  console.log('File list:', fileContent);
  console.log('Output path:', outputPath);

  const concat = spawn('ffmpeg', [
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    '-y',
    outputPath
  ]);

  concat.stderr.on('data', (data) => {
    console.log('Concat FFmpeg:', data.toString());
  });

  concat.on('close', (code) => {
    if (code === 0) {
      console.log('Highlight saved to', outputPath);
      mainWindow.webContents.send('highlight-saved', outputPath);
    } else {
      console.log('Concat failed with code', code);
      mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  ipcMain.on('save-highlight', () => {
    saveHighlight();
  });

  ipcMain.on('start-recording', (event, monitorIndex) => {
    if (ffmpegProcess) {
      ffmpegProcess.kill();
      ffmpegProcess = null;
    }
    startRecording(monitorIndex);
    mainWindow.webContents.send('recording-started', monitorIndex);
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

app.whenReady().then(() => {
  createWindow();
  // Wait for monitor selection from UI before starting

  // F9 hotkey to save highlight
  globalShortcut.register('F9', () => {
    console.log('F9 pressed - saving highlight');
    saveHighlight();
  });
});

app.on('window-all-closed', () => {
  // Stop FFmpeg when app closes
  if (ffmpegProcess) ffmpegProcess.kill();
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});