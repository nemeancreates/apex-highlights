// ================================
// AUTH — JWT verification middleware (HTTP + socket), register/login/me
// routes, tier helpers, code redemption, and the admin code-generation
// route (see requireAdmin — gated by ADMIN_SECRET, not a user account).
// ================================
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { log } = require('./logger');
const { safeError } = require('./utils');
const { JWT_SECRET, JWT_EXPIRY, BCRYPT_ROUNDS, TIERS, ADMIN_SECRET } = require('./config');
const { users, saveUsersToDisk } = require('./stores');
const { generateRedemptionCodes, redeemCode } = require('./redemption');

// A user's tier as of right now — falls back to t1 for missing/unknown/
// expired tiers rather than trusting a stale field forever. tierExpiresAt
// is null for lifetime grants (redeemed codes, manual); a future Stripe
// integration would set a real expiry on that same field.
function getEffectiveTier(user) {
  if (!user || !user.tier || !TIERS[user.tier]) return 't1';
  if (user.tierExpiresAt && Date.now() > user.tierExpiresAt) return 't1';
  return user.tier;
}

function getMonthKey() { return new Date().toISOString().slice(0, 7); }

// Route middleware: requires the user's effective tier to be in allowedTiers.
// Always re-reads from the store (never trusts the JWT) so a redemption
// takes effect immediately instead of waiting out the 7-day token expiry.
function requireTier(allowedTiers) {
  return (req, res, next) => {
    const user = users.get((req.user.username || '').toLowerCase());
    const tier = getEffectiveTier(user);
    if (!allowedTiers.includes(tier)) {
      return safeError(res, 403, `This requires ${allowedTiers.map(t => TIERS[t].label).join(' or ')} tier.`);
    }
    req.userTier = tier;
    next();
  };
}

// Admin-only gate for redemption-code generation. Deliberately NOT tied to
// any user account — a compromised user (even a Pro one) can't mint codes.
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.headers['x-admin-secret'] !== ADMIN_SECRET) {
    return safeError(res, 403, 'Forbidden');
  }
  next();
}

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
    const user = {
      username: clean, passwordHash, createdAt: new Date().toISOString(),
      tier: 't1', tierSource: 'default', tierExpiresAt: null,
      sessionsThisMonth: 0, sessionsMonthKey: getMonthKey(),
      bandwidthBytesThisMonth: 0, bandwidthMonthKey: getMonthKey(), bandwidthAlertedThisMonth: false
    };
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
    const user = users.get(req.user.username.toLowerCase());
    return res.json({ username: req.user.username, tier: getEffectiveTier(user) });
  });

  app.post('/auth/redeem', requireAuth, (req, res) => {
    const { code } = req.body || {};
    if (!code) return safeError(res, 400, 'Code required');
    const result = redeemCode(code, req.user.username);
    if (!result.ok) return safeError(res, 400, result.error);
    const user = users.get(req.user.username.toLowerCase());
    user.tier = result.tier;
    user.tierSource = 'redeemed';
    user.tierExpiresAt = null; // lifetime
    saveUsersToDisk();
    log('info', 'tier_granted', { username: req.user.username, tier: result.tier, source: 'redeemed' });
    return res.json({ tier: result.tier });
  });

  // Admin-only — generate codes for Kickstarter batches etc. Not for
  // client use; hit this from the droplet with curl. Example:
  //   curl -X POST https://peakabu.app/admin/redemption-codes \
  //     -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  //     -d '{"tier":"t3","note":"KS $60 backers","maxUses":50,"quantity":1}'
  app.post('/admin/redemption-codes', requireAdmin, (req, res) => {
    const { tier, note, maxUses, quantity } = req.body || {};
    if (!TIERS[tier]) return safeError(res, 400, 'Invalid tier');
    try {
      const generated = generateRedemptionCodes({ tier, note, maxUses, quantity });
      return res.status(201).json({ codes: generated });
    } catch (err) {
      return safeError(res, 400, err.message);
    }
  });
}

module.exports = { requireAuth, socketAuth, initAuthRoutes, requireTier, requireAdmin, getEffectiveTier, getMonthKey };