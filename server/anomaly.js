// ================================
// ANOMALY MONITORING — soft, non-blocking burst detection layered on top
// of existing hard limits (uploadLimiter, checkRegisterRate,
// sessionsPerMonth). Those already BLOCK abuse; this only LOGS a single
// 'warn' the first time a rolling window crosses a threshold, so a burst
// that stays under the hard caps (e.g. sessions spread across a monthly
// quota, or uploads that stay just under the per-minute limiter) still
// shows up for an operator scanning logs. Same soft-alert shape as
// trackBandwidth() in redemption.js.
// ================================
const { log } = require('./logger');

const counters = new Map(); // key -> { count, windowStart, alerted }

// windowMs: rolling window length
// threshold: count within the window that triggers the one-time alert
// event: log event name
// extra: additional fields to attach to the log line
function recordEvent(key, { windowMs, threshold, event, extra = {} }) {
  const now = Date.now();
  let entry = counters.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now, alerted: false };
    counters.set(key, entry);
  }
  entry.count++;
  if (entry.count >= threshold && !entry.alerted) {
    entry.alerted = true;
    log('warn', event, { key, count: entry.count, windowMs, ...extra });
  }
}

// Stale entry cleanup — same sweep pattern as ratelimit.js / auth.js's
// abuse-limiter maps.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of counters) {
    if (now - v.windowStart > 60 * 60 * 1000) counters.delete(k);
  }
}, 10 * 60 * 1000);

module.exports = { recordEvent };