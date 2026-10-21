// ================================
// AUTH — JWT verification middleware (HTTP + socket), register/login/me
// routes, tier helpers, code redemption, and the admin code-generation
// route (see requireAdmin — gated by ADMIN_SECRET, not a user account).
// ================================
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { log } = require('./logger');
const { safeError, getMonthKey } = require('./utils');
const { JWT_SECRET, JWT_EXPIRY, BCRYPT_ROUNDS, TIERS, TIER_ORDER, TESTING, ADMIN_SECRET,
        REDEEM_ATTEMPT_MAX, REDEEM_ATTEMPT_WINDOW,
        REGISTER_IP_MAX, REGISTER_IP_WINDOW,
        ANOMALY_REGISTER_BURST_MAX, ANOMALY_REGISTER_BURST_WINDOW } = require('./config');
const { users, saveUsersToDisk } = require('./stores');
const { generateRedemptionCodes, redeemCode, peekCode, isProduct } = require('./redemption');
const mobile = require('./mobile');
const { getFlags, setFlags } = require('./killswitch');
const { DISCORD_ENABLED, DISCORD_RECOVERY_REDIRECT_URI, PRIVACY_POLICY_VERSION } = require('./config');
const { buildAuthorizeUrl, exchangeCodeForUser, consumeState, linkDiscordAccount, buildRecoveryUrl, consumeRecoveryState } = require('./discord-oauth');
const { syncRole } = require('./discord-bot');
const { recordEvent } = require('./anomaly');
const loginSlots = require('./login-slots');
// A user's tier as of right now — falls back to t1 for missing/unknown/
// expired tiers rather than trusting a stale field forever. tierExpiresAt
// is null for lifetime grants (redeemed codes, manual); a future Stripe
// integration would set a real expiry on that same field.
function getBaseTier(user) {
  if (!user || !user.tier || !TIERS[user.tier]) return 't1';
  if (user.tierExpiresAt && Date.now() > user.tierExpiresAt) return 't1';
  return user.tier;
}

// When the post-testing bonus ends for this account, or null if it has none.
// Eligible = account created inside the testing window (createdAt, so no
// extra stored field).
function bonusEndsAt(user) {
  if (!user || !TESTING.bonusMonths || !TESTING.startsAt || !TESTING.endsAt) return null;
  const joined = Date.parse(user.createdAt);
  if (!(joined >= TESTING.startsAt && joined <= TESTING.endsAt)) return null;
  return TESTING.endsAt + TESTING.bonusMonths * 30 * 24 * 60 * 60 * 1000;
}

// What the account can DO right now. During the testing phase that is the
// virtual t6 for every paid-or-free tier below Founder; after it, a tester's
// bonus tier applies while their own plan is Free. Use getBaseTier for
// anything about what they bought (Discord role, code stacking).
function getEffectiveTier(user) {
  const base = getBaseTier(user);
  if (TESTING.enabled) return ['t1', 't2', 't3', 't4'].includes(base) ? 't6' : base;
  if (base === 't1') {
    const end = bonusEndsAt(user);
    if (end && Date.now() < end) return TESTING.bonusTier;
  }
  return base;
}

// Expiry that goes with getEffectiveTier (what the client's "days left" shows).
function getTierExpiresAt(user) {
  if (getEffectiveTier(user) === getBaseTier(user)) return (user && user.tierExpiresAt) || null;
  return TESTING.enabled ? (TESTING.endsAt || null) : bonusEndsAt(user);
}

// getMonthKey moved to utils.js so every monthly counter in the app shares
// one definition (it was computed here in UTC and in generation-usage.js in
// local time). Still re-exported below, so existing importers are unaffected.

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

// ================================
// PASSWORD RESET TOKENS — short-lived, single-use, issued only after a
// completed Discord OAuth recovery flow (proof of Discord identity ==
// proof of account ownership, since discordId is verified at link time).
// In-memory only, same volatility tradeoff as the other maps above.
// ================================
const passwordResetTokens = new Map(); // token -> { username, expiresAt }

function issueResetToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  passwordResetTokens.set(token, { username, expiresAt: Date.now() + 15 * 60 * 1000 }); // 15 min
  return token;
}

