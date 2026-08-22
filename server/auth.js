// ================================
// AUTH — JWT verification middleware (HTTP + socket), register/login/me
// routes, tier helpers, code redemption, and the admin code-generation
// route (see requireAdmin — gated by ADMIN_SECRET, not a user account).
// ================================
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { log } = require('./logger');
const { safeError } = require('./utils');
const { JWT_SECRET, JWT_EXPIRY, BCRYPT_ROUNDS, TIERS, TIER_ORDER, ADMIN_SECRET,
        REDEEM_ATTEMPT_MAX, REDEEM_ATTEMPT_WINDOW,
        REGISTER_IP_MAX, REGISTER_IP_WINDOW } = require('./config');
const { users, saveUsersToDisk } = require('./stores');
const { generateRedemptionCodes, redeemCode, peekCode } = require('./redemption');

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

// ================================
// ABUSE LIMITERS — both in-memory and volatile on purpose. A restart
// forgiving a few attempts is an acceptable tradeoff; neither of these
// needs to survive one, and keeping them off disk avoids write churn.
// ================================

// Failed redemption attempts per account. Only FAILURES count — a valid
// redemption clears the counter, so normal users never hit this. Guards
// against brute-forcing the 8-char code space across many attempts.
const redeemAttempts = new Map(); // usernameLower -> { count, resetAt }

function checkRedeemRate(usernameLower) {
  const now = Date.now();
  const entry = redeemAttempts.get(usernameLower);
  if (!entry || now > entry.resetAt) {
    redeemAttempts.set(usernameLower, { count: 0, resetAt: now + REDEEM_ATTEMPT_WINDOW });
    return true;
  }
  return entry.count < REDEEM_ATTEMPT_MAX;
}

function recordRedeemFailure(usernameLower) {
  const entry = redeemAttempts.get(usernameLower);
  if (entry) entry.count++;
}

function clearRedeemAttempts(usernameLower) {
  redeemAttempts.delete(usernameLower);
}

// New accounts per IP per day. Account creation is the enabler for most
// other abuse here (code brute-forcing, socket flooding, session
// squatting), so capping it starves those vectors of throwaway accounts.
// NOTE: households/LANs share a public IP — 5/day is well above normal
// legitimate use (a squad signing up together) without being permissive.
const registerAttempts = new Map(); // ip -> { count, resetAt }

function checkRegisterRate(ip) {
  const now = Date.now();
  const entry = registerAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    registerAttempts.set(ip, { count: 0, resetAt: now + REGISTER_IP_WINDOW });
    return true;
  }
  return entry.count < REGISTER_IP_MAX;
}

function recordRegistration(ip) {
  const entry = registerAttempts.get(ip);
  if (entry) entry.count++;
}

// Stale entry cleanup for both maps — same pattern as the socket rate
// limiter. Without this, every IP/account that ever hit these endpoints
// stays resident for the life of the process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of redeemAttempts) if (now > v.resetAt) redeemAttempts.delete(k);
  for (const [k, v] of registerAttempts) if (now > v.resetAt) registerAttempts.delete(k);
}, 10 * 60 * 1000);

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
  const provided = req.headers['x-admin-secret'];
  if (!ADMIN_SECRET || !provided || provided.length !== ADMIN_SECRET.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_SECRET))) {
    return safeError(res, 403, 'Forbidden');
  }
  next();
}

// --- HTTP middleware ---
// Rejects a token whose tokenVersion (tv claim) no longer matches the
// account's current version — i.e. the account has since logged in
// elsewhere and superseded this token (single-login / newest-wins). A
// token minted before tv existed has no tv claim; treated as version 0,
// which matches the DEFAULT 0 on existing rows, so nobody is force-logged
// out by the upgrade itself — only by a genuine newer login.
function tokenVersionOk(decoded) {
  const user = users.get((decoded.username || '').toLowerCase());
  if (!user) return false;
  const claimTv = typeof decoded.tv === 'number' ? decoded.tv : 0;
  return claimTv === (user.tokenVersion || 0);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return safeError(res, 401, 'Authentication required');
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (!tokenVersionOk(decoded)) {
      return safeError(res, 401, 'Signed in on another device. Please log in again.');
    }
    req.user = decoded;
    next();
  } catch (err) {
    return safeError(res, 401, 'Invalid or expired token. Please log in again.');
  }
}

// Same as requireAuth but also accepts the token via ?token= query param.
// Needed for plain <a href> download links (composite/AI reel exports) —
// those trigger a browser navigation, not a fetch, so they can't attach an
// Authorization header. Use this ONLY on download-style GET routes;
// everything else keeps using header-only requireAuth.
function requireAuthAny(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7)
    : req.query.token;
  if (!token) return safeError(res, 401, 'Authentication required');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!tokenVersionOk(decoded)) {
      return safeError(res, 401, 'Signed in on another device. Please log in again.');
    }
    req.user = decoded;
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
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!tokenVersionOk(decoded)) return next(new Error('auth_invalid'));
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('auth_invalid'));
  }
}

