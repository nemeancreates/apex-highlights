// ================================
// STORES — users + sessions state, backed by SQLite (v0.1.29).
//
// Same exported function names as the JSON version, so auth.js, the routes,
// and the sockets are UNCHANGED. Internals:
//   - users: SQLite is the source of truth; an in-memory Map mirrors it for
//     fast synchronous auth lookups. saveUsersToDisk() writes the Map through
//     to SQLite (idempotent upsert), so auth.js's existing call site works.
//   - sessions: stay an in-memory Map because they carry live socket state
//     (members, pendingHighlights, highlightLockedUntil) with no meaning on
//     disk. Durable parts (session row + uploads) are written through to
//     SQLite; transient fields reset on load.
//
// TIERS: user tier state and per-session tier limits are persisted here.
// If a field isn't in the upsert statements below it silently vanishes on
// restart — that's how the first pass of tier support lost redeemed tiers.
// ================================
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');
const { SESSION_TTL, UPLOADS_DIR } = require('./config');
const { deleteFromSpaces, uploadToSpaces, isSpacesEnabled } = require('./spaces');
const { enqueueThumbnail } = require('./media');
const db = require('./db');

const users = new Map();
const sessions = new Map();

// ================================
// CLIP WEIGHT — duration-based clip-count cost. 0-3min = 1, 3:01-6min = 2.
// 6 minutes is the hard cap on auto-capture length, so weight never exceeds
// 2 regardless of how long a clip claims to be — a malformed/spoofed
// durationMs can't inflate the cost past what the system actually allows
// to be recorded.
// ================================
// Weight is now the clip's duration in whole seconds — the cap becomes
// "seconds of footage allowed", not a bracket-based clip count. A 15s
// false positive costs 15, not the same as a 3-minute clip; a bad guess
// is cheap to make and cheap to delete. No public-facing bracket math.
function clipWeightForDuration(durationMs) {
  if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.round(durationMs / 1000));
}

// One-time migration: sessions created before this change persisted
// maxClips as an old bracket-era COUNT (20/75/175/300) and uploads'
// clipWeight as 1 or 2. Both are now meaningless against the new
// seconds-based cap — a session capped at "75" would read as instantly
// exhausted. Map old cap values to their new seconds-based equivalent by
// value (the four old numbers are unique, so no tier lookup needed), and
// recompute each upload's weight from its stored durationMs where available.
const OLD_CAP_MIGRATION = { 20: 3600, 75: 43200, 175: 86400, 300: 144000 };
function migrateLegacyCaps(session) {
  let changed = false;
  if (typeof session.maxClips === 'number' && OLD_CAP_MIGRATION[session.maxClips] !== undefined) {
    session.maxClips = OLD_CAP_MIGRATION[session.maxClips];
    changed = true;
  }
  for (const u of session.uploads) {
    if (typeof u.durationMs === 'number' && u.durationMs > 0) {
      const recomputed = clipWeightForDuration(u.durationMs);
      if (u.clipWeight !== recomputed) { u.clipWeight = recomputed; changed = true; }
    }
  }
  return changed;
}

// A session's expiry: prefer its own tier-derived expiresAt, fall back to
// the global TTL for sessions created before tiers shipped.
function sessionExpiryMs(s) {
  if (typeof s.expiresAt === 'number' && s.expiresAt > 0) return s.expiresAt;
  return new Date(s.createdAt).getTime() + SESSION_TTL;
}

