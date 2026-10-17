// ================================
// SPOT CARDS — printable QR cards for big Peakabu Mobile events.
//
// A host makes a card SET ("Wedding") with up to MAX_SPOTS spots ("Head
// table", "Pool", …). Each spot gets its own long random token, printed as
// a QR code that points at https://peakabu.app/s/<token>. Any signed-in
// account can make and print sets, free accounts included; a card only
// does something once the host starts a party on Peakabu Mobile (host plan
// or event pass) and the mobile server ATTACHES the set to that party.
//
//   card scanned, set attached and live -> redirect to the party, in that spot
//   card scanned, nothing live          -> "this party hasn't started yet"
//
// Printed cards stay valid until the host reissues the set (new tokens), so
// a lost card can be retired without deleting the set.
//
// Own tables (not users columns), same choice as login-slots.js.
// ================================
const crypto = require('crypto');
const db = require('./db');

const MAX_SETS = 20;
const MAX_SPOTS = 12;
const NAME_MAX = 40;
// Spot colours the website offers. Anything else is refused so card text
// stays readable on the printed card.
const COLORS = ['#39d3a0', '#7fc8ff', '#ffd23f', '#ff8a5c', '#c6f36b', '#a98fe8', '#f0a5bd', '#e8c88f'];
const ATTACH_MAX_MS = 16 * 60 * 60 * 1000; // matches the longest event pass

db.exec(`
  CREATE TABLE IF NOT EXISTS spot_sets (
    id              TEXT PRIMARY KEY,
    usernameLower   TEXT NOT NULL,
    name            TEXT NOT NULL,
    createdAt       INTEGER NOT NULL,
    updatedAt       INTEGER NOT NULL,
    attachedJoinUrl TEXT,
    attachedUntil   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_spot_sets_user ON spot_sets(usernameLower);
  CREATE TABLE IF NOT EXISTS spot_cards (
    id        TEXT PRIMARY KEY,
    setId     TEXT NOT NULL,
    name      TEXT NOT NULL,
    color     TEXT NOT NULL,
    token     TEXT NOT NULL UNIQUE,
    position  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spot_cards_set ON spot_cards(setId);
`);

const stmt = {
  setsFor:    db.prepare(`SELECT * FROM spot_sets WHERE usernameLower = ? ORDER BY createdAt DESC`),
  countSets:  db.prepare(`SELECT COUNT(*) AS n FROM spot_sets WHERE usernameLower = ?`),
  getSet:     db.prepare(`SELECT * FROM spot_sets WHERE id = ?`),
  insertSet:  db.prepare(`INSERT INTO spot_sets (id, usernameLower, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`),
  renameSet:  db.prepare(`UPDATE spot_sets SET name = ?, updatedAt = ? WHERE id = ?`),
  touchSet:   db.prepare(`UPDATE spot_sets SET updatedAt = ? WHERE id = ?`),
  deleteSet:  db.prepare(`DELETE FROM spot_sets WHERE id = ?`),
  attach:     db.prepare(`UPDATE spot_sets SET attachedJoinUrl = ?, attachedUntil = ? WHERE id = ?`),
  cardsFor:   db.prepare(`SELECT * FROM spot_cards WHERE setId = ? ORDER BY position ASC`),
  cardByTok:  db.prepare(`SELECT * FROM spot_cards WHERE token = ?`),
  insertCard: db.prepare(`INSERT INTO spot_cards (id, setId, name, color, token, position) VALUES (?, ?, ?, ?, ?, ?)`),
  updateCard: db.prepare(`UPDATE spot_cards SET name = ?, color = ?, position = ? WHERE id = ? AND setId = ?`),
  deleteCard: db.prepare(`DELETE FROM spot_cards WHERE id = ?`),
  deleteCards:db.prepare(`DELETE FROM spot_cards WHERE setId = ?`),
  retoken:    db.prepare(`UPDATE spot_cards SET token = ? WHERE id = ?`)
};

const newId = () => crypto.randomBytes(9).toString('hex');
// 24 random bytes = 192 bits, same strength as the mobile QR join token.
const newToken = () => crypto.randomBytes(24).toString('base64url');

function cleanName(v, fallback) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || fallback;
}

