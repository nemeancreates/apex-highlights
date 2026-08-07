// ================================
// AUTO-CAPTURE — server-authoritative state machine for hands-free
// highlight detection. Any subscribed member's audio peak holds the
// ACTIVE window open for the WHOLE squad; the server is the single
// source of truth for when the window starts, extends, and ends, so
// every member's client extracts the identical time span. Without a
// central authority here, independent per-client timers would drift
// and produce clips of different lengths capturing different moments.
//
// The client owns WHY it peaked (audio thresholding, sensitivity) and
// sends only two numbers up: settleMs (how long to wait quiet before
// ending) and minActiveMs (floor below which the window is discarded
// as noise). The server never interprets audio — purely a timer.
// ================================
const { log } = require('../logger');
const { sessions } = require('../stores');
const { checkSocketRate } = require('../ratelimit');
const { getEffectiveTier } = require('../auth');
const { fireCoordinatedHighlight } = require('./highlights');

const MAX_AUTO_CAPTURE_MS = 6 * 60 * 1000;      // hard cap — forces a save regardless of settle state
const DEFAULT_MIN_ACTIVE_MS = 20 * 1000;        // floor below which a peak-then-quiet is discarded as noise
const DEFAULT_SETTLE_MS = 3000;                 // fallback if a client omits settleMs
const MIN_SETTLE_MS = 1000;                     // sanity floor — a hostile/buggy client can't set this to 0
const MAX_SETTLE_MS = 20000;                    // sanity ceiling — matches the longest planned genre window (battle royale)

// Auto-capture-only tier gate. Free-tier hosts never get auto-capture,
// regardless of who in the squad is triggering peaks — matches "if the
// host isn't t2+, silently ignore" from the design discussion.
function hostMeetsAutoCaptureTier(session) {
  const { users } = require('../stores');
  if (!session || !session.createdBy) return false;
  const hostUser = users.get(session.createdBy.toLowerCase());
  const tier = getEffectiveTier(hostUser);
  return tier === 't2' || tier === 't3' || tier === 't4';
}

function clearAutoCaptureTimers(session) {
  if (session._autoSettleTimer) { clearTimeout(session._autoSettleTimer); session._autoSettleTimer = null; }
  if (session._autoHardCapTimer) { clearTimeout(session._autoHardCapTimer); session._autoHardCapTimer = null; }
}

function resetAutoCaptureState(session) {
  clearAutoCaptureTimers(session);
  session.autoCaptureActive = false;
  session.autoCaptureStartTs = 0;
  session.autoCapturePeakTs = 0;
}

// Fires when the settle timer expires (quiet long enough) OR the hard cap
// is hit. Either path ends up here; `forced` distinguishes them for logging.
function endAutoCapture(io, sessionCode, session, forced) {
  if (!session.autoCaptureActive) return;

  const now = Date.now();
  const elapsed = now - session.autoCaptureStartTs;
  const minActive = session._autoMinActiveMs || DEFAULT_MIN_ACTIVE_MS;

  clearAutoCaptureTimers(session);

  if (elapsed < minActive) {
    // Too short to be worth a clip — a single shot or door slam, not a
    // real moment. Reset silently, no save, no squad notification beyond
    // the cancel event (lets clients drop any "listening" UI state).
    log('info', 'auto_capture_cancelled', { session: sessionCode, elapsedMs: elapsed, minActiveMs: minActive });
    io.to(sessionCode).emit('auto-capture-cancel', { elapsedMs: elapsed });
    resetAutoCaptureState(session);
    return;
  }

  const cappedElapsed = Math.min(elapsed, MAX_AUTO_CAPTURE_MS);
  const startTs = session.autoCaptureStartTs;

  log('info', 'auto_capture_end', {
    session: sessionCode, elapsedMs: cappedElapsed, forced: !!forced,
    triggeredBy: session._autoTriggerUsername
  });

  io.to(sessionCode).emit('auto-capture-end', {
    startTs,
    elapsedMs: cappedElapsed,
    forced: !!forced
  });

  const username = session._autoTriggerUsername || session.createdBy;
  resetAutoCaptureState(session);

  // Anchor the save at the END of the window (startTs + elapsed) — this
  // reuses fireCoordinatedHighlight's existing 90/10 split logic (10%
  // post-capture after the trigger moment), which for a duration equal
  // to the full ACTIVE window means clients extract back from "now"
  // across the whole span that was actually active.
  fireCoordinatedHighlight(io, sessionCode, session, username, startTs + cappedElapsed, cappedElapsed, 'auto');
}

function registerAutoCaptureHandlers(io, socket) {
  // ================================
  // auto-peak — a member's client detected an audio spike. Starts the
  // ACTIVE window if idle, or extends/resets the settle timer if already
  // active. This is the ONLY inbound auto-capture event; everything else
  // is server-driven timers broadcasting out.
  // ================================
  socket.on('auto-peak', (payload) => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    if (!hostMeetsAutoCaptureTier(session)) return; // silent — client shows its own upgrade prompt

    const now = Date.now();

    // Sanitize client-supplied timing so a bad/hostile client can't set an
    // absurd settle window or hold the squad's session in a weird state.
    let settleMs = (payload && typeof payload.settleMs === 'number' && isFinite(payload.settleMs))
      ? payload.settleMs : DEFAULT_SETTLE_MS;
    settleMs = Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, settleMs));

    let minActiveMs = (payload && typeof payload.minActiveMs === 'number' && isFinite(payload.minActiveMs))
      ? payload.minActiveMs : DEFAULT_MIN_ACTIVE_MS;
    minActiveMs = Math.min(60000, Math.max(5000, minActiveMs));

    if (!session.autoCaptureActive) {
      // Entering ACTIVE for the first time this cycle.
      session.autoCaptureActive = true;
      session.autoCaptureStartTs = now;
      session.autoCapturePeakTs = now;
      session._autoMinActiveMs = minActiveMs;
      session._autoTriggerUsername = socket.username;

      log('info', 'auto_capture_start', { session: sessionCode, username: socket.username, settleMs, minActiveMs });
      io.to(sessionCode).emit('auto-capture-start', { startTs: now, username: socket.username });

      // Hard cap: fires once, MAX_AUTO_CAPTURE_MS after ACTIVE began,
      // regardless of how many more peaks reset the settle timer.
      session._autoHardCapTimer = setTimeout(() => {
        const current = sessions.get(sessionCode);
        if (current) endAutoCapture(io, sessionCode, current, true);
      }, MAX_AUTO_CAPTURE_MS);
    } else {
      session.autoCapturePeakTs = now;
    }

    // (Re)schedule the settle timer off THIS peak — any member's peak
    // resets it, which is what "holds the state for the whole squad"
    // means in practice: the window only ends once EVERYONE has been
    // quiet for settleMs.
    if (session._autoSettleTimer) clearTimeout(session._autoSettleTimer);
    session._autoSettleTimer = setTimeout(() => {
      const current = sessions.get(sessionCode);
      if (current) endAutoCapture(io, sessionCode, current, false);
    }, settleMs);
  });

  // Defensive cleanup: if the triggering member disconnects mid-window,
  // the window itself keeps running (other members' peaks still count),
  // but if the WHOLE session empties out, don't leave orphaned timers.
  socket.on('disconnect', () => {
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;
    if (session.members.length === 0 && session.autoCaptureActive) {
      clearAutoCaptureTimers(session);
      resetAutoCaptureState(session);
    }
  });
}

module.exports = { registerAutoCaptureHandlers };