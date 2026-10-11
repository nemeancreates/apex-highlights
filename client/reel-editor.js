// ================================================================
// reel-editor.js — the reel's editor: decides WHAT goes in a reel and
// builds the ffmpeg command for each shot. No I/O, no dependencies.
//
// THE SAME FILE LIVES IN TWO PLACES and must stay identical:
//   server/reel-editor.js   (browser AI Reel, rendered on the server)
//   client/reel-editor.js   (in-app AI Reel, rendered on the user's PC)
//
// Why it exists (measured 10-10-26 on session 9F7PLX, 36 clips, 3 players):
// the old editor picked loud seconds per FILE and cut a fixed 8 s around
// each. Back-to-back highlights overlap (313 of one player's 598 s of clips
// were the same real seconds saved twice), so two files of one player
// became a "two-POV" grid of the same footage; a 170 s fight became seven
// 8 s snippets; a clip too short for the window had its start shifted, so
// tiles drifted up to 1.1 s apart; and a 60 s request came back 44 s long.
//
// This editor works on REAL TIME instead of files:
//   1. Every clip is placed on one session timeline by its startTimeUTC.
//      A player's overlapping files are one track: a player is on screen
//      once, and no real second is shown twice.
//   2. It cuts on stretches of action (loudness, relative to each clip),
//      and how strict "action" is follows the length asked for.
//   3. Tile in-points are computed here, from the timeline. A POV that
//      doesn't cover a shot is left out of it; nothing is ever shifted.
//   4. A moment with several POVs opens on the grid and cuts to the player
//      in the middle of it, without skipping or repeating time.
//   5. Stars, comments and style notes steer it (see DIRECTIONS).
//   6. Effects: quiet gaps inside a play are sped up instead of cut, the
//      reel's biggest moment gets a short slow-motion punch-in, and sound
//      fades at hard cuts.
//
// An AI director (server only) can choose among the moments this file
// finds; it never supplies timestamps, so everything above still holds.
// ================================================================
'use strict';

const BIN = 0.5;                 // timeline resolution, seconds
const MAX_TILES = 4;
const CANVAS_W = 1280, CANVAS_H = 720;
const TILE_W = 640, TILE_H = 360;
const OUT_FPS = 30;
const GRID_POS = {
  2: [[0, 180], [640, 180]],
  3: [[0, 0], [640, 0], [320, 360]],
  4: [[0, 0], [640, 0], [0, 360], [640, 360]]
};

const MIN_SPAN = 4;              // shortest moment worth showing, seconds
const MIN_TRIM = 4;              // shortest piece a moment may be trimmed to
const GRID_THEN_SOLO_MIN = 8;    // a moment this long opens on the grid, then goes solo
const GRID_MIN = 3.5;            // shortest grid opening
const SECTION_MAX = 24;          // longer moments are taken in sections of about SECTION_LEN
const SECTION_LEN = 16;
const BRIDGE_MAX_GAP = 10;       // quiet gaps up to this long are sped up, not cut
const PIN_BEFORE = 3, PIN_AFTER = 2.5;   // what a comment keeps around its time
const SLOW_BEFORE = 0.4, SLOW_AFTER = 0.8;
const SLOW_ZOOM = 1.25, COMMENT_ZOOM = 1.4;
const FADE = 0.06;

// How strict "action" is, loosest first. The editor uses the strictest level
// that still finds enough for the length asked for.
const LEVELS = [
  { hi: 0.30, lo: 0.18, lead: 2.5, tail: 2.0, gap: 5.0 },
  { hi: 0.40, lo: 0.25, lead: 2.0, tail: 1.5, gap: 4.0 },
  { hi: 0.50, lo: 0.30, lead: 1.5, tail: 1.0, gap: 3.5 },
  { hi: 0.60, lo: 0.40, lead: 1.5, tail: 1.0, gap: 3.5 },
  { hi: 0.70, lo: 0.50, lead: 1.2, tail: 0.8, gap: 3.0 },
  { hi: 0.80, lo: 0.60, lead: 1.0, tail: 0.8, gap: 3.0 },
  { hi: 0.90, lo: 0.70, lead: 1.0, tail: 0.6, gap: 3.0 }
];
const POOL = 1.3;                // candidates found, as a multiple of the target

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function r3(n) { return Math.round(n * 1000) / 1000; }
function playerKey(name) { return String(name || '').trim().toLowerCase() || '?'; }

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1)];
}

// ---------- 1. How intense each half-second of a clip is (0..1) ----------
// Loudness RELATIVE to the clip's own normal level, so a game that is loud
// all the time doesn't read as wall-to-wall action, blended with a little
// absolute loudness so a quiet clip's small bumps don't read as fights.
//
// "Normal level" is taken over ALL of a player's selected clips, not one
// clip at a time: per clip, every clip's own loudest 5% would score as a
// fight, so a quiet lobby clip would rank with a real one.
function loudnessScale(clipList) {
  const all = [];
  for (const c of clipList) for (const s of c.loudness || []) if (Number.isFinite(s.m) && s.m > -60) all.push(s.m);
  if (all.length < 5) return null;
  all.sort((a, b) => a - b);
  const floor = percentile(all, 0.5);
  return { floor, top: Math.max(percentile(all, 0.95), floor + 6) };
}

function clipIntensity(clip, scale) {
  const n = Math.max(1, Math.ceil(clip.duration / BIN));
  const raw = new Array(n).fill(-70);
  for (const s of clip.loudness || []) {
    if (!Number.isFinite(s.m) || !Number.isFinite(s.t)) continue;
    const i = Math.floor(s.t / BIN);
    if (i < 0 || i >= n) continue;
    if (s.m > raw[i]) raw[i] = s.m;
  }
  const out = new Array(n).fill(0);
  if (!scale) return out;
  const floor = scale.floor, top = scale.top;
  for (let i = 0; i < n; i++) {
    const m = raw[i];
    if (m <= -55) continue;
    const rel = clamp((m - floor) / (top - floor), 0, 1);
    const abs = clamp((m + 45) / 30, 0, 1);
    out[i] = 0.7 * rel + 0.3 * abs;
  }
  for (const t of clip.scenes || []) {
    const i = Math.floor(t / BIN);
    if (i >= 0 && i < n) out[i] = Math.min(1, out[i] + 0.2);
  }
  return out.map((v, i) => 0.25 * (out[i - 1] !== undefined ? out[i - 1] : v) + 0.5 * v +
                           0.25 * (out[i + 1] !== undefined ? out[i + 1] : v));
}

