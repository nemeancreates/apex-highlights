// ================================
// STARS — favorited highlight moments (v0.1.87).
//
// A star belongs to a MOMENT — the server-issued coordinated timestamp that
// every POV of a highlight shares — not to one clip, so starring it stars
// every POV. Stars come from two places:
//   - the web player's ★ on a highlight pill (the HTTP routes below)
//   - the star hotkey, arbitrated in sockets/stars.js
// Both go through canStar() and addStars()/removeStar() here, and every
// change is broadcast as 'stars-changed' so squadmates' desktop apps can
// write the flag into their local clip sidecars.
//
// The host's "Squad can star" switch (on by default) is enforced HERE, not
// just hidden in the UI. Switching it off keeps the stars already made.
//
// Reads ride on GET /sessions/:code/uploads (routes/sessions.js): the web
// player already polls it, and so do the desktop app's Sync and retry sweep.
//
// Same architecture note as routes/comments.js: db.js owns the schema, the
// prepared statements live here.
// ================================
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError } = require('../utils');
const { createRateLimiter } = require('../ratelimit');
const { STAR_MAX_PER_SESSION } = require('../config');
const { sessions } = require('../stores');
const { requireAuth } = require('../auth');
const db = require('../db');

// Clicking through a long session's pills is legitimately bursty.
const starWriteLimiter = createRateLimiter({ windowMs: 60000, max: 60 });

// --- Prepared statements (compiled once, reused) ---
const stmt = {
  listForSession: db.prepare(`
    SELECT momentTs, starredBy FROM stars WHERE sessionCode = ? ORDER BY momentTs ASC
  `),
  countForSession: db.prepare(`SELECT COUNT(*) AS n FROM stars WHERE sessionCode = ?`),
  has: db.prepare(`SELECT 1 FROM stars WHERE sessionCode = ? AND momentTs = ?`),
  insert: db.prepare(`
    INSERT OR IGNORE INTO stars (sessionCode, momentTs, starredBy, createdAt)
    VALUES (@sessionCode, @momentTs, @starredBy, @createdAt)
  `),
  remove: db.prepare(`DELETE FROM stars WHERE sessionCode = ? AND momentTs = ?`),

  sessionCodes: db.prepare(`SELECT sessionCode FROM stars UNION SELECT sessionCode FROM star_settings`),
  deleteForSession: db.prepare(`DELETE FROM stars WHERE sessionCode = ?`),
  deleteSettingsForSession: db.prepare(`DELETE FROM star_settings WHERE sessionCode = ?`),

  getSettings: db.prepare(`SELECT squadCanStar FROM star_settings WHERE sessionCode = ?`),
  setSettings: db.prepare(`
    INSERT INTO star_settings (sessionCode, squadCanStar) VALUES (@sessionCode, @squadCanStar)
    ON CONFLICT(sessionCode) DO UPDATE SET squadCanStar = excluded.squadCanStar
  `)
};

function listStars(code) {
  try { return stmt.listForSession.all(code); }
  catch (err) { log('warn', 'stars_list_failed', { code, error: err.message }); return []; }
}

function getSquadCanStar(code) {
  try {
    const row = stmt.getSettings.get(code);
    return row ? !!row.squadCanStar : true;
  } catch (err) { return true; }
}

function isStarred(code, momentTs) {
  try { return !!stmt.has.get(code, momentTs); } catch (err) { return false; }
}

// Who may star (or unstar) in this session. Same order as the upload route:
// the ban check first and unconditional, then membership. "Member" includes
// anyone who uploaded to the session — members[] empties when the session
// closes, and most starring happens after that, in the web player.
function canStar(session, rawUsername) {
  const username = sanitizeUsername(rawUsername);
  if (!session || !username) return { ok: false, status: 403, error: 'Log in to star highlights.' };
  if ((session.bannedUsernames || []).includes(username)) {
    return { ok: false, status: 403, error: 'You have been banned from this session.' };
  }
  if (session.createdBy === username) return { ok: true, username, isHost: true };
  const isMember = session.members.some(m => m.username === username) ||
    session.uploads.some(u => u.username === username);
  if (!isMember) return { ok: false, status: 403, error: 'Only members of this session can star highlights.' };
  if (!getSquadCanStar(session.code)) {
    return { ok: false, status: 403, error: 'Starring is host-only in this session.' };
  }
  return { ok: true, username, isHost: false };
}

