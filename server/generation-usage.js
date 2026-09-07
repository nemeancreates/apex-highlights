// ================================================================
// server/generation-usage.js — AI Reel (Claude-backed) monthly generation cap
// ================================================================
// Tracks how many Claude-backed AI Reel actions a user has used this
// calendar month, and enforces a cap before any real work (ASR, Claude
// call) happens.
//
// v0.1: flat cap — every action (fresh generation or re-edit) costs 1
// credit, see COST_WEIGHTS below. A fresh generation costs roughly 10x
// more in real API spend than a re-edit against a cached transcript, so
// if usage data later says the flat model is wrong, change ONLY
// COST_WEIGHTS — checkAndIncrement, getUsage, and every call site in
// aireel.js stay untouched.
//
// Storage: own SQLite table via better-sqlite3, independent of
// stores.js/users.json — this is usage telemetry, not user identity.
// ================================================================

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'generation-usage.db');

// Credits per action kind. Flat 1:1 today, matching the flat 100/month
// cap decision. Callers pass 'fresh' or 'reedit' and never hardcode a
// number — that's the whole point of keeping this a lookup.
const COST_WEIGHTS = {
  fresh: 1,
  reedit: 1
};

let db = null;
let D = null; // { log } — same lightweight deps pattern as aireel.js

function initGenerationUsage(deps) {
  D = deps;
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS aireel_generation_usage (
      userId   TEXT NOT NULL,
      monthKey TEXT NOT NULL,
      credits  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, monthKey)
    )
  `);
  D.log('info', 'generation_usage_ready', { dbFile: DB_FILE });
}

// Calendar-month key, e.g. "2026-09". Simpler than a per-user billing-
// cycle anchor — revisit only if the cap ever needs to reset on each
// user's individual subscription renewal date instead of the 1st.
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getRow(userId, monthKey) {
  return db.prepare(
    'SELECT credits FROM aireel_generation_usage WHERE userId = ? AND monthKey = ?'
  ).get(userId, monthKey);
}

// Read-only — does NOT consume a credit. Use for displaying "X of Y used"
// in the client UI without touching the counter.
function getUsage(userId, cap) {
  const monthKey = currentMonthKey();
  const row = getRow(userId, monthKey);
  const used = row ? row.credits : 0;
  return { used, cap, remaining: Math.max(0, cap - used), monthKey };
}

// Atomically checks and reserves credit for one action. Returns
// { ok, usage } — usage is populated either way so the caller can show
// "X of Y used" without a second query, even on a rejected request.
//
// kind: 'fresh' | 'reedit'. cap: the tier's monthly cap (from config.js —
// this module has no opinion on what the number is).
//
// Call this BEFORE doing any ASR or Claude API work — the whole point is
// to fail fast on an over-cap request instead of spending real money on
// one that's about to be rejected anyway.
function checkAndIncrement(userId, kind, cap) {
  const cost = COST_WEIGHTS[kind];
  if (!Number.isFinite(cost)) throw new Error(`Unknown generation kind: ${kind}`);

  const monthKey = currentMonthKey();

  // Transaction so two concurrent requests from the same user can't both
  // pass the check before either write lands (better-sqlite3 transactions
  // are synchronous, so this is safe without extra locking).
  const txn = db.transaction(() => {
    const row = getRow(userId, monthKey);
    const used = row ? row.credits : 0;
    if (used + cost > cap) return { ok: false, used };
    db.prepare(`
      INSERT INTO aireel_generation_usage (userId, monthKey, credits)
      VALUES (?, ?, ?)
      ON CONFLICT(userId, monthKey) DO UPDATE SET credits = credits + excluded.credits
    `).run(userId, monthKey, cost);
    return { ok: true, used: used + cost };
  });

  const result = txn();
  return {
    ok: result.ok,
    usage: { used: result.used, cap, remaining: Math.max(0, cap - result.used), monthKey }
  };
}

// Housekeeping — old month rows are cheap to keep but pointless past a
// couple months. Call on an interval the way aireel.js does with
// cleanupJobs/sweepOrphanedAireelFiles.
function pruneOldMonths(keepMonths = 3) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - keepMonths);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  const result = db.prepare('DELETE FROM aireel_generation_usage WHERE monthKey < ?').run(cutoffKey);
  if (result.changes > 0) D.log('info', 'generation_usage_pruned', { rows: result.changes, cutoffKey });
}

module.exports = { initGenerationUsage, checkAndIncrement, getUsage, pruneOldMonths, COST_WEIGHTS };