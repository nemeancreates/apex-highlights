// ================================
// MODERATION — rules for who may go public, strikes and bans, automated
// scans, legal holds, and the case files + staff alerts that tie it together.
//
// routes/public.js owns listings and reports and calls in here. This module
// never touches listings directly: browse and roulette ask isHostAllowed()
// and sessionScanState() at read time, so a ban or a flag takes effect on
// every listing at once without rewriting rows.
//
// Rules (decided 10/15/26):
//   - Going public needs a tier with canListPublic (Creator / T2 and up).
//   - 3 staff-confirmed strikes = no more public posting, ever (until staff
//     lifts it). Auto-hides from reports are NOT strikes on their own —
//     staff confirm with the "remove" action, so a brigade can't ban anyone.
//   - A CSAM hash match (or staff confirming one) bans the host from public
//     posting immediately, places a legal hold, and sends an urgent case file.
// ================================
const crypto = require('crypto');
const { log } = require('../logger');
const { TIERS } = require('../config');
const { users, sessions } = require('../stores');
const { getEffectiveTier } = require('../auth');
const db = require('../db');
const { buildPdf } = require('./case-pdf');
const { postStaffAlert } = require('./staff-alerts');
const { scanUpload, scannerConfigured, logScannerStartup } = require('./scanner');
const { isOnHold, placeHold, getHold } = require('./legal-hold');

const STRIKES_TO_BAN = 3;
const NCMEC_URL = 'https://report.cybertip.org/';

db.exec(`
  CREATE TABLE IF NOT EXISTS moderation_scans (
    uploadId    TEXT PRIMARY KEY,
    sessionCode TEXT NOT NULL,
    verdict     TEXT NOT NULL,
    detail      TEXT,
    scannedAt   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mod_scans_session ON moderation_scans(sessionCode);

  CREATE TABLE IF NOT EXISTS public_strikes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    sessionCode TEXT,
    reason      TEXT NOT NULL,
    issuedBy    TEXT NOT NULL,
    createdAt   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_strikes_user ON public_strikes(username);

  CREATE TABLE IF NOT EXISTS public_bans (
    username    TEXT PRIMARY KEY,
    reason      TEXT NOT NULL,
    issuedBy    TEXT NOT NULL,
    createdAt   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS moderation_cases (
    caseId      TEXT PRIMARY KEY,
    sessionCode TEXT NOT NULL,
    kind        TEXT NOT NULL,
    summary     TEXT,
    createdAt   INTEGER NOT NULL
  );
`);

const stmt = {
  scansFor:     db.prepare(`SELECT * FROM moderation_scans WHERE sessionCode = ?`),
  putScan:      db.prepare(`
    INSERT INTO moderation_scans (uploadId, sessionCode, verdict, detail, scannedAt)
    VALUES (@uploadId, @sessionCode, @verdict, @detail, @scannedAt)
    ON CONFLICT(uploadId) DO UPDATE SET verdict = excluded.verdict, detail = excluded.detail, scannedAt = excluded.scannedAt
  `),
  strikesFor:   db.prepare(`SELECT * FROM public_strikes WHERE username = ? COLLATE NOCASE ORDER BY createdAt ASC`),
  addStrike:    db.prepare(`
    INSERT INTO public_strikes (username, sessionCode, reason, issuedBy, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `),
  clearStrikes: db.prepare(`DELETE FROM public_strikes WHERE username = ? COLLATE NOCASE`),
  banFor:       db.prepare(`SELECT * FROM public_bans WHERE username = ? COLLATE NOCASE`),
  addBan:       db.prepare(`
    INSERT INTO public_bans (username, reason, issuedBy, createdAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(username) DO NOTHING
  `),
  removeBan:    db.prepare(`DELETE FROM public_bans WHERE username = ? COLLATE NOCASE`),
  addCase:      db.prepare(`INSERT INTO moderation_cases (caseId, sessionCode, kind, summary, createdAt) VALUES (?, ?, ?, ?, ?)`),
  casesFor:     db.prepare(`SELECT * FROM moderation_cases WHERE sessionCode = ? ORDER BY createdAt ASC`),
  clearReview:  db.prepare(`UPDATE moderation_scans SET verdict = 'cleared', detail = COALESCE(detail, '') || ' (cleared by staff)' WHERE sessionCode = ? AND verdict = 'review'`),
  scanSessions: db.prepare(`SELECT DISTINCT sessionCode FROM moderation_scans`),
  dropScans:    db.prepare(`DELETE FROM moderation_scans WHERE sessionCode = ?`)
};

