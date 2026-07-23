// client/updater.js
// Silent-until-needed auto-updater for Peak-Abu.
// On app launch, checks server /api/version. If a newer version exists,
// prompts the user via an in-app banner, downloads in the background,
// then asks if they're ready to restart before launching the installer.

const { app, dialog } = require('electron');
const https = require('https');
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
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    if (parsed.protocol !== 'https:' || !parsed.pathname.endsWith('.exe')) {
      return resolve(null);
    }

    const filename = `PeakAbu-Update-${Date.now()}.exe`;
    const filePath = path.join(os.tmpdir(), filename);

    const request = (targetUrl, redirectsLeft) => {
      https.get(targetUrl, { timeout: 60000 }, (res) => {
        // Follow redirects (CDN often 302s)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0 || !res.headers.location) {
            console.error('[updater] Redirect chain exhausted');
            return resolve(null);
          }
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          return request(nextUrl, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          console.error(`[updater] HTTP ${res.statusCode} from ${targetUrl}`);
          res.resume();
          return resolve(null);
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;

        const file = fs.createWriteStream(filePath);

        file.on('error', (err) => {
          console.error('[updater] File write error:', err.message);
          try { fs.unlinkSync(filePath); } catch {}
          resolve(null);
        });

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total > 0) onProgress(downloaded, total);
        });

        res.on('error', (err) => {
          console.error('[updater] Response stream error:', err.message);
          try { file.close(); fs.unlinkSync(filePath); } catch {}
          resolve(null);
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            try {
              const stats = fs.statSync(filePath);
              if (stats.size < 1024 * 1024) {
                console.error(`[updater] Downloaded file too small: ${stats.size} bytes`);
                try { fs.unlinkSync(filePath); } catch {}
                return resolve(null);
              }
              if (total > 0 && stats.size !== total) {
                console.error(`[updater] Size mismatch: got ${stats.size}, expected ${total}`);
                try { fs.unlinkSync(filePath); } catch {}
                return resolve(null);
              }
              console.log(`[updater] Downloaded ${stats.size} bytes to ${filePath}`);
              resolve(filePath);
            } catch (e) {
              console.error('[updater] Stat failed:', e.message);
              resolve(null);
            }
          });
        });
      }).on('error', (err) => {
        console.error('[updater] Request error:', err.message);
        resolve(null);
      }).on('timeout', function() {
        console.error('[updater] Request timed out');
        this.destroy();
        resolve(null);
      });
    };

    request(url, 5);
  });
}

// Launch the installer detached and quit the current app.
// --updated flag tells NSIS to skip the "welcome" page and go straight to install.
function runInstallerAndQuit(installerPath) {
  try {
    // shell.openPath hands the .exe to Windows properly — UAC prompt
    // surfaces correctly and SmartScreen can show its click-through.
    // spawn() with detached:true silently dies on both without an OV cert.
    const { shell } = require('electron');
    shell.openPath(installerPath).then((err) => {
      if (err) {
        console.error('[updater] shell.openPath failed:', err);
        dialog.showErrorBox('Update Failed',
          'Could not launch the installer. Please download manually from peakabu.app.');
      }
    });
    // Give shell.openPath a beat to hand off to Windows before quitting
    setTimeout(() => app.quit(), 1500);
  } catch (err) {
    console.error('[updater] Failed to launch installer:', err.message);
    dialog.showErrorBox('Update Failed',
      'Could not launch the installer. Please download manually from peakabu.app.');
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

  if (!info.downloadUrl) {
    console.log('[updater] No download URL — skipping');
    return;
  }

  // Tell the renderer to show the update banner
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  }

  // Download silently in the background while user keeps using the app
  console.log('[updater] Downloading update in background…');
  const installerPath = await downloadInstaller(info.downloadUrl, (dl, total) => {
    const pct = Math.round((dl / total) * 100);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { pct });
    }
  });

  if (!installerPath) {
    console.log('[updater] Download failed — notifying renderer');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-failed');
    }
    return;
  }

  // Download complete — tell renderer to show "ready to install" state
  console.log(`[updater] Download complete: ${installerPath}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-ready', { installerPath });
  }

  // Listen for user confirming they want to install now
  const { ipcMain } = require('electron');
  ipcMain.once('install-update', () => {
    runInstallerAndQuit(installerPath);
  });
}

module.exports = { checkForUpdates };