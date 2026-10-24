// ================================
// ACCOUNT DELETION — people delete their own account (app stores require it).
//
// Asking signs the account out everywhere, takes its public listings down,
// and starts a 7-day grace period. Signing back in during those 7 days
// cancels it (auth.js calls cancelDeletion on login). After that the hourly
// sweep deletes:
//   - the account and its logins
//   - its own clips (files and records), comments and Peak Moments
//   - Mobile passes, event passes, Swing card sets, AI Reel usage
//   - its Peakabu Mobile data (the mobile server is told over the secret)
//   - monthly subscriptions: cancelled in Stripe FIRST, so charges stop
//     (a renewal that lands during the 7 days is not cancelled; refund it)
// Kept on purpose:
//   - sessions it hosted, so guests keep their clips; the host shows as
//     "Deleted account" (a name registration can never produce, since sign-up
//     strips spaces), so no one who later takes the username becomes host
//   - stars it gave, re-attributed to "Deleted account" (a star is shared by
//     everyone in the session)
//   - ban/strike records (Terms enforcement) and anything under legal hold
//   - redeemed codes as anonymous sales records
//
// Pending deletions live in their own table, not a users column, so the
// stores.js three-place rule doesn't apply (same choice as login-slots.js).
// ================================
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { log } = require('./logger');
const { UPLOADS_DIR } = require('./config');
const { users, sessions, saveUsersToDisk, saveSessionsToDisk } = require('./stores');
const { deleteFromSpaces } = require('./spaces');
const { isOnHold } = require('./moderation/legal-hold');
const loginSlots = require('./login-slots');
const db = require('./db');

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DELETED_NAME = 'Deleted account';
const MOBILE_API_URL = (process.env.MOBILE_API_URL || '').replace(/\/$/, '');
const MOBILE_SHARED_SECRET = process.env.MOBILE_SHARED_SECRET || '';

db.exec(`
  CREATE TABLE IF NOT EXISTS account_deletions (
    usernameLower TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    requestedAt   INTEGER NOT NULL,
    dueAt         INTEGER NOT NULL,
    doneAt        INTEGER,
    mobileDone    INTEGER NOT NULL DEFAULT 0
  );
`);

// Tables that may not exist on every install are touched through run(), which
// skips a missing table instead of failing the whole deletion.
function run(sql, ...args) {
  try { return db.prepare(sql).run(...args).changes; }
  catch (err) { if (!/no such table/i.test(err.message)) throw err; return 0; }
}

const stmt = {
  get:     db.prepare(`SELECT * FROM account_deletions WHERE usernameLower = ?`),
  add:     db.prepare(`INSERT INTO account_deletions (usernameLower, username, requestedAt, dueAt) VALUES (?, ?, ?, ?)
                       ON CONFLICT(usernameLower) DO UPDATE SET requestedAt = excluded.requestedAt, dueAt = excluded.dueAt, doneAt = NULL, mobileDone = 0`),
  cancel:  db.prepare(`DELETE FROM account_deletions WHERE usernameLower = ? AND doneAt IS NULL`),
  due:     db.prepare(`SELECT * FROM account_deletions WHERE doneAt IS NULL AND dueAt <= ?`),
  mobileLeft: db.prepare(`SELECT * FROM account_deletions WHERE doneAt IS NOT NULL AND mobileDone = 0`),
  done:    db.prepare(`UPDATE account_deletions SET doneAt = ? WHERE usernameLower = ?`),
  mobileOk: db.prepare(`UPDATE account_deletions SET mobileDone = 1 WHERE usernameLower = ?`),
  // Finished rows are only kept to retry the mobile server; drop them after 30 days.
  prune:   db.prepare(`DELETE FROM account_deletions WHERE doneAt IS NOT NULL AND mobileDone = 1 AND doneAt < ?`)
};

function pendingDeletion(usernameLower) {
  try {
    const r = stmt.get.get(String(usernameLower || '').toLowerCase());
    return r && !r.doneAt ? { requestedAt: r.requestedAt, dueAt: r.dueAt } : null;
  } catch (e) { return null; }
}

// Password check, then sign out everywhere and start the grace period.
async function requestDeletion(username, password) {
  const key = String(username || '').toLowerCase();
  const user = users.get(key);
  if (!user) return { ok: false, status: 404, error: 'Account not found' };
  if (typeof password !== 'string' || !password || !(await bcrypt.compare(password, user.passwordHash))) {
    return { ok: false, status: 403, error: 'That password isn’t right.' }; // not 401: the website signs out on 401
  }
  const now = Date.now();
  stmt.add.run(key, user.username, now, now + GRACE_MS);
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  loginSlots.clearSlots(key);
  saveUsersToDisk();
  // Public listings come down now, not in 7 days.
  run(`DELETE FROM public_listings WHERE listedBy = ?`, user.username);
  log('info', 'account_deletion_requested', { username: user.username, dueAt: new Date(now + GRACE_MS).toISOString() });
  return { ok: true, dueAt: now + GRACE_MS };
}

// Signing in during the grace period keeps the account.
function cancelDeletion(usernameLower) {
  try {
    const n = stmt.cancel.run(String(usernameLower || '').toLowerCase()).changes;
    if (n) log('info', 'account_deletion_cancelled', { username: usernameLower });
    return n > 0;
  } catch (e) { return false; }
}

