// ================================
// AUTH — JWT verification middleware (HTTP + socket) and the
// register/login/me routes.
//
// Future home of tier gating: add requireTier('T3') style middleware
// here and every TIER GATE in the codebase becomes a one-liner on a route.
// ================================
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { log } = require('./logger');
const { safeError } = require('./utils');
const { JWT_SECRET, JWT_EXPIRY, BCRYPT_ROUNDS } = require('./config');
const { users, saveUsersToDisk } = require('./stores');

// --- HTTP middleware ---
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return safeError(res, 401, 'Authentication required');
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return safeError(res, 401, 'Invalid or expired token. Please log in again.');
  }
}

// --- Socket.IO middleware ---
function socketAuth(socket, next) {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('auth_required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    next(new Error('auth_invalid'));
  }
}

// --- Routes ---
function initAuthRoutes(app) {
  app.post('/auth/register', async (req, res) => {
    const { username, password } = req.body || {};
    const clean = (username || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!clean || clean.length < 2 || clean.length > 24) {
      return safeError(res, 400, 'Username must be 2-24 characters: letters, numbers, _ or -');
    }
    if (!password || password.length < 8 || password.length > 128) {
      return safeError(res, 400, 'Password must be 8-128 characters');
    }
    if (users.has(clean.toLowerCase())) {
      return safeError(res, 409, 'Username already taken');
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = { username: clean, passwordHash, createdAt: new Date().toISOString() };
    users.set(clean.toLowerCase(), user);
    saveUsersToDisk();
    const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    log('info', 'user_registered', { username: clean });
    return res.status(201).json({ token, username: clean });
  });

  app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const clean = (username || '').trim();
    if (!clean || !password) {
      return safeError(res, 400, 'Username and password required');
    }
    const user = users.get(clean.toLowerCase());
    // Timing-safe: always run bcrypt.compare even for unknown usernames
    const hashToCheck = user ? user.passwordHash : '$2b$12$invalidhashfortimingprotection000000000000000000000000';
    const valid = await bcrypt.compare(password, hashToCheck);
    if (!user || !valid) {
      return safeError(res, 401, 'Invalid username or password');
    }
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    log('info', 'user_login', { username: user.username });
    return res.status(200).json({ token, username: user.username });
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    return res.json({ username: req.user.username });
  });
}

module.exports = { requireAuth, socketAuth, initAuthRoutes };
