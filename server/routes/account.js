// ================================
// ACCOUNT + SPOT CARD ROUTES — what peakabu.app/account shows.
//
//   GET  /account                         the page (public/account.html)
//   GET  /api/account                     plan, limits, this month's usage, Mobile status
//   GET  /api/account/sessions            hosted sessions + their Public state
//   GET  /api/account/codes               codes this account bought (to use or gift)
//   GET  /api/account/devices             where this account is signed in
//   POST /api/account/devices/:sid/signout   sign one of them out
//
//   GET    /api/spots/sets                my Spot card sets
//   POST   /api/spots/sets                new set { name, spots: [{ name, color }] }
//   PATCH  /api/spots/sets/:id            rename / edit spots (kept spots keep their QR)
//   DELETE /api/spots/sets/:id
//   POST   /api/spots/sets/:id/reissue    new QR codes; old printed cards stop working
//   GET    /api/spots/sets/:id/cards      cards with QR codes as SVG, for printing
//   GET    /s/:token                      a scanned card: into the party, or a waiting page
//   GET    /api/spots/card/:token         what the waiting page shows
//
// Mobile server only (X-Mobile-Secret), when a party starts / ends / a card
// is scanned there:
//   POST /internal/mobile/spots/attach    { username, setId, joinUrl, until }
//   POST /internal/mobile/spots/detach    { username, setId }
//   GET  /internal/mobile/spots/card/:token
// ================================
const path = require('path');
const QRCode = require('qrcode');
const { log } = require('../logger');
const { safeError, getMonthKey } = require('../utils');
const { createRateLimiter } = require('../ratelimit');
const { TIERS } = require('../config');
const { users, sessions, getSessionsByUser } = require('../stores');
const { requireAuth, getEffectiveTier, getTierExpiresAt } = require('../auth');
const loginSlots = require('../login-slots');
const mobile = require('../mobile');
const entitlements = require('../entitlements');
const { codesBoughtBy } = require('../redemption');
const spots = require('../spots');
const { hostState } = require('./public');

const SITE_URL = (process.env.SITE_URL || 'https://peakabu.app').replace(/\/$/, '');
const MOBILE_PUBLIC_URL = (process.env.MOBILE_PUBLIC_URL || '').replace(/\/$/, '');
const cardUrl = (token) => `${SITE_URL}/s/${token}`;

const accountLimiter = createRateLimiter({ windowMs: 60000, max: 60 });
const spotWriteLimiter = createRateLimiter({ windowMs: 60000, max: 30 });
const qrLimiter = createRateLimiter({ windowMs: 60000, max: 20 });
// Per IP. A whole wedding can share one venue Wi-Fi address, so these are
// loose: tokens are 192-bit (nothing to guess) and each hit is one indexed
// lookup. The waiting page polls every 30s.
const scanLimiter = createRateLimiter({ windowMs: 60000, max: 300 });
const cardPollLimiter = createRateLimiter({ windowMs: 60000, max: 600 });

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function userFor(req) {
  return users.get(String(req.user.username || '').toLowerCase()) || null;
}

