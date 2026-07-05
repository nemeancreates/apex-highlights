const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const helmet = require('helmet');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '7d';
const JWT_SECRET = process.env.JWT_SECRET || null;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Set it and restart.');
  process.exit(1);
}

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// ================================
// DIGITALOCEAN SPACES (S3-compatible object storage)
// ================================
const SPACES_REGION = process.env.SPACES_REGION || 'nyc3';
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'peakbu-media';
const SPACES_ENDPOINT = `https://${SPACES_REGION}.digitaloceanspaces.com`;
const SPACES_CDN_BASE = `https://${SPACES_BUCKET}.${SPACES_REGION}.cdn.digitaloceanspaces.com`;

let spacesClient = null;
if (process.env.SPACES_KEY && process.env.SPACES_SECRET) {
  spacesClient = new S3Client({
    endpoint: SPACES_ENDPOINT,
    region: SPACES_REGION,
    credentials: {
      accessKeyId: process.env.SPACES_KEY,
      secretAccessKey: process.env.SPACES_SECRET
    }
  });
  console.log('Spaces configured:', SPACES_BUCKET, SPACES_REGION);
} else {
  console.log('WARNING: Spaces not configured — SPACES_KEY/SPACES_SECRET missing, uploads will stay local');
}

// Push a local file to Spaces, return its CDN URL. Deletes the local file on success.
async function uploadToSpaces(localPath, objectKey, contentType) {
  const fileBuffer = fs.readFileSync(localPath);
  await spacesClient.send(new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  try { fs.unlinkSync(localPath); } catch (e) {}
  return `${SPACES_CDN_BASE}/${objectKey}`;
}

// Delete an object from Spaces by its key (for retention/purge)
async function deleteFromSpaces(objectKey) {
  if (!spacesClient) return;
  try {
    await spacesClient.send(new DeleteObjectCommand({ Bucket: SPACES_BUCKET, Key: objectKey }));
  } catch (e) {
    log('warn', 'spaces_delete_failed', { key: objectKey, error: e.message });
  }
}

// ================================
// STRUCTURED LOGGING
// ================================
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, event, data = {}) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;

  // Never log sensitive fields
  const REDACTED_KEYS = ['password', 'token', 'secret', 'key', 'auth', 'cookie'];
  const safe = Object.fromEntries(
    Object.entries(data).filter(([k]) => !REDACTED_KEYS.some(r => k.toLowerCase().includes(r)))
  );

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...safe
  };

  // Output as JSON — one line per event, easy to grep/parse
  console.log(JSON.stringify(entry));
}

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost', 'http://localhost:3000'];

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", "blob:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com"],
      imgSrc: ["'self'", "data:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com"]
    }
  }
}));
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '1mb' }));

// Serve the web player
app.use('/player', express.static(path.join(__dirname, '..', 'web-player')));

// Serve uploaded videos and thumbnails
app.use('/media', express.static(path.join(__dirname, 'uploads')));

// ================================
// THUMBNAIL GENERATION
// ================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ================================
// THUMBNAIL QUEUE (memory-constrained droplet: one ffmpeg at a time)
// ================================
const thumbnailQueue = [];
let thumbnailRunning = false;

function enqueueThumbnail(videoPath, thumbnailPath, onDone) {
  thumbnailQueue.push({ videoPath, thumbnailPath, onDone });
  processThumbnailQueue();
}

async function processThumbnailQueue() {
  if (thumbnailRunning || thumbnailQueue.length === 0) return;
  thumbnailRunning = true;
  const job = thumbnailQueue.shift();
  try {
    const ok = await generateThumbnail(job.videoPath, job.thumbnailPath);
    if (ok && typeof job.onDone === 'function') job.onDone();
  } catch (e) {
    log('warn', 'thumbnail_queue_error', { error: e.message });
  } finally {
    thumbnailRunning = false;
    processThumbnailQueue();
  }
}function generateThumbnail(videoPath, thumbnailPath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-i', videoPath,
      '-ss', '00:00:01',      // grab frame at 1 second
      '-vframes', '1',         // one frame only
      '-vf', 'scale=480:-1',  // 480px wide, maintain aspect ratio
      '-q:v', '3',             // JPEG quality (2=best, 5=good enough)
      '-y',
      thumbnailPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        log("info", "thumbnail_generated", { file: path.basename(thumbnailPath) });
        resolve(true);
      } else {
        log("warn", "thumbnail_failed", { file: path.basename(videoPath) });
        resolve(false);
      }
    });

    ffmpeg.on('error', () => {
      log("warn", "ffmpeg_unavailable", { context: "thumbnail" });
      resolve(false);
    });
  });
}

