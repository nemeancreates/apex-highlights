const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost',
    methods: ['GET', 'POST']
  }
});

app.use(cors({ origin: 'http://localhost' }));
app.use(express.json());

// ================================
// SECURITY: Rate limiting (HTTP)
// ================================
const rateLimits = new Map();
const RATE_LIMIT_MAX = 30;
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

// Clean up stale rate limit entries every 5 minutes
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

// --- In-memory storage ---
const sessions = new Map();

// --- Helper: generate a short session code ---
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// --- HTTP Routes ---

app.get('/', (req, res) => {
  res.json({ status: 'Peak-Abu server running', activeSessions: sessions.size });
});

app.post('/sessions', (req, res) => {
  // SECURITY: Sanitize username
  const username = sanitizeUsername(req.body.username);

  if (!username) {
    return res.status(400).json({ error: 'Invalid username. Use 1-24 characters: letters, numbers, spaces, _ or -' });
  }

  // SECURITY: Capacity limit
  if (sessions.size >= MAX_SESSIONS) {
    return res.status(503).json({ error: 'Server is at capacity. Try again later.' });
  }

  let code = generateCode();
  while (sessions.has(code)) {
    code = generateCode();
  }

  const session = {
    id: uuidv4(),
    code: code,
    createdBy: username,
    createdAt: new Date().toISOString(),
    members: []
  };

  sessions.set(code, session);
  console.log(`Session created: ${code} by ${username}`);

  res.status(201).json({ sessionCode: code, sessionId: session.id });
});

app.get('/sessions/:code', (req, res) => {
  // SECURITY: Sanitize code input
  const code = sanitizeCode(req.params.code);
  if (!code) return res.status(400).json({ error: 'Invalid session code' });

  const session = sessions.get(code);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    code: session.code,
    createdBy: session.createdBy,
    createdAt: session.createdAt,
    members: session.members.map(m => ({
      username: m.username,
      isRecording: m.isRecording,
      joinedAt: m.joinedAt
    }))
  });
});

// --- WebSocket (real-time) ---
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('join-session', ({ code, username }) => {
    // SECURITY: Rate check
    if (!checkSocketRate(socket.id)) {
      socket.emit('error-message', { message: 'Too many requests. Slow down.' });
      return;
    }

    // SECURITY: Sanitize all inputs
    const sessionCode = sanitizeCode(code);
    const cleanUsername = sanitizeUsername(username);

    if (!sessionCode || !cleanUsername) {
      socket.emit('error-message', { message: 'Invalid session code or username' });
      return;
    }

    const session = sessions.get(sessionCode);

    if (!session) {
      socket.emit('error-message', { message: 'Session not found' });
      return;
    }

    // SECURITY: Prevent session from exceeding member limit
    if (session.members.length >= MAX_MEMBERS_PER_SESSION) {
      socket.emit('error-message', { message: 'Session is full' });
      return;
    }

    // SECURITY: Prevent duplicate usernames (impersonation)
    if (session.members.some(m => m.username === cleanUsername)) {
      socket.emit('error-message', { message: 'Username already taken in this session' });
      return;
    }

    // SECURITY: Prevent one socket joining multiple sessions
    if (socket.sessionCode) {
      socket.emit('error-message', { message: 'Already in a session. Leave first.' });
      return;
    }

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

    console.log(`${cleanUsername} joined session ${sessionCode}`);

    socket.emit('session-joined', {
      code: sessionCode,
      members: session.members.map(m => ({
        username: m.username,
        isRecording: m.isRecording
      }))
    });

    socket.to(sessionCode).emit('member-joined', {
      username: cleanUsername
    });
  });

  socket.on('recording-status', ({ isRecording }) => {
    // SECURITY: Rate check
    if (!checkSocketRate(socket.id)) return;

    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;

    const session = sessions.get(sessionCode);
    if (!session) return;

    // SECURITY: Validate type
    if (typeof isRecording !== 'boolean') return;

    const member = session.members.find(m => m.socketId === socket.id);
    if (member) {
      member.isRecording = isRecording;
    }

    io.to(sessionCode).emit('member-recording-update', {
      username: socket.username,
      isRecording: isRecording
    });

    console.log(`${socket.username} ${isRecording ? 'started' : 'stopped'} recording in ${sessionCode}`);
  });

  socket.on('disconnect', () => {
    const sessionCode = socket.sessionCode;
    // SECURITY: Clean up rate limit entry
    socketRateLimits.delete(socket.id);

    if (!sessionCode) return;

    const session = sessions.get(sessionCode);
    if (!session) return;

    session.members = session.members.filter(m => m.socketId !== socket.id);

    console.log(`${socket.username} left session ${sessionCode} (${session.members.length} remaining)`);

    socket.to(sessionCode).emit('member-left', {
      username: socket.username
    });

    if (session.members.length === 0) {
      setTimeout(() => {
        const current = sessions.get(sessionCode);
        if (current && current.members.length === 0) {
          sessions.delete(sessionCode);
          console.log(`Session ${sessionCode} deleted (empty)`);
        }
      }, 5 * 60 * 1000);
    }
  });
});

// --- Start server ---
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Peak-Abu server running on http://localhost:${PORT}`);
});