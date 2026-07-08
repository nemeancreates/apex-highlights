// client/updater.js
// Silent-until-needed auto-updater for Peak-Abu.
// On app launch, checks server /api/version. If a newer version exists,
// prompts the user, downloads the installer to temp, runs it, and quits.

const { app, dialog, shell, BrowserWindow } = require('electron');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const VERSION_ENDPOINT = 'https://peakabu.app/api/version';
const CHECK_TIMEOUT_MS = 8000;

// Compare "0.1.10" > "0.1.9" — supports arbitrary segment counts
function isNewer(remote, current) {
  if (!remote || !current) return false;
  const r = String(remote).split('.').map(n => parseInt(n, 10) || 0);
  const c = String(current).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(r.length, c.length);
  for (let i = 0; i < len; i++) {
    const ri = r[i] || 0, ci = c[i] || 0;
    if (ri > ci) return true;
    if (ri < ci) return false;
  }
  return false;
}

// Fetch JSON from HTTPS with timeout, returns parsed object or null on any failure
function fetchVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const req = https.get(VERSION_ENDPOINT, { timeout: CHECK_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return done(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) { req.destroy(); done(null); }
      });
      res.on('end', () => {
        try { done(JSON.parse(body)); }
        catch { done(null); }
      });
    });

    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// Download the installer to temp with progress callback. Returns file path or null.
function downloadInstaller(url, onProgress) {
  return new Promise((resolve) => {
    // Basic URL sanity — must be https and end in .exe
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    if (parsed.protocol !== 'https:' || !parsed.pathname.endsWith('.exe')) {
      return resolve(null);
    }

    const filename = `PeakAbu-Update-${Date.now()}.exe`;
    const filePath = path.join(os.tmpdir(), filename);
    const file = fs.createWriteStream(filePath);
    let downloaded = 0;
    let total = 0;

    const cleanup = () => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(filePath); } catch {}
    };

    const request = (targetUrl, redirectsLeft) => {
      https.get(targetUrl, (res) => {
        // Follow redirects (CDN often 302s)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0 || !res.headers.location) {
            cleanup(); return resolve(null);
          }
          return request(res.headers.location, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume(); cleanup(); return resolve(null);
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total > 0) onProgress(downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(filePath)));
        file.on('error', () => { cleanup(); resolve(null); });
      }).on('error', () => { cleanup(); resolve(null); });
    };

    request(url, 5);
  });
}

// Small progress window shown after user consents to update
function showProgressWindow(parent) {
  const win = new BrowserWindow({
    width: 380,
    height: 140,
    parent,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Updating Peak-Abu',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  const html = `
    <html><head><style>
      body { font-family: Segoe UI, sans-serif; background: #1a1a1a; color: #eee;
             margin: 0; padding: 20px; user-select: none; }
      h3 { margin: 0 0 12px 0; font-weight: 500; font-size: 14px; }
      .bar { background: #333; border-radius: 4px; height: 8px; overflow: hidden; }
      .fill { background: linear-gradient(90deg,#4a9eff,#6bb6ff); height: 100%; width: 0%;
              transition: width 0.2s ease; }
      .pct { margin-top: 8px; font-size: 12px; color: #aaa; text-align: right; }
    </style></head>
    <body>
      <h3>Downloading update…</h3>
      <div class="bar"><div class="fill" id="fill"></div></div>
      <div class="pct" id="pct">0%</div>
      <script>
        const { ipcRenderer } = { ipcRenderer: null };
        window.addEventListener('message', e => {
          const pct = Math.max(0, Math.min(100, e.data.pct || 0));
          document.getElementById('fill').style.width = pct + '%';
          document.getElementById('pct').textContent = pct.toFixed(0) + '%';
        });
      </script>
    </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

// Launch the installer detached and quit the current app
function runInstallerAndQuit(installerPath) {
  try {
    const child = spawn(installerPath, ['--updated'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    // Small delay so the child is fully handed off before we exit
    setTimeout(() => app.quit(), 500);
  } catch (err) {
    console.error('Failed to launch installer:', err.message);
    dialog.showErrorBox('Update Failed', 'Could not launch the installer. Please download the update manually from peakabu.app.');
  }
}

// Main entry point. Fires once at app startup. Silent unless update available.
async function checkForUpdates(mainWindow) {
  const currentVersion = app.getVersion();

  // Skip in dev mode
  if (!app.isPackaged) {
    console.log(`[updater] Skipping check in dev (current: v${currentVersion})`);
    return;
  }

  console.log(`[updater] Current version: v${currentVersion} — checking for updates…`);
  const info = await fetchVersion();

  if (!info || !info.version) {
    console.log('[updater] No response from version endpoint — skipping');
    return;
  }

  if (!isNewer(info.version, currentVersion)) {
    console.log(`[updater] Up to date (server reports v${info.version})`);
    return;
  }

  console.log(`[updater] Update available: v${info.version}`);

  // Prompt the user
  const notes = info.releaseNotes ? `\n\nWhat's new:\n${String(info.releaseNotes).slice(0, 500)}` : '';
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `Peak-Abu v${info.version} is available.`,
    detail: `You're currently on v${currentVersion}.${notes}`,
    buttons: ['Update Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (response !== 0) {
    console.log('[updater] User deferred update');
    return;
  }

  if (!info.downloadUrl) {
    dialog.showErrorBox('Update Unavailable',
      'No download URL was provided. Please visit peakabu.app to download manually.');
    return;
  }

  // Show progress window
  const progressWin = showProgressWindow(mainWindow);
  const installerPath = await downloadInstaller(info.downloadUrl, (dl, total) => {
    const pct = (dl / total) * 100;
    if (progressWin && !progressWin.isDestroyed()) {
      progressWin.webContents.executeJavaScript(
        `window.postMessage({ pct: ${pct.toFixed(1)} }, '*');`
      ).catch(() => {});
    }
  });

  if (progressWin && !progressWin.isDestroyed()) progressWin.close();

  if (!installerPath) {
    dialog.showErrorBox('Download Failed',
      'The update could not be downloaded. Please check your connection and try again, or download manually from peakabu.app.');
    return;
  }

  console.log(`[updater] Downloaded to ${installerPath}, launching installer…`);
  runInstallerAndQuit(installerPath);
}

module.exports = { checkForUpdates };