// ================================
// RE-ENCODING (AV1 for bandwidth savings)
// ================================
function reencodeVideo(inputPath, outputPath) {
  return new Promise((resolve) => {
    // SVT-AV1: preset 6 (speed/quality balance), crf 35 (good quality, ~40% smaller than h264)
    const ffmpeg = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'libsvtav1',
      '-preset', '6',
      '-crf', '35',
      '-c:a', 'libopus',
      '-b:a', '128k',
      '-y',
      outputPath
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        log("info", "reencode_complete", { file: path.basename(outputPath) });
        resolve(true);
      } else {
        log("warn", "reencode_failed", { file: path.basename(inputPath) });
        resolve(false);
      }
    });

    ffmpeg.on('error', () => {
      log("error", "ffmpeg_error", { context: "reencode" });
      resolve(false);
    });
  });
}



// ================================
// SECURITY: Content-type verification
// ================================

// MP4 magic bytes: ftyp box appears at byte 4-7
// Common MP4 signatures
const MP4_SIGNATURES = [
  Buffer.from([0x66, 0x74, 0x79, 0x70]), // ftyp
  Buffer.from([0x6D, 0x6F, 0x6F, 0x76]), // moov
  Buffer.from([0x66, 0x72, 0x65, 0x65]), // free
  Buffer.from([0x6D, 0x64, 0x61, 0x74]), // mdat
];

function verifyMP4(filePath) {
  try {
    const fd = require('fs').openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    require('fs').readSync(fd, buf, 0, 12, 0);
    require('fs').closeSync(fd);
    // MP4: bytes 4-7 contain a known box type
    const boxType = buf.slice(4, 8);
    return MP4_SIGNATURES.some(sig => sig.equals(boxType));
  } catch(e) {
    return false;
  }
}

function verifyJSON(filePath) {
  try {
    const content = require('fs').readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    // Validate expected metadata structure
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (parsed.version === undefined) return false;
    if (typeof parsed.saveTimeUTC !== 'number') return false;
    if (typeof parsed.startTimeUTC !== 'number') return false;
    // Sanity check timestamps (must be plausible Unix ms — after 2020, before 2100)
    const MIN_TS = 1577836800000; // 2020-01-01
    const MAX_TS = 4102444800000; // 2100-01-01
    if (parsed.saveTimeUTC < MIN_TS || parsed.saveTimeUTC > MAX_TS) return false;
    if (parsed.startTimeUTC < MIN_TS || parsed.startTimeUTC > MAX_TS) return false;
    return true;
  } catch(e) {
    return false;
  }
}

// ================================
// SECURITY: Generic error responses
// ================================

// Never leak internal paths, stack traces, or implementation details
function safeError(res, status, message) {
  res.status(status).json({ error: message });
}

// ================================
// SERVER-SIDE COMPOSITING
// ================================
const compositeJobs = new Map();
const COMPOSITE_DIR = path.join(os.tmpdir(), 'peak-abu-composites');
if (!fs.existsSync(COMPOSITE_DIR)) fs.mkdirSync(COMPOSITE_DIR, { recursive: true });

// Clean up stale composite jobs every hour
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of compositeJobs) {
    if (now - job.createdAt > 3600000) {
      if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
      compositeJobs.delete(jobId);
    }
  }
}, 3600000);

function getGridDimensions(count) {
  if (count === 1) return { cols: 1, rows: 1 };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  if (count <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(count / 4) };
}

