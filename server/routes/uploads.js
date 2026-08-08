// ================================
// UPLOAD ROUTE — multer config, content verification, Spaces handoff.
// The single biggest route in the app; lives alone so it has room to grow
// (per-tier upload limits live here — see session.maxClips).
// ================================
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { log, logUsage } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError, verifyMP4, verifyJSON } = require('../utils');
const {
  UPLOADS_DIR,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_HIGHLIGHTS_PER_SESSION
} = require('../config');
const { sessions, saveSessionsToDisk, users, saveUsersToDisk, clipWeightForDuration } = require('../stores');
const { isSpacesEnabled, uploadToSpaces, deleteFromSpaces } = require('../spaces');
const { enqueueThumbnail } = require('../media');
const { requireAuth } = require('../auth');
const { trackBandwidth } = require('../redemption');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Multer: disk storage with sanitized names, whitelist, size cap ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const code = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const sessionDir = path.join(UPLOADS_DIR, code);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const baseName = path.basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .substring(0, 100);
      const safeName = `${baseName}_${Date.now()}${ext}`;
      cb(null, safeName);
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Invalid file type. Only .mp4 and .json allowed.'));
    }
    cb(null, true);
  }
});

function initUploadRoutes(app, io) {
  app.post('/sessions/:code/upload', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const uploaderName = sanitizeUsername(req.user.username);
    if (!uploaderName) {
      return safeError(res, 400, 'Invalid account username');
    }

    const isMember = session.members.some(m => m.username === uploaderName) ||
                     session.createdBy === uploaderName;
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this session' });
    }

    // Tier-based cap: session.maxClips is set at creation from the host's
    // tier (see routes/sessions.js). Total across all uploaders — not
    // per-member — matching the "clips per session" tier limits. Sessions
    // created before tiers shipped won't have maxClips; fall back to the
    // old per-member formula so they don't suddenly break.
    //
    // WEIGHTED CAP: this pre-check runs before the file is even parsed, so
    // the real duration/weight of THIS upload isn't known yet — it assumes
    // weight 1 (the common case) as a soft gate. The authoritative weighted
    // total is written after the file lands (see below), where the actual
    // durationMs from the metadata sidecar is known. A single clip landing
    // right at the cap can therefore push the weighted total slightly over;
    // that's accepted rather than blocking uploads on a size we can't know
    // in advance without buffering the whole file first.
    const sessionClipCap = session.maxClips || (MAX_HIGHLIGHTS_PER_SESSION * Math.max(session.members.length, 1));
    const weightedSoFar = session.uploads.reduce((sum, u) => sum + (u.clipWeight || 1), 0);
    if (weightedSoFar >= sessionClipCap) {
      return safeError(res, 400, `Clip limit reached for this session (${sessionClipCap}). Host can start a new session to keep going.`);
    }

    upload.fields([
      { name: 'video', maxCount: 1 },
      { name: 'metadata', maxCount: 1 }
    ])(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return safeError(res, 413, 'File too large. Maximum 500MB.');
          }
          return safeError(res, 400, 'Upload failed. Check file type and size.');
        }
        return safeError(res, 400, 'Upload failed.');
      }

      const videoFile = req.files && req.files.video && req.files.video[0];
      if (!videoFile) {
        return safeError(res, 400, 'No video file provided.');
      }

      // Path traversal backstop: file must resolve inside uploads dir
      const resolvedPath = path.resolve(videoFile.path);
      if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
        fs.unlinkSync(resolvedPath);
        return safeError(res, 400, 'Invalid upload');
      }

      if (!verifyMP4(videoFile.path)) {
        fs.unlinkSync(videoFile.path);
        log('warn', 'upload_rejected', { reason: 'invalid_mp4_bytes', session: code, username: uploaderName });
        return safeError(res, 400, 'Invalid file content. File must be a valid MP4.');
      }

      let parsedDurationMs = null;

      if (req.files.metadata) {
        const metaFile = req.files.metadata[0];
        if (!verifyJSON(metaFile.path)) {
          fs.unlinkSync(videoFile.path);
          fs.unlinkSync(metaFile.path);
          log('warn', 'upload_rejected', { reason: 'invalid_metadata', session: code, username: uploaderName });
          return safeError(res, 400, 'Invalid metadata format.');
        }
        // Pull durationMs for weight calculation — best-effort. A metadata
        // read failure here just falls back to weight 1, it doesn't fail
        // the upload; the video itself already passed verification.
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaFile.path, 'utf8'));
          const d = metaJson.durationMs;
          if (typeof d === 'number' && isFinite(d) && d > 0) parsedDurationMs = d;
        } catch (e) {
          log('warn', 'duration_parse_failed', { session: code, error: e.message });
        }
      }

      const clipWeight = clipWeightForDuration(parsedDurationMs);

      const thumbName = `thumb_${path.basename(videoFile.filename, '.mp4')}.jpg`;
      const thumbPath = path.join(path.dirname(videoFile.path), thumbName);
      const metaFileObj = req.files.metadata ? req.files.metadata[0] : null;

      const videoKey = `${code}/${videoFile.filename}`;
      const thumbKey = `${code}/${thumbName}`;
      const metaKey = metaFileObj ? `${code}/${metaFileObj.filename}` : null;

      const findRecord = () => session.uploads.find(u => u.videoFile === videoFile.filename);

      if (isSpacesEnabled()) {
        enqueueThumbnail(videoFile.path, thumbPath, async () => {
          try {
            const videoUrl = await uploadToSpaces(videoFile.path, videoKey, 'video/mp4');
            const rec = findRecord();
            if (rec) { rec.videoUrl = videoUrl; rec.videoKey = videoKey; }

            if (fs.existsSync(thumbPath)) {
              const thumbUrl = await uploadToSpaces(thumbPath, thumbKey, 'image/jpeg');
              const r2 = findRecord();
              if (r2) { r2.thumbnailUrl = thumbUrl; r2.thumbnailKey = thumbKey; }
            }

            if (metaFileObj && fs.existsSync(metaFileObj.path)) {
              const metaUrl = await uploadToSpaces(metaFileObj.path, metaKey, 'application/json');
              const r3 = findRecord();
              if (r3) { r3.metadataUrl = metaUrl; r3.metadataKey = metaKey; }
            }

            saveSessionsToDisk();
            log('info', 'spaces_upload_complete', { session: code, key: videoKey });
          } catch (e) {
            log('error', 'spaces_upload_failed', { session: code, error: e.message });
          }
        });
      } else {
        enqueueThumbnail(videoFile.path, thumbPath, () => {
          const rec = findRecord();
          if (rec) rec.thumbnailFile = thumbName;
        });
      }

      const uploadRecord = {
        id: uuidv4(),
        username: uploaderName,
        videoFile: videoFile.filename,
        metadataFile: req.files.metadata ? req.files.metadata[0].filename : null,
        thumbnailFile: null,
        videoUrl: null,
        thumbnailUrl: null,
        metadataUrl: null,
        videoKey: null,
        thumbnailKey: null,
        metadataKey: null,
        uploadedAt: new Date().toISOString(),
        fileSize: videoFile.size,
        durationMs: parsedDurationMs,
        clipWeight: clipWeight
      };

      session.uploads.push(uploadRecord);
      saveSessionsToDisk();

      // Bandwidth safeguard — see config.js note on why this tracks upload
      // bytes rather than true CDN egress.
      trackBandwidth(uploaderName, videoFile.size, users, saveUsersToDisk);

      log('info', 'upload_received', {
        session: code, username: uploaderName,
        sizeMB: (videoFile.size / 1024 / 1024).toFixed(1),
        durationMs: parsedDurationMs, clipWeight
      });
      logUsage('upload', {
        session: code,
        username: uploaderName,
        uploadId: uploadRecord.id,
        sizeMB: parseFloat((videoFile.size / 1024 / 1024).toFixed(2)),
        memberCount: session.members.length,
        createdBy: session.createdBy,
        clipWeight
      });

      io.to(code).emit('upload-received', {
        username: uploaderName,
        uploadId: uploadRecord.id
      });

      // Authoritative clip counter: WEIGHTED total, not a flat per-upload
      // count. A 4-6 minute clip costs 2 against the cap instead of 1 —
      // this is what actually reflects storage/bandwidth cost now that
      // clip length varies (batch 3's auto-capture can save up to 6min).
      const weightedUsed = session.uploads.reduce((sum, u) => sum + (u.clipWeight || 1), 0);
      io.to(code).emit('clip-count-update', {
        used: weightedUsed,
        max: session.maxClips || MAX_HIGHLIGHTS_PER_SESSION
      });

      res.status(201).json({
        message: 'Upload successful',
        uploadId: uploadRecord.id
      });
    });
  });

  // ================================
  // DELETE — host-only, and only within a 4-hour window of upload. This is
  // deliberately NOT tied to tier retention (1-14 days) — it's a short
  // false-positive cleanup window, not a way to endlessly reuse one session.
  // Server-enforced: the client can hide the button after 4h, but the real
  // gate is here. Refund is automatic — clip weight is derived by summing
  // session.uploads on every read, so removing the record IS the refund.
  // ================================
  const DELETE_WINDOW_MS = 4 * 60 * 60 * 1000;

  app.delete('/sessions/:code/uploads/:uploadId', requireAuth, async (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');

    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    const requesterName = sanitizeUsername(req.user.username);
    if (session.createdBy !== requesterName) {
      return safeError(res, 403, 'Only the session host can delete clips');
    }

    const idx = session.uploads.findIndex(u => u.id === req.params.uploadId);
    if (idx === -1) return safeError(res, 404, 'Clip not found');

    const rec = session.uploads[idx];
    const ageMs = Date.now() - new Date(rec.uploadedAt).getTime();
    if (ageMs > DELETE_WINDOW_MS) {
      return safeError(res, 403, 'This clip is past the 4-hour delete window and can no longer be removed.');
    }

    // Remove from Spaces if it made it there; local temp files are already
    // gone by this point in the normal flow (uploadToSpaces deletes on
    // success), but clean up defensively in case Spaces upload never landed.
    if (rec.videoKey) await deleteFromSpaces(rec.videoKey);
    if (rec.thumbnailKey) await deleteFromSpaces(rec.thumbnailKey);
    if (rec.metadataKey) await deleteFromSpaces(rec.metadataKey);

    const sessionDir = path.join(UPLOADS_DIR, code);
    [rec.videoFile, rec.metadataFile, rec.thumbnailFile].forEach(f => {
      if (!f) return;
      const p = path.join(sessionDir, f);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    });

    session.uploads.splice(idx, 1);
    saveSessionsToDisk();

    const weightedUsed = session.uploads.reduce((sum, u) => sum + (u.clipWeight || 1), 0);

    log('info', 'upload_deleted', { session: code, uploadId: rec.id, deletedBy: requesterName, refundedWeight: rec.clipWeight || 1 });

    io.to(code).emit('highlight-deleted', { uploadId: rec.id });
    io.to(code).emit('clip-count-update', {
      used: weightedUsed,
      max: session.maxClips || MAX_HIGHLIGHTS_PER_SESSION
    });

    res.json({ message: 'Clip deleted', refundedWeight: rec.clipWeight || 1 });
  });
}

module.exports = { initUploadRoutes };