function consumeResetToken(token) {
  const entry = passwordResetTokens.get(token);
  if (!entry) return null;
  passwordResetTokens.delete(token); // single-use
  if (Date.now() > entry.expiresAt) return null;
  return entry.username;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of passwordResetTokens) if (now > v.expiresAt) passwordResetTokens.delete(k);
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
// Also checks the login slot (login-slots.js): a token with a sid is only
// good while that slot is still one of the account's active logins.
function tokenVersionOk(decoded) {
  const key = (decoded.username || '').toLowerCase();
  const user = users.get(key);
  if (!user) return false;
  const claimTv = typeof decoded.tv === 'number' ? decoded.tv : 0;
  if (claimTv !== (user.tokenVersion || 0)) return false;
  if (decoded.sid) return loginSlots.isActive(key, decoded.sid);
  return true;
}

// Mints a token in a fresh login slot for `platform` ('pc' | 'mobile' |
// 'web'). An older login on the same platform is signed out; the other
// platforms stay signed in. The account's first slot login bumps
// tokenVersion once so pre-slot tokens (no sid) stop working — they'd
// otherwise be an uncounted extra login. Caller saves the user.
function issueLoginToken(user, platform) {
  const key = user.username.toLowerCase();
  if (!loginSlots.hasSlots(key)) user.tokenVersion = (user.tokenVersion || 0) + 1;
  const { sid, evicted, platform: pl } = loginSlots.openSlot(key, platform);
  if (evicted.length) log('info', 'login_slot_evicted', { username: user.username, platform: pl, evicted: evicted.length });
  return jwt.sign({ username: user.username, tv: user.tokenVersion || 0, sid, pl }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return safeError(res, 401, 'Authentication required');
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (!tokenVersionOk(decoded)) {
      return safeError(res, 401, 'You signed in on another device of the same kind, so this one was signed out. Please log in again.');
    }
    req.user = decoded;
    next();
  } catch (err) {
    return safeError(res, 401, 'Invalid or expired token. Please log in again.');
  }
}

