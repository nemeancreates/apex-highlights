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
//
// This is the first unauthenticated-readable / authenticated-writable text
// surface in Peak-Abu, so every field is validated server-side even when
// the client already constrains it.
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
    INSERT INTO comments (id, sessionCode, uploadId, username, timestampMs, text, createdAt)
    VALUES (@id, @sessionCode, @uploadId, @username, @timestampMs, @text, @createdAt)
  `),
  listForSession: db.prepare(`
    SELECT id, uploadId, username, timestampMs, text, createdAt
    FROM comments WHERE sessionCode = ?
    ORDER BY timestampMs ASC, createdAt ASC
  `),
  countForUpload: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE uploadId = ?`),
  getById: db.prepare(`SELECT * FROM comments WHERE id = ?`),
  deleteById: db.prepare(`DELETE FROM comments WHERE id = ?`),
  deleteForUpload: db.prepare(`DELETE FROM comments WHERE uploadId = ?`),
  deleteForSession: db.prepare(`DELETE FROM comments WHERE sessionCode = ?`),

  // Orphan sweep — a session row is gone (purged past its retention window),
  // so its comments have nothing left to attach to.
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

// ================================
// HOST TOGGLE — comments default to ON. Absence of a row means "never
// touched", which is the same as enabled; only an explicit host switch-off
// writes a 0.
// ================================
function getCommentsEnabled(code) {
  const row = stmt.getSettings.get(code);
  return row ? !!row.enabled : true;
}

function setCommentsEnabled(code, enabled) {
  stmt.setSettings.run({ sessionCode: code, enabled: enabled ? 1 : 0 });
}

// ================================
// TEXT NORMALIZATION
// A comment is ONE short line. Newlines, tabs, and other control characters
// become spaces; zero-width and bidirectional-override characters (the
// classic trick for disguising text) are dropped outright; runs of
// whitespace collapse. Length is measured AFTER normalization so padding
// can't be used to smuggle a longer payload past the check.
//
// .length counts UTF-16 code units, which is exactly what the browser's
// maxlength attribute counts — so client and server agree, and an emoji
// costs 2 in both places.
// ================================
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

// ================================
// RATE LIMIT — per ACCOUNT, not per IP.
// Every write here is authenticated, so the account is the real identity;
// an IP limit would punish a whole household sharing a connection while
// doing nothing to stop one account posting from several IPs.
// ================================
const commentRate = new Map(); // usernameLower -> { count, resetTime }

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

// ================================
// CLEANUP — hourly. Drops comments whose session no longer exists, and
// prunes the in-memory rate-limit map so it can't grow unbounded.
// Mirrors startCompositeCleanup()'s shape in composite.js.
// ================================
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

// Call this from the host clip-delete route so a deleted highlight takes its
// comments with it instead of waiting for the hourly sweep.
function deleteCommentsForUpload(uploadId) {
  try {
    return stmt.deleteForUpload.run(uploadId).changes;
  } catch (err) {
    log('warn', 'comments_delete_upload_failed', { uploadId, error: err.message });
    return 0;
  }
}

function deleteCommentsForSession(code) {
  try {
    return stmt.deleteForSession.run(code).changes;
  } catch (err) {
    log('warn', 'comments_delete_session_failed', { code, error: err.message });
    return 0;
  }
}

