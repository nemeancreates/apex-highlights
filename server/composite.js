// ================================
// COMPOSITE — server-side multi-POV grid rendering (FFmpeg xstack)
// plus the three HTTP endpoints that drive it.
//
// v2: optional comment overlay via ASS subtitles when includeComments
// is true (the default). Requires libass in FFmpeg.
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
const { requireAuth, requireAuthAny, requireTier } = require('./auth');
const { getCommentsForSession } = require('./routes/comments');
const { generateASS, checkAssFilter, escapeFilterPath } = require('./comment-overlay');

// Paid tiers allowed to generate/download combined-view exports.
const EXPORT_TIERS = ['t2', 't3', 't4', 't5'];

const compositeJobs = new Map();
const COMPOSITE_DIR = path.join(os.tmpdir(), 'peak-abu-composites');
if (!fs.existsSync(COMPOSITE_DIR)) fs.mkdirSync(COMPOSITE_DIR, { recursive: true });

function startCompositeCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of compositeJobs) {
      if (now - job.createdAt > 3600000) {
        if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
        if (job.assPath && fs.existsSync(job.assPath)) try { fs.unlinkSync(job.assPath); } catch (e) {}
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

async function runComposite(session, code, outputPath, jobId, includeComments) {
  const uploads = session.uploads;
  const sessionDir = path.join(UPLOADS_DIR, code);

  const clipData = [];
  const tempDownloads = [];
  let earliestStart = Infinity;

  for (const upload of uploads) {
    let videoPath = path.join(sessionDir, upload.videoFile);

    if (!fs.existsSync(videoPath)) {
      if (!upload.videoUrl) continue;
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

    clipData.push({ videoPath, startTimeUTC, username: upload.username, uploadId: upload.id });
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
  const canvasW = cols * cellW;
  const canvasH = rows * cellH;

  // --- Comment overlay (ASS subtitle file) ---
  let assPath = null;
  if (includeComments) {
    const canAss = await checkAssFilter();
    if (canAss) {
      const comments = getCommentsForSession(code);
      if (comments.length > 0) {
        // Build tile map: where each clip sits in the grid
        const tileMap = {};
        clipData.forEach((c, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          tileMap[c.uploadId] = {
            x: col * cellW, y: row * cellH,
            w: cellW, h: cellH,
            offsetSec: c.offsetSec
          };
        });
        const result = generateASS(comments, tileMap, canvasW, canvasH);
        if (result.count > 0) {
          assPath = path.join(COMPOSITE_DIR, `comments_${jobId}.ass`);
          fs.writeFileSync(assPath, result.ass, 'utf8');
          log('info', 'composite_comments_overlay', { jobId, comments: result.count });
        }
      }
    } else {
      log('warn', 'composite_no_libass', { jobId });
    }
  }

  const job = compositeJobs.get(jobId);
  if (job) job.assPath = assPath;

  const ffmpegArgs = [];

  clipData.forEach(c => {
    if (c.offsetSec > 0) ffmpegArgs.push('-itsoffset', String(c.offsetSec.toFixed(3)));
    ffmpegArgs.push('-i', c.videoPath);
  });

  let filterComplex = '';

  clipData.forEach((_, i) => {
    filterComplex += `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[v${i}];`;
  });

  // Video label before optional ASS pass
  const preLabel = assPath ? '[xraw]' : '[out]';

  if (count === 1) {
    // 'null' instead of 'copy' so ASS can chain onto it (copy is bitstream, not filterable)
    filterComplex += `[v0]null${preLabel}`;
  } else {
    const layoutPositions = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r * cols + c >= count) break;
        layoutPositions.push(`${c * cellW}_${r * cellH}`);
      }
    }
    const scaledRefs = clipData.map((_, i) => `[v${i}]`).join('');
    filterComplex += `${scaledRefs}xstack=inputs=${count}:layout=${layoutPositions.join('|')}${preLabel}`;
  }

  if (assPath) {
    filterComplex += `;[xraw]ass=${escapeFilterPath(assPath)}[out]`;
  }

  const audioRefs = clipData.map((_, i) => `[${i}:a]`).join('');
  filterComplex += `;${audioRefs}amix=inputs=${count}:duration=longest:normalize=0[aout]`;

  ffmpegArgs.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '[aout]',
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
      if (assPath) try { fs.unlinkSync(assPath); } catch (e) {}
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
      if (assPath) try { fs.unlinkSync(assPath); } catch (e) {}
      const job = compositeJobs.get(jobId);
      if (job) job.status = 'failed';
      resolve();
    });
  });
}

// --- Routes ---
function initCompositeRoutes(app) {
  app.post('/sessions/:code/composite', requireAuth, requireTier(EXPORT_TIERS), (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.uploads.length === 0) return res.status(400).json({ error: 'No uploads yet' });

    // Default: include comments. Only false when client explicitly opts out.
    const includeComments = !(req.body && req.body.includeComments === false);

    const jobId = uuidv4();
    const outputPath = path.join(COMPOSITE_DIR, `composite_${jobId}.mp4`);

    compositeJobs.set(jobId, {
      status: 'processing',
      outputPath,
      assPath: null,
      createdAt: Date.now()
    });

    res.status(202).json({ jobId });

    runComposite(session, code, outputPath, jobId, includeComments);
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

  app.get('/composite/:jobId/download', requireAuthAny, requireTier(EXPORT_TIERS), (req, res) => {
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