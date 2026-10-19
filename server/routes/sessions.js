// ================================
// SESSION ROUTES — create a session, read session state, list uploads.
// createSessionForUser() is shared with the migrate-session socket
// handler in sockets/index.js so "start a new session" behaves identically
// whether it comes from the button or the API.
// ================================
const { v4: uuidv4 } = require('uuid');
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError, generateCode } = require('../utils');
const { MAX_SESSIONS, MAX_MEMBERS_PER_SESSION, TIERS,
        ANOMALY_SESSION_BURST_MAX, ANOMALY_SESSION_BURST_WINDOW } = require('../config');
const { createRateLimiter } = require('../ratelimit');
const { recordEvent } = require('../anomaly');

const sessionLookupLimiter = createRateLimiter({ windowMs: 60000, max: 20 });
const { sessions, users, saveUsersToDisk, getSessionsByUser } = require('../stores');
const { requireAuth, getEffectiveTier, getMonthKey } = require('../auth');
const { listStars, getSquadCanStar } = require('./stars');
// A session on legal hold reads as "not found" to everyone.
const { isOnHold } = require('../moderation/legal-hold');
const access = require('../session-access');

// Shared by POST /sessions and the migrate-session socket handler.
// Returns { session } on success or { error, status } on failure.
const { getFlags } = require('../killswitch');

function createSessionForUser(rawUsername, opts) {
  if (getFlags().sessionsPaused) {
    return { error: 'New sessions are temporarily paused. Existing sessions are unaffected — check back shortly.', status: 503 };
  }

  const username = sanitizeUsername(rawUsername);
  if (!username) return { error: 'Invalid account username', status: 400 };

  const user = users.get(rawUsername.toLowerCase());
  const tier = getEffectiveTier(user);
  const tierConfig = TIERS[tier];

  if (!tierConfig.canHost) {
    return { error: `${tierConfig.label} can't host sessions — upgrade to Creator, Squad, or Pro.`, status: 403 };
  }

  const monthKey = getMonthKey();
  if (user.sessionsMonthKey !== monthKey) {
    user.sessionsMonthKey = monthKey;
    user.sessionsThisMonth = 0;
  }
  if (user.sessionsThisMonth >= tierConfig.sessionsPerMonth) {
    return { error: `Monthly session limit reached for ${tierConfig.label} (${tierConfig.sessionsPerMonth}/mo). Resets next month.`, status: 403 };
  }

  let liveSessions = 0;
  for (const s of sessions.values()) {
    if (!s.closed && s.members.length > 0) liveSessions++;
  }
  if (liveSessions >= MAX_SESSIONS) {
    return { error: 'Server is at capacity. Try again later.', status: 503 };
  }

  let code = generateCode();
  while (sessions.has(code)) code = generateCode();

  const now = Date.now();
  const session = {
    id: uuidv4(),
    code,
    createdBy: username,
    hostTier: tier,
    createdAt: new Date().toISOString(),
    expiresAt: now + tierConfig.retentionDays * 24 * 60 * 60 * 1000,
    maxMembers: tierConfig.memberCap,
    maxClips: tierConfig.clipCap,
    clipDuration: 30000,
    commentSettings: JSON.stringify({ filterMode: 'all', topN: 0 }),
    highlightLockedUntil: 0,
    highlightCount: 0,
    pendingHighlights: [],
    members: [],
    uploads: [],
    bannedUsernames: [],
    // Set by the caller: 'members' for sessions from client 0.1.97 on.
    visibility: (opts && opts.visibility === 'members') ? 'members' : null,
    watchKey: null,
    participants: [username]
  };

  sessions.set(code, session);
  user.sessionsThisMonth++;
  saveUsersToDisk();
  log('info', 'session_created', { code, createdBy: username, hostTier: tier, sessionsThisMonth: user.sessionsThisMonth });
  recordEvent(`session:${username}`, {
    windowMs: ANOMALY_SESSION_BURST_WINDOW,
    threshold: ANOMALY_SESSION_BURST_MAX,
    event: 'session_burst_detected',
    extra: { username, hostTier: tier }
  });

  return { session };
}

