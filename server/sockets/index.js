// ================================
// SOCKETS — connection wiring: auth middleware, time-sync, join-session,
// clip duration, recording status, disconnect, migrate-session. Highlight
// save logic lives in ./highlights.js.
// ================================
const { log } = require('../logger');
const { sanitizeUsername, sanitizeCode } = require('../utils');
const { MAX_MEMBERS_PER_SESSION, ALLOWED_CLIP_DURATIONS, TIERS, HOST_RECORDING_INACTIVITY_MS, HOST_NOT_RECORDING_TIMEOUT_MS, HOST_WATCHDOG_INTERVAL_MS } = require('../config');
const { sessions, saveSessionsToDisk, users } = require('../stores');
const { checkSocketRate, removeSocketRate } = require('../ratelimit');
const { socketAuth, getEffectiveTier } = require('../auth');
const { registerHighlightHandlers } = require('./highlights');
const { registerAutoCaptureHandlers } = require('./autocapture');
const { createSessionForUser } = require('../routes/sessions');

// Per-IP socket connection cap. Sits before socketAuth so it rejects
// before doing JWT work. Generous ceiling — households/LANs behind one
// NAT share an IP, and 15 is well above a real squad's usage.
const socketsPerIp = new Map(); // ip -> count
const MAX_SOCKETS_PER_IP = 15;

// ================================
// KICK / BAN — host-only. Kick removes a member for this session only;
// they can rejoin with the same code. Ban does the same removal AND adds
// them to the session's persisted ban list, blocking rejoin (see the
// bannedUsernames check in join-session below). Neither affects the
// member's account — this is per-session, not a platform-wide ban.
// Defined at module scope (not inside io.on('connection')) so it isn't
// redefined on every new connection.
// ================================

function cleanIsHost(session, username) {
  return !!session && session.createdBy === username;
}

function removeMemberFromSession(io, session, sessionCode, targetUsername, mode, actingUsername) {
  const idx = session.members.findIndex(m => m.username === targetUsername);
  if (idx === -1) return { ok: false, error: 'That member is not in this session' };

  const target = session.members[idx];
  session.members.splice(idx, 1);

  // Force the target off the session room. Their socket connection stays
  // alive (unlike a full disconnect) so their client can show a message
  // and cleanly return to the lobby instead of erroring out.
  const targetSocket = io.sockets.sockets.get(target.socketId);
  if (targetSocket) {
    targetSocket.emit(mode === 'ban' ? 'banned-from-session' : 'kicked-from-session', {
      reason: mode === 'ban' ? 'Banned by the host' : 'Removed by the host'
    });
    targetSocket.leave(sessionCode);
    targetSocket.sessionCode = null;
    targetSocket.username = null;
  }

  if (mode === 'ban') {
    session.bannedUsernames = session.bannedUsernames || [];
    if (!session.bannedUsernames.includes(targetUsername)) {
      session.bannedUsernames.push(targetUsername);
    }
    saveSessionsToDisk(); // only the ban list is persisted — members[] is transient
  }

  log('info', mode === 'ban' ? 'member_banned' : 'member_kicked', {
    session: sessionCode, target: targetUsername, by: actingUsername
  });

  io.to(sessionCode).emit(mode === 'ban' ? 'member-banned' : 'member-kicked', { username: targetUsername });
  return { ok: true };
}

// ================================
// HOST INACTIVITY WATCHDOG — closes a session the host has effectively
// abandoned. Two clocks: hostIdleSince (not recording) and
// hostLastActivityAt (recording but silent). See config.js for thresholds.
// Mirrors the host-disconnect closure below but doesn't touch it — this
// only fires while the host's socket is still connected.
// ================================
function closeSessionForInactivity(io, sessionCode, session, reason) {
  if (session.closed) return;
  session.closed = true;
  saveSessionsToDisk();
  if (session.members.length > 0) {
    log('info', 'session_closed_inactivity', { session: sessionCode, reason });
    io.to(sessionCode).emit('session-closed', { reason });
    session.members = [];
  }
}

