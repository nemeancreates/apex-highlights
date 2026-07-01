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
    origin: '*', // allows any client to connect (we'll lock this down later)
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// --- In-memory storage (replaced with a database later) ---
const sessions = new Map(); // sessionCode -> session object

// --- Helper: generate a short session code ---
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/1/O/0 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// --- HTTP Routes ---

// Health check (just confirms the server is running)
app.get('/', (req, res) => {
  res.json({ status: 'Peak-Abu server running', activeSessions: sessions.size });
});

// Create a new session
app.post('/sessions', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  let code = generateCode();
  // make sure code isn't already in use (very unlikely, but just in case)
  while (sessions.has(code)) {
    code = generateCode();
  }

  const session = {
    id: uuidv4(),
    code: code,
    createdBy: username,
    createdAt: new Date().toISOString(),
    members: [] // populated when people connect via WebSocket
  };

  sessions.set(code, session);
  console.log(`Session created: ${code} by ${username}`);

  res.status(201).json({ sessionCode: code, sessionId: session.id });
});

// Get session info
app.get('/sessions/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
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

  // When a client joins a session
  socket.on('join-session', ({ code, username }) => {
    const sessionCode = code.toUpperCase();
    const session = sessions.get(sessionCode);

    if (!session) {
      socket.emit('error-message', { message: 'Session not found' });
      return;
    }

    // Add this user to the session
    const member = {
      socketId: socket.id,
      username: username,
      isRecording: false,
      joinedAt: new Date().toISOString()
    };

    session.members.push(member);
    socket.join(sessionCode); // Socket.IO "room" so we can broadcast to the session
    socket.sessionCode = sessionCode; // remember which session this socket belongs to
    socket.username = username;

    console.log(`${username} joined session ${sessionCode}`);

    // Tell the person who joined: here's who's already in the session
    socket.emit('session-joined', {
      code: sessionCode,
      members: session.members.map(m => ({
        username: m.username,
        isRecording: m.isRecording
      }))
    });

    // Tell everyone else in the session: someone new joined
    socket.to(sessionCode).emit('member-joined', {
      username: username
    });
  });

  // When a client starts or stops recording
  socket.on('recording-status', ({ isRecording }) => {
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;

    const session = sessions.get(sessionCode);
    if (!session) return;

    const member = session.members.find(m => m.socketId === socket.id);
    if (member) {
      member.isRecording = isRecording;
    }

    // Tell everyone in the session about the recording status change
    io.to(sessionCode).emit('member-recording-update', {
      username: socket.username,
      isRecording: isRecording
    });

    console.log(`${socket.username} ${isRecording ? 'started' : 'stopped'} recording in ${sessionCode}`);
  });

  // When a client disconnects
  socket.on('disconnect', () => {
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;

    const session = sessions.get(sessionCode);
    if (!session) return;

    // Remove them from the session
    session.members = session.members.filter(m => m.socketId !== socket.id);

    console.log(`${socket.username} left session ${sessionCode} (${session.members.length} remaining)`);

    // Tell everyone else
    socket.to(sessionCode).emit('member-left', {
      username: socket.username
    });

    // If session is empty, clean it up after 5 minutes
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