function initSessionRoutes(app) {
  app.post('/sessions', requireAuth, (req, res) => {
    // Client 0.1.97+ asks for a members-only session; older clients send
    // nothing and keep the old open-with-the-code behaviour.
    const visibility = req.body && req.body.visibility === 'members' ? 'members' : null;
    const result = createSessionForUser(req.user.username, { visibility });
    if (result.error) return safeError(res, result.status, result.error);
    const s = result.session;
    res.status(201).json({
      sessionCode: s.code,
      sessionId: s.id,
      maxMembers: s.maxMembers,
      maxClips: s.maxClips,
      expiresAt: s.expiresAt
    });
  });

  // Durable per-account session history. The client's localStorage list is
  // machine-local and lost on reinstall; this is the server-side truth so a
  // fresh install (or a second PC) logging into the same account gets its
  // hosted sessions back. Hosted only — see getSessionsByUser.
  // MUST be registered before '/sessions/:code' or Express matches "mine"
  // as a :code param and this route never fires.
  app.get('/sessions/mine', requireAuth, (req, res) => {
    try {
      const list = getSessionsByUser(req.user.username, 50);
      res.json({ sessions: list });
    } catch (err) {
      res.status(500).json({ error: 'Could not load session history' });
    }
  });

  app.get('/sessions/:code', sessionLookupLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session || isOnHold(code)) return res.status(404).json({ error: 'Session not found' });

    // Members-only and not one of them: enough to say it exists and who
    // hosts it (the app's join flow needs that), but no clips.
    if (!access.canView(req, session)) {
      return res.json({
        code: session.code,
        createdBy: session.createdBy,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt || null,
        maxMembers: session.maxMembers || MAX_MEMBERS_PER_SESSION,
        members: session.members.map(m => ({ username: m.username, isRecording: m.isRecording, joinedAt: m.joinedAt })),
        visibility: 'members',
        restricted: true,
        message: access.MEMBERS_ONLY_MSG
      });
    }
    const host = access.isHostReq(req, session);

    res.json({
      code: session.code,
      visibility: access.isMembersOnly(session) ? 'members' : 'everyone',
      ...(host ? { watchUrl: access.watchUrlFor(session) } : {}),
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt || null,
      clipDuration: session.clipDuration,
      maxMembers: session.maxMembers || MAX_MEMBERS_PER_SESSION,
      maxClips: session.maxClips || null,
      clipsUsed: (session.uploads || []).reduce((sum, u) => sum + (u.clipWeight || 1), 0),
      members: session.members.map(m => ({
        username: m.username,
        isRecording: m.isRecording,
        joinedAt: m.joinedAt
      })),
      uploads: session.uploads
    });
  });

  app.get('/sessions/:code/uploads', sessionLookupLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session || isOnHold(code)) return res.status(404).json({ error: 'Session not found' });
    if (!access.canView(req, session)) return res.status(403).json({ error: access.MEMBERS_ONLY_MSG, restricted: true });

    // closed/expiresAt ride along so the client can tell the three cases
    // apart without guessing: 404 = purged past retention (nothing to sync
    // to, ever), closed = host gone but the session still exists (sync is
    // allowed, under the restricted rules in routes/uploads.js), and open =
    // normal operation. Without these, a client can only infer from the
    // status code and would show "expired" for a merely-closed session.
    // createdBy lets the client apply that closed-session rule itself (the
    // host is exempt) instead of uploading a whole clip just to be refused.
    // Already public via GET /sessions/:code.
    // stars/squadCanStar (v0.1.87): the web player shows them, and the
    // desktop app's Sync writes the star flag into local clip sidecars.
    // ?around=<ms>: just the one peak (the clips saved together at that
    // moment). Peak Roulette uses this so it doesn't pull a whole session's
    // clip list, and every clip's metadata, to play a single moment.
    let uploads = session.uploads;
    const around = Number(req.query.around);
    if (req.query.around !== undefined && Number.isFinite(around) && around > 0) {
      uploads = uploadsAroundMoment(session.uploads || [], around);
    }
    res.json({
      uploads,
      partial: uploads !== session.uploads,
      closed: !!session.closed,
      createdBy: session.createdBy,
      expiresAt: session.expiresAt || null,
      stars: listStars(code),
      squadCanStar: getSquadCanStar(code)
    });
  });
}

// Same clustering rule as the web player and /browse: clips saved within 5s
// of each other are one peak. Returns the peak nearest the given moment.
const PEAK_GAP_MS = 5000;
function uploadTs(u) {
  if (typeof u.coordinatedTimestamp === 'number' && u.coordinatedTimestamp > 0) return u.coordinatedTimestamp;
  const t = Date.parse(u.uploadedAt);
  return Number.isFinite(t) ? t : 0;
}
function uploadsAroundMoment(all, moment) {
  const sorted = all.slice().sort((a, b) => uploadTs(a) - uploadTs(b));
  let best = null, bestDiff = Infinity, cur = null, prev = 0;
  for (const u of sorted) {
    const ts = uploadTs(u);
    if (!cur || ts - prev > PEAK_GAP_MS) {
      cur = { start: ts, clips: [] };
      const d = Math.abs(ts - moment);
      if (d < bestDiff) { bestDiff = d; best = cur; }
    }
    cur.clips.push(u);
    prev = ts;
  }
  return best ? best.clips : [];
}

module.exports = { initSessionRoutes, createSessionForUser };