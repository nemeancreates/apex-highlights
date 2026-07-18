// ================================
// SESSION ROUTES — create a session, read session state, list uploads.
// ================================
const { v4: uuidv4 } = require('uuid');
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError, generateCode } = require('../utils');
const { MAX_SESSIONS } = require('../config');
const { sessions } = require('../stores');
const { requireAuth } = require('../auth');

function initSessionRoutes(app) {
  app.post('/sessions', requireAuth, (req, res) => {
    const username = sanitizeUsername(req.user.username);
    if (!username) {
      return safeError(res, 400, 'Invalid account username');
    }

    if (sessions.size >= MAX_SESSIONS) {
      return safeError(res, 503, 'Server is at capacity. Try again later.');
    }

    let code = generateCode();
    while (sessions.has(code)) code = generateCode();

    const session = {
      id: uuidv4(),
      code,
      createdBy: username,
      createdAt: new Date().toISOString(),
      clipDuration: 30000,        // default 30s — host can change
      highlightLockedUntil: 0,    // timestamp when session-wide lock expires
      highlightCount: 0,          // coordinated highlight triggers this session
      pendingHighlights: [],      // triggers that arrived during lock — fired in order
      members: [],
      uploads: []
    };

    sessions.set(code, session);
    log('info', 'session_created', { code, createdBy: username });

    res.status(201).json({ sessionCode: code, sessionId: session.id });
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
      clipDuration: session.clipDuration,
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

module.exports = { initSessionRoutes };
