// ================================
// GROWTH — anonymous, aggregate-only counters for the website and the apps.
//
// What is stored: whole-number counts per UTC day, nothing else. No IP
// addresses, no user agents, no cookies, no install ids, no accounts.
//   visits / visitors   page views, and distinct visitors that day
//   dl_*                clicks on the download buttons (PC Store, PC direct, Android)
//   launch_*            first launch of an install, by platform (and PC version)
//
// "Distinct visitors" uses a hash of address + browser mixed with a random
// salt made fresh every UTC day. The salt and the hashes live in memory only
// and are thrown away at midnight (or on restart), so yesterday's visitors
// cannot be matched to today's, and nothing on disk can be traced to a person.
//
// Everything else the report shows (accounts, sessions, clips, purchases,
// returning hosts) is counted from data the server already keeps; see
// derived() below.
// ================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.GROWTH_FILE || path.join(__dirname, 'growth.json');
const KEEP_DAYS = 400;
const MAX_SEEN = 200000;               // memory cap for today's visitor hashes

// Pages worth counting. Anything else (images, scripts, API calls) is not a visit.
const PAGES = {
  '/': 'home', '/index.html': 'home', '/guide': 'guide', '/pricing': 'pricing', '/mobile': 'mobile',
  '/browse': 'browse', '/support': 'support', '/account': 'account', '/billing': 'billing',
  '/privacy': 'legal', '/terms': 'legal'
};
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|discord|slack|whatsapp|telegram|curl|wget|python|node-fetch|axios|go-http|java\/|headless|phantom|lighthouse|monitor|uptime|pingdom|check_http/i;

let days = {};                          // 'YYYY-MM-DD' -> { counter: n }
let writeTimer = null;
let saltDay = '';
let salt = null;
let seen = new Set();

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function load() {
  try { days = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { days = {}; }
}
function flush() {
  clearTimeout(writeTimer); writeTimer = null;
  const cut = dayKey(Date.now() - KEEP_DAYS * 86400000);
  for (const k of Object.keys(days)) if (k < cut) delete days[k];
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(days));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.warn('[growth] save failed', e.message); }
}
function saveLater() { if (!writeTimer) { writeTimer = setTimeout(flush, 5000); writeTimer.unref(); } }

function count(name, n = 1) {
  const d = dayKey();
  const row = days[d] || (days[d] = {});
  row[name] = (row[name] || 0) + n;
  saveLater();
}

// ---------- who counts ----------
const isBot = (req) => BOT_RE.test(String(req.get('user-agent') || '')) || !req.get('user-agent');
// People who ask not to be measured (Do Not Track, Global Privacy Control) aren't.
const optedOut = (req) => req.get('dnt') === '1' || req.get('sec-gpc') === '1';
const clientAddr = (req) => String(req.get('cf-connecting-ip') || req.ip || '');

function newVisitorToday(req) {
  const d = dayKey();
  if (d !== saltDay) { saltDay = d; salt = crypto.randomBytes(16); seen = new Set(); }
  const h = crypto.createHash('sha256').update(salt).update(clientAddr(req) + '|' + req.get('user-agent')).digest('base64').slice(0, 16);
  if (seen.has(h)) return false;
  if (seen.size < MAX_SEEN) seen.add(h);
  return true;
}

// Express middleware, mounted before the static files: counts page loads.
function pageCounter(req, res, next) {
  try {
    if (req.method === 'GET' && PAGES[req.path] && String(req.get('accept') || '').includes('text/html') && !isBot(req) && !optedOut(req)) {
      count('visits');
      count('page_' + PAGES[req.path]);
      if (newVisitorToday(req)) count('visitors');
    }
  } catch { /* counting must never break a page */ }
  next();
}

// ---------- download buttons and first-launch pings ----------
const STORE_URL = process.env.MS_STORE_URL || 'https://apps.microsoft.com/detail/9MZFVNFQQHTP';
const ANDROID_URL = process.env.ANDROID_APK_URL || 'https://pub-2480e9beab9c4e958815881370670616.r2.dev/releases/peakabu-mobile.apk';

const pings = new Map();                 // address -> { n, at }; limits scripts, never written down
setInterval(() => { const cut = Date.now() - 3600000; for (const [k, v] of pings) if (v.at < cut) pings.delete(k); }, 600000).unref();

function initGrowthRoutes(app, { latestClient, secretOk }) {
  // Read by the Peakabu Mobile moderation dashboard (/mod) over the shared secret.
  app.get('/internal/mobile/growth', (req, res) => {
    if (!secretOk(req)) return res.status(403).json({ error: 'Forbidden' });
    res.set('Cache-Control', 'no-store');
    res.json(summary(req.query.days));
  });

  const go = (counter, target) => (req, res) => {
    if (!isBot(req)) count(counter);
    res.redirect(302, typeof target === 'function' ? target() : target);
  };
  app.get('/dl/pc', go('dl_pc_store', STORE_URL));
  app.get('/dl/pc-direct', go('dl_pc_direct', () => latestClient().downloadUrl));
  app.get('/dl/android', go('dl_android', ANDROID_URL));

  // The apps call this once, the first time they ever run. They remember that
  // they did on the device itself, so no id is needed here.
  app.post('/api/ping/launch', (req, res) => {
    const b = req.body || {};
    const platform = b.platform === 'pc' ? 'pc' : null;
    const addr = clientAddr(req);
    const p = pings.get(addr) || { n: 0, at: Date.now() };
    p.n++; pings.set(addr, p);
    if (platform && p.n <= 5 && !isBot(req)) {
      count('launch_' + platform);
      const v = String(b.version || '');
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) count('ver_' + platform + '_' + v);
    }
    res.status(204).end();
  });
}

