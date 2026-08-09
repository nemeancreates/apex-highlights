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
const SESSION_TTL = 48 * 60 * 60 * 1000; // 48 hours — beta testing window / fallback for pre-tier sessions

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

// --- Quick comments ---
// Short timestamped notes left on a single POV clip. Every one of these is
// enforced server-side in routes/comments.js — the client's maxlength and
// disabled buttons are convenience, not enforcement.
const COMMENT_MAX_LENGTH = 100;        // characters, measured after normalization
const COMMENT_MAX_PER_CLIP = 100;      // ceiling per uploadId
const COMMENT_RATE_MAX = 3;            // posts per window, per ACCOUNT (not per IP)
const COMMENT_RATE_WINDOW = 60000;     // 1 minute
const COMMENT_MAX_TIMESTAMP_MS = 6 * 60 * 60 * 1000; // sanity bound on the anchor

// ================================
// TIERS — the single source of truth for what each tier can do.
// t1 Free / t2 Creator / t3 Squad / t4 Pro (naming matches the TIER GATE
// convention already used in aireel.js).
//
// hostSessionsPerMonth: max sessions a user of this tier can CREATE per
// calendar month (does not limit joining others' sessions).
// clipCap: max total saved highlight clips across the whole session,
// regardless of who saves them (see sockets/highlights.js + routes/uploads.js).
// retentionDays: how long an ended session's clips stay in storage before
// the purge sweep deletes them. 0 = expires in 24h (Free tier).
// freeMemberSubCap: regardless of host tier, at most this many Free-tier
// members can be in one session (prevents a Pro host's 41 seats from
// being filled by freeloaders).
// ================================
const TIERS = {
t1: { label: 'Free',    canHost: true,  memberCap: 2,  clipCap: 1800,   sessionsPerMonth: 6,  retentionDays: 1,  hasAiReel: false },
  t2: { label: 'Creator', canHost: true,  memberCap: 5,  clipCap: 43200,  sessionsPerMonth: 50, retentionDays: 3,  hasAiReel: false },
  t3: { label: 'Squad',   canHost: true,  memberCap: 11, clipCap: 86400,  sessionsPerMonth: 80, retentionDays: 7,  hasAiReel: true  },
  t4: { label: 'Pro',     canHost: true,  memberCap: 41, clipCap: 144000, sessionsPerMonth: 70, retentionDays: 14, hasAiReel: true  }
};

// Ordering for tier comparisons — used to stop a timed code from
// "stacking" on top of an equal-or-higher active subscription (see
// auth.js /auth/redeem). Lifetime codes bypass this check entirely.
const TIER_ORDER = ['t1', 't2', 't3', 't4'];

// --- Admin (redemption code generation only — never exposed to the client) ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// --- Redemption codes ---
const REDEMPTION_CODES_FILE = path.join(__dirname, 'redemption-codes.json');

// --- Bandwidth safeguard ---
// NOTE: media is served straight from the DO Spaces CDN, which never
// touches this server, so true "bytes pulled" (downloads/playback) isn't
// observable here. This tracks UPLOAD bytes only, as an approximation —
// flags any single account that has pushed more than this much in a
// calendar month so you catch outliers before they skew cost averages.
const BANDWIDTH_ALERT_BYTES = 500 * 1024 * 1024 * 1024; // 500GB

// ================================
// CLIENT VERSION — served at /api/version for the client auto-updater.
// Update when a new client build is uploaded to the CDN.
// ================================
const LATEST_CLIENT_VERSION = {
  version: '0.1.37',
  downloadUrl: 'https://peakbu-media.nyc3.cdn.digitaloceanspaces.com/releases/PeakAbu-Setup-0.1.37.exe',
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
  COMMENT_MAX_LENGTH,
  COMMENT_MAX_PER_CLIP,
  COMMENT_RATE_MAX,
  COMMENT_RATE_WINDOW,
  COMMENT_MAX_TIMESTAMP_MS,
  TIERS,
  TIER_ORDER,
  ADMIN_SECRET,
  REDEMPTION_CODES_FILE,
  BANDWIDTH_ALERT_BYTES,
  LATEST_CLIENT_VERSION
};