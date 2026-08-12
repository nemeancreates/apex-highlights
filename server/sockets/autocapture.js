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

const MAX_AUTO_CAPTURE_MS = 3 * 60 * 1000;      // absolute hard cap — forces a save regardless of settle state
const DEFAULT_MIN_ACTIVE_MS = 20 * 1000;        // floor below which a peak-then-quiet is discarded as noise
const DEFAULT_SETTLE_MS = 3000;                 // fallback if a client omits settleMs
const MIN_SETTLE_MS = 1000;                     // sanity floor — a hostile/buggy client can't set this to 0
const MAX_SETTLE_MS = 20000;                    // sanity ceiling — matches the longest planned genre window (battle royale)

// Every client extracts from a finite ring buffer. A window longer than the
// SMALLEST recording member's buffer makes that client silently clamp to
// whatever history it still holds — producing a shorter clip with a LATER
// startTimeUTC than everyone else, which the player faithfully renders as a
// desynced POV. Cap every window to what the whole squad can deliver.
const BUFFER_SAFETY_MS = 25000;   // postDelay (11.5s) + partially-consumed oldest chunk (10s) + slack
const MIN_SQUAD_CAP_MS = 30000;   // never cap below a normal manual clip
const REARM_COOLDOWN_MS = 4000;   // ignore peaks briefly after a window closes

// A manual commit arriving seconds after detection opened would otherwise
// produce a 2-second clip. Floor it at the session's normal clip length so
// a fast press still yields something watchable — same footage the button
// would have grabbed if auto-capture were off.
const MIN_COMMIT_MS = 30000;

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

