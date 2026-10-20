// ================================
// PUBLIC SESSIONS — the website's browse page + cross-session roulette.
//
// A session is NEVER public unless its host turns it on. Listing state lives
// in its own table (not a sessions column) so nothing here touches the
// sessions upsert or the stores.js three-place rule, and so a listing can be
// dropped without rewriting the session row.
//
// What's public is exactly what the share link already exposes: anyone with
// a code could always watch it. Listing only makes the code discoverable.
// So the browse/roulette responses carry nothing GET /sessions/:code/uploads
// doesn't already return — no member lists, no bans, no internals.
//
// Moderation: anyone can report a listing (no account needed). Reports are
// deduped by a salted hash of the IP — raw IPs are never stored. At
// REPORT_HIDE_THRESHOLD distinct reporters the listing is hidden and the host
// can't relist it; an admin clears or removes it via the /admin routes.
//
// Same architecture note as routes/stars.js: schema is created here in a
// standalone block (no FK — a fresh session's row may not exist yet), the
// hourly sweep drops listings whose session is gone.
// ================================
const crypto = require('crypto');
const path = require('path');
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode, safeError } = require('../utils');
const { createRateLimiter } = require('../ratelimit');
const { JWT_SECRET } = require('../config');
const { sessions, saveSessionsToDisk } = require('../stores');
const access = require('../session-access');
const { requireAuth, requireAdmin } = require('../auth');
const db = require('../db');
const mod = require('../moderation');
const { isOnHold, listHolds, releaseHold, getHold } = require('../moderation/legal-hold');
const mobile = require('../mobile');
const moments = require('./moments');
const { postStaffAlert } = require('../moderation/staff-alerts');

// --- Tunables ---
const PEAK_GAP_MS = 5000;                       // same clustering rule as the web player
const RECENCY_HALF_LIFE_DAYS = 3;               // roulette weight halves every 3 days
const EXPIRY_GRACE_MS = 60 * 60 * 1000;         // hide sessions expiring within the hour
const REPORT_HIDE_THRESHOLD = 3;                // distinct reporters before auto-hide
const BROWSE_PAGE_MAX = 48;
const SEEN_MAX = 300;                           // roulette "already watched" list cap
// Starred moments (PC): a session with unseen starred peaks is this many
// times likelier to be picked, and inside it a starred peak is this many
// times likelier than an unstarred one. Mobile listings use Peak Moments
// instead (routes/moments.js).
const STAR_SESSION_BOOST = 3;
const STAR_PEAK_WEIGHT = 4;
// Mobile listings come from m.peakabu.app (see mobile.js). Their ids are
// prefixed so they can never collide with a PC session code.
const MOBILE_PREFIX = 'm-';
const PLATFORMS = ['pc', 'mobile'];
const REPORT_REASONS = ['child', 'privacy', 'inappropriate', 'spam', 'other'];

db.exec(`
  CREATE TABLE IF NOT EXISTS public_listings (
    sessionCode TEXT PRIMARY KEY,
    platform    TEXT NOT NULL DEFAULT 'pc',
    listedAt    INTEGER NOT NULL,
    listedBy    TEXT NOT NULL,
    views       INTEGER NOT NULL DEFAULT 0,
    hidden      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS public_reports (
    sessionCode TEXT NOT NULL,
    reporterKey TEXT NOT NULL,
    reason      TEXT,
    createdAt   INTEGER NOT NULL,
    PRIMARY KEY (sessionCode, reporterKey)
  );
`);

