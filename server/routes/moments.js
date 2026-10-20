// ================================
// PEAK MOMENTS — upvotes on public Peakabu Mobile Peaks.
//
// One Peak Moment per signed-in account per Peak. They make a Peak (and its
// session) come up more often in Peak Roulette and in the phone app's Peak
// feed, with diminishing returns so one viral Peak can't take over forever.
//
// Votes are given through POST /api/public/moments with the account's own
// login token. The phone app sends them through the mobile server, which
// passes the token along (it never holds it beyond the request).
//
// The feed itself is picked here, not on the mobile server: this server is
// the one that knows what moderation has cleared (scans, reports, bans), so
// the mobile server asks /internal/mobile/feed which Peaks to show and only
// adds its own video links.
//
// Own table, no FK (a listing lives on the mobile server); the hourly sweep
// drops votes whose listing is gone.
// ================================
const crypto = require('crypto');
const { log } = require('../logger');
const { sanitizeUsername, safeError } = require('../utils');
const { requireAuth } = require('../auth');
const db = require('../db');
const mobile = require('../mobile');

const MOBILE_PREFIX = 'm-';
const RECENCY_HALF_LIFE_DAYS = 3;   // same as roulette
const FEED_MAX = 8;                 // Peaks per feed request
const SEEN_MAX = 300;
const VOTES_PER_MIN = 60;           // per account

db.exec(`
  CREATE TABLE IF NOT EXISTS peak_moments (
    listingCode TEXT NOT NULL,
    peakId      TEXT NOT NULL,
    username    TEXT NOT NULL,
    createdAt   INTEGER NOT NULL,
    PRIMARY KEY (listingCode, peakId, username)
  );
  CREATE INDEX IF NOT EXISTS peak_moments_by_listing ON peak_moments (listingCode);
`);

const stmt = {
  add:      db.prepare(`INSERT OR IGNORE INTO peak_moments (listingCode, peakId, username, createdAt) VALUES (?, ?, ?, ?)`),
  remove:   db.prepare(`DELETE FROM peak_moments WHERE listingCode = ? AND peakId = ? AND username = ?`),
  countOne: db.prepare(`SELECT COUNT(*) AS n FROM peak_moments WHERE listingCode = ? AND peakId = ?`),
  counts:   db.prepare(`SELECT listingCode, peakId, COUNT(*) AS n FROM peak_moments GROUP BY listingCode, peakId`),
  mine:     db.prepare(`SELECT listingCode, peakId FROM peak_moments WHERE username = ?`),
  codes:    db.prepare(`SELECT DISTINCT listingCode FROM peak_moments`),
  dropCode: db.prepare(`DELETE FROM peak_moments WHERE listingCode = ?`)
};

// How much more likely a Peak is to come up: 1 with no votes, ~2.4 with 1,
// ~5.8 with 10, ~8.9 with 50.
const momentWeight = (n) => 1 + 2 * Math.log(1 + (n || 0));

// "m-<listing>" -> { peakId -> count }, read once per request.
function momentCounts() {
  const map = new Map();
  try {
    for (const r of stmt.counts.all()) {
      if (!map.has(r.listingCode)) map.set(r.listingCode, new Map());
      map.get(r.listingCode).set(r.peakId, r.n);
    }
  } catch (err) { log('warn', 'moments_count_failed', { error: err.message }); }
  return map;
}
function mineSet(username) {
  const u = sanitizeUsername(username);
  if (!u) return new Set();
  try { return new Set(stmt.mine.all(u).map(r => r.listingCode + '.' + r.peakId)); } catch (e) { return new Set(); }
}

// Same "already watched" format as roulette: "m-<id>.<peak time>".
function parseSeen(raw) {
  const seen = new Set();
  if (typeof raw !== 'string' || !raw) return seen;
  for (const part of raw.split(',').slice(0, SEEN_MAX)) {
    if (/^m-[A-Za-z0-9_-]{4,32}\.\d{1,15}$/.test(part)) seen.add(part);
  }
  return seen;
}

const rand = () => crypto.randomInt(1e9) / 1e9;
function weightedPick(items, weightOf) {
  const total = items.reduce((s, x) => s + weightOf(x), 0);
  let r = rand() * total;
  for (const x of items) { r -= weightOf(x); if (r <= 0) return x; }
  return items[items.length - 1];
}

// Weight for a mobile listing in roulette and the feed: recency (halves every
// 3 days), boosted by the Peak Moments on the Peaks the viewer hasn't seen.
function listingWeight(l, unseen, counts, now) {
  const age = Math.max(0, (now - (l.createdAt || now)) / 86400000);
  const byPeak = counts.get(MOBILE_PREFIX + l.id);
  const votes = byPeak ? unseen.reduce((s, p) => s + (byPeak.get(p.id) || 0), 0) : 0;
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_DAYS) * (1 + Math.log(1 + votes));
}
function pickPeak(l, unseen, counts) {
  const byPeak = counts.get(MOBILE_PREFIX + l.id);
  return weightedPick(unseen, p => momentWeight(byPeak && byPeak.get(p.id)));
}

