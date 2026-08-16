// ================================
// JOIN ROUTE — the https bridge between a shared link (Discord, Slack,
// SMS, anywhere) and the peakabu:// protocol handler on the desktop client.
//
// Discord will not render custom-protocol links and its link buttons must
// be http(s), so every invite path has to land here first. This page's job:
// validate the code, hand off to the client, and degrade gracefully to a
// copyable code + download link if the client isn't installed.
// ================================
const { sanitizeCode } = require('../utils');
const { sessions } = require('../stores');
const { log } = require('../logger');

const BRAND = {
  bg: '#0a1611', card: '#0f2318', border: '#1e3527',
  teal: '#39d3a0', tealDim: '#1d9e75', text: '#e8f5ec',
  soft: '#c8d6cd', muted: '#5f7a6a'
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function page({ code, host, memberCount, valid, reason }) {
  const deepLink = `peakabu://join/${code}?autostart=1`;
  const title = valid
    ? `Join ${esc(host)}'s Peak-Abu squad`
    : 'Peak-Abu session unavailable';
  const desc = valid
    ? `Session ${code} — ${memberCount} in the squad. Click to join and start recording.`
    : (reason || 'This session has expired or the code is incorrect.');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://peakabu.app/join/${code}">
<meta property="og:image" content="https://peakabu.app/og-join.png">
<meta name="theme-color" content="${BRAND.teal}">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:${BRAND.bg};color:${BRAND.soft};font-family:'Segoe UI',Arial,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:14px;
        padding:34px 30px;max-width:440px;width:100%;text-align:center}
  .mark{font-size:44px;margin-bottom:10px}
  h1{color:${BRAND.text};font-size:22px;font-weight:600;margin-bottom:6px}
  .sub{color:${BRAND.muted};font-size:14px;margin-bottom:22px}
  .code{font-family:Consolas,'Courier New',monospace;font-size:34px;font-weight:600;
        letter-spacing:8px;color:${BRAND.text};background:#12251a;border:1px solid #24402e;
        border-radius:9px;padding:14px;margin-bottom:8px;cursor:pointer;user-select:all}
  .code:hover{border-color:${BRAND.teal}}
  .hint{font-size:12px;color:${BRAND.muted};margin-bottom:22px}
  .btn{display:block;width:100%;padding:14px;border-radius:9px;font-size:16px;font-weight:600;
       border:none;cursor:pointer;text-decoration:none;margin-bottom:10px;font-family:inherit}
  .primary{background:${BRAND.tealDim};color:#04140d;box-shadow:0 0 0 1px ${BRAND.teal}}
  .primary:hover{background:#23b686}
  .ghost{background:#14291d;color:#8fbfa3;border:1px solid #2a4636}
  .ghost:hover{border-color:${BRAND.teal};color:${BRAND.teal}}
  .foot{font-size:12px;color:${BRAND.muted};margin-top:18px;line-height:1.6}
  .err{color:#f0857a;font-size:15px;margin-bottom:20px}
</style>
</head>
<body>
  <div class="card">
    <div class="mark">&#x1F648;</div>
    ${valid ? `
      <h1>${esc(host)} invited you</h1>
      <div class="sub">${memberCount} ${memberCount === 1 ? 'player' : 'players'} in the squad</div>
      <div class="code" id="code" onclick="copyCode()">${code}</div>
      <div class="hint" id="hint">Click the code to copy it</div>
      <a class="btn primary" id="openBtn" href="${deepLink}">Open Peak-Abu &amp; Join</a>
      <a class="btn ghost" href="/player?code=${code}">Watch in browser instead</a>
      <div class="hint" id="handoff" style="display:none;color:${BRAND.teal};margin-top:14px;margin-bottom:0;">
        Peak-Abu is opening — you can close this tab.
      </div>
      <div class="foot">
        Nothing happened? <a href="https://peakabu.app" style="color:${BRAND.teal}">Download Peak-Abu</a>,
        then enter code <strong>${code}</strong> in the app.
      </div>
    ` : `
      <h1>Session unavailable</h1>
      <div class="err">${esc(desc)}</div>
      <a class="btn primary" href="https://peakabu.app">Go to Peak-Abu</a>
    `}
  </div>
${valid ? `<script>
  // No auto-handoff. The user picks one of the two buttons below —
  // "Open Peak-Abu & Join" or "Watch in browser instead" — nothing fires
  // on its own. Clicking the primary button navigates to the deep link
  // (browser-native <a href>), which is also the trigger main.js listens
  // for to route the join and, separately, decide whether to auto-start
  // recording.
  document.getElementById('openBtn').addEventListener('click', function() {
    setTimeout(function(){
      var h = document.getElementById('handoff');
      if (h) h.style.display = 'block';
    }, 1200);
  });

  function copyCode(){
    navigator.clipboard.writeText(${JSON.stringify(code)}).then(function(){
      document.getElementById('hint').textContent = 'Copied';
      setTimeout(function(){ document.getElementById('hint').textContent = 'Click the code to copy it'; }, 1800);
    });
  }
</script>` : ''}
</body>
</html>`;
}

function initJoinRoutes(app) {
  app.get('/join/:code', (req, res) => {
    const code = sanitizeCode(req.params.code);

    if (!code || code.length < 4) {
      return res.status(400).send(page({ code: '', valid: false, reason: 'That invite code is malformed.' }));
    }

    const session = sessions.get(code);
    if (!session) {
      log('info', 'join_page_miss', { code });
      return res.status(404).send(page({
        code, valid: false,
        reason: 'This session has expired or the code is incorrect.'
      }));
    }

    log('info', 'join_page_hit', { code, referer: req.get('referer') || null });

    res.send(page({
      code,
      host: session.createdBy,
      memberCount: session.members.length,
      valid: true
    }));
  });
}

module.exports = { initJoinRoutes };