// Smallest usable buffer among members who are actually recording. Members
// who never reported a buffer size are ignored rather than assumed — an old
// client that doesn't send 'buffer-capacity' shouldn't drag the cap down to
// a guess, and a non-recording member's buffer is irrelevant.
function squadCapMs(session) {
  const caps = (session.members || [])
    .filter(m => m.isRecording && typeof m.bufferSeconds === 'number' && m.bufferSeconds > 0)
    .map(m => (m.bufferSeconds * 1000) - BUFFER_SAFETY_MS);
  if (caps.length === 0) return MAX_AUTO_CAPTURE_MS;
  return Math.max(MIN_SQUAD_CAP_MS, Math.min(MAX_AUTO_CAPTURE_MS, Math.min(...caps)));
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

// Fires when the settle timer expires (quiet long enough), the hard cap is
// hit, or a member presses Save mid-window. `forced` distinguishes timer
// expiry from the other two for logging; `ignoreMinActive` is set only by
// an explicit press — the press IS the signal that this is worth keeping,
// so the noise floor doesn't apply.
function endAutoCapture(io, sessionCode, session, forced, ignoreMinActive) {
  if (!session.autoCaptureActive) return;

  const now = Date.now();
  const elapsed = now - session.autoCaptureStartTs;
  const minActive = session._autoMinActiveMs || DEFAULT_MIN_ACTIVE_MS;

  clearAutoCaptureTimers(session);

  if (!ignoreMinActive && elapsed < minActive) {
    // Too short to be worth a clip — a single shot or door slam, not a
    // real moment. Reset silently, no save, no squad notification beyond
    // the cancel event (lets clients drop any "listening" UI state).
    log('info', 'auto_capture_cancelled', { session: sessionCode, elapsedMs: elapsed, minActiveMs: minActive });
    io.to(sessionCode).emit('auto-capture-cancel', { elapsedMs: elapsed });
    resetAutoCaptureState(session);
    return;
  }

  const capMs = squadCapMs(session);
  const cappedElapsed = Math.min(
    capMs,
    ignoreMinActive ? Math.max(elapsed, MIN_COMMIT_MS) : elapsed
  );
  const startTs = session.autoCaptureStartTs;

  log('info', 'auto_capture_end', {
    session: sessionCode, elapsedMs: cappedElapsed, rawElapsedMs: elapsed,
    capMs, buffCapped: cappedElapsed < elapsed,
    forced: !!forced, committed: !!ignoreMinActive,
    triggeredBy: session._autoTriggerUsername
  });

  io.to(sessionCode).emit('auto-capture-end', {
    startTs,
    elapsedMs: cappedElapsed,
    rawElapsedMs: elapsed,
    capMs,
    buffCapped: cappedElapsed < elapsed,
    forced: !!forced
  });

  const username = session._autoTriggerUsername || session.createdBy;
  resetAutoCaptureState(session);
  session._autoRearmUntil = Date.now() + REARM_COOLDOWN_MS;

  // Anchor the save at the END of the window. main.js's 'auto' branch cuts
  // [end - duration, end], so passing the full window length makes every
  // client extract the exact span that was active.
  fireCoordinatedHighlight(io, sessionCode, session, username, startTs + cappedElapsed, cappedElapsed, 'auto');
}

function registerAutoCaptureHandlers(io, socket) {
  // ================================
  // auto-peak — a member's client detected an audio spike. Starts the
  // ACTIVE window if idle, or extends/resets the settle timer if already
  // active.
  // ================================
  socket.on('auto-peak', (payload) => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session) return;

    if (!hostMeetsAutoCaptureTier(session)) return; // silent — client shows its own upgrade prompt

    // Nobody recording means nothing to extract from. Without this, windows
    // open and fire coordinated saves at members with empty buffers, who burn
    // the retry loop and error out.
    if (!(session.members || []).some(m => m.isRecording)) return;

    const now = Date.now();

    // Brief cooldown after a window closes. Sustained combat audio otherwise
    // reopens a window milliseconds after the last one closed, chaining
    // multi-minute captures back to back.
    if (session._autoRearmUntil && now < session._autoRearmUntil) return;

    // Sanitize client-supplied timing so a bad/hostile client can't set an
    // absurd settle window or hold the squad's session in a weird state.
    let settleMs = (payload && typeof payload.settleMs === 'number' && isFinite(payload.settleMs))
      ? payload.settleMs : DEFAULT_SETTLE_MS;
    settleMs = Math.min(MAX_SETTLE_MS, Math.max(MIN_SETTLE_MS, settleMs));

    let minActiveMs = (payload && typeof payload.minActiveMs === 'number' && isFinite(payload.minActiveMs))
      ? payload.minActiveMs : DEFAULT_MIN_ACTIVE_MS;
    minActiveMs = Math.min(60000, Math.max(5000, minActiveMs));

    if (!session.autoCaptureActive) {
      session.autoCaptureActive = true;
      session.autoCaptureStartTs = now;
      session.autoCapturePeakTs = now;
      session._autoMinActiveMs = minActiveMs;
      session._autoTriggerUsername = socket.username;

      const capMs = squadCapMs(session);
      log('info', 'auto_capture_start', { session: sessionCode, username: socket.username, settleMs, minActiveMs, capMs });
      io.to(sessionCode).emit('auto-capture-start', { startTs: now, username: socket.username, capMs });

      // Hard cap: fires once, capMs after ACTIVE began, regardless of how
      // many more peaks reset the settle timer.
      session._autoHardCapTimer = setTimeout(() => {
        const current = sessions.get(sessionCode);
        if (current) endAutoCapture(io, sessionCode, current, true, false);
      }, capMs);
    } else {
      session.autoCapturePeakTs = now;
    }

    // (Re)schedule the settle timer off THIS peak — any member's peak
    // resets it, so the window only ends once EVERYONE has been quiet.
    if (session._autoSettleTimer) clearTimeout(session._autoSettleTimer);
    session._autoSettleTimer = setTimeout(() => {
      const current = sessions.get(sessionCode);
      if (current) endAutoCapture(io, sessionCode, current, false, false);
    }, settleMs);
  });

  // ================================
  // auto-capture-commit — a member pressed Save while an ACTIVE window was
  // open. Ends the window immediately and saves from where detection began
  // to now, instead of the fixed clip duration. minActiveMs is deliberately
  // bypassed: an explicit press is the strongest possible signal.
  // ================================
  socket.on('auto-capture-commit', () => {
    if (!checkSocketRate(socket.id)) return;
    const sessionCode = socket.sessionCode;
    if (!sessionCode) return;
    const session = sessions.get(sessionCode);
    if (!session || !session.autoCaptureActive) return;

    log('info', 'auto_capture_commit', {
      session: sessionCode,
      by: socket.username,
      elapsedMs: Date.now() - session.autoCaptureStartTs
    });
    endAutoCapture(io, sessionCode, session, true, true);
  });

  // Defensive cleanup: if the triggering member disconnects mid-window,
  // the window keeps running (other members' peaks still count), but if
  // the WHOLE session empties out, don't leave orphaned timers.
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