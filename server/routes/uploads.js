// ================================
// UPLOAD ROUTE — multer config, content verification, Spaces handoff.
// The single biggest route in the app; lives alone so it has room to grow
// (per-tier upload limits live here — see session.maxClips).
// ================================
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { log, logUsage } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError, verifyMP4, verifyJSON } = require('../utils');
const {
  UPLOADS_DIR,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_HIGHLIGHTS_PER_SESSION,
  tiersWithCapability
} = require('../config');
const { sessions, saveSessionsToDisk, users, saveUsersToDisk, clipWeightForDuration } = require('../stores');
const { isSpacesEnabled, uploadToSpaces, deleteFromSpaces } = require('../spaces');
const { enqueueThumbnail } = require('../media');
const { requireAuth, requireTier } = require('../auth');
const { trackBandwidth } = require('../redemption');
const { createRateLimiter } = require('../ratelimit');
const { recordEvent } = require('../anomaly');
const { ANOMALY_UPLOAD_BURST_MAX, ANOMALY_UPLOAD_BURST_WINDOW } = require('../config');

const uploadLimiter = createRateLimiter({ windowMs: 60000, max: 10 });

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Paid tiers allowed to pull raw clip downloads / exports. Matches the
// "combined web+client login with paid subscription" access decision —
// same bracket as composite/AI Reel gating.
const DOWNLOAD_TIERS = tiersWithCapability('hasDownload');

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
  app.post('/sessions/:code/upload', requireAuth, uploadLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const uploaderName = sanitizeUsername(req.user.username);
    if (!uploaderName) {
      return safeError(res, 400, 'Invalid account username');
    }

    // ================================
    // UPLOAD AUTHORIZATION
    //
    // Order is deliberate. The ban check is FIRST and unconditional:
    // banned users were previously blocked only as a side effect of
    // removeMemberFromSession splicing them out of members[], and the
    // former-participant branch below would hand that access straight back.
    // It is load-bearing, not defensive extra.
    //
    // members[] is emptied when the host leaves (sockets/index.js), so once
    // a session closes only the host would otherwise pass. The
    // former-participant branch exists so Sync can recover clips that never
    // made it up. It is deliberately narrow: it requires proof of prior
    // participation, and on a CLOSED session it may only fill in moments the
    // session already knows about — enforced after the metadata parse below.
    // ================================
    if ((session.bannedUsernames || []).includes(uploaderName)) {
      log('warn', 'upload_rejected', { reason: 'banned', session: code, username: uploaderName });
      return safeError(res, 403, 'You have been banned from this session.');
    }

    const isHost = session.createdBy === uploaderName;
    const isActiveMember = session.members.some(m => m.username === uploaderName);
    const hasPriorUpload = session.uploads.some(u => u.username === uploaderName);

    if (!isHost && !isActiveMember && !hasPriorUpload) {
      return res.status(403).json({ error: 'You are not a member of this session' });
    }

    // Reconnecting participant — allowed, but gap-filling only once the
    // session has closed. Harmless while it is open and the host is present.
    const syncRestricted = !isHost && !isActiveMember;

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

      // Size floor — a real clip is never this small. An empty/near-empty MP4
      // (valid container header, no actual video frames) passes verifyMP4's
      // signature check but is unplayable — it uploads "successfully", then
      // shows as a black screen days later with no error trail. This catches
      // it at upload time and rejects it honestly. 100KB is well below any
      // real clip (smallest real clips are multiple MB) but above a
      // header-only stub.
      const MIN_VIDEO_BYTES = 100 * 1024; // 100KB
      if (videoFile.size < MIN_VIDEO_BYTES) {
        fs.unlinkSync(videoFile.path);
        log('warn', 'upload_rejected', {
          reason: 'video_too_small',
          session: code,
          username: uploaderName,
          sizeBytes: videoFile.size
        });
        return safeError(res, 400, 'Recording appears empty — no video was captured. This can happen if the capture source had no frames. Try recording again.');
      }

      let parsedDurationMs = null;
      let parsedCoordinatedTs = null;

      if (req.files.metadata) {
        const metaFile = req.files.metadata[0];
        if (!verifyJSON(metaFile.path)) {
          fs.unlinkSync(videoFile.path);
          fs.unlinkSync(metaFile.path);
          log('warn', 'upload_rejected', { reason: 'invalid_metadata', session: code, username: uploaderName });
          return safeError(res, 400, 'Invalid metadata format.');
        }
        try {
          const metaJson = JSON.parse(fs.readFileSync(metaFile.path, 'utf8'));
          const d = metaJson.durationMs;
          if (typeof d === 'number' && isFinite(d) && d > 0) parsedDurationMs = d;
          // Server-issued trigger time this clip belongs to. Stored so the
          // gap-filling gate below (and the player's moment-grouping later)
          // can tell which highlight a clip is a POV of.
          const ct = metaJson.coordinated_timestamp;
          if (typeof ct === 'number' && isFinite(ct) && ct > 0) parsedCoordinatedTs = ct;
        } catch (e) {
          log('warn', 'duration_parse_failed', { session: code, error: e.message });
        }
      }

      // Sync gap-filling gate. A participant no longer in the session may top
      // up a CLOSED one only with clips from a moment it already has — never
      // with new footage. Otherwise a former member could burn the host's
      // retention and inject content into a session the host is not present
      // to moderate. A null timestamp can't be verified, so it fails too.
      if (syncRestricted && session.closed) {
        const knownMoment = parsedCoordinatedTs !== null &&
          session.uploads.some(u => u.coordinatedTimestamp === parsedCoordinatedTs);
        if (!knownMoment) {
          try { fs.unlinkSync(videoFile.path); } catch (e) {}
          if (req.files.metadata) { try { fs.unlinkSync(req.files.metadata[0].path); } catch (e) {} }
          log('warn', 'upload_rejected', {
            reason: 'sync_new_moment_on_closed_session',
            session: code, username: uploaderName, coordinatedTimestamp: parsedCoordinatedTs
          });
          return safeError(res, 403, 'This session has closed. You can only upload clips from highlights the session already recorded.');
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
          // An upload can outlive the thing it belongs to. Two ways: the
          // hourly purge sweep (stores.js) evicts this session, or the host
          // deletes this clip inside the 4h window — both while these pushes
          // are still in flight. Either one leaves an object in R2 that
          // nothing references and no future sweep can ever find, because the
          // key was still null when the deletion ran. That is how the 202
          // orphaned records in the old sessions.json were produced, and it
          // is still reachable today. Re-check ownership after every push; if
          // the owner is gone, what we just created is an orphan by
          // definition, so delete it now instead of leaking it.
          const stillReferenced = () => sessions.has(code) && !!findRecord();
          const uploadedKeys = [];
          try {
            const videoUrl = await uploadToSpaces(videoFile.path, videoKey, 'video/mp4');
            uploadedKeys.push(videoKey);
            const rec = findRecord();
            if (rec) { rec.videoUrl = videoUrl; rec.videoKey = videoKey; }

            if (stillReferenced() && fs.existsSync(thumbPath)) {
              const thumbUrl = await uploadToSpaces(thumbPath, thumbKey, 'image/jpeg');
              uploadedKeys.push(thumbKey);
              const r2 = findRecord();
              if (r2) { r2.thumbnailUrl = thumbUrl; r2.thumbnailKey = thumbKey; }
            }

            if (stillReferenced() && metaFileObj && fs.existsSync(metaFileObj.path)) {
              const metaUrl = await uploadToSpaces(metaFileObj.path, metaKey, 'application/json');
              uploadedKeys.push(metaKey);
              const r3 = findRecord();
              if (r3) { r3.metadataUrl = metaUrl; r3.metadataKey = metaKey; }
            }

            if (!stillReferenced()) {
              const reason = sessions.has(code) ? 'clip_deleted' : 'session_purged';
              for (const key of uploadedKeys) await deleteFromSpaces(key);
              log('warn', 'spaces_upload_orphaned', { session: code, reason, keysDeleted: uploadedKeys.length });
              return;
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
        coordinatedTimestamp: parsedCoordinatedTs,
        clipWeight: clipWeight
      };

      session.uploads.push(uploadRecord);
      if (uploaderName === session.createdBy) {
        session.hostLastActivityAt = Date.now();
      }
      saveSessionsToDisk();

      trackBandwidth(uploaderName, videoFile.size, users, saveUsersToDisk);

      log('info', 'upload_received', {
        session: code, username: uploaderName,
        sizeMB: (videoFile.size / 1024 / 1024).toFixed(1),
        durationMs: parsedDurationMs, clipWeight
      });
      recordEvent(`upload:${uploaderName}`, {
        windowMs: ANOMALY_UPLOAD_BURST_WINDOW,
        threshold: ANOMALY_UPLOAD_BURST_MAX,
        event: 'upload_burst_detected',
        extra: { username: uploaderName, session: code }
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
  // DOWNLOAD — proxy endpoint gated behind login + paid tier (t2+). The
  // public web player can still STREAM any clip via the CDN videoUrl
  // embedded in session data — that's the "view/share" surface and stays
  // open. But the one-click Download affordance in the UI now routes
  // through here instead of fetching the CDN URL directly, so the actual
  // download action is behind auth+billing. Same middleware pattern as the
  // delete endpoint below (requireAuth), plus a tier check.
  //
  // Known limitation: since the CDN object itself is public-read (needed
  // for playback), a technically inclined viewer can still pull the raw
  // mp4 URL from the network tab. This route stops the casual/UI-driven
  // download path and gives us a real gate on the by-far heavier exports
  // (composite, AI reel) — it isn't DRM.
  // ================================
  app.get('/sessions/:code/uploads/:uploadId/download', requireAuth, requireTier(DOWNLOAD_TIERS), async (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');

    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    const rec = session.uploads.find(u => u.id === req.params.uploadId);
    if (!rec) return safeError(res, 404, 'Clip not found');

    const filename = `peak-abu-${rec.username}-${code}.mp4`;

    const localPath = path.join(UPLOADS_DIR, code, rec.videoFile);
    if (fs.existsSync(localPath)) {
      return res.download(localPath, filename);
    }

    if (!rec.videoUrl) return safeError(res, 404, 'Clip not available');

    https.get(rec.videoUrl, (upstream) => {
      if (upstream.statusCode !== 200) {
        upstream.resume();
        return safeError(res, 502, 'Failed to fetch clip');
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      upstream.pipe(res);
    }).on('error', (e) => {
      log('error', 'download_proxy_failed', { session: code, uploadId: rec.id, error: e.message });
      if (!res.headersSent) safeError(res, 502, 'Failed to fetch clip');
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