// Up to n Peaks for the feed, weighted, no repeats, and not the same session
// twice in a row while there's a choice.
function feedPicks({ seen, n, last, now = Date.now() }) {
  const counts = momentCounts();
  let pool = mobile.mobileListings().map(l => ({
    l, key: MOBILE_PREFIX + l.id,
    unseen: l.peaks.filter(p => Number.isFinite(p.t) && !seen.has(MOBILE_PREFIX + l.id + '.' + p.t))
  })).filter(x => x.unseen.length);
  const out = [];
  while (out.length < n && pool.length) {
    const choices = pool.length > 1 && last ? pool.filter(x => x.key !== last) : pool;
    const pick = weightedPick(choices, x => listingWeight(x.l, x.unseen, counts, now));
    const peak = pickPeak(pick.l, pick.unseen, counts);
    out.push({ id: pick.l.id, peakId: peak.id, t: peak.t });
    pick.unseen = pick.unseen.filter(p => p !== peak);
    if (!pick.unseen.length) pool = pool.filter(x => x !== pick);
    last = pick.key;
  }
  return out;
}

// Votes come through the mobile server, so they share its IP: limit per account.
const voteHits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of voteHits) if (now > v.reset) voteHits.delete(k); }, 5 * 60 * 1000);
function voteAllowed(username) {
  const now = Date.now();
  let e = voteHits.get(username);
  if (!e || now > e.reset) { e = { n: 0, reset: now + 60000 }; voteHits.set(username, e); }
  return ++e.n <= VOTES_PER_MIN;
}

function annotate(list, username) {
  const counts = momentCounts();
  const mine = mineSet(username);
  return list.map(x => {
    const code = MOBILE_PREFIX + x.id;
    return { ...x, moments: (counts.get(code) && counts.get(code).get(x.peakId)) || 0, mine: mine.has(code + '.' + x.peakId) };
  });
}

function initMomentRoutes(app) {
  // --- Give or take back a Peak Moment. { code: "m-<listing>", peakId, on }
  app.post('/api/public/moments', requireAuth, (req, res) => {
    const username = sanitizeUsername(req.user && req.user.username);
    if (!username) return safeError(res, 401, 'Sign in to give Peak Moments.');
    if (!voteAllowed(username)) return safeError(res, 429, 'Too many Peak Moments at once. Try again in a minute.');
    const code = String(req.body?.code || '');
    const peakId = String(req.body?.peakId || '');
    if (!code.startsWith(MOBILE_PREFIX) || !/^[A-Za-z0-9_-]{4,32}$/.test(peakId)) return safeError(res, 400, 'Invalid Peak');
    const listing = mobile.mobileListings().find(l => MOBILE_PREFIX + l.id === code);
    if (!listing || !listing.peaks.some(p => p.id === peakId)) return safeError(res, 404, 'That Peak isn\'t public any more.');
    try {
      if (req.body?.on === false) stmt.remove.run(code, peakId, username);
      else stmt.add.run(code, peakId, username, Date.now());
      res.json({ count: stmt.countOne.get(code, peakId).n, mine: req.body?.on !== false });
    } catch (err) {
      log('error', 'moment_vote_failed', { code, error: err.message });
      safeError(res, 500, 'Could not save that. Try again.');
    }
  });

  // --- The phone app's feed (mobile server only, shared secret).
  //   ?n=8 &seen=m-id.t,... &last=m-id &user=<username for "mine">
  //   ?session=m-<id>  every Peak of one listing, oldest first
  app.get('/internal/mobile/feed', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    res.set('Cache-Control', 'no-store');
    const user = typeof req.query.user === 'string' ? req.query.user : '';
    const one = typeof req.query.session === 'string' ? req.query.session : '';
    if (one) {
      const l = mobile.mobileListings().find(x => MOBILE_PREFIX + x.id === one);
      if (!l) return res.json({ peaks: [], gone: true });
      const peaks = l.peaks.filter(p => Number.isFinite(p.t)).sort((a, b) => a.t - b.t).map(p => ({ id: l.id, peakId: p.id, t: p.t }));
      return res.json({ peaks: annotate(peaks, user) });
    }
    const n = Math.max(1, Math.min(FEED_MAX, parseInt(req.query.n, 10) || FEED_MAX));
    const last = typeof req.query.last === 'string' ? req.query.last.slice(0, 40) : '';
    const picks = feedPicks({ seen: parseSeen(req.query.seen), n, last });
    res.json({ peaks: annotate(picks, user), exhausted: !picks.length });
  });

  // --- Public sessions for "Pick a session" (mobile server only).
  app.get('/internal/mobile/feed/sessions', (req, res) => {
    if (!mobile.mobileSecretOk(req)) return safeError(res, 403, 'Forbidden');
    res.set('Cache-Control', 'no-store');
    const counts = momentCounts();
    const list = mobile.mobileListings().filter(l => l.peaks.length).map(l => {
      const byPeak = counts.get(MOBILE_PREFIX + l.id);
      let moments = 0;
      if (byPeak) for (const p of l.peaks) moments += byPeak.get(p.id) || 0;
      return { id: l.id, peaks: l.peaks.length, moments, createdAt: l.createdAt || 0 };
    }).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ sessions: list });
  });
}

// Hourly: drop votes for listings that are gone for good (session expired or
// unlisted). Only when the mobile listing cache is fresh, so a slow mobile
// server never wipes votes.
function startMomentCleanup() {
  setInterval(() => {
    try {
      const ids = mobile.allMobileListingIds();
      if (!ids || !ids.length) return;
      const keep = new Set(ids.map(id => MOBILE_PREFIX + id));
      let dropped = 0;
      for (const { listingCode } of stmt.codes.all()) {
        if (!keep.has(listingCode)) dropped += stmt.dropCode.run(listingCode).changes;
      }
      if (dropped) log('info', 'peak_moments_purged', { votes: dropped });
    } catch (err) { log('warn', 'peak_moments_purge_failed', { error: err.message }); }
  }, 60 * 60 * 1000);
}

module.exports = { initMomentRoutes, startMomentCleanup, momentCounts, momentWeight, listingWeight, pickPeak };
