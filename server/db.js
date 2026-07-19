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
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username_lower TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    passwordHash   TEXT NOT NULL,
    createdAt      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    code                TEXT PRIMARY KEY,
    id                  TEXT NOT NULL,
    createdBy           TEXT NOT NULL,
    createdAt           TEXT NOT NULL,
    clipDuration        INTEGER NOT NULL DEFAULT 30000,
    highlightCount      INTEGER NOT NULL DEFAULT 0
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
    FOREIGN KEY (sessionCode) REFERENCES sessions(code) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_uploads_session ON uploads(sessionCode);
`);

module.exports = db;