// Hooks routes/public.js registers, so this module can read reports and
// hide listings without requiring public.js (which requires this file).
const hooks = { getListing: () => null, getReports: () => [], hideListing: () => {} };
function registerListingHooks(h) { Object.assign(hooks, h); }

// ================================
// WHO MAY GO PUBLIC
// ================================
function getBan(username) { try { return stmt.banFor.get(username) || null; } catch (e) { return null; } }
function getStrikes(username) { try { return stmt.strikesFor.all(username); } catch (e) { return []; } }

// { ok, reason } — reason is user-facing.
function canListPublic(username) {
  const user = users.get(String(username || '').toLowerCase());
  if (!user) return { ok: false, reason: 'Sign in to make a session public.' };
  if (getBan(user.username)) return { ok: false, reason: 'Public posting is disabled on this account.' };
  const tier = getEffectiveTier(user);
  if (!TIERS[tier] || !TIERS[tier].canListPublic) {
    return { ok: false, reason: 'Public sessions are for Creator tier and up.' };
  }
  return { ok: true };
}

// Read-time filter for browse/roulette: banned hosts and held sessions vanish.
function isHostAllowed(session) {
  return !isOnHold(session.code) && !getBan(session.createdBy);
}

// ================================
// STRIKES + BANS
// ================================
function addStrike(username, sessionCode, reason, issuedBy) {
  stmt.addStrike.run(username, sessionCode || null, reason, issuedBy, Date.now());
  const count = getStrikes(username).length;
  let banned = false;
  if (count >= STRIKES_TO_BAN && !getBan(username)) {
    stmt.addBan.run(username, `${STRIKES_TO_BAN} strikes`, 'auto', Date.now());
    banned = true;
    log('warn', 'public_ban_strikes', { username, strikes: count });
  }
  log('info', 'public_strike', { username, sessionCode, count, issuedBy });
  return { count, banned };
}

function banFromPublic(username, reason, issuedBy) {
  stmt.addBan.run(username, reason, issuedBy, Date.now());
  log('warn', 'public_ban', { username, reason, issuedBy });
}

// Staff override of classifier flags (never touches csam verdicts).
function clearReviewFlags(code) { return stmt.clearReview.run(code).changes; }

function unban(username) { return stmt.removeBan.run(username).changes > 0; }
function clearStrikes(username) { return stmt.clearStrikes.run(username).changes; }

// ================================
// SCANS
// ================================
function scansFor(code) { try { return stmt.scansFor.all(code); } catch (e) { return []; } }

// 'clean'   — every watchable clip passed (or no scanner is configured)
// 'pending' — at least one clip hasn't been checked yet
// 'flagged' — something was flagged (csam or review)
function sessionScanState(session) {
  const conf = scannerConfigured();
  const clips = (session.uploads || []).filter(u => u.videoFile);
  const byId = new Map(scansFor(session.code).map(s => [s.uploadId, s]));
  let pending = false;
  for (const c of clips) {
    const s = byId.get(c.id);
    if (s && (s.verdict === 'csam' || s.verdict === 'review')) return 'flagged';
    if (!s && (conf.hashMatch || conf.classifier)) pending = true;
  }
  return pending ? 'pending' : 'clean';
}

const scanning = new Set();   // session codes with a scan in flight

