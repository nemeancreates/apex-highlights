// ================================
// REDEMPTION CODES — admin-generated, tier-granting, multi-use codes.
// Own Map + JSON file, same pattern as users/sessions persistence.
// loadCodesFromDisk() is called once at boot from index.js.
// ================================
const fs = require('fs');
const crypto = require('crypto');
const { log } = require('./logger');
const { REDEMPTION_CODES_FILE, TIERS, BANDWIDTH_ALERT_BYTES } = require('./config');

const codes = new Map(); // code -> { code, tier, note, maxUses, useCount, usedBy: [{username, redeemedAt}], createdAt, meta? }

// Non-tier products a code can carry instead of a PC tier (Peakabu Mobile).
//   mobile: durationDays of Mobile on the redeeming account (stacks)
//   event:  one $3 event pass, meta = { startsAt, hours }
// 'sub' = a code issued for a Stripe subscription; redeeming it links that
// subscription to the account (entitlements.js). meta.subId says which.
const PRODUCTS = ['mobile', 'event', 'sub'];
const isProduct = (t) => PRODUCTS.includes(t);

function loadCodesFromDisk() {
  try {
    if (!fs.existsSync(REDEMPTION_CODES_FILE)) return;
    const data = JSON.parse(fs.readFileSync(REDEMPTION_CODES_FILE, 'utf8'));
    for (const c of data) codes.set(c.code, c);
    log('info', 'redemption_codes_loaded', { count: codes.size });
  } catch (err) {
    log('warn', 'redemption_codes_load_failed', { error: err.message });
  }
}

function saveCodesToDisk() {
  try {
    fs.writeFileSync(REDEMPTION_CODES_FILE, JSON.stringify(Array.from(codes.values()), null, 2));
  } catch (err) {
    log('warn', 'redemption_codes_save_failed', { error: err.message });
  }
}

function generateOneCode(tier) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 8; i++) rand += alphabet.charAt(crypto.randomInt(alphabet.length));
  return `PA-${tier.toUpperCase()}-${rand}`;
}

// Returns an array of generated code strings.
// durationDays: omit/null for a LIFETIME code (never expires — for
// friends/family, $1500+ backers, manual grants). Set a number for a
// TIMED subscription code (e.g. 30 for a monthly Kickstarter tier).
// buyer: lowercased username of whoever bought it on peakabu.app while
// signed in, so it shows in their account's "My codes" list (gifts too).
function generateRedemptionCodes({ tier, note, maxUses, quantity, durationDays, meta, buyer }) {
  if (!TIERS[tier] && !isProduct(tier)) throw new Error(`Unknown tier "${tier}"`);
  const uses = Math.max(1, Math.min(100000, parseInt(maxUses, 10) || 1));
  const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
  const duration = (durationDays !== undefined && durationDays !== null && durationDays !== '')
    ? (Math.max(1, Math.min(3650, parseInt(durationDays, 10) || 0)) || null)
    : null;
  const generated = [];
  for (let i = 0; i < qty; i++) {
    let code = generateOneCode(tier);
    while (codes.has(code)) code = generateOneCode(tier);
    codes.set(code, {
      code, tier, note: note || null,
      maxUses: uses, useCount: 0, usedBy: [],
      durationDays: duration, // null = lifetime
      ...(meta ? { meta } : {}),
      ...(buyer ? { buyer } : {}),
      createdAt: new Date().toISOString()
    });
    generated.push(code);
  }
  saveCodesToDisk();
  log('info', 'redemption_codes_generated', { tier, quantity: qty, maxUses: uses, durationDays: duration, note });
  return generated;
}

// Non-mutating validity check — same rules as redeemCode's guards, used
// by auth.js to decide the anti-stacking rule BEFORE actually consuming
// a use. redeemCode re-checks everything anyway (never trust a stale
// peek), so this is purely for ordering: "is this code even usable" has
// to be answered before "does the tier make sense for this account".
function peekCode(rawCode, username) {
  const code = String(rawCode || '').trim().toUpperCase();
  const entry = codes.get(code);
  if (!entry) return { ok: false, error: 'Invalid code' };
  if (entry.useCount >= entry.maxUses) return { ok: false, error: 'Code has already been fully redeemed' };
  if (entry.usedBy.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: "You've already redeemed this code" };
  }
  return { ok: true, tier: entry.tier, durationDays: entry.durationDays || null, meta: entry.meta || null };
}

// Returns { ok: true, tier, durationDays, meta } or { ok: false, error }
function redeemCode(rawCode, username) {
  const code = String(rawCode || '').trim().toUpperCase();
  const entry = codes.get(code);
  if (!entry) return { ok: false, error: 'Invalid code' };
  if (entry.useCount >= entry.maxUses) return { ok: false, error: 'Code has already been fully redeemed' };
  if (entry.usedBy.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: "You've already redeemed this code" };
  }
  entry.useCount++;
  entry.usedBy.push({ username, redeemedAt: new Date().toISOString() });
  saveCodesToDisk();
  log('info', 'redemption_code_used', { code, username, tier: entry.tier, durationDays: entry.durationDays || null, useCount: entry.useCount, maxUses: entry.maxUses });
  return { ok: true, tier: entry.tier, durationDays: entry.durationDays || null, meta: entry.meta || null };
}

// Billing looks codes up by the Stripe checkout that paid for them, so a
// retried webhook or a refreshed success page never mints a second code.
// Every code a multi-quantity checkout issued, in the order they were made.
function findCodesByNote(note) {
  return Array.from(codes.values()).filter(c => c.note === note).map(c => c.code);
}

function findCodeByNote(note) {
  for (const c of codes.values()) if (c.note === note) return c.code;
  return null;
}

// --- Bandwidth safeguard (upload bytes — see note in config.js about the
// CDN-bypasses-the-server limitation) ---
// Called from routes/uploads.js after a file is accepted.
function trackBandwidth(username, bytes, users, saveUsersToDisk) {
  const user = users.get(username.toLowerCase());
  if (!user) return;
  const monthKey = new Date().toISOString().slice(0, 7);
  if (user.bandwidthMonthKey !== monthKey) {
    user.bandwidthMonthKey = monthKey;
    user.bandwidthBytesThisMonth = 0;
    user.bandwidthAlertedThisMonth = false;
  }
  user.bandwidthBytesThisMonth = (user.bandwidthBytesThisMonth || 0) + bytes;
  if (user.bandwidthBytesThisMonth >= BANDWIDTH_ALERT_BYTES && !user.bandwidthAlertedThisMonth) {
    user.bandwidthAlertedThisMonth = true;
    log('warn', 'bandwidth_alert', { username, bytesThisMonth: user.bandwidthBytesThisMonth });
  }
  saveUsersToDisk();
}

// Codes this account bought, newest first (for the account page).
function codesBoughtBy(usernameLower) {
  return Array.from(codes.values()).filter(c => c.buyer === usernameLower)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// Account deletion (account-deletion.js): codes stay as sales records, but
// without the username of whoever bought or redeemed them.
function forgetUser(username, replacement) {
  const lower = String(username || '').toLowerCase();
  let changed = false;
  for (const entry of codes.values()) {
    if (entry.buyer === lower) { delete entry.buyer; changed = true; }
    for (const u of entry.usedBy || []) {
      if (u.username && u.username.toLowerCase() === lower) { u.username = replacement; changed = true; }
    }
  }
  if (changed) saveCodesToDisk();
}

module.exports = { loadCodesFromDisk, generateRedemptionCodes, redeemCode, peekCode, findCodeByNote, findCodesByNote, codesBoughtBy, trackBandwidth, isProduct, forgetUser, PRODUCTS };