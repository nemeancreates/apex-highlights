// ================================
// LOGIN SLOTS — how many places one account can be signed in at once.
//
// Was single-login (newest wins): every login bumped tokenVersion, so
// signing in on a phone logged the PC out, and signing into the web player
// in a browser logged the desktop app out. Now each login gets its own slot
// id (the `sid` claim in the JWT). An account keeps MAX_LOGINS slots; a new
// login past that frees the OLDEST one, and only that device is signed out.
//
// tokenVersion still exists and still means "sign out everywhere": a
// password reset bumps it, which kills every token whatever its slot.
//
// Tokens minted before slots existed have no sid. They stay valid until the
// account's first slot login, which bumps tokenVersion once to retire them —
// otherwise an old token would be a silent third login.
//
// Its own table (not a users column) so stores.js's three-place rule for
// user fields doesn't apply. Depends only on db.js.
// ================================
const crypto = require('crypto');
const db = require('./db');

const MAX_LOGINS = 2;

db.exec(`
  CREATE TABLE IF NOT EXISTS login_slots (
    sid           TEXT PRIMARY KEY,
    usernameLower TEXT NOT NULL,
    createdAt     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_slots_user ON login_slots(usernameLower);
`);

const stmt = {
  all:     db.prepare(`SELECT * FROM login_slots ORDER BY createdAt ASC`),
  insert:  db.prepare(`INSERT INTO login_slots (sid, usernameLower, createdAt) VALUES (?, ?, ?)`),
  remove:  db.prepare(`DELETE FROM login_slots WHERE sid = ?`),
  clear:   db.prepare(`DELETE FROM login_slots WHERE usernameLower = ?`)
};

// usernameLower -> [{ sid, createdAt }] oldest first. Checked on every
// authenticated request, so it lives in memory; the table is the backup.
const slots = new Map();
try {
  for (const r of stmt.all.all()) {
    if (!slots.has(r.usernameLower)) slots.set(r.usernameLower, []);
    slots.get(r.usernameLower).push({ sid: r.sid, createdAt: r.createdAt });
  }
} catch (e) {}

function hasSlots(usernameLower) {
  return (slots.get(usernameLower) || []).length > 0;
}

function isActive(usernameLower, sid) {
  return (slots.get(usernameLower) || []).some(s => s.sid === sid);
}

// New slot for a fresh login. Returns { sid, evicted: [sid…] }.
function openSlot(usernameLower) {
  const sid = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const list = (slots.get(usernameLower) || []).slice();
  list.push({ sid, createdAt: now });
  const evicted = [];
  while (list.length > MAX_LOGINS) evicted.push(list.shift().sid);
  db.transaction(() => {
    stmt.insert.run(sid, usernameLower, now);
    for (const old of evicted) stmt.remove.run(old);
  })();
  slots.set(usernameLower, list);
  return { sid, evicted };
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

module.exports = { MAX_LOGINS, hasSlots, isActive, openSlot, closeSlot, clearSlots };
