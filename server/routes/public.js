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
const { sessions } = require('../stores');
const { requireAuth, requireAdmin } = require('../auth');
const db = require('../db');

// --- Tunables ---
const PEAK_GAP_MS = 5000;                       // same clustering rule as the web player
const RECENCY_HALF_LIFE_DAYS = 3;               // roulette weight halves every 3 days
const EXPIRY_GRACE_MS = 60 * 60 * 1000;         // hide sessions expiring within the hour
const REPORT_HIDE_THRESHOLD = 3;                // distinct reporters before auto-hide
const BROWSE_PAGE_MAX = 48;
const SEEN_MAX = 300;                           // roulette "already watched" list cap
const PLATFORMS = ['pc', 'mobile'];

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
  listingCodes: db.prepare(`SELECT sessionCode FROM public_listings UNION SELECT sessionCode FROM public_reports`)
};

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
    if (/^[A-Z0-9]{4,6}\.\d{1,15}$/.test(part)) seen.add(part);
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

    log('info', 'public_toggled', { session: code, isPublic: want, by: session.createdBy });
    res.json({ isPublic: want && isPublic(code) });
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
    const row = stmt.get.get(code);
    res.json({ isPublic: !!row && !row.hidden, underReview: !!row && !!row.hidden });
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

    if (sort === 'popular') list.sort((a, b) => b.row.views - a.row.views || b.row.listedAt - a.row.listedAt);
    else list.sort((a, b) => Date.parse(b.session.createdAt) - Date.parse(a.session.createdAt));

    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      total: list.length,
      games,
      sessions: list.slice(offset, offset + BROWSE_PAGE_MAX).map(card)
    });
  });

  // --- ROULETTE: one random peak from any public session, weighted toward
  // newer sessions. ?seen= is the viewer's already-watched list (kept in
  // their browser); ?last= avoids the same session twice in a row.
  app.get('/api/public/roulette', rouletteLimiter, (req, res) => {
    const now = Date.now();
    const platform = PLATFORMS.includes(req.query.platform) ? req.query.platform : null;
    const seen = parseSeen(req.query.seen);
    const last = sanitizeCode(req.query.last || '');

    let pool = liveListings(now)
      .filter(l => !platform || l.row.platform === platform)
      .map(l => {
        // Roulette only uses peaks with a real coordinated timestamp, so the
        // player can land on exactly the same moment.
        const unseen = l.peaks.filter(p => p.clips.some(c => c.coordinatedTimestamp) &&
          !seen.has(l.session.code + '.' + p.ts));
        return { ...l, unseen, weight: Math.pow(0.5, ageDays(l.session, now) / RECENCY_HALF_LIFE_DAYS) };
      })
      .filter(l => l.unseen.length);

    if (!pool.length) return res.json({ exhausted: true });
    if (pool.length > 1 && last) pool = pool.filter(l => l.session.code !== last);

    const total = pool.reduce((s, l) => s + l.weight, 0);
    let r = crypto.randomInt(1e9) / 1e9 * total;
    let pick = pool[pool.length - 1];
    for (const l of pool) { r -= l.weight; if (r <= 0) { pick = l; break; } }

    const peak = pick.unseen[crypto.randomInt(pick.unseen.length)];
    const c = card(pick);
    res.set('Cache-Control', 'no-store');
    res.json({
      code: c.code, host: c.host, title: c.title, game: c.game, platform: c.platform,
      expiresAt: c.expiresAt,
      momentTs: peak.ts,
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

  // --- REPORT: no account needed.
  app.post('/api/public/sessions/:code/report', reportLimiter, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const row = stmt.get.get(code);
    if (!row) return safeError(res, 404, 'That session isn\'t listed.');

    const reason = typeof req.body?.reason === 'string'
      ? req.body.reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : null;

    try {
      stmt.addReport.run(code, reporterKey(req), reason, Date.now());
      const n = stmt.countReports.get(code).n;
      if (n >= REPORT_HIDE_THRESHOLD && !row.hidden) {
        stmt.hide.run(code);
        log('warn', 'public_listing_auto_hidden', { session: code, reports: n, host: row.listedBy });
      } else {
        log('info', 'public_listing_reported', { session: code, reports: n });
      }
    } catch (err) {
      log('error', 'public_report_failed', { code, error: err.message });
      return safeError(res, 500, 'Could not send that. Try again.');
    }
    res.json({ ok: true });
  });

  // --- ADMIN: review + resolve reports.
  //   curl https://peakabu.app/admin/public/reports -H "X-Admin-Secret: $ADMIN_SECRET"
  //   curl -X POST https://peakabu.app/admin/public/ABC123 -H "X-Admin-Secret: $ADMIN_SECRET" \
  //        -H "Content-Type: application/json" -d '{"action":"restore"}'    (or "remove")
  app.get('/admin/public/reports', requireAdmin, (req, res) => {
    res.json({ reports: stmt.reported.all() });
  });

  app.post('/admin/public/:code', requireAdmin, (req, res) => {
    const code = sanitizeCode(req.params.code);
    if (!code) return safeError(res, 400, 'Invalid session code');
    const action = req.body?.action;
    if (action === 'restore') { stmt.unhide.run(code); stmt.clearReports.run(code); }
    else if (action === 'remove') { stmt.hide.run(code); }
    else return safeError(res, 400, 'action must be "restore" or "remove"');
    log('info', 'public_admin_action', { session: code, action });
    res.json({ ok: true });
  });
}

module.exports = { initPublicRoutes, startPublicCleanup, isPublic };