async function runComposite(session, code, outputPath, jobId) {
  const uploads = session.uploads;
  const sessionDir = path.join(UPLOADS_DIR, code);

  // Load metadata for sync offsets
  const clipData = [];
  let earliestStart = Infinity;

  for (const upload of uploads) {
    const videoPath = path.join(sessionDir, upload.videoFile);
    if (!fs.existsSync(videoPath)) continue;

    let startTimeUTC = null;
    if (upload.metadataFile) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, upload.metadataFile), 'utf8'));
        startTimeUTC = meta.startTimeUTC || null;
        if (startTimeUTC) earliestStart = Math.min(earliestStart, startTimeUTC);
      } catch(e) {}
    }

    clipData.push({ videoPath, startTimeUTC, username: upload.username });
  }

  if (clipData.length === 0) {
    compositeJobs.get(jobId).status = 'failed';
    return;
  }

  // Calculate per-clip offsets in seconds
  clipData.forEach(c => {
    c.offsetSec = (earliestStart !== Infinity && c.startTimeUTC)
      ? (c.startTimeUTC - earliestStart) / 1000
      : 0;
  });

  const count = clipData.length;
  const { cols, rows } = getGridDimensions(count);
  const cellW = 640;
  const cellH = 360;

  // Build FFmpeg args
  const ffmpegArgs = [];

  // Inputs with time offsets
  clipData.forEach(c => {
    if (c.offsetSec > 0) ffmpegArgs.push('-itsoffset', String(c.offsetSec.toFixed(3)));
    ffmpegArgs.push('-i', c.videoPath);
  });

  // filter_complex: scale each input, xstack into grid, mix audio
  let filterComplex = '';

  // Scale all inputs to uniform cell size
  clipData.forEach((_, i) => {
    filterComplex += `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[v${i}];`;
  });

  if (count === 1) {
    filterComplex += `[v0]copy[out]`;
  } else {
    // Build pixel-position layout string
    const layoutPositions = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r * cols + c >= count) break;
        layoutPositions.push(`${c * cellW}_${r * cellH}`);
      }
    }
    const scaledRefs = clipData.map((_, i) => `[v${i}]`).join('');
    filterComplex += `${scaledRefs}xstack=inputs=${count}:layout=${layoutPositions.join('|')}[out]`;
  }

  // Mix audio from all clips
  const audioRefs = clipData.map((_, i) => `[${i}:a]`).join('');
  filterComplex += `;${audioRefs}amix=inputs=${count}:duration=longest:normalize=0[aout]`;

  ffmpegArgs.push(
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-map', '[aout]',
    '-c:v', 'libsvtav1',
    '-preset', '6',
    '-crf', '35',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-y',
    outputPath
  );

  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stderr.on('data', d => {
      const line = d.toString().trim();
      if (line.includes('frame=') || line.includes('error')) console.log('Composite:', line);
    });

    ffmpeg.on('close', (exitCode) => {
      const job = compositeJobs.get(jobId);
      if (!job) return resolve();
      if (exitCode === 0 && fs.existsSync(outputPath)) {
        job.status = 'done';
        job.fileSize = fs.statSync(outputPath).size;
        log("info", "composite_done", { jobId, sizeMB: (job.fileSize/1024/1024).toFixed(1) });
      } else {
        job.status = 'failed';
        log("warn", "composite_failed", { jobId });
      }
      resolve();
    });

    ffmpeg.on('error', () => {
      const job = compositeJobs.get(jobId);
      if (job) job.status = 'failed';
      resolve();
    });
  });
}

// ================================
// SECURITY: Upload configuration
// ================================
const ALLOWED_EXTENSIONS = ['.mp4', '.json'];
const MAX_FILE_SIZE = 500 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const code = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const sessionDir = path.join(UPLOADS_DIR, code);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const baseName = path.basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .substring(0, 100);
      const safeName = `${baseName}_${Date.now()}${ext}`;
      cb(null, safeName);
    }
  }),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error('Invalid file type. Only .mp4 and .json allowed.'));
    }
    cb(null, true);
  }
});

// ================================
// SECURITY: Rate limiting (HTTP)
// ================================
const rateLimits = new Map();
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW = 60000;

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  let entry = rateLimits.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimits.set(ip, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  next();
}

app.use(rateLimit);

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetTime) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ================================
// SECURITY: Rate limiting (WebSocket)
// ================================
const socketRateLimits = new Map();
const SOCKET_RATE_MAX = 20;
const SOCKET_RATE_WINDOW = 10000;

