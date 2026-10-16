// ================================
// PEAKABU MOBILE — the main server's side of m.peakabu.app.
//
// Mobile runs as its own small server (own port, own data folder). It has
// no accounts of its own: hosts sign in with their Peak-Abu account, and
// the mobile server asks this module two things over a shared secret:
//   - is this account paying for Mobile right now? (getMobileStatus)
//   - claim one of its $3 event passes for a session (claimEventPass)
// It also hands us its public listings, which /browse and Peak Roulette
// merge in (see routes/public.js).
//
// Paying for Mobile = any of:
//   - an active Mobile pass (Stripe 1- or 3-month code, see routes/billing.js)
//   - an active T3 Squad / T4 Pro / T5 Founder plan (Mobile comes included)
//
// Own tables (not users columns) so stores.js's three-place rule for user
// fields doesn't apply — same choice as login-slots.js.
// ================================
const crypto = require('crypto');
const db = require('./db');
const { log } = require('./logger');

// Free mobile hosts: this much live session time per UTC day, enforced by
// the mobile server (it's the one that knows when a session is live).
const MOBILE_FREE_DAILY_SEC = 10 * 60;
// PC plans that include Mobile while they're active.
const MOBILE_INCLUDED_TIERS = ['t3', 't4', 't5'];
const EVENT_MAX_HOURS = 16;

db.exec(`
  CREATE TABLE IF NOT EXISTS mobile_passes (
    usernameLower TEXT PRIMARY KEY,
    expiresAt     INTEGER NOT NULL,
    updatedAt     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_event_passes (
    id            TEXT PRIMARY KEY,
    usernameLower TEXT NOT NULL,
    startsAt      INTEGER NOT NULL,
    endsAt        INTEGER NOT NULL,
    claimedBy     TEXT,
    claimedAt     INTEGER,
    createdAt     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mobile_event_user ON mobile_event_passes(usernameLower);
  CREATE TABLE IF NOT EXISTS mobile_listing_reports (
    listingId   TEXT NOT NULL,
    reporterKey TEXT NOT NULL,
    reason      TEXT,
    createdAt   INTEGER NOT NULL,
    PRIMARY KEY (listingId, reporterKey)
  );
  CREATE TABLE IF NOT EXISTS mobile_listing_hidden (
    listingId TEXT PRIMARY KEY,
    reason    TEXT,
    hiddenAt  INTEGER NOT NULL
  );
`);

const stmt = {
  getPass:     db.prepare(`SELECT * FROM mobile_passes WHERE usernameLower = ?`),
  upsertPass:  db.prepare(`
    INSERT INTO mobile_passes (usernameLower, expiresAt, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(usernameLower) DO UPDATE SET expiresAt = excluded.expiresAt, updatedAt = excluded.updatedAt
  `),
  addEvent:    db.prepare(`
    INSERT INTO mobile_event_passes (id, usernameLower, startsAt, endsAt, createdAt) VALUES (?, ?, ?, ?, ?)
  `),
  eventsFor:   db.prepare(`SELECT * FROM mobile_event_passes WHERE usernameLower = ? AND endsAt > ? ORDER BY startsAt ASC`),
  getEvent:    db.prepare(`SELECT * FROM mobile_event_passes WHERE id = ?`),
  claimEvent:  db.prepare(`UPDATE mobile_event_passes SET claimedBy = ?, claimedAt = ? WHERE id = ? AND (claimedBy IS NULL OR claimedBy = ?)`),
  dropOldEvents: db.prepare(`DELETE FROM mobile_event_passes WHERE endsAt < ?`),

  addReport:   db.prepare(`INSERT OR IGNORE INTO mobile_listing_reports (listingId, reporterKey, reason, createdAt) VALUES (?, ?, ?, ?)`),
  countReports: db.prepare(`SELECT COUNT(*) AS n FROM mobile_listing_reports WHERE listingId = ?`),
  clearReports: db.prepare(`DELETE FROM mobile_listing_reports WHERE listingId = ?`),
  hide:        db.prepare(`INSERT OR IGNORE INTO mobile_listing_hidden (listingId, reason, hiddenAt) VALUES (?, ?, ?)`),
  unhide:      db.prepare(`DELETE FROM mobile_listing_hidden WHERE listingId = ?`),
  isHidden:    db.prepare(`SELECT 1 FROM mobile_listing_hidden WHERE listingId = ?`),
  hiddenAll:   db.prepare(`SELECT listingId FROM mobile_listing_hidden`)
};

// --- Passes ---------------------------------------------------------------

// Bought time stacks: a 1-month code on top of an active pass adds 30 days
// to the end of it. (Unlike PC tier codes, these are always paid for, one
// per Stripe purchase, so there's no chaining abuse to stop.)
function grantMobileDays(usernameLower, days) {
  const now = Date.now();
  const row = stmt.getPass.get(usernameLower);
  const base = row && row.expiresAt > now ? row.expiresAt : now;
  const expiresAt = base + days * 86400000;
  stmt.upsertPass.run(usernameLower, expiresAt, now);
  log('info', 'mobile_pass_granted', { username: usernameLower, days, expiresAt });
  return expiresAt;
}

function addEventPass(usernameLower, startsAt, hours) {
  const h = Math.max(0.5, Math.min(EVENT_MAX_HOURS, Number(hours) || 0));
  const id = crypto.randomBytes(8).toString('base64url');
  const endsAt = startsAt + Math.round(h * 3600000);
  stmt.addEvent.run(id, usernameLower, startsAt, endsAt, Date.now());
  log('info', 'mobile_event_pass_granted', { username: usernameLower, id, startsAt, endsAt });
  return { id, startsAt, endsAt };
}

