// ================================
// COMPOSITE — server-side multi-POV grid rendering (FFmpeg xstack)
// plus the three HTTP endpoints that drive it.
// ================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { log } = require('./logger');
const { sanitizeCode, downloadToFile } = require('./utils');
const { UPLOADS_DIR } = require('./config');
const { sessions } = require('./stores');

const compositeJobs = new Map();
const COMPOSITE_DIR = path.join(os.tmpdir(), 'peak-abu-composites');
if (!fs.existsSync(COMPOSITE_DIR)) fs.mkdirSync(COMPOSITE_DIR, { recursive: true });

// Sweep abandoned jobs hourly
function startCompositeCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of compositeJobs) {
      if (now - job.createdAt > 3600000) {
        if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
        compositeJobs.delete(jobId);
      }
    }
  }, 3600000);
}

function getGridDimensions(count) {
  if (count === 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

async function runComposite(session, code, outputPath, jobId) {
  const uploads = session.uploads;
  const sessionDir = path.join(UPLOADS_DIR, code);

  const clipData = [];
  const tempDownloads = []; // track for cleanup
  let earliestStart = Infinity;

  for (const upload of uploads) {
    let videoPath = path.join(sessionDir, upload.videoFile);

    if (!fs.existsSync(videoPath)) {
      if (!upload.videoUrl) continue; // truly gone, nothing to composite
      const tempPath = path.join(COMPOSITE_DIR, `src_${jobId}_${upload.videoFile}`);
      try {
        await downloadToFile(upload.videoUrl, tempPath);
        videoPath = tempPath;
        tempDownloads.push(tempPath);
      } catch (e) {
        log('warn', 'composite_download_failed', { jobId, file: upload.videoFile, error: e.message });
        continue;
      }
    }

    let startTimeUTC = null;
    if (upload.metadataFile) {
      try {
        const metaPath = path.join(sessionDir, upload.metadataFile);
        const metaRaw = fs.existsSync(metaPath)
          ? fs.readFileSync(metaPath, 'utf8')
          : null;
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          startTimeUTC = meta.startTimeUTC || null;
          if (startTimeUTC) earliestStart = Math.min(earliestStart, startTimeUTC);
        }
      } catch (e) {}
    }

    clipData.push({ videoPath, startTimeUTC, username: upload.username });
  }

  if (clipData.length === 0) {
    compositeJobs.get(jobId).status = 'failed';
    tempDownloads.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
    return;
  }

  clipData.forEach(c => {
    c.offsetSec = (earliestStart !== Infinity && c.startTimeUTC)
      ? (c.startTimeUTC - earliestStart) / 1000
      : 0;
  });

  const count = clipData.length;
  const { cols, rows } = getGridDimensions(count);
  const cellW = 640;
  const cellH = 360;

  const ffmpegArgs = [];

  clipData.forEach(c => {
    if (c.offsetSec > 0) ffmpegArgs.push('-itsoffset', String(c.offsetSec.toFixed(3)));
    ffmpegArgs.push('-i', c.videoPath);
  });

  let filterComplex = '';

  clipData.forEach((_, i) => {
    filterComplex += `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[v${i}];`;
  });

  if (count === 1) {
    filterComplex += `[v0]copy[out]`;
  } else {
    const layoutPositions = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r * cols + c >= count) break;
        layoutPositions.push(`${c * cellW}_${r * cellH}`);
      }
    }
    const scaledRefs = clipData.map((_, i) => `[v${i}]`).join('');
    filterComplex += `${scaledRefs}xstack=inputs=${count}:layout=${layoutPositions.join('|')}[out]`;
  }

  const audioRefs = clipData.map((_, i) => `[${i}:a]`).join('');
  filterComplex += `;${audioRefs}amix=inputs=${count}:duration=longest:normalize=0[aout]`;

  ffmpegArgs.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '[aout]',
    // x264 veryfast: 10-30x faster than SVT-AV1 preset 6 on a 1-vCPU droplet,
    // universally playable MP4 (AV1+Opus-in-MP4 support is spotty on mobile).
    // Revisit AV1 for bandwidth savings once encoding moves to a worker queue.
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-y',
    outputPath
  );

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line.includes('frame=') || line.includes('error')) console.log('Composite:', line);
    });

    ffmpeg.on('close', (exitCode) => {
      tempDownloads.forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
      const job = compositeJobs.get(jobId);
      if (!job) return resolve();
      if (exitCode === 0 && fs.existsSync(outputPath)) {
        job.status = 'done';
        job.fileSize = fs.statSync(outputPath).size;
        log('info', 'composite_done', { jobId, sizeMB: (job.fileSize / 1024 / 1024).toFixed(1) });
      } else {
        job.status = 'failed';
        log('warn', 'composite_failed', { jobId });
      }
      resolve();
    });

    ffmpeg.on('error', () => {
      const job = compositeJobs.get(jobId);
      if (job) job.status = 'failed';
      resolve();
    });
  });
}

// --- Routes ---
function initCompositeRoutes(app) {
  app.post('/sessions/:code/composite', (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.uploads.length === 0) return res.status(400).json({ error: 'No uploads yet' });

    const jobId = uuidv4();
    const outputPath = path.join(COMPOSITE_DIR, `composite_${jobId}.mp4`);

    compositeJobs.set(jobId, {
      status: 'processing',
      outputPath,
      createdAt: Date.now()
    });

    res.status(202).json({ jobId });

    runComposite(session, code, outputPath, jobId);
  });

  app.get('/sessions/:code/composite/:jobId', (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json({
      status: job.status,
      downloadUrl: job.status === 'done' ? `/composite/${req.params.jobId}/download` : null,
      fileSize: job.fileSize || null
    });
  });

  app.get('/composite/:jobId/download', (req, res) => {
    const job = compositeJobs.get(req.params.jobId);
    if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });

    res.download(job.outputPath, 'peak-abu-composite.mp4', (err) => {
      if (!err) {
        setTimeout(() => {
          if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
          compositeJobs.delete(req.params.jobId);
        }, 60000);
      }
    });
  });
}

module.exports = { initCompositeRoutes, startCompositeCleanup };