function startHostInactivityWatchdog(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [code, session] of sessions) {
      if (session.closed) continue;
      const host = session.members.find(m => m.username === session.createdBy);
      if (!host) continue; // host's socket isn't connected right now — skip

      if (host.isRecording) {
        const last = session.hostLastActivityAt || session.hostIdleSince || now;
        if (now - last > HOST_RECORDING_INACTIVITY_MS) {
          closeSessionForInactivity(io, code, session,
            `No activity from host while recording — session closed after ${Math.round(HOST_RECORDING_INACTIVITY_MS / 60000)}m`);
        }
      } else {
        const idleSince = session.hostIdleSince || now;
        if (now - idleSince > HOST_NOT_RECORDING_TIMEOUT_MS) {
          closeSessionForInactivity(io, code, session,
            `Host not recording — session closed after ${Math.round(HOST_NOT_RECORDING_TIMEOUT_MS / 60000)}m`);
        }
      }
    }
  }, HOST_WATCHDOG_INTERVAL_MS);
}

function initSockets(io) {
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const count = socketsPerIp.get(ip) || 0;
    if (count >= MAX_SOCKETS_PER_IP) return next(new Error('too_many_connections'));
    socketsPerIp.set(ip, count + 1);
    socket.on('disconnect', () => {
      const c = (socketsPerIp.get(ip) || 1) - 1;
      if (c <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, c);
    });
    next();
  });

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

      if (session.closed) {
        if (cleanUsername === session.createdBy) {
          session.closed = false; // host reconnecting reopens it
          saveSessionsToDisk();
          session.hostIdleSince = Date.now();
          session.hostLastActivityAt = null;
        } else {
          socket.emit('error-message', { message: 'Waiting on the host to reconnect — or ask them to start a new session.' });
          return;
        }
      }

      if ((session.bannedUsernames || []).includes(cleanUsername)) {
        socket.emit('error-message', { message: 'You have been banned from this session.' });
        return;
      }

      const memberCap = session.maxMembers || MAX_MEMBERS_PER_SESSION;
      if (session.members.length >= memberCap) { socket.emit('error-message', { message: 'Session is full' }); return; }
      if (session.members.some(m => m.username === cleanUsername)) { socket.emit('error-message', { message: 'Username already taken in this session' }); return; }
      if (socket.sessionCode) { socket.emit('error-message', { message: 'Already in a session. Leave first.' }); return; }

      const joinerUser = users.get(cleanUsername.toLowerCase());
      const joinerTier = getEffectiveTier(joinerUser);

      // Free-tier sub-cap: regardless of host tier, only so many Free
      // members can occupy one session — stops a Pro host's seat count
      // from being filled by freeloaders instead of paying members.
      if (joinerTier === 't1') {
        const hostTierCfg = TIERS[session.hostTier] || TIERS.t1;
        const freeCap = hostTierCfg.freeMemberSubCap;
        if (freeCap !== null && freeCap !== undefined) {
          const freeCount = session.members.filter(m => m.tier === 't1').length;
          if (freeCount >= freeCap) {
            socket.emit('error-message', { message: `This session has reached its limit of ${freeCap} Free-tier members. Ask the host, or upgrade to join.` });
            return;
          }
        }
      }

      const member = {
        socketId: socket.id,
        username: cleanUsername,
        tier: joinerTier,
        isRecording: false,
        bufferSeconds: null,   // reported by the client via 'buffer-capacity'
        joinedAt: new Date().toISOString()
      };

      session.members.push(member);
      if (cleanUsername === session.createdBy && session.hostIdleSince === undefined) {
        session.hostIdleSince = Date.now(); // covers first-ever join, not just reconnect-after-close
      }
      socket.join(sessionCode);
      socket.sessionCode = sessionCode;
      socket.username = cleanUsername;

      log('info', 'member_joined', { session: sessionCode, username: cleanUsername, tier: joinerTier });

      const weightedClipsUsed = (session.uploads || []).reduce((sum, u) => sum + (u.clipWeight || 1), 0);

      socket.emit('session-joined', {
        code: sessionCode,
        createdBy: session.createdBy,
        clipDuration: session.clipDuration,
        expiresAt: session.expiresAt || null,
        maxClips: session.maxClips || null,
        clipsUsed: weightedClipsUsed,
        commentSettings: session.commentSettings ? JSON.parse(session.commentSettings) : { filterMode: 'all', topN: 0 },
        members: session.members.map(m => ({
          username: m.username,
          isRecording: m.isRecording
        }))
      });

      socket.to(sessionCode).emit('member-joined', { username: cleanUsername });
    });

    // ================================
    // SESSION TITLE — any member can set/change it. Broadcast to the whole
    // squad so everyone's client shows the same title, and persisted so it
    // survives reconnects/late joins via session-joined. This is distinct
    // from each user's LOCAL note (client-side only, never sent here).
    // ================================
    socket.on('set-session-title', ({ title }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;

      const clean = (typeof title === 'string') ? title.trim().slice(0, 60) : '';
      session.title = clean || null;
      saveSessionsToDisk();

      log('info', 'session_title_changed', { session: sessionCode, title: session.title, setBy: socket.username });

      io.to(sessionCode).emit('session-title-changed', {
        title: session.title,
        setBy: socket.username
      });
    });

    // ================================
    // DETECTED GAME — informational, set by whichever client detects it
    // first. Does not overwrite an existing value, since a later, weaker
    // guess shouldn't clobber an earlier confident match. Purely a label;
    // never gates anything.
    // ================================
    socket.on('session-game-detected', ({ game }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;
      if (session.detectedGame) return; // first detection wins

      const clean = (typeof game === 'string') ? game.trim().slice(0, 60) : '';
      if (!clean) return;

      session.detectedGame = clean;
      saveSessionsToDisk();

      log('info', 'session_game_detected', { session: sessionCode, game: clean, by: socket.username });

      io.to(sessionCode).emit('session-game-detected', { game: clean });
    });

    // ================================
    // COMMENT SETTINGS — host only
    // Filter mode controls what comments viewers see during playback.
    // Modes: 'all' | 'host-only' | 'top-1' | 'top-5' | 'top-10' | 'top-20'
    // ================================
    socket.on('set-comment-settings', ({ filterMode, topN }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;

      const session = sessions.get(sessionCode);
      if (!session) return;

      // Only the session creator can change comment settings
      if (session.createdBy !== socket.username) {
        socket.emit('error-message', { message: 'Only the session host can change comment settings' });
        return;
      }

      // Validate input
      const validModes = ['all', 'host-only', 'top-1', 'top-5', 'top-10', 'top-20'];
      if (!validModes.includes(filterMode)) {
        socket.emit('error-message', { message: 'Invalid comment filter mode' });
        return;
      }

      // Store as JSON string in DB
      session.commentSettings = JSON.stringify({ filterMode, topN: topN || 0 });
      saveSessionsToDisk();

      log('info', 'comment_settings_changed', {
        session: sessionCode,
        filterMode,
        setBy: socket.username
      });

      // Tell everyone in the session
      io.to(sessionCode).emit('comment-settings-changed', {
        filterMode,
        setBy: socket.username
      });
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

    // ================================
    // BUFFER CAPACITY — seconds of history this client's ring buffer holds.
    // Auto-capture caps its window to the smallest value among recording
    // members so every POV can produce the full span; without it, a
    // short-buffer client silently clamps its extraction and desyncs.
    // ================================
    socket.on('buffer-capacity', ({ bufferSeconds }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;
      if (typeof bufferSeconds !== 'number' || !isFinite(bufferSeconds)) return;

      const clean = Math.min(3600, Math.max(10, Math.round(bufferSeconds)));
      const member = session.members.find(m => m.socketId === socket.id);
      if (member) member.bufferSeconds = clean;
      if (cleanIsHost(session, socket.username) && member && member.isRecording) {
        session.hostLastActivityAt = Date.now();
      }

      log('info', 'buffer_capacity', { session: sessionCode, username: socket.username, bufferSeconds: clean });
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

      if (cleanIsHost(session, socket.username)) {
        if (isRecording) {
          session.hostIdleSince = null;
          session.hostLastActivityAt = Date.now();
        } else {
          session.hostIdleSince = Date.now();
          session.hostLastActivityAt = null;
        }
      }

      io.to(sessionCode).emit('member-recording-update', {
        username: socket.username,
        isRecording
      });

      log('info', 'recording_status', { session: sessionCode, username: socket.username, isRecording });
    });

    // ================================
    // MIGRATE — host-only. Spins up a fresh session (same tier gating as
    // POST /sessions, including the monthly cap) and moves the whole
    // squad over in one shot when the current session fills up.
    // ================================
    socket.on('migrate-session', () => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;

      if (session.createdBy !== socket.username) {
        socket.emit('error-message', { message: 'Only the session host can start a new session' });
        return;
      }

      const result = createSessionForUser(socket.username);
      if (result.error) {
        socket.emit('error-message', { message: result.error });
        return;
      }

      log('info', 'session_migrated', { from: sessionCode, to: result.session.code, by: socket.username });
      io.to(sessionCode).emit('session-migrated', { newCode: result.session.code });
    });

    // ================================
    // KICK — host-only. Removes a member for this session only; they can
    // rejoin with the same code (see removeMemberFromSession above).
    // ================================
    socket.on('kick-member', ({ username }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;

      if (session.createdBy !== socket.username) {
        socket.emit('error-message', { message: 'Only the session host can remove members' });
        return;
      }

      const target = sanitizeUsername(username);
      if (!target || target === socket.username) {
        socket.emit('error-message', { message: 'Invalid target' });
        return;
      }

      const result = removeMemberFromSession(io, session, sessionCode, target, 'kick', socket.username);
      if (!result.ok) socket.emit('error-message', { message: result.error });
    });

    // ================================
    // BAN — host-only. Same removal as kick, plus adds the member to the
    // session's persisted ban list so they can't rejoin with the same code.
    // ================================
    socket.on('ban-member', ({ username }) => {
      if (!checkSocketRate(socket.id)) return;
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;
      const session = sessions.get(sessionCode);
      if (!session) return;

      if (session.createdBy !== socket.username) {
        socket.emit('error-message', { message: 'Only the session host can ban members' });
        return;
      }

      const target = sanitizeUsername(username);
      if (!target || target === socket.username) {
        socket.emit('error-message', { message: 'Invalid target' });
        return;
      }

      const result = removeMemberFromSession(io, session, sessionCode, target, 'ban', socket.username);
      if (!result.ok) socket.emit('error-message', { message: result.error });
    });

    // Highlight save broadcast + lock/queue machinery
    registerHighlightHandlers(io, socket);

    // Auto-capture state machine — server-authoritative ACTIVE/settle timing
    registerAutoCaptureHandlers(io, socket);

    socket.on('disconnect', () => {
      removeSocketRate(socket.id);
      const sessionCode = socket.sessionCode;
      if (!sessionCode) return;

      const session = sessions.get(sessionCode);
      if (!session) return;

      const wasHost = session.createdBy === socket.username;

      session.members = session.members.filter(m => m.socketId !== socket.id);
      log('info', 'member_left', { session: sessionCode, username: socket.username, remaining: session.members.length });

      socket.to(sessionCode).emit('member-left', { username: socket.username });

      // Host leaving ends the session for everyone still connected, and
      // blocks new joins (see join-session) until the host reconnects with
      // the same username. Web player is unaffected — it reads via HTTP,
      // not this socket path.
      if (wasHost) {
        session.closed = true;
        // Persist immediately — a restart between here and the delayed
        // archive below would otherwise reopen the session to anyone
        // holding the code (closed is a durable column now, not
        // in-memory-only, but it still has to actually be written).
        saveSessionsToDisk();
        if (session.members.length > 0) {
          log('info', 'session_closed_by_host', { session: sessionCode, host: socket.username, kicked: session.members.length });
          io.to(sessionCode).emit('session-closed', { reason: 'Host left the session' });
          session.members = [];
        }
      }

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

function initSocketsWithWatchdog(io) {
  initSockets(io);
  startHostInactivityWatchdog(io);
}

module.exports = { initSockets: initSocketsWithWatchdog };