const stmt = {
  get:        db.prepare(`SELECT * FROM public_listings WHERE sessionCode = ?`),
  all:        db.prepare(`SELECT * FROM public_listings WHERE hidden = 0`),
  insert:     db.prepare(`
    INSERT INTO public_listings (sessionCode, platform, listedAt, listedBy)
    VALUES (@sessionCode, @platform, @listedAt, @listedBy)
    ON CONFLICT(sessionCode) DO NOTHING
  `),
  remove:     db.prepare(`DELETE FROM public_listings WHERE sessionCode = ?`),
  addView:    db.prepare(`UPDATE public_listings SET views = views + 1 WHERE sessionCode = ?`),
  hide:       db.prepare(`UPDATE public_listings SET hidden = 1 WHERE sessionCode = ?`),
  unhide:     db.prepare(`UPDATE public_listings SET hidden = 0 WHERE sessionCode = ?`),

  addReport:  db.prepare(`
    INSERT OR IGNORE INTO public_reports (sessionCode, reporterKey, reason, createdAt)
    VALUES (?, ?, ?, ?)
  `),
  countReports: db.prepare(`SELECT COUNT(*) AS n FROM public_reports WHERE sessionCode = ?`),
  clearReports: db.prepare(`DELETE FROM public_reports WHERE sessionCode = ?`),
  reported:   db.prepare(`
    SELECT l.sessionCode, l.listedBy, l.hidden, COUNT(r.reporterKey) AS reports,
      MAX(r.createdAt) AS lastReportAt
    FROM public_listings l JOIN public_reports r ON r.sessionCode = l.sessionCode
    GROUP BY l.sessionCode ORDER BY lastReportAt DESC LIMIT 100
  `),
  listingCodes: db.prepare(`SELECT sessionCode FROM public_listings UNION SELECT sessionCode FROM public_reports`),
  liveCodes:  db.prepare(`SELECT sessionCode FROM public_listings WHERE hidden = 0`),
  reportsFor: db.prepare(`SELECT reason, reporterKey, createdAt FROM public_reports WHERE sessionCode = ? ORDER BY createdAt ASC`),
  starsFor:   db.prepare(`SELECT momentTs FROM stars WHERE sessionCode = ?`)
};

function starredSet(code) {
  try { return new Set(stmt.starsFor.all(code).map(r => r.momentTs)); } catch (e) { return new Set(); }
}
// A peak is starred when any of its clips' coordinated timestamps was
// starred (a star belongs to a moment, shared by every POV of it).
function peakStarred(peak, stars) {
  if (!stars.size) return false;
  return peak.clips.some(c => typeof c.coordinatedTimestamp === 'number' && stars.has(c.coordinatedTimestamp));
}

// Same card shape as PC sessions, plus watchUrl: mobile sessions open in
// the mobile watch page, not the web player.
function mobileCard(l) {
  return {
    code: MOBILE_PREFIX + l.id,
    host: l.host || null,
    title: l.name || null,
    game: null,
    platform: 'mobile',
    povCount: l.povCount || 0,
    peakCount: l.peaks.length,
    views: 0,
    createdAt: new Date(l.createdAt || Date.now()).toISOString(),
    listedAt: l.listedAt || l.createdAt || 0,
    expiresAt: l.expiresAt || null,
    thumbnailUrl: l.thumbnailUrl || null,
    watchUrl: l.watchUrl
  };
}

// moderation/ reads listings and reports through these, and hides a listing
// when a scan flags it, without needing to require this file.
mod.registerListingHooks({
  getListing: (code) => { try { return stmt.get.get(code) || null; } catch (e) { return null; } },
  getReports: (code) => { try { return stmt.reportsFor.all(code); } catch (e) { return []; } },
  hideListing: (code) => { try { stmt.hide.run(code); } catch (e) {} }
});

// Salted so the stored key can't be reversed to an IP by brute-forcing the
// IPv4 space. Truncated: dedupe only needs it to be unique-enough.
function reporterKey(req) {
  return crypto.createHmac('sha256', String(JWT_SECRET || 'peakabu'))
    .update(String(req.ip || '')).digest('hex').slice(0, 24);
}

function isPublic(code) {
  try {
    const row = stmt.get.get(code);
    return !!row && !row.hidden;
  } catch (err) { return false; }
}

// Real clips only — a placeholder (no videoFile yet) isn't watchable.
function realClips(session) {
  return (session.uploads || []).filter(u => u.videoFile);
}

function clipTs(u) {
  if (typeof u.coordinatedTimestamp === 'number' && u.coordinatedTimestamp > 0) return u.coordinatedTimestamp;
  const t = Date.parse(u.uploadedAt);
  return Number.isFinite(t) ? t : 0;
}

// Clusters a session's clips into peaks, mirroring clusterHighlights() in
// the web player so peak counts and roulette picks line up with its pills.
function peaksOf(session) {
  const clips = realClips(session).slice().sort((a, b) => clipTs(a) - clipTs(b));
  const peaks = [];
  let cur = null;
  for (const c of clips) {
    const ts = clipTs(c);
    if (!cur || ts - cur.ts > PEAK_GAP_MS) {
      cur = { ts, clips: [c] };
      peaks.push(cur);
    } else {
      cur.clips.push(c);
    }
  }
  return peaks;
}