// --- Prepared statements (compiled once, reused) ---
const stmt = {
  upsertUser: db.prepare(`
    INSERT INTO users (
      username_lower, username, passwordHash, createdAt,
      tier, tierSource, tierExpiresAt,
      sessionsThisMonth, sessionsMonthKey,
      bandwidthBytesThisMonth, bandwidthMonthKey, bandwidthAlertedThisMonth
    )
    VALUES (
      @username_lower, @username, @passwordHash, @createdAt,
      @tier, @tierSource, @tierExpiresAt,
      @sessionsThisMonth, @sessionsMonthKey,
      @bandwidthBytesThisMonth, @bandwidthMonthKey, @bandwidthAlertedThisMonth
    )
    ON CONFLICT(username_lower) DO UPDATE SET
      passwordHash = excluded.passwordHash,
      tier = excluded.tier,
      tierSource = excluded.tierSource,
      tierExpiresAt = excluded.tierExpiresAt,
      sessionsThisMonth = excluded.sessionsThisMonth,
      sessionsMonthKey = excluded.sessionsMonthKey,
      bandwidthBytesThisMonth = excluded.bandwidthBytesThisMonth,
      bandwidthMonthKey = excluded.bandwidthMonthKey,
      bandwidthAlertedThisMonth = excluded.bandwidthAlertedThisMonth
  `),
  allUsers: db.prepare(`SELECT * FROM users`),

  upsertSession: db.prepare(`
    INSERT INTO sessions (
      code, id, createdBy, createdAt, clipDuration, highlightCount,
      hostTier, expiresAt, maxMembers, maxClips, title, detectedGame
    )
    VALUES (
      @code, @id, @createdBy, @createdAt, @clipDuration, @highlightCount,
      @hostTier, @expiresAt, @maxMembers, @maxClips, @title, @detectedGame
    )
    ON CONFLICT(code) DO UPDATE SET
      clipDuration = excluded.clipDuration,
      highlightCount = excluded.highlightCount,
      hostTier = excluded.hostTier,
      expiresAt = excluded.expiresAt,
      maxMembers = excluded.maxMembers,
      maxClips = excluded.maxClips,
      title = excluded.title,
      detectedGame = excluded.detectedGame
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE code = ?`),
  allSessions: db.prepare(`SELECT * FROM sessions`),

  upsertUpload: db.prepare(`
    INSERT INTO uploads (id, sessionCode, username, videoFile, metadataFile, thumbnailFile,
      videoUrl, thumbnailUrl, metadataUrl, videoKey, thumbnailKey, metadataKey, uploadedAt, fileSize,
      durationMs, clipWeight)
    VALUES (@id, @sessionCode, @username, @videoFile, @metadataFile, @thumbnailFile,
      @videoUrl, @thumbnailUrl, @metadataUrl, @videoKey, @thumbnailKey, @metadataKey, @uploadedAt, @fileSize,
      @durationMs, @clipWeight)
    ON CONFLICT(id) DO UPDATE SET
      videoUrl = excluded.videoUrl, thumbnailUrl = excluded.thumbnailUrl, metadataUrl = excluded.metadataUrl,
      videoKey = excluded.videoKey, thumbnailKey = excluded.thumbnailKey, metadataKey = excluded.metadataKey,
      thumbnailFile = excluded.thumbnailFile,
      durationMs = excluded.durationMs, clipWeight = excluded.clipWeight
  `),
  uploadsForSession: db.prepare(`SELECT * FROM uploads WHERE sessionCode = ?`),
  sessionsByUser: db.prepare(`
    SELECT s.*,
      (SELECT COALESCE(SUM(u.clipWeight), 0) FROM uploads u WHERE u.sessionCode = s.code) AS clipsUsed
    FROM sessions s
    WHERE s.createdBy = ?
    ORDER BY s.createdAt DESC
    LIMIT ?
  `)
};

// ================================
// USERS
// ================================
function loadUsersFromDisk() {
  for (const row of stmt.allUsers.all()) {
    users.set(row.username_lower, {
      username: row.username,
      passwordHash: row.passwordHash,
      createdAt: row.createdAt,
      tier: row.tier || 't1',
      tierSource: row.tierSource || 'default',
      tierExpiresAt: row.tierExpiresAt ?? null,
      sessionsThisMonth: row.sessionsThisMonth || 0,
      sessionsMonthKey: row.sessionsMonthKey || null,
      bandwidthBytesThisMonth: row.bandwidthBytesThisMonth || 0,
      bandwidthMonthKey: row.bandwidthMonthKey || null,
      // SQLite has no boolean type — stored as 0/1, surfaced as a bool
      bandwidthAlertedThisMonth: !!row.bandwidthAlertedThisMonth
    });
  }
  log('info', 'users_loaded', { count: users.size });
}

// auth.js calls this right after users.set(...) on register. Writes the whole
// Map through to SQLite; upsert makes it idempotent so re-writing costs nothing.
function saveUsersToDisk() {
  const persist = db.transaction(() => {
    for (const [lower, u] of users) {
      stmt.upsertUser.run({
        username_lower: lower,
        username: u.username,
        passwordHash: u.passwordHash,
        createdAt: u.createdAt,
        tier: u.tier || 't1',
        tierSource: u.tierSource || 'default',
        tierExpiresAt: u.tierExpiresAt ?? null,
        sessionsThisMonth: u.sessionsThisMonth || 0,
        sessionsMonthKey: u.sessionsMonthKey ?? null,
        bandwidthBytesThisMonth: u.bandwidthBytesThisMonth || 0,
        bandwidthMonthKey: u.bandwidthMonthKey ?? null,
        bandwidthAlertedThisMonth: u.bandwidthAlertedThisMonth ? 1 : 0
      });
    }
  });
  try {
    persist();
  } catch (err) {
    log('warn', 'users_save_failed', { error: err.message });
  }
}

