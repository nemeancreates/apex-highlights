// ================================
// RATE LIMITING — HTTP middleware + WebSocket per-socket budget.
// ================================
const {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW,
  SOCKET_RATE_MAX,
  SOCKET_RATE_WINDOW
} = require('./config');

// --- HTTP: per-IP ---
const rateLimits = new Map();

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

// --- WebSocket: per-socket ---
const socketRateLimits = new Map();

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

function removeSocketRate(socketId) {
  socketRateLimits.delete(socketId);
}

// --- Stale entry cleanup (prevents memory leaks) ---
function startRateLimitCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
      if (now > entry.resetTime) rateLimits.delete(ip);
    }
  }, 5 * 60 * 1000);
}

// --- Scoped limiter factory: for routes needing a stricter/separate
// budget than the global per-IP limit (e.g. public code-lookup routes,
// the upload endpoint). Each call returns its own independent Map + cleanup.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now > entry.resetTime) hits.delete(ip);
    }
  }, 5 * 60 * 1000);

  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.resetTime) {
      entry = { count: 0, resetTime: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

module.exports = { rateLimit, checkSocketRate, removeSocketRate, startRateLimitCleanup, createRateLimiter };