// ---------- DIRECTIONS: style notes ----------
// Plain words the editor understands. `understood` goes into the report so
// the user can see which of their notes did something.
function parseNotes(notes, players, names) {
  names = names || {};
  const n = ' ' + String(notes || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const d = { mode: 'auto', slow: true, zoom: true, speed: true, slowCount: null, pace: 0,
              boost: {}, understood: [] };
  if (n.trim() === '') return d;

  if (/\b(no|without|skip|less)\s+(the\s+)?(grids?|splits?|multi|side)|\bsolo only|\bonly solo|\bsingle pov|\bone pov\b/.test(n)) {
    d.mode = 'solo'; d.understood.push('one POV at a time');
  } else if (/\b(always|all|prefer|more|keep)\s+(the\s+)?(grids?|multi|povs?|split)|\b[234]\s*-?\s*(povs?|up)\b|side[- ]by[- ]side|\ball povs?\b|\beveryone\b/.test(n)) {
    d.mode = 'grid'; d.understood.push('every POV on screen whenever there is more than one');
  }
  if (/\bno\s+(effects?|fx)\b|\braw\b|\bplain\b/.test(n)) {
    d.slow = d.zoom = d.speed = false; d.understood.push('no effects');
  } else {
    if (/\b(no|without|skip)\s+(the\s+)?(slow|slo)/.test(n)) { d.slow = false; d.understood.push('no slow motion'); }
    else if (/\b(slow[- ]?mo(tion)?|slo-?mo|more slow)\b/.test(n)) { d.slowCount = 2; d.understood.push('more slow motion'); }
    if (/\b(no|without|skip)\s+(the\s+)?zoom/.test(n)) { d.zoom = false; d.understood.push('no zoom'); }
    if (/\b(no|without|skip)\s+(the\s+)?(speed|fast[- ]?forward|time[- ]?lapse)/.test(n)) { d.speed = false; d.understood.push('no speed-ups'); }
  }
  if (/\b(tight|quick|snappy|punchy|short cuts|fast[- ]paced|fast cuts)\b/.test(n)) { d.pace = 1; d.understood.push('tighter cuts'); }
  else if (/\b(hold|breathe|longer|long cuts|let (it|them|plays?) (play|run)|more context)\b/.test(n)) { d.pace = -1; d.understood.push('longer holds'); }

  for (const p of players) {
    if (p === '?' || p === 'you' || p.length < 3) continue;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b(no|less|not|skip|without)\\s+(of\\s+)?' + esc + '\\b').test(n)) {
      d.boost[p] = 0.5; d.understood.push('less of ' + (names[p] || p));
    } else if (new RegExp('\\b' + esc + '\\b').test(n)) {
      d.boost[p] = 1.6; d.understood.push('more of ' + (names[p] || p));
    }
  }
  return d;
}

