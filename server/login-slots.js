// ================================
// LOGIN SLOTS — where one account can be signed in at once.
//
// One slot per PLATFORM: the desktop app ('pc'), Peakabu Mobile ('mobile')
// and the website / web player in a browser ('web'). An account can be
// signed in on all three at the same time. Signing in again on the SAME
// platform (a second PC, a new phone) replaces that platform's slot, so
// only the older login on that platform is signed out.
//
// Each login carries its slot id (the `sid` claim in the JWT).
// tokenVersion still means "sign out everywhere": a password reset bumps
// it, which kills every token whatever its slot.
//
// Tokens minted before slots existed have no sid. They stay valid until the
// account's first slot login, which bumps tokenVersion once to retire them.
// Slots saved before platforms existed (platform NULL) count as 'legacy':
// they keep working until the account has more than one slot per platform
// in total, then the oldest go first.
//
// Its own table (not a users column) so stores.js's three-place rule for
// user fields doesn't apply. Depends only on db.js.
// ================================
const crypto = require('crypto');
const db = require('./db');

const PLATFORMS = ['pc', 'mobile', 'web'];
const MAX_LOGINS = PLATFORMS.length;

db.exec(`
  CREATE TABLE IF NOT EXISTS login_slots (
    sid           TEXT PRIMARY KEY,
    usernameLower TEXT NOT NULL,
    createdAt     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_slots_user ON login_slots(usernameLower);
`);
// Migration: platform + lastSeenAt columns for existing databases.
const slotCols = db.prepare(`PRAGMA table_info(login_slots)`).all().map(c => c.name);
if (!slotCols.includes('platform'))   db.exec(`ALTER TABLE login_slots ADD COLUMN platform TEXT`);
if (!slotCols.includes('lastSeenAt')) db.exec(`ALTER TABLE login_slots ADD COLUMN lastSeenAt INTEGER`);

const stmt = {
  all:     db.prepare(`SELECT * FROM login_slots ORDER BY createdAt ASC`),
  insert:  db.prepare(`INSERT INTO login_slots (sid, usernameLower, createdAt, platform, lastSeenAt) VALUES (?, ?, ?, ?, ?)`),
  remove:  db.prepare(`DELETE FROM login_slots WHERE sid = ?`),
  clear:   db.prepare(`DELETE FROM login_slots WHERE usernameLower = ?`),
  seen:    db.prepare(`UPDATE login_slots SET lastSeenAt = ? WHERE sid = ?`)
};

// usernameLower -> [{ sid, createdAt, platform, lastSeenAt }] oldest first.
// Checked on every authenticated request, so it lives in memory; the table
// is the backup.
const slots = new Map();
try {
  for (const r of stmt.all.all()) {
    if (!slots.has(r.usernameLower)) slots.set(r.usernameLower, []);
    slots.get(r.usernameLower).push({
      sid: r.sid, createdAt: r.createdAt,
      platform: PLATFORMS.includes(r.platform) ? r.platform : 'legacy',
      lastSeenAt: r.lastSeenAt || r.createdAt
    });
  }
} catch (e) {}

// Which platform a login request comes from. Clients send it explicitly;
// older clients don't, so fall back to the user agent: Electron = the
// desktop app, a phone browser = mobile, anything else = the website.
function platformFor(req) {
  const asked = String((req.body && req.body.platform) || '').toLowerCase();
  if (PLATFORMS.includes(asked)) return asked;
  const ua = String(req.headers['user-agent'] || '');
  if (/Electron/i.test(ua)) return 'pc';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
  return 'web';
}

function hasSlots(usernameLower) {
  return (slots.get(usernameLower) || []).length > 0;
}

function isActive(usernameLower, sid) {
  const s = (slots.get(usernameLower) || []).find(x => x.sid === sid);
  if (!s) return false;
  // lastSeenAt is for the account page's device list only; write it at
  // most once every 10 minutes per slot so auth checks stay cheap.
  const now = Date.now();
  if (now - (s.lastSeenAt || 0) > 10 * 60 * 1000) {
    s.lastSeenAt = now;
    try { stmt.seen.run(now, sid); } catch (e) {}
  }
  return true;
}

// New slot for a fresh login on `platform`. Any older slot on the same
// platform is signed out. Returns { sid, evicted: [sid…] }.
function openSlot(usernameLower, platform) {
  const pl = PLATFORMS.includes(platform) ? platform : 'web';
  const sid = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  let list = (slots.get(usernameLower) || []).slice();
  const evicted = list.filter(s => s.platform === pl).map(s => s.sid);
  list = list.filter(s => s.platform !== pl);
  list.push({ sid, createdAt: now, platform: pl, lastSeenAt: now });
  // Legacy (pre-platform) slots are the only way past the cap; oldest go.
  while (list.length > MAX_LOGINS) {
    const i = list.findIndex(s => s.platform === 'legacy');
    evicted.push(list.splice(i >= 0 ? i : 0, 1)[0].sid);
  }
  db.transaction(() => {
    stmt.insert.run(sid, usernameLower, now, pl, now);
    for (const old of evicted) stmt.remove.run(old);
  })();
  slots.set(usernameLower, list);
  return { sid, evicted, platform: pl };
}

// Sign-out from one device frees its slot.
function closeSlot(usernameLower, sid) {
  const list = (slots.get(usernameLower) || []).filter(s => s.sid !== sid);
  slots.set(usernameLower, list);
  try { stmt.remove.run(sid); } catch (e) {}
}

// Sign out everywhere (password reset).
function clearSlots(usernameLower) {
  slots.delete(usernameLower);
  try { stmt.clear.run(usernameLower); } catch (e) {}
}

// For the account page: where this account is signed in right now.
function listSlots(usernameLower) {
  return (slots.get(usernameLower) || []).map(s => ({
    sid: s.sid, platform: s.platform, signedInAt: s.createdAt, lastSeenAt: s.lastSeenAt || s.createdAt
  }));
}

module.exports = { PLATFORMS, MAX_LOGINS, platformFor, hasSlots, isActive, openSlot, closeSlot, clearSlots, listSlots };
