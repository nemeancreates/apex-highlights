// ================================
// PEAKABU MOBILE — the main server's side of m.peakabu.app.
//
// Mobile runs as its own small server (own port, own data folder). It has
// no accounts of its own: hosts sign in with their Peakabu account, and
// the mobile server asks this module two things over a shared secret:
//   - is this account paying for Mobile right now? (getMobileStatus)
//   - claim one of its $3 event passes for a session (claimEventPass)
// It also hands us its public listings, which /browse and Peak Roulette
// merge in (see routes/public.js). A mobile listing goes through the SAME
// scanners as PC footage (moderation/scanner.js: CSAM hash match + content
// classifier) on every clip thumbnail and photo, and only shows once all of
// it is clean. New footage puts it back to "checking" until that's scanned.
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
const { TESTING } = require('./config');

// Free mobile hosts: this much live session time per UTC day, enforced by
// the mobile server (it's the one that knows when a session is live).
const MOBILE_FREE_DAILY_SEC = 10 * 60;
// PC plans that include Mobile while they're active.
// t6 is the testing-phase tier (config.js TESTING): Mobile is free for everyone then.
const MOBILE_INCLUDED_TIERS = ['t3', 't4', 't5', 't6'];
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
  -- Shared with moderation/index.js (same schema). Created here too because
  -- this file can load first, and its statements are prepared at load.
  CREATE TABLE IF NOT EXISTS moderation_scans (
    uploadId    TEXT PRIMARY KEY,
    sessionCode TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    detail      TEXT,
    scannedAt   INTEGER NOT NULL
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
  scansFor:    db.prepare(`SELECT uploadId, verdict, detail FROM moderation_scans WHERE sessionCode = ?`),
  putScan:     db.prepare(`
    INSERT INTO moderation_scans (uploadId, sessionCode, verdict, detail, scannedAt)
    VALUES (@uploadId, @sessionCode, @verdict, @detail, @scannedAt)
    ON CONFLICT(uploadId) DO UPDATE SET verdict = excluded.verdict, detail = excluded.detail, scannedAt = excluded.scannedAt
  `),
  clearReview: db.prepare(`UPDATE moderation_scans SET verdict = 'cleared', detail = COALESCE(detail, '') || ' (cleared by staff)' WHERE sessionCode = ? AND verdict = 'review'`),
  hasCsam:     db.prepare(`SELECT 1 FROM moderation_scans WHERE sessionCode = ? AND verdict = 'csam' LIMIT 1`),
  mobileScanCodes: db.prepare(`SELECT DISTINCT sessionCode FROM moderation_scans WHERE sessionCode LIKE 'm-%'`),
  dropScans:   db.prepare(`DELETE FROM moderation_scans WHERE sessionCode = ?`),
  getHidden:   db.prepare(`SELECT * FROM mobile_listing_hidden WHERE listingId = ?`),
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

// effectiveTier / planExpiresAt come from auth.getEffectiveTier and
// auth.getTierExpiresAt (passed in to avoid a require cycle with auth.js).
function getMobileStatus(user, effectiveTier, planExpiresAt) {
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
    planExpiresAt: viaTier ? (planExpiresAt === undefined ? (user.tierExpiresAt || null) : planExpiresAt) : null,
    // Testing phase: everything is free, event passes included (the mobile
    // server reads this to let any signed-in host run an event without a pass).
    testing: TESTING.enabled,
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
// minute, keep the last good copy (so /browse never waits on it), and scan
// any new media straight after.
const MOBILE_API_URL = (process.env.MOBILE_API_URL || '').replace(/\/$/, '');
const MOBILE_SHARED_SECRET = process.env.MOBILE_SHARED_SECRET || '';
const PREFIX = 'm-';
let listingCache = [];
let listingFetchedAt = 0;

// Lazy: moderation/ requires auth.js, which requires this file.
const mod = () => require('./moderation');
const scanner = () => require('./moderation/scanner');

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
  await scanMobileListings();
}

// One host's Peakabu Mobile sessions for /account. Empty (not an error) when
// the mobile server is off or slow, so the desktop sessions still show.
async function hostedMobileSessions(username) {
  if (!MOBILE_API_URL || !MOBILE_SHARED_SECRET || !username) return [];
  try {
    const res = await fetch(MOBILE_API_URL + '/api/internal/hosted?username=' + encodeURIComponent(username), {
      headers: { 'X-Mobile-Secret': MOBILE_SHARED_SECRET },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data.sessions) ? data.sessions.filter(s => s && typeof s.id === 'string' &&
      typeof s.watchUrl === 'string' && /^https?:\/\//.test(s.watchUrl)) : [];
  } catch (err) {
    log('warn', 'mobile_hosted_fetch_failed', { error: err.message });
    return [];
  }
}

function validListing(l) {
  return l && typeof l.id === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(l.id) &&
    typeof l.watchUrl === 'string' && /^https?:\/\//.test(l.watchUrl) &&
    Array.isArray(l.peaks) && Array.isArray(l.media);
}

// Every clip thumbnail and photo in the listing is one scan item.
//   'clean'   every item passed (or no scanner is configured, same as PC)
//   'pending' something isn't scanned yet (incl. a clip with no thumbnail yet)
//   'flagged' anything came back csam or review
function listingScanState(l) {
  const conf = scanner().scannerConfigured();
  const byId = new Map(stmt.scansFor.all(PREFIX + l.id).map(r => [r.uploadId, r]));
  let pending = false;
  for (const m of l.media) {
    const r = byId.get(itemKey(l, m));
    if (r && (r.verdict === 'csam' || r.verdict === 'review')) return 'flagged';
    if (!r && (conf.hashMatch || conf.classifier)) pending = true;
  }
  return pending ? 'pending' : 'clean';
}
const itemKey = (l, m) => `${PREFIX}${l.id}:${m.id}`;

let scanBusy = false;
async function scanMobileListings() {
  const conf = scanner().scannerConfigured();
  if (scanBusy || (!conf.hashMatch && !conf.classifier)) return;
  scanBusy = true;
  try {
    for (const l of listingCache) {
      const code = PREFIX + l.id;
      if (stmt.hasCsam.get(code)) continue;            // already on the CSAM path
      const done = new Set(stmt.scansFor.all(code).map(r => r.uploadId));
      let worst = null;
      for (const m of l.media) {
        if (done.has(itemKey(l, m)) || !m.url) continue;   // no thumbnail yet: next pass
        // The mobile server serves these through m.peakabu.app, which sits
        // behind Cloudflare, so the same URL is what the CSAM tool sees.
        const r = await scanner().scanImage({ url: m.url, scanUrl: process.env.MOBILE_CSAM_SCAN === '1' ? m.url : null });
        if (r.verdict === 'unscanned') continue;
        stmt.putScan.run({ uploadId: itemKey(l, m), sessionCode: code, verdict: r.verdict, detail: r.detail, scannedAt: Date.now() });
        if (r.verdict === 'csam') { worst = { verdict: 'csam', item: m, detail: r.detail }; break; }
        if (r.verdict === 'review' && !worst) worst = { verdict: 'review', item: m, detail: r.detail };
      }
      if (worst) await actOnFlag(l, worst);
    }
  } catch (err) {
    log('warn', 'mobile_scan_failed', { error: err.message });
  } finally {
    scanBusy = false;
  }
}

// Same outcomes as PC (moderation/index.js handleCsam / scan-review):
//   csam   -> hidden, host banned from public posting, legal hold on the
//             mobile server (kept past retention, hidden from everyone),
//             urgent staff alert
//   review -> hidden pending staff review, staff alert; nobody is banned
async function actOnFlag(l, worst) {
  const code = PREFIX + l.id;
  if (worst.verdict === 'csam') {
    stmt.hide.run(l.id, 'csam', Date.now());
    if (l.host) mod().banFromPublic(l.host, 'Apparent CSAM (Peakabu Mobile)', 'scanner');
    let held = false;
    try {
      const r = await fetch(`${MOBILE_API_URL}/api/internal/hold/${encodeURIComponent(l.id)}`, {
        method: 'POST', headers: { 'X-Mobile-Secret': MOBILE_SHARED_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Apparent CSAM: automated scan' }), signal: AbortSignal.timeout(8000)
      });
      held = r.ok;
    } catch (e) {}
    log('warn', 'mobile_csam_flag', { listing: l.id, host: l.host, held });
    await require('./moderation/staff-alerts').postStaffAlert({
      title: `URGENT: apparent CSAM in Peakabu Mobile session ${l.id}`,
      level: 'urgent',
      description: `${worst.detail} (${worst.item.kind} ${worst.item.id}). Do not download or share it. Report to NCMEC: https://report.cybertip.org/`,
      fields: [
        { name: 'Session', value: l.id, inline: true },
        { name: 'Host', value: l.host || '-', inline: true },
        { name: 'Legal hold', value: held ? 'Placed on the mobile server: kept past retention, hidden from everyone.' : 'FAILED to reach the mobile server. Place it by hand.' },
        { name: 'Actions taken', value: 'Listing removed from /browse and roulette. Host banned from public posting.' }
      ]
    }).catch(() => {});
  } else {
    stmt.hide.run(l.id, 'scan-review', Date.now());
    log('warn', 'mobile_scan_review', { listing: l.id, host: l.host });
    await require('./moderation/staff-alerts').postStaffAlert({
      title: `Scan flagged Peakabu Mobile session ${l.id} for review`,
      level: 'warn',
      description: `${worst.detail} (${worst.item.kind} ${worst.item.id}). Hidden from /browse and roulette pending staff review.`,
      fields: [
        { name: 'Watch', value: l.watchUrl },
        { name: 'Host', value: l.host || '-', inline: true },
        { name: 'Restore', value: `POST /admin/public/mobile/${l.id} {"action":"restore"}` }
      ]
    }).catch(() => {});
  }
}

function startMobileListingSync() {
  if (!MOBILE_API_URL || !MOBILE_SHARED_SECRET) {
    console.warn('Mobile listings disabled: MOBILE_API_URL / MOBILE_SHARED_SECRET not set in .env');
    return;
  }
  refreshMobileListings();
  setInterval(refreshMobileListings, 60 * 1000);
  setInterval(() => {
    try { stmt.dropOldEvents.run(Date.now() - 30 * 86400000); } catch (e) {}
    // Drop scan rows for listings that are gone (unlisted or expired),
    // except anything that hit the CSAM path, which is kept as evidence.
    try {
      if (Date.now() - listingFetchedAt > 5 * 60 * 1000) return;
      const live = new Set(listingCache.map(l => PREFIX + l.id));
      for (const { sessionCode } of stmt.mobileScanCodes.all()) {
        if (!live.has(sessionCode) && !stmt.hasCsam.get(sessionCode)) stmt.dropScans.run(sessionCode);
      }
    } catch (e) {}
  }, 6 * 60 * 60 * 1000);
}

// What /browse and roulette may show: not hidden, host not banned from public
// posting, and every piece of media scanned clean. Nothing stale if the
// mobile server hasn't answered in 5 minutes.
function mobileListings() {
  if (Date.now() - listingFetchedAt > 5 * 60 * 1000) return [];
  let hidden = new Set();
  try { hidden = new Set(stmt.hiddenAll.all().map(r => r.listingId)); } catch (e) {}
  const deletion = require('./account-deletion');
  return listingCache.filter(l => !hidden.has(l.id) &&
    !(l.host && mod().getBan(l.host)) &&
    !(l.host && deletion.pendingDeletion(l.host)) &&
    listingScanState(l) === 'clean');
}

// Every listing the mobile server sent (cleared or not), or null when that
// list is stale. Peak Moments' cleanup uses it so votes survive a re-scan.
function allMobileListingIds() {
  if (Date.now() - listingFetchedAt > 5 * 60 * 1000) return null;
  return listingCache.map(l => l.id);
}

// For the mobile host page's switch: 'off' | 'checking' | 'live' | 'under-review'
function mobileListingState(id) {
  const l = listingCache.find(x => x.id === id);
  const h = stmt.getHidden.get(id);
  if (h) return 'under-review';
  if (!l) return 'checking';                     // switched on, not polled yet
  if (l.host && mod().getBan(l.host)) return 'under-review';
  const st = listingScanState(l);
  return st === 'clean' ? 'live' : st === 'pending' ? 'checking' : 'under-review';
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

// Staff. Restore never overrides a CSAM verdict (same rule as PC legal holds).
function setMobileListingHidden(listingId, hidden) {
  if (hidden) { stmt.hide.run(listingId, 'staff', Date.now()); return { ok: true }; }
  if (stmt.hasCsam.get(PREFIX + listingId)) return { ok: false, error: 'A scan matched known CSAM for this session. It stays hidden.' };
  stmt.unhide.run(listingId);
  stmt.clearReports.run(listingId);
  stmt.clearReview.run(PREFIX + listingId);
  return { ok: true };
}

function mobileSecretOk(req) {
  const got = req.headers['x-mobile-secret'];
  if (!MOBILE_SHARED_SECRET || typeof got !== 'string' || got.length !== MOBILE_SHARED_SECRET.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(MOBILE_SHARED_SECRET));
}

module.exports = {
  MOBILE_FREE_DAILY_SEC, MOBILE_INCLUDED_TIERS, EVENT_MAX_HOURS,
  grantMobileDays, addEventPass, getMobileStatus, claimEventPass,
  startMobileListingSync, mobileListings, allMobileListingIds, hostedMobileSessions, mobileListingState, reportMobileListing, setMobileListingHidden, mobileSecretOk,
  _refreshForTest: refreshMobileListings
};
