// ================================
// CRASH REPORTING — Sentry (free tier). Catches uncaught exceptions and
// unhandled promise rejections process-wide. No-ops if SENTRY_DSN is unset
// (local dev) so nothing here can block running without a Sentry account.
// Required FIRST in index.js — must be listening before anything else can throw.
// ================================
const Sentry = require('@sentry/node');
const { SENTRY_DSN } = require('./config');

if (SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN, environment: process.env.NODE_ENV || 'production' });
}

process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT EXCEPTION:', err.message, err.stack);
  if (SENTRY_DSN) Sentry.captureException(err);
  // Process state is undefined after an uncaught exception — exit and let
  // PM2 restart clean, rather than log-and-continue.
  setTimeout(() => process.exit(1), 2000);
});

process.on('unhandledRejection', (reason) => {
  console.log('UNHANDLED REJECTION:', reason);
  if (SENTRY_DSN) Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

module.exports = { Sentry, SENTRY_DSN };