// Scans every clip in the session that hasn't been scanned. Acts on the
// worst result: csam > review. Safe to call repeatedly.
async function scanSession(session) {
  const conf = scannerConfigured();
  if (!conf.hashMatch && !conf.classifier) return 'clean';
  if (scanning.has(session.code)) return 'pending';
  scanning.add(session.code);
  try {
    const done = new Set(scansFor(session.code).map(s => s.uploadId));
    const todo = (session.uploads || []).filter(u => u.videoFile && !done.has(u.id));
    let worst = null;
    for (const u of todo) {
      // Thumbnail not generated yet — leave it for the next sweep.
      if (!u.thumbnailUrl && !u.thumbnailKey) continue;
      const r = await scanUpload(session.code, u);
      if (r.verdict === 'unscanned') continue;   // retry next sweep
      stmt.putScan.run({ uploadId: u.id, sessionCode: session.code, verdict: r.verdict, detail: r.detail, scannedAt: Date.now() });
      if (r.verdict === 'csam') { worst = { verdict: 'csam', upload: u, detail: r.detail }; break; }
      if (r.verdict === 'review' && !worst) worst = { verdict: 'review', upload: u, detail: r.detail };
    }
    if (worst && worst.verdict === 'csam') {
      await handleCsam(session, { trigger: 'Automated scan', detail: worst.detail, uploadId: worst.upload.id, by: 'scanner' });
    } else if (worst && worst.verdict === 'review') {
      hooks.hideListing(session.code);
      await sendCase(session, {
        kind: 'scan-review', level: 'warn',
        title: `Scan flagged ${session.code} for review`,
        trigger: 'Automated content classifier',
        detail: `${worst.detail} (clip by ${worst.upload.username})`,
        actions: ['Listing hidden from /browse and roulette pending staff review.']
      });
    }
    return sessionScanState(session);
  } catch (err) {
    log('warn', 'moderation_scan_failed', { code: session.code, error: err.message });
    return 'pending';
  } finally {
    scanning.delete(session.code);
  }
}

// ================================
// CSAM PATH
// ================================
async function handleCsam(session, { trigger, detail, uploadId, by }) {
  const already = isOnHold(session.code);
  const caseId = newCaseId();
  if (!already) {
    placeHold(session.code, { caseId, reason: `Apparent CSAM: ${trigger}`, placedBy: by });
  }
  hooks.hideListing(session.code);
  banFromPublic(session.createdBy, 'Apparent CSAM', by);
  log('warn', 'csam_case_opened', { code: session.code, host: session.createdBy, trigger, caseId });
  await sendCase(session, {
    caseId, kind: 'csam', level: 'urgent',
    title: `URGENT: apparent CSAM in session ${session.code}`,
    trigger, detail: detail + (uploadId ? ` (clip ${uploadId})` : ''),
    actions: [
      'Legal hold placed: the session is preserved, will not expire, and is hidden from everyone (share link and player return "not found").',
      `Host "${session.createdBy}" is banned from public posting.`,
      'Listing removed from /browse and roulette.'
    ]
  });
}

