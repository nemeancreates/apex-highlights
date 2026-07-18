// ================================
// UPLOAD ROUTE — multer config, content verification, Spaces handoff.
// The single biggest route in the app; lives alone so it has room to grow
// (per-tier upload limits will land here).
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
const { sessions, saveSessionsToDisk } = require('../stores');
const { isSpacesEnabled, uploadToSpaces } = require('../spaces');
const { enqueueThumbnail } = require('../media');
const { requireAuth } = require('../auth');

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

    // 200 highlights per session = up to 200 clips per member.
    // Cap is per-uploader so one member's volume can't starve the squad,
    // with an absolute session backstop of 200 x current member count.
    const uploaderClipCount = session.uploads.filter(u => u.username === uploaderName).length;
    if (uploaderClipCount >= MAX_HIGHLIGHTS_PER_SESSION) {
      return safeError(res, 400, 'Highlight limit reached for this session (200 per member).');
    }
    const sessionUploadCap = MAX_HIGHLIGHTS_PER_SESSION * Math.max(session.members.length, 1);
    if (session.uploads.length >= sessionUploadCap) {
      return safeError(res, 400, 'Upload limit reached for this session.');
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

      if (req.files.metadata) {
        const metaFile = req.files.metadata[0];
        if (!verifyJSON(metaFile.path)) {
          fs.unlinkSync(videoFile.path);
          fs.unlinkSync(metaFile.path);
          log('warn', 'upload_rejected', { reason: 'invalid_metadata', session: code, username: uploaderName });
          return safeError(res, 400, 'Invalid metadata format.');
        }
      }

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
        fileSize: videoFile.size
      };

      session.uploads.push(uploadRecord);
      saveSessionsToDisk();

      log('info', 'upload_received', { session: code, username: uploaderName, sizeMB: (videoFile.size / 1024 / 1024).toFixed(1) });
      logUsage('upload', {
        session: code,
        username: uploaderName,
        uploadId: uploadRecord.id,
        sizeMB: parseFloat((videoFile.size / 1024 / 1024).toFixed(2)),
        memberCount: session.members.length,
        createdBy: session.createdBy
      });

      io.to(code).emit('upload-received', {
        username: uploaderName,
        uploadId: uploadRecord.id
      });

      res.status(201).json({
        message: 'Upload successful',
        uploadId: uploadRecord.id
      });
    });
  });
}

module.exports = { initUploadRoutes };