// ---------- 2. Put every clip on one timeline ----------
// input.clips: [{ id, player, duration, startTimeUTC|null, hasAudio, fps,
//                 loudness: [{t, m}], scenes?: [t], starred?: bool }]
// input.comments: [{ uploadId, username, text, timestampMs, positionX, positionY }]
function prepare(input) {
  const targetSec = Number(input.targetSec) || 60;
  const clips = (input.clips || []).filter(c => c && c.duration > 1.5).map(c => ({
    id: String(c.id), player: playerKey(c.player), name: String(c.player || '?'),
    duration: c.duration, startTimeUTC: Number.isFinite(c.startTimeUTC) && c.startTimeUTC > 0 ? c.startTimeUTC : null,
    hasAudio: !!c.hasAudio, fps: Number(c.fps) || 0, starred: !!c.starred,
    loudness: c.loudness || [], scenes: c.scenes || []
  }));
  const ctx = { targetSec, clips, islands: [], candidates: [], level: 0,
                notes: null, uniqueSec: 0, game: input.game || '', styleNotes: input.styleNotes || '',
                localOnly: !!input.localOnly };   // in-app reel: no comments to steer with
  if (clips.length === 0) return ctx;

  const players = Array.from(new Set(clips.map(c => c.player)));
  ctx.names = {};
  clips.forEach(c => { ctx.names[c.player] = c.name; });
  ctx.notes = parseNotes(input.styleNotes, players, ctx.names);

  // Session time: seconds since the earliest clip. A clip with no start time
  // can't be lined up with anything, so it sits on its own, an hour away.
  const timed = clips.filter(c => c.startTimeUTC !== null);
  const t0 = timed.length ? Math.min(...timed.map(c => c.startTimeUTC)) : 0;
  let cursor = (timed.length ? Math.max(...timed.map(c => (c.startTimeUTC - t0) / 1000 + c.duration)) : 0) + 3600;
  for (const c of clips) {
    if (c.startTimeUTC !== null) { c.a = (c.startTimeUTC - t0) / 1000; c.untimed = false; }
    else { c.a = cursor; cursor += c.duration + 3600; c.untimed = true; }
    c.b = c.a + c.duration;
  }
  for (const p of players) {
    const mine = clips.filter(c => c.player === p);
    const scale = loudnessScale(mine);
    mine.forEach(c => { c.I = clipIntensity(c, scale); });
  }

  // Islands: stretches of real time that at least one clip covers.
  const sorted = clips.slice().sort((x, y) => x.a - y.a);
  let cur = null;
  for (const c of sorted) {
    if (cur && !c.untimed && !cur.untimed && c.a <= cur.b + 0.25) {
      cur.clips.push(c); cur.b = Math.max(cur.b, c.b);
    } else {
      cur = { a: c.a, b: c.b, clips: [c], untimed: c.untimed };
      ctx.islands.push(cur);
    }
  }
  ctx.islands.forEach((isl, k) => {
    isl.index = k;
    isl.n = Math.max(1, Math.ceil((isl.b - isl.a) / BIN));
    isl.G = new Array(isl.n).fill(0);     // most intense POV at each moment
    isl.P = {};                           // each player's own intensity
    isl.starred = new Array(isl.n).fill(false);
    for (const c of isl.clips) {
      const P = isl.P[c.player] || (isl.P[c.player] = new Array(isl.n).fill(0));
      for (let ci = 0; ci < c.I.length; ci++) {
        const gi = Math.floor((c.a - isl.a + (ci + 0.5) * BIN) / BIN);
        if (gi < 0 || gi >= isl.n) continue;
        if (c.I[ci] > P[gi]) P[gi] = c.I[ci];
        if (c.I[ci] > isl.G[gi]) isl.G[gi] = c.I[ci];
        if (c.starred) isl.starred[gi] = true;
      }
    }
    ctx.uniqueSec += isl.b - isl.a;
  });

  // Comments: each one keeps its moment and features the POV it was left on.
  ctx.pins = [];
  const byId = new Map(clips.map(c => [c.id, c]));
  for (const cm of input.comments || []) {
    const c = byId.get(String(cm.uploadId));
    const ts = Number(cm.timestampMs) / 1000;
    if (!c || !Number.isFinite(ts) || ts < 0 || ts > c.duration) continue;
    const text = String(cm.text || '');
    const hasPos = cm.positionX != null && cm.positionY != null;
    ctx.pins.push({
      t: c.a + ts, player: c.player, island: ctx.islands.find(i => i.clips.includes(c)),
      slow: /\bslo-?mo\b|\bslow/i.test(text),
      zoom: /\bzoom/i.test(text),
      cx: hasPos ? clamp(Number(cm.positionX) / 100, 0, 1) : 0.5,
      cy: hasPos ? clamp(Number(cm.positionY) / 100, 0, 1) : 0.5,
      by: String(cm.username || ''), text: text.slice(0, 120)
    });
  }

  // Candidates: the strictest level that still finds POOL x the target. If
  // even the loosest level is short, moments are given more room.
  // "Tight" notes ask for a smaller pool (a stricter level), "longer holds"
  // for a bigger one.
  const pool = ctx.notes.pace > 0 ? 1.05 : ctx.notes.pace < 0 ? 1.8 : POOL;
  const wanted = Math.min(targetSec * pool, ctx.uniqueSec);
  let chosen = null;
  for (let lv = LEVELS.length - 1; lv >= 0; lv--) {
    const spans = findSpans(ctx, LEVELS[lv], 0);
    const total = spans.reduce((n, s) => n + (s.e - s.s), 0);
    if (total >= wanted || lv === 0) { chosen = { spans, lv }; break; }
  }
  let grow = 0;
  while (chosen.spans.reduce((n, s) => n + (s.e - s.s), 0) < Math.min(targetSec, ctx.uniqueSec) - 0.5 && grow < 600) {
    grow = grow === 0 ? 1.5 : grow * 1.6;
    chosen.spans = findSpans(ctx, LEVELS[0], grow);
  }
  ctx.level = chosen.lv;
  ctx.candidates = chosen.spans.sort((x, y) => x.s - y.s);
  ctx.candidates.forEach((s, i) => { s.id = 'M' + (i + 1); });
  return ctx;
}

// Stretches of action in every island at one strictness level.
function findSpans(ctx, L, grow) {
  const out = [];
  for (const isl of ctx.islands) {
    const len = isl.b - isl.a;
    if (len < 2) continue;
    const raw = [];
    let i = 0;
    while (i < isl.n) {
      if (isl.G[i] < L.hi) { i++; continue; }
      let s = i, e = i + 1;
      while (s > 0 && isl.G[s - 1] >= L.lo) s--;
      while (e < isl.n && isl.G[e] >= L.lo) e++;
      raw.push({ s: isl.a + s * BIN - L.lead - grow, e: isl.a + e * BIN + L.tail + grow, pins: [] });
      i = e;
    }
    for (const p of ctx.pins.filter(p => p.island === isl)) {
      raw.push({ s: p.t - PIN_BEFORE, e: p.t + PIN_AFTER, pins: [p] });
    }
    raw.sort((x, y) => x.s - y.s);
    const merged = [];
    for (const r of raw) {
      r.s = clamp(r.s, isl.a, isl.b); r.e = clamp(r.e, isl.a, isl.b);
      const last = merged[merged.length - 1];
      if (last && r.s - last.e <= L.gap) { last.e = Math.max(last.e, r.e); last.pins = last.pins.concat(r.pins); }
      else merged.push(r);
    }
    for (const m of merged) {
      if (m.e - m.s < MIN_SPAN) {                       // too short to read: widen it
        const mid = (m.s + m.e) / 2, half = Math.min(MIN_SPAN, len) / 2;
        m.s = clamp(mid - half, isl.a, Math.max(isl.a, isl.b - 2 * half));
        m.e = Math.min(isl.b, m.s + 2 * half);
      }
      if (m.e - m.s >= 2) out.push(measure(isl, m));
    }
    // An island with nothing loud still offers its best few seconds, so a
    // quiet highlight the user picked can make a long reel.
    if (!merged.length) {
      const w = Math.min(isl.n, Math.round(Math.min(6, len) / BIN));
      let best = 0, bestSum = -1, sum = 0;
      for (let k = 0; k < isl.n; k++) {
        sum += isl.G[k];
        if (k >= w) sum -= isl.G[k - w];
        if (k >= w - 1 && sum > bestSum) { bestSum = sum; best = k - w + 1; }
      }
      const s = clamp(isl.a + best * BIN - grow, isl.a, isl.b);
      const span = measure(isl, { s, e: clamp(isl.a + (best + w) * BIN + grow, s, isl.b), pins: [] });
      span.weak = true;
      if (span.e - span.s >= 2) out.push(span);
    }
  }
  return out;
}

