// ================================
// STAR KEY — server arbiter for the star hotkey (v0.1.87).
//
// A star press means "that moment was good". The client only ever sends a
// mark (time T, user) and never saves a clip on its own from this key. This
// file decides what the mark attaches to, with one pending window per
// session:
//
//   1. A highlight requested since T - STAR_WINDOW_MS (fired or still
//      queued) gets the star. So does a manual highlight whose clip still
//      runs past T (a 3-min clip ends 18s after its press). No capture.
//   2. Otherwise a window opens for STAR_WINDOW_MS. The next NEW highlight
//      request (anyone's key, or auto-capture firing) gets the star and
//      closes it. A queued press that finally fires is not new: its clip is
//      from before T.
//   3. Nothing by T + STAR_WINDOW_MS: one normal squad highlight through
//      requestHighlight() (same cap, lock and queue rules as a key press),
//      anchored at T + STAR_WINDOW_MS and starred. A 30s clip then spans
//      T-17s..T+13s. If an auto-capture window is still open at that point,
//      the star waits for it instead: it stars whatever auto-capture saves,
//      or captures then if auto-capture discards the window.
//   4. Presses from anyone while a window is open join it. They never queue
//      another capture.
//
// So the star key captures at most one clip per window and never doubles up
// with auto-capture or a squadmate's press. Two highlights inside ±10s of a
// press can both end up starred; that's intended.
//
// "Recent" (case 1) is measured from when a request happened, not from its
// clip's own timestamp — those differ only for the star key's own fill-in
// capture (case 3), which anchors 10s after the press that caused it. A
// later press within 10s of that DECISION re-confirms the same clip; a
// press more than 10s after it opens a fresh window, same as for any other
// highlight. See requestHighlight's triggeredAt in highlights.js.
// ================================
const { log } = require('../logger');
const { STAR_WINDOW_MS } = require('../config');
const { sessions } = require('../stores');
const { checkSocketRate } = require('../ratelimit');
const { requestHighlight, onHighlightRequest } = require('./highlights');
const { canStar, addStars } = require('../routes/stars');

const RECENT_KEEP_MS = 60 * 1000;
// Backstop for a window waiting on an auto-capture window that never
// reports back. Auto windows are hard-capped at 3 minutes.
const AWAIT_AUTO_MAX_MS = 4 * 60 * 1000;

function closeWindow(session) {
  const w = session._starWindow;
  if (w && w.timer) clearTimeout(w.timer);
  session._starWindow = null;
}

// Case 1: highlights a press at T attaches to without capturing. Every
// entry in _starRecent was requested before this press was handled, so no
// upper bound is needed.
//
// "recent" checks triggeredAt (when the request actually happened), not ts
// (the clip's own anchor) — for a normal press those are the same instant,
// but the star key's own fill-in capture anchors 10s AFTER the decision
// that caused it. Using ts there would let a press up to 20s after the
// ORIGINAL star press silently re-confirm that old clip instead of opening
// a fresh window.
function highlightsCovering(session, T) {
  const hits = new Set();
  for (const r of session._starRecent || []) {
    const recent = r.triggeredAt >= T - STAR_WINDOW_MS;
    const clipRunsPastT = r.source !== 'auto' && r.ts <= T && T <= r.ts + Math.ceil(r.clipDuration * 0.1);
    if (recent || clipRunsPastT) hits.add(r.ts);
  }
  return [...hits];
}

// Case 3: the star's own capture.
function captureForWindow(io, code, session, w) {
  closeWindow(session);
  if (session.closed || !session.members.length) {
    log('info', 'star_window_dropped', { session: code, reason: 'session_empty', by: w.by });
    return;
  }
  // Anchored at the window's end even when it fires later (after waiting on
  // an auto-capture window): clients cut a clip anchored in the past exactly
  // like a queued press.
  const ts = Math.min(Date.now(), w.T + STAR_WINDOW_MS);
  const result = requestHighlight(io, code, session, w.by[0], ts, { source: 'star', triggeredAt: w.T });
  if (result !== 'blocked') addStars(io, code, [ts], w.by[0], 'key');
  log('info', 'star_capture', { session: code, ts, result, by: w.by });
}