function thumbFor(session, clips) {
  const pick = clips.find(u => u.username === session.createdBy && (u.thumbnailUrl || u.thumbnailFile)) ||
               clips.find(u => u.thumbnailUrl || u.thumbnailFile);
  if (!pick) return null;
  return pick.thumbnailUrl || ('/media/' + session.code + '/' + pick.thumbnailFile);
}

// A listing is showable if its session still exists, isn't about to expire,
// and has at least one watchable clip.
function liveListings(now) {
  const out = [];
  let rows = [];
  try { rows = stmt.all.all(); } catch (err) { log('warn', 'public_list_failed', { error: err.message }); }
  for (const row of rows) {
    const session = sessions.get(row.sessionCode);
    if (!session) continue;
    if (session.expiresAt && session.expiresAt - now < EXPIRY_GRACE_MS) continue;
    // Banned hosts, held sessions, and anything not yet cleared by the
    // scanners never show, whatever the listing row says.
    if (!mod.isHostAllowed(session)) continue;
    if (mod.sessionScanState(session) !== 'clean') continue;
    const peaks = peaksOf(session);
    if (!peaks.length) continue;
    out.push({ row, session, peaks });
  }
  return out;
}

function card({ row, session, peaks }) {
  const clips = realClips(session);
  return {
    code: session.code,
    host: session.createdBy,
    title: session.title || null,
    game: session.detectedGame || null,
    platform: row.platform,
    povCount: new Set(clips.map(u => u.username)).size,
    peakCount: peaks.length,
    views: row.views,
    createdAt: session.createdAt,
    listedAt: row.listedAt,
    expiresAt: session.expiresAt || null,
    thumbnailUrl: thumbFor(session, clips)
  };
}

function ageDays(session, now) {
  const created = Date.parse(session.createdAt);
  return Number.isFinite(created) ? Math.max(0, (now - created) / 86400000) : 0;
}

// Parses "CODE.momentTs,CODE.momentTs" into a Set. Anything malformed is
// dropped rather than rejected — it's only a "don't repeat" hint.
function parseSeen(raw) {
  const seen = new Set();
  if (typeof raw !== 'string' || !raw) return seen;
  for (const part of raw.split(',').slice(0, SEEN_MAX)) {
    if (/^(?:[A-Z0-9]{4,6}|m-[A-Za-z0-9_-]{4,32})\.\d{1,15}$/.test(part)) seen.add(part);
  }
  return seen;
}

// Views: one per hashed IP per session per day, in memory only.
const viewDedupe = new Map();   // key -> expiry ms
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of viewDedupe) if (now > exp) viewDedupe.delete(k);
}, 30 * 60 * 1000);

// Hourly: drop listings + reports whose session is gone (purged at expiry).
function startPublicCleanup() {
  mod.startModerationSweep(() => {
    try { return stmt.liveCodes.all().map(r => r.sessionCode); } catch (e) { return []; }
  });
  setInterval(() => {
    try {
      let purged = 0;
      for (const { sessionCode } of stmt.listingCodes.all()) {
        if (sessions.has(sessionCode)) continue;
        purged += stmt.remove.run(sessionCode).changes;
        stmt.clearReports.run(sessionCode);
      }
      if (purged > 0) log('info', 'public_listings_purged', { listings: purged });
    } catch (err) {
      log('warn', 'public_purge_failed', { error: err.message });
    }
  }, 60 * 60 * 1000);
}

const browseLimiter   = createRateLimiter({ windowMs: 60000, max: 60 });
const rouletteLimiter = createRateLimiter({ windowMs: 60000, max: 40 });
const reportLimiter   = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const toggleLimiter   = createRateLimiter({ windowMs: 60000, max: 10 });

// What the host's Public button should show.
//   state: 'off' | 'checking' (scan pending) | 'live' | 'under-review'
function hostState(session) {
  const row = stmt.get.get(session.code);
  const allowed = mod.canListPublic(session.createdBy);
  let state = 'off';
  if (row) {
    if (row.hidden || isOnHold(session.code)) state = 'under-review';
    else if (mod.sessionScanState(session) === 'pending') state = 'checking';
    else if (mod.sessionScanState(session) === 'flagged') state = 'under-review';
    else state = 'live';
  }
  return {
    isPublic: state === 'live' || state === 'checking',
    state,
    underReview: state === 'under-review',
    canList: allowed.ok,
    reason: allowed.ok ? null : allowed.reason
  };
}