function checkSocketRate(socketId) {
  const now = Date.now();
  let entry = socketRateLimits.get(socketId);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + SOCKET_RATE_WINDOW };
    socketRateLimits.set(socketId, entry);
  }

  entry.count++;
  return entry.count <= SOCKET_RATE_MAX;
}

// ================================
// SECURITY: Input sanitization
// ================================
function sanitizeUsername(input) {
  if (typeof input !== 'string') return null;
  const clean = input.trim().replace(/[^a-zA-Z0-9 _\-]/g, '');
  if (clean.length < 1 || clean.length > 24) return null;
  return clean;
}

function sanitizeCode(input) {
  if (typeof input !== 'string') return null;
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);
}

// ================================
// SECURITY: Capacity limits
// ================================
const MAX_SESSIONS = 100;
const MAX_MEMBERS_PER_SESSION = 30;

const sessions = new Map();
// ================================
// USERS STORE + PERSISTENCE
// ================================
const USERS_FILE = path.join(__dirname, 'users.json');
const users = new Map();

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

// ================================
// AUTH MIDDLEWARE
// ================================
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return safeError(res, 401, 'Authentication required');
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return safeError(res, 401, 'Invalid or expired token. Please log in again.');
  }
}
// ================================
// SESSION PERSISTENCE
// ================================
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSION_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days in ms

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
    const data = Array.from(sessions.values());
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log('warn', 'sessions_save_failed', { error: err.message });
  }
}

// Purge expired sessions once per day, deleting their Spaces objects too
setInterval(async () => {
  const now = Date.now();
  let purged = 0;
  for (const [code, session] of sessions) {
    if (now - new Date(session.createdAt).getTime() > SESSION_TTL) {
      // Delete all Spaces objects for this session before dropping it
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// --- HTTP Routes ---
// ================================
// AUTH ROUTES
// ================================
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  const clean = (username || '').trim().replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!clean || clean.length < 2 || clean.length > 24) {
    return safeError(res, 400, 'Username must be 2-24 characters: letters, numbers, _ or -');
  }
  if (!password || password.length < 8 || password.length > 128) {
    return safeError(res, 400, 'Password must be 8-128 characters');
  }
  if (users.has(clean.toLowerCase())) {
    return safeError(res, 409, 'Username already taken');
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = { username: clean, passwordHash, createdAt: new Date().toISOString() };
  users.set(clean.toLowerCase(), user);
  saveUsersToDisk();
  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  log('info', 'user_registered', { username: clean });
  return res.status(201).json({ token, username: clean });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const clean = (username || '').trim();
  if (!clean || !password) {
    return safeError(res, 400, 'Username and password required');
  }
  const user = users.get(clean.toLowerCase());
  // Always hash to prevent timing attacks even on miss
  const hashToCheck = user ? user.passwordHash : '$2b$12$invalidhashfortimingprotection000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);
  if (!user || !valid) {
    return safeError(res, 401, 'Invalid username or password');
  }
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  log('info', 'user_login', { username: user.username });
  return res.status(200).json({ token, username: user.username });
});

app.get('/auth/me', requireAuth, (req, res) => {
  return res.json({ username: req.user.username });
});
app.get('/', (req, res) => {
  res.json({ status: 'Peak-Abu server running', activeSessions: sessions.size });
});

app.post('/sessions', requireAuth, (req, res) => {
  const username = sanitizeUsername(req.user.username);
  if (!username) {
    return safeError(res, 400, 'Invalid account username');
  }

  if (sessions.size >= MAX_SESSIONS) {
    return safeError(res, 503, 'Server is at capacity. Try again later.');
  }

  let code = generateCode();
  while (sessions.has(code)) code = generateCode();

  const session = {
    id: uuidv4(),
    code,
    createdBy: username,
    createdAt: new Date().toISOString(),
    members: [],
    uploads: []
  };

  sessions.set(code, session);
  log("info", "session_created", { code, createdBy: username });
  log("info", "session_created", { code, createdBy: username });

  res.status(201).json({ sessionCode: code, sessionId: session.id });
});

app.get('/sessions/:code', (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Invalid session code' });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    code: session.code,
    createdBy: session.createdBy,
    createdAt: session.createdAt,
    members: session.members.map(m => ({
      username: m.username,
      isRecording: m.isRecording,
      joinedAt: m.joinedAt
    })),
    uploads: session.uploads
  });
});