// Fills in a span's peak, strength and priority.
function measure(isl, m) {
  const i0 = clamp(Math.floor((m.s - isl.a) / BIN), 0, isl.n - 1);
  const i1 = clamp(Math.ceil((m.e - isl.a) / BIN), i0 + 1, isl.n);
  let peak = -1, peakI = i0, sum = 0, starred = false;
  for (let i = i0; i < i1; i++) {
    sum += isl.G[i];
    if (isl.G[i] > peak) { peak = isl.G[i]; peakI = i; }
    if (isl.starred[i]) starred = true;
  }
  const span = {
    island: isl, s: m.s, e: m.e, pins: m.pins || [],
    peakT: clamp(isl.a + (peakI + 0.5) * BIN, m.s, m.e), peak: Math.max(0, peak),
    mean: sum / Math.max(1, i1 - i0), starred, weak: false
  };
  if (span.pins.length) span.peakT = clamp(span.pins[0].t, m.s, m.e);
  span.score = 0.6 * span.peak + 0.4 * span.mean;
  return span;
}

// A player's intensity around a time, for choosing who a moment is about.
function playerLevel(isl, player, t, half) {
  const P = isl.P[player];
  if (!P) return 0;
  const i0 = clamp(Math.floor((t - half - isl.a) / BIN), 0, isl.n - 1);
  const i1 = clamp(Math.ceil((t + half - isl.a) / BIN), i0 + 1, isl.n);
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += P[i];
  return sum / (i1 - i0);
}

// The one file of `player` that holds all of [s, e], or null.
function covering(isl, player, s, e) {
  let best = null, bestMargin = -1;
  for (const c of isl.clips) {
    if (c.player !== player || c.a > s + 0.05 || c.b < e - 0.05) continue;
    const margin = Math.min(s - c.a, c.b - e);
    if (margin > bestMargin) { best = c; bestMargin = margin; }
  }
  return best;
}

// When G peaks in [a, b].
function peakTime(isl, a, b) {
  const i0 = clamp(Math.floor((a - isl.a) / BIN), 0, isl.n - 1);
  const i1 = clamp(Math.ceil((b - isl.a) / BIN), i0 + 1, isl.n);
  let best = i0;
  for (let i = i0; i < i1; i++) if (isl.G[i] > isl.G[best]) best = i;
  return clamp(isl.a + (best + 0.5) * BIN, a, b);
}

// Splits a long moment at its quietest points into sections of roughly
// SECTION_LEN seconds. Sections touch: no time is skipped.
function sections(isl, s, e) {
  const len = e - s;
  if (len <= SECTION_MAX) return [[s, e]];
  const n = Math.ceil(len / SECTION_LEN);
  const cuts = [s];
  for (let k = 1; k < n; k++) {
    const ideal = s + k * len / n;
    let best = ideal, bestV = Infinity;
    for (let t = ideal - 4; t <= ideal + 4; t += BIN) {
      const i = clamp(Math.floor((t - isl.a) / BIN), 0, isl.n - 1);
      const v = isl.G[i] + Math.abs(t - ideal) * 0.01;
      if (v < bestV && t - cuts[cuts.length - 1] >= 8 && e - t >= 8) { bestV = v; best = t; }
    }
    if (best - cuts[cuts.length - 1] >= 8 && e - best >= 8) cuts.push(best);
  }
  cuts.push(e);
  return cuts.slice(1).map((c, i) => [cuts[i], c]);
}

// Follows [s, e] from file to file. `order` is the players to prefer, best
// first. -> [{ clip, s, e }], touching, each at least ~1.5 s where it can be.
function chain(isl, s, e, order) {
  const out = [];
  let t = s;
  let guard = 0;
  while (t < e - 0.05 && guard++ < 200) {
    let pick = null, pickRank = Infinity, pickEnd = -1;
    for (const c of isl.clips) {
      if (c.a > t + 0.05 || c.b < t + 1) continue;
      const rank = order.indexOf(c.player);
      const end = Math.min(e, c.b);
      // Prefer the better-ranked player, unless their file ends within 3 s.
      const usable = end - t >= 3 || end >= e - 0.05;
      const key = (usable ? 0 : 100) + (rank < 0 ? 50 : rank);
      if (key < pickRank || (key === pickRank && end > pickEnd)) { pick = c; pickRank = key; pickEnd = end; }
    }
    if (!pick) {                       // a hole in the footage: step to the next file
      const next = isl.clips.filter(c => c.a > t).sort((x, y) => x.a - y.a)[0];
      if (!next || next.a >= e) break;
      t = next.a;
      continue;
    }
    out.push({ clip: pick, s: t, e: pickEnd });
    t = pickEnd;
  }
  return out;
}