// effectiveTier comes from auth.getEffectiveTier (passed in to avoid a
// require cycle with auth.js).
function getMobileStatus(user, effectiveTier) {
  const now = Date.now();
  const lower = user ? user.username.toLowerCase() : '';
  const row = lower ? stmt.getPass.get(lower) : null;
  const passUntil = row && row.expiresAt > now ? row.expiresAt : null;
  const viaTier = MOBILE_INCLUDED_TIERS.includes(effectiveTier);
  let events = [];
  try { events = lower ? stmt.eventsFor.all(lower, now) : []; } catch (e) {}
  return {
    username: user ? user.username : null,
    paying: !!passUntil || viaTier,
    source: passUntil ? 'pass' : (viaTier ? 'plan' : 'free'),
    passExpiresAt: passUntil,
    tier: effectiveTier,
    planExpiresAt: viaTier ? (user.tierExpiresAt || null) : null,
    freeDailySec: MOBILE_FREE_DAILY_SEC,
    events: events.map(e => ({ id: e.id, startsAt: e.startsAt, endsAt: e.endsAt, claimedBy: e.claimedBy || null }))
  };
}

// One pass = one session. Re-claiming for the same session is fine (the
// mobile server may retry); a different session is refused.
function claimEventPass(usernameLower, id, sessionId) {
  const row = stmt.getEvent.get(id);
  if (!row || row.usernameLower !== usernameLower) return { ok: false, error: 'That event pass isn\'t on this account.' };
  if (row.endsAt <= Date.now()) return { ok: false, error: 'That event pass has already ended.' };
  const changed = stmt.claimEvent.run(sessionId, Date.now(), id, sessionId).changes;
  if (!changed) return { ok: false, error: 'That event pass is already used by another session.' };
  return { ok: true, startsAt: row.startsAt, endsAt: row.endsAt };
}

// --- Public listings from the mobile server --------------------------------
// The mobile server lists what its hosts switched public. We poll it once a
// minute and keep the last good copy, so /browse never waits on it.
const MOBILE_API_URL = (process.env.MOBILE_API_URL || '').replace(/\/$/, '');
const MOBILE_SHARED_SECRET = process.env.MOBILE_SHARED_SECRET || '';
let listingCache = [];
let listingFetchedAt = 0;

async function refreshMobileListings() {
  if (!MOBILE_API_URL || !MOBILE_SHARED_SECRET) return;
  try {
    const res = await fetch(MOBILE_API_URL + '/api/public/listings', {
      headers: { 'X-Mobile-Secret': MOBILE_SHARED_SECRET },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (Array.isArray(data.listings)) {
      listingCache = data.listings.filter(validListing);
      listingFetchedAt = Date.now();
    }
  } catch (err) {
    log('warn', 'mobile_listings_fetch_failed', { error: err.message });
  }
}

function validListing(l) {
  return l && typeof l.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(l.id) &&
    typeof l.watchUrl === 'string' && /^https?:\/\//.test(l.watchUrl) &&
    Array.isArray(l.peaks);
}

function startMobileListingSync() {
  if (!MOBILE_API_URL || !MOBILE_SHARED_SECRET) {
    console.warn('Mobile listings disabled: MOBILE_API_URL / MOBILE_SHARED_SECRET not set in .env');
    return;
  }
  refreshMobileListings();
  setInterval(refreshMobileListings, 60 * 1000);
  setInterval(() => { try { stmt.dropOldEvents.run(Date.now() - 30 * 86400000); } catch (e) {} }, 6 * 60 * 60 * 1000);
}

// Listings minus anything hidden by reports or staff, and anything we
// haven't heard about in 5 minutes (mobile server down = nothing stale).
function mobileListings() {
  if (Date.now() - listingFetchedAt > 5 * 60 * 1000) return [];
  let hidden = new Set();
  try { hidden = new Set(stmt.hiddenAll.all().map(r => r.listingId)); } catch (e) {}
  return listingCache.filter(l => !hidden.has(l.id));
}

// Report: child-safety hides on the first report, anything else at 3.
// Returns { added, n, hiddenNow, child } for the caller's staff alert.
function reportMobileListing(listingId, reporterKey, reason) {
  const added = stmt.addReport.run(listingId, reporterKey, reason, Date.now()).changes;
  const n = stmt.countReports.get(listingId).n;
  const already = !!stmt.isHidden.get(listingId);
  let hiddenNow = false;
  if (!already && (reason === 'child' || n >= 3)) {
    stmt.hide.run(listingId, reason === 'child' ? 'child-report' : 'reports', Date.now());
    hiddenNow = true;
  }
  return { added, n, hiddenNow, child: reason === 'child' };
}

function setMobileListingHidden(listingId, hidden) {
  if (hidden) stmt.hide.run(listingId, 'staff', Date.now());
  else { stmt.unhide.run(listingId); stmt.clearReports.run(listingId); }
}

function mobileSecretOk(req) {
  const got = req.headers['x-mobile-secret'];
  if (!MOBILE_SHARED_SECRET || typeof got !== 'string' || got.length !== MOBILE_SHARED_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(MOBILE_SHARED_SECRET));
}

module.exports = {
  MOBILE_FREE_DAILY_SEC, MOBILE_INCLUDED_TIERS, EVENT_MAX_HOURS,
  grantMobileDays, addEventPass, getMobileStatus, claimEventPass,
  startMobileListingSync, mobileListings, reportMobileListing, setMobileListingHidden, mobileSecretOk
};
