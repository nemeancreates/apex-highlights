// ================================
// CONFIG — every tunable constant lives here.
// Version bumps: edit LATEST_CLIENT_VERSION below, plus client/package.json
// and the version-tag span in client/index.html.
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

// --- Cloudflare R2 (S3-compatible object storage) ---
// Migrated from DigitalOcean Spaces — zero egress fees was the deciding
// factor. spaces.js is unchanged in name/exports since R2 speaks the same
// S3 API; only these values differ.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || null;
const SPACES_REGION = 'auto'; // R2 requires the literal string "auto"
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'peakbu-media';
const SPACES_ENDPOINT = R2_ACCOUNT_ID
  ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : null;
const SPACES_CDN_BASE = process.env.SPACES_CDN_BASE || null;

// --- Paths ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// --- Capacity limits ---
const MAX_SESSIONS = 100;
const MAX_MEMBERS_PER_SESSION = 30;
const MAX_HIGHLIGHTS_PER_SESSION = 3600; // fallback in seconds, matches t1 Free floor

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

// --- Redemption attempt limiting ---
const REDEEM_ATTEMPT_MAX = 10;           // failed attempts per window, per ACCOUNT
const REDEEM_ATTEMPT_WINDOW = 3600000;   // 1 hour

// --- Registration limiting ---
const REGISTER_IP_MAX = 5;               // new accounts per window, per IP
const REGISTER_IP_WINDOW = 86400000;     // 24 hours

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
// NEW — clipCap in seconds of highlight time per session
const TIERS = {
  t1: { label: 'Free',    canHost: true, memberCap: 2,  clipCap: 3600,   sessionsPerMonth: 6,   retentionDays: 1,  hasAiReel: false, aiReelMaxSec: 0,    reelPriority: 0 },
  t2: { label: 'Creator', canHost: true, memberCap: 5,  clipCap: 36000,  sessionsPerMonth: 20,  retentionDays: 30,  hasAiReel: false, aiReelMaxSec: 0,    reelPriority: 0 },
  t3: { label: 'Squad',   canHost: true, memberCap: 11, clipCap: 79200,  sessionsPerMonth: 45,  retentionDays: 30, hasAiReel: true,  aiReelMaxSec: 900,  reelPriority: 0 },
  t4: { label: 'Pro',     canHost: true, memberCap: 25, clipCap: 144000, sessionsPerMonth: 110, retentionDays: 60, hasAiReel: true,  aiReelMaxSec: 1800, reelPriority: 1 },
  // Founder — $1,500 lifetime Kickstarter tier.
  t5: { label: 'Founder', canHost: true, memberCap: 41, clipCap: 144000, sessionsPerMonth: 200, retentionDays: 60, hasAiReel: true,  aiReelMaxSec: 1800, reelPriority: 2 }
};

// Ordering for tier comparisons — used to stop a timed code from
// "stacking" on top of an equal-or-higher active subscription (see
// auth.js /auth/redeem). Lifetime codes bypass this check entirely.
const TIER_ORDER = ['t1', 't2', 't3', 't4', 't5'];
// --- Admin (redemption code generation only — never exposed to the client) ---
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// --- Discord linking (OAuth) ---
// Not fail-fast like JWT_SECRET — Discord linking is an additive feature,
// not core to the server running. If unset, DISCORD_ENABLED is false and
// the /auth/discord/* routes return a clean 503 instead of crashing boot.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || null;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || null;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'https://peakabu.app/auth/discord/callback';
const DISCORD_ENABLED = Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET);
if (!DISCORD_ENABLED) {
  console.warn('Discord linking disabled: DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not set in .env');
}

// --- Discord bot (role sync) ---
// Separate from DISCORD_ENABLED above — linking can work independently of
// role sync being configured, so this gets its own flag and its own clean
// no-op if unset rather than crashing boot.
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const DISCORD_ROLE_MAP = {
  t1: process.env.DISCORD_ROLE_T1 || null,
  t2: process.env.DISCORD_ROLE_T2 || null,
  t3: process.env.DISCORD_ROLE_T3 || null,
  t4: process.env.DISCORD_ROLE_T4 || null,
  t5: process.env.DISCORD_ROLE_T5 || null
};
const DISCORD_BOT_ENABLED = Boolean(
  DISCORD_BOT_TOKEN && DISCORD_GUILD_ID &&
  DISCORD_ROLE_MAP.t1 && DISCORD_ROLE_MAP.t2 && DISCORD_ROLE_MAP.t3 && DISCORD_ROLE_MAP.t4 && DISCORD_ROLE_MAP.t5
);
if (!DISCORD_BOT_ENABLED) {
  console.warn('Discord role sync disabled: DISCORD_BOT_TOKEN / DISCORD_GUILD_ID / DISCORD_ROLE_T1-T4 not fully set in .env');
}

// --- Redemption codes ---
const REDEMPTION_CODES_FILE = path.join(__dirname, 'redemption-codes.json');
const SYSTEM_FLAGS_FILE = path.join(__dirname, 'system-flags.json');

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
  version: '0.1.62',
  downloadUrl: 'https://pub-2480e9beab9c4e958815881370670616.r2.dev/releases/peak-abu-setup-0.1.62.exe',
  releaseNotes: "Improved reliability for saved settings across updates, and your login is now stored encrypted."
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
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_ENABLED,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_MAP,
  DISCORD_BOT_ENABLED,
  REDEMPTION_CODES_FILE,
  SYSTEM_FLAGS_FILE,
  BANDWIDTH_ALERT_BYTES,
  LATEST_CLIENT_VERSION,
  REDEEM_ATTEMPT_MAX,
  REDEEM_ATTEMPT_WINDOW,
  REGISTER_IP_MAX,
  REGISTER_IP_WINDOW
};