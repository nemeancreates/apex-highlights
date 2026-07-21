// ================================
// CONFIG — every tunable constant lives here.
// Version bumps: edit LATEST_CLIENT_VERSION below (plus client/package.json
// and client/main.js — three files, same as always).
// ================================
const path = require('path');

// --- Fail fast on missing secrets ---
const JWT_SECRET = process.env.JWT_SECRET || null;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Set it and restart.');
  process.exit(1);
}

// --- Server ---
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost', 'http://localhost:3000'];

// --- Auth ---
const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '7d';

// --- DigitalOcean Spaces ---
const SPACES_REGION = process.env.SPACES_REGION || 'nyc3';
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'peakbu-media';
const SPACES_ENDPOINT = `https://${SPACES_REGION}.digitaloceanspaces.com`;
const SPACES_CDN_BASE = `https://${SPACES_BUCKET}.${SPACES_REGION}.cdn.digitaloceanspaces.com`;

// --- Paths ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// --- Capacity limits ---
const MAX_SESSIONS = 100;
const MAX_MEMBERS_PER_SESSION = 30;
const MAX_HIGHLIGHTS_PER_SESSION = 200;

// --- Clip durations (ms) ---
const ALLOWED_CLIP_DURATIONS = [15000, 30000, 60000, 180000];

// --- Session lifetime ---
const SESSION_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

// --- Uploads ---
const ALLOWED_EXTENSIONS = ['.mp4', '.json'];
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

// --- Rate limiting ---
const RATE_LIMIT_MAX = 120;          // HTTP requests per window per IP
const RATE_LIMIT_WINDOW = 60000;     // 1 minute
const SOCKET_RATE_MAX = 20;          // socket events per window per socket
const SOCKET_RATE_WINDOW = 10000;    // 10 seconds

// --- Highlights ---
const MAX_PENDING_HIGHLIGHTS = 3;    // queued triggers during cooldown lock

// ================================
// CLIENT VERSION — served at /api/version for the client auto-updater.
// Update when a new client build is uploaded to the CDN.
// ================================
const LATEST_CLIENT_VERSION = {
  version: '0.1.30',
  downloadUrl: 'https://peakbu-media.nyc3.cdn.digitaloceanspaces.com/releases/PeakAbu-Setup-0.1.30.exe',
  releaseNotes: 'Database upgrade for improved reliability at scale.'
};

module.exports = {
  JWT_SECRET,
  PORT,
  ALLOWED_ORIGINS,
  BCRYPT_ROUNDS,
  JWT_EXPIRY,
  SPACES_REGION,
  SPACES_BUCKET,
  SPACES_ENDPOINT,
  SPACES_CDN_BASE,
  UPLOADS_DIR,
  USERS_FILE,
  SESSIONS_FILE,
  MAX_SESSIONS,
  MAX_MEMBERS_PER_SESSION,
  MAX_HIGHLIGHTS_PER_SESSION,
  ALLOWED_CLIP_DURATIONS,
  SESSION_TTL,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
  SOCKET_RATE_MAX,
  SOCKET_RATE_WINDOW,
  MAX_PENDING_HIGHLIGHTS,
  LATEST_CLIENT_VERSION
};