function onWindowDeadline(io, code) {
  const session = sessions.get(code);
  if (!session || !session._starWindow) return;
  const w = session._starWindow;
  w.timer = null;
  if (session.autoCaptureActive) {
    w.awaitingAuto = true;
    w.timer = setTimeout(() => {
      const s = sessions.get(code);
      if (s && s._starWindow === w) {
        closeWindow(s);
        log('warn', 'star_window_expired', { session: code, by: w.by });
      }
    }, AWAIT_AUTO_MAX_MS);
    log('info', 'star_window_awaiting_auto', { session: code, by: w.by });
    return;
  }
  captureForWindow(io, code, session, w);
}

// Every NEW highlight request in the session (see highlights.js).
onHighlightRequest((io, code, session, info) => {
  if (info.kind === 'request') {
    const now = Date.now();
    const recent = (session._starRecent || []).filter(r => now - r.at < RECENT_KEEP_MS);
    const triggeredAt = typeof info.triggeredAt === 'number' ? info.triggeredAt : info.ts;
    recent.push({ ts: info.ts, triggeredAt, clipDuration: info.clipDuration || 30000, source: info.source, at: now });
    session._starRecent = recent;

    // Case 2 resolved: this highlight gets the star.
    const w = session._starWindow;
    if (w) {
      closeWindow(session);
      addStars(io, code, [info.ts], w.by[0], 'key');
      log('info', 'star_window_resolved', { session: code, momentTs: info.ts, source: info.source, by: w.by });
    }
  } else if (info.kind === 'auto-none') {
    const w = session._starWindow;
    if (w && w.awaitingAuto) captureForWindow(io, code, session, w);
  }
});

function registerStarHandlers(io, socket) {
  socket.on('star-mark', (payload) => {
    if (!checkSocketRate(socket.id)) return;
    const code = socket.sessionCode;
    if (!code) return;
    const session = sessions.get(code);
    if (!session) return;

    const perm = canStar(session, socket.username);
    if (!perm.ok) { socket.emit('error-message', { message: perm.error }); return; }

    const now = Date.now();
    if (socket.username === session.createdBy) session.hostLastActivityAt = now;

    // Same trust window as a highlight press (sockets/highlights.js).
    let T = (payload && typeof payload.pressTs === 'number' && isFinite(payload.pressTs))
      ? payload.pressTs : now;
    if (T > now + 1000 || T < now - 3000) T = now;

    // 4. A window is already open: join it.
    const w = session._starWindow;
    if (w) {
      if (!w.by.includes(socket.username)) w.by.push(socket.username);
      log('info', 'star_window_joined', { session: code, by: socket.username });
      socket.emit('star-window-open', { by: w.by[0], deadline: w.T + STAR_WINDOW_MS, joined: true });
      return;
    }

    // 1. Star what just happened.
    const hits = highlightsCovering(session, T);
    if (hits.length) {
      const added = addStars(io, code, hits, socket.username, 'key');
      // Already starred: nothing was broadcast, but the presser still
      // gets a confirmation.
      if (!added.length) socket.emit('stars-changed', { momentTs: hits, starred: true, by: socket.username, source: 'key' });
      return;
    }

    // 2. Wait for one.
    session._starWindow = {
      T,
      by: [socket.username],
      awaitingAuto: false,
      timer: setTimeout(() => onWindowDeadline(io, code), Math.max(0, T + STAR_WINDOW_MS - now))
    };
    log('info', 'star_window_open', { session: code, by: socket.username, T });
    io.to(code).emit('star-window-open', { by: socket.username, deadline: T + STAR_WINDOW_MS });
  });
}

module.exports = { registerStarHandlers };