// ================================
// UPLOAD ENDPOINT
// ================================
  app.post('/sessions/:code/upload', requireAuth, (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Invalid session code' });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const uploaderName = sanitizeUsername(req.user.username);
  if (!uploaderName) {
    return safeError(res, 400, 'Invalid account username');
  }

  const isMember = session.members.some(m => m.username === uploaderName) ||
                   session.createdBy === uploaderName;
  if (!isMember) {
    return res.status(403).json({ error: 'You are not a member of this session' });
  }

  const MAX_UPLOADS_PER_SESSION = 50;
  if (session.uploads.length >= MAX_UPLOADS_PER_SESSION) {
    return safeError(res, 400, 'Upload limit reached for this session.');
  }

  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'metadata', maxCount: 1 }
  ])(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return safeError(res, 413, 'File too large. Maximum 500MB.');
        }
        return safeError(res, 400, 'Upload failed. Check file type and size.');
      }
      return safeError(res, 400, 'Upload failed.');
    }

    const videoFile = req.files && req.files.video && req.files.video[0];
    if (!videoFile) {
      return safeError(res, 400, 'No video file provided.');
    }

    const resolvedPath = path.resolve(videoFile.path);
    if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
      fs.unlinkSync(resolvedPath);
      return safeError(res, 400, 'Invalid upload');
    }

    // SECURITY: Verify actual file bytes match declared type
    if (!verifyMP4(videoFile.path)) {
      fs.unlinkSync(videoFile.path);
      log('warn', 'upload_rejected', { reason: 'invalid_mp4_bytes', session: code, username: uploaderName });
      return safeError(res, 400, 'Invalid file content. File must be a valid MP4.');
    }

    // SECURITY: Verify metadata JSON structure if provided
    if (req.files.metadata) {
      const metaFile = req.files.metadata[0];
      if (!verifyJSON(metaFile.path)) {
        fs.unlinkSync(videoFile.path);
        fs.unlinkSync(metaFile.path);
        log('warn', 'upload_rejected', { reason: 'invalid_metadata', session: code, username: uploaderName });
        return safeError(res, 400, 'Invalid metadata format.');
      }
    }

    // Generate thumbnail locally first (needed before we push to Spaces), then
    // upload video + thumbnail + metadata to Spaces and remove local copies.
    const thumbName = `thumb_${path.basename(videoFile.filename, '.mp4')}.jpg`;
    const thumbPath = path.join(path.dirname(videoFile.path), thumbName);
    const metaFileObj = req.files.metadata ? req.files.metadata[0] : null;

    // Object keys in Spaces: organize by session for easy purge later
    const videoKey = `${code}/${videoFile.filename}`;
    const thumbKey = `${code}/${thumbName}`;
    const metaKey = metaFileObj ? `${code}/${metaFileObj.filename}` : null;

    // Find the upload record we just pushed so we can fill in URLs as they resolve
    const findRecord = () => session.uploads.find(u => u.videoFile === videoFile.filename);

    if (spacesClient) {
      // Thumbnail must be generated before upload. Queue it (one ffmpeg at a
      // time), and once done, push everything to Spaces.
      enqueueThumbnail(videoFile.path, thumbPath, async () => {
        try {
          const videoUrl = await uploadToSpaces(videoFile.path, videoKey, 'video/mp4');
          const rec = findRecord();
          if (rec) { rec.videoUrl = videoUrl; rec.videoKey = videoKey; }

          if (fs.existsSync(thumbPath)) {
            const thumbUrl = await uploadToSpaces(thumbPath, thumbKey, 'image/jpeg');
            const r2 = findRecord();
            if (r2) { r2.thumbnailUrl = thumbUrl; r2.thumbnailKey = thumbKey; }
          }

          if (metaFileObj && fs.existsSync(metaFileObj.path)) {
            const metaUrl = await uploadToSpaces(metaFileObj.path, metaKey, 'application/json');
            const r3 = findRecord();
            if (r3) { r3.metadataUrl = metaUrl; r3.metadataKey = metaKey; }
          }

          saveSessionsToDisk();
          log('info', 'spaces_upload_complete', { session: code, key: videoKey });
        } catch (e) {
          log('error', 'spaces_upload_failed', { session: code, error: e.message });
        }
      });
    } else {
      // Fallback: Spaces not configured, keep old local behavior
      enqueueThumbnail(videoFile.path, thumbPath, () => {
        const rec = findRecord();
        if (rec) rec.thumbnailFile = thumbName;
      });
    }