// ---------- the report ----------
// Day-by-day rows plus the funnel. Mixes the counters above with numbers
// counted from the tables the server already has.
function derived(fromDay) {
  const db = require('./db');
  const byDay = (sql, ...p) => { const m = {}; for (const r of db.prepare(sql).all(...p)) m[r.d] = r.n; return m; };
  const from = fromDay + 'T00:00:00';
  const out = {
    accounts: byDay(`SELECT substr(createdAt,1,10) d, COUNT(*) n FROM users WHERE createdAt >= ? GROUP BY d`, from),
    sessions: byDay(`SELECT substr(createdAt,1,10) d, COUNT(*) n FROM sessions WHERE createdAt >= ? GROUP BY d`, from),
    newHosts: byDay(`SELECT substr(m,1,10) d, COUNT(*) n FROM (SELECT createdBy, MIN(createdAt) m FROM sessions GROUP BY lower(createdBy)) WHERE m >= ? GROUP BY d`, from),
    clips: byDay(`SELECT substr(uploadedAt,1,10) d, COUNT(*) n FROM uploads WHERE uploadedAt >= ? GROUP BY d`, from),
    newUploaders: byDay(`SELECT substr(m,1,10) d, COUNT(*) n FROM (SELECT username, MIN(uploadedAt) m FROM uploads WHERE uploadedAt IS NOT NULL GROUP BY lower(username)) WHERE m >= ? GROUP BY d`, from),
    purchases: {}, redeemed: {}
  };
  try {
    const ev = require('./redemption').codeEvents();
    const seenCheckout = new Set();
    for (const b of ev.bought) {
      if (!b.at || b.at < from || seenCheckout.has(b.note)) continue;   // one checkout can issue several codes
      seenCheckout.add(b.note);
      const d = b.at.slice(0, 10); out.purchases[d] = (out.purchases[d] || 0) + 1;
    }
    for (const r of ev.redeemed) { if (r.at && r.at >= from) { const d = r.at.slice(0, 10); out.redeemed[d] = (out.redeemed[d] || 0) + 1; } }
  } catch { /* codes not loaded: leave blank */ }
  return out;
}

// Of accounts made N days ago, how many hosted a session again later?
// "Hosted again" is the only activity the server keeps dates for.
function returning() {
  const db = require('./db');
  const DAY = 86400000, now = Date.now();
  const users = db.prepare(`SELECT username_lower u, createdAt c FROM users WHERE createdAt >= ?`).all(new Date(now - 36 * DAY).toISOString());
  const rows = db.prepare(`SELECT lower(createdBy) u, createdAt c FROM sessions WHERE createdAt >= ?`).all(new Date(now - 36 * DAY).toISOString());
  const acts = new Map();
  for (const r of rows) { (acts.get(r.u) || acts.set(r.u, []).get(r.u)).push(Date.parse(r.c)); }
  const res = { d1: { of: 0, n: 0 }, d7: { of: 0, n: 0 } };
  for (const u of users) {
    const t0 = Date.parse(u.c), mine = acts.get(u.u) || [];
    const on = (a, b) => mine.some((t) => t >= t0 + a * DAY && t < t0 + b * DAY);
    if (now - t0 >= 2 * DAY) { res.d1.of++; if (on(1, 2)) res.d1.n++; }       // hosted the day after signing up
    if (now - t0 >= 8 * DAY) { res.d7.of++; if (on(1, 8)) res.d7.n++; }       // hosted again within a week
  }
  return res;
}

function summary(nDays) {
  nDays = Math.max(1, Math.min(90, parseInt(nDays, 10) || 30));
  const list = [];
  for (let i = nDays - 1; i >= 0; i--) list.push(dayKey(Date.now() - i * 86400000));
  const d = derived(list[0]);
  const rows = list.map((day) => {
    const c = days[day] || {};
    return {
      day, visits: c.visits || 0, visitors: c.visitors || 0,
      dlPcStore: c.dl_pc_store || 0, dlPcDirect: c.dl_pc_direct || 0, dlAndroid: c.dl_android || 0,
      launchPc: c.launch_pc || 0,
      accounts: d.accounts[day] || 0, newHosts: d.newHosts[day] || 0, sessions: d.sessions[day] || 0,
      newUploaders: d.newUploaders[day] || 0, clips: d.clips[day] || 0,
      purchases: d.purchases[day] || 0, redeemed: d.redeemed[day] || 0
    };
  });
  const totals = {}, pages = {}, versions = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (k !== 'day') totals[k] = (totals[k] || 0) + v;
  for (const day of list) for (const [k, v] of Object.entries(days[day] || {})) {
    if (k.startsWith('page_')) pages[k.slice(5)] = (pages[k.slice(5)] || 0) + v;
    if (k.startsWith('ver_pc_')) versions[k.slice(7)] = (versions[k.slice(7)] || 0) + v;
  }
  return { generatedAt: new Date().toISOString(), days: nDays, rows, totals, pages, versions, returning: returning() };
}

load();
process.on('exit', () => { if (writeTimer) flush(); });

module.exports = { pageCounter, initGrowthRoutes, summary, count, _flush: flush, _days: () => days };