// Validates a spots array from the website. Returns { spots } or { error }.
function cleanSpots(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'Add at least one spot.' };
  if (list.length > MAX_SPOTS) return { error: `A set can have up to ${MAX_SPOTS} spots.` };
  const spots = list.map((s, i) => ({
    id: typeof s.id === 'string' && /^[a-f0-9]{18}$/.test(s.id) ? s.id : null,
    name: cleanName(s && s.name, `Spot ${i + 1}`),
    color: COLORS.includes(String(s && s.color).toLowerCase()) ? String(s.color).toLowerCase() : COLORS[i % COLORS.length]
  }));
  return { spots };
}

function isLive(set) {
  return !!(set.attachedJoinUrl && set.attachedUntil && set.attachedUntil > Date.now());
}

function shape(set, cardUrl) {
  return {
    id: set.id,
    name: set.name,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    live: isLive(set),
    spots: stmt.cardsFor.all(set.id).map(c => ({ id: c.id, name: c.name, color: c.color, url: cardUrl(c.token) }))
  };
}

function listSets(usernameLower, cardUrl) {
  return stmt.setsFor.all(usernameLower).map(s => shape(s, cardUrl));
}

function getOwnedSet(usernameLower, id) {
  const set = stmt.getSet.get(String(id || ''));
  return set && set.usernameLower === usernameLower ? set : null;
}

function createSet(usernameLower, name, spotsIn) {
  if (stmt.countSets.get(usernameLower).n >= MAX_SETS) return { error: `You can keep up to ${MAX_SETS} card sets. Delete one first.` };
  const { spots, error } = cleanSpots(spotsIn);
  if (error) return { error };
  const id = newId();
  const now = Date.now();
  db.transaction(() => {
    stmt.insertSet.run(id, usernameLower, cleanName(name, 'My event'), now, now);
    spots.forEach((s, i) => stmt.insertCard.run(newId(), id, s.name, s.color, newToken(), i));
  })();
  return { set: stmt.getSet.get(id) };
}

// Rename and/or replace the spot list. Spots that keep their id keep their
// token, so cards already printed for them still work.
function updateSet(set, name, spotsIn) {
  const now = Date.now();
  let cleaned = null;
  if (spotsIn !== undefined) {
    const r = cleanSpots(spotsIn);
    if (r.error) return { error: r.error };
    cleaned = r.spots;
  }
  db.transaction(() => {
    if (name !== undefined) stmt.renameSet.run(cleanName(name, set.name), now, set.id);
    if (cleaned) {
      const existing = new Map(stmt.cardsFor.all(set.id).map(c => [c.id, c]));
      const keep = new Set();
      cleaned.forEach((s, i) => {
        if (s.id && existing.has(s.id)) {
          stmt.updateCard.run(s.name, s.color, i, s.id, set.id);
          keep.add(s.id);
        } else {
          stmt.insertCard.run(newId(), set.id, s.name, s.color, newToken(), i);
        }
      });
      for (const id of existing.keys()) if (!keep.has(id)) stmt.deleteCard.run(id);
    }
    stmt.touchSet.run(now, set.id);
  })();
  return { set: stmt.getSet.get(set.id) };
}

function deleteSet(set) {
  db.transaction(() => { stmt.deleteCards.run(set.id); stmt.deleteSet.run(set.id); })();
}

// New tokens for every card in the set: old printed cards stop working.
function reissueSet(set) {
  db.transaction(() => {
    for (const c of stmt.cardsFor.all(set.id)) stmt.retoken.run(newToken(), c.id);
    stmt.touchSet.run(Date.now(), set.id);
  })();
  return stmt.getSet.get(set.id);
}

function cardsForSet(set) {
  return stmt.cardsFor.all(set.id);
}

// What a scanned card points at. null = no such card (or reissued).
function resolveToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const card = stmt.cardByTok.get(token);
  if (!card) return null;
  const set = stmt.getSet.get(card.setId);
  if (!set) return null;
  return { card, set, live: isLive(set) };
}

// Called by the mobile server when a party starts or ends.
function attachSet(set, joinUrl, untilMs) {
  const until = Math.min(Number(untilMs) || 0, Date.now() + ATTACH_MAX_MS);
  stmt.attach.run(joinUrl, until, set.id);
}
function detachSet(set) {
  stmt.attach.run(null, null, set.id);
}

module.exports = {
  MAX_SETS, MAX_SPOTS, COLORS,
  listSets, getOwnedSet, createSet, updateSet, deleteSet, reissueSet, cardsForSet,
  resolveToken, attachSet, detachSet, shape, isLive
};