// DISABLED_AV1: 
// DISABLED_AV1:     reencodeVideo(videoFile.path, reencPath).then(reencOk => {
// DISABLED_AV1:       if (reencOk) {
// DISABLED_AV1:         const record = session.uploads.find(u => u.videoFile === videoFile.filename);
// DISABLED_AV1:         if (record) {
// DISABLED_AV1:           const origSize = videoFile.size;
// DISABLED_AV1:           const newSize = require('fs').statSync(reencPath).size;
// DISABLED_AV1:           const saving = (((origSize - newSize) / origSize) * 100).toFixed(1);
// DISABLED_AV1:           log("info", "reencode_savings", { origMB: (origSize/1024/1024).toFixed(1), newMB: (newSize/1024/1024).toFixed(1), savedPct: saving });
// DISABLED_AV1: 
// DISABLED_AV1:           // Swap: replace original with re-encoded, delete original
// DISABLED_AV1:           require('fs').unlinkSync(videoFile.path);
// DISABLED_AV1:           require('fs').renameSync(reencPath, videoFile.path);
// DISABLED_AV1:           record.reencoded = true;
// DISABLED_AV1:           record.fileSize = newSize;
// DISABLED_AV1:         }
// DISABLED_AV1:       } else {
// DISABLED_AV1:         // Clean up failed re-encode attempt
// DISABLED_AV1:         if (require('fs').existsSync(reencPath)) require('fs').unlinkSync(reencPath);
// DISABLED_AV1:       }
// DISABLED_AV1:     });

    const uploadRecord = {
      id: uuidv4(),
      username: uploaderName,
      videoFile: videoFile.filename,
      metadataFile: req.files.metadata ? req.files.metadata[0].filename : null,
      thumbnailFile: null,
      videoUrl: null,       // Spaces CDN URL, filled in async
      thumbnailUrl: null,   // Spaces CDN URL, filled in async
      metadataUrl: null,    // Spaces CDN URL, filled in async
      videoKey: null,       // Spaces object key, for purge
      thumbnailKey: null,
      metadataKey: null,
      uploadedAt: new Date().toISOString(),
      fileSize: videoFile.size
    };

    session.uploads.push(uploadRecord);
    saveSessionsToDisk();

    log("info", "upload_received", { session: code, username: uploaderName, sizeMB: (videoFile.size / 1024 / 1024).toFixed(1) });

    io.to(code).emit('upload-received', {
      username: uploaderName,
      uploadId: uploadRecord.id
    });

    res.status(201).json({
      message: 'Upload successful',
      uploadId: uploadRecord.id
    });
  });
});

app.get('/sessions/:code/uploads', (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Invalid session code' });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({ uploads: session.uploads });
});


// ================================
// COMPOSITE ENDPOINTS
// ================================

// Start a composite job
app.post('/sessions/:code/composite', (req, res) => {
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Invalid session code' });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.uploads.length === 0) return res.status(400).json({ error: 'No uploads yet' });

  const jobId = uuidv4();
  const outputPath = path.join(COMPOSITE_DIR, `composite_${jobId}.mp4`);

  compositeJobs.set(jobId, {
    status: 'processing',
    outputPath,
    createdAt: Date.now()
  });

  res.status(202).json({ jobId });

  // Run async — don't await
  runComposite(session, code, outputPath, jobId);
});

// Poll composite job status
app.get('/sessions/:code/composite/:jobId', (req, res) => {
  const job = compositeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    status: job.status,
    downloadUrl: job.status === 'done' ? `/composite/${req.params.jobId}/download` : null,
    fileSize: job.fileSize || null
  });
});

