// ================================
// SOCKETS — connection wiring: auth middleware, time-sync, join-session,
// clip duration, recording status, disconnect. Highlight save logic lives
// in ./highlights.js.
// ================================
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode } = require('../utils');
const { MAX_MEMBERS_PER_SESSION, ALLOWED_CLIP_DURATIONS } = require('../config');
const { sessions, saveSessionsToDisk } = require('../stores');
const { checkSocketRate, removeSocketRate } = require('../ratelimit');
const { socketAuth } = require('../auth');
const { registerHighlightHandlers } = require('./highlights');

function initSockets(io) {
  io.use(socketAuth);

  io.on('connection', (socket) => {
    log('debug', 'client_connected', { socketId: socket.id });

    // ================================
    // TIME SYNC — clients ping to measure their offset from server clock.
    // Uses ack callback; doesn't consume the main socket rate budget,
    // but has its own light cap to prevent spam.
    // ================================
    socket._timeSyncCount = 0;
    socket._timeSyncReset = Date.now() + 60000;
    socket.on('time-sync', (clientT0, ack) => {
      if (typeof ack !== 'function') return;
      const now = Date.now();
      if (now > socket._timeSyncReset) { socket._timeSyncCount = 0; socket._timeSyncReset = now + 60000; }
      if (++socket._timeSyncCount > 60) return;
      ack({ serverTime: now });
    });

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

      log('info', 'member_joined', { session: sessionCode, username: cleanUsername });

      socket.emit('session-joined', {
        code: sessionCode,
        createdBy: session.createdBy,
        clipDuration: session.clipDuration,
        members: session.members.map(m => ({
          username: m.username,
          isRecording: m.isRecording
        }))
      });

      socket.to(sessionCode).emit('member-joined', { username: cleanUsername });
    });

    // ================================
    // CLIP DURATION — host only
    // ================================
    socket.on('set-clip-duration', ({ duration }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;

      const session = sessions.get(sessionCode);
      if (!session) return;

      // Only the session creator can change clip duration
      if (session.createdBy !== socket.username) {
        socket.emit('error-message', { message: 'Only the session host can change clip duration' });
        return;
      }

      if (!ALLOWED_CLIP_DURATIONS.includes(duration)) {
        socket.emit('error-message', { message: 'Invalid clip duration' });
        return;
      }

      session.clipDuration = duration;
      saveSessionsToDisk();

      log('info', 'clip_duration_changed', { session: sessionCode, duration, setBy: socket.username });

      // Tell everyone in the session (including the host)
      io.to(sessionCode).emit('clip-duration-changed', {
        duration,
        setBy: socket.username
      });
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

      log('info', 'recording_status', { session: sessionCode, username: socket.username, isRecording });
    });

    // Highlight save broadcast + lock/queue machinery
    registerHighlightHandlers(io, socket);

    socket.on('disconnect', () => {
      removeSocketRate(socket.id);
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;

      const session = sessions.get(sessionCode);
      if (!session) return;

      session.members = session.members.filter(m => m.socketId !== socket.id);
      log('info', 'member_left', { session: sessionCode, username: socket.username, remaining: session.members.length });

      socket.to(sessionCode).emit('member-left', { username: socket.username });

      if (session.members.length === 0) {
        setTimeout(() => {
          const current = sessions.get(sessionCode);
          if (current && current.members.length === 0) {
            if (current.uploads && current.uploads.length > 0) {
              log('info', 'session_archived', { session: sessionCode, uploads: current.uploads.length });
              saveSessionsToDisk();
            } else {
              // Empty + no uploads: hold it for the full TTL anyway so a squad
              // that disbands and regroups can rejoin the same code. The purge
              // sweep will collect it. (Previously deleted here after 5min,
              // and only from the in-memory Map — the SQLite row survived and
              // got resurrected on the next restart.)
              log('info', 'session_idle_empty', { session: sessionCode });
            }
          }
        }, 5 * 60 * 1000);
      }
    });
  });
}

module.exports = { initSockets };