// ---------- 3. Choose moments, then turn them into shots ----------
// choice (optional, from the AI director): { use: [{ id, layout, feature, slow }] }
function buildPlan(ctx, choice) {
  const empty = { edl: [], report: 'No usable footage in the selected clips.', stats: null };
  if (!ctx.candidates.length) return empty;
  const T = Math.min(ctx.targetSec, ctx.uniqueSec);
  const notes = ctx.notes;
  const prio = (s) => (s.pins.length ? 4 : 0) + (s.starred ? 2 : 0) + (s.weak ? -1 : 0) + s.score;

  // --- which moments ---
  let picked = [];
  const overrides = new Map();
  if (choice && Array.isArray(choice.use)) {
    const byId = new Map(ctx.candidates.map(s => [s.id, s]));
    for (const u of choice.use) {
      const s = u && byId.get(String(u.id));
      if (!s || overrides.has(s.id)) continue;
      overrides.set(s.id, u);
      picked.push(Object.assign({}, s));
    }
    let total = picked.reduce((n, s) => n + (s.e - s.s), 0);
    const droppable = picked.filter(s => !s.pins.length).sort((x, y) => prio(x) - prio(y));
    while (total > T * 1.15 && droppable.length && picked.length > 1) {
      const d = droppable.shift();
      picked = picked.filter(s => s.id !== d.id);
      total -= d.e - d.s;
    }
    if (total < Math.min(T * 0.5, T - 8)) picked = [];      // too thin: use the default cut
  }
  if (!picked.length) {
    overrides.clear();
    const order = ctx.candidates.slice().sort((x, y) => prio(y) - prio(x));
    const slack = Math.max(1.5, T * 0.03);
    let total = 0;
    for (const s of order) {
      const len = s.e - s.s;
      if (total + len <= T + slack) { picked.push(Object.assign({}, s)); total += len; continue; }
      const room = T - total;
      if (room >= MIN_TRIM) {
        const t = Object.assign({}, s);
        t.s = clamp(s.peakT - room * 0.6, s.s, s.e - room);
        t.e = t.s + room;
        picked.push(t); total += room;
      }
      if (T - total < MIN_TRIM) break;
    }
    if (!picked.length) {
      const s = Object.assign({}, order[0]);
      const room = Math.min(s.e - s.s, Math.max(T, MIN_TRIM));
      s.s = clamp(s.peakT - room * 0.6, s.s, s.e - room); s.e = s.s + room;
      picked.push(s);
    }
  }
  picked.sort((x, y) => x.s - y.s);

  // --- which get slow motion: the reel's biggest moment(s), and any a comment asked for ---
  const slowIds = new Set();
  if (notes.slow) {
    const k = notes.slowCount || (T <= 90 ? 1 : 2);
    picked.filter(s => !s.weak && s.peak >= 0.6).sort((x, y) => y.peak - x.peak).slice(0, k).forEach(s => slowIds.add(s.id));
    picked.filter(s => s.pins.some(p => p.slow)).forEach(s => slowIds.add(s.id));
    for (const [id, u] of overrides) { if (u.slow === true) slowIds.add(id); else if (u.slow === false) slowIds.delete(id); }
    while (slowIds.size > 3) slowIds.delete(Array.from(slowIds).pop());
  }

  // --- shots ---
  const shots = [];
  const info = { grids: 0, solos: 0, slow: 0, zoom: 0, bridges: 0, pinned: 0, starred: 0 };
  const shot = (isl, a, b, clipList, kind) => ({
    isl, s: a, e: b, speed: 1, zoom: null, kind: kind || (clipList.length > 1 ? 'grid' : 'solo'),
    members: clipList.map(c => ({ clip: c, start: a - c.a }))
  });
  let prev = null;
  for (const sp of picked) {
    const isl = sp.island;
    const ov = overrides.get(sp.id) || {};
    const pin = sp.pins[0] || null;
    let mode = notes.mode;
    // A style the user chose (all POVs / solo) outranks the AI's per-moment layout.
    if (notes.mode === 'auto' && (ov.layout === 'solo' || ov.layout === 'grid')) mode = ov.layout;
    const wantsZoom = notes.zoom && pin && pin.zoom;
    if (wantsZoom) mode = 'solo';
    const parts = [];
    let spanFeatured = null, hadGrid = false;

    // A long moment is taken in sections (split at its quietest points), so
    // the POV can change with the action while time runs on unbroken.
    for (const [a, b] of sections(isl, sp.s, sp.e)) {
      const hasPeak = sp.peakT >= a && sp.peakT <= b;
      const peakT = hasPeak ? sp.peakT : peakTime(isl, a, b);
      const level = {};
      Object.keys(isl.P).forEach(p => { level[p] = playerLevel(isl, p, peakT, 2) * (notes.boost[p] || 1); });
      const rank = (list) => list.slice().sort((x, y) => level[y] - level[x]);
      const full = Object.keys(isl.P).filter(p => covering(isl, p, a, b));

      if (!full.length) {
        // Nobody has this whole section on one file: follow it from file to
        // file, staying with the most involved player where possible.
        const order = rank(Object.keys(isl.P));
        if (pin && hasPeak) { order.splice(order.indexOf(pin.player), 1); order.unshift(pin.player); }
        for (const pc of chain(isl, a, b, order)) {
          const mates = (mode === 'grid' && !isl.untimed)
            ? rank(Object.keys(isl.P).filter(p => p !== pc.clip.player && covering(isl, p, pc.s, pc.e))).slice(0, MAX_TILES - 1)
            : [];
          parts.push(shot(isl, pc.s, pc.e, [pc.clip].concat(mates.map(p => covering(isl, p, pc.s, pc.e)))));
          if (mates.length) hadGrid = true;
          if (hasPeak && pc.s <= peakT && pc.e >= peakT) spanFeatured = pc.clip.player;
        }
        continue;
      }

      let featured = rank(full)[0];
      if (hasPeak && pin && full.includes(pin.player)) featured = pin.player;
      if (hasPeak && ov.feature && full.includes(playerKey(ov.feature))) featured = playerKey(ov.feature);
      if (hasPeak) spanFeatured = featured;
      const others = isl.untimed ? [] : rank(full.filter(p => p !== featured)).slice(0, MAX_TILES - 1);
      const clipsOf = (list, x, y) => list.map(p => covering(isl, p, x, y));
      const len = b - a;
      if (!others.length || mode === 'solo') parts.push(shot(isl, a, b, clipsOf([featured], a, b)));
      else if (mode === 'grid') { parts.push(shot(isl, a, b, clipsOf([featured].concat(others), a, b))); hadGrid = true; }
      else if (len >= GRID_THEN_SOLO_MIN) {
        const cut = clamp(peakT - 1, a + GRID_MIN, b - 3);
        parts.push(shot(isl, a, cut, clipsOf([featured].concat(others), a, cut)));
        parts.push(shot(isl, cut, b, clipsOf([featured], cut, b)));
        hadGrid = true;
      } else {
        const involved = others.filter(o => level[o] >= 0.6 * level[featured]);
        parts.push(shot(isl, a, b, clipsOf(involved.length ? [featured].concat(involved) : [featured], a, b)));
        if (involved.length) hadGrid = true;
      }
    }
    if (!parts.length) continue;

    // Slow motion (and a punch-in) on the peak, inside the solo part. Only
    // from footage recorded at 50 fps or more: at 30 it would stutter.
    const solo = parts.find(p => p.kind === 'solo' && p.s <= sp.peakT && p.e >= sp.peakT);
    const split = (a, b, make) => {
      if (a - solo.s < 1) a = solo.s;
      if (solo.e - b < 1) b = solo.e;
      const c = [solo.members[0].clip];
      const pieces = [];
      if (a > solo.s) pieces.push(shot(isl, solo.s, a, c));
      pieces.push(make(shot(isl, a, b, c)));
      if (b < solo.e) pieces.push(shot(isl, b, solo.e, c));
      parts.splice(parts.indexOf(solo), 1, ...pieces);
    };
    if (solo && slowIds.has(sp.id) && solo.members[0].clip.fps >= 50) {
      const zoom = notes.zoom
        ? { z: pin && pin.zoom ? COMMENT_ZOOM : SLOW_ZOOM, cx: pin ? pin.cx : 0.5, cy: pin ? pin.cy : 0.5 } : null;
      split(sp.peakT - SLOW_BEFORE, sp.peakT + SLOW_AFTER, (x) => { x.speed = 0.5; x.zoom = zoom; x.kind = 'slow'; return x; });
      info.slow++;
      if (zoom) info.zoom++;
    } else if (solo && wantsZoom) {
      // A comment that says "zoom": punch in on where it was placed.
      split(pin.t - 1, pin.t + 2.5, (x) => { x.zoom = { z: COMMENT_ZOOM, cx: pin.cx, cy: pin.cy }; x.kind = 'zoom'; return x; });
      info.zoom++;
    }

    // A quiet gap since the last moment of the same play: speed through it
    // instead of jumping over it.
    const first = parts[0];
    if (prev && notes.speed && prev.isl === isl) {
      const gap = first.s - prev.e;
      if (gap > 0.2 && gap <= BRIDGE_MAX_GAP) {
        const who = [first.members[0].clip.player, prev.player].concat(Object.keys(isl.P))
          .find(p => covering(isl, p, prev.e, first.s));
        if (who) {
          const br = shot(isl, prev.e, first.s, [covering(isl, who, prev.e, first.s)], 'bridge');
          br.speed = gap <= 4.5 ? 2 : gap <= 8 ? 3 : 4;
          shots.push(br);
          info.bridges++;
        }
      }
    }

    parts.forEach(p => shots.push(p));
    if (hadGrid) info.grids++; else info.solos++;
    if (sp.pins.length) info.pinned++;
    if (sp.starred) info.starred++;
    const lastPart = parts[parts.length - 1];
    prev = { isl, e: lastPart.e, player: spanFeatured || lastPart.members[0].clip.player };
  }

  // Sped-up gaps are a nicety: drop the longest until the reel is back
  // within 5% of the length asked for.
  const outLen = () => shots.reduce((n, sh) => n + (sh.e - sh.s) / sh.speed, 0);
  while (outLen() > T * 1.05 && shots.some(sh => sh.kind === 'bridge')) {
    const longest = shots.filter(sh => sh.kind === 'bridge').sort((x, y) => (y.e - y.s) / y.speed - (x.e - x.s) / x.speed)[0];
    shots.splice(shots.indexOf(longest), 1);
    info.bridges--;
  }
  if (!shots.length) return empty;

  // Shots that simply continue the same file at normal speed are one shot.
  for (let i = shots.length - 1; i > 0; i--) {
    const x = shots[i - 1], y = shots[i];
    if (x.isl === y.isl && Math.abs(y.s - x.e) < 0.02 && x.speed === 1 && y.speed === 1 && !x.zoom && !y.zoom &&
        x.kind === 'solo' && y.kind === 'solo' && x.members[0].clip === y.members[0].clip) {
      x.e = y.e;
      shots.splice(i, 1);
    }
  }

  // --- EDL ---
  const joined = (x, y) => x && y && x.isl === y.isl && Math.abs(y.s - x.e) < 0.05;
  const edl = shots.map((sh, i) => {
    const dur = r3(sh.e - sh.s);
    const hard0 = !joined(shots[i - 1], sh), hard1 = !joined(sh, shots[i + 1]);
    return {
      layout: sh.members.length >= 3 ? 'grid' : sh.members.length === 2 ? 'side' : 'solo',
      kind: sh.kind,
      duration: dur,
      speed: sh.speed,
      outDuration: r3(dur / sh.speed),
      zoom: sh.zoom,
      fadeIn: hard0 || sh.speed !== 1,
      fadeOut: hard1 || sh.speed !== 1,
      at: r3(sh.s),
      clipId: sh.members[0].clip.id,
      start: r3(sh.members[0].start),
      members: sh.members.map(m => ({ clipId: m.clip.id, start: r3(m.start) }))
    };
  });

  const outSec = edl.reduce((n, s) => n + s.outDuration, 0);
  const moments = picked.length;
  const stats = Object.assign({ outSec: r3(outSec), moments, shots: edl.length, level: ctx.level,
                                targetSec: ctx.targetSec, uniqueSec: r3(ctx.uniqueSec) }, info);
  return { edl, stats, report: writeReport(ctx, stats, !!(choice && overrides.size)) };
}