// Download composite file
app.get('/composite/:jobId/download', (req, res) => {
  const job = compositeJobs.get(req.params.jobId);
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });

  res.download(job.outputPath, 'peak-abu-composite.mp4', (err) => {
    if (!err) {
      // Clean up 60s after download
      setTimeout(() => {
        if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
        compositeJobs.delete(req.params.jobId);
      }, 60000);
    }
  });
});

// --- WebSocket ---
// Require valid JWT on every Socket.IO connection
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('auth_required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    next(new Error('auth_invalid'));
  }
});
io.on('connection', (socket) => {
  log("debug", "client_connected", { socketId: socket.id });

  socket.on('join-session', ({ code, username }) => {
    if (!checkSocketRate(socket.id)) {
      socket.emit('error-message', { message: 'Too many requests. Slow down.' });
      return;
    }

    const sessionCode = sanitizeCode(code);
    const cleanUsername = sanitizeUsername(socket.user.username);

    if (!sessionCode || !cleanUsername) {
      socket.emit('error-message', { message: 'Invalid session code or username' });
      return;
    }

    const session = sessions.get(sessionCode);
    if (!session) { socket.emit('error-message', { message: 'Session not found' }); return; }
    if (session.members.length >= MAX_MEMBERS_PER_SESSION) { socket.emit('error-message', { message: 'Session is full' }); return; }
    if (session.members.some(m => m.username === cleanUsername)) { socket.emit('error-message', { message: 'Username already taken in this session' }); return; }
    if (socket.sessionCode) { socket.emit('error-message', { message: 'Already in a session. Leave first.' }); return; }

    const member = {
      socketId: socket.id,
      username: cleanUsername,
      isRecording: false,
      joinedAt: new Date().toISOString()
    };

    session.members.push(member);
    socket.join(sessionCode);
    socket.sessionCode = sessionCode;
    socket.username = cleanUsername;

    log("info", "member_joined", { session: sessionCode, username: cleanUsername });

    socket.emit('session-joined', {
      code: sessionCode,
      members: session.members.map(m => ({
        username: m.username,
        isRecording: m.isRecording
      }))
    });

    socket.to(sessionCode).emit('member-joined', { username: cleanUsername });
  });

  socket.on('recording-status', ({ isRecording }) => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    if (typeof isRecording !== 'boolean') return;

    const member = session.members.find(m => m.socketId === socket.id);
    if (member) member.isRecording = isRecording;

    io.to(sessionCode).emit('member-recording-update', {
      username: socket.username,
      isRecording
    });

    log("info", "recording_status", { session: sessionCode, username: socket.username, isRecording });
  });

  socket.on('broadcast-save-highlight', () => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const coordinated_timestamp = Date.now();
    log("info", "highlight_triggered", { session: sessionCode, username: socket.username, ts: coordinated_timestamp });

    io.to(sessionCode).emit('coordinated-save-highlight', {
      username: socket.username,
      coordinated_timestamp
    });
  });

  socket.on('disconnect', () => {
    const sessionCode = socket.sessionCode;
    socketRateLimits.delete(socket.id);
    if (!sessionCode) return;

    const session = sessions.get(sessionCode);
    if (!session) return;

    session.members = session.members.filter(m => m.socketId !== socket.id);
    log("info", "member_left", { session: sessionCode, username: socket.username, remaining: session.members.length });

    socket.to(sessionCode).emit('member-left', { username: socket.username });

    if (session.members.length === 0) {
      setTimeout(() => {
        const current = sessions.get(sessionCode);
        if (current && current.members.length === 0) {
          if (current.uploads && current.uploads.length > 0) {
            log("info", "session_archived", { session: sessionCode, uploads: current.uploads.length });
          } else {
            sessions.delete(sessionCode);
            saveSessionsToDisk();
            log("info", "session_deleted", { session: sessionCode });
          }
        }
      }, 5 * 60 * 1000);
    }
  });
});

loadUsersFromDisk();
loadSessionsFromDisk();

server.listen(PORT, () => {
  log("info", "server_start", { port: PORT });
});