async function deleteFiles(code, up) {
  for (const k of [up.videoKey, up.thumbnailKey, up.metadataKey]) {
    if (k) { try { await deleteFromSpaces(k); } catch (e) { log('warn', 'account_delete_spaces_failed', { key: k, error: e.message }); } }
  }
  const dir = path.join(UPLOADS_DIR, code);
  const names = [up.videoFile, up.metadataFile, up.thumbnailFile];
  if (up.videoFile) names.push(`thumb_${path.basename(up.videoFile, '.mp4')}.jpg`);
  for (const f of names) {
    if (!f) continue;
    const p = path.join(dir, path.basename(f));
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
  }
}

// The deletion itself. Sessions under legal hold are left exactly as they are.
async function performDeletion(row) {
  const name = row.username;
  const lower = row.usernameLower;
  const same = (u) => typeof u === 'string' && u.toLowerCase() === lower;
  // Stop any monthly charges first. If Stripe can't be reached this throws,
  // nothing is deleted yet, and the hourly sweep tries again.
  await require('./routes/billing').cancelSubscriptionsFor(lower);
  let clips = 0;
  for (const [code, s] of sessions) {
    if (isOnHold(code)) continue;
    // Own clips, wherever they were uploaded.
    const mine = (s.uploads || []).filter((u) => same(u.username));
    for (const up of mine) {
      await deleteFiles(code, up);
      run(`DELETE FROM comments WHERE uploadId = ?`, up.id); // comments on a clip go with it
      run(`DELETE FROM uploads WHERE id = ?`, up.id);
      clips++;
    }
    if (mine.length) s.uploads = s.uploads.filter((u) => !same(u.username));
    // Hosted sessions stay for the guests, under "Deleted account".
    if (same(s.createdBy)) s.createdBy = DELETED_NAME;
    if (Array.isArray(s.participants)) s.participants = s.participants.filter((p) => !same(typeof p === 'string' ? p : p && p.username));
    if (Array.isArray(s.members)) s.members = s.members.filter((m) => !same(typeof m === 'string' ? m : m && m.username));
  }
  // createdBy isn't in the sessions upsert's update list, so set it directly
  // (this also covers rows of sessions not held in memory).
  run(`UPDATE sessions SET createdBy = ? WHERE lower(createdBy) = ? AND code NOT IN (SELECT sessionCode FROM legal_holds)`, DELETED_NAME, lower);
  saveSessionsToDisk();
  run(`DELETE FROM comments WHERE lower(username) = ? AND sessionCode NOT IN (SELECT sessionCode FROM legal_holds)`, lower);
  run(`UPDATE stars SET starredBy = ? WHERE lower(starredBy) = ?`, DELETED_NAME, lower);
  run(`DELETE FROM peak_moments WHERE lower(username) = ?`, lower);
  run(`DELETE FROM public_listings WHERE lower(listedBy) = ?`, lower);
  run(`DELETE FROM mobile_passes WHERE usernameLower = ?`, lower);
  run(`DELETE FROM mobile_event_passes WHERE usernameLower = ?`, lower);
  run(`DELETE FROM spot_cards WHERE setId IN (SELECT id FROM spot_sets WHERE usernameLower = ?)`, lower);
  run(`DELETE FROM spot_sets WHERE usernameLower = ?`, lower);
  try { require('./generation-usage').forgetUser(name); } catch (e) { /* not set up here */ }
  try { require('./redemption').forgetUser(name, DELETED_NAME); } catch (e) { log('warn', 'account_delete_codes_failed', { error: e.message }); }
  loginSlots.clearSlots(lower);
  users.delete(lower);
  run(`DELETE FROM users WHERE username_lower = ?`, lower);
  stmt.done.run(Date.now(), lower);
  log('info', 'account_deleted', { username: name, clips });
  await tellMobile(row);
}

// Peakabu Mobile keeps its own records (hosted sessions, joined lists, usage).
async function tellMobile(row) {
  if (!MOBILE_API_URL || !MOBILE_SHARED_SECRET) { stmt.mobileOk.run(row.usernameLower); return; }
  try {
    const r = await fetch(MOBILE_API_URL + '/api/internal/account-deleted', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mobile-Secret': MOBILE_SHARED_SECRET },
      body: JSON.stringify({ username: row.username }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    stmt.mobileOk.run(row.usernameLower);
  } catch (err) {
    log('warn', 'account_delete_mobile_failed', { username: row.username, error: err.message }); // retried next sweep
  }
}

async function sweep() {
  const now = Date.now();
  for (const row of stmt.due.all(now)) {
    try { await performDeletion(row); }
    catch (err) { log('error', 'account_delete_failed', { username: row.username, error: err.message }); }
  }
  for (const row of stmt.mobileLeft.all()) await tellMobile(row);
  stmt.prune.run(now - 30 * 24 * 60 * 60 * 1000);
}

function startAccountDeletionSweep() {
  setInterval(() => { sweep().catch((err) => log('error', 'account_delete_sweep_failed', { error: err.message })); }, 60 * 60 * 1000);
}

module.exports = { requestDeletion, cancelDeletion, pendingDeletion, startAccountDeletionSweep, GRACE_MS, DELETED_NAME, _sweepForTest: sweep };