// ================================
// SESSIONS
// ================================
function loadSessionsFromDisk() {
  const now = Date.now();
  let loaded = 0, expired = 0, migratedCount = 0;
  for (const row of stmt.allSessions.all()) {
    // Per-session tier retention, with the global TTL as the fallback
    if (now > sessionExpiryMs(row)) {
      stmt.deleteSession.run(row.code); // cascade drops uploads
      expired++;
      continue;
    }
    const uploads = stmt.uploadsForSession.all(row.code);
    const migratedSession = {
      id: row.id,
      code: row.code,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      clipDuration: row.clipDuration,
      highlightCount: row.highlightCount,
      hostTier: row.hostTier ?? null,
      expiresAt: row.expiresAt ?? null,
      maxMembers: row.maxMembers ?? null,
      maxClips: row.maxClips ?? null,
      title: row.title ?? null,
      detectedGame: row.detectedGame ?? null,
      highlightLockedUntil: 0,   // transient — rebuilt live
      pendingHighlights: [],     // transient
      members: [],               // transient
      uploads
    };
    if (migrateLegacyCaps(migratedSession)) migratedCount++;
    sessions.set(row.code, migratedSession);
    loaded++;
  }
  log('info', 'sessions_loaded', { loaded, expired });
  if (migratedCount > 0) {
    log('info', 'sessions_cap_migration', { migrated: migratedCount });
    saveSessionsToDisk();
  }
}

// Write-through: persist durable parts of every in-memory session.
// Called from the same places the old JSON saveSessionsToDisk() was.
function saveSessionsToDisk() {
  const persist = db.transaction(() => {
    for (const s of sessions.values()) {
      stmt.upsertSession.run({
        code: s.code,
        id: s.id,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
        clipDuration: s.clipDuration,
        highlightCount: s.highlightCount || 0,
        hostTier: s.hostTier ?? null,
        expiresAt: s.expiresAt ?? null,
        maxMembers: s.maxMembers ?? null,
        maxClips: s.maxClips ?? null,
        title: s.title ?? null,
        detectedGame: s.detectedGame ?? null
      });
      for (const u of s.uploads) {
        stmt.upsertUpload.run({
          id: u.id,
          sessionCode: s.code,
          username: u.username,
          videoFile: u.videoFile ?? null,
          metadataFile: u.metadataFile ?? null,
          thumbnailFile: u.thumbnailFile ?? null,
          videoUrl: u.videoUrl ?? null,
          thumbnailUrl: u.thumbnailUrl ?? null,
          metadataUrl: u.metadataUrl ?? null,
          videoKey: u.videoKey ?? null,
          thumbnailKey: u.thumbnailKey ?? null,
          metadataKey: u.metadataKey ?? null,
          uploadedAt: u.uploadedAt ?? null,
          fileSize: u.fileSize ?? null,
          durationMs: u.durationMs ?? null,
          clipWeight: u.clipWeight || 1
        });
      }
    }
  });
  try {
    persist();
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
      if (rec.videoKey) continue;
      const localPath = path.join(sessionDir, rec.videoFile);
      if (!fs.existsSync(localPath)) continue;

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

// --- Hourly purge of expired sessions (Spaces objects + DB rows) ---
// Honors each session's own tier-based expiresAt; sessions created before
// tiers shipped fall back to the global SESSION_TTL.
function startSessionPurge() {
  setInterval(async () => {
    const now = Date.now();
    let purged = 0;
    for (const [code, session] of sessions) {
      if (now > sessionExpiryMs(session)) {
        for (const up of session.uploads) {
          if (up.videoKey) await deleteFromSpaces(up.videoKey);
          if (up.thumbnailKey) await deleteFromSpaces(up.thumbnailKey);
          if (up.metadataKey) await deleteFromSpaces(up.metadataKey);
        }
        sessions.delete(code);
        stmt.deleteSession.run(code); // cascade drops uploads
        purged++;
      }
    }
    if (purged > 0) log('info', 'sessions_purged', { purged });
  }, 60 * 60 * 1000);
}

// ================================
// PER-USER SESSION HISTORY — durable, survives reinstall.
// Reads straight from SQLite (not the in-memory Map) so it works even after
// a session is pruned from memory, and filters out anything already past its
// tier-based expiry so the client never shows dead codes. Hosted sessions
// only — a joined-but-not-hosted session isn't in sessions.createdBy.
// ================================
function getSessionsByUser(username, limit = 50) {
  if (!username) return [];
  const now = Date.now();
  const rows = stmt.sessionsByUser.all(username, limit);
  return rows
    .filter(r => now <= sessionExpiryMs(r))
    .map(r => ({
      code: r.code,
      title: r.title ?? null,
      detectedGame: r.detectedGame ?? null,
      expiresAt: (typeof r.expiresAt === 'number' && r.expiresAt > 0)
        ? r.expiresAt
        : sessionExpiryMs(r),
      createdAt: r.createdAt,
      clipsUsed: r.clipsUsed || 0,
      role: 'host'
    }));
}

module.exports = {
  users,
  sessions,
  loadUsersFromDisk,
  saveUsersToDisk,
  loadSessionsFromDisk,
  saveSessionsToDisk,
  retryPendingSpacesUploads,
  startSessionPurge,
  clipWeightForDuration,
  getSessionsByUser
};