// ================================
// HIDDEN HIGHLIGHTS (v1.0.0) — the host hides a highlight moment from
// everyone else: squad members, public viewers, /browse and Peak Roulette.
//
// Like a star, a hide belongs to a MOMENT (the coordinated timestamp every
// POV of a highlight shares), so hiding it hides every POV. Only the host
// can hide or unhide, and only the host sees hidden moments in the player.
//
// One exception keeps uploads working: a member still gets their OWN clips
// of a hidden moment back from GET /sessions/:code/uploads, flagged
// hiddenMoment — the desktop app's Sync and retry sweep match local clips
// against those records, and without them would re-upload the clip as
// "missing". The web player drops flagged clips for non-hosts.
//
// Media files stay where they are (a direct file URL still plays); this
// controls what Peakabu lists, not storage.
// ================================
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError } = require('../utils');
const { createRateLimiter } = require('../ratelimit');
const { sessions } = require('../stores');
const { requireAuth } = require('../auth');
const db = require('../db');
const access = require('../session-access');
const { parseMomentTs } = require('./stars');

const HIDDEN_MAX_PER_SESSION = 2000;
const hideWriteLimiter = createRateLimiter({ windowMs: 60000, max: 60 });

const stmt = {
  listForSession: db.prepare(`SELECT momentTs FROM hidden_moments WHERE sessionCode = ?`),
  countForSession: db.prepare(`SELECT COUNT(*) AS n FROM hidden_moments WHERE sessionCode = ?`),
  insert: db.prepare(`
    INSERT OR IGNORE INTO hidden_moments (sessionCode, momentTs, hiddenBy, createdAt)
    VALUES (@sessionCode, @momentTs, @hiddenBy, @createdAt)
  `),
  remove: db.prepare(`DELETE FROM hidden_moments WHERE sessionCode = ? AND momentTs = ?`),
  sessionCodes: db.prepare(`SELECT DISTINCT sessionCode FROM hidden_moments`),
  deleteForSession: db.prepare(`DELETE FROM hidden_moments WHERE sessionCode = ?`)
};

function hiddenMomentSet(code) {
  try { return new Set(stmt.listForSession.all(code).map(r => r.momentTs)); }
  catch (err) { log('warn', 'hidden_list_failed', { code, error: err.message }); return new Set(); }
}

function isHiddenUpload(hidden, u) {
  return hidden.size > 0 && typeof u.coordinatedTimestamp === 'number' && hidden.has(u.coordinatedTimestamp);
}

// What this request may see of `uploads`. The host gets everything.
// Everyone else loses hidden moments, except their own clips, which come
// back flagged (see the header).
function uploadsForViewer(req, session, uploads) {
  const hidden = hiddenMomentSet(session.code);
  if (!hidden.size || access.isHostReq(req, session)) return uploads;
  const viewer = access.viewerOf(req);
  const me = viewer && viewer.username ? String(viewer.username).toLowerCase() : null;
  const out = [];
  for (const u of uploads || []) {
    if (!isHiddenUpload(hidden, u)) { out.push(u); continue; }
    if (me && String(u.username || '').toLowerCase() === me) out.push(Object.assign({}, u, { hiddenMoment: true }));
  }
  return out;
}

// Hourly: drop rows whose session is gone (same rule as stars).
function startHiddenCleanup() {
  setInterval(() => {
    try {
      let purged = 0;
      for (const { sessionCode } of stmt.sessionCodes.all()) {
        if (sessions.has(sessionCode)) continue;
        purged += stmt.deleteForSession.run(sessionCode).changes;
      }
      if (purged > 0) log('info', 'hidden_moments_purged', { rows: purged });
    } catch (err) {
      log('warn', 'hidden_moments_purge_failed', { error: err.message });
    }
  }, 60 * 60 * 1000);
}

function initHiddenRoutes(app, io) {
  function hideRoute(hide) {
    return (req, res) => {
      const code = sanitizeCode(req.params.code);
      if (!code) return safeError(res, 400, 'Invalid session code');
      const session = sessions.get(code);
      if (!session) return safeError(res, 404, 'Session not found');
      const username = sanitizeUsername(req.user.username);
      if (!username || session.createdBy !== username) {
        return safeError(res, 403, 'Only the session host can hide highlights.');
      }
      const ts = parseMomentTs(req.params.momentTs, session);
      if (ts === null) return safeError(res, 400, 'Invalid highlight');

      try {
        if (hide) {
          if (stmt.countForSession.get(code).n >= HIDDEN_MAX_PER_SESSION) {
            return safeError(res, 409, 'This session has too many hidden highlights.');
          }
          stmt.insert.run({ sessionCode: code, momentTs: ts, hiddenBy: username, createdAt: Date.now() });
        } else {
          stmt.remove.run(code, ts);
        }
      } catch (err) {
        log('error', 'hidden_moment_failed', { code, error: err.message });
        return safeError(res, 500, 'Could not save that. Try again.');
      }
      log('info', hide ? 'highlight_hidden' : 'highlight_unhidden', { session: code, momentTs: ts, by: username });
      if (io) io.to(code).emit('hidden-changed', { momentTs: ts, hidden: hide });
      res.json({ momentTs: ts, hidden: hide });
    };
  }

  app.put('/sessions/:code/hidden/:momentTs', requireAuth, hideWriteLimiter, hideRoute(true));
  app.delete('/sessions/:code/hidden/:momentTs', requireAuth, hideWriteLimiter, hideRoute(false));
}

module.exports = { initHiddenRoutes, startHiddenCleanup, hiddenMomentSet, isHiddenUpload, uploadsForViewer };
