// ================================
// HIGHLIGHTS — the coordinated save broadcast, session-wide cooldown
// lock, and pending-trigger queue. This is the patent-relevant core
// (App. No. 64/111,818) and the most timing-sensitive logic on the
// server. It lives alone so it can be tested in isolation.
// ================================
const { log } = require('../logger');
const { MAX_HIGHLIGHTS_PER_SESSION, MAX_PENDING_HIGHLIGHTS } = require('../config');
const { sessions } = require('../stores');
const { checkSocketRate } = require('../ratelimit');

// Fires a coordinated save to all clients, locks the session, and on
// expiry either drains the next queued trigger (with its original
// timestamp) or emits highlight-unlocked.
function fireCoordinatedHighlight(io, sessionCode, session, username, coordinated_timestamp) {
  const clipDuration = session.clipDuration || 30000;
  const postCapture = Math.ceil(clipDuration * 0.1);
  // Lock for: post-capture window + 15s buffer refill cooldown
  const lockDuration = postCapture + 15000;

  session.highlightCount = (session.highlightCount || 0) + 1;
  session.highlightLockedUntil = Date.now() + lockDuration;

  log('info', 'highlight_triggered', { session: sessionCode, username, ts: coordinated_timestamp, clipDuration, lockMs: lockDuration, highlightCount: session.highlightCount });

  // Tell every client to save their POV — anchored to the trigger's
  // original timestamp (may be in the past for queued triggers)
  io.to(sessionCode).emit('coordinated-save-highlight', {
    username,
    coordinated_timestamp,
    clipDuration
  });

  // session.maxClips is set at creation from the host's tier (see
  // routes/sessions.js); falls back to the old global constant for
  // sessions created before tiers shipped.
  io.to(sessionCode).emit('clip-count-update', {
    used: session.highlightCount,
    max: session.maxClips || MAX_HIGHLIGHTS_PER_SESSION
  });

  // Tell every client to lock their save button
  io.to(sessionCode).emit('highlight-cooldown', {
    lockDuration,
    clipDuration
  });

  // Auto-unlock after lock expires. Guard against setTimeout firing a few
  // ms early (which previously skipped the emit entirely, leaving clients
  // locked): only skip if a NEWER lock replaced this one. After unlocking,
  // drain the next queued trigger if one is waiting.
  const thisLockExpiry = session.highlightLockedUntil;
  setTimeout(() => {
    const current = sessions.get(sessionCode);
    if (!current) return;
    if (current.highlightLockedUntil > thisLockExpiry) return; // a newer save re-locked
    current.highlightLockedUntil = 0;
    io.to(sessionCode).emit('highlight-unlocked');

    const next = (current.pendingHighlights || []).shift();
    if (next) {
      log('info', 'highlight_dequeued', { session: sessionCode, username: next.username, ts: next.ts, remaining: current.pendingHighlights.length });
      fireCoordinatedHighlight(io, sessionCode, current, next.username, next.ts);
    }
  }, lockDuration + 100);
}

function registerHighlightHandlers(io, socket) {
  socket.on('broadcast-save-highlight', (payload) => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    const now = Date.now();

    // Client-stamped press time, already shifted into the server clock domain.
    // Trusted only inside a sane window (max 3s stale, max 1s ahead) so a bad
    // clock or hostile client can't anchor a clip somewhere absurd.
    // Old clients send no payload → falls back to server receive time.
    let pressTs = (payload && typeof payload.pressTs === 'number' && isFinite(payload.pressTs))
      ? payload.pressTs : now;
    if (pressTs > now + 1000 || pressTs < now - 3000) pressTs = now;

    const pending = session.pendingHighlights = session.pendingHighlights || [];

    // Session clip cap — count fired + already-queued triggers. Uses the
    // host's tier-based cap (session.maxClips) when present.
    const clipCap = session.maxClips || MAX_HIGHLIGHTS_PER_SESSION;
    if ((session.highlightCount || 0) + pending.length >= clipCap) {
      socket.emit('error-message', { message: 'Clip limit reached for this session (' + clipCap + '). Host can start a new session to keep going.' });
      return;
    }

    // Locked: queue the trigger with its ORIGINAL timestamp instead of
    // rejecting. It fires when the lock expires — clients cut the clip
    // anchored to this moment, and their lastHighlightBoundary dedup
    // guarantees zero footage overlap with the previous clip.
    if (session.highlightLockedUntil && now < session.highlightLockedUntil) {
      if (pending.length >= MAX_PENDING_HIGHLIGHTS) {
        socket.emit('error-message', { message: 'Highlight queue full — wait for cooldown' });
        return;
      }
      pending.push({ username: socket.username, ts: now });
      log('info', 'highlight_queued', { session: sessionCode, username: socket.username, ts: now, queueDepth: pending.length });
      io.to(sessionCode).emit('highlight-queued', { username: socket.username, queued: pending.length });
      return;
    }

    fireCoordinatedHighlight(io, sessionCode, session, socket.username, now);
  });
}

module.exports = { registerHighlightHandlers, fireCoordinatedHighlight };