function writeReport(ctx, st, directed) {
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : /(ch|s)$/.test(w) ? 'es' : 's');
  const lines = [];
  lines.push(`${plural(st.moments, 'moment')} from ${plural(ctx.islands.length, 'stretch')} of play, ` +
    `${Math.round(st.outSec)} s long (you asked for ${ctx.targetSec} s).`);
  if (ctx.uniqueSec < ctx.targetSec - 1) {
    lines.push(`The selected clips hold ${Math.round(ctx.uniqueSec)} s of play once overlapping saves are counted once, so the reel can't be longer than that.`);
  }
  const bits = [];
  if (st.grids) bits.push(`${plural(st.grids, 'moment')} ${st.grids === 1 ? 'opens' : 'open'} on every POV that recorded it, then ${st.grids === 1 ? 'cuts' : 'cut'} to the player in the middle of it`);
  if (st.solos) bits.push(`${plural(st.solos, 'moment')} ${st.solos === 1 ? 'plays' : 'play'} from one POV`);
  if (bits.length) lines.push(bits.join('; ') + '.');
  const fx = [];
  if (st.slow) fx.push(plural(st.slow, 'slow-motion replay'));
  if (st.zoom > st.slow) fx.push(plural(st.zoom - st.slow, 'punch-in') + ' where a comment asked for a zoom');
  if (st.bridges) fx.push(plural(st.bridges, 'quiet gap') + ' sped up instead of cut');
  if (fx.length) lines.push('Effects: ' + fx.join(', ') + '.');
  const kept = [];
  if (st.pinned) kept.push(plural(st.pinned, 'commented moment'));
  if (st.starred) kept.push(plural(st.starred, 'starred moment'));
  if (kept.length) lines.push('Kept on purpose: ' + kept.join(' and ') + '.');
  if (ctx.notes && ctx.notes.understood.length) lines.push('From your notes: ' + ctx.notes.understood.join(', ') + '.');
  else if (ctx.styleNotes) lines.push('Your notes didn\'t match anything this editor understands yet (try: "solo only", "all POVs", "no slow motion", "tight", "longer holds", or a player\'s name).');
  lines.push('No moment is shown twice, and each player appears once per shot.');
  lines.push(ctx.localOnly
    ? 'To steer the next one: star a highlight, or add notes.'
    : 'To steer the next one: star a highlight, leave a comment on the moment you want kept (add "slow" or "zoom"), or add notes.');
  return (directed ? 'AI editor: ' : 'Editor: ') + lines.join(' ');
}

