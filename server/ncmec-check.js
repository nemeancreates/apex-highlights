// Checks the NCMEC settings against the API, from the droplet:
//   node server/ncmec-check.js            GET /status, then GET /xsd (saved to /tmp/ncmec.xsd)
//   node server/ncmec-check.js --test     also files one dummy report (no files), finished;
//                                         in the TEST environment only; refuses a live base.
// Settings come from server/.env, the same as the app.
const fs = require('fs');
const path = require('path');
for (const line of (fs.existsSync(path.join(__dirname, '.env')) ? fs.readFileSync(path.join(__dirname, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const ncmec = require('./moderation/ncmec');

(async () => {
  const s = ncmec.settings();
  if (!ncmec.configured()) {
    console.log('Settings incomplete. Needed in server/.env: NCMEC_API_BASE (https), NCMEC_USER, NCMEC_PASS, NCMEC_REPORTER_EMAIL.');
    process.exit(1);
  }
  const live = !/exttest\./.test(s.base);
  console.log(`API: ${s.base} (${live ? 'LIVE' : 'test'}) as ${s.user}`);
  const st = await ncmec.get('/status');
  console.log(`/status: HTTP ${st.status}`, st.text.replace(/\s+/g, ' ').slice(0, 300));
  const xsd = await ncmec.get('/xsd');
  if (xsd.status === 200) { fs.writeFileSync('/tmp/ncmec.xsd', xsd.text); console.log('/xsd: saved to /tmp/ncmec.xsd (' + xsd.text.length + ' bytes)'); }
  else console.log(`/xsd: HTTP ${xsd.status}`);
  if (process.argv.includes('--test')) {
    if (live) { console.log('Refusing to file a test report against the LIVE API.'); process.exit(1); }
    const r = await ncmec.fileReport({ url: 'https://peakabu.app/', screenName: 'peakabu-test-account', espIdentifier: 'peakabu-test-account', espService: 'Peakabu', info: 'TEST REPORT from the Peakabu integration check. Please disregard.' }, []);
    console.log('test report:', JSON.stringify(r));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
