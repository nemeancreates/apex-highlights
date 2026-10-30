// drop-deleted-clips.js — one-time cleanup, run on the droplet with the app STOPPED.
//   pm2 stop peak-abu
//   node server/drop-deleted-clips.js            (dry run: counts only)
//   node server/drop-deleted-clips.js --apply    (deletes the rows)
//   pm2 start peak-abu
//
// Before forgetUpload() (stores.js), a deleted clip or dropped placeholder
// kept its row in uploads, so every restart brought it back with nothing
// behind it. This removes rows whose video AND thumbnail are both gone from
// storage. A clip missing only one of them is listed, never deleted.
// Sessions under legal hold are skipped. Run with the app stopped: a running
// server would write its in-memory copy of these rows straight back.

const fs = require('fs');
const path = require('path');
for (const line of (fs.existsSync(path.join(__dirname, '.env')) ? fs.readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const Database = require('better-sqlite3');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { SPACES_REGION, SPACES_BUCKET, SPACES_ENDPOINT, PORT } = require('./config');

const APPLY = process.argv.includes('--apply');
const db = new Database(process.env.PEAKABU_DB || path.join(__dirname, 'peakabu.db'), { readonly: !APPLY });
const s3 = new S3Client({
  endpoint: SPACES_ENDPOINT, region: SPACES_REGION, forcePathStyle: true,
  credentials: { accessKeyId: process.env.SPACES_KEY, secretAccessKey: process.env.SPACES_SECRET }
});

// 'yes' | 'gone' | 'error'. Only a clear 404 counts as gone.
async function exists(Key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: SPACES_BUCKET, Key })); return 'yes'; }
  catch (e) { return e.$metadata && e.$metadata.httpStatusCode === 404 ? 'gone' : 'error'; }
}

(async () => {
  if (!process.env.SPACES_KEY) { console.log('SPACES_KEY not set: nothing to check.'); return; }
  if (APPLY) {
    const up = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (up) { console.log('The app is still running. Run "pm2 stop peak-abu" first, then try again.'); process.exitCode = 1; return; }
  }
  let held = new Set();
  try { held = new Set(db.prepare('SELECT sessionCode FROM legal_holds').all().map(r => r.sessionCode)); } catch (e) {}
  const rows = db.prepare(`SELECT id, sessionCode, username, videoKey, thumbnailKey FROM uploads
    WHERE videoKey IS NOT NULL OR thumbnailKey IS NOT NULL`).all().filter(r => !held.has(r.sessionCode));
  console.log(`Checking ${rows.length} clips in storage${held.size ? ` (${held.size} held sessions skipped)` : ''}...`);

  const results = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      const i = next++;
      const r = rows[i];
      results[i] = { video: r.videoKey ? await exists(r.videoKey) : 'gone', thumb: r.thumbnailKey ? await exists(r.thumbnailKey) : 'gone' };
    }
  }));

  const drop = [], partial = [], errors = [];
  rows.forEach((r, i) => {
    const { video, thumb } = results[i];
    if (video === 'error' || thumb === 'error') errors.push(r);
    else if (video === 'gone' && thumb === 'gone') drop.push(r);
    else if (video === 'gone' || thumb === 'gone') partial.push({ ...r, video, thumb });
  });

  const bySession = {};
  for (const r of drop) bySession[r.sessionCode] = (bySession[r.sessionCode] || 0) + 1;
  console.log(`Deleted clips that came back: ${drop.length}`);
  for (const [code, n] of Object.entries(bySession).sort((a, b) => b[1] - a[1])) console.log(`  ${code}: ${n}`);
  if (partial.length) {
    console.log(`Missing only one file (left alone): ${partial.length}`);
    for (const r of partial.slice(0, 20)) console.log(`  ${r.sessionCode} ${r.id} by ${r.username}: video ${r.video}, thumbnail ${r.thumb}`);
  }
  if (errors.length) console.log(`Couldn't check (left alone): ${errors.length}`);

  if (!APPLY) { console.log('Dry run: nothing changed. Add --apply (with the app stopped) to delete them.'); return; }
  const del = db.prepare('DELETE FROM uploads WHERE id = ?');
  const n = db.transaction(() => drop.reduce((sum, r) => sum + del.run(r.id).changes, 0))();
  console.log(`Deleted ${n} rows.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