function initAccountRoutes(app) {
  app.get('/account', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'account.html'));
  });

  // --- Plan, limits and this month's usage.
  app.get('/api/account', requireAuth, accountLimiter, (req, res) => {
    const user = userFor(req);
    if (!user) return safeError(res, 404, 'Account not found');
    const tier = getEffectiveTier(user);
    const t = TIERS[tier] || TIERS.t1;
    const sameMonth = user.sessionsMonthKey === getMonthKey();
    res.json({
      username: user.username,
      tier,
      tierLabel: t.label,
      tierExpiresAt: getTierExpiresAt(user),
      discordLinked: !!user.discordId,
      discordUsername: user.discordUsername || null,
      limits: {
        memberCap: t.memberCap,
        sessionsPerMonth: t.sessionsPerMonth,
        retentionDays: t.retentionDays,
        canListPublic: !!t.canListPublic,
        hasDownload: !!t.hasDownload,
        hasAiReel: !!t.hasAiReel
      },
      usage: { sessionsThisMonth: sameMonth ? (user.sessionsThisMonth || 0) : 0 },
      mobile: mobile.getMobileStatus(user, tier, getTierExpiresAt(user)),
      // Monthly subscriptions and any time saved to start after them.
      ...entitlements.subscriptionsFor(user.username.toLowerCase())
    });
  });

  // --- Codes bought on peakabu.app while signed in: unused ones to copy or
  // gift, and what happened to the rest. A code drops off this list a month
  // after it expired (the record itself stays as a sales record).
  app.get('/api/account/codes', requireAuth, accountLimiter, (req, res) => {
    const user = userFor(req);
    if (!user) return safeError(res, 404, 'Account not found');
    const me = user.username.toLowerCase();
    const now = Date.now();
    const DAY = 86400000;
    const list = codesBoughtBy(me).map((c) => {
      const use = (c.usedBy || [])[0] || null;
      const redeemedAt = use ? Date.parse(use.redeemedAt) : null;
      const m = c.meta || {};
      let label, expiresAt = null, status = use ? 'redeemed' : 'unused', subscriptionId = null, renewsAt = null;
      if (c.tier === 'sub') {
        const st = entitlements.subscriptionState(m.subId) || {};
        const plan = Object.values(entitlements.SUB_PLANS).find(p => p.tier === (entitlements.subscriptionTier(m.subId) || ''));
        label = plan ? plan.label.replace(', monthly', '') + ' (monthly)' : 'Monthly subscription';
        subscriptionId = st.live ? m.subId : null;
        renewsAt = st.renewsAt || null;
        expiresAt = st.endsAt || null; // set once cancelled or ended
        status = !st.live ? 'ended' : (use ? 'active' : 'unused');
      } else if (c.tier === 'event') {
        label = `Event pass (${m.hours}h, up to ${(mobile.EVENT_SIZES[mobile.eventSize(m.size)] || {}).phones || 15} phones)`;
        expiresAt = Number(m.startsAt) + Math.round(Number(m.hours) * 3600000); // the window ends either way
      } else if (c.tier === 'mobile') {
        label = `Peakabu Mobile, ${c.durationDays || 30} days`;
        if (redeemedAt) expiresAt = redeemedAt + (c.durationDays || 30) * DAY;
      } else {
        label = `${(TIERS[c.tier] || {}).label || c.tier}, ${c.durationDays ? c.durationDays + ' days' : 'lifetime'}`;
        if (redeemedAt && c.durationDays) expiresAt = redeemedAt + c.durationDays * DAY;
      }
      if (expiresAt && expiresAt <= now && status !== 'ended') status = 'expired';
      return {
        code: c.code, label, status, boughtAt: c.createdAt,
        redeemedAt, redeemedByYou: !!(use && String(use.username).toLowerCase() === me),
        expiresAt, renewsAt, subscriptionId
      };
    }).filter(x => !(x.expiresAt && x.expiresAt + 30 * DAY < now));
    res.json({ codes: list });
  });

  // --- Hosted sessions with their Public switch state, in one call.
  app.get('/api/account/sessions', requireAuth, accountLimiter, async (req, res) => {
    try {
      const list = getSessionsByUser(req.user.username, 50).map(s => {
        const live = sessions.get(s.code);
        let pub = { isPublic: false, state: 'off', canList: false, reason: null };
        if (live) { try { pub = hostState(live); } catch (e) {} }
        // The host's own link: carries the key when the session is members-only.
        const access = require('../session-access');
        const watch = live ? { visibility: access.isMembersOnly(live) ? 'members' : 'everyone', watchUrl: access.watchUrlFor(live) } : {};
        return { ...s, kind: 'pc', public: pub, ...watch };
      });
      // Peakabu Mobile parties this account hosted. Public is switched on the
      // mobile host page, so the row only shows its state.
      const mob = (await mobile.hostedMobileSessions(req.user.username)).map(m => ({
        kind: 'mobile', code: m.id, title: m.name, createdAt: m.createdAt, endedAt: m.endedAt,
        clipCount: (m.clips || 0) + (m.photos || 0), clips: m.clips || 0, photos: m.photos || 0, peaks: m.peaks || 0,
        expiresAt: m.expiresAt, watchUrl: m.watchUrl, listed: !!m.listed
      }));
      res.json({ sessions: list.concat(mob) });
    } catch (err) {
      log('error', 'account_sessions_failed', { error: err.message });
      safeError(res, 500, 'Could not load your sessions');
    }
  });

  // --- Where this account is signed in (one per platform).
  app.get('/api/account/devices', requireAuth, accountLimiter, (req, res) => {
    const list = loginSlots.listSlots(req.user.username.toLowerCase());
    res.json({
      platforms: loginSlots.PLATFORMS,
      devices: list.map(d => ({ id: d.sid, platform: d.platform, signedInAt: d.signedInAt, lastSeenAt: d.lastSeenAt, current: d.sid === req.user.sid }))
    });
  });

  app.post('/api/account/devices/:sid/signout', requireAuth, accountLimiter, (req, res) => {
    const key = req.user.username.toLowerCase();
    const sid = String(req.params.sid || '');
    if (!loginSlots.listSlots(key).some(d => d.sid === sid)) return safeError(res, 404, 'That device is not signed in.');
    loginSlots.closeSlot(key, sid);
    log('info', 'device_signed_out', { username: req.user.username });
    res.json({ ok: true });
  });

  // ---------------- Spot cards ("Swing cards" to users; see spots.js) ----------------
  app.get('/api/spots/sets', requireAuth, accountLimiter, (req, res) => {
    res.json({
      sets: spots.listSets(req.user.username.toLowerCase(), cardUrl),
      limits: { maxSets: spots.MAX_SETS, maxSpots: spots.MAX_SPOTS },
      colors: spots.COLORS
    });
  });

  app.post('/api/spots/sets', requireAuth, spotWriteLimiter, (req, res) => {
    const { name, spots: list } = req.body || {};
    const r = spots.createSet(req.user.username.toLowerCase(), name, list);
    if (r.error) return safeError(res, 400, r.error);
    log('info', 'spot_set_created', { username: req.user.username, spots: Array.isArray(list) ? list.length : 0 });
    res.status(201).json({ set: spots.shape(r.set, cardUrl) });
  });

  app.patch('/api/spots/sets/:id', requireAuth, spotWriteLimiter, (req, res) => {
    const set = spots.getOwnedSet(req.user.username.toLowerCase(), req.params.id);
    if (!set) return safeError(res, 404, 'Card set not found');
    const { name, spots: list } = req.body || {};
    const r = spots.updateSet(set, name, list);
    if (r.error) return safeError(res, 400, r.error);
    res.json({ set: spots.shape(r.set, cardUrl) });
  });

  app.delete('/api/spots/sets/:id', requireAuth, spotWriteLimiter, (req, res) => {
    const set = spots.getOwnedSet(req.user.username.toLowerCase(), req.params.id);
    if (!set) return safeError(res, 404, 'Card set not found');
    spots.deleteSet(set);
    res.json({ ok: true });
  });

  app.post('/api/spots/sets/:id/reissue', requireAuth, spotWriteLimiter, (req, res) => {
    const set = spots.getOwnedSet(req.user.username.toLowerCase(), req.params.id);
    if (!set) return safeError(res, 404, 'Card set not found');
    const fresh = spots.reissueSet(set);
    log('info', 'spot_set_reissued', { username: req.user.username });
    res.json({ set: spots.shape(fresh, cardUrl) });
  });

  // Ready-to-print cards: each spot's QR as an SVG string.
  app.get('/api/spots/sets/:id/cards', requireAuth, qrLimiter, async (req, res) => {
    const set = spots.getOwnedSet(req.user.username.toLowerCase(), req.params.id);
    if (!set) return safeError(res, 404, 'Card set not found');
    try {
      const cards = await Promise.all(spots.cardsForSet(set).map(async c => ({
        id: c.id, name: c.name, color: c.color, url: cardUrl(c.token),
        svg: await QRCode.toString(cardUrl(c.token), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#10261a', light: '#ffffff' } })
      })));
      res.set('Cache-Control', 'no-store');
      res.json({ set: { id: set.id, name: set.name }, cards });
    } catch (err) {
      log('error', 'spot_qr_failed', { error: err.message });
      safeError(res, 500, 'Could not make the QR codes');
    }
  });

  // A scanned card. Live party -> straight in; otherwise the waiting page.
  app.get('/s/:token', scanLimiter, (req, res) => {
    const hit = spots.resolveToken(req.params.token);
    if (hit && hit.live && hit.set.attachedJoinUrl) {
      const sep = hit.set.attachedJoinUrl.includes('?') ? '&' : '?';
      return res.redirect(302, `${hit.set.attachedJoinUrl}${sep}spot=${encodeURIComponent(hit.card.id)}`);
    }
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(PUBLIC_DIR, 'spot.html'));
  });

  // A host test-scanning their own printed card while signed in on this
  // browser: the waiting page says the card is theirs and linked.
  app.get('/api/spots/card/:token/mine', requireAuth, cardPollLimiter, (req, res) => {
    const hit = spots.resolveToken(req.params.token);
    if (!hit) return safeError(res, 404, 'Card not found');
    res.set('Cache-Control', 'no-store');
    res.json({ mine: hit.set.usernameLower === req.user.username.toLowerCase(), setName: hit.set.name });
  });

  app.get('/api/spots/card/:token', cardPollLimiter, (req, res) => {
    const hit = spots.resolveToken(req.params.token);
    if (!hit) return safeError(res, 404, 'This card isn\'t active any more. Ask the host for a new one.');
    res.set('Cache-Control', 'no-store');
    res.json({ setName: hit.set.name, spotName: hit.card.name, color: hit.card.color, live: hit.live });
  });

  // ---------------- Mobile server only ----------------
  function ownedSetForMobile(req, res) {
    if (!mobile.mobileSecretOk(req)) { safeError(res, 403, 'Forbidden'); return null; }
    const { username, setId } = req.body || {};
    const set = spots.getOwnedSet(String(username || '').toLowerCase(), setId);
    if (!set) { safeError(res, 404, 'Card set not found'); return null; }
    return set;
  }

  app.post('/internal/mobile/spots/attach', (req, res) => {
    const set = ownedSetForMobile(req, res);
    if (!set) return;
    const { joinUrl, until } = req.body || {};
    // Only ever redirect scanners to our own mobile site.
    if (!MOBILE_PUBLIC_URL || typeof joinUrl !== 'string' || !joinUrl.startsWith(MOBILE_PUBLIC_URL + '/')) {
      return safeError(res, 400, 'joinUrl must be on the mobile site');
    }
    spots.attachSet(set, joinUrl, until);
    res.json({ ok: true, set: spots.shape(spots.getOwnedSet(set.usernameLower, set.id), cardUrl) });
  });

  app.post('/internal/mobile/spots/detach', (req, res) => {
    const set = ownedSetForMobile(req, res);
    if (!set) return;
    spots.detachSet(set);
    res.json({ ok: true });
  });

  // The mobile host page's "Use Swing cards" picker: this host's sets.
  app.get('/internal/mobile/spots/sets/:username', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const key = String(req.params.username || '').toLowerCase();
    if (!/^[a-z0-9_-]{2,24}$/.test(key)) return safeError(res, 400, 'Invalid username');
    res.json({ sets: spots.listSets(key, cardUrl) });
  });

  app.get('/internal/mobile/spots/card/:token', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const hit = spots.resolveToken(req.params.token);
    if (!hit) return safeError(res, 404, 'Card not found');
    res.json({ setId: hit.set.id, owner: hit.set.usernameLower, spotId: hit.card.id, spotName: hit.card.name, color: hit.card.color });
  });
}

module.exports = { initAccountRoutes };
