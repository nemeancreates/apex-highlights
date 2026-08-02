// ================================
// REDEMPTION CODES — admin-generated, tier-granting, multi-use codes.
// Own Map + JSON file, same pattern as users/sessions persistence.
// loadCodesFromDisk() is called once at boot from index.js.
// ================================
const fs = require('fs');
const crypto = require('crypto');
const { log } = require('./logger');
const { REDEMPTION_CODES_FILE, TIERS, BANDWIDTH_ALERT_BYTES } = require('./config');

const codes = new Map(); // code -> { code, tier, note, maxUses, useCount, usedBy: [{username, redeemedAt}], createdAt }

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
function generateRedemptionCodes({ tier, note, maxUses, quantity }) {
  if (!TIERS[tier]) throw new Error(`Unknown tier "${tier}"`);
  const uses = Math.max(1, Math.min(100000, parseInt(maxUses, 10) || 1));
  const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
  const generated = [];
  for (let i = 0; i < qty; i++) {
    let code = generateOneCode(tier);
    while (codes.has(code)) code = generateOneCode(tier);
    codes.set(code, {
      code, tier, note: note || null,
      maxUses: uses, useCount: 0, usedBy: [],
      createdAt: new Date().toISOString()
    });
    generated.push(code);
  }
  saveCodesToDisk();
  log('info', 'redemption_codes_generated', { tier, quantity: qty, maxUses: uses, note });
  return generated;
}

// Returns { ok: true, tier } or { ok: false, error }
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
  log('info', 'redemption_code_used', { code, username, tier: entry.tier, useCount: entry.useCount, maxUses: entry.maxUses });
  return { ok: true, tier: entry.tier };
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

module.exports = { loadCodesFromDisk, generateRedemptionCodes, redeemCode, trackBandwidth };