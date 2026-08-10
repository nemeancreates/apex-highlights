// ================================
// COMMENTS — "quick comments": short, timestamped plain-text notes left on
// ONE POV clip, which surface as an on-screen overlay at that moment during
// playback in the web player.
//
// Deliberately narrow by design:
//   - text only, hard length cap, no links, no markup (client renders with
//     textContent, server strips control characters)
//   - logged-in Peak-Abu accounts only, any tier including Free
//   - anchored to a single uploadId, so a note on Cabbam's POV never shows
//     over moonfrog's
//   - per-user rate limit + per-clip ceiling, both enforced HERE, not in
//     the UI ("security by UI" is not security)
//   - host can switch comments off for a whole session
//   - host can drag comments to custom positions (positionX/positionY as
//     percentages, null = auto-zone placement)
//
// ARCHITECTURE NOTE: db.js still owns the schema (see the `comments` and
// `comment_settings` tables there). The prepared statements live in this
// file rather than stores.js — a deliberate exception, since comments carry
// no live socket state and nothing outside this module reads them, so a
// stores.js layer would have exactly one caller. Easy to relocate later.
// ================================
const { v4: uuidv4 } = require('uuid');
const { log } = require('../logger');
const { sanitizeCode, safeError } = require('../utils');
const {
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_PER_CLIP,
  COMMENT_RATE_MAX,
  COMMENT_RATE_WINDOW,
  COMMENT_MAX_TIMESTAMP_MS
} = require('../config');
const { sessions } = require('../stores');
const { requireAuth } = require('../auth');
const db = require('../db');

