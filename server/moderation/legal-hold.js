// ================================
// LEGAL HOLD — sessions that must be preserved and locked down.
//
// Placed automatically when the scanner flags apparent child sexual abuse
// material, or by staff via the admin routes. A held session:
//   - is never purged at expiry (stores.js checks isOnHold) — US law
//     (18 U.S.C. 2258A, as amended by the REPORT Act) requires preserving
//     reported material for at least one year
//   - is hidden from everyone: the session/upload routes answer 404, it
//     can't be listed publicly, and the host can't delete its clips
//
// Depends only on db.js so stores.js can require it without a cycle.
// ================================
const db = require('../db');

db.exec(`
  CREATE TABLE IF NOT EXISTS legal_holds (
    sessionCode TEXT PRIMARY KEY,
    caseId      TEXT NOT NULL,
    reason      TEXT NOT NULL,
    placedBy    TEXT NOT NULL,
    createdAt   INTEGER NOT NULL
  );
`);

const stmt = {
  get:     db.prepare(`SELECT * FROM legal_holds WHERE sessionCode = ?`),
  all:     db.prepare(`SELECT * FROM legal_holds ORDER BY createdAt DESC`),
  place:   db.prepare(`
    INSERT INTO legal_holds (sessionCode, caseId, reason, placedBy, createdAt)
    VALUES (@sessionCode, @caseId, @reason, @placedBy, @createdAt)
    ON CONFLICT(sessionCode) DO NOTHING
  `),
  release: db.prepare(`DELETE FROM legal_holds WHERE sessionCode = ?`)
};

// Cached in memory: isOnHold() runs on every session lookup and every
// purge pass, and holds are rare.
let held = new Set();
function reload() {
  try { held = new Set(stmt.all.all().map(r => r.sessionCode)); } catch (e) { held = new Set(); }
}
reload();

function isOnHold(code) { return held.has(code); }

function placeHold(code, { caseId, reason, placedBy }) {
  stmt.place.run({ sessionCode: code, caseId, reason, placedBy, createdAt: Date.now() });
  held.add(code);
}

function releaseHold(code) {
  const n = stmt.release.run(code).changes;
  held.delete(code);
  return n > 0;
}

function getHold(code) { return stmt.get.get(code) || null; }
function listHolds() { return stmt.all.all(); }

module.exports = { isOnHold, placeHold, releaseHold, getHold, listHolds };
