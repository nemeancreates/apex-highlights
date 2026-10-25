// ================================
// ACCOUNT BANS — closing an account for breaking the Terms (section 19), and
// catching the same person coming back on a new account.
//
// Different from public_bans (moderation/index.js), which only stop public
// posting. An account ban:
//   - signs the account out everywhere and refuses every sign-in after that,
//     with a message saying why (auth.js)
//   - also bans it from public posting, so its listings vanish
//   - is never refunded (Terms section 19)
//
// Ban evasion. We keep no names or emails, so a new account is linked to a
// banned one only through two opaque signals:
//   card    Stripe's card fingerprint for the card that paid for a code. It's
//           Stripe's own one-way id (the same card always gives the same
//           value), not the card number. Recorded when the code is redeemed.
//   device  the Peakabu Mobile app's per-phone tag (a hash made by the mobile
//           server; we never see the phone's real id). Recorded at sign-in.
// When a signal on one account belongs to a banned account, the new account
// is banned too ("evasion"), the redeem or sign-in is refused, and staff get
// an alert. Staff can lift any ban (POST /admin/accounts/NAME).
// ================================
const db = require('../db');
const { log } = require('../logger');

db.exec(`
  CREATE TABLE IF NOT EXISTS account_bans (
    usernameLower TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    reason        TEXT NOT NULL,
    issuedBy      TEXT NOT NULL,
    linkedTo      TEXT,
    createdAt     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ban_signals (
    kind          TEXT NOT NULL,
    value         TEXT NOT NULL,
    usernameLower TEXT NOT NULL,
    createdAt     INTEGER NOT NULL,
    PRIMARY KEY (kind, value, usernameLower)
  );
  CREATE INDEX IF NOT EXISTS idx_ban_signals_user ON ban_signals(usernameLower);
  -- Accounts staff checked and cleared: never closed automatically again.
  CREATE TABLE IF NOT EXISTS ban_cleared (
    usernameLower TEXT PRIMARY KEY,
    clearedAt     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS code_payments (
    code        TEXT PRIMARY KEY,
    checkoutId  TEXT NOT NULL,
    fingerprint TEXT,
    createdAt   INTEGER NOT NULL
  );
`);

const stmt = {
  get:        db.prepare(`SELECT * FROM account_bans WHERE usernameLower = ?`),
  add:        db.prepare(`INSERT INTO account_bans (usernameLower, username, reason, issuedBy, linkedTo, createdAt)
                          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(usernameLower) DO NOTHING`),
  remove:     db.prepare(`DELETE FROM account_bans WHERE usernameLower = ?`),
  all:        db.prepare(`SELECT * FROM account_bans ORDER BY createdAt DESC LIMIT 500`),
  addSignal:  db.prepare(`INSERT OR IGNORE INTO ban_signals (kind, value, usernameLower, createdAt) VALUES (?, ?, ?, ?)`),
  // Other accounts with this signal that are banned.
  bannedWith: db.prepare(`SELECT b.* FROM ban_signals s JOIN account_bans b ON b.usernameLower = s.usernameLower
                          WHERE s.kind = ? AND s.value = ? AND s.usernameLower != ? LIMIT 1`),
  signalsFor: db.prepare(`SELECT kind, value, createdAt FROM ban_signals WHERE usernameLower = ?`),
  bannedDevice: db.prepare(`SELECT 1 FROM ban_signals s JOIN account_bans b ON b.usernameLower = s.usernameLower
                          WHERE s.kind = 'device' AND s.value = ? LIMIT 1`),
  putPayment: db.prepare(`INSERT INTO code_payments (code, checkoutId, fingerprint, createdAt) VALUES (?, ?, ?, ?)
                          ON CONFLICT(code) DO UPDATE SET fingerprint = COALESCE(excluded.fingerprint, code_payments.fingerprint)`),
  getPayment: db.prepare(`SELECT * FROM code_payments WHERE code = ?`),
  clear:      db.prepare(`INSERT OR REPLACE INTO ban_cleared (usernameLower, clearedAt) VALUES (?, ?)`),
  isCleared:  db.prepare(`SELECT 1 FROM ban_cleared WHERE usernameLower = ?`),
  unclear:    db.prepare(`DELETE FROM ban_cleared WHERE usernameLower = ?`)
};

const lower = (u) => String(u || '').trim().toLowerCase();
const SIGNAL_KINDS = ['card', 'device'];

function getAccountBan(username) {
  try { return stmt.get.get(lower(username)) || null; } catch (e) { return null; }
}

