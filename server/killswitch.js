// ================================
// KILL SWITCH — runtime-toggleable pause flags for new session creation
// and new registration. Own JSON file, same pattern as redemption.js.
// loadFlagsFromDisk() is called once at boot from index.js.
//
// Deliberately does NOT gate anything for already-logged-in users or
// already-active sessions — only the two entry points that let NEW
// people/sessions into the system. Toggled via an authenticated admin
// endpoint (requireAdmin), takes effect on the very next request with
// no restart or deploy needed.
// ================================
const fs = require('fs');
const { log } = require('./logger');
const { SYSTEM_FLAGS_FILE } = require('./config');

let flags = {
  sessionsPaused: false,
  registrationPaused: false,
  reason: null,
  updatedAt: null,
  updatedBy: null
};

function loadFlagsFromDisk() {
  try {
    if (!fs.existsSync(SYSTEM_FLAGS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SYSTEM_FLAGS_FILE, 'utf8'));
    flags = { ...flags, ...data };
    log('info', 'system_flags_loaded', flags);
  } catch (err) {
    log('warn', 'system_flags_load_failed', { error: err.message });
  }
}

function saveFlagsToDisk() {
  try {
    fs.writeFileSync(SYSTEM_FLAGS_FILE, JSON.stringify(flags, null, 2));
  } catch (err) {
    log('warn', 'system_flags_save_failed', { error: err.message });
  }
}

function getFlags() {
  return { ...flags };
}

function setFlags(patch, updatedBy) {
  if (typeof patch.sessionsPaused === 'boolean') flags.sessionsPaused = patch.sessionsPaused;
  if (typeof patch.registrationPaused === 'boolean') flags.registrationPaused = patch.registrationPaused;
  if (typeof patch.reason === 'string' || patch.reason === null) flags.reason = patch.reason || null;
  flags.updatedAt = new Date().toISOString();
  flags.updatedBy = updatedBy || null;
  saveFlagsToDisk();
  log('warn', 'system_flags_updated', flags);
  return getFlags();
}

module.exports = { loadFlagsFromDisk, getFlags, setFlags };
KILLSWITCH_EOF