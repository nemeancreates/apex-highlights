// analyze-usage.js — READ-ONLY diagnostic. Does not touch app state.
// Run on the droplet from /opt/peak-abu:
//   node analyze-usage.js
//
// Answers: how close do real sessions actually get to clipCap, what do
// real file sizes look like vs the 3-5MB assumption, and what does
// current + projected R2 storage cost actually look like per tier —
// using real numbers instead of the modeled worst-case.

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'peakabu.db'), { readonly: true });

// Keep in sync with server/config.js TIERS
const TIERS = {
  t1: { label: 'Free',    clipCap: 3600,   sessionsPerMonth: 6,   retentionDays: 1  },
  t2: { label: 'Creator', clipCap: 36000,  sessionsPerMonth: 20,  retentionDays: 15 },
  t3: { label: 'Squad',   clipCap: 79200,  sessionsPerMonth: 45,  retentionDays: 30 },
  t4: { label: 'Pro',     clipCap: 144000, sessionsPerMonth: 110, retentionDays: 60 }
};

const R2_STORAGE_PER_GB_MONTH = 0.015;

// One row per session: total weighted seconds used, total bytes stored,
// upload count. LEFT JOIN so empty sessions (0 uploads) still show up.
const sessions = db.prepare(`
  SELECT s.code, s.hostTier, s.maxClips, s.createdAt,
    COALESCE(SUM(u.clipWeight), 0) AS weightedUsed,
    COALESCE(SUM(u.fileSize), 0)   AS totalBytes,
    COUNT(u.id)                    AS uploadCount
  FROM sessions s
  LEFT JOIN uploads u ON u.sessionCode = s.code
  GROUP BY s.code
`).all();

const byTier = {};
for (const s of sessions) {
  const tier = s.hostTier || 'unknown';
  (byTier[tier] = byTier[tier] || []).push(s);
}

console.log(`Total sessions in DB: ${sessions.length}\n`);

for (const [tier, rows] of Object.entries(byTier)) {
  const cfg = TIERS[tier];
  const active = rows.filter(r => r.uploadCount > 0);

  const utilPcts = rows
    .filter(r => r.maxClips > 0)
    .map(r => r.weightedUsed / r.maxClips);
  const avgUtil = utilPcts.length ? utilPcts.reduce((a, b) => a + b, 0) / utilPcts.length : 0;
  const maxUtil = utilPcts.length ? Math.max(...utilPcts) : 0;
  const p90Util = utilPcts.length
    ? utilPcts.slice().sort((a, b) => a - b)[Math.floor(utilPcts.length * 0.9)]
    : 0;

  const totalUploads = rows.reduce((a, r) => a + r.uploadCount, 0);
  const totalBytes = rows.reduce((a, r) => a + r.totalBytes, 0);
  const avgFileSizeMB = totalUploads ? (totalBytes / totalUploads) / 1024 / 1024 : 0;
  const avgSessionMB = active.length ? (totalBytes / active.length) / 1024 / 1024 : 0;

  console.log(`--- ${tier}${cfg ? ' (' + cfg.label + ')' : ' (unknown/legacy)'} — ${rows.length} sessions, ${active.length} with uploads ---`);
  console.log(`  Avg clipCap utilization:  ${(avgUtil * 100).toFixed(2)}%`);
  console.log(`  p90 clipCap utilization:  ${(p90Util * 100).toFixed(2)}%`);
  console.log(`  Max clipCap utilization:  ${(maxUtil * 100).toFixed(2)}%`);
  console.log(`  Avg file size per upload: ${avgFileSizeMB.toFixed(2)} MB`);
  console.log(`  Avg total storage/session:${avgSessionMB.toFixed(1)} MB`);
  console.log(`  Total stored right now:   ${(totalBytes / 1024 / 1024 / 1024).toFixed(3)} GB`);
  console.log(`  Current R2 storage cost:  $${(totalBytes / 1024 / 1024 / 1024 * R2_STORAGE_PER_GB_MONTH).toFixed(4)}/mo (this snapshot only)`);

  if (cfg && active.length) {
    // Real per-user monthly projection: avg bytes/session * real sessions/mo
    // (using the tier's cap, since we don't have per-user session counts
    // here — swap in a real avg if you want tighter numbers) * retention ratio.
    const projectedGB = (avgSessionMB / 1024) * cfg.sessionsPerMonth * (cfg.retentionDays / 30);
    console.log(`  Projected steady-state storage @ full sessionsPerMonth: ${projectedGB.toFixed(2)} GB-month`);
    console.log(`  Projected cost/user/mo @ that rate: $${(projectedGB * R2_STORAGE_PER_GB_MONTH).toFixed(4)}`);
  }
  console.log('');
}

db.close();