// ================================
// CASE FILES
// ================================
function newCaseId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return `PA-${ymd}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function fmt(ms) {
  if (ms == null || ms === '') return '-';
  const t = typeof ms === 'number' ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return String(ms);
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
function mb(bytes) { return bytes ? (bytes / 1048576).toFixed(1) + ' MB' : '-'; }

const REASON_LABELS = {
  child: 'Involves a minor (child safety)', privacy: 'Someone did not agree to be shown',
  inappropriate: 'Inappropriate content', spam: 'Spam or misleading', other: 'Something else'
};

function buildCaseFile(session, { caseId, kind, trigger, detail, actions }) {
  const host = users.get(String(session.createdBy || '').toLowerCase()) || {};
  const listing = hooks.getListing(session.code);
  const reports = hooks.getReports(session.code);
  const scans = scansFor(session.code);
  const strikes = getStrikes(session.createdBy);
  const ban = getBan(session.createdBy);
  const hold = getHold(session.code);
  const clips = (session.uploads || []).filter(u => u.videoFile);
  const csam = kind === 'csam';

  const blocks = [
    { h1: `Peak-Abu moderation case ${caseId}` },
    { small: `Generated ${fmt(Date.now())}. CONFIDENTIAL - staff only. Contains no images or video by design.` },
    { rule: true },
    { h2: 'Summary', color: csam ? '0.7 0.1 0.2' : null },
    { kv: [
      ['Case type', { csam: 'Apparent child sexual abuse material', 'scan-review': 'Automated scan flag', report: 'User report', autohide: 'Auto-hidden by reports', 'staff-remove': 'Removed by staff' }[kind] || kind],
      ['Trigger', trigger],
      ['Detail', detail],
      ['Session', session.code],
      ['Host account', session.createdBy]
    ] },
  ];

  if (csam) {
    blocks.push(
      { h2: 'Required next steps (US law: 18 U.S.C. 2258A)', color: '0.7 0.1 0.2' },
      { p: '1. Do NOT download, copy, screenshot, forward or post the content anywhere, including this channel. Do not open it except as needed to make the report.' },
      { p: `2. File a CyberTipline report with NCMEC as soon as reasonably possible: ${NCMEC_URL}  (Providers should register for an ESP account with NCMEC for direct reporting.)` },
      { p: '3. Include the account, session, file keys and timestamps listed below. NCMEC forwards to the right law enforcement agency.' },
      { p: '4. Keep the legal hold in place. Reported material must be preserved for at least one year. Do not release the hold or delete the session.' },
      { p: '5. If anyone is in immediate danger, call 911 / local police first.' }
    );
  }

  blocks.push(
    { h2: 'Actions taken automatically' },
    ...(actions && actions.length ? actions.map(a => ({ p: '- ' + a })) : [{ p: '- None' }]),

    { h2: 'Session' },
    { kv: [
      ['Code', session.code],
      ['Title', session.title || '-'],
      ['Game / event', session.detectedGame || '-'],
      ['Created', fmt(session.createdAt)],
      ['Expires', hold ? 'Never (legal hold)' : fmt(session.expiresAt)],
      ['Host tier at creation', session.hostTier || '-'],
      ['Host has left', session.closed ? 'yes' : 'no'],
      ['Listed publicly', listing ? `${fmt(listing.listedAt)} (${listing.platform})` : 'no'],
      ['Listing hidden', listing ? (listing.hidden ? 'yes' : 'no') : '-'],
      ['Public views', listing ? listing.views : '-'],
      ['Legal hold', hold ? `${hold.caseId} - ${hold.reason} (${fmt(hold.createdAt)})` : 'none']
    ] },

    { h2: 'Host account' },
    { kv: [
      ['Username', host.username || session.createdBy],
      ['Account created', fmt(host.createdAt)],
      ['Current tier', host.username ? `${getEffectiveTier(host)} (source: ${host.tierSource || '-'})` : '-'],
      ['Tier expires', host.tierExpiresAt ? fmt(host.tierExpiresAt) : '-'],
      ['Discord', host.discordId ? `${host.discordUsername || '?'} (ID ${host.discordId})` : 'not linked'],
      ['Public ban', ban ? `${ban.reason} - by ${ban.issuedBy}, ${fmt(ban.createdAt)}` : 'no'],
      ['Strikes', `${strikes.length} of ${STRIKES_TO_BAN}`]
    ] },
    ...strikes.map((s, i) => ({ small: `Strike ${i + 1}: ${fmt(s.createdAt)} - ${s.reason} - session ${s.sessionCode || '-'} - by ${s.issuedBy}` })),

    { h2: `Clips (${clips.length})` },
    { small: 'Storage keys are object paths in the R2 bucket. Times are when the server received each file.' }
  );
  const scanById = new Map(scans.map(s => [s.uploadId, s]));
  clips.slice(0, 200).forEach((c, i) => {
    const sc = scanById.get(c.id);
    blocks.push({ kv: [
      [`#${i + 1} uploader`, c.username],
      ['Received', fmt(c.uploadedAt)],
      ['Moment', c.coordinatedTimestamp ? fmt(c.coordinatedTimestamp) : '-'],
      ['Length / size', `${c.durationMs ? Math.round(c.durationMs / 1000) + 's' : '-'} / ${mb(c.fileSize)}`],
      ['Video key', c.videoKey || c.videoFile || '-'],
      ['Thumbnail key', c.thumbnailKey || c.thumbnailFile || '-'],
      ['Scan', sc ? `${sc.verdict} - ${sc.detail || ''} (${fmt(sc.scannedAt)})` : 'not scanned'],
      ['Upload ID', c.id]
    ], labelWidth: 110 });
  });
  if (clips.length > 200) blocks.push({ small: `...and ${clips.length - 200} more clips.` });

  blocks.push({ h2: `Reports (${reports.length})` });
  if (!reports.length) blocks.push({ p: 'None.' });
  reports.forEach(r => blocks.push({ small: `${fmt(r.createdAt)} - ${REASON_LABELS[r.reason] || r.reason || 'no reason'} - reporter ${r.reporterKey}` }));

  blocks.push(
    { h2: 'Staff commands (run on the droplet)' },
    { small: `See reports:   curl -s localhost:3000/admin/public/reports -H "X-Admin-Secret: $ADMIN_SECRET"` },
    { small: `Keep removed + strike host:   curl -s -X POST localhost:3000/admin/public/${session.code} -H "X-Admin-Secret: $ADMIN_SECRET" -H "Content-Type: application/json" -d '{"action":"remove"}'` },
    { small: `Restore (no violation):   ... -d '{"action":"restore"}'` },
    { small: `Confirm CSAM (hold + ban + urgent case):   ... -d '{"action":"csam"}'` }
  );

  return buildPdf(blocks, { footer: `Peak-Abu case ${caseId} - CONFIDENTIAL` });
}

