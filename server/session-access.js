// ================================
// SESSION ACCESS — who can watch a PC session.
//
//   'members'  (sessions started from client 0.1.97 on): the host, anyone who
//              has been in the session (signed in), or anyone holding the
//              host's watch link (?k=<watchKey>).
//   'everyone' (older sessions, and any session listed on Browse): anyone
//              with the code, as before.
//
// Listing a session on Browse switches it to 'everyone'; switching back to
// 'members' takes it off Browse (routes/public.js).
// ================================
const crypto = require('crypto');
const { userFromRequest } = require('./auth');
const { saveSessionsToDisk } = require('./stores');

const isMembersOnly = (s) => !!s && s.visibility === 'members';
const lower = (u) => String(u || '').toLowerCase();

function safeEq(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Everyone who has been part of the session: host, past and present members,
// and anyone with a clip in it.
function peopleOf(s) {
  const set = new Set();
  const add = (u) => { if (u) set.add(lower(u)); };
  add(s.createdBy);
  (s.participants || []).forEach(add);
  (s.members || []).forEach((m) => add(m && m.username));
  (s.uploads || []).forEach((u) => add(u && u.username));
  return set;
}

// Remembered for good (members leave the live list when they disconnect).
function addParticipant(s, username) {
  if (!s || !username) return;
  if (!Array.isArray(s.participants)) s.participants = [];
  if (s.participants.some((u) => lower(u) === lower(username))) return;
  s.participants.push(username);
  saveSessionsToDisk();
}

function ensureWatchKey(s) {
  if (!s.watchKey) { s.watchKey = crypto.randomBytes(18).toString('base64url'); saveSessionsToDisk(); }
  return s.watchKey;
}
function resetWatchKey(s) {
  s.watchKey = crypto.randomBytes(18).toString('base64url');
  saveSessionsToDisk();
  return s.watchKey;
}

// The link the host shares. Members-only sessions carry the key.
function watchUrlFor(s) {
  return `https://peakabu.app/player?code=${encodeURIComponent(s.code)}` + (isMembersOnly(s) ? `&k=${ensureWatchKey(s)}` : '');
}

// The signed-in account on this request, if any (never required).
function viewerOf(req) { return req.user || userFromRequest(req); }

function isHostReq(req, s) {
  const u = viewerOf(req);
  return !!(u && s && u.username && lower(u.username) === lower(s.createdBy));
}

function canView(req, s) {
  if (!s) return false;
  if (!isMembersOnly(s)) return true;
  const k = typeof req.query.k === 'string' ? req.query.k : '';
  if (k && s.watchKey && safeEq(k, s.watchKey)) return true;
  const u = viewerOf(req);
  return !!(u && u.username && peopleOf(s).has(lower(u.username)));
}

const MEMBERS_ONLY_MSG = 'This session is for the people who were in it. Ask the host for the watch link.';

module.exports = { isMembersOnly, canView, isHostReq, addParticipant, ensureWatchKey, resetWatchKey, watchUrlFor, viewerOf, MEMBERS_ONLY_MSG };