// The signed-in account on a request, or null. For routes anyone can call
// that show more to some people (members-only sessions): never rejects.
function userFromRequest(req) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(h.slice(7), JWT_SECRET);
    return tokenVersionOk(decoded) ? decoded : null;
  } catch (e) { return null; }
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
      return safeError(res, 401, 'You signed in on another device of the same kind, so this one was signed out. Please log in again.');
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
  // Add near the other Discord routes:
  app.get('/auth/discord/recover-url', (req, res) => {
    if (!DISCORD_ENABLED) return safeError(res, 503, 'Discord recovery is not configured yet.');
    const url = buildRecoveryUrl();
    res.json({ url });
  });

  app.get('/auth/discord/recover-callback', async (req, res) => {
    if (!DISCORD_ENABLED) return res.status(503).send('Discord recovery is not configured.');
    const { code, state, error: discordError } = req.query;
    if (discordError) {
      return res.status(400).send('Recovery was cancelled or denied. You can close this tab and try again from the app.');
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state.');
    }
    if (!consumeRecoveryState(state)) {
      return res.status(400).send('This recovery link has expired or was already used. Please try again from the app.');
    }

    try {
      const discordUser = await exchangeCodeForUser(code, DISCORD_RECOVERY_REDIRECT_URI);

      let matchedUser = null;
      for (const u of users.values()) {
        if (u.discordId === discordUser.id) { matchedUser = u; break; }
      }

      if (!matchedUser) {
        return res.status(200).send(
          'No Peakabu account is linked to this Discord account. If you have an account, link Discord from Settings first, then use "Forgot password" again.'
        );
      }

      const resetToken = issueResetToken(matchedUser.username);
      return res.redirect(`https://peakabu.app/reset-password.html?token=${resetToken}`);
    } catch (err) {
      log('warn', 'discord_recovery_failed', { error: err.message });
      return res.status(500).send('Something went wrong verifying your Discord account. Please try again.');
    }
  });

  app.post('/auth/reset-password', async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return safeError(res, 400, 'Token and new password required');
    if (newPassword.length < 8 || newPassword.length > 128) {
      return safeError(res, 400, 'Password must be 8-128 characters');
    }

    const username = consumeResetToken(token);
    if (!username) return safeError(res, 400, 'This reset link has expired or was already used. Please request a new one.');

    const user = users.get(username.toLowerCase());
    if (!user) return safeError(res, 400, 'Account not found');

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Sign out everywhere: the version bump kills every token, and the
    // slots go so the next two logins start fresh.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    loginSlots.clearSlots(user.username.toLowerCase());
    saveUsersToDisk();
    log('info', 'password_reset_via_discord', { username: user.username });

    return res.json({ success: true });
  });
  app.post('/auth/register', async (req, res) => {
   if (getFlags().registrationPaused) {
     return safeError(res, 503, 'New sign-ups are temporarily paused. Existing accounts are unaffected — check back shortly.');
   }

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
    if (!req.body || req.body.acceptedTerms !== true) {
      return safeError(res, 400, 'You must agree to the Terms of Service and Privacy Policy');
    }
    if (users.has(clean.toLowerCase())) {
      return safeError(res, 409, 'Username already taken');
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = {
      username: clean, passwordHash, createdAt: new Date().toISOString(),
      tier: 't1', tierSource: 'default', tierExpiresAt: null,
      sessionsThisMonth: 0, sessionsMonthKey: getMonthKey(),
      bandwidthBytesThisMonth: 0, bandwidthMonthKey: getMonthKey(), bandwidthAlertedThisMonth: false,
      privacyVersionAccepted: PRIVACY_POLICY_VERSION, privacyAcceptedAt: Date.now(),
      recordingConsentSeen: false
    };
    user.tokenVersion = 0;
    users.set(clean.toLowerCase(), user);
    const token = issueLoginToken(user, loginSlots.platformFor(req));
    saveUsersToDisk();
    // Only count SUCCESSFUL registrations — a typo'd username or a taken
    // name shouldn't burn someone's daily allowance.
    recordRegistration(ip);
    recordEvent(`register:${ip}`, {
      windowMs: ANOMALY_REGISTER_BURST_WINDOW,
      threshold: ANOMALY_REGISTER_BURST_MAX,
      event: 'registration_burst_detected',
      extra: { ip }
    });
    log('info', 'user_registered', { username: clean, ip });
    return res.status(201).json({
      token, username: clean, tier: getEffectiveTier(user), tierExpiresAt: getTierExpiresAt(user),
      privacyVersionAccepted: PRIVACY_POLICY_VERSION,
      recordingConsentSeen: false
    });
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
    // Signing in during the 7-day grace period keeps the account.
    const deletionCancelled = require('./account-deletion').cancelDeletion(user.username.toLowerCase());
    // One login per platform (desktop app, mobile, website) at the same
    // time. Signing in again on the same platform signs out only the older
    // login there.
    const token = issueLoginToken(user, loginSlots.platformFor(req));
    saveUsersToDisk();
    log('info', 'user_login', { username: user.username, tier: getEffectiveTier(user) });
    return res.status(200).json({
      token, username: user.username, tier: getEffectiveTier(user), tierExpiresAt: getTierExpiresAt(user),
      ...(deletionCancelled ? { deletionCancelled: true } : {}),
      privacyVersionAccepted: user.privacyVersionAccepted || null,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      recordingConsentSeen: !!user.recordingConsentSeen
    });
  });

  // Frees this device's login slot. Clients that just drop their token
  // still work — the slot is replaced by the next login on that platform.
  app.post('/auth/logout', requireAuth, (req, res) => {
    if (req.user.sid) loginSlots.closeSlot(req.user.username.toLowerCase(), req.user.sid);
    res.json({ ok: true });
  });

  // Delete my account (password to confirm). Signs out everywhere now; the
  // account is deleted after 7 days unless they sign back in. See
  // account-deletion.js for what goes and what stays.
  // Per account, not per IP: phone requests all arrive from the mobile server.
  const deleteTries = new Map(); // usernameLower -> { n, reset }
  app.post('/auth/delete-account', requireAuth, async (req, res) => {
    const key = req.user.username.toLowerCase();
    const now = Date.now();
    let t = deleteTries.get(key);
    if (!t || now > t.reset) { t = { n: 0, reset: now + 60 * 60 * 1000 }; deleteTries.set(key, t); }
    if (++t.n > 5) return safeError(res, 429, 'Too many tries. Try again in an hour.');
    const r = await require('./account-deletion').requestDeletion(req.user.username, req.body && req.body.password);
    if (!r.ok) return safeError(res, r.status, r.error);
    res.json({ ok: true, deleteAt: r.dueAt });
  });

  app.get('/auth/me', requireAuth, (req, res) => {
    const user = users.get(req.user.username.toLowerCase());
    return res.json({
      username: req.user.username,
      tier: getEffectiveTier(user),
      tierExpiresAt: getTierExpiresAt(user),
      discordLinked: !!user.discordId,
      discordUsername: user.discordUsername || null,
      privacyVersionAccepted: user.privacyVersionAccepted || null,
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      recordingConsentSeen: !!user.recordingConsentSeen
    });
  });

  // Peakabu Mobile status for the signed-in account: paying or free, any
  // event passes, the free daily allowance. The mobile host page shows it.
  app.get('/auth/mobile', requireAuth, (req, res) => {
    const user = users.get(req.user.username.toLowerCase());
    if (!user) return safeError(res, 404, 'Account not found');
    res.json(mobile.getMobileStatus(user, getEffectiveTier(user), getTierExpiresAt(user)));
  });

  // Server-to-server, for the mobile server only (X-Mobile-Secret). It
  // re-checks a host's status while a session runs, without keeping their
  // login token, and claims event passes for sessions.
  app.get('/internal/mobile/status/:username', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const user = users.get(String(req.params.username || '').toLowerCase());
    if (!user) return safeError(res, 404, 'Account not found');
    res.json(mobile.getMobileStatus(user, getEffectiveTier(user), getTierExpiresAt(user)));
  });

  // Where a listed mobile session stands with moderation, for the host's switch.
  app.get('/internal/mobile/listing-state/:id', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const id = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return safeError(res, 400, 'Invalid id');
    res.json({ state: mobile.mobileListingState(id) });
  });

  app.post('/internal/mobile/event-passes/:id/claim', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const { username, sessionId } = req.body || {};
    if (typeof username !== 'string' || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{4,32}$/.test(sessionId)) {
      return safeError(res, 400, 'username and sessionId required');
    }
    const r = mobile.claimEventPass(username.toLowerCase(), String(req.params.id), sessionId);
    if (!r.ok) return safeError(res, 409, r.error);
    log('info', 'mobile_event_pass_claimed', { username, id: req.params.id, sessionId });
    res.json(r);
  });

  app.post('/auth/accept-privacy', requireAuth, (req, res) => {
    const user = users.get(req.user.username.toLowerCase());
    if (!user) return safeError(res, 404, 'Account not found');
    user.privacyVersionAccepted = PRIVACY_POLICY_VERSION;
    user.privacyAcceptedAt = Date.now();
    saveUsersToDisk();
    log('info', 'privacy_accepted', { username: user.username, version: PRIVACY_POLICY_VERSION });
    return res.json({ success: true, privacyVersionAccepted: PRIVACY_POLICY_VERSION });
  });

  app.post('/auth/ack-recording-consent', requireAuth, (req, res) => {
    const user = users.get(req.user.username.toLowerCase());
    if (!user) return safeError(res, 404, 'Account not found');
    user.recordingConsentSeen = true;
    saveUsersToDisk();
    return res.json({ success: true });
  });

  // Anti-stacking: a TIMED code can't be redeemed on top of an active
  // subscription at the same or higher tier — this is what stops one
  // account from buying five 30-day codes and chaining them into five
  // months. It CAN be used to upgrade (t2 active -> redeem t3 timed
  // code is fine) and lifetime codes always bypass this entirely, since
  // those are hand-issued (friends/family, big backers) not sold in bulk.
  // Mobile/event codes never touch the PC tier, so they're never blocked.
  function stackingError(preview, currentTier) {
    if (isProduct(preview.tier)) return null;
    if (preview.durationDays && currentTier !== 't1' &&
        TIER_ORDER.indexOf(preview.tier) <= TIER_ORDER.indexOf(currentTier)) {
      return `You already have an active ${TIERS[currentTier].label} plan. Timed codes can't stack on an active subscription — wait for it to expire, or redeem a code for a higher tier to upgrade now.`;
    }
    return null;
  }

  // What a code grants, in words the site can show ("Squad", 30 days).
  function describeCode(preview) {
    if (preview.tier === 'event') {
      const m = preview.meta || {};
      return { kind: 'event', label: 'Peakabu Mobile event pass', durationDays: null, hours: Number(m.hours) || null };
    }
    if (preview.tier === 'mobile') {
      return { kind: 'mobile', label: 'Peakabu Mobile', durationDays: preview.durationDays || 30 };
    }
    return { kind: 'pc', label: (TIERS[preview.tier] || {}).label || preview.tier, durationDays: preview.durationDays || null };
  }

  // Looks a code up WITHOUT using it, so the website can ask
  // "Are you sure you want to use Squad (30 days) for <username>?" first.
  // Shares the failed-attempt limiter with /auth/redeem, so it can't be
  // used to guess codes.
  app.post('/auth/redeem/check', requireAuth, (req, res) => {
    const { code } = req.body || {};
    if (!code) return safeError(res, 400, 'Code required');

    const usernameLower = req.user.username.toLowerCase();
    if (!checkRedeemRate(usernameLower)) {
      log('warn', 'redeem_rate_limited', { username: req.user.username });
      return safeError(res, 429, 'Too many failed code attempts. Try again in an hour.');
    }

    const preview = peekCode(code, req.user.username);
    if (!preview.ok) {
      recordRedeemFailure(usernameLower);
      return safeError(res, 400, preview.error);
    }

    const user = users.get(usernameLower);
    if (!user) return safeError(res, 404, 'Account not found');
    const stackErr = stackingError(preview, getBaseTier(user));
    if (stackErr) return safeError(res, 400, stackErr);

    return res.json({ username: req.user.username, ...describeCode(preview) });
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
    const currentTier = getBaseTier(user);

    // Peakabu Mobile codes (bought on peakabu.app/billing). They don't touch
    // the PC tier, so the anti-stacking rule below doesn't apply: Mobile time
    // stacks, and an event pass just lands on the account until it's used.
    // The PC client and the mobile host page both redeem through here.
    if (isProduct(preview.tier)) {
      const result = redeemCode(code, req.user.username);
      if (!result.ok) {
        recordRedeemFailure(usernameLower);
        return safeError(res, 400, result.error);
      }
      clearRedeemAttempts(usernameLower);
      const base = { tier: getEffectiveTier(user), tierExpiresAt: getTierExpiresAt(user), product: result.tier };
      if (result.tier === 'mobile') {
        const mobileExpiresAt = mobile.grantMobileDays(usernameLower, result.durationDays || 30);
        log('info', 'mobile_code_redeemed', { username: req.user.username, durationDays: result.durationDays });
        return res.json({ ...base, mobileExpiresAt, durationDays: result.durationDays,
          message: `Peakabu Mobile is active until ${new Date(mobileExpiresAt).toDateString()}.` });
      }
      const m = result.meta || {};
      const ev = mobile.addEventPass(usernameLower, Number(m.startsAt) || Date.now(), m.hours);
      log('info', 'event_code_redeemed', { username: req.user.username, eventId: ev.id });
      return res.json({ ...base, event: ev,
        message: 'Event pass added. Pick it when you start a session in Peakabu Mobile.' });
    }

    // Anti-stacking (see stackingError above). Not a brute-force signal —
    // a legitimate code the user simply can't apply yet, so it doesn't
    // count against the limiter.
    const stackErr = stackingError(preview, currentTier);
    if (stackErr) return safeError(res, 400, stackErr);

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
    // Same fire-and-forget-with-logging pattern as the link callback —
    // a Discord sync failure shouldn't fail the redemption response.
    if (user.discordId) {
      syncRole(user.discordId, result.tier).catch(() => {});
    }
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
    const { tier, note, maxUses, quantity, durationDays, meta } = req.body || {};
    if (!TIERS[tier] && !isProduct(tier)) return safeError(res, 400, 'Invalid tier');
    try {
      const generated = generateRedemptionCodes({ tier, note, maxUses, quantity, durationDays,
        meta: tier === 'event' && meta ? { startsAt: Number(meta.startsAt) || Date.now(), hours: Number(meta.hours) || 4 } : undefined });
      return res.status(201).json({ codes: generated });
    } catch (err) {
      log('warn', 'redemption_code_generation_failed', { error: err.message });
      return safeError(res, 400, 'Could not generate redemption codes. Check the request parameters.');
    }
  });
    // Kill switch — GET to check current state, POST to toggle. No restart
  // needed; takes effect on the very next request. Only gates NEW session
  // creation and NEW registration — logged-in users and active sessions
  // are never affected, so pausing can't strand anyone mid-session.
  //   curl https://peakabu.app/admin/kill-switch -H "X-Admin-Secret: $ADMIN_SECRET"
  //   curl -X POST https://peakabu.app/admin/kill-switch \
  //     -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
  //     -d '{"sessionsPaused":true,"registrationPaused":true,"reason":"wave-1 investigating a bug"}'
    // Discord linking. link-url is behind requireAuth (we need to know WHO
  // is linking); callback is public since Discord's redirect is a plain
  // browser navigation with no Authorization header — identity comes from
  // the single-use `state` value instead, not a session.
  app.get('/auth/discord/link-url', requireAuth, (req, res) => {
    if (!DISCORD_ENABLED) return safeError(res, 503, 'Discord linking is not configured yet.');
    const url = buildAuthorizeUrl(req.user.username);
    res.json({ url });
  });

  app.get('/auth/discord/callback', async (req, res) => {
    if (!DISCORD_ENABLED) return res.status(503).send('Discord linking is not configured.');

    const { code, state, error: discordError } = req.query;
    if (discordError) {
      log('warn', 'discord_link_denied', { error: discordError });
      return res.status(400).send('Discord linking was cancelled or denied. You can close this tab and try again from the app.');
    }
    if (!code || !state) {
      return res.status(400).send('Missing code or state.');
    }

    const username = consumeState(state);
    if (!username) {
      return res.status(400).send('This link request has expired or was already used. Please try linking again from the app.');
    }

    try {
      const discordUser = await exchangeCodeForUser(code);
      const result = linkDiscordAccount(username, discordUser);
      if (!result.ok) {
        const message = result.error === 'already_linked_elsewhere'
          ? 'This Discord account is already linked to a different Peakabu account.'
          : 'Could not link this account.';
        return res.status(400).send(message);
      }
      // Sync immediately so an existing Pro/Squad/Creator backer doesn't
      // have to wait for their next tier change to see the right role.
      // Fire-and-forget-with-logging: a sync failure here (e.g. they
      // haven't joined the Discord server yet) shouldn't block the
      // successful account link the user is actually watching for.
      const linkedUser = users.get(username.toLowerCase());
      syncRole(discordUser.id, getBaseTier(linkedUser)).catch(() => {});
      return res.status(200).send('Discord account linked! You can close this tab and return to Peakabu.');
    } catch (err) {
      log('warn', 'discord_link_failed', { error: err.message });
      return res.status(500).send('Something went wrong linking your Discord account. Please try again.');
    }
  });

  app.get('/admin/kill-switch', requireAdmin, (req, res) => {
    res.json(getFlags());
  });

  app.post('/admin/kill-switch', requireAdmin, (req, res) => {
    const { sessionsPaused, registrationPaused, reason } = req.body || {};
    const updated = setFlags({ sessionsPaused, registrationPaused, reason }, 'admin');
    res.json(updated);
  });
}

module.exports = { requireAuth, requireAuthAny, userFromRequest, socketAuth, initAuthRoutes, requireTier, requireAdmin, getEffectiveTier, getBaseTier, getTierExpiresAt, getMonthKey };