// Stars the given moments. Returns the ones that weren't starred already.
// source ('key' | 'player') rides on the broadcast so the desktop app only
// announces star-key stars; a web player starring run stays quiet.
function addStars(io, code, momentTsList, username, source) {
  const added = [];
  const now = Date.now();
  try {
    db.transaction(() => {
      let count = stmt.countForSession.get(code).n;
      for (const ts of momentTsList) {
        if (count >= STAR_MAX_PER_SESSION) break;
        if (stmt.insert.run({ sessionCode: code, momentTs: ts, starredBy: username, createdAt: now }).changes) {
          added.push(ts);
          count++;
        }
      }
    })();
  } catch (err) {
    log('warn', 'stars_add_failed', { code, error: err.message });
    return [];
  }
  if (added.length) {
    log('info', 'stars_added', { session: code, momentTs: added, by: username });
    if (io) io.to(code).emit('stars-changed', { momentTs: added, starred: true, by: username, source: source || 'player' });
  }
  return added;
}

function removeStar(io, code, momentTs, username) {
  let removed = 0;
  try { removed = stmt.remove.run(code, momentTs).changes; }
  catch (err) { log('warn', 'stars_remove_failed', { code, error: err.message }); return false; }
  if (removed) {
    log('info', 'star_removed', { session: code, momentTs, by: username });
    if (io) io.to(code).emit('stars-changed', { momentTs: [momentTs], starred: false, by: username, source: 'player' });
  }
  return removed > 0;
}

// A moment timestamp is epoch ms, bounded to the session's lifetime (a day
// of slack before creation for clock skew) so the table can't be filled
// with arbitrary numbers.
function parseMomentTs(raw, session) {
  const ts = Number(raw);
  if (!Number.isInteger(ts) || ts <= 0) return null;
  const created = Date.parse(session.createdAt);
  if (Number.isFinite(created) && ts < created - 24 * 60 * 60 * 1000) return null;
  if (ts > Date.now() + 60 * 1000) return null;
  return ts;
}

// Hourly: drop star rows whose session is gone. Checked against the
// in-memory session Map, not the sessions TABLE — a brand-new session's row
// isn't written until its first save, and the star key can star a moment
// before that happens.
function startStarCleanup() {
  setInterval(() => {
    try {
      let purged = 0;
      for (const { sessionCode } of stmt.sessionCodes.all()) {
        if (sessions.has(sessionCode)) continue;
        purged += stmt.deleteForSession.run(sessionCode).changes;
        stmt.deleteSettingsForSession.run(sessionCode);
      }
      if (purged > 0) log('info', 'stars_purged', { stars: purged });
    } catch (err) {
      log('warn', 'stars_purge_failed', { error: err.message });
    }
  }, 60 * 60 * 1000);
}

// ================================
// ROUTES
// ================================
function initStarRoutes(app, io) {

  // --- STAR / UNSTAR a moment (the web player's ★ on a pill).
  function starRoute(starred) {
    return (req, res) => {
      const code = sanitizeCode(req.params.code);
      if (!code) return safeError(res, 400, 'Invalid session code');
      const session = sessions.get(code);
      if (!session) return safeError(res, 404, 'Session not found');

      const perm = canStar(session, req.user.username);
      if (!perm.ok) return safeError(res, perm.status, perm.error);

      const ts = parseMomentTs(req.params.momentTs, session);
      if (ts === null) return safeError(res, 400, 'Invalid highlight');

      if (starred) {
        const added = addStars(io, code, [ts], perm.username, 'player');
        if (!added.length && !isStarred(code, ts)) {
          return safeError(res, 409, `This session already has the maximum of ${STAR_MAX_PER_SESSION} stars.`);
        }
      } else {
        removeStar(io, code, ts, perm.username);
      }
      res.json({ momentTs: ts, starred });
    };
  }

  app.put('/sessions/:code/stars/:momentTs', requireAuth, starWriteLimiter, starRoute(true));
  app.delete('/sessions/:code/stars/:momentTs', requireAuth, starWriteLimiter, starRoute(false));

  // --- HOST TOGGLE: "Squad can star" (default on). Off = host only.
  app.patch('/sessions/:code/star-settings', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');

    if (session.createdBy !== sanitizeUsername(req.user.username)) {
      return safeError(res, 403, 'Only the session host can change this.');
    }

    const { squadCanStar } = req.body || {};
    if (typeof squadCanStar !== 'boolean') return safeError(res, 400, 'squadCanStar must be true or false');

    try { stmt.setSettings.run({ sessionCode: code, squadCanStar: squadCanStar ? 1 : 0 }); }
    catch (err) {
      log('error', 'star_settings_failed', { code, error: err.message });
      return safeError(res, 500, 'Could not save that. Try again.');
    }

    log('info', 'star_settings_changed', { session: code, squadCanStar, by: req.user.username });
    if (io) io.to(code).emit('star-settings-changed', { squadCanStar });
    res.json({ squadCanStar });
  });
}

module.exports = {
  initStarRoutes,
  startStarCleanup,
  listStars,
  getSquadCanStar,
  canStar,
  addStars,
  removeStar
};