// What a banned person sees when they try to sign in or use the app.
function banMessage(ban) {
  const why = ban.linkedTo
    ? 'This account is linked to an account that was closed for breaking the Peakabu Terms of Service.'
    : 'This account was closed for breaking the Peakabu Terms of Service.';
  return `${why} Closed accounts aren't refunded (Terms, section 19). If you think this is a mistake, email report@peakabu.app within 30 days.`;
}

// Closes the account: ban row, signed out everywhere, no public posting.
function banAccount(username, { reason, issuedBy, linkedTo = null }) {
  const key = lower(username);
  if (!key) return false;
  if (issuedBy !== 'auto') { try { stmt.unclear.run(key); } catch (e) {} }
  const added = stmt.add.run(key, String(username), String(reason || 'Terms violation').slice(0, 300), issuedBy || 'staff', linkedTo, Date.now()).changes > 0;
  if (!added) return false;
  try {
    const { users, saveUsersToDisk } = require('../stores');
    const user = users.get(key);
    if (user) { user.tokenVersion = (user.tokenVersion || 0) + 1; saveUsersToDisk(); }
    require('../login-slots').clearSlots(key);
  } catch (e) { log('warn', 'account_ban_signout_failed', { username: key, error: e.message }); }
  try { require('./index').banFromPublic(username, 'Account closed: ' + (reason || 'Terms violation'), issuedBy || 'staff'); } catch (e) {}
  // Stop any subscription charges right away (no refund: Terms section 19).
  try { require('../routes/billing').stopBillingForBan(key).catch(() => {}); } catch (e) {}
  log('warn', 'account_banned', { username: key, reason, issuedBy, linkedTo });
  return true;
}

function unbanAccount(username) {
  const key = lower(username);
  const removed = stmt.remove.run(key).changes > 0;
  // Lifted by staff: don't close it again automatically over a shared card
  // or phone (a family member, a second-hand phone).
  try { stmt.clear.run(key, Date.now()); } catch (e) {}
  if (removed) {
    try { require('./index').unban(username); } catch (e) {}
    log('info', 'account_unbanned', { username: key });
  }
  return removed;
}

// Records a signal for an account. If a different, banned account already
// has it, this account is banned as evasion. Returns the ban (or null).
function recordSignal(kind, value, username) {
  if (!SIGNAL_KINDS.includes(kind)) return null;
  const v = String(value || '').slice(0, 128);
  const key = lower(username);
  if (!v || !key) return null;
  try { stmt.addSignal.run(kind, v, key, Date.now()); } catch (e) { return null; }
  const existing = getAccountBan(key);
  if (existing) return existing;
  if (stmt.isCleared.get(key)) return null;
  const match = stmt.bannedWith.get(kind, v, key);
  if (!match) return null;
  banAccount(username, {
    reason: `Ban evasion: same ${kind === 'card' ? 'payment card' : 'phone'} as closed account "${match.username}"`,
    issuedBy: 'auto', linkedTo: match.usernameLower
  });
  require('./staff-alerts').postStaffAlert({
    title: `Ban evasion: "${username}" closed automatically`,
    level: 'warn',
    description: `Same ${kind === 'card' ? 'payment card' : 'phone'} as closed account "${match.username}" (${match.reason}). No refund issued.`,
    fields: [
      { name: 'Lift it if wrong', value: `POST /admin/accounts/${key} {"action":"unban"}` }
    ]
  }).catch(() => {});
  return getAccountBan(key);
}

// Is this phone tag tied to any closed account? (The mobile server asks
// before letting a phone join a session.)
function isDeviceBanned(tag) {
  try { return !!stmt.bannedDevice.get(String(tag || '').slice(0, 128)); } catch (e) { return false; }
}

// --- Payment fingerprints for codes (routes/billing.js) ---
function recordCodePayment(code, checkoutId, fingerprint) {
  try { stmt.putPayment.run(code, checkoutId, fingerprint || null, Date.now()); } catch (e) {}
}
function codeFingerprint(code) {
  try { const r = stmt.getPayment.get(String(code || '').trim().toUpperCase()); return r ? r.fingerprint : null; } catch (e) { return null; }
}

function listAccountBans() { try { return stmt.all.all(); } catch (e) { return []; } }
function signalsFor(username) {
  try { return stmt.signalsFor.all(lower(username)).map(s => ({ kind: s.kind, value: s.value.slice(0, 8) + '…', createdAt: s.createdAt })); } catch (e) { return []; }
}

module.exports = {
  getAccountBan, banMessage, banAccount, unbanAccount, recordSignal, isDeviceBanned,
  recordCodePayment, codeFingerprint, listAccountBans, signalsFor
};
