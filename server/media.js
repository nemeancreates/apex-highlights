// ================================
// MEDIA — FFmpeg work: thumbnail queue + generation, AV1 re-encode.
// Queue exists because the droplet is memory-constrained: one ffmpeg
// process at a time, ever.
// ================================
const { spawn } = require('child_process');
const path = require('path');
const { log } = require('./logger');

// --- Thumbnail queue (one ffmpeg at a time) ---
const thumbnailQueue = [];
let thumbnailRunning = false;

function enqueueThumbnail(videoPath, thumbnailPath, onDone) {
  thumbnailQueue.push({ videoPath, thumbnailPath, onDone });
  processThumbnailQueue();
}

async function processThumbnailQueue() {
  if (thumbnailRunning || thumbnailQueue.length === 0) return;
  thumbnailRunning = true;
  const job = thumbnailQueue.shift();
  try {
    await generateThumbnail(job.videoPath, job.thumbnailPath);
    // ALWAYS run onDone — the video upload must not depend on thumbnail success
    if (typeof job.onDone === 'function') job.onDone();
  } catch (e) {
    log('warn', 'thumbnail_queue_error', { error: e.message });
  } finally {
    thumbnailRunning = false;
    processThumbnailQueue();
  }
}

function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      '-vf', 'scale=480:-1',
      '-q:v', '3',
      '-y',
      thumbnailPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        log('info', 'thumbnail_generated', { file: path.basename(thumbnailPath) });
        resolve(true);
      } else {
        log('warn', 'thumbnail_failed', { file: path.basename(videoPath) });
        resolve(false);
      }
    });

    ffmpeg.on('error', () => {
      log('warn', 'ffmpeg_unavailable', { context: 'thumbnail' });
      resolve(false);
    });
  });
}

// --- AV1 re-encode (currently unused; kept for when encoding moves to a
// worker queue — see bandwidth notes) ---
function reencodeVideo(inputPath, outputPath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'libsvtav1',
      '-preset', '6',
      '-crf', '35',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-y',
      outputPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        log('info', 'reencode_complete', { file: path.basename(outputPath) });
        resolve(true);
      } else {
        log('warn', 'reencode_failed', { file: path.basename(inputPath) });
        resolve(false);
      }
    });

    ffmpeg.on('error', () => {
      log('error', 'ffmpeg_error', { context: 'reencode' });
      resolve(false);
    });
  });
}

module.exports = { enqueueThumbnail, generateThumbnail, reencodeVideo };
