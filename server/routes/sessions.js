// ================================
// SESSION ROUTES — create a session, read session state, list uploads.
// createSessionForUser() is shared with the migrate-session socket
// handler in sockets/index.js so "start a new session" behaves identically
// whether it comes from the button or the API.
// ================================
const { v4: uuidv4 } = require('uuid');
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError, generateCode } = require('../utils');
const { MAX_SESSIONS, MAX_MEMBERS_PER_SESSION, TIERS } = require('../config');
const { sessions, users, saveUsersToDisk } = require('../stores');
const { requireAuth, getEffectiveTier, getMonthKey } = require('../auth');

// Shared by POST /sessions and the migrate-session socket handler.
// Returns { session } on success or { error, status } on failure.
function createSessionForUser(rawUsername) {
  const username = sanitizeUsername(rawUsername);
  if (!username) return { error: 'Invalid account username', status: 400 };

  const user = users.get(rawUsername.toLowerCase());
  const tier = getEffectiveTier(user);
  const tierConfig = TIERS[tier];

  if (!tierConfig.canHost) {
    return { error: "Free tier can host 2 total a session — upgrade to Creator, Squad, or Pro.", status: 403 };
  }

  const monthKey = getMonthKey();
  if (user.sessionsMonthKey !== monthKey) {
    user.sessionsMonthKey = monthKey;
    user.sessionsThisMonth = 0;
  }
  if (user.sessionsThisMonth >= tierConfig.sessionsPerMonth) {
    return { error: `Monthly session limit reached for ${tierConfig.label} (${tierConfig.sessionsPerMonth}/mo). Resets next month.`, status: 403 };
  }

  if (sessions.size >= MAX_SESSIONS) {
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
    uploads: []
  };

  sessions.set(code, session);
  user.sessionsThisMonth++;
  saveUsersToDisk();
  log('info', 'session_created', { code, createdBy: username, hostTier: tier, sessionsThisMonth: user.sessionsThisMonth });

  return { session };
}

function initSessionRoutes(app) {
  app.post('/sessions', requireAuth, (req, res) => {
    const result = createSessionForUser(req.user.username);
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

  app.get('/sessions/:code', (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.json({
      code: session.code,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt || null,
      clipDuration: session.clipDuration,
      maxMembers: session.maxMembers || MAX_MEMBERS_PER_SESSION,
      maxClips: session.maxClips || null,
      clipsUsed: session.highlightCount || 0,
      members: session.members.map(m => ({
        username: m.username,
        isRecording: m.isRecording,
        joinedAt: m.joinedAt
      })),
      uploads: session.uploads
    });
  });

  app.get('/sessions/:code/uploads', (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Invalid session code' });

    const session = sessions.get(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.json({ uploads: session.uploads });
  });
}

module.exports = { initSessionRoutes, createSessionForUser };