// One call for the common case.
function planReel(input) { return buildPlan(prepare(input)); }

// What the AI director is shown: the moments, never raw timestamps.
function describeMoments(ctx) {
  const fmt = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
  const def = new Set(pickedIds(ctx));
  return ctx.candidates.map(s => {
    const isl = s.island;
    const players = Object.keys(isl.P).filter(p => covering(isl, p, s.s, s.e))
      .map(p => ({ name: ctx.names[p], intensity: Math.round(playerLevel(isl, p, s.peakT, 2) * 100) }))
      .sort((x, y) => y.intensity - x.intensity);
    return {
      id: s.id, at: fmt(s.s), stretchOfPlay: isl.index + 1, seconds: Math.round((s.e - s.s) * 10) / 10,
      intensity: Math.round(s.score * 100), players,
      starred: s.starred || undefined,
      comments: s.pins.length ? s.pins.map(p => ({ by: p.by, on: ctx.names[p.player], text: p.text })) : undefined,
      inDefaultCut: def.has(s.id) || undefined
    };
  });
}
function pickedIds(ctx) {
  // The default cut's moments, by matching shot times back to candidates.
  const plan = buildPlan(ctx);
  const ids = [];
  for (const c of ctx.candidates) {
    if (plan.edl.some(sh => sh.kind !== 'bridge' && sh.at >= c.s - 0.01 && sh.at < c.e)) ids.push(c.id);
  }
  return ids;
}

// ---------- 4. Check a cut (tests and a runtime guard) ----------
// Independent of the planner: works only from the EDL and the clips' start
// times. -> { outSec, repeatedSec, samePlayerTwice, maxSyncErrSec, hardCuts, outOfBounds }
function checkEdl(edl, clipsIn) {
  const byId = new Map((clipsIn || []).map(c => [String(c.id), c]));
  const seen = new Map();
  let outSec = 0, repeatedSec = 0, samePlayerTwice = 0, maxSync = 0, hardCuts = 0, outOfBounds = 0;
  let prevEnd = null, prevKey = null;
  for (const seg of edl) {
    const speed = seg.speed || 1;
    outSec += seg.outDuration != null ? seg.outDuration : seg.duration / speed;
    const ms = (seg.members && seg.members.length ? seg.members : [{ clipId: seg.clipId, start: seg.start }])
      .map(m => ({ clip: byId.get(String(m.clipId)), start: Number(m.start) || 0 })).filter(m => m.clip);
    if (!ms.length) continue;
    const names = ms.map(m => playerKey(m.clip.player != null ? m.clip.player : m.clip.username));
    if (new Set(names).size < names.length) samePlayerTwice++;
    for (const m of ms) if (m.start < -0.01 || m.start + seg.duration > m.clip.duration + 0.05) outOfBounds++;
    const real = (m) => (Number.isFinite(m.clip.startTimeUTC) && m.clip.startTimeUTC > 0)
      ? m.clip.startTimeUTC / 1000 + m.start : null;
    const a = real(ms[0]);
    for (const m of ms.slice(1)) { const b = real(m); if (a !== null && b !== null) maxSync = Math.max(maxSync, Math.abs(b - a)); }
    const key = a !== null ? 'T' : 'U' + ms[0].clip.id;
    const base = a !== null ? a : ms[0].start;
    // Tenths of a second, half-open, so two shots that touch share nothing.
    const i0 = Math.floor(base * 10 + 1e-6), i1 = Math.floor((base + seg.duration) * 10 + 1e-6);
    for (let i = i0; i < i1; i++) {
      const k = key + i;
      const n = seen.get(k) || 0;
      if (n > 0) repeatedSec += 0.1;
      seen.set(k, n + 1);
    }
    if (prevEnd !== null && !(prevKey === key && Math.abs(base - prevEnd) < 0.06)) hardCuts++;
    prevEnd = base + seg.duration; prevKey = key;
  }
  return { outSec: r3(outSec), repeatedSec: r3(repeatedSec), samePlayerTwice, maxSyncErrSec: r3(maxSync),
           hardCuts, outOfBounds };
}