// What the host's controls show: the listing state plus who can watch and
// the link to share.
function hostView(session) {
  return {
    ...hostState(session),
    visibility: access.isMembersOnly(session) ? 'members' : 'everyone',
    watchUrl: access.watchUrlFor(session)
  };
}

// ================================
// ROUTES
// ================================
function initPublicRoutes(app) {

  // --- The browse page itself (public/browse.html), at a clean URL.
  app.get('/browse', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'browse.html'));
  });

  // --- HOST TOGGLE: list / unlist. Host only, enforced here.
  app.patch('/sessions/:code/public', requireAuth, toggleLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');
    if (session.createdBy !== sanitizeUsername(req.user.username)) {
      return safeError(res, 403, 'Only the session host can change this.');
    }

    const { isPublic: want, platform } = req.body || {};
    if (typeof want !== 'boolean') return safeError(res, 400, 'isPublic must be true or false');

    if (want) {
      const allowed = mod.canListPublic(session.createdBy);
      if (!allowed.ok) return safeError(res, 403, allowed.reason);
      if (isOnHold(code)) return safeError(res, 403, 'This session is under review.');
    }

    try {
      if (want) {
        const existing = stmt.get.get(code);
        if (existing && existing.hidden) {
          return safeError(res, 403, 'This session was reported and is under review.');
        }
        stmt.insert.run({
          sessionCode: code,
          platform: PLATFORMS.includes(platform) ? platform : 'pc',
          listedAt: Date.now(),
          listedBy: session.createdBy
        });
      } else {
        // Unlisting keeps nothing behind: reports go too, so a later relist
        // starts clean — unless it's hidden, in which case the row stays so
        // the host can't wash the reports by toggling.
        const existing = stmt.get.get(code);
        if (existing && !existing.hidden) {
          stmt.remove.run(code);
          stmt.clearReports.run(code);
        }
      }
    } catch (err) {
      log('error', 'public_toggle_failed', { code, error: err.message });
      return safeError(res, 500, 'Could not save that. Try again.');
    }

    // A public listing is open to anyone, so the session stops being members-only.
    if (want && session.visibility === 'members') { session.visibility = 'everyone'; saveSessionsToDisk(); }
    log('info', 'public_toggled', { session: code, isPublic: want, by: session.createdBy });
    // Scans run in the background; the listing appears on /browse once
    // every clip has cleared (immediately, if no scanner is configured).
    if (want) mod.scanSession(session).catch(() => {});
    res.json(hostView(session));
  });

  // --- Who can watch: 'members' (the people who were in it + the watch link)
  // or 'everyone' with the code. Host only. Members takes it off Browse.
  app.patch('/sessions/:code/visibility', requireAuth, toggleLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');
    if (session.createdBy !== sanitizeUsername(req.user.username)) return safeError(res, 403, 'Only the session host can change this.');
    const v = req.body && req.body.visibility;
    if (v !== 'members' && v !== 'everyone') return safeError(res, 400, "visibility must be 'members' or 'everyone'");
    session.visibility = v;
    if (v === 'members') {
      const existing = stmt.get.get(code);
      if (existing && !existing.hidden) { stmt.remove.run(code); stmt.clearReports.run(code); }
    }
    saveSessionsToDisk();
    log('info', 'visibility_changed', { session: code, visibility: v, by: session.createdBy });
    res.json(hostView(session));
  });

  // --- New watch link: the old one stops working. Host only.
  app.post('/sessions/:code/watch-link/reset', requireAuth, toggleLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');
    if (session.createdBy !== sanitizeUsername(req.user.username)) return safeError(res, 403, 'Only the session host can change this.');
    access.resetWatchKey(session);
    log('info', 'watch_link_reset', { session: code, by: session.createdBy });
    res.json(hostView(session));
  });

  // --- Host-only read of the toggle state (the player shows the switch).
  app.get('/sessions/:code/public', requireAuth, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const session = sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');
    if (session.createdBy !== sanitizeUsername(req.user.username)) {
      return safeError(res, 403, 'Only the session host can see this.');
    }
    res.json(hostView(session));
  });

  // --- BROWSE: cards for the website's public page.
  //   ?platform=pc|mobile  ?game=<text>  ?sort=new|popular  ?offset=N
  app.get('/api/public/sessions', browseLimiter, (req, res) => {
    const now = Date.now();
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : null;
    const game = typeof req.query.game === 'string' ? req.query.game.trim().toLowerCase().slice(0, 60) : '';
    const sort = req.query.sort === 'popular' ? 'popular' : 'new';
    const offset = Math.max(0, Math.min(10000, parseInt(req.query.offset, 10) || 0));

    let list = liveListings(now);
    const games = [...new Set(list.map(l => l.session.detectedGame).filter(Boolean))].sort();

    if (platform) list = list.filter(l => l.row.platform === platform);
    if (game) list = list.filter(l => (l.session.detectedGame || '').toLowerCase() === game);

    // Mobile sessions have no detected game, so a game filter leaves them out.
    let cards = list.map(card);
    if ((!platform || platform === 'mobile') && !game) {
      cards = cards.concat(mobile.mobileListings().filter(l => l.peaks.length).map(mobileCard));
    }

    if (sort === 'popular') cards.sort((a, b) => b.views - a.views || b.listedAt - a.listedAt);
    else cards.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      total: cards.length,
      games,
      sessions: cards.slice(offset, offset + BROWSE_PAGE_MAX)
    });
  });

  // --- ROULETTE: one random peak from any public session, weighted toward
  // newer sessions. ?seen= is the viewer's already-watched list (kept in
  // their browser); ?last= avoids the same session twice in a row.
  app.get('/api/public/roulette', rouletteLimiter, (req, res) => {
    const now = Date.now();
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : null;
    const seen = parseSeen(req.query.seen);
    const lastRaw = typeof req.query.last === 'string' ? req.query.last.slice(0, 40) : '';
    const last = lastRaw.startsWith(MOBILE_PREFIX) ? lastRaw : sanitizeCode(lastRaw);

    const rand = () => crypto.randomInt(1e9) / 1e9;
    function weightedPick(items, weightOf) {
      const total = items.reduce((s, x) => s + weightOf(x), 0);
      let r = rand() * total;
      for (const x of items) { r -= weightOf(x); if (r <= 0) return x; }
      return items[items.length - 1];
    }

    // PC: recency, boosted toward sessions with unseen starred moments.
    let pool = liveListings(now)
      .filter(l => !platform || l.row.platform === platform)
      .map(l => {
        // Roulette only uses peaks with a real coordinated timestamp, so the
        // player can land on exactly the same moment.
        const stars = starredSet(l.session.code);
        const unseen = l.peaks
          .filter(p => p.clips.some(c => c.coordinatedTimestamp) && !seen.has(l.session.code + '.' + p.ts))
          .map(p => ({ ...p, starred: peakStarred(p, stars) }));
        const boost = unseen.some(p => p.starred) ? STAR_SESSION_BOOST : 1;
        return { kind: 'pc', key: l.session.code, l, unseen,
          weight: Math.pow(0.5, ageDays(l.session, now) / RECENCY_HALF_LIFE_DAYS) * boost };
      })
      .filter(x => x.unseen.length);

    // Mobile: recency, boosted by Peak Moments (see routes/moments.js).
    const counts = moments.momentCounts();
    if (!platform || platform === 'mobile') {
      for (const l of mobile.mobileListings()) {
        const key = MOBILE_PREFIX + l.id;
        const unseen = l.peaks.filter(p => Number.isFinite(p.t) && !seen.has(key + '.' + p.t));
        if (!unseen.length) continue;
        pool.push({ kind: 'mobile', key, l, unseen, weight: moments.listingWeight(l, unseen, counts, now) });
      }
    }

    if (!pool.length) return res.json({ exhausted: true });
    if (pool.length > 1 && last) pool = pool.filter(x => x.key !== last);

    const pick = weightedPick(pool, x => x.weight);
    res.set('Cache-Control', 'no-store');

    if (pick.kind === 'mobile') {
      const peak = moments.pickPeak(pick.l, pick.unseen, counts);
      const c = mobileCard(pick.l);
      const sep = c.watchUrl.includes('?') ? '&' : '?';
      return res.json({
        code: c.code, host: c.host, title: c.title, game: null, platform: 'mobile',
        expiresAt: c.expiresAt, momentTs: peak.t, starred: false,
        povCount: peak.povCount || c.povCount,
        watchUrl: c.watchUrl + sep + 'peak=' + encodeURIComponent(peak.id || '') + '&from=roulette'
      });
    }

    const peak = weightedPick(pick.unseen, p => (p.starred ? STAR_PEAK_WEIGHT : 1));
    const c = card(pick.l);
    res.json({
      code: c.code, host: c.host, title: c.title, game: c.game, platform: c.platform,
      expiresAt: c.expiresAt,
      momentTs: peak.ts,
      starred: !!peak.starred,
      povCount: new Set(peak.clips.map(u => u.username)).size
    });
  });

  // --- VIEW beacon: the player calls this once when it opens a listed
  // session. Deduped per hashed IP per session per day; only counts listings.
  app.post('/api/public/sessions/:code/view', browseLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code || !isPublic(code)) return res.status(204).end();
    const key = code + ':' + reporterKey(req);
    if (!viewDedupe.has(key)) {
      viewDedupe.set(key, Date.now() + 24 * 60 * 60 * 1000);
      try { stmt.addView.run(code); } catch (err) {}
    }
    res.status(204).end();
  });

  // Mobile listings: hidden here (the mobile server never decides).
  // Child-safety hides on the first report; anything else at 3.
  function reportMobile(res, raw, key, rawReason) {
    const id = raw.slice(MOBILE_PREFIX.length);
    const listing = mobile.mobileListings().find(l => l.id === id);
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id) || !listing) return safeError(res, 404, 'That session isn\'t listed.');
    const reason = REPORT_REASONS.includes(rawReason) ? rawReason : 'other';
    let r;
    try { r = mobile.reportMobileListing(id, key, reason); }
    catch (err) { log('error', 'mobile_report_failed', { id, error: err.message }); return safeError(res, 500, 'Could not send that. Try again.'); }
    res.json({ ok: true });
    log(r.child ? 'warn' : 'info', 'mobile_listing_reported', { id, reports: r.n, hidden: r.hiddenNow, reason });
    if (r.added && (r.hiddenNow || r.n === 1)) {
      postStaffAlert({
        title: r.child ? `Child-safety report (mobile): ${id}` : (r.hiddenNow ? `Mobile listing auto-hidden: ${id}` : `New report (mobile): ${id}`),
        level: r.child ? 'warn' : 'info',
        description: r.child
          ? 'Hidden from /browse and roulette on the first report. Review promptly. If it shows a child being sexually abused or exploited, report to NCMEC; do not download or share it.'
          : `${r.n} report(s). ${r.hiddenNow ? 'Hidden from /browse and roulette.' : 'Still listed; hides at 3 reports.'}`,
        fields: [
          { name: 'Listing', value: id, inline: true },
          { name: 'Host', value: listing.host || '-', inline: true },
          { name: 'Watch', value: listing.watchUrl },
          { name: 'Restore / remove', value: `POST /admin/public/mobile/${id} {"action":"restore"|"hide"}` }
        ]
      }).catch(() => {});
    }
  }

  // --- REPORT from the phone app's Peak feed, relayed by the mobile server
  // (shared secret). Every relay shares the mobile server's IP, so it sends a
  // hashed key per viewer; namespaced so it can never match a web key.
  app.post('/internal/mobile/report', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    const code = String(req.body?.code || '');
    const viewer = String(req.body?.viewerKey || '');
    if (!code.startsWith(MOBILE_PREFIX) || !/^[a-f0-9]{16,64}$/.test(viewer)) return safeError(res, 400, 'Invalid report');
    const key = crypto.createHmac('sha256', String(JWT_SECRET || 'peakabu')).update('mobile-feed:' + viewer).digest('hex').slice(0, 24);
    reportMobile(res, code, key, req.body?.reason);
  });

  // --- REPORT: no account needed.
  app.post('/api/public/sessions/:code/report', reportLimiter, async (req, res) => {
    const raw = String(req.params.code || '');
    if (raw.startsWith(MOBILE_PREFIX)) return reportMobile(res, raw, reporterKey(req), req.body?.reason);
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const row = stmt.get.get(code);
    if (!row) return safeError(res, 404, 'That session isn\'t listed.');
    const session = sessions.get(code);

    const reason = REPORT_REASONS.includes(req.body?.reason) ? req.body.reason : 'other';

    let added = 0, n = 0, autoHidden = false, childHidden = false;
    try {
      added = stmt.addReport.run(code, reporterKey(req), reason, Date.now()).changes;
      n = stmt.countReports.get(code).n;
      // Child-safety reports hide the listing on the FIRST report and go to
      // staff as urgent. Nobody is banned or struck until staff confirm.
      if (reason === 'child' && !row.hidden) {
        stmt.hide.run(code); childHidden = true;
        log('warn', 'public_listing_child_report', { session: code, host: row.listedBy });
      } else if (n >= REPORT_HIDE_THRESHOLD && !row.hidden) {
        stmt.hide.run(code); autoHidden = true;
        log('warn', 'public_listing_auto_hidden', { session: code, reports: n, host: row.listedBy });
      } else {
        log('info', 'public_listing_reported', { session: code, reports: n });
      }
    } catch (err) {
      log('error', 'public_report_failed', { code, error: err.message });
      return safeError(res, 500, 'Could not send that. Try again.');
    }
    res.json({ ok: true });

    // Staff channel: the first report, the auto-hide, and every child-safety
    // hide. Repeat reports in between are counted, not re-posted.
    if (!session || !added) return;
    if (childHidden) {
      mod.sendCase(session, {
        kind: 'report', level: 'urgent',
        title: `Child-safety report: ${code}`,
        trigger: 'User report: involves a minor',
        detail: `${n} report(s) total. Review promptly. If it shows a child being sexually abused or exploited, use the csam action and report to NCMEC; do not download or share it.`,
        actions: ['Listing hidden from /browse and roulette until staff review.']
      }).catch(() => {});
    } else if (autoHidden) {
      mod.sendCase(session, {
        kind: 'autohide', level: 'warn',
        title: `Auto-hidden after ${n} reports: ${code}`,
        trigger: `${n} reports from different people`,
        detail: 'Hidden automatically. Confirm with remove (adds a strike) or restore.',
        actions: ['Listing hidden from /browse and roulette.', 'Host can\'t relist it until staff restore it.']
      }).catch(() => {});
    } else if (n === 1) {
      mod.sendCase(session, {
        kind: 'report', level: 'info',
        title: `New report: ${code}`,
        trigger: 'User report',
        detail: `Reason: ${reason}. Still listed; it hides automatically at ${REPORT_HIDE_THRESHOLD} reports.`,
        actions: []
      }).catch(() => {});
    }
  });

  // --- ADMIN (X-Admin-Secret). Run on the droplet, e.g.:
  //   curl -s localhost:3000/admin/public/reports -H "X-Admin-Secret: $ADMIN_SECRET"
  //   curl -s -X POST localhost:3000/admin/public/ABC123 -H "X-Admin-Secret: $ADMIN_SECRET" \
  //        -H "Content-Type: application/json" -d '{"action":"remove"}'
  //   actions: restore | remove (adds a strike) | csam (hold + ban + urgent case)
  app.get('/admin/public/reports', requireAdmin, (req, res) => {
    res.json({ reports: stmt.reported.all() });
  });

  // Mobile listings: restore after a report, or hide by hand.
  //   curl -s -X POST localhost:3000/admin/public/mobile/ID -H "X-Admin-Secret: $ADMIN_SECRET" \
  //        -H "Content-Type: application/json" -d '{"action":"restore"}'
  app.post('/admin/public/mobile/:id', requireAdmin, (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return safeError(res, 400, 'Invalid id');
    const action = req.body?.action;
    if (action !== 'restore' && action !== 'hide') return safeError(res, 400, 'action must be "restore" or "hide"');
    const r = mobile.setMobileListingHidden(id, action === 'hide');
    if (!r.ok) return safeError(res, 409, r.error);
    log('info', 'mobile_listing_admin_action', { id, action });
    res.json({ ok: true });
  });

  app.post('/admin/public/:code', requireAdmin, async (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const action = req.body?.action;
    const session = sessions.get(code);
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null;

    if (action === 'restore') {
      if (isOnHold(code)) return safeError(res, 409, 'Session is on legal hold. Release the hold first if that was a mistake.');
      stmt.unhide.run(code); stmt.clearReports.run(code);
      mod.clearReviewFlags(code);
      log('info', 'public_admin_action', { session: code, action });
      return res.json({ ok: true, restored: true });
    }
    if (action === 'remove') {
      if (!session) return safeError(res, 404, 'Session not found');
      stmt.hide.run(code);
      const r = mod.addStrike(session.createdBy, code, note || 'Public listing removed by staff', 'staff');
      log('info', 'public_admin_action', { session: code, action, strikes: r.count, banned: r.banned });
      // Keep the staff channel's record complete: every strike, and the ban.
      require('../moderation/staff-alerts').postStaffAlert({
        title: r.banned ? `${session.createdBy} banned from public posting (${r.count} strikes)` : `Strike ${r.count}/${mod.STRIKES_TO_BAN}: ${session.createdBy}`,
        level: r.banned ? 'warn' : 'info',
        fields: [
          { name: 'Session', value: code, inline: true },
          { name: 'Host', value: session.createdBy, inline: true },
          { name: 'Note', value: note || 'Public listing removed by staff' }
        ]
      }).catch(() => {});
      return res.json({ ok: true, host: session.createdBy, strikes: r.count, bannedFromPublic: r.banned || !!mod.getBan(session.createdBy) });
    }
    if (action === 'csam') {
      if (!session) return safeError(res, 404, 'Session not found');
      await mod.handleCsam(session, { trigger: 'Confirmed by staff', detail: note || 'Staff confirmed apparent CSAM', by: 'staff' });
      return res.json({ ok: true, hold: getHold(code), host: session.createdBy });
    }
    return safeError(res, 400, 'action must be "restore", "remove" or "csam"');
  });

  // Strikes / public ban for one account.
  //   GET  /admin/public/users/NAME
  //   POST /admin/public/users/NAME  {"action":"unban"} | {"action":"clear-strikes"} | {"action":"ban","note":"..."}
  app.get('/admin/public/users/:username', requireAdmin, (req, res) => {
    const name = sanitizeUsername(req.params.username);
    if (!name) return safeError(res, 400, 'Invalid username');
    res.json({ username: name, strikes: mod.getStrikes(name), ban: mod.getBan(name), strikesToBan: mod.STRIKES_TO_BAN });
  });

  app.post('/admin/public/users/:username', requireAdmin, (req, res) => {
    const name = sanitizeUsername(req.params.username);
    if (!name) return safeError(res, 400, 'Invalid username');
    const action = req.body?.action;
    if (action === 'unban') res.json({ ok: true, unbanned: mod.unban(name) });
    else if (action === 'clear-strikes') res.json({ ok: true, cleared: mod.clearStrikes(name) });
    else if (action === 'ban') { mod.banFromPublic(name, req.body?.note || 'Banned by staff', 'staff'); res.json({ ok: true }); }
    else return safeError(res, 400, 'action must be "unban", "clear-strikes" or "ban"');
    log('info', 'public_admin_user_action', { username: name, action });
  });

  // Legal holds. Release only if a hold was placed by mistake (a scanner
  // false positive staff have checked) — never after an NCMEC report.
  app.get('/admin/holds', requireAdmin, (req, res) => res.json({ holds: listHolds() }));
  app.post('/admin/holds/:code', requireAdmin, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    if (req.body?.action !== 'release') return safeError(res, 400, 'action must be "release"');
    const released = releaseHold(code);
    log('warn', 'legal_hold_released', { session: code, released });
    res.json({ ok: true, released });
  });

  // Fresh case file for a session, as a PDF download.
  //   curl -s localhost:3000/admin/public/ABC123/case -H "X-Admin-Secret: $ADMIN_SECRET" -o case.pdf
  app.get('/admin/public/:code/case', requireAdmin, (req, res) => {
    const code = sanitizeCode(req.params.code);
    const session = code && sessions.get(code);
    if (!session) return safeError(res, 404, 'Session not found');
    const caseId = mod.newCaseId();
    const pdf = mod.buildCaseFile(session, {
      caseId, kind: 'report', trigger: 'Requested by staff', detail: 'On-demand case file', actions: []
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${caseId}.pdf"`);
    res.send(pdf);
  });
}

module.exports = { initPublicRoutes, startPublicCleanup, isPublic, hostState };