// ================================
// ROUTES
// ================================
function initCommentRoutes(app, io) {
  // --- READ: public. Anyone with the share link can see comments, same as
  // they can watch the clips. Returns the whole session in one call — text
  // is tiny (100 chars max) so a per-clip endpoint would cost more in round
  // trips than it saves in payload.
  app.get('/sessions/:code/comments', (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');

    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    let comments = [];
    try {
      comments = stmt.listForSession.all(code);
    } catch (err) {
      log('warn', 'comments_list_failed', { code, error: err.message });
    }

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

    // The clip must exist in THIS session. Without this an id from any other
    // session (or a made-up one) could be used to park text in the table.
    if (typeof uploadId !== 'string' || !uploadId) {
      return safeError(res, 400, 'Clip id required');
    }
    const upload = (session.uploads || []).find(u => u.id === uploadId);
    if (!upload) return safeError(res, 404, 'Clip not found in this session');

    const ts = Number(timestampMs);
    if (!Number.isFinite(ts) || ts < 0 || ts > COMMENT_MAX_TIMESTAMP_MS) {
      return safeError(res, 400, 'Invalid timestamp');
    }

    const clean = normalizeText(text);
    if (!clean) {
      return safeError(res, 400, `Comment must be 1-${COMMENT_MAX_LENGTH} characters of plain text.`);
    }

    let existing = 0;
    try {
      existing = stmt.countForUpload.get(uploadId).n;
    } catch (err) {
      log('warn', 'comments_count_failed', { uploadId, error: err.message });
    }
    if (existing >= COMMENT_MAX_PER_CLIP) {
      return safeError(res, 409, `This clip already has the maximum of ${COMMENT_MAX_PER_CLIP} comments.`);
    }

    // Rate check sits AFTER validation on purpose: a typo or an over-length
    // draft shouldn't burn a slot in the user's minute, but a valid post
    // must, and the check still runs before anything is written.
    const usernameLower = (req.user.username || '').toLowerCase();
    if (!checkCommentRate(usernameLower)) {
      return safeError(res, 429, `Slow down — ${COMMENT_RATE_MAX} comments per minute.`);
    }

    const comment = {
      id: uuidv4(),
      sessionCode: code,
      uploadId,
      username: req.user.username,
      timestampMs: Math.round(ts),
      text: clean,
      createdAt: Date.now()
    };

    try {
      stmt.insert.run(comment);
    } catch (err) {
      log('error', 'comment_insert_failed', { code, uploadId, error: err.message });
      return safeError(res, 500, 'Could not save that comment. Try again.');
    }

    log('info', 'comment_added', {
      session: code, uploadId, username: comment.username, at: comment.timestampMs
    });

    // Live push for anyone sitting in the session room. The web player is a
    // plain page with no socket connection today, so nothing consumes this
    // yet — it's here so the desktop client can surface "someone commented
    // on your clip" without a second pass through this file.
    if (io) {
      io.to(code).emit('comment-added', {
        id: comment.id,
        uploadId: comment.uploadId,
        username: comment.username,
        timestampMs: comment.timestampMs,
        text: comment.text,
        createdAt: comment.createdAt
      });
    }

    res.status(201).json({ comment });
  });

  // --- DELETE: the comment's author, or the session host.
  // No 4-hour window here, unlike clip deletion. Different risk profile: a
  // clip delete destroys everyone's footage for a moment and is irreversible,
  // so it's time-boxed. A comment is 100 characters and the host needs a
  // takedown lever for the full life of a publicly-shared session.
  app.delete('/sessions/:code/comments/:id', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');

    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    const row = stmt.getById.get(req.params.id);
    if (!row || row.sessionCode !== code) return safeError(res, 404, 'Comment not found');

    const me = (req.user.username || '').toLowerCase();
    const isAuthor = (row.username || '').toLowerCase() === me;
    const isHost = (session.createdBy || '').toLowerCase() === me;
    if (!isAuthor && !isHost) {
      return safeError(res, 403, 'Only the comment author or the session host can remove this.');
    }

    stmt.deleteById.run(row.id);
    log('info', 'comment_deleted', {
      session: code, commentId: row.id, by: req.user.username, asHost: !isAuthor
    });

    if (io) io.to(code).emit('comment-deleted', { id: row.id, uploadId: row.uploadId });

    res.json({ deleted: true, id: row.id });
  });

  // --- HOST TOGGLE: turn comments on/off for the whole session.
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

module.exports = {
  initCommentRoutes,
  startCommentCleanup,
  deleteCommentsForUpload,
  deleteCommentsForSession,
  getCommentsEnabled
};