// ---------- 5. The ffmpeg command for one shot ----------
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2.0001) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.4999) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 0.001) parts.push('atempo=' + s.toFixed(4));
  return parts;
}

// seg: an EDL entry. getClip(clipId) -> { path, hasAudio } or null.
// opts: { encoder: [ffmpeg args], outPath, assFilter?: 'ass=...' }
// -> ffmpeg args (without the binary), or null if no member can be read.
function segmentArgs(seg, getClip, opts) {
  const raw = Array.isArray(seg.members) && seg.members.length ? seg.members : [{ clipId: seg.clipId, start: seg.start }];
  const members = raw.map(m => ({ start: Math.max(0, Number(m.start) || 0), clip: getClip(m.clipId) }))
    .filter(m => m.clip && m.clip.path).slice(0, MAX_TILES);
  if (!members.length) return null;

  const speed = seg.speed > 0 ? seg.speed : 1;
  const dur = Number(seg.duration);
  const out = (dur / speed).toFixed(3);
  const d = dur.toFixed(3);
  const ass = opts.assFilter ? ',' + opts.assFilter : '';
  const pts = `setpts=(PTS-STARTPTS)/${speed}`;
  const args = [];
  members.forEach(m => args.push('-ss', m.start.toFixed(3), '-t', d, '-i', m.clip.path));

  let filter;
  let silentIdx;
  if (members.length === 1) {
    silentIdx = 1;
    args.push('-f', 'lavfi', '-t', out, '-i', 'anullsrc=r=48000:cl=stereo');
    let crop = '';
    if (seg.zoom && seg.zoom.z > 1) {
      const f = 1 / seg.zoom.z;
      const x = clamp((seg.zoom.cx != null ? seg.zoom.cx : 0.5) - f / 2, 0, 1 - f);
      const y = clamp((seg.zoom.cy != null ? seg.zoom.cy : 0.5) - f / 2, 0, 1 - f);
      crop = `crop=w=iw*${f.toFixed(4)}:h=ih*${f.toFixed(4)}:x=iw*${x.toFixed(4)}:y=ih*${y.toFixed(4)},`;
    }
    // setpts before fps: a 60 fps clip slowed to half speed fills all 30
    // output frames with real ones.
    filter = `[0:v]${crop}${pts},fps=${OUT_FPS},scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,` +
      `pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p${ass}[v]`;
  } else {
    const pos = GRID_POS[members.length];
    const baseIdx = members.length;
    silentIdx = members.length + 1;
    args.push('-f', 'lavfi', '-t', out, '-i', `color=c=black:s=${CANVAS_W}x${CANVAS_H}:r=${OUT_FPS}`);
    args.push('-f', 'lavfi', '-t', out, '-i', 'anullsrc=r=48000:cl=stereo');
    const cell = `${pts},fps=${OUT_FPS},scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
      `pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    const chain = members.map((m, i) => `[${i}:v]${cell}[t${i}]`);
    let prev = `[${baseIdx}:v]`;
    members.forEach((m, i) => {
      const last = i === members.length - 1;
      chain.push(`${prev}[t${i}]overlay=${pos[i][0]}:${pos[i][1]}${last ? ',format=yuv420p' + ass + '[v]' : `[b${i}]`}`);
      prev = `[b${i}]`;
    });
    filter = chain.join(';');
  }

  // Sound: the first member's (the player the moment is about). Padded to
  // the picture's exact length so the joined reel never drifts.
  const a = [];
  if (members[0].clip.hasAudio) {
    a.push('asetpts=PTS-STARTPTS', 'aresample=48000:async=1000');
    atempoChain(speed).forEach(p => a.push(p));
    if (speed > 1) a.push('volume=0.6');
    if (seg.fadeIn) a.push(`afade=t=in:st=0:d=${FADE}`);
    if (seg.fadeOut) a.push(`afade=t=out:st=${Math.max(0, dur / speed - FADE).toFixed(3)}:d=${FADE}`);
    a.push(`apad=whole_dur=${out}`);
    filter += `;[0:a:0]${a.join(',')}[a]`;
  } else {
    filter += `;[${silentIdx}:a]anull[a]`;
  }

  return args.concat(
    ['-filter_complex', filter, '-map', '[v]', '-map', '[a]'],
    opts.encoder || [],
    ['-t', out, '-y', opts.outPath]
  );
}

// Where a comment left on a clip lands in a shot: its tile on the canvas
// (allowing for a punch-in) and its time in the shot (allowing for speed).
// -> [{ clipId, tile: { x, y, w, h }, toShotSec(clipSec) }]
function commentPlacement(seg) {
  const raw = Array.isArray(seg.members) && seg.members.length ? seg.members : [{ clipId: seg.clipId, start: seg.start }];
  const speed = seg.speed > 0 ? seg.speed : 1;
  return raw.slice(0, MAX_TILES).map((m, i) => {
    let tile;
    if (raw.length === 1) {
      tile = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
      if (seg.zoom && seg.zoom.z > 1) {
        const f = 1 / seg.zoom.z;
        const x = clamp((seg.zoom.cx != null ? seg.zoom.cx : 0.5) - f / 2, 0, 1 - f);
        const y = clamp((seg.zoom.cy != null ? seg.zoom.cy : 0.5) - f / 2, 0, 1 - f);
        tile = { x: -x * CANVAS_W / f, y: -y * CANVAS_H / f, w: CANVAS_W / f, h: CANVAS_H / f };
      }
    } else {
      const pos = GRID_POS[Math.min(raw.length, MAX_TILES)];
      tile = { x: pos[i][0], y: pos[i][1], w: TILE_W, h: TILE_H };
    }
    const start = Number(m.start) || 0;
    return { clipId: String(m.clipId), tile, toShotSec: (clipSec) => (clipSec - start) / speed };
  });
}

module.exports = {
  prepare, buildPlan, planReel, describeMoments, checkEdl,
  segmentArgs, commentPlacement, parseNotes,
  MAX_TILES, CANVAS_W, CANVAS_H, OUT_FPS
};