// --- Prepared statements (compiled once, reused) ---
const stmt = {
  insert: db.prepare(`
    INSERT INTO comments (id, sessionCode, uploadId, username, timestampMs, text, createdAt, positionX, positionY)
    VALUES (@id, @sessionCode, @uploadId, @username, @timestampMs, @text, @createdAt, @positionX, @positionY)
  `),
  listForSession: db.prepare(`
    SELECT id, uploadId, username, timestampMs, text, createdAt, positionX, positionY
    FROM comments WHERE sessionCode = ?
    ORDER BY timestampMs ASC, createdAt ASC
  `),
  countForUpload: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE uploadId = ?`),
  getById: db.prepare(`SELECT * FROM comments WHERE id = ?`),
  deleteById: db.prepare(`DELETE FROM comments WHERE id = ?`),
  deleteForUpload: db.prepare(`DELETE FROM comments WHERE uploadId = ?`),
  deleteForSession: db.prepare(`DELETE FROM comments WHERE sessionCode = ?`),

  updatePosition: db.prepare(`
    UPDATE comments SET positionX = @positionX, positionY = @positionY WHERE id = @id
  `),

  deleteOrphans: db.prepare(`
    DELETE FROM comments
    WHERE sessionCode NOT IN (SELECT code FROM sessions)
  `),
  deleteOrphanSettings: db.prepare(`
    DELETE FROM comment_settings
    WHERE sessionCode NOT IN (SELECT code FROM sessions)
  `),

  getSettings: db.prepare(`SELECT enabled FROM comment_settings WHERE sessionCode = ?`),
  setSettings: db.prepare(`
    INSERT INTO comment_settings (sessionCode, enabled) VALUES (@sessionCode, @enabled)
    ON CONFLICT(sessionCode) DO UPDATE SET enabled = excluded.enabled
  `)
};

function getCommentsEnabled(code) {
  const row = stmt.getSettings.get(code);
  return row ? !!row.enabled : true;
}

function setCommentsEnabled(code, enabled) {
  stmt.setSettings.run({ sessionCode: code, enabled: enabled ? 1 : 0 });
}

function normalizeText(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > COMMENT_MAX_LENGTH) return null;
  return cleaned;
}

const commentRate = new Map();

function checkCommentRate(usernameLower) {
  const now = Date.now();
  let entry = commentRate.get(usernameLower);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + COMMENT_RATE_WINDOW };
    commentRate.set(usernameLower, entry);
  }
  entry.count++;
  return entry.count <= COMMENT_RATE_MAX;
}

function startCommentCleanup() {
  setInterval(() => {
    try {
      const c = stmt.deleteOrphans.run().changes;
      const s = stmt.deleteOrphanSettings.run().changes;
      if (c > 0 || s > 0) log('info', 'comments_purged', { comments: c, settings: s });
    } catch (err) {
      log('warn', 'comments_purge_failed', { error: err.message });
    }
    const now = Date.now();
    for (const [key, entry] of commentRate) {
      if (now > entry.resetTime) commentRate.delete(key);
    }
  }, 60 * 60 * 1000);
}

function deleteCommentsForUpload(uploadId) {
  try { return stmt.deleteForUpload.run(uploadId).changes; }
  catch (err) { log('warn', 'comments_delete_upload_failed', { uploadId, error: err.message }); return 0; }
}

function deleteCommentsForSession(code) {
  try { return stmt.deleteForSession.run(code).changes; }
  catch (err) { log('warn', 'comments_delete_session_failed', { code, error: err.message }); return 0; }
}

// ================================
// ROUTES
// ================================
function initCommentRoutes(app, io) {

  // --- READ: public.
  app.get('/sessions/:code/comments', (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    let comments = [];
    try { comments = stmt.listForSession.all(code); }
    catch (err) { log('warn', 'comments_list_failed', { code, error: err.message }); }

    res.json({
      enabled: getCommentsEnabled(code),
      maxLength: COMMENT_MAX_LENGTH,
      maxPerClip: COMMENT_MAX_PER_CLIP,
      comments
    });
  });

  // --- WRITE: any logged-in account, including Free tier.
  app.post('/sessions/:code/comments', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    if (!getCommentsEnabled(code)) {
      return safeError(res, 403, 'The host has turned comments off for this session.');
    }

    const { uploadId, timestampMs, text } = req.body || {};
    if (typeof uploadId !== 'string' || !uploadId) return safeError(res, 400, 'Clip id required');
    const upload = (session.uploads || []).find(u => u.id === uploadId);
    if (!upload) return safeError(res, 404, 'Clip not found in this session');

    const ts = Number(timestampMs);
    if (!Number.isFinite(ts) || ts < 0 || ts > COMMENT_MAX_TIMESTAMP_MS) return safeError(res, 400, 'Invalid timestamp');

    const clean = normalizeText(text);
    if (!clean) return safeError(res, 400, `Comment must be 1-${COMMENT_MAX_LENGTH} characters of plain text.`);

    let existing = 0;
    try { existing = stmt.countForUpload.get(uploadId).n; }
    catch (err) { log('warn', 'comments_count_failed', { uploadId, error: err.message }); }
    if (existing >= COMMENT_MAX_PER_CLIP) {
      return safeError(res, 409, `This clip already has the maximum of ${COMMENT_MAX_PER_CLIP} comments.`);
    }

    const usernameLower = (req.user.username || '').toLowerCase();
    if (!checkCommentRate(usernameLower)) {
      return safeError(res, 429, `Slow down — ${COMMENT_RATE_MAX} comments per minute.`);
    }

    const comment = {
      id: uuidv4(), sessionCode: code, uploadId,
      username: req.user.username, timestampMs: Math.round(ts),
      text: clean, createdAt: Date.now(),
      positionX: null, positionY: null
    };

    try { stmt.insert.run(comment); }
    catch (err) {
      log('error', 'comment_insert_failed', { code, uploadId, error: err.message });
      return safeError(res, 500, 'Could not save that comment. Try again.');
    }

    log('info', 'comment_added', { session: code, uploadId, username: comment.username, at: comment.timestampMs });

    if (io) {
      io.to(code).emit('comment-added', {
        id: comment.id, uploadId: comment.uploadId,
        username: comment.username, timestampMs: comment.timestampMs,
        text: comment.text, createdAt: comment.createdAt,
        positionX: null, positionY: null
      });
    }

    res.status(201).json({ comment });
  });

  // --- DELETE: author or host.
  app.delete('/sessions/:code/comments/:id', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    const row = stmt.getById.get(req.params.id);
    if (!row || row.sessionCode !== code) return safeError(res, 404, 'Comment not found');

    const me = (req.user.username || '').toLowerCase();
    const isAuthor = (row.username || '').toLowerCase() === me;
    const isHostUser = (session.createdBy || '').toLowerCase() === me;
    if (!isAuthor && !isHostUser) return safeError(res, 403, 'Only the comment author or the session host can remove this.');

    stmt.deleteById.run(row.id);
    log('info', 'comment_deleted', { session: code, commentId: row.id, by: req.user.username, asHost: !isAuthor });
    if (io) io.to(code).emit('comment-deleted', { id: row.id, uploadId: row.uploadId });
    res.json({ deleted: true, id: row.id });
  });

  // --- HOST POSITION: drag a comment to a custom on-screen spot.
  // Coordinates are percentages (0–100) of the video container, consistent
  // across screen sizes. null = reset to automatic zone placement.
  app.patch('/sessions/:code/comments/:id/position', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    if ((session.createdBy || '').toLowerCase() !== (req.user.username || '').toLowerCase()) {
      return safeError(res, 403, 'Only the session host can move comments.');
    }

    const row = stmt.getById.get(req.params.id);
    if (!row || row.sessionCode !== code) return safeError(res, 404, 'Comment not found');

    const { positionX, positionY } = req.body || {};
    const px = positionX === null ? null : Number(positionX);
    const py = positionY === null ? null : Number(positionY);

    if (px !== null && (!Number.isFinite(px) || px < 0 || px > 100)) return safeError(res, 400, 'positionX must be 0-100 or null');
    if (py !== null && (!Number.isFinite(py) || py < 0 || py > 100)) return safeError(res, 400, 'positionY must be 0-100 or null');

    try { stmt.updatePosition.run({ id: row.id, positionX: px, positionY: py }); }
    catch (err) {
      log('error', 'comment_position_failed', { code, id: row.id, error: err.message });
      return safeError(res, 500, 'Could not save position.');
    }

    log('info', 'comment_positioned', { session: code, commentId: row.id, positionX: px, positionY: py });
    if (io) io.to(code).emit('comment-moved', { id: row.id, positionX: px, positionY: py });
    res.json({ id: row.id, positionX: px, positionY: py });
  });

  // --- HOST TOGGLE: comments on/off.
  app.patch('/sessions/:code/comments-enabled', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    if ((session.createdBy || '').toLowerCase() !== (req.user.username || '').toLowerCase()) {
      return safeError(res, 403, 'Only the session host can change this.');
    }

    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return safeError(res, 400, 'enabled must be true or false');

    setCommentsEnabled(code, enabled);
    log('info', 'comments_toggled', { session: code, enabled, by: req.user.username });
    if (io) io.to(code).emit('session-comments-toggled', { enabled });
    res.json({ enabled });
  });
}

// Used by composite.js and aireel.js to fetch comments for export overlay.
function getCommentsForSession(code) {
  try { return stmt.listForSession.all(code); }
  catch (err) { return []; }
}

module.exports = {
  initCommentRoutes,
  startCommentCleanup,
  deleteCommentsForUpload,
  deleteCommentsForSession,
  getCommentsEnabled,
  getCommentsForSession
};