// --- Routes ---
function initAuthRoutes(app) {
  app.post('/auth/register', async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRegisterRate(ip)) {
      log('warn', 'register_rate_limited', { ip });
      return safeError(res, 429, 'Too many accounts created from this network today. Try again tomorrow.');
    }

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
        user.tokenVersion = 0;
    users.set(clean.toLowerCase(), user);
    saveUsersToDisk();
    // Only count SUCCESSFUL registrations — a typo'd username or a taken
    // name shouldn't burn someone's daily allowance.
    recordRegistration(ip);
    const token = jwt.sign({ username: clean, tv: user.tokenVersion }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    log('info', 'user_registered', { username: clean, ip });
    return res.status(201).json({ token, username: clean, tier: 't1' });
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
    // Newest-wins: bump the version so every previously-issued token for
    // this account (other devices) fails its tv check from here on.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    saveUsersToDisk();
    const token = jwt.sign({ username: user.username, tv: user.tokenVersion }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    log('info', 'user_login', { username: user.username, tier: getEffectiveTier(user) });
    return res.status(200).json({ token, username: user.username, tier: getEffectiveTier(user), tierExpiresAt: user.tierExpiresAt || null });
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    const user = users.get(req.user.username.toLowerCase());
    return res.json({ username: req.user.username, tier: getEffectiveTier(user), tierExpiresAt: user.tierExpiresAt || null });
  });

  app.post('/auth/redeem', requireAuth, (req, res) => {
    const { code } = req.body || {};
    if (!code) return safeError(res, 400, 'Code required');

    const usernameLower = req.user.username.toLowerCase();
    if (!checkRedeemRate(usernameLower)) {
      log('warn', 'redeem_rate_limited', { username: req.user.username });
      return safeError(res, 429, 'Too many failed code attempts. Try again in an hour.');
    }

    // Peek first (no mutation) — "is this code even usable" has to be
    // answered before "does this tier make sense for this account".
    const preview = peekCode(code, req.user.username);
    if (!preview.ok) {
      recordRedeemFailure(usernameLower);
      return safeError(res, 400, preview.error);
    }

    const user = users.get(usernameLower);
    const currentTier = getEffectiveTier(user);
    const hasActivePlan = currentTier !== 't1';

    // Anti-stacking: a TIMED code can't be redeemed on top of an active
    // subscription at the same or higher tier — this is what stops one
    // account from buying five 30-day codes and chaining them into five
    // months. It CAN be used to upgrade (t2 active -> redeem t3 timed
    // code is fine) and lifetime codes always bypass this entirely, since
    // those are hand-issued (friends/family, big backers) not sold in bulk.
    if (preview.durationDays && hasActivePlan &&
        TIER_ORDER.indexOf(preview.tier) <= TIER_ORDER.indexOf(currentTier)) {
      // Not a brute-force signal — this is a legitimate code the user
      // simply can't apply yet, so it doesn't count against the limiter.
      return safeError(res, 400,
        `You already have an active ${TIERS[currentTier].label} plan. Timed codes can't stack on an active subscription — wait for it to expire, or redeem a code for a higher tier to upgrade now.`);
    }

    const result = redeemCode(code, req.user.username);
    if (!result.ok) {
      recordRedeemFailure(usernameLower);
      return safeError(res, 400, result.error);
    }

    clearRedeemAttempts(usernameLower);

    // Carry over unused time from the current plan on an upgrade — the user
    // already paid for those remaining days via their prior code, so an
    // upgrade shouldn't silently forfeit them. Only applies when the new
    // grant is timed; a lifetime grant makes carryover moot.
    const remainingMs = (user.tierExpiresAt && user.tierExpiresAt > Date.now())
      ? user.tierExpiresAt - Date.now()
      : 0;

    user.tier = result.tier;
    user.tierSource = 'redeemed';
    user.tierExpiresAt = result.durationDays
      ? Date.now() + result.durationDays * 24 * 60 * 60 * 1000 + remainingMs
      : null; // null = lifetime

    saveUsersToDisk();
    log('info', 'tier_granted', {
      username: req.user.username, tier: result.tier, source: 'redeemed',
      durationDays: result.durationDays, tierExpiresAt: user.tierExpiresAt,
      carriedOverMs: remainingMs
    });
    return res.json({
      tier: result.tier,
      tierExpiresAt: user.tierExpiresAt,
      daysCarriedOver: remainingMs > 0 ? Math.round(remainingMs / (24 * 60 * 60 * 1000)) : 0
    });
  });

  // Admin-only — generate codes for Kickstarter batches etc. Not for
  // client use; hit this from the droplet with curl. Examples:
  //   Timed (30-day) Squad code, 50 uses — Kickstarter tier:
  //   curl -X POST https://peakabu.app/admin/redemption-codes \
  //     -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  //     -d '{"tier":"t3","note":"KS $28 backers","maxUses":50,"quantity":1,"durationDays":30}'
  //
  //   Lifetime Pro code, 1 use — friend/family/$1500 backer:
  //   curl -X POST https://peakabu.app/admin/redemption-codes \
  //     -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  //     -d '{"tier":"t4","note":"lifetime - family","maxUses":1,"quantity":1}'
  app.post('/admin/redemption-codes', requireAdmin, (req, res) => {
    const { tier, note, maxUses, quantity, durationDays } = req.body || {};
    if (!TIERS[tier]) return safeError(res, 400, 'Invalid tier');
    try {
      const generated = generateRedemptionCodes({ tier, note, maxUses, quantity, durationDays });
      return res.status(201).json({ codes: generated });
    } catch (err) {
      log('warn', 'redemption_code_generation_failed', { error: err.message });
      return safeError(res, 400, 'Could not generate redemption codes. Check the request parameters.');
    }
  });
}

module.exports = { requireAuth, requireAuthAny, socketAuth, initAuthRoutes, requireTier, requireAdmin, getEffectiveTier, getMonthKey };