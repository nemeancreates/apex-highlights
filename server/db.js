// ================================
// DB — SQLite connection + schema. Single file on disk (peakabu.db),
// no separate server process. This is the ONLY file that knows SQLite
// exists; stores.js talks to it, everything else talks to stores.js.
// ================================
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'peakabu.db');
const db = new Database(DB_PATH);

// WAL mode: concurrent reads don't block writes, and a crash mid-write
// rolls back to the last committed state instead of corrupting the file.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
// NOTE: CREATE TABLE IF NOT EXISTS only runs on a fresh database. For an
// EXISTING database the tier columns below are added by the migration
// block further down — keep the two in sync when adding new columns.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username_lower TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    passwordHash   TEXT NOT NULL,
    createdAt      TEXT NOT NULL,
    tier           TEXT NOT NULL DEFAULT 't1',
    tierSource     TEXT NOT NULL DEFAULT 'default',
    tierExpiresAt  INTEGER,
    sessionsThisMonth INTEGER NOT NULL DEFAULT 0,
    sessionsMonthKey  TEXT,
    bandwidthBytesThisMonth INTEGER NOT NULL DEFAULT 0,
    bandwidthMonthKey       TEXT,
    bandwidthAlertedThisMonth INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    code                TEXT PRIMARY KEY,
    id                  TEXT NOT NULL,
    createdBy           TEXT NOT NULL,
    createdAt           TEXT NOT NULL,
    clipDuration        INTEGER NOT NULL DEFAULT 30000,
    highlightCount      INTEGER NOT NULL DEFAULT 0,
    hostTier            TEXT,
    expiresAt           INTEGER,
    maxMembers          INTEGER,
    maxClips            INTEGER,
    title               TEXT,
    detectedGame        TEXT
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id           TEXT PRIMARY KEY,
    sessionCode  TEXT NOT NULL,
    username     TEXT NOT NULL,
    videoFile    TEXT,
    metadataFile TEXT,
    thumbnailFile TEXT,
    videoUrl     TEXT,
    thumbnailUrl TEXT,
    metadataUrl  TEXT,
    videoKey     TEXT,
    thumbnailKey TEXT,
    metadataKey  TEXT,
    uploadedAt   TEXT,
    fileSize     INTEGER,
    durationMs   INTEGER,
    clipWeight   INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (sessionCode) REFERENCES sessions(code) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_uploads_session ON uploads(sessionCode);
`);

// ================================
// QUICK COMMENTS — short timestamped notes anchored to ONE POV clip.
//
// Kept in its own db.exec() rather than threaded into the schema template
// above. New feature schema should go in a standalone block like this:
// a stray line inside a template literal is invisible until Node refuses
// to parse the file, and a db.js that won't compile takes the whole
// server down on boot, not just the feature.
//
// Deliberately NO foreign key to sessions(code). A session's row is only
// written by saveSessionsToDisk(), which may not have run yet for a
// brand-new session, and foreign_keys is ON above — an FK here would
// reject the very first comment on a fresh session. Cleanup is handled by
// the hourly orphan sweep in routes/comments.js instead.
// ================================
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    sessionCode TEXT NOT NULL,
    uploadId    TEXT NOT NULL,
    username    TEXT NOT NULL,
    timestampMs INTEGER NOT NULL,
    text        TEXT NOT NULL,
    createdAt   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(sessionCode);
  CREATE INDEX IF NOT EXISTS idx_comments_upload  ON comments(uploadId);

  CREATE TABLE IF NOT EXISTS comment_settings (
    sessionCode TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1
  );
`);

// ================================
// MIGRATIONS — additive only, idempotent, safe to run on every boot.
//
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we read the existing
// column list via PRAGMA and only add what's missing. Existing rows get
// the DEFAULT (or NULL), so nobody's account or session is disturbed.
// Adding a column is a metadata-only operation in SQLite — it does not
// rewrite the table, so this stays fast as the DB grows.
// ================================
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (existing.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`DB migration: added ${table}.${column}`);
  return true;
}

// users — tier state + monthly counters
addColumnIfMissing('users', 'tier', "TEXT NOT NULL DEFAULT 't1'");
addColumnIfMissing('users', 'tierSource', "TEXT NOT NULL DEFAULT 'default'");
addColumnIfMissing('users', 'tierExpiresAt', 'INTEGER');
addColumnIfMissing('users', 'sessionsThisMonth', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'sessionsMonthKey', 'TEXT');
addColumnIfMissing('users', 'bandwidthBytesThisMonth', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'bandwidthMonthKey', 'TEXT');
addColumnIfMissing('users', 'bandwidthAlertedThisMonth', 'INTEGER NOT NULL DEFAULT 0');

// sessions — tier limits captured at creation time
addColumnIfMissing('sessions', 'hostTier', 'TEXT');
addColumnIfMissing('sessions', 'expiresAt', 'INTEGER');
addColumnIfMissing('sessions', 'maxMembers', 'INTEGER');
addColumnIfMissing('sessions', 'maxClips', 'INTEGER');
addColumnIfMissing('sessions', 'title', 'TEXT');
addColumnIfMissing('sessions', 'detectedGame', 'TEXT');

// uploads — duration-based clip weight (batch 2: 3min=1, 6min=2, hard cap)
addColumnIfMissing('uploads', 'durationMs', 'INTEGER');
addColumnIfMissing('uploads', 'clipWeight', "INTEGER NOT NULL DEFAULT 1");
// comments — host-dragged position (null = auto-zone)
addColumnIfMissing('comments', 'positionX', 'REAL');
addColumnIfMissing('comments', 'positionY', 'REAL');

module.exports = db;