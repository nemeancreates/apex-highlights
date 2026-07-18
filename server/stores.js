// ================================
// STORES — users + sessions in-memory state and JSON persistence.
//
// v0.1.28: identical JSON-file persistence, just relocated. Every other
// module talks to state through this file, which means the planned SQLite
// swap (v0.1.29) only ever touches THIS file — nothing else changes.
// ================================
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { USERS_FILE, SESSIONS_FILE, SESSION_TTL, UPLOADS_DIR } = require('./config');
const { deleteFromSpaces, uploadToSpaces, isSpacesEnabled } = require('./spaces');
const { enqueueThumbnail } = require('./media');

const users = new Map();
const sessions = new Map();

// --- Users persistence ---
function loadUsersFromDisk() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    for (const user of data) {
      users.set(user.username.toLowerCase(), user);
    }
    log('info', 'users_loaded', { count: users.size });
  } catch (err) {
    log('warn', 'users_load_failed', { error: err.message });
  }
}

function saveUsersToDisk() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(users.values()), null, 2));
  } catch (err) {
    log('warn', 'users_save_failed', { error: err.message });
  }
}

// --- Sessions persistence ---
function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    let loaded = 0;
    let expired = 0;
    for (const session of data) {
      const age = now - new Date(session.createdAt).getTime();
      if (age > SESSION_TTL) { expired++; continue; }
      session.members = []; // clear live socket state — members rejoin
      session.highlightLockedUntil = 0; // clear stale lock
      sessions.set(session.code, session);
      loaded++;
    }
    log('info', 'sessions_loaded', { loaded, expired });
  } catch (err) {
    log('warn', 'sessions_load_failed', { error: err.message });
  }
}

function saveSessionsToDisk() {
  try {
    const data = Array.from(sessions.values()).map(s => {
      // Don't persist transient lock state
      const { highlightLockedUntil, ...rest } = s;
      return rest;
    });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log('warn', 'sessions_save_failed', { error: err.message });
  }
}

// --- Boot task: re-upload anything that never made it to Spaces ---
function retryPendingSpacesUploads() {
  if (!isSpacesEnabled()) return;
  let retried = 0;
  for (const [code, session] of sessions) {
    const sessionDir = path.join(UPLOADS_DIR, code);
    for (const rec of session.uploads) {
      if (rec.videoKey) continue; // already on CDN
      const localPath = path.join(sessionDir, rec.videoFile);
      if (!fs.existsSync(localPath)) continue; // file gone, nothing to do

      const thumbName = `thumb_${path.basename(rec.videoFile, '.mp4')}.jpg`;
      const thumbPath = path.join(sessionDir, thumbName);
      const videoKey = `${code}/${rec.videoFile}`;
      const thumbKey = `${code}/${thumbName}`;
      const metaKey = rec.metadataFile ? `${code}/${rec.metadataFile}` : null;

      retried++;
      enqueueThumbnail(localPath, thumbPath, async () => {
        try {
          rec.videoUrl = await uploadToSpaces(localPath, videoKey, 'video/mp4');
          rec.videoKey = videoKey;
          if (fs.existsSync(thumbPath)) {
            rec.thumbnailUrl = await uploadToSpaces(thumbPath, thumbKey, 'image/jpeg');
            rec.thumbnailKey = thumbKey;
          }
          if (rec.metadataFile) {
            const metaPath = path.join(sessionDir, rec.metadataFile);
            if (fs.existsSync(metaPath)) {
              rec.metadataUrl = await uploadToSpaces(metaPath, metaKey, 'application/json');
              rec.metadataKey = metaKey;
            }
          }
          saveSessionsToDisk();
          log('info', 'spaces_retry_complete', { session: code, key: videoKey });
        } catch (e) {
          log('error', 'spaces_retry_failed', { session: code, error: e.message });
        }
      });
    }
  }
  if (retried > 0) log('info', 'spaces_retry_queued', { count: retried });
}

// --- Daily purge of expired sessions (deletes their Spaces objects too) ---
function startSessionPurge() {
  setInterval(async () => {
    const now = Date.now();
    let purged = 0;
    for (const [code, session] of sessions) {
      if (now - new Date(session.createdAt).getTime() > SESSION_TTL) {
        for (const up of session.uploads) {
          if (up.videoKey) await deleteFromSpaces(up.videoKey);
          if (up.thumbnailKey) await deleteFromSpaces(up.thumbnailKey);
          if (up.metadataKey) await deleteFromSpaces(up.metadataKey);
        }
        sessions.delete(code);
        purged++;
      }
    }
    if (purged > 0) {
      log('info', 'sessions_purged', { purged });
      saveSessionsToDisk();
    }
  }, 24 * 60 * 60 * 1000);
}

module.exports = {
  users,
  sessions,
  loadUsersFromDisk,
  saveUsersToDisk,
  loadSessionsFromDisk,
  saveSessionsToDisk,
  retryPendingSpacesUploads,
  startSessionPurge
};
