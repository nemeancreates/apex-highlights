// ================================
// LOGGER — structured JSON logging + file mirroring + usage log.
// Every other module imports { log } from here. Nothing here imports
// other Peak-Abu modules, so this is always safe to require first.
// ================================
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'server.log');
const usageLogFile = path.join(logsDir, 'usage.log');

// Mirror all console.log output to server.log
const originalLog = console.log;
console.log = function (...args) {
  originalLog.apply(console, args);
  try {
    fs.appendFileSync(logFile, args.join(' ') + '\n');
  } catch (e) { /* never let logging crash the server */ }
};

// --- Structured logging ---
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

function log(level, event, data = {}) {
  if (LOG_LEVELS[level] < LOG_LEVELS[LOG_LEVEL]) return;

  // Never log sensitive fields
  const REDACTED_KEYS = ['password', 'token', 'secret', 'key', 'auth', 'cookie'];
  const safe = Object.fromEntries(
    Object.entries(data).filter(([k]) => !REDACTED_KEYS.some(r => k.toLowerCase().includes(r)))
  );

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...safe
  };

  // One JSON line per event — easy to grep/parse
  console.log(JSON.stringify(entry));
}

// --- Usage log (business events: uploads, etc.) ---
function logUsage(event, data = {}) {
  const entry = { ts: new Date().toISOString(), event, ...data };
  try {
    fs.appendFileSync(usageLogFile, JSON.stringify(entry) + '\n');
  } catch (e) { /* never let logging crash the server */ }
}

module.exports = { log, logUsage };