// Builds the case file, records it, and posts it to the staff channel.
async function sendCase(session, { caseId, kind, level, title, trigger, detail, actions }) {
  caseId = caseId || newCaseId();
  let pdf = null;
  try { pdf = buildCaseFile(session, { caseId, kind, trigger, detail, actions }); }
  catch (err) { log('error', 'case_pdf_failed', { code: session.code, error: err.message }); }
  try { stmt.addCase.run(caseId, session.code, kind, String(detail || '').slice(0, 500), Date.now()); } catch (e) {}

  const reports = hooks.getReports(session.code);
  const fields = [
    { name: 'Session', value: session.code, inline: true },
    { name: 'Host', value: session.createdBy, inline: true },
    { name: 'Reports', value: String(reports.length), inline: true },
    { name: 'Strikes', value: `${getStrikes(session.createdBy).length}/${STRIKES_TO_BAN}`, inline: true },
    { name: 'Trigger', value: trigger },
    { name: 'Detail', value: detail || '-' }
  ];
  if (actions && actions.length) fields.push({ name: 'Done automatically', value: actions.map(a => '- ' + a).join('\n') });
  if (kind === 'csam') {
    fields.push({ name: 'Report it', value: `Do not open, download or share the content. File with NCMEC CyberTipline: ${NCMEC_URL}\nSteps are in the attached case file.` });
  } else {
    fields.push({ name: 'Review', value: `Watch: https://peakabu.app/player?code=${session.code}\nDecide with the commands in the case file (restore / remove / csam).` });
  }
  await postStaffAlert({ title, level, fields, pdf, pdfName: `${caseId}.pdf`,
    description: `Case **${caseId}**` });
  return caseId;
}

// ================================
// SWEEP — scans clips added to public sessions, retries anything a scanner
// couldn't reach, and drops scan rows for purged sessions.
// ================================
function startModerationSweep(getListedCodes) {
  logScannerStartup();
  const run = async () => {
    for (const code of getListedCodes()) {
      const s = sessions.get(code);
      if (!s || isOnHold(code)) continue;
      if (sessionScanState(s) === 'pending') await scanSession(s);
    }
  };
  setTimeout(run, 60 * 1000);
  setInterval(run, 5 * 60 * 1000);
  setInterval(() => {
    try {
      for (const { sessionCode } of stmt.scanSessions.all()) {
        if (!sessions.has(sessionCode)) stmt.dropScans.run(sessionCode);
      }
    } catch (e) {}
  }, 60 * 60 * 1000);
}

module.exports = {
  registerListingHooks,
  canListPublic, isHostAllowed,
  getBan, getStrikes, addStrike, banFromPublic, unban, clearStrikes, clearReviewFlags,
  sessionScanState, scanSession,
  handleCsam, sendCase, buildCaseFile, newCaseId,
  startModerationSweep,
  STRIKES_TO_BAN
};
