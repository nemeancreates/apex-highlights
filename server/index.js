// ================================
// PEAK-ABU SERVER — entry point. Wiring only: if logic is creeping into
// this file, it belongs in a module. Target: under 150 lines, forever.
// ================================
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
const { initUploadRoutes } = require('./routes/uploads');
const { initCompositeRoutes, startCompositeCleanup } = require('./composite');
const { initSockets } = require('./sockets');
const { initAiReel } = require('./aireel');

// --- App + HTTP + Socket.IO ---
const app = express();
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
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", "blob:", config.SPACES_CDN_BASE],
      imgSrc: ["'self'", "data:", config.SPACES_CDN_BASE],
      connectSrc: ["'self'", "ws:", "wss:", config.SPACES_CDN_BASE]
    }
  }
}));
app.use(cors({ origin: config.ALLOWED_ORIGINS }));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit);

// --- Static serving ---
app.use('/player', express.static(path.join(__dirname, '..', 'web-player')));
app.use('/media', express.static(path.join(__dirname, 'uploads')));

// --- Tiny inline routes ---
app.get('/', (req, res) => {
  res.json({ status: 'Peak-Abu server running', activeSessions: sessions.size });
});

app.get('/api/version', (req, res) => {
  res.json(config.LATEST_CLIENT_VERSION);
});

// --- Feature routes ---
initAuthRoutes(app);
initSessionRoutes(app);
initUploadRoutes(app, io);
initCompositeRoutes(app);
initSockets(io);

// --- Boot ---
loadUsersFromDisk();
loadSessionsFromDisk();
retryPendingSpacesUploads();
startRateLimitCleanup();
startSessionPurge();
startCompositeCleanup();
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
