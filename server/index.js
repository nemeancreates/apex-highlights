// ================================
// PEAK-ABU SERVER — entry point. Wiring only: if logic is creeping into
// this file, it belongs in a module. Target: under 150 lines, forever.
// ================================
require('./crash-reporter');

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

// logger first — it patches console.log so every later module's output
// gets mirrored to logs/server.log
const { log } = require('./logger');
const config = require('./config');
const { safeError, sanitizeCode, downloadToFile } = require('./utils');
const { rateLimit, startRateLimitCleanup } = require('./ratelimit');
const {
  sessions,
  loadUsersFromDisk,
  loadSessionsFromDisk,
  retryPendingSpacesUploads,
  startSessionPurge
} = require('./stores');
const { initAuthRoutes } = require('./auth');
const { initSessionRoutes } = require('./routes/sessions');
const { initJoinRoutes } = require('./routes/join');
const { initUploadRoutes } = require('./routes/uploads');
const { initCommentRoutes, startCommentCleanup } = require('./routes/comments');
const { initCompositeRoutes, startCompositeCleanup } = require('./composite');
const { initSockets } = require('./sockets');
const { initAiReel } = require('./aireel');
const { loadCodesFromDisk } = require('./redemption');
const { loadFlagsFromDisk } = require('./killswitch');

// --- App + HTTP + Socket.IO ---
const app = express();
// nginx sits in front of this server, so req.ip would otherwise report
// the proxy's address (127.0.0.1) for every request — making per-IP
// limits global instead of per-client. '1' = trust exactly one hop.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  }
});

// --- Middleware ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'self'", "https://www.youtube.com"],
            // Both domains stay allowed during the R2 migration window — old
      // sessions saved before the switch still have DO Spaces URLs baked
      // into their upload records, and those need to keep loading until
      // they age out per each tier's retentionDays.
      mediaSrc: ["'self'", "blob:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com", config.SPACES_CDN_BASE],
      imgSrc: ["'self'", "data:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com", config.SPACES_CDN_BASE, "https://i.ytimg.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://peakbu-media.nyc3.cdn.digitaloceanspaces.com", config.SPACES_CDN_BASE]
    }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(cors({ origin: config.ALLOWED_ORIGINS }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit);

// --- Static serving ---
app.use('/player', express.static(path.join(__dirname, '..', 'web-player')));
app.use('/media', express.static(path.join(__dirname, 'uploads')));

// --- Tiny inline routes ---
app.get('/api/health', (req, res) => {
  res.json({ status: 'Peak-Abu server running', activeSessions: sessions.size });
});

app.get('/api/version', (req, res) => {
  res.json(config.LATEST_CLIENT_VERSION);
});

// --- Feature routes ---
initAuthRoutes(app);
initSessionRoutes(app);
initJoinRoutes(app);
initUploadRoutes(app, io);
initCommentRoutes(app, io);
initCompositeRoutes(app);
initSockets(io);

// --- Boot ---
loadUsersFromDisk();
loadSessionsFromDisk();
loadCodesFromDisk();
loadFlagsFromDisk();
retryPendingSpacesUploads();
startRateLimitCleanup();
startSessionPurge();
startCompositeCleanup();
startCommentCleanup();
initAiReel({
  app,
  sessions,
  sanitizeCode,
  safeError,
  log,
  UPLOADS_DIR: config.UPLOADS_DIR,
  downloadToFile
});

server.listen(config.PORT, () => {
  log('info', 'server_start', { port: config.PORT });
});