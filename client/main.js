const { app, BrowserWindow, globalShortcut, ipcMain, dialog, safeStorage } = require('electron');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const FormData = require('form-data');
const https = require('https');
const { checkForUpdates } = require('./updater');
const { buildReelLocally } = require('./aireel-client');

// ================================
// UPLOAD THROTTLE + LOW BANDWIDTH MODE
// The old static 6 Mbps ThrottleStream never engaged for anyone whose uplink
// is below 6 Mbps — exactly the players whose ping spiked. Throttling is now
// 60% of each player's MEASURED upload (speed test at launch, cached 24h),
// and in Low Bandwidth Mode videos wait for downtime. Logic + tests live in
// upload-queue.js; the state that drives it is further down, next to the
// pending-upload manifest.
// ================================
const {
  FIGHT_QUIET_MS, UPLOAD_MODES,
  normalizeSettings, isLowBandwidth, speedTestIsStale, baseThrottleBps, currentThrottleBps,
  RateThrottleStream, runSpeedTest,
  findLandedRecord, findPendingRecord, decideSweepAction
} = require('./upload-queue');
const { init: sentryInit } = require('@sentry/electron/main');
const { SENTRY_DSN } = require('./sentry-config');

if (SENTRY_DSN) {
  sentryInit({ dsn: SENTRY_DSN, release: `peak-abu@${app.getVersion()}` });
}


function getFFmpegPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  }
  return path.join(__dirname, 'ffmpeg', 'ffmpeg.exe');
}

// ================================
// DEEP LINK — peakabu://join/<CODE>?autostart=1
// Windows hands the URL to a NEW process, so a single-instance lock is
// mandatory: without it a second copy of the app launches, fights over the
// hotkey registration, and the running session never sees the link.
// ================================
const PROTOCOL = 'peakabu';
let pendingDeepLink = null;

if (!app.requestSingleInstanceLock()) {
  // The lock request already forwarded our argv to the running instance.
  app.exit(0);
}

function parseDeepLink(url) {
  if (typeof url !== 'string') return null;
  const m = /^peakabu:\/\/join\/([A-Za-z0-9]{4,6})/i.exec(url.trim());
  if (!m) return null;
  return {
    code: m[1].toUpperCase(),
    autostart: !/[?&]autostart=0/i.test(url)
  };
}

function extractDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    const parsed = parseDeepLink(a);
    if (parsed) return parsed;
  }
  return null;
}

function routeDeepLink(link) {
  if (!link) return;
  console.log(`Deep link received: join ${link.code} (autostart=${link.autostart})`);
  pendingDeepLink = link;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('deep-link-join', link);
  }
}

app.on('second-instance', (event, argv) => {
  routeDeepLink(extractDeepLink(argv));
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// macOS/Linux path — harmless on Windows
app.on('open-url', (event, url) => {
  event.preventDefault();
  routeDeepLink(parseDeepLink(url));
});

const DEFAULT_BUFFER_DIR = path.join(os.tmpdir(), 'apex-highlights-buffer');
const DEFAULT_CLIPS_DIR = path.join(app.getPath('videos'), 'PeakAbu');
const USER_PREFS_PATH = path.join(app.getPath('userData'), 'user-preferences.json');
const CHUNK_SECONDS = 10;

// ================================
// GAME DETECTION + WINDOW FILTERING
// Two jobs:
//   1. Keep Spotify / Steam / Explorer / browsers out of the Game Window
//      picker so users only see plausible capture targets.
//   2. Identify which game is running, for session history labelling (and
//      later, auto-capture genre selection).
// Process names are compared lowercase, without ".exe".
// ================================

// Known games → display name + genre. Genre drives the auto-capture settle
// window in a later release; harmless to carry now.
const GAME_PROCESS_MAP = {
  // --- Shooters
  'valorant-win64-shipping': { name: 'VALORANT', genre: 'shooter' },
  'valorant':                { name: 'VALORANT', genre: 'shooter' },
  'cs2':                     { name: 'Counter-Strike 2', genre: 'shooter' },
  'csgo':                    { name: 'CS:GO', genre: 'shooter' },
  'overwatch':               { name: 'Overwatch 2', genre: 'shooter' },
  'rainbowsix':              { name: 'Rainbow Six Siege', genre: 'shooter' },
  'rainbowsixgame':          { name: 'Rainbow Six Siege', genre: 'shooter' },
  'destiny2':                { name: 'Destiny 2', genre: 'shooter' },
  'escapefromtarkov':        { name: 'Escape from Tarkov', genre: 'shooter' },
  'huntgame':                { name: 'Hunt: Showdown', genre: 'shooter' },
  'discovery':               { name: 'THE FINALS', genre: 'shooter' },
  'marvel-win64-shipping':   { name: 'Marvel Rivals', genre: 'shooter' },
  'helldivers2':             { name: 'Helldivers 2', genre: 'shooter' },
  'warframe.x64':            { name: 'Warframe', genre: 'shooter' },
  'modernwarfare':           { name: 'Call of Duty', genre: 'shooter' },
  'cod':                     { name: 'Call of Duty', genre: 'shooter' },
  'blackopscoldwar':         { name: 'Call of Duty', genre: 'shooter' },
  'titanfall2':              { name: 'Titanfall 2', genre: 'shooter' },
  'thefinals':               { name: 'THE FINALS', genre: 'shooter' },
  'gta5':                    { name: 'GTA V', genre: 'shooter' },
  'gta5_enhanced':           { name: 'GTA V Enhanced', genre: 'shooter' },
  'rdr2':                    { name: 'Red Dead Redemption 2', genre: 'shooter' },

  // --- Battle royale (longer settle windows — sustained fights)
  'r5apex':                    { name: 'Apex Legends', genre: 'battle_royale' },
  'r5apex_dx12':               { name: 'Apex Legends', genre: 'battle_royale' },
  'fortniteclient-win64-shipping': { name: 'Fortnite', genre: 'battle_royale' },
  'tslgame':                   { name: 'PUBG', genre: 'battle_royale' },
  'warzone':                   { name: 'Warzone', genre: 'battle_royale' },
  'naraka':                    { name: 'Naraka: Bladepoint', genre: 'battle_royale' },

  // --- Survival / crafting
  'minecraft.windows':   { name: 'Minecraft', genre: 'survival' },
  'javaw':               { name: 'Minecraft (Java)', genre: 'survival' },
  'valheim':             { name: 'Valheim', genre: 'survival' },
  'rustclient':          { name: 'Rust', genre: 'survival' },
  'sonsofthaforest':     { name: 'Sons of the Forest', genre: 'survival' },
  'sonsoftheforest':     { name: 'Sons of the Forest', genre: 'survival' },
  '7daystodie':          { name: '7 Days to Die', genre: 'survival' },
  'projectzomboid':      { name: 'Project Zomboid', genre: 'survival' },
  'palworld-win64-shipping': { name: 'Palworld', genre: 'survival' },
  'shootergame':         { name: 'ARK', genre: 'survival' },
  'dayz':                { name: 'DayZ', genre: 'survival' },
  'satisfactory':        { name: 'Satisfactory', genre: 'survival' },
  'factorio':            { name: 'Factorio', genre: 'survival' },
  'terraria':            { name: 'Terraria', genre: 'survival' },

  // --- MOBA
  'league of legends':   { name: 'League of Legends', genre: 'moba' },
  'dota2':               { name: 'Dota 2', genre: 'moba' },
  'smite':               { name: 'SMITE', genre: 'moba' },
  'project8':            { name: 'Deadlock', genre: 'moba' },
  'deadlock':            { name: 'Deadlock', genre: 'moba' },
  'heroesofthestorm_x64':{ name: 'Heroes of the Storm', genre: 'moba' },

  // --- Horror (mic reactions carry the signal)
  'phasmophobia':        { name: 'Phasmophobia', genre: 'horror' },
  'deadbydaylight-win64-shipping': { name: 'Dead by Daylight', genre: 'horror' },
  'lethal company':      { name: 'Lethal Company', genre: 'horror' },
  'lethalcompany':       { name: 'Lethal Company', genre: 'horror' },
  'devour':              { name: 'DEVOUR', genre: 'horror' },
  'contentwarning':      { name: 'Content Warning', genre: 'horror' },
  'rEPO':                { name: 'R.E.P.O.', genre: 'horror' },

  // --- Sports / racing (near-constant audio floor)
  'rocketleague':        { name: 'Rocket League', genre: 'sports_racing' },
  'forzahorizon5':       { name: 'Forza Horizon 5', genre: 'sports_racing' },
  'forza_gaming.desktop.x64_release': { name: 'Forza', genre: 'sports_racing' },
  'acc':                 { name: 'Assetto Corsa Competizione', genre: 'sports_racing' },
  'assettocorsa':        { name: 'Assetto Corsa', genre: 'sports_racing' },
  'iracingsim64dx11':    { name: 'iRacing', genre: 'sports_racing' },
  'beamng.drive.x64':    { name: 'BeamNG.drive', genre: 'sports_racing' },
  'f1_24':               { name: 'F1 24', genre: 'sports_racing' },
  'fc25':                { name: 'EA FC', genre: 'sports_racing' },
  'nba2k25':             { name: 'NBA 2K', genre: 'sports_racing' }
};

// Never show these in the picker. This is the fix for "Spotify and a random
// Steam window show up as capture targets".
const NON_GAME_PROCESSES = new Set([
  // Browsers
  'chrome','msedge','firefox','brave','opera','opera_gx','vivaldi','iexplore','safari',
  // Chat / social / media
  'spotify','discord','discordptb','discordcanary','slack','teams','ms-teams','zoom',
  'telegram','whatsapp','signal','thunderbird','skype','vlc','mpc-hc64','mpc-hc',
  'itunes','applemusic','musicbee','foobar2000','audacity',
  // Launchers / storefronts
  'steam','steamwebhelper','epicgameslauncher','battle.net','battle.net helper',
  'ubisoftconnect','upc','galaxyclient','eadesktop','ealauncher','origin','riotclientux',
  'riotclientservices','playnite.desktoppapp','playnite.fullscreenapp','itch',
  // Capture / streaming (avoid recursive capture)
  'obs64','obs32','streamlabs obs','streamlabs','xsplit.core','nvcontainer',
  'nvidia share','nvidia overlay','medal','outplayed','peak-abu','electron',
  // Windows shell / system
  'explorer','applicationframehost','textinputhost','shellexperiencehost','searchhost',
  'searchapp','startmenuexperiencehost','systemsettings','taskmgr','lockapp',
  'widgets','widgetservice','sihost','dwm','rundll32','msinfo32','control',
  // Dev / office
  'code','devenv','rider64','idea64','pycharm64','webstorm64','sublime_text',
  'notepad','notepad++','winword','excel','powerpnt','outlook','onenote','msaccess',
  'windowsterminal','cmd','powershell','pwsh','conhost','wt','git-gui','gitkraken',
  'photoshop','illustrator','afterfx','premiere pro','blender','figma','krita','gimp',
  // Misc utilities
  '7zfm','winrar','calculator','calculatorapp','snippingtool','sndvol','mspaint','msedgewebview2'
]);

// Titles that are always shell chrome, regardless of process
const NON_GAME_TITLE_PATTERNS = [
  /^calculator$/i,
  /^program manager$/i,
  /^windows input experience$/i,
  /^microsoft text input application$/i,
  /^task manager$/i,
  /^settings$/i,
  /^search$/i,
  /^start$/i,
  /^peak-abu/i,
  /^new notification$/i,
  /^volume mixer$/i
];

function normalizeProcName(n) {
  return String(n || '').replace(/\.exe$/i, '').trim().toLowerCase();
}

function lookupGame(procName) {
  const key = normalizeProcName(procName);
  if (!key) return null;
  if (GAME_PROCESS_MAP[key]) return GAME_PROCESS_MAP[key];
  // Loose match for versioned/shipping variants (e.g. FooGame-Win64-Shipping)
  for (const k of Object.keys(GAME_PROCESS_MAP)) {
    if (key.startsWith(k) || k.startsWith(key)) return GAME_PROCESS_MAP[k];
  }
  return null;
}

// Unknown process: assume it's a game unless it's clearly not. Erring toward
// "show it" here is deliberate — a hard filter would hide someone's obscure
// indie title with no way to recover. The "Show all windows" checkbox in the
// picker is the escape hatch for anything this still gets wrong.
function isLikelyGameProcess(procName, title) {
  const key = normalizeProcName(procName);
  if (NON_GAME_TITLE_PATTERNS.some(re => re.test(String(title || '').trim()))) return false;
  if (!key) return false;                 // no process match at all — hide by default
  if (NON_GAME_PROCESSES.has(key)) return false;
  if (/^(microsoft|windows|nvidia|amd|intel|realtek|logitech|razer|corsair|steelseries)/i.test(key)) return false;
  return true;
}

// Single source of truth for "what windows exist". Used by both the picker
// and game detection so they can't disagree.
function enumerateWindowsPS() {
  return new Promise((resolve) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress"
    ], { windowsHide: true });

    let out = '';
    ps.stdout.on('data', d => out += d.toString());
    ps.on('close', () => {
      try {
        let parsed = JSON.parse(out);
        if (!Array.isArray(parsed)) parsed = [parsed];
        resolve(parsed
          .filter(w => w.MainWindowTitle && w.MainWindowTitle.trim() !== '')
          .filter(w => w.MainWindowTitle !== 'Peak-Abu')
          .map(w => ({ processName: w.ProcessName, title: w.MainWindowTitle })));
      } catch (e) {
        resolve([]);
      }
    });
    ps.on('error', () => resolve([]));
  });
}

// ================================
// DOCKED / WINDOWED WEB PLAYER
// Default: the player rides inside the main window as a WebContentsView on
// the right ~2/3, client shrinks to the left 1/3. Windowed mode (settings
// toggle) opens it as its own BrowserWindow that dies with the main window.
// ================================
let playerView = null;
let playerWindow = null;
let playerWindowedMode = false;
let aiReelWindow = null;
let playerDockedWidth = 0;       // px reserved from the right edge (view + gutter); 0 = not yet computed
const PLAYER_GUTTER = 6;         // width of the visible drag handle, carved out of the reserved zone
const MIN_PLAYER_VIEW = 360;     // floor for the visible player area
const MIN_CLIENT_WIDTH = 260;    // floor for the client column — this is what stops the squish

function defaultPlayerDockedWidth(winWidth) {
  // Client gets the majority share by default (~55%); drag the divider for more.
  return Math.round(winWidth * 0.45);
}

function clampPlayerDockedWidth(desired, winWidth) {
  // In windowed mode, there's no view taking up space in the main window,
  // so the client-width floor doesn't apply — it's purely a docked-mode
  // concern. Just clamp the player side (it still needs a minimum).
  if (playerWindowedMode) {
    const minAllowed = MIN_PLAYER_VIEW + PLAYER_GUTTER;
    return Math.max(minAllowed, desired);
  }

  const minAllowed = MIN_PLAYER_VIEW + PLAYER_GUTTER;
  const maxAllowed = Math.max(minAllowed, winWidth - MIN_CLIENT_WIDTH);
  return Math.min(maxAllowed, Math.max(minAllowed, desired));
}

function playerUrlFor(code, token, username) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (clean.length < 4) return 'https://peakabu.app/player';
  let url = `https://peakabu.app/player?code=${clean}`;
  // Credentials only ever get attached here — when the app opens the
  // player for ITS OWN logged-in user. Never put these on a link meant
  // to be shared (Copy Invite Link / the player's own "copy share link"
  // build their URLs separately and never pass through playerUrlFor).
  if (token && username) {
    url += `&t=${encodeURIComponent(token)}&u=${encodeURIComponent(username)}`;
  }
  // Bake in the current theme so first paint matches immediately instead
  // of waiting for the post-load pushThemeToPlayer() executeJavaScript
  // call (which still runs for LIVE theme changes — this just closes the
  // flash-of-default-theme gap on initial load). One base64 JSON param
  // rather than one query param per token, so adding/removing tokens
  // later doesn't require touching this function.
  if (latestThemeTokens) {
    try {
      const encoded = Buffer.from(JSON.stringify(latestThemeTokens), 'utf8').toString('base64');
      url += `&theme=${encodeURIComponent(encoded)}`;
    } catch (e) {
      console.log('[theme-push] failed to encode theme for URL:', e.message);
    }
  }
  return url;
}

function layoutPlayerView() {
  if (!playerView || !mainWindow || mainWindow.isDestroyed()) return;

  // Windows fires 'resize' on minimize, and getContentSize() reports a
  // bogus tiny size while minimized. Laying out against that used to
  // clamp playerDockedWidth down to the 360px floor and WRITE IT BACK —
  // so restoring the window left the player collapsed until the user
  // re-dragged the divider. Skip entirely while minimized.
  if (mainWindow.isMinimized()) return;

  const [w, h] = mainWindow.getContentSize();
  if (!w || !h || w < 200) return; // defensive: never lay out against a garbage size

  if (!playerDockedWidth) playerDockedWidth = defaultPlayerDockedWidth(w);

  // playerDockedWidth is the user's DESIRED width and is never mutated by
  // layout. The clamp result is local and applies only to this paint, so a
  // transient narrow window can't destroy the persisted preference.
  const appliedWidth = clampPlayerDockedWidth(playerDockedWidth, w);

  // The reserved zone is [player view][gutter]. The gutter is deliberately
  // NOT covered by the native view, so the renderer's divider/close button
  // (drawn in the base webContents layer) stay visible and clickable —
  // a WebContentsView renders above the window's own content wherever
  // their bounds overlap, so anything drawn under it would be invisible.
  const viewWidth = appliedWidth - PLAYER_GUTTER;
  playerView.setBounds({ x: w - viewWidth, y: 0, width: viewWidth, height: h });

  // Read back what the view ACTUALLY got rather than trusting what we asked
  // for. Electron can adjust bounds, and getContentSize() (DIP) may not match
  // the renderer's window.innerWidth (CSS px) on scaled displays — which is
  // what leaves a gap between the divider and where the view really starts.
  const applied = playerView.getBounds();
  const actualViewLeft = applied.x;
  const actualViewWidth = applied.width;

  console.log(
    `[dock] w=${w} desired=${playerDockedWidth} applied=${appliedWidth} ` +
    `viewWidth=${viewWidth} appliedX=${applied.x} appliedW=${applied.width} ` +
    `gutter=${PLAYER_GUTTER} dividerShouldBeAt=${w - appliedWidth + PLAYER_GUTTER}`
  );

  mainWindow.webContents.send('player-docked', {
    docked: true,
    reservedRight: appliedWidth,
    gutter: PLAYER_GUTTER,
    // Authoritative geometry, straight from the applied bounds
    viewLeft: actualViewLeft,
    viewWidth: actualViewWidth,
    contentWidth: w
  });
}

let latestThemeTokens = null;

function pushThemeToPlayer() {
  if (!latestThemeTokens) return;
  // Ship tokens as one JSON blob and let the player apply + persist them
  // itself (via window.paApplyThemeTokens, defined in index.html). Falls
  // back to raw setProperty calls if that function isn't present yet —
  // e.g. a very old cached page — so a live theme push never silently
  // no-ops. The try/catch around localStorage covers private-browsing
  // contexts where it can throw.
  const payload = JSON.stringify(latestThemeTokens);
  const js = `
    (function () {
      var tokens = ${payload};
      if (window.paApplyThemeTokens) {
        window.paApplyThemeTokens(tokens);
      } else {
        Object.keys(tokens).forEach(function (k) {
          document.documentElement.style.setProperty(k, tokens[k]);
        });
      }
      try { localStorage.setItem('pa_theme_tokens', JSON.stringify(tokens)); } catch (e) {}
    })();
  `;
  if (playerView && playerView.webContents) {
    playerView.webContents.executeJavaScript(js).catch((e) => console.log('[theme-push] docked player failed:', e.message));
  }
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.executeJavaScript(js).catch((e) => console.log('[theme-push] windowed player failed:', e.message));
  }
}


function openDockedPlayer(code, token, username) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { WebContentsView } = require('electron');
  if (playerView) {
    playerView.webContents.loadURL(playerUrlFor(code, token, username));
    layoutPlayerView();
    return;
  }
  playerView = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  mainWindow.contentView.addChildView(playerView);
  playerView.webContents.on('did-finish-load', () => pushThemeToPlayer());
  playerView.webContents.loadURL(playerUrlFor(code, token, username));
  layoutPlayerView();
  if (!app.isPackaged) playerView.webContents.openDevTools({ mode: 'detach' });
  console.log('Web player docked into main window');
}

function closeDockedPlayer() {
  if (!playerView) return;
  try { mainWindow.contentView.removeChildView(playerView); } catch (e) {}
  try { playerView.webContents.close(); } catch (e) {}
  playerView = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-docked', { docked: false, reservedRight: 0 });
  }
  console.log('Docked web player closed');
}

function openWindowedPlayer(code, token, username) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-docked', { docked: false, reservedRight: 0 });
  }

  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.webContents.loadURL(playerUrlFor(code, token, username));
    playerWindow.show();
    playerWindow.focus();
    return;
  }

  const b = mainWindow.getBounds();
  playerWindow = new BrowserWindow({
    width: Math.round(b.width * 0.62),
    height: b.height,
    x: b.x + Math.round(b.width * 0.38),
    y: b.y,
    title: 'Peak-Abu Player',
    backgroundColor: '#0a1611',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  playerWindow.setMenuBarVisibility(false);
  playerWindow.webContents.on('did-finish-load', () => pushThemeToPlayer());
  playerWindow.loadURL(playerUrlFor(code, token, username));
  if (!app.isPackaged) playerWindow.webContents.openDevTools({ mode: 'detach' });
  playerWindow.on('closed', () => { playerWindow = null; });
  console.log('Web player opened in its own window');
}

function closeAnyPlayer() {
  closeDockedPlayer();
  if (playerWindow && !playerWindow.isDestroyed()) {
    try { playerWindow.destroy(); } catch (e) {}
  }
  playerWindow = null;
}

// ================================
// AI REEL WINDOW — dedicated window for local clip selection + reel build.
// Separate from the main window so the clip checklist has real room, and
// so a long local render doesn't compete for the main window's attention.
// ================================
function openAiReelWindow(params) {
  const sessionId = (params && params.sessionId) ? String(params.sessionId).toUpperCase() : '';
  const maxSec = (params && params.maxSec) || 0;
  const username = (params && params.username) || '';
  const query = { session: sessionId, maxSec: String(maxSec), user: username };

  if (aiReelWindow && !aiReelWindow.isDestroyed()) {
    aiReelWindow.loadFile('aireel-window.html', { query });
    aiReelWindow.show();
    aiReelWindow.focus();
    return;
  }

  aiReelWindow = new BrowserWindow({
    width: 660, height: 1020,
    minWidth: 520, minHeight: 700,
    title: 'Peak-Abu — AI Reel',
    backgroundColor: '#0a1611',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  aiReelWindow.setMenuBarVisibility(false);
  aiReelWindow.loadFile('aireel-window.html', { query });
  if (!app.isPackaged) aiReelWindow.webContents.openDevTools({ mode: 'detach' });
  aiReelWindow.on('closed', () => { aiReelWindow = null; });
  console.log('AI Reel window opened');
}

// Shared resolution key <-> dimensions map (used for saving AND applying)
const RESOLUTION_MAP = {
  native: null,
  '720': { width: 1280, height: 720 },
  '480': { width: 854, height: 480 }
};


let BUFFER_DIR = DEFAULT_BUFFER_DIR;
let CLIPS_DIR = DEFAULT_CLIPS_DIR;

let maxChunks = 18;
let recordFps = 30;
let recordResolution = null;
let recordResolutionKey = 'native'; // 'native' | '720' | '480' — persisted key form
let savedMonitorIndex = null; // last user-selected monitor index, persisted
let customHotkey = 'F9';
let startupHotkeyRegistered = true;
let starHotkey = null;              // star key (v0.1.87) — unbound until the user sets one
let starHotkeyRegistered = true;
let captureHdr = false;
let captureAdapter = null;
let captureWindowTitle = null; 
let clockOffset = 0;
let clockUncertaintyMs = null;
let ffmpegProcess = null;
let mainWindow = null;
let currentSession = null;
let authToken = null;
let useCpuEncoder = false;
let currentMonitor = null;
let videoStartTime = null;
let audioFirstChunkTime = null;
let bufferReadyWatcher = null;
let recordingStartTime = null;
let recordingSessionTag = Date.now();
let lastHighlightBoundary = 0;
let autoCaptureLocked = false; // true while a server-side auto-capture ACTIVE window is open — suspends chunk pruning so the whole window survives to save time

let hlAudioPath = null;
let hlMicPath = null;
let hlAudioChunkCount = 0;
let hlMicChunkCount = 0;

// ================================
// AUTO-CAPTURE PEAK LOG — rolling log of audio-peak events streamed from
// the renderer's analyzer (client/index.html: acPollSource). Not used for
// anything capture-triggering — that's still the server-authoritative
// auto-peak/auto-capture-* socket flow. This is purely so a saved clip can
// carry a record of WHEN things got loud and WHEN mic activity started/
// stopped, for the web player's combat/mic timeline markers (queued
// separately). Reset per recording session, pruned continuously.
// ================================
let peakLogBuffer = []; // { t: localMs, source: 'desktop'|'mic', intensity?: number, event?: string }
const PEAK_LOG_MAX_AGE_MS = 15 * 60 * 1000; // generous — comfortably covers any realistic buffer span

let fullSessionMode = false;
let fullSessionDir = null;
let sessionArchiveActive = false;
let diskWatchTimer = null;
let fullSessionAudioChunks = [];
let fullSessionMicChunks = [];
let fullSessionAudioIndex = 0;

const DISK_WARN_BYTES = 20 * 1024 * 1024 * 1024;
const DISK_STOP_BYTES = 10 * 1024 * 1024 * 1024;

// ================================
// WGC (WINDOW GRAPHICS CAPTURE) STATE
// ================================
let wgcCaptureMode = false;
let wgcSourceId = null;
let wgcLastWindowTitle = null;
let wgcFileStreams = {};
let wgcFiles = [];
let wgcRolloverTimer = null;
let wgcSaveInFlight = false;
let pipelineBusy = false;
const pendingSaveQueue = [];
// The window-capture save currently cutting footage: its window start and
// the buffer files it has open. Cleanup never deletes those files.
let wgcActiveSave = null;
// Work waiting for the save queue to empty — a Stop or a window-capture
// fallback keeps the buffer (and audio) until every queued save has run.
const saveQueueIdleCallbacks = [];

// Footage the buffer must keep. A save waits after the press for its window
// END to reach disk (POST-ROLL WAIT) — 26 s for a 3 min clip — and the
// rolling buffer used to keep deleting the oldest chunks meanwhile, cutting
// the START off long clips (163 of 180 s, 9-26-26). Saves waiting out their
// post-roll hold their window start here; queued and running saves count too.
const saveWindowsWaiting = new Set();
let activeSaveWindowStart = null;

// Earliest footage (local clock) a waiting, queued or running save still
// needs. Infinity when none.
function saveNeededFromLocal() {
  let min = Infinity;
  for (const h of saveWindowsWaiting) min = Math.min(min, h.start);
  if (activeSaveWindowStart !== null) min = Math.min(min, activeSaveWindowStart);
  for (const q of pendingSaveQueue) min = Math.min(min, saveWindowLocal(q.saveTimeUTC, q.durationMs, q.triggerSource).start);
  return min;
}

// The session's clip length (set by the host, can change mid-session). The
// buffer grows to fit it so a longer clip never needs a restart to fit.
let sessionClipDurationMs = 0;
function effectiveMaxChunks() {
  const forClip = sessionClipDurationMs > 0 ? Math.ceil(sessionClipDurationMs / (CHUNK_SECONDS * 1000)) + 3 : 0;
  return Math.max(maxChunks, forClip);
}

function releaseSavePipeline() {
  if (!pipelineBusy) return; // already released, avoid double-drain
  pipelineBusy = false;
  wgcSaveInFlight = false;
  wgcActiveSave = null;
  activeSaveWindowStart = null;
  markFightSignal();   // quiet period restarts from the end of the save
  if (pendingSaveQueue.length > 0) {
    const next = pendingSaveQueue.shift();
    console.log(`Save pipeline free — starting queued ${next.triggerSource || 'manual'} save (${pendingSaveQueue.length} still queued)`);
    broadcastQueueState();
    doSaveHighlight(next.saveTimeUTC, next.clipChunks, next.durationMs, next.coordinatedTs, 0, next.triggerSource, next.ctx);
    return;
  }
  broadcastQueueState();
  const waiting = saveQueueIdleCallbacks.splice(0);
  for (const fn of waiting) {
    try { fn(); } catch (e) { console.log('Save-queue idle task failed:', e.message); }
  }
  if (wgcFiles.length > 2) wgcCleanupOldFiles();
}

// Run fn once nothing is saving or queued (immediately if that's now).
function onSaveQueueIdle(fn) {
  if (!pipelineBusy && pendingSaveQueue.length === 0) { fn(); return; }
  saveQueueIdleCallbacks.push(fn);
}

// ================================
// SAVE FAILURE LEDGER
// A highlight that fails to SAVE leaves no file behind, so Sync — which
// works from the clips on disk — had nothing to report and said "all
// uploaded ✓" while POVs were missing (Nemean, 9/25). Every failed or
// dropped save during a session is recorded here, and Sync shows the count.
// ================================
const SAVE_FAILURES_PATH = path.join(app.getPath('userData'), 'save-failures.json');
const SAVE_FAILURES_MAX = 300;

function readSaveFailures() {
  try {
    if (fs.existsSync(SAVE_FAILURES_PATH)) {
      const arr = JSON.parse(fs.readFileSync(SAVE_FAILURES_PATH, 'utf8'));
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { console.log('Could not read save-failures ledger:', e.message); }
  return [];
}

function recordSaveFailure(ctx, coordinatedTs, reason) {
  const sessionCode = ctx && ctx.sessionCode;
  if (!sessionCode) return; // solo saves have no session for Sync to report against
  try {
    const list = readSaveFailures();
    list.push({ at: Date.now(), sessionCode, coordinatedTs: coordinatedTs || null, mode: (ctx && ctx.mode) || null, reason });
    const tmp = SAVE_FAILURES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-SAVE_FAILURES_MAX)));
    fs.renameSync(tmp, SAVE_FAILURES_PATH);
  } catch (e) { console.log('Could not write save-failures ledger:', e.message); }
}

function saveFailuresForSession(code) {
  const want = String(code || '').toUpperCase();
  return readSaveFailures().filter(f => String(f.sessionCode || '').toUpperCase() === want);
}

// Drops every queued (not yet started) save, records each, and tells the
// user how many — never silently.
function dropQueuedSaves(reason) {
  if (pendingSaveQueue.length === 0) return 0;
  const dropped = pendingSaveQueue.splice(0);
  for (const q of dropped) recordSaveFailure(q.ctx, q.coordinatedTs, reason);
  console.log(`Dropped ${dropped.length} queued save(s): ${reason}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('highlight-error',
      `${dropped.length} queued highlight save${dropped.length === 1 ? ' was' : 's were'} dropped — ${reason}`);
  }
  broadcastQueueState();
  return dropped.length;
}

// The footage window a save cuts, in local clock. Manual anchors a
// point-in-time press (90% before, 10% after); auto's moment is already the
// END of the detected span.
function saveWindowLocal(saveTimeUTC, durationMs, triggerSource) {
  const at = saveTimeUTC - clockOffset;
  return triggerSource === 'auto'
    ? { start: at - durationMs, end: at }
    : { start: at - 0.9 * durationMs, end: at + 0.1 * durationMs };
}
let wgcMidSessionRestarts = 0;
const WGC_MAX_RESTARTS = 3;
// Bumped whenever a new window capture starts, so a cleanup deferred for an
// old capture's queued saves can never delete a newer capture's files.
let wgcGeneration = 0;
// Start of the oldest footage still buffered once cleanup has deleted
// anything — a save whose window begins before it can't be cut any more.
let wgcTrimmedBeforeUTC = null;
// Buffer files are kept past the 2 newest only while a running or queued
// save still needs them; past this many, the oldest go anyway (disk).
const WGC_MAX_FILES = 8;
// A window may start up to this far before the first file of a fresh
// capture (recorder start latency) and still be cut from its top.
const WGC_START_SLACK_MS = 2000;

const XINPUT_BUTTON_MAP = [
  0x1000, 0x2000, 0x4000, 0x8000,
  0x0100, 0x0200,
  -1, -2,
  0x0020, 0x0010,
  0x0040, 0x0080,
  0x0001, 0x0002, 0x0004, 0x0008,
  0
];

let xinputProcess = null;
let gamepadPrefs = { buttonIndex: null, triggerMode: 'double' };
let gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
let xinputConnected = false;

function startXInputPoll() {
  if (xinputProcess) return;

  const script = [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class XI {',
    '  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, ref XIS s);',
    '  [StructLayout(LayoutKind.Sequential)] public struct XIS { public int P; public XGP G; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct XGP {',
    '    public ushort B; public byte LT; public byte RT;',
    '    public short LX; public short LY; public short RX; public short RY;',
    '  }',
    '}',
    '"@',
    '$s = New-Object XI+XIS',
    'while($true) {',
    '  $r = [XI]::XInputGetState(0,[ref]$s)',
    '  if($r -eq 0) { [Console]::WriteLine("$($s.G.B),$($s.G.LT),$($s.G.RT)") }',
    '  else { [Console]::WriteLine("-1,0,0") }',
    '  Start-Sleep -Milliseconds 50',
    '}'
  ].join('\n');

  xinputProcess = spawn('powershell.exe', [
    '-NoProfile', '-Command', script
  ], { windowsHide: true });

  let lineBuffer = '';
  xinputProcess.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) processXInputLine(line.trim());
    }
  });

  xinputProcess.stderr.on('data', (d) => {
    console.log('XInput poll error:', d.toString().slice(0, 200));
  });

  xinputProcess.on('close', () => {
    xinputProcess = null;
    console.log('XInput poll process exited');
  });

  xinputProcess.on('error', (e) => {
    console.log('XInput poll spawn failed:', e.message);
    xinputProcess = null;
  });

  console.log('XInput OS-level gamepad polling started');
}

function stopXInputPoll() {
  if (xinputProcess) {
    try { xinputProcess.kill(); } catch (e) {}
    xinputProcess = null;
  }
}

function processXInputLine(line) {
  const parts = line.split(',');
  if (parts.length < 3) return;

  const buttons = parseInt(parts[0]);
  const lt = parseInt(parts[1]);
  const rt = parseInt(parts[2]);

  const connected = buttons !== -1;
  if (connected !== xinputConnected) {
    xinputConnected = connected;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('xinput-connection', connected);
    }
    console.log(`XInput controller ${connected ? 'connected' : 'disconnected'}`);
  }

  if (!connected) return;
  if (gamepadPrefs.buttonIndex === null) return;

  const btnIdx = gamepadPrefs.buttonIndex;
  if (btnIdx >= XINPUT_BUTTON_MAP.length) return;
  const mask = XINPUT_BUTTON_MAP[btnIdx];

  let pressed = false;
  if (mask === -1) pressed = lt > 200;
  else if (mask === -2) pressed = rt > 200;
  else if (mask > 0) pressed = (buttons & mask) !== 0;

  const now = Date.now();
  const st = gpState;

  if (gamepadPrefs.triggerMode === 'long') {
    if (pressed) {
      if (!st.isHeld) { st.isHeld = true; st.holdStart = now; st.fired = false; }
      else if (!st.fired && (now - st.holdStart) >= 800) {
        st.fired = true;
        console.log('Gamepad long-press save triggered');
        onHotkeyPressed();
      }
    } else {
      st.isHeld = false;
      st.fired = false;
    }
  } else {
    if (pressed) {
      if (!st.isHeld) {
        st.isHeld = true;
        if (now - st.lastPressTime < 400) {
          st.lastPressTime = 0;
          st.fired = true;
          console.log('Gamepad double-press save triggered');
          onHotkeyPressed();
        } else {
          st.lastPressTime = now;
        }
      }
    } else {
      st.isHeld = false;
    }
  }
}

// ================================
// HOTKEYS THAT DON'T STEAL THE KEY
//
// globalShortcut is Windows RegisterHotKey, which takes the key away from
// every other app while Peak-Abu runs: with Shift+R as the hotkey, no
// capital R could be typed anywhere. The key watcher reads the keyboard
// instead (GetAsyncKeyState, same PowerShell + Add-Type approach as the
// XInput poll above) and leaves every key where it was going.
// globalShortcut stays as the fallback: it covers the second the watcher
// takes to start, and takes over again if the watcher can't run.
//
// The key now also reaches whatever app has focus, so a "typing" key (a
// letter, digit, Space, Enter… alone or with Shift) is ignored while a chat
// app, browser or other known non-game program has focus: a capital R typed
// in Discord doesn't save a highlight. F-keys and Ctrl/Alt combos fire from
// anywhere, as before. In Peak-Abu's own window the renderer decides (it
// ignores the key while you type in a field or set a hotkey).
// ================================
const KEY_WATCHER_CS = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.Diagnostics;',
  'using System.Runtime.InteropServices;',
  'using System.Threading;',
  'public static class PAKeys {',
  '  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  class Bind { public int Vk; public int Mods; public bool Down; }',
  '  static readonly Dictionary<string, Bind> binds = new Dictionary<string, Bind>();',
  '  static bool IsDown(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }',
  '  public static void Run() {',
  // Commands on stdin: SET <id> <vk> <mods>, CLEAR <id>. stdin closing means
  // Peak-Abu is gone, so the watcher never outlives it.
  '    var reader = new Thread(() => {',
  '      string line;',
  '      while ((line = Console.In.ReadLine()) != null) {',
  '        var p = line.Trim().Split(\' \');',
  '        lock (binds) {',
  '          if (p.Length == 4 && p[0] == "SET") binds[p[1]] = new Bind { Vk = int.Parse(p[2]), Mods = int.Parse(p[3]), Down = true };',
  '          else if (p.Length == 2 && p[0] == "CLEAR") binds.Remove(p[1]);',
  '        }',
  '      }',
  '      Environment.Exit(0);',
  '    });',
  '    reader.IsBackground = true;',
  '    reader.Start();',
  '    Console.WriteLine("READY");',
  '    Console.Out.Flush();',
  // Fires on the key going down with exactly the bound modifiers held
  // (1 Ctrl, 2 Alt, 4 Shift), and names the app that had focus.
  '    while (true) {',
  '      lock (binds) {',
  '        foreach (var kv in binds) {',
  '          var b = kv.Value;',
  '          bool down = IsDown(b.Vk);',
  '          if (down && !b.Down) {',
  '            int mods = (IsDown(0x11) ? 1 : 0) | (IsDown(0x12) ? 2 : 0) | (IsDown(0x10) ? 4 : 0);',
  '            if (mods == b.Mods) {',
  '              uint pid = 0;',
  '              GetWindowThreadProcessId(GetForegroundWindow(), out pid);',
  '              string name = "";',
  '              try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }',
  '              Console.WriteLine("PRESS " + kv.Key + " " + pid + " " + name);',
  '              Console.Out.Flush();',
  '            }',
  '          }',
  '          b.Down = down;',
  '        }',
  '      }',
  '      Thread.Sleep(10);',
  '    }',
  '  }',
  '}'
].join('\n');

let keyWatcher = null;
let keyWatcherReady = false;
let keyWatcherStopping = false;
let keyWatcherRestarts = 0;
const KEY_WATCHER_MAX_RESTARTS = 3;

const VK_NAMED = { Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Space: 0x20, Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, Delete: 0x2E };

// 'Shift+R' -> { vk, mods (1 Ctrl, 2 Alt, 4 Shift), typing }
function parseHotkey(accel) {
  if (!isValidHotkey(accel)) return null;
  const parts = accel.split('+');
  const key = parts.pop();
  let mods = 0;
  for (const m of parts) mods |= (m === 'Alt') ? 2 : (m === 'Shift') ? 4 : 1;   // Ctrl / Control / CmdOrCtrl / Command
  let vk;
  if (/^F([1-9]|1[0-2])$/.test(key)) vk = 0x6F + parseInt(key.slice(1), 10);
  else if (/^[A-Z0-9]$/.test(key)) vk = key.charCodeAt(0);
  else vk = VK_NAMED[key];
  if (!vk) return null;
  return { vk, mods, typing: !(mods & 3) && !/^F\d/.test(key) };
}

function sendKeyWatcher(line) {
  if (!keyWatcher || !keyWatcher.stdin || keyWatcher.stdin.destroyed) return false;
  try { keyWatcher.stdin.write(line + '\n'); return true; } catch (e) { return false; }
}

function watchHotkey(id, accel) {
  const k = accel ? parseHotkey(accel) : null;
  return sendKeyWatcher(k ? `SET ${id} ${k.vk} ${k.mods}` : `CLEAR ${id}`);
}

// Binds hotkey `id` ('save' | 'star') to `accel` (null = unbind): through
// the watcher when it's running, else as a globalShortcut. False only when
// Windows refused the globalShortcut (the previous key is restored).
function bindHotkey(id, accel, previous) {
  const handler = (id === 'star') ? onStarHotkeyPressed : onHotkeyPressed;
  if (keyWatcherReady && watchHotkey(id, accel)) return true;
  if (previous && globalShortcut.isRegistered(previous)) globalShortcut.unregister(previous);
  if (!accel) return true;
  if (globalShortcut.register(accel, () => handler())) return true;
  if (previous) globalShortcut.register(previous, () => handler());
  return false;
}

function registerHotkeysFallback() {
  if (customHotkey && !globalShortcut.isRegistered(customHotkey)) {
    startupHotkeyRegistered = globalShortcut.register(customHotkey, () => onHotkeyPressed());
  }
  if (starHotkey && starHotkey !== customHotkey && !globalShortcut.isRegistered(starHotkey)) {
    starHotkeyRegistered = globalShortcut.register(starHotkey, () => onStarHotkeyPressed());
  }
}

function onKeyWatcherReady() {
  // Hand the keys back to every other app, then watch them instead.
  if (customHotkey && globalShortcut.isRegistered(customHotkey)) globalShortcut.unregister(customHotkey);
  if (starHotkey && globalShortcut.isRegistered(starHotkey)) globalShortcut.unregister(starHotkey);
  keyWatcherReady = true;
  watchHotkey('save', customHotkey);
  if (starHotkey) watchHotkey('star', starHotkey);
  startupHotkeyRegistered = true;
  starHotkeyRegistered = true;
  console.log(`Key watcher running: ${customHotkey}${starHotkey ? ' / ' + starHotkey : ''} no longer blocked in other apps`);
}

function onWatchedHotkey(id, pid, procName) {
  const accel = id === 'star' ? starHotkey : (id === 'save' ? customHotkey : null);
  const k = accel ? parseHotkey(accel) : null;
  if (!k) return;
  const inApp = pid === process.pid;
  if (inApp) {
    // Peak-Abu itself: the main window only, and not while typing in the
    // docked web player.
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isFocused()) return;
    if (playerView && playerView.webContents && !playerView.webContents.isDestroyed() &&
        playerView.webContents.isFocused()) return;
  } else if (k.typing && NON_GAME_PROCESSES.has(normalizeProcName(procName))) {
    return;   // typing in a chat app, browser… — that key press is theirs
  }
  const info = { inApp, typingKey: k.typing };
  if (id === 'star') onStarHotkeyPressed(info);
  else onHotkeyPressed(info);
}

function startKeyWatcher() {
  if (keyWatcher || process.platform !== 'win32') return;
  keyWatcherStopping = false;
  const script = ["Add-Type -TypeDefinition @'", KEY_WATCHER_CS, "'@", '[PAKeys]::Run()'].join('\n');
  let proc;
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  } catch (e) {
    console.log('Key watcher spawn failed:', e.message);
    return;
  }
  keyWatcher = proc;

  let lineBuffer = '';
  proc.stdout.on('data', (data) => {
    lineBuffer += data.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (line === 'READY') onKeyWatcherReady();
      else if (line.startsWith('PRESS ')) {
        const [, id, pid, ...name] = line.split(' ');
        onWatchedHotkey(id, Number(pid), name.join(' '));
      }
    }
  });
  proc.stderr.on('data', (d) => console.log('Key watcher error:', d.toString().slice(0, 200)));
  proc.stdin.on('error', () => {});   // it died; 'close' below handles it
  proc.on('error', (e) => console.log('Key watcher failed:', e.message));
  proc.on('close', () => {
    if (keyWatcher === proc) { keyWatcher = null; keyWatcherReady = false; }
    if (keyWatcherStopping) return;
    console.log('Key watcher exited — hotkeys back on globalShortcut');
    registerHotkeysFallback();
    if (keyWatcherRestarts++ < KEY_WATCHER_MAX_RESTARTS) setTimeout(startKeyWatcher, 5000);
  });
}

function stopKeyWatcher() {
  keyWatcherStopping = true;
  keyWatcherReady = false;
  if (keyWatcher) {
    try { keyWatcher.stdin.end(); } catch (e) {}
    try { keyWatcher.kill(); } catch (e) {}
    keyWatcher = null;
  }
}

let engineLadder = [];
let engineIndex = 0;
let stoppingIntentionally = false;
let midSessionRestarts = 0;
let midRestartTimer = null;
const MAX_MID_SESSION_RESTARTS = 3;

// A DXGI_ERROR_ACCESS_LOST (AcquireNextFrame failed: 887a0026) — and the
// "Desktop duplication access denied" / gdigrab "error 5" that follow it on
// every engine for a second or two afterward — is the OS briefly blocking
// screen capture system-wide (secure desktop, driver reset, exclusive-
// fullscreen transition). It has nothing to do with engine capability, so
// it gets its own retry budget/backoff instead of burning through
// engineLadder like a real per-engine failure does.
let transientCaptureRetries = 0;
let transientRecoveryTimer = null;
const MAX_TRANSIENT_CAPTURE_RETRIES = 8;

const ENGINE_LABELS = {
  'dda-nvenc':     'GPU capture + GPU encode (zero-copy)',
  'dda-nvenc-vf':  'GPU capture + GPU encode (scaled)',
  'dda-hdr-nvenc': 'GPU capture + HDR tonemap + GPU encode',
  'dda-hdr-x264':  'GPU capture + HDR tonemap + CPU encode',
  'dda-x264':      'GPU capture + CPU encode',
  'gdi-nvenc':     'Legacy capture + GPU encode',
  'gdi-x264':      'Legacy capture + CPU encode',
  'wgc-window':    'Window capture (Game Window Beta)',
};

function buildEngineLadder() {
  const l = [];
  if (captureHdr) {
    if (!useCpuEncoder) l.push('dda-hdr-nvenc');
    l.push('dda-hdr-x264');
    if (!useCpuEncoder) l.push('gdi-nvenc');
    l.push('gdi-x264');
  } else {
    if (!useCpuEncoder) {
      if (!recordResolution) l.push('dda-nvenc');
      l.push('dda-nvenc-vf');
      l.push('gdi-nvenc');
    }
    l.push('dda-x264');
    l.push('gdi-x264');
  }
  return l;
}

function setBelowNormalPriority(pid) {
  try {
    // os.setPriority is native and synchronous — the old PowerShell spawn
    // cost ~150ms of process creation per call, which is absurd for a
    // helper we now want to call on every extraction process.
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (e) {
    console.log('Priority adjust skipped:', e.message);
  }
}

function killFFmpegTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const pid = proc.pid;
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const forceKill = setTimeout(() => {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch (e) {
        console.log('taskkill failed:', e.message);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
      done();
    }, 1200);

    proc.once('close', () => { clearTimeout(forceKill); done(); });
    proc.once('exit',  () => { clearTimeout(forceKill); done(); });

    try {
      if (proc.stdin && proc.stdin.writable) {
        proc.stdin.write('q');
      }
    } catch (e) {
      console.log('Graceful quit write failed, will force-kill:', e.message);
    }
  });
}

function sweepOrphanedFFmpeg() {
  if (process.platform !== 'win32') return;
  try {
    const marker = 'apex-highlights-buffer';
    const ps = [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${marker}*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ];
    const sweep = spawn('powershell.exe', ps, { windowsHide: true });
    sweep.on('close', () => console.log('Orphaned FFmpeg sweep complete'));
    sweep.on('error', (e) => console.log('Orphan sweep skipped:', e.message));
  } catch (e) {
    console.log('Orphan sweep skipped:', e.message);
  }
}

let micFirstChunkTime = null;
let micVolume = 80;
let micMuted = false;

function getArchiveBaseDir() {
  const base = (fullSessionDir && fs.existsSync(fullSessionDir))
    ? fullSessionDir
    : CLIPS_DIR;
  return path.join(base, 'archives');
}

function getActiveStorageRoot() {
  if (fullSessionMode && fullSessionDir && fs.existsSync(fullSessionDir)) return fullSessionDir;
  return CLIPS_DIR;
}

function ensureFolders() {
  if (!fs.existsSync(BUFFER_DIR)) fs.mkdirSync(BUFFER_DIR, { recursive: true });
  if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// Pure read — parses the prefs file with NO side effects on in-memory
// globals. Use this (never loadUserPreferences) anywhere you're about to
// merge a new value in and save. loadUserPreferences() re-derives
// customHotkey/captureHdr/captureAdapter/wgcCaptureMode/etc. from whatever
// is still on disk every time it's called, so calling it AFTER setting a
// new value in memory silently reverts that value back to the old one
// right before it gets saved — this was the root cause of settings (and
// the hotkey) not persisting.
function readPrefsRaw() {
  try {
    if (fs.existsSync(USER_PREFS_PATH)) {
      return JSON.parse(fs.readFileSync(USER_PREFS_PATH, 'utf8'));
    }
  } catch (err) {
    console.log('Could not read user preferences:', err.message);
  }
  return {};
}

// Applies saved preferences onto in-memory globals. Only call this at
// startup — calling it mid-session after changing a setting will clobber
// the change you just made. For read-modify-write, use readPrefsRaw.
function loadUserPreferences() {
  const prefs = readPrefsRaw();
  if (Object.keys(prefs).length === 0) return prefs;

  if (prefs.storageDirectory && fs.existsSync(prefs.storageDirectory)) {
    CLIPS_DIR = path.join(prefs.storageDirectory, 'PeakAbu');
    BUFFER_DIR = path.join(prefs.storageDirectory, '.apex-highlights-buffer');
  }

  if (prefs.hotkey && isValidHotkey(prefs.hotkey)) {
    customHotkey = prefs.hotkey;
    console.log(`Loaded user hotkey preference: ${customHotkey}`);
  }

  if (prefs.starHotkey && isValidHotkey(prefs.starHotkey)) {
    starHotkey = prefs.starHotkey;
    console.log(`Loaded star key preference: ${starHotkey}`);
  }

  if (typeof prefs.captureHdr === 'boolean') {
    captureHdr = prefs.captureHdr;
    console.log(`Loaded HDR capture preference: ${captureHdr}`);
  }

  if (typeof prefs.captureAdapter === 'number' || prefs.captureAdapter === null) {
    captureAdapter = prefs.captureAdapter;
    console.log(`Loaded capture adapter preference: ${captureAdapter === null ? 'auto' : captureAdapter}`);
  }

  if (typeof prefs.fullSessionMode === 'boolean') {
    fullSessionMode = prefs.fullSessionMode;
    console.log(`Loaded full session mode preference: ${fullSessionMode}`);
  }
  if (prefs.fullSessionDir && fs.existsSync(prefs.fullSessionDir)) {
    fullSessionDir = prefs.fullSessionDir;
    console.log(`Loaded full session archive dir: ${fullSessionDir}`);
  }

  if (typeof prefs.wgcCaptureMode === 'boolean') {
    wgcCaptureMode = prefs.wgcCaptureMode;
    console.log(`Loaded capture mode preference: ${wgcCaptureMode ? 'Window' : 'Monitor'}`);
  }
  if (typeof prefs.playerWindowedMode === 'boolean') {
    playerWindowedMode = prefs.playerWindowedMode;
    console.log(`Loaded web player mode: ${playerWindowedMode ? 'separate window' : 'docked'}`);
  }
  // Apply the mode-appropriate minimum once the window exists (loadUserPreferences
  // runs before createWindow in some paths — guard for that)
  if (mainWindow && !mainWindow.isDestroyed() && playerWindowedMode) {
    mainWindow.setMinimumSize(560, 640);
  }

  if (typeof prefs.playerDockedWidth === 'number' && prefs.playerDockedWidth > 0) {
    playerDockedWidth = prefs.playerDockedWidth;
    console.log(`Loaded docked player width: ${playerDockedWidth}px`);
  }

  if (prefs.wgcLastWindowTitle) {
    wgcLastWindowTitle = prefs.wgcLastWindowTitle;
    console.log(`Loaded last window title: ${wgcLastWindowTitle}`);
  }

  if (prefs.fps && [30, 60].includes(prefs.fps)) {
    recordFps = prefs.fps;
    console.log(`Loaded fps preference: ${recordFps}`);
  }

  if (prefs.resolution && prefs.resolution in RESOLUTION_MAP) {
    recordResolutionKey = prefs.resolution;
    recordResolution = RESOLUTION_MAP[prefs.resolution];
    console.log(`Loaded resolution preference: ${recordResolutionKey}`);
  }

  if (typeof prefs.monitorIndex === 'number') {
    savedMonitorIndex = prefs.monitorIndex;
    console.log(`Loaded monitor preference: index ${savedMonitorIndex}`);
  }

  console.log(`Loaded preferences: storageDir=${CLIPS_DIR}`);
  return prefs;
}

function saveUserPreferences(prefs) {
  try {
    const tmp = USER_PREFS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
    fs.renameSync(tmp, USER_PREFS_PATH);   // rename is atomic on the same volume
    console.log('User preferences saved');
  } catch (err) {
    console.log('Could not save user preferences:', err.message);
  }
}

function isValidHotkey(hotkey) {
  if (typeof hotkey !== 'string') return false;
  const parts = hotkey.split('+');
  if (parts.length === 0 || parts.length > 4) return false;
  const modifiers = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl', 'Command', 'Control'];
  for (let i = 0; i < parts.length - 1; i++) {
    if (!modifiers.includes(parts[i])) return false;
  }
  const lastPart = parts[parts.length - 1];
  if (!(/^F([1-9]|1[0-2])$/.test(lastPart) || /^[A-Z0-9]$/.test(lastPart) ||
        ['Backspace', 'Delete', 'Enter', 'Space', 'Tab', 'Up', 'Down', 'Left', 'Right'].includes(lastPart))) {
    return false;
  }
  return true;
}

// info (from the key watcher): { inApp, typingKey } — lets the renderer
// ignore the key while you're typing in one of its fields.
function onHotkeyPressed(info) {
  console.log(`${customHotkey} pressed — routing to renderer save path`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-save-pressed', info || {});
  } else {
    saveHighlight();
  }
}

// Star key: stamp the press now (server clock) and let the renderer route it
// — to the server in a connected session, or to localStarMark otherwise.
function onStarHotkeyPressed(info) {
  const pressTs = getPreciseUTC();
  console.log(`${starHotkey} (star key) pressed`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-star-pressed', Object.assign({ pressTs }, info || {}));
  } else {
    localStarMark(pressTs, true);
  }
}

function startBufferReadyWatcher() {
  stopBufferReadyWatcher();
  bufferReadyWatcher = setInterval(() => {
    try {
      const chunks = fs.readdirSync(BUFFER_DIR)
        .filter(f => f.endsWith('.mp4') && !f.startsWith('temp_'))
        .map(f => ({ name: f, size: fs.statSync(path.join(BUFFER_DIR, f)).size }));

      const elapsedMs = recordingStartTime ? (Date.now() - recordingStartTime) : 0;
      const ready = elapsedMs >= 15000 &&
        (chunks.length >= 2 || chunks.some(c => c.size > 1000000));

      if (ready) {
        stopBufferReadyWatcher();
        console.log('Buffer ready — first complete chunk detected');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('buffer-ready');
        }
      }
    } catch (e) { /* buffer dir momentarily unreadable */ }
  }, 1000);
}

function stopBufferReadyWatcher() {
  if (bufferReadyWatcher) {
    clearInterval(bufferReadyWatcher);
    bufferReadyWatcher = null;
  }
}

ipcMain.on('server-clock-offset', (event, payload) => {
  const offset = (payload && typeof payload === 'object') ? payload.offset : payload;
  const uncertainty = (payload && typeof payload === 'object') ? payload.uncertaintyMs : null;
  if (typeof offset === 'number' && isFinite(offset) && Math.abs(offset) < 24 * 3600 * 1000) {
    clockOffset = offset;
    if (typeof uncertainty === 'number' && isFinite(uncertainty)) clockUncertaintyMs = uncertainty;
    console.log(`Server clock offset updated: ${offset.toFixed(1)}ms (±${uncertainty === null ? '?' : uncertainty.toFixed(1)}ms)`);
  } else {
    console.log('server-clock-offset: rejected invalid payload:', JSON.stringify(payload));
  }
});

// Auto-capture peak log — streamed live from the renderer's analyzer
// (client/index.html: acPollSource). Purely additive data for the saved
// clip's metadata; never touches capture-triggering logic.
ipcMain.on('auto-peak-log', (event, entry) => {
  if (!entry || typeof entry.tLocalMs !== 'number') return;
  peakLogBuffer.push({
    t: entry.tLocalMs,
    source: entry.source === 'mic' ? 'mic' : 'desktop',
    intensity: typeof entry.intensity === 'number' ? entry.intensity : null,
    event: entry.event || null
  });
  // Prune anything older than any save could plausibly still need — same
  // reasoning as pruneOldChunks, just for a much smaller array.
  const cutoff = Date.now() - PEAK_LOG_MAX_AGE_MS;
  while (peakLogBuffer.length && peakLogBuffer[0].t < cutoff) peakLogBuffer.shift();
});

function getPreciseUTC() { return Date.now() + clockOffset; }

function pruneOldChunks() {
  if (fullSessionMode) return;
  if (autoCaptureLocked) return; // an auto-capture window may be open — don't evict chunks it still needs
  if (extractionInFlight) return;    // don't stat/unlink chunks an extract is reading
  const files = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  const keep = effectiveMaxChunks();
  const neededFrom = saveNeededFromLocal();
  while (files.length > keep) {
    // A chunk that closed after the earliest footage a save still needs is
    // kept (and so is everything newer) — see saveWindowsWaiting.
    if (files[0].time >= neededFrom - 2000) break;
    const oldest = files.shift();
    try { fs.unlinkSync(path.join(BUFFER_DIR, oldest.name)); }
    catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') console.log('Skipping locked chunk:', oldest.name);
      else console.log('Prune error:', err.message);
    }
  }
}

// ================================
// LOW-PRIORITY FFMPEG SPAWN
// Every extraction/merge process gets nudged below normal so a save can
// never steal frame time from the game. Capture already did this; the
// save path did not, which is what made every clip cost a hitch.
// ================================
function spawnFFmpegLow(args) {
  const p = spawn(getFFmpegPath(), args, { windowsHide: true });
  if (p.pid) setBelowNormalPriority(p.pid);
  return p;
}

// ================================
// ASYNC BATCHED FFMPEG LOG
// appendFileSync on every stderr chunk was a blocking syscall several
// times a second for the entire recording session.
// ================================
const FFMPEG_LOG_PATH = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
let ffmpegLogBuf = '';
let ffmpegLogTimer = null;

function queueFFmpegLog(text) {
  ffmpegLogBuf += text;
  if (ffmpegLogBuf.length > 65536) ffmpegLogBuf = ffmpegLogBuf.slice(-65536);
  if (ffmpegLogTimer) return;
  ffmpegLogTimer = setTimeout(() => {
    const out = ffmpegLogBuf;
    ffmpegLogBuf = '';
    ffmpegLogTimer = null;
    if (out) fs.appendFile(FFMPEG_LOG_PATH, out, () => {});
  }, 2000);
}

// ================================
// PRUNE SCHEDULER
// Pruning used to run off the stderr firehose — a readdirSync plus one
// statSync per chunk, twice a second, up to 60 files deep at the 600s
// buffer setting. It only ever needed to run every few seconds, and it
// must never run while an extraction is reading those same chunks.
// ================================
let extractionInFlight = false;
let pruneTimer = null;

function startPruneScheduler() {
  stopPruneScheduler();
  pruneTimer = setInterval(() => {
    try { pruneOldChunks(); } catch (e) {}
  }, 5000);
}

function stopPruneScheduler() {
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
}

// ================================
// LIVE CAPTURE SETTINGS
// FPS, resolution, HDR, GPU adapter and monitor used to take effect only on
// the next Start, so squads stopped and restarted mid-session to change them.
// They now apply while recording. Monitor capture restarts FFmpeg with the
// new settings once no save still needs the current buffer; the buffer starts
// fresh, since footage in the old format can't be joined to the new one.
// Window capture switches over at a recorder handoff and keeps its buffer.
// Audio recording is never touched, and the session carries on.
// ================================
let captureEpoch = 0;          // bumped by Start/Stop; a live restart aborts if it changes
let liveRestartTimer = null;

function notifyCapture(msg) {
  console.log(msg);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('capture-engine', msg);
}

function savesHoldBuffer() {
  return pipelineBusy || pendingSaveQueue.length > 0 || saveWindowsWaiting.size > 0 || autoCaptureLocked;
}

function scheduleLiveCaptureRestart(monitor) {
  if (liveRestartTimer) clearTimeout(liveRestartTimer);
  const epoch = captureEpoch;
  let announced = false;
  const attempt = () => {
    liveRestartTimer = null;
    if (epoch !== captureEpoch || !ffmpegProcess || wgcCaptureMode || stoppingIntentionally) return;
    if (savesHoldBuffer()) {
      if (!announced) {
        announced = true;
        notifyCapture('⚙ New capture settings will apply as soon as the current save finishes');
      }
      liveRestartTimer = setTimeout(attempt, 1000);
      return;
    }
    restartCaptureLive(monitor, epoch);
  };
  // Short settle: several settings often change together.
  liveRestartTimer = setTimeout(attempt, 800);
}

async function restartCaptureLive(monitor, epoch) {
  const dying = ffmpegProcess;
  if (!dying) return;
  if (midRestartTimer) { clearTimeout(midRestartTimer); midRestartTimer = null; }
  stoppingIntentionally = true;
  ffmpegProcess = null;
  await killFFmpegTree(dying);
  // Start or Stop pressed while the old capture was closing: that wins.
  if (epoch !== captureEpoch) return;
  stoppingIntentionally = false;
  midSessionRestarts = 0;
  transientCaptureRetries = 0;
  recordingSessionTag = Date.now();
  engineLadder = buildEngineLadder();
  engineIndex = 0;
  startRecording(monitor);
  notifyCapture(`⚙ New capture settings applied (${recordFps}fps, ${recordResolutionKey || 'native'}${captureHdr ? ', HDR fix' : ''}) — buffer restarted`);
}

// Window capture: hand the new settings to the renderer, then roll over now
// so the next buffer file records with them (see wgc-rollover-request).
function applyWgcSettingsLive() {
  if (!wgcCaptureMode || Object.keys(wgcFileStreams).length === 0) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wgc-update-cfg', {
      fps: recordFps,
      resolution: recordResolution,
      bitrate: recordResolution ? (recordResolution.height <= 480 ? 3000000 : 5000000) : 8000000
    });
  }
  wgcRolloverNow();
}

// ================================
// CAPTURE CLOCK ANCHOR
// A chunk's file birthtime is when the muxer opened it, which is AFTER its
// first frame went through the encoder — so it trails the real capture time
// by the encoder's delay. Measured 9-26-26 with a clock page: 0.1-0.9 s
// depending on encoder, B-frames and fps, and it differs per PC. That is
// what put one POV ~235 ms off the rest of the squad (60 vs 30 fps).
//
// The capture filter chain now starts with a no-op setpts that logs
// "wall clock - stream time" (the wall time of stream time 0) every 5 s,
// measured BEFORE the encoder, and FFmpeg writes a segment list with each
// chunk's exact stream start. Anchor + list start = the real capture time
// of every chunk's first frame. Birthtime stays as the fallback.
// ================================
let captureAnchor = { samples: [], lineBuf: '' };

function resetCaptureAnchor() {
  captureAnchor = { samples: [], lineBuf: '' };
}

function noteCaptureAnchor(text, spawnMs) {
  const a = captureAnchor;
  const lines = (a.lineBuf + text).split(/[\r\n]/);
  a.lineBuf = lines.pop();
  if (a.lineBuf.length > 200) a.lineBuf = '';
  for (const line of lines) {
    const m = /^\s*(\d{15,17})\.\d+\s*$/.exec(line);
    if (!m) continue;
    const w0 = Number(m[1]) / 1000;                   // wall-clock ms of stream time 0
    if (!(Math.abs(w0 - spawnMs) < 20000)) continue;  // stream 0 is at capture start
    a.samples.push({ w0, at: Date.now() });
    if (a.samples.length > 400) a.samples.shift();    // ~33 min at one per 5 s
  }
}

// Wall time of stream time 0, from the samples logged near `streamSec`. The
// grabber clock drifts against the wall clock (~40 ppm measured), so nearby
// samples beat one session-wide value; the minimum drops any sample that sat
// in a queue before reaching the filter.
function captureAnchorAt(streamSec) {
  const s = captureAnchor.samples;
  if (!s.length) return null;
  const near = s.filter(x => Math.abs((x.at - x.w0) / 1000 - streamSec) <= 30);
  const pool = near.length ? near : s.slice(-6);
  return Math.min(...pool.map(x => x.w0));
}

// FFmpeg's segment list: one "file,start,end" row (stream seconds) per
// FINISHED chunk. Returns Map(fileName -> { startSec, endSec }) or null.
function readChunkTimeline(tag) {
  let txt;
  try { txt = fs.readFileSync(path.join(BUFFER_DIR, `chunklist_${tag}.csv`), 'utf8'); }
  catch (e) { return null; }
  const map = new Map();
  for (const line of txt.split(/\r?\n/)) {
    const p = line.split(',');
    if (p.length < 3) continue;
    const startSec = parseFloat(p[p.length - 2]);
    const endSec = parseFloat(p[p.length - 1]);
    if (Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec) {
      map.set(path.basename(p.slice(0, -2).join(',')), { startSec, endSec });
    }
  }
  return map;
}

// The keyframe a stream-copy trim will really start on: the last one at or
// before the wanted offset, read from the concatenated file. Flooring to a
// whole second assumed a keyframe sat there; when none did (scene-cut
// keyframes, encoder GOP drift) FFmpeg silently started at an earlier one and
// the clip's startTimeUTC was wrong by up to ~1 s. cb(null) on any failure.
function probeCutKeyframe(filePath, offsetSec, cb) {
  let out = '';
  let done = false;
  const finish = (r) => { if (!done) { done = true; cb(r); } };
  let p;
  try {
    p = spawn(getFFmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', filePath
    ], { windowsHide: true });
  } catch (e) { finish(null); return; }
  p.stdout.on('data', d => { out += d.toString(); });
  p.on('error', () => finish(null));
  p.on('close', (code) => {
    if (code !== 0) { finish(null); return; }
    let mediaStartSec = Infinity;
    const keys = [];
    for (const line of out.split(/\r?\n/)) {
      const [ts, flags] = line.split(',');
      const t = parseFloat(ts);
      if (!Number.isFinite(t)) continue;
      if (t < mediaStartSec) mediaStartSec = t;
      if (flags && flags.includes('K')) keys.push(t);
    }
    if (!keys.length || !Number.isFinite(mediaStartSec)) { finish(null); return; }
    const target = offsetSec + mediaStartSec + 0.0005;
    let keySec = null;
    for (const k of keys) if (k <= target && (keySec === null || k > keySec)) keySec = k;
    if (keySec === null) keySec = Math.min(...keys);
    finish({ keySec, mediaStartSec });
  });
}

function buildCaptureArgs(engine, monitor) {
const chunkPattern = path.join(BUFFER_DIR, `chunk_${recordingSessionTag}_%03d.mp4`);  const fpsStr = String(recordFps);

  const screen = require('electron').screen;
  const displays = screen.getAllDisplays();
  const target = monitor !== undefined && displays[monitor] ? displays[monitor] : displays[0];
  const scale = target.scaleFactor || 1;
  const gx = Math.round(target.bounds.x * scale);
  const gy = Math.round(target.bounds.y * scale);
  let gw = Math.round(target.bounds.width * scale);
  let gh = Math.round(target.bounds.height * scale);
  gw -= gw % 2; gh -= gh % 2;

  const bitrate = recordResolution
    ? (recordResolution.height <= 480 ? '3M' : '5M')
    : '8M';

  // -bf 0: B-frames shift each chunk's timestamps (measured 2-3 frames) and
  // add encoder delay. NVENC used them by default.
  const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate, '-bf', '0'];
  const x264Args  = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-bf', '0'];

  // Capture clock anchor (see CAPTURE CLOCK ANCHOR): first filter in every
  // chain, logs every 5 s, changes nothing in the picture. setpts drops the
  // stream's frame rate in FFmpeg 7, so '-r' restates it below — without it
  // the output falls back to 25 fps.
  const anchorVf = `setpts='PTS+0*if(eq(mod(N\\,${recordFps * 5})\\,0)*gt(N\\,0)\\,print(RTCTIME-T*1000000\\,32)\\,0)'`;
  const chunkListPath = path.join(BUFFER_DIR, `chunklist_${recordingSessionTag}.csv`);

  const segmentArgs = [
    '-r', fpsStr,
    '-g', fpsStr, '-keyint_min', fpsStr,
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-an',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    '-segment_list', chunkListPath, '-segment_list_type', 'csv',
    '-reset_timestamps', '1', '-y', chunkPattern
  ];

  const scaleTail = recordResolution ? `,scale=-2:${recordResolution.height}` : '';

  const adapterOpt = (captureAdapter !== null && captureAdapter !== undefined)
    ? `:adapter=${captureAdapter}` : '';
  const ddaInput = (tenBit) => [
    '-f', 'lavfi',
    '-i', `ddagrab=output_idx=${monitor || 0}${adapterOpt}:framerate=${recordFps}${tenBit ? ':output_fmt=10bit' : ''}`
  ];

  const ddaCpuVf = `hwdownload,format=bgra${scaleTail},format=yuv420p`;

  const hdrVf =
    'hwdownload,format=x2bgr10le,' +
    'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,' +
    'zscale=t=linear:npl=200,format=gbrpf32le,zscale=p=bt709,' +
    'tonemap=hable:desat=0,' +
    'zscale=t=bt709:m=bt709:r=tv' +
    scaleTail + ',format=yuv420p';

  const gdiInput = [
    '-f', 'gdigrab', '-framerate', fpsStr,
    '-offset_x', String(gx), '-offset_y', String(gy),
    '-video_size', `${gw}x${gh}`, '-i', 'desktop'
  ];
  const gdiVf = ['-vf', anchorVf + (recordResolution ? `,scale=-2:${recordResolution.height}` : '')];

  switch (engine) {
    case 'dda-nvenc':
      return [...ddaInput(false), '-vf', anchorVf, ...nvencArgs, ...segmentArgs];
    case 'dda-nvenc-vf':
      return [...ddaInput(false), '-vf', `${anchorVf},${ddaCpuVf}`, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-nvenc':
      return [...ddaInput(true), '-vf', `${anchorVf},${hdrVf}`, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-x264':
      return [...ddaInput(true), '-vf', `${anchorVf},${hdrVf}`, ...x264Args, ...segmentArgs];
    case 'dda-x264':
      return [...ddaInput(false), '-vf', `${anchorVf},${ddaCpuVf}`, ...x264Args, ...segmentArgs];
    case 'gdi-nvenc':
      return [...gdiInput, ...gdiVf, ...nvencArgs, ...segmentArgs];
    case 'gdi-x264':
    default:
      return [...gdiInput, ...gdiVf, ...x264Args, '-pix_fmt', 'yuv420p', ...segmentArgs];
  }
}

function getFreeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch (e) {
    return null;
  }
}

// ================================
// WGC BUFFER MANAGER
// ================================

function getWgcSpanSeconds() {
  const clipDurationSec = effectiveMaxChunks() * CHUNK_SECONDS;
  return Math.max(45, Math.ceil(1.5 * clipDurationSec) + 15);
}

function wgcFileTag() {
  return `wgc_${recordingSessionTag}`;
}

function wgcStartNewFile(fileId) {
  const filePath = path.join(BUFFER_DIR, `${fileId}.webm`);
  const ws = fs.createWriteStream(filePath, { flags: 'w' });
  ws.on('error', err => console.log(`WGC write stream error [${fileId}]:`, err.message));
  wgcFileStreams[fileId] = ws;
  wgcFiles.push({ fileId, path: filePath, startUTC: null, finalized: false });
  console.log(`WGC buffer file created: ${fileId}`);
  return fileId;
}

function wgcAppendChunk(fileId, buffer) {
  const ws = wgcFileStreams[fileId];
  if (!ws || ws.destroyed) {
    console.log(`WGC chunk dropped — no stream for ${fileId}`);
    return;
  }
  ws.write(Buffer.from(buffer));
  // How far this file's footage reaches (local clock) — a save waits for
  // the slice holding its window end (see POST-ROLL WAIT).
  const entry = wgcFiles.find(f => f.fileId === fileId);
  if (entry) entry.writtenUntilLocal = Date.now();
}

function wgcSetFileStartUTC(fileId, utc) {
  const entry = wgcFiles.find(f => f.fileId === fileId);
  if (entry) entry.startUTC = utc;
}

function wgcFinalizeFile(fileId) {
  const ws = wgcFileStreams[fileId];
  if (ws && !ws.destroyed) {
    ws.end();
  }
  delete wgcFileStreams[fileId];
  const entry = wgcFiles.find(f => f.fileId === fileId);
  if (entry) entry.finalized = true;
  console.log(`WGC buffer file finalized: ${fileId}`);
}

// Earliest footage (local clock) that a running or queued window-capture
// save still has to cut. Infinity when none.
function wgcNeededFromUTC() {
  let min = Infinity;
  if (wgcActiveSave) min = Math.min(min, wgcActiveSave.windowStart);
  for (const h of saveWindowsWaiting) if (h.mode === 'wgc') min = Math.min(min, h.start);
  for (const q of pendingSaveQueue) {
    if (!q.ctx || q.ctx.mode !== 'wgc') continue;
    min = Math.min(min, saveWindowLocal(q.saveTimeUTC, q.durationMs, q.triggerSource).start);
  }
  return min;
}

// Used to delete down to the 2 newest files regardless of what was queued,
// so a backlog's footage could be deleted before its saves ran. Now a file
// goes only when no running or queued save needs it (it ends before the
// earliest needed moment), and never while a save has it open.
function wgcCleanupOldFiles() {
  if (autoCaptureLocked) return; // same reasoning as pruneOldChunks
  const neededFrom = wgcNeededFromUTC();
  while (wgcFiles.length > 2) {
    const old = wgcFiles[0];
    const next = wgcFiles[1];
    if (wgcActiveSave && wgcActiveSave.fileIds.includes(old.fileId)) break;
    // `old` holds [old.startUTC, next.startUTC) — needed if anything queued starts before next.
    const needed = !next.startUTC || next.startUTC > neededFrom;
    if (needed && wgcFiles.length <= WGC_MAX_FILES) break;
    if (needed) console.log(`WGC buffer over ${WGC_MAX_FILES} files — deleting ${old.fileId} although a queued save still needs it`);
    wgcFiles.shift();
    if (wgcFileStreams[old.fileId]) {
      wgcFileStreams[old.fileId].end();
      delete wgcFileStreams[old.fileId];
    }
    try { fs.unlinkSync(old.path); } catch (e) {}
    if (next.startUTC) wgcTrimmedBeforeUTC = next.startUTC;
    console.log(`WGC buffer file deleted: ${old.fileId}`);
  }
}

function wgcStartRolloverSchedule() {
  wgcStopRolloverSchedule();
  const spanMs = getWgcSpanSeconds() * 1000;
  // This used to skip the rollover whenever a save was running. With
  // auto-capture firing every 30–60s a save almost always is, so the buffer
  // file never rolled over and grew for the whole session — and every save
  // had to decode further into it, making the next one later still (Cabbam
  // 9/22: 30 min behind; Nemean 9/25). Rolling over mid-save is safe: the
  // save reads its own file(s), and cleanup keeps any file a running or
  // queued save still needs.
  wgcRolloverTimer = setInterval(wgcRolloverNow, spanMs - 1000);
  console.log(`WGC rollover schedule started: every ${getWgcSpanSeconds()}s`);
}

// Start the next buffer file now (also used to switch capture settings live).
function wgcRolloverNow() {
  const newFileId = `${wgcFileTag()}_${Date.now() % 100000}`;
  wgcStartNewFile(newFileId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wgc-rollover-request', { newFileId });
  }
  setTimeout(() => wgcCleanupOldFiles(), 2000);
}

function wgcStopRolloverSchedule() {
  if (wgcRolloverTimer) {
    clearInterval(wgcRolloverTimer);
    wgcRolloverTimer = null;
  }
}

function wgcCleanupAll() {
  wgcStopRolloverSchedule();
  for (const fileId of Object.keys(wgcFileStreams)) {
    try { wgcFileStreams[fileId].end(); } catch (e) {}
  }
  wgcFileStreams = {};
  for (const f of wgcFiles) {
    try { fs.unlinkSync(f.path); } catch (e) {}
  }
  wgcFiles = [];
  wgcSaveInFlight = false;
  wgcActiveSave = null;
  wgcTrimmedBeforeUTC = null;
  wgcMidSessionRestarts = 0;
  console.log('WGC buffer cleaned up');
}

// Stop writing window-capture files but keep them until every save queued
// against them has run. Fallback and Stop used to clean up at once, which
// deleted the footage under ~30 queued saves on Cabbam's PC (RAE8X9, 05:37
// UTC 9/22); each then failed with "Buffer not ready" and no clip.
function wgcRetire(reason) {
  wgcStopRolloverSchedule();
  for (const fileId of Object.keys(wgcFileStreams)) {
    try { wgcFileStreams[fileId].end(); } catch (e) {}
  }
  wgcFileStreams = {};
  wgcMidSessionRestarts = 0;
  const waiting = pendingSaveQueue.length + (pipelineBusy ? 1 : 0);
  if (waiting === 0) { wgcCleanupAll(); return; }
  const gen = wgcGeneration;
  console.log(`WGC capture ended (${reason}) — keeping buffer files for ${waiting} queued save(s)`);
  onSaveQueueIdle(() => {
    if (gen === wgcGeneration) wgcCleanupAll();
  });
}

function wgcFindCoveringFiles(startUTC, endUTC) {
  const candidates = wgcFiles.filter(f => f.startUTC && fs.existsSync(f.path));
  return wgcPickCovering(candidates, startUTC, endUTC, wgcTrimmedBeforeUTC);
}

// Pure: which buffer file(s) hold [startUTC, endUTC]. Files are contiguous
// (each one ends where the next begins). Returns null when there are no
// files yet (the caller retries), or mode 'expired' when the footage was
// already deleted — previously that fell through to a "best effort" cut
// from the start of the NEWEST file: the wrong moment, uploaded as if right.
function wgcPickCovering(candidates, startUTC, endUTC, trimmedBeforeUTC) {
  if (!candidates || candidates.length === 0) return null;
  const files = candidates.slice().sort((a, b) => a.startUTC - b.startUTC);

  // Latest file that began at or before the window start.
  let i = -1;
  for (let k = 0; k < files.length; k++) {
    if (files[k].startUTC <= startUTC) i = k;
  }

  if (i === -1) {
    // Starts before the oldest buffered footage. If nothing was ever
    // deleted, that's just the start of the capture (or recorder start
    // latency): cut from the top of the first file, as before.
    if (!trimmedBeforeUTC || startUTC >= trimmedBeforeUTC - WGC_START_SLACK_MS) {
      return { mode: 'single', files: [files[0]] };
    }
    return { mode: 'expired', files: [] };
  }

  const next = files[i + 1];
  if (!next || next.startUTC >= endUTC) return { mode: 'single', files: [files[i]] };
  return { mode: 'straddle', files: [files[i], next] };
}

function startDiskWatcher() {
  stopDiskWatcher();
  let warned = false;
  diskWatchTimer = setInterval(() => {
    const root = getActiveStorageRoot();
    const free = getFreeBytes(root);
    if (free === null) return;

    if (free <= DISK_STOP_BYTES) {
      console.log(`Disk critical: ${(free / 1e9).toFixed(1)}GB free — auto-stopping recording`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('disk-critical', {
          freeGB: (free / 1e9).toFixed(1),
          path: root
        });
      }
      stopRecordingInternal();
    } else if (free <= DISK_WARN_BYTES && !warned) {
      warned = true;
      console.log(`Disk low: ${(free / 1e9).toFixed(1)}GB free — warning user`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('disk-warning', {
          freeGB: (free / 1e9).toFixed(1),
          path: root
        });
      }
    }
  }, 30000);
}

function stopDiskWatcher() {
  if (diskWatchTimer) { clearInterval(diskWatchTimer); diskWatchTimer = null; }
}

let lastDropCount = 0;
let lastDupCount = 0;
let lowSpeedStreak = 0;

function parseCaptureHealth(text, engine) {
  const speedMatch = text.match(/speed=\s*([\d.]+)x/);
  const dropMatch  = text.match(/drop=\s*(\d+)/);
  const dupMatch   = text.match(/dup=\s*(\d+)/);
  const fpsMatch   = text.match(/fps=\s*([\d.]+)/);
  if (!speedMatch && !dropMatch && !dupMatch) return;

  // ddagrab never reports drops — when it misses a frame it re-emits the
  // last one, so starvation shows up as dup= climbing, not drop=. Log it
  // the same way so a choppy clip has a matching line in peakabu-ffmpeg.log.
  if (dupMatch) {
    const dup = parseInt(dupMatch[1], 10);
    if (dup > lastDupCount) {
      console.log(`Capture duplicated ${dup - lastDupCount} frame(s) (total ${dup}) on [${engine}]`);
      lastDupCount = dup;
    }
  }

  const speed = speedMatch ? parseFloat(speedMatch[1]) : null;
  const drop  = dropMatch ? parseInt(dropMatch[1], 10) : null;
  const fps   = fpsMatch ? parseFloat(fpsMatch[1]) : null;

  if (drop !== null && drop > lastDropCount) {
    const newDrops = drop - lastDropCount;
    lastDropCount = drop;
    console.log(`Capture dropped ${newDrops} frame(s) (total ${drop}) on [${engine}]`);
  }

  if (speed !== null) {
    if (speed < 0.95) {
      lowSpeedStreak++;
      if (lowSpeedStreak === 3 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-health', {
          status: 'behind', engine, speed, drop, fps,
          message: `Capture is falling behind (${speed.toFixed(2)}x) on ${ENGINE_LABELS[engine] || engine}. ` +
                   `This can drop game FPS. Try a lighter engine, lower FPS, or check for other recorders (Shadowplay/OBS).`
        });
      }
    } else {
      if (lowSpeedStreak >= 3 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-health', { status: 'ok', engine, speed, drop, fps });
      }
      lowSpeedStreak = 0;
    }
  }
}

function startRecording(monitor) {
  ensureFolders();

  // Two ddagrab sessions on one monitor is not a supported configuration —
  // they starve each other (dup= climbs), one eventually dies, and the
  // orphan keeps writing chunks under its own session tag that the save
  // path then mixes into a concat. Kill first, spawn second, never both.
  if (ffmpegProcess && ffmpegProcess.exitCode === null) {
    console.log('startRecording called while capture is still alive — killing the old process first');
    const dying = ffmpegProcess;
    ffmpegProcess = null;
    stoppingIntentionally = true;
    killFFmpegTree(dying).then(() => {
      stoppingIntentionally = false;
      startRecording(monitor);
    });
    return;
  }

  currentMonitor = monitor;

  if (wgcCaptureMode && wgcSourceId) {
    try {
      const staleWgc = fs.readdirSync(BUFFER_DIR).filter(f => f.startsWith('wgc_'));
      for (const f of staleWgc) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      if (staleWgc.length) console.log(`Cleaned ${staleWgc.length} stale WGC files`);
    } catch (e) {}

    wgcFiles = [];
    wgcFileStreams = {};
    wgcMidSessionRestarts = 0;
    wgcSaveInFlight = false;
    wgcActiveSave = null;
    wgcTrimmedBeforeUTC = null;
    wgcGeneration++;

    console.log(`Recording window via WGC — sourceId: ${wgcSourceId}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture-engine', ENGINE_LABELS['wgc-window']);
      mainWindow.webContents.send('wgc-start-capture', {
        sourceId: wgcSourceId,
        fps: recordFps,
        resolution: recordResolution,
        bitrate: recordResolution
          ? (recordResolution.height <= 480 ? 3000000 : 5000000)
          : 8000000
      });
      mainWindow.webContents.send('buffer-ready');
    }
    recordingStartTime = Date.now();
    videoStartTime = recordingStartTime;
    lastHighlightBoundary = 0;
    if (fullSessionMode) startDiskWatcher();
    return;
  }

  while (
    engineIndex < engineLadder.length &&
    useCpuEncoder &&
    engineLadder[engineIndex].includes('nvenc')
  ) {
    engineIndex++;
  }

  if (engineIndex >= engineLadder.length) {
    console.log('All capture engines exhausted — cannot record');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-error',
        'All capture methods failed. Check GPU drivers and make sure the bundled FFmpeg is a full build (ddagrab/zscale).');
    }
    return;
  }

  const engine = engineLadder[engineIndex];
  // -stats_period cuts FFmpeg's progress output from ~2/sec to 1 every 5s.
  // parseCaptureHealth only needs a sample, not a firehose. Requires
  // FFmpeg 5.0+, which the gyan.dev full build satisfies.
  const ffmpegArgs = ['-hide_banner', '-stats_period', '5', ...buildCaptureArgs(engine, monitor)];

  console.log(`Recording monitor ${monitor} with engine [${engine}] — ${ENGINE_LABELS[engine]}`);
  console.log(`Settings: ${recordFps}fps, resolution: ${recordResolution ? recordResolution.width + 'x' + recordResolution.height : 'native'}, buffer: ${maxChunks * CHUNK_SECONDS}s, HDR fix: ${captureHdr}`);
  console.log('FFmpeg args:', ffmpegArgs.join(' '));

  ffmpegProcess = spawn(getFFmpegPath(), ffmpegArgs, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const thisCapture = ffmpegProcess;

  // Live capture must NOT run below normal — that helper is for extraction
  // work that should yield to capture. Under game load a below-normal
  // ddagrab process is the first thing Windows starves, and ddagrab covers
  // the starvation by re-emitting the last frame (dup= climbs, drop= stays
  // 0), which plays back as stutter. Capture is real-time; keep it a notch
  // above the game so it always gets its slice.
  if (ffmpegProcess.pid) {
    try { os.setPriority(ffmpegProcess.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); }
    catch (e) { console.log('Capture priority adjust skipped:', e.message); }
  }

  // Forgive the transient-loss budget once this run has proven itself
  // stable, so a DXGI hiccup an hour into a session isn't penalized by
  // retries already spent on an unrelated hiccup earlier in the same
  // multi-hour play session.
  if (transientRecoveryTimer) clearTimeout(transientRecoveryTimer);
  transientRecoveryTimer = setTimeout(() => { transientCaptureRetries = 0; }, 60000);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture-engine', ENGINE_LABELS[engine]);
    if (captureHdr && engine.startsWith('gdi')) {
      mainWindow.webContents.send('capture-engine',
        '⚠ HDR tonemap unavailable in this FFmpeg build — colors may look washed out. Bundle the gyan.dev FULL build.');
    }
  }

  const spawnStartTime = Date.now();
  videoStartTime = spawnStartTime;
  recordingStartTime = spawnStartTime;
  resetCaptureAnchor();
  lastHighlightBoundary = 0;
  lastDropCount = 0;
  lastDupCount = 0;
  lowSpeedStreak = 0;
  // NOTE: audioFirstChunkTime / micFirstChunkTime are NOT reset here.
  // startRecording also runs on mid-session crash restarts, where the
  // renderer's audio recorders keep running and never re-send their start
  // timestamps — nulling them here made every post-restart save extract
  // audio from t=0 (the repeating-audio bug, round two).
  let stderrTail = '';

  startBufferReadyWatcher();
  startPruneScheduler();      
  if (fullSessionMode) startDiskWatcher();

  ffmpegProcess.on('error', (err) => {
    const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
    fs.appendFileSync(logPath, 'SPAWN ERROR: ' + err.message + '\n');
    console.log('FFmpeg spawn error:', err.message);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const text = data.toString();
    queueFFmpegLog(text);
    stderrTail = (stderrTail + text).slice(-3000);
    parseCaptureHealth(text, engine);
    noteCaptureAnchor(text, spawnStartTime);
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`FFmpeg [${engine}] stopped with code`, code);
    if (stoppingIntentionally) return;
    // A replaced capture: killFFmpegTree resolves on 'exit', and 'close' can
    // land after the new capture has started. Treating that as a crash
    // spawned a second capture beside the new one.
    if (ffmpegProcess && ffmpegProcess !== thisCapture) return;

    const ranForMs = Date.now() - spawnStartTime;

    const isTransientCaptureLoss = /AcquireNextFrame failed|Desktop duplication access denied|Failed to capture image \(error 5\)/i.test(stderrTail);

    if (isTransientCaptureLoss && transientCaptureRetries < MAX_TRANSIENT_CAPTURE_RETRIES) {
      transientCaptureRetries++;
      const backoffMs = Math.min(1500 * transientCaptureRetries, 8000);
      const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
      fs.appendFileSync(logPath,
        `\n=== ENGINE [${engine}] transient capture loss (${transientCaptureRetries}/${MAX_TRANSIENT_CAPTURE_RETRIES}) — retrying same engine in ${backoffMs}ms ===\n${stderrTail.slice(-400)}\n`);
      console.log(`Transient capture loss on [${engine}] — retry ${transientCaptureRetries}/${MAX_TRANSIENT_CAPTURE_RETRIES} in ${backoffMs}ms`);
      ffmpegProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-engine', '⚠ Capture briefly interrupted — recovering...');
      }
      if (midRestartTimer) clearTimeout(midRestartTimer);
      midRestartTimer = setTimeout(() => {
        midRestartTimer = null;
        if (!stoppingIntentionally) {
          recordingSessionTag = Date.now();
          startRecording(currentMonitor);
        }
      }, backoffMs);
      return;
    }

    const earlyFailure = !isTransientCaptureLoss && code !== 0 && ranForMs < 6000;

    if (earlyFailure) {
      const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
      fs.appendFileSync(logPath, `\n=== ENGINE [${engine}] FAILED (code ${code}, ${ranForMs}ms) — trying next engine ===\n`);
      console.log(`Engine [${engine}] failed early — advancing ladder. Tail:`, stderrTail.slice(-400));

      if (engine.includes('nvenc') && /nvenc|nvcuda|cuda|Cannot load|does not support the required nvenc/i.test(stderrTail)) {
        useCpuEncoder = true;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('encoder-fallback', 'CPU');
        }
      }

      engineIndex++;
      startRecording(currentMonitor);
      return;
    }

    ffmpegProcess = null;
    const logPath = path.join(os.tmpdir(), 'peakabu-ffmpeg.log');
    fs.appendFileSync(logPath, `\n=== ENGINE [${engine}] DIED MID-SESSION (code ${code}, after ${(ranForMs/1000).toFixed(0)}s) ===\n${stderrTail.slice(-800)}\n`);
    console.log(`Capture died mid-session [${engine}] code ${code} after ${(ranForMs/1000).toFixed(0)}s — tail:`, stderrTail.slice(-400));

    if (midSessionRestarts < MAX_MID_SESSION_RESTARTS) {
      midSessionRestarts++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-engine',
          `⚠ Capture process died — auto-restarting (${midSessionRestarts}/${MAX_MID_SESSION_RESTARTS})`);
      }
      if (midRestartTimer) clearTimeout(midRestartTimer);
      midRestartTimer = setTimeout(() => {
        midRestartTimer = null;
        if (!stoppingIntentionally) {
          recordingSessionTag = Date.now();
          startRecording(currentMonitor);
        }
      }, 1500);
    } else {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error',
          'Recording stopped — capture crashed repeatedly. Check peakabu-ffmpeg.log in your temp folder, then press Start again.');
        mainWindow.webContents.send('recording-stopped');
      }
    }
  });
}

// ================================
// POST-ROLL WAIT
// A save can only cut footage that is already on disk: a monitor chunk must
// be CLOSED and settled (1.2 s, see doSaveHighlight), and a window-capture
// file must have received the recorder slice that holds the window end.
// Waiting too little is what cut the ends off clips. Manual saves were capped
// at CHUNK + 1.5 s, but pressing in the last seconds of a chunk needs up to
// CHUNK + 10% of the clip + 1.5 s (~30% of presses for a 30 s clip lost up to
// 3 s). Auto waited a flat CHUNK + 1.5 s that the encoder delay could overrun,
// losing the whole last chunk. Window capture waited 10% of the clip, but the
// recorder only delivers a slice every second. The wait now comes from the
// real chunk boundaries on disk, and doSaveHighlight waits again if the end
// still isn't there. (There were two identical computeManualPostDelay
// definitions; both are replaced by this.)
// ================================
const WGC_FLUSH_MS = 1500;   // recorder slice (1000 ms) + IPC and write

// ms until the monitor chunk holding local time `targetLocal` has closed and
// settled, from real chunk birth times on disk. null when there are none yet.
function msUntilChunkCovers(targetLocal) {
  let births;
  try {
    births = fs.readdirSync(BUFFER_DIR)
      .filter(f => f.startsWith('chunk_' + recordingSessionTag + '_') && f.endsWith('.mp4'))
      .map(f => fs.statSync(path.join(BUFFER_DIR, f)).birthtimeMs)
      .sort((a, b) => a - b);
  } catch (e) { return null; }
  if (!births.length) return null;
  // Birthtimes trail capture by the encoder delay (tens of ms since the
  // capture-clock fix); the margin keeps a window end just before a boundary
  // from being matched to the chunk before it.
  let closeAt = births[births.length - 1] + CHUNK_SECONDS * 1000;
  while (closeAt < targetLocal + 150) closeAt += CHUNK_SECONDS * 1000;
  return closeAt - Date.now() + 1500;   // settle rule (1.2 s) + margin
}

// How long to wait before cutting a clip whose window ends at windowEndLocal.
function computePostDelay(windowEndLocal, mode) {
  const untilEnd = Math.max(0, windowEndLocal - Date.now());
  if (mode === 'wgc') return untilEnd + WGC_FLUSH_MS;
  const ms = msUntilChunkCovers(windowEndLocal);
  if (ms === null) return untilEnd + CHUNK_SECONDS * 1000 + 1500;
  return Math.max(0, Math.min(untilEnd + CHUNK_SECONDS * 1000 + 3000, ms));
}

// ================================
// STARS (v0.1.87)
//
// Which highlight moments are starred, per session code ('' = solo), keyed
// by the clip's saveTimeUTC. For a session clip that IS the server's
// coordinated timestamp, the moment's identity. The server is the source of
// truth for session clips (server/routes/stars.js); this mirror is what lets
// a clip's sidecar carry `starred`: set when the sidecar is written, patched
// by live 'stars-changed' events for clips saved this run, and reconciled by
// Sync (reconcileSidecarStars).
//
// A star made here without the server (solo, or not connected) on a SESSION
// clip is `starPending` in the sidecar; Sync hands it to the server once the
// server has that clip.
// ================================
const starredMoments = new Map();     // code -> Map<momentTs, pending:boolean>
const clipsSavedThisRun = new Map();  // `${code}|${momentTs}` -> [sidecar paths]

function starKey(code) { return code ? String(code).toUpperCase() : ''; }

function starEntry(code, ts) {
  const m = starredMoments.get(starKey(code));
  return (m && m.has(ts)) ? { pending: m.get(ts) } : null;
}

// Rewrites only the given fields of a sidecar (undefined removes a field).
// tmp + rename like adoptOrphanClips, so a crash never leaves half a file.
function writeSidecarPatch(jsonPath, patch) {
  try {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete meta[k];
      else meta[k] = patch[k];
    }
    const tmp = jsonPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
    fs.renameSync(tmp, jsonPath);
    return true;
  } catch (e) {
    console.log(`Stars: couldn't update ${path.basename(jsonPath)}:`, e.message);
    return false;
  }
}

function setMomentStarred(code, ts, starred, pending) {
  const key = starKey(code);
  let m = starredMoments.get(key);
  if (!m) { m = new Map(); starredMoments.set(key, m); }
  if (starred) m.set(ts, !!pending);
  else m.delete(ts);
  for (const jsonPath of clipsSavedThisRun.get(key + '|' + ts) || []) {
    writeSidecarPatch(jsonPath, { starred: !!starred, starPending: (starred && pending) ? true : undefined });
  }
}

// Every clip's sidecar is written through here: the same file with the same
// fields as always, plus the star flag and the game (see CLIP FOLDERS).
function writeClipSidecar(metadataPath, metadata) {
  const star = starEntry(metadata.sessionId, metadata.saveTimeUTC);
  metadata.starred = !!star;
  if (star && star.pending) metadata.starPending = true;
  metadata.game = clipGameFor(metadata.sessionId);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  const k = starKey(metadata.sessionId) + '|' + metadata.saveTimeUTC;
  if (!clipsSavedThisRun.has(k)) clipsSavedThisRun.set(k, []);
  clipsSavedThisRun.get(k).push(metadataPath);
}

// --- Star key without the server (solo, or not connected) ----------------
// The same rules as server/sockets/stars.js, against this PC's own saves:
// star a save from the last STAR_WINDOW_MS; otherwise wait that long for
// one; otherwise save one, starred. Presses during a window join it.
const STAR_WINDOW_MS = 10000;        // matches STAR_WINDOW_MS in server/config.js
let recentSaveRequests = [];         // { ts, triggeredAt, durationMs, source, code, at }
let localStarWindow = null;          // { T, code, timer }
let localStarCapture = false;        // true only while localStarDeadline calls saveHighlight
// Set by localStarDeadline right before it calls saveHighlight for the
// star's own fill-in capture, so noteSaveRequest can record WHEN THE PRESS
// HAPPENED (not the clip's anchor, 10s later — see noteSaveRequest).
let pendingStarTriggeredAt = null;

function sendStarLocal(state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('star-local', Object.assign({ state }, extra || {}));
  }
}

// saveHighlight calls this for every save, with the moment it will carry.
// triggeredAt is when the request actually happened; for every save except
// the star key's own fill-in capture, that's saveTimeUTC itself. The star
// capture's clip anchors STAR_WINDOW_MS after the press that caused it
// (pendingStarTriggeredAt), which is what a LATER star press needs to check
// "did something just happen" against — using the clip's anchor there let a
// press up to 2×STAR_WINDOW_MS after the original one silently re-confirm
// the same clip instead of opening a fresh window.
function noteSaveRequest(ctx, saveTimeUTC, durationMs, triggerSource) {
  const code = starKey(ctx.sessionCode);
  const now = Date.now();
  const triggeredAt = (triggerSource === 'star' && pendingStarTriggeredAt !== null) ? pendingStarTriggeredAt : saveTimeUTC;
  recentSaveRequests = recentSaveRequests.filter(r => now - r.at < 60000);
  recentSaveRequests.push({ ts: saveTimeUTC, triggeredAt, durationMs, source: triggerSource || 'manual', code, at: now });

  if (triggerSource === 'star') {
    // Star captures are starred from the start. The server's own captures
    // are pre-starred there too, but its 'stars-changed' can land after the
    // sidecar is written; a local one is pending until Sync hands it up.
    setMomentStarred(code, saveTimeUTC, true, localStarCapture && code !== '');
    return;
  }
  // A NEW save resolves an open local window. A queued save carrying an
  // older moment (saveTimeUTC before the press) doesn't.
  const w = localStarWindow;
  if (w && w.code === code && saveTimeUTC >= w.T) {
    clearTimeout(w.timer);
    localStarWindow = null;
    setMomentStarred(code, saveTimeUTC, true, code !== '');
    sendStarLocal('starred', { count: 1 });
  }
}

function localStarMark(pressTs, canCapture) {
  const T = (typeof pressTs === 'number' && isFinite(pressTs)) ? pressTs : getPreciseUTC();
  const code = starKey(currentSession && currentSession.code);
  if (localStarWindow) { sendStarLocal('joined'); return; }

  const hits = new Set(recentSaveRequests
    .filter(r => r.code === code && (r.triggeredAt >= T - STAR_WINDOW_MS ||
      (r.source !== 'auto' && r.ts <= T && T <= r.ts + Math.ceil(r.durationMs * 0.1))))
    .map(r => r.ts));
  if (hits.size) {
    for (const ts of hits) setMomentStarred(code, ts, true, code !== '');
    sendStarLocal('starred', { count: hits.size });
    return;
  }
  if (!canCapture) { sendStarLocal('nothing'); return; }

  localStarWindow = {
    T, code,
    timer: setTimeout(localStarDeadline, Math.max(0, T + STAR_WINDOW_MS - getPreciseUTC()))
  };
  sendStarLocal('waiting', { deadline: T + STAR_WINDOW_MS });
}

function localStarDeadline() {
  const w = localStarWindow;
  localStarWindow = null;
  if (!w) return;
  const capturing = !!ffmpegProcess || Object.keys(wgcFileStreams).length > 0;
  if (!capturing) { sendStarLocal('not-recording'); return; }
  // Same clip length a highlight press would get right now.
  const duration = (currentSession && sessionClipDurationMs) ? sessionClipDurationMs : null;
  // Explicit anchor (not saveHighlight's default getPreciseUTC()-at-call-time)
  // so it can't drift past w.T + STAR_WINDOW_MS if the timer fires a little
  // late — matches the server's Math.min(Date.now(), w.T + STAR_WINDOW_MS).
  const anchor = Math.min(getPreciseUTC(), w.T + STAR_WINDOW_MS);
  localStarCapture = true;
  pendingStarTriggeredAt = w.T;
  try { saveHighlight(anchor, duration, 'star'); }
  finally { localStarCapture = false; pendingStarTriggeredAt = null; }
  sendStarLocal('capturing');
}

// PUT /sessions/:code/stars/:ts: hands a star made offline to the server.
// Resolves to the HTTP status (0 = unreachable).
function putStar(code, momentTs) {
  return new Promise((resolve) => {
    if (!authToken) { resolve(0); return; }
    const req = https.request({
      protocol: 'https:', host: 'peakabu.app', port: 443,
      path: `/sessions/${code}/stars/${momentTs}`, method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + authToken, 'Content-Length': 0 }
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', () => resolve(0));
    });
    req.setTimeout(15000, () => req.destroy(new Error('star push timed out')));
    req.on('error', () => resolve(0));
    req.end();
  });
}

// Sync: brings one session's local sidecars in line with the server's stars
// (remote = a fetchSessionUploads result). Only clips whose flag differs are
// rewritten. An offline star goes up once the server has that clip; a
// definitive refusal (host-only mode, not a member) drops it.
function reconcileSidecarStars(code, localClips, remote) {
  const serverStars = new Set((remote.stars || [])
    .map(s => s && s.momentTs).filter(t => typeof t === 'number'));
  const me = accountName();
  const mirror = new Map();
  for (const ts of serverStars) mirror.set(ts, false);
  let changed = 0;

  for (const clip of localClips) {
    const ts = clip.momentTs;
    if (typeof ts !== 'number') continue;
    if (clip.starPending && !serverStars.has(ts)) {
      mirror.set(ts, true);
      const onServer = findLandedRecord(remote.uploads, clip.videoPath, me) ||
        findPendingRecord(remote.uploads, clip.metadataPath, me);
      if (!onServer) continue;                     // not uploaded yet: next Sync
      putStar(code, ts).then((status) => {
        const m = starredMoments.get(starKey(code));
        if (status === 200) {
          writeSidecarPatch(clip.metadataPath, { starred: true, starPending: undefined });
          if (m) m.set(ts, false);
        } else if ([400, 403, 404].includes(status)) {
          console.log(`Stars: server refused an offline star for ${code} (${status}) — dropping it`);
          writeSidecarPatch(clip.metadataPath, { starred: false, starPending: undefined });
          if (m) m.delete(ts);
        }
      });
      continue;
    }
    const want = serverStars.has(ts);
    if ((clip.starred !== want || clip.starPending) &&
        writeSidecarPatch(clip.metadataPath, { starred: want, starPending: undefined })) changed++;
  }

  starredMoments.set(starKey(code), mirror);
  if (changed) console.log(`Stars: updated ${changed} clip sidecar(s) for ${code}`);
}

// ================================
// CLIP FOLDERS (v0.1.87)
//
// New clips land in <clips>\<Game>\<YYYY-MM-DD> · <CODE>\ for a session and
// <clips>\Solo\<YYYY-MM-DD>\ without one. File names are unchanged: Sync
// matches server records by the ISO-timestamp name prefix.
//
// A sitting's folder is decided at its FIRST save (the game is definitely
// running then) and locked, so alt-tabbing mid-session can't split it. A
// sitting ends after SITTING_GAP_MS without a save on that code, and the
// next save starts a new dated folder: a late-night session doesn't split
// at midnight, and a code reused days later gets that day's folder.
//
// Game detection is async (PowerShell). If it hasn't answered by the time a
// clip is cut, the clip is cut into the clips root and placeClip moves it
// when it's finished. Unknown games fall back to the window title; the user
// can rename from the session card, and the rename is remembered per
// detected process/title (game-names.json), so that game keeps its folder.
//
// Everything that reads clips walks these folders: listClipSidecars().
// ================================
const SESSION_FOLDERS_PATH = path.join(app.getPath('userData'), 'session-folders.json');
const GAME_NAMES_PATH = path.join(app.getPath('userData'), 'game-names.json');
const SITTING_GAP_MS = 8 * 60 * 60 * 1000;
const FOLDER_DETECT_TIMEOUT_MS = 8000;
const UNSORTED_GAME = 'Unsorted';

function readJsonFile(p, fallback) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || fallback;
  } catch (e) {
    console.log(`Could not read ${path.basename(p)}:`, e.message);
  }
  return fallback;
}

function writeJsonFile(p, data) {
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, p);   // atomic on the same volume
  } catch (e) {
    console.log(`Could not write ${path.basename(p)}:`, e.message);
  }
}

let folderLocks = readJsonFile(SESSION_FOLDERS_PATH, {});  // 'CODE' | 'SOLO' -> { game, gameKey, date, lastUsedAt, known }
const folderDetecting = new Map();                          // lock key -> detection promise
const movedClipPaths = new Map();                           // old path -> new path (see moveClipPair)
const deferredClipMoves = new Map();                        // video path -> { toDir, patch }, run when its upload finishes

// Windows-safe folder name: no reserved characters or device names, no
// leading/trailing dots or spaces, no way to climb out of the clips folder,
// bounded length. null/'' in → fallback out.
const WIN_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function sanitizeFolderName(raw, fallback) {
  let s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s || WIN_RESERVED_NAMES.test(s.split('.')[0].trim())) return fallback;
  if (/^(archives|solo)$/i.test(s)) s += ' (game)';   // our own folder names
  return s;
}

function localDateStr(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function folderLockKey(code) { return code ? String(code).toUpperCase() : 'SOLO'; }

function sittingDir(key, lock) {
  return key === 'SOLO'
    ? path.join(CLIPS_DIR, 'Solo', lock.date)
    : path.join(CLIPS_DIR, lock.game, `${lock.date} · ${key}`);
}

function liveFolderLock(key) {
  const lock = folderLocks[key];
  return (lock && Date.now() - (lock.lastUsedAt || 0) <= SITTING_GAP_MS) ? lock : null;
}

function clipFolderInfo(key, lock) {
  return { code: key, game: lock.game, folder: path.relative(CLIPS_DIR, sittingDir(key, lock)), known: !!lock.known };
}

// Best guess at the game being played (shared with the 'detect-game' IPC).
async function detectGameNow() {
  let wins = [];
  try { wins = await enumerateWindowsPS(); } catch (e) { return null; }

  // Known title wins outright
  for (const w of wins) {
    const g = lookupGame(w.processName);
    if (g) {
      return { name: g.name, genre: g.genre, process: w.processName, title: w.title, known: true };
    }
  }

  // If they picked a specific window for WGC, trust that over a guess
  if (wgcCaptureMode && wgcLastWindowTitle) {
    const match = wins.find(w => w.title === wgcLastWindowTitle);
    return {
      name: wgcLastWindowTitle,
      genre: 'shooter',
      process: match ? match.processName : '',
      title: wgcLastWindowTitle,
      known: false
    };
  }

  // Fall back to the first plausible non-shell window
  const guess = wins.find(w => isLikelyGameProcess(w.processName, w.title));
  if (guess) {
    return { name: guess.title, genre: 'shooter', process: guess.processName, title: guess.title, known: false };
  }
  return null;
}

function lockClipFolder(key, detected) {
  const names = readJsonFile(GAME_NAMES_PATH, {});
  const gameKey = detected
    ? (normalizeProcName(detected.process) || String(detected.title || '').trim().toLowerCase() || null)
    : null;
  const game = sanitizeFolderName((gameKey && names[gameKey]) || (detected && detected.name), UNSORTED_GAME);
  const lock = { game, gameKey, date: localDateStr(Date.now()), lastUsedAt: Date.now(), known: !!(detected && detected.known) };
  folderLocks[key] = lock;
  writeJsonFile(SESSION_FOLDERS_PATH, folderLocks);
  console.log(`Clip folder for ${key}: ${path.relative(CLIPS_DIR, sittingDir(key, lock))}${lock.known ? '' : ' (game guessed)'}`);
  if (key !== 'SOLO' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clip-folder', clipFolderInfo(key, lock));
  }
  return lock;
}

// saveHighlight calls this at the press, when the game is surely running.
// Starts detection for a new sitting; a no-op otherwise.
function beginClipFolder(sessionCode) {
  const key = folderLockKey(sessionCode);
  if (liveFolderLock(key) || folderDetecting.has(key)) return;
  const detection = Promise.race([
    detectGameNow(),
    new Promise(resolve => setTimeout(() => resolve(null), FOLDER_DETECT_TIMEOUT_MS))
  ]).catch(() => null).then((detected) => {
    folderDetecting.delete(key);
    if (!liveFolderLock(key)) lockClipFolder(key, detected);
  });
  folderDetecting.set(key, detection);
}

// The folder a clip goes in. While a new sitting's detection is still
// running that's the clips root (placeClip moves it later). `final` = the
// clip is finished: lock with what we have rather than wait any longer.
function clipDirFor(sessionCode, final) {
  const key = folderLockKey(sessionCode);
  let lock = liveFolderLock(key);
  if (!lock) {
    if (!final) return CLIPS_DIR;
    lock = lockClipFolder(key, null);
  }
  if (final) {
    lock.lastUsedAt = Date.now();
    writeJsonFile(SESSION_FOLDERS_PATH, folderLocks);
  }
  const dir = sittingDir(key, lock);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    console.log(`Could not create clip folder ${dir}:`, e.message);
    return CLIPS_DIR;
  }
}

// A finished clip whose folder wasn't known when it was cut moves in now.
// The sidecar isn't written yet; only the video moves.
function placeClip(videoPath, metadataPath, sessionCode) {
  const dir = clipDirFor(sessionCode, true);
  if (path.dirname(videoPath) === dir) return { videoPath, metadataPath };
  const to = path.join(dir, path.basename(videoPath));
  try {
    fs.renameSync(videoPath, to);
  } catch (e) {
    console.log(`Could not move ${path.basename(videoPath)} into its folder:`, e.message);
    return { videoPath, metadataPath };
  }
  return { videoPath: to, metadataPath: path.join(dir, path.basename(metadataPath)) };
}

// The game a clip's sidecar records: the sitting's game, unless nothing
// could be detected.
function clipGameFor(sessionCode) {
  const lock = folderLocks[folderLockKey(sessionCode)];
  return (lock && lock.game !== UNSORTED_GAME) ? lock.game : null;
}

// Every clip sidecar under the clips folder: the flat pre-0.1.87 layout and
// the <Game>\<date> · <CODE>\ folders. Skips the full-session archive tree
// and dot-folders. Clips are never more than two folders deep.
function listClipSidecars() {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 2 && !(depth === 0 && ent.name.toLowerCase() === 'archives')) walk(p, depth + 1);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
        out.push(p);
      }
    }
  };
  walk(CLIPS_DIR, 0);
  return out;
}

// Moves one clip (.mp4 + .json) into toDir, then re-points everything that
// remembers its path: the upload manifest, the live-star index, and an
// upload that's about to start (movedClipPaths). The caller makes sure it
// isn't mid-upload. Returns the new paths, or null if it couldn't move.
function moveClipPair(videoPath, toDir, patch) {
  const jsonFrom = videoPath.replace(/\.mp4$/i, '.json');
  const videoTo = path.join(toDir, path.basename(videoPath));
  const jsonTo = path.join(toDir, path.basename(jsonFrom));
  if (videoTo === videoPath) return { videoPath, metadataPath: jsonFrom };
  if (fs.existsSync(videoTo) || fs.existsSync(jsonTo)) {
    console.log(`Not moving ${path.basename(videoPath)}: ${toDir} already has a clip with that name`);
    return null;
  }
  try {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(videoPath, videoTo);
  } catch (e) {
    console.log(`Could not move ${path.basename(videoPath)}:`, e.message);
    return null;
  }
  if (fs.existsSync(jsonFrom)) {
    try { fs.renameSync(jsonFrom, jsonTo); }
    catch (e) {
      // Keep the pair together: put the video back.
      try { fs.renameSync(videoTo, videoPath); } catch (e2) {}
      console.log(`Could not move ${path.basename(jsonFrom)}:`, e.message);
      return null;
    }
    if (patch) writeSidecarPatch(jsonTo, patch);
  }

  movedClipPaths.set(videoPath, videoTo);
  movedClipPaths.set(jsonFrom, jsonTo);
  const key = path.basename(videoPath);
  const manifest = readPendingManifest();
  const entry = manifest[key];
  if (entry && entry.videoPath === videoPath) {
    entry.videoPath = videoTo;
    if (entry.metadataPath === jsonFrom) entry.metadataPath = jsonTo;
    writePendingManifest(manifest);
    if (pendingUploads.has(key)) pendingUploads.set(key, entry);
  }
  for (const list of clipsSavedThisRun.values()) {
    const i = list.indexOf(jsonFrom);
    if (i !== -1) list[i] = jsonTo;
  }
  queueSizeCache.delete(videoPath);
  return { videoPath: videoTo, metadataPath: jsonTo };
}

// A clip that was uploading when its folder was renamed moves once its
// upload is done (markUploadDone calls this).
function runDeferredClipMove(videoPath) {
  const job = deferredClipMoves.get(videoPath);
  if (!job) return;
  deferredClipMoves.delete(videoPath);
  if (!fs.existsSync(videoPath)) return;
  const fromDir = path.dirname(videoPath);
  if (moveClipPair(videoPath, job.toDir, job.patch)) removeEmptyClipDirs(fromDir);
}

// Removes a clip folder (and its game folder) once nothing is left in it.
function removeEmptyClipDirs(dir) {
  const root = path.resolve(CLIPS_DIR);
  let d = path.resolve(dir);
  for (let i = 0; i < 2 && d.startsWith(root + path.sep); i++) {
    try { fs.rmdirSync(d); } catch (e) { return; }   // not empty (or gone): stop
    d = path.dirname(d);
  }
}

// Session card ✏: rename this sitting's game folder. Future clips of that
// game use the name too (game-names.json). Clips already saved move now;
// one that's uploading right now moves when its upload finishes.
function renameClipFolder(code, rawName) {
  const key = folderLockKey(code);
  const lock = liveFolderLock(key);
  if (key === 'SOLO' || !lock) return { ok: false, error: 'No clips saved for this session yet.' };
  const game = sanitizeFolderName(rawName, null);
  if (!game) return { ok: false, error: 'That name can\'t be used as a folder name.' };
  if (game === lock.game) return Object.assign({ ok: true, moved: 0, waiting: 0 }, clipFolderInfo(key, lock));

  const fromDir = sittingDir(key, lock);
  lock.game = game;
  lock.known = true;
  writeJsonFile(SESSION_FOLDERS_PATH, folderLocks);
  if (lock.gameKey) {
    const names = readJsonFile(GAME_NAMES_PATH, {});
    names[lock.gameKey] = game;
    writeJsonFile(GAME_NAMES_PATH, names);
  }
  const toDir = sittingDir(key, lock);

  let moved = 0, waiting = 0;
  let files = [];
  try { files = fs.readdirSync(fromDir).filter(f => f.toLowerCase().endsWith('.mp4')); } catch (e) {}
  const manifest = readPendingManifest();
  for (const f of files) {
    const videoPath = path.join(fromDir, f);
    const queued = pendingUploads.has(f) || !!manifest[f];
    // Uploading now (or about to be, mid-sweep), or held open by the
    // empty-clip probe: move it once its upload is done instead.
    if (inFlightUploads.has(f) || (queued && uploadSweepRunning) || !moveClipPair(videoPath, toDir, { game })) {
      deferredClipMoves.set(videoPath, { toDir, patch: { game } });
      waiting++;
      continue;
    }
    moved++;
  }
  removeEmptyClipDirs(fromDir);
  console.log(`Clip folder for ${key} renamed to "${game}": ${moved} moved, ${waiting} waiting`);
  return Object.assign({ ok: true, moved, waiting }, clipFolderInfo(key, lock));
}

// ================================
// ORGANIZE CLIPS (v0.1.87) — sorts clips saved before 0.1.87 (flat in the
// clips folder) into the layout above: organize-plan is the dry run,
// organize-run moves with fs.rename (never copies), writes the game into
// each sidecar, and logs every move to organize-log.json for organize-undo.
//
// The game for each session comes from the renderer (local session history,
// then the server's /sessions/mine), then this PC's folder locks, else
// Unsorted. Clips waiting to upload are skipped: the retry manifest holds
// their absolute paths. It won't run while recording, saving or syncing.
// Full-session archives aren't touched.
// ================================
const ORGANIZE_LOG_NAME = 'organize-log.json';
let organizePlan = null;          // the last dry run: { id, groups }
let organizeRunning = false;
let syncUploadRunning = false;

function organizeBlocker() {
  if (ffmpegProcess || Object.keys(wgcFileStreams).length > 0) return 'Stop recording first.';
  if (pipelineBusy || pendingSaveQueue.length) return 'Wait for the highlight that\'s saving to finish.';
  if (syncCheckRunning || syncUploadRunning) return 'Wait for Sync to finish.';
  if (organizeRunning) return 'Already organizing.';
  return null;
}

// startTimeUTC, else the ISO time in the file name.
function clipTimeOf(meta, name) {
  if (typeof meta.startTimeUTC === 'number') return meta.startTimeUTC;
  if (typeof meta.saveTimeUTC === 'number') return meta.saveTimeUTC;
  const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(name);
  const t = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
  return Number.isFinite(t) ? t : null;
}

function buildOrganizePlan(sessionGames) {
  const block = organizeBlocker();
  if (block) return { ok: false, error: block };
  const manifest = readPendingManifest();
  let names = [];
  try { names = fs.readdirSync(CLIPS_DIR).filter(f => f.toLowerCase().endsWith('.json')); } catch (e) {}

  const clips = [];
  let skippedUploading = 0;
  for (const name of names) {
    const jsonPath = path.join(CLIPS_DIR, name);
    const videoPath = jsonPath.replace(/\.json$/i, '.mp4');
    if (!fs.existsSync(videoPath)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { continue; }
    if (!meta || !meta.clipId) continue;
    const key = path.basename(videoPath);
    if (pendingUploads.has(key) || manifest[key]) { skippedUploading++; continue; }
    const code = meta.sessionId ? String(meta.sessionId).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    clips.push({ videoPath, jsonPath, code, t: clipTimeOf(meta, name) || 0 });
  }

  // Sittings per session code (or solo), split on gaps over SITTING_GAP_MS
  // and dated by their first clip: the same rule new clips follow.
  clips.sort((a, b) => a.t - b.t);
  const groups = [];
  const lastByKey = new Map();
  for (const c of clips) {
    const key = c.code || 'SOLO';
    let g = lastByKey.get(key);
    if (!g || (c.t && g.lastT && c.t - g.lastT > SITTING_GAP_MS)) {
      const lock = c.code ? folderLocks[c.code] : null;
      g = {
        id: groups.length,
        code: c.code || null,
        date: c.t ? localDateStr(c.t) : 'undated',
        game: c.code
          ? (sanitizeFolderName(sessionGames && sessionGames[c.code], null) ||
             (lock && lock.game !== UNSORTED_GAME ? lock.game : null))
          : null,
        lastT: c.t,
        clips: []
      };
      groups.push(g);
      lastByKey.set(key, g);
    }
    g.clips.push(c);
    if (c.t) g.lastT = c.t;
  }

  organizePlan = { id: Date.now(), groups };
  return {
    ok: true,
    planId: organizePlan.id,
    total: clips.length,
    skippedUploading,
    groups: groups.map(g => ({ id: g.id, code: g.code, date: g.date, game: g.game, count: g.clips.length }))
  };
}

// games: { groupId: name } from the preview (blank = Unsorted).
async function runOrganize(planId, games) {
  const block = organizeBlocker();
  if (block) return { ok: false, error: block };
  if (!organizePlan || organizePlan.id !== planId) return { ok: false, error: 'The preview is out of date. Open Organize again.' };
  organizeRunning = true;

  const logPath = path.join(CLIPS_DIR, ORGANIZE_LOG_NAME);
  const log = readJsonFile(logPath, null) || { version: 1, runs: [] };
  if (!Array.isArray(log.runs)) log.runs = [];
  const run = { startedAt: Date.now(), moves: [] };
  log.runs.push(run);

  const total = organizePlan.groups.reduce((n, g) => n + g.clips.length, 0);
  let done = 0, moved = 0, skipped = 0, failed = 0;
  const progress = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('organize-progress', { done, total });
  };
  try {
    const manifest = readPendingManifest();
    for (const g of organizePlan.groups) {
      const game = g.code ? sanitizeFolderName(games && games[g.id], null) : null;
      const toDir = g.code
        ? path.join(CLIPS_DIR, game || UNSORTED_GAME, `${g.date} · ${g.code}`)
        : path.join(CLIPS_DIR, 'Solo', g.date);
      for (const c of g.clips) {
        done++;
        const key = path.basename(c.videoPath);
        if (pendingUploads.has(key) || manifest[key] || !fs.existsSync(c.videoPath)) {
          skipped++;
        } else {
          const r = moveClipPair(c.videoPath, toDir, game ? { game } : null);
          if (r) {
            moved++;
            run.moves.push({ from: [c.videoPath, c.jsonPath], to: [r.videoPath, r.metadataPath] });
          } else {
            failed++;
          }
        }
        // Log as we go, so a crash mid-run can still be undone.
        if (done % 25 === 0) {
          writeJsonFile(logPath, log);
          progress();
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
  } finally {
    run.finishedAt = Date.now();
    if (run.moves.length) writeJsonFile(logPath, log);
    organizeRunning = false;
    organizePlan = null;
    progress();
  }
  console.log(`Organize: ${moved} moved, ${skipped} skipped, ${failed} failed`);
  return { ok: true, moved, skipped, failed };
}

async function undoOrganize() {
  const block = organizeBlocker();
  if (block) return { ok: false, error: block };
  const logPath = path.join(CLIPS_DIR, ORGANIZE_LOG_NAME);
  const log = readJsonFile(logPath, null);
  if (!log || !Array.isArray(log.runs) || !log.runs.some(r => r.moves && r.moves.length)) {
    return { ok: false, error: 'Nothing to undo.' };
  }
  organizeRunning = true;
  let restored = 0, busy = 0, gone = 0, n = 0;
  const leftDirs = new Set();
  try {
    for (const run of log.runs.slice().reverse()) {
      const keep = [];
      for (const m of (run.moves || []).slice().reverse()) {
        const [videoTo] = m.to;
        const [videoFrom] = m.from;
        if (!fs.existsSync(videoTo) || fs.existsSync(videoFrom)) { gone++; continue; }
        if (inFlightUploads.has(path.basename(videoTo))) { busy++; keep.unshift(m); continue; }
        if (moveClipPair(videoTo, path.dirname(videoFrom), { game: undefined })) {
          restored++;
          leftDirs.add(path.dirname(videoTo));
        } else {
          busy++;
          keep.unshift(m);
        }
        if (++n % 25 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      run.moves = keep;
    }
    for (const d of leftDirs) removeEmptyClipDirs(d);
    log.runs = log.runs.filter(r => r.moves.length);
    if (log.runs.length) writeJsonFile(logPath, log);
    else { try { fs.unlinkSync(logPath); } catch (e) {} }
  } finally {
    organizeRunning = false;
  }
  console.log(`Undo organize: ${restored} restored, ${busy} still to do, ${gone} already moved or deleted`);
  return { ok: true, restored, busy, gone };
}

function organizeStatus() {
  const log = readJsonFile(path.join(CLIPS_DIR, ORGANIZE_LOG_NAME), null);
  return { canUndo: !!(log && Array.isArray(log.runs) && log.runs.some(r => r.moves && r.moves.length)) };
}


function saveHighlight(coordinatedTimestamp = null, clipDurationMs = null, triggerSource = null) {
  markFightSignal();   // a save means action — hold queued videos (Low Bandwidth Mode)
  // Decided NOW, at the moment of the highlight, not when the save finally
  // runs. A save that sat in the queue used to read currentSession at
  // extract time — if the host had ended the session by then the clip was
  // saved with sessionId null, never uploaded, and invisible to Sync
  // (Nemean, 9/25). Same for capture mode across a window→monitor fallback.
  const ctx = {
    sessionCode: currentSession ? currentSession.code : null,
    mode: wgcCaptureMode ? 'wgc' : 'monitor'
  };
  const duration = clipDurationMs || 30000;
  const clipChunks = Math.ceil(duration / (CHUNK_SECONDS * 1000));
  const saveTimeUTC = coordinatedTimestamp || getPreciseUTC();
  noteSaveRequest(ctx, saveTimeUTC, duration, triggerSource);   // star key (see STARS)
  beginClipFolder(ctx.sessionCode);                             // game detected at a sitting's first save (see CLIP FOLDERS)
  // Wait until the footage for the window END is on disk (see POST-ROLL
  // WAIT). doSaveHighlight checks again and waits more if it still isn't.
  const win = saveWindowLocal(saveTimeUTC, duration, triggerSource);
  const postDelay = computePostDelay(win.end, ctx.mode);

  if (postDelay > 500) {
    console.log(`Post-capture: waiting ${postDelay}ms for remaining footage (${(duration / 1000)}s clip, ${clipChunks} chunks)...`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('post-capture-started', { postDelay });
    }
    // Keep this clip's footage in the buffer while we wait (saveWindowsWaiting).
    const hold = { start: win.start, mode: ctx.mode };
    saveWindowsWaiting.add(hold);
    setTimeout(() => {
      saveWindowsWaiting.delete(hold);
      doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp, 0, triggerSource, ctx);
    }, postDelay);
  } else {
    doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp, 0, triggerSource, ctx);
  }
}

function doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs = null, retryCount = 0, triggerSource = null, ctx = null) {
  if (!ctx) ctx = { sessionCode: currentSession ? currentSession.code : null, mode: wgcCaptureMode ? 'wgc' : 'monitor' };
  if (retryCount === 0) {
    if (pipelineBusy) {
      pendingSaveQueue.push({ saveTimeUTC, clipChunks, durationMs, coordinatedTs, triggerSource, ctx });
      console.log(`Save pipeline busy — queuing ${triggerSource || 'manual'} save (${pendingSaveQueue.length} queued)`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('save-queued', { triggerSource: triggerSource || 'manual' });
      }
      broadcastQueueState();
      return;
    }
    pipelineBusy = true;
    broadcastQueueState();
  }
  activeSaveWindowStart = saveWindowLocal(saveTimeUTC, durationMs, triggerSource).start;
  if (ctx.mode === 'wgc' && wgcFiles.length > 0) {
    wgcSaveInFlight = true;

    const durationSec = durationMs / 1000;
    // Manual anchors a point-in-time button press: 90% before, 10% after.
    // Auto's "moment" is already the END of a known start-to-end window —
    // running the same split computes a start 10% INTO the real action.
    // Auto gets its own math: anchor the exact detected span, no split.
    const win = saveWindowLocal(saveTimeUTC, durationMs, triggerSource);
    const windowStartLocal = win.start;
    const windowEndLocal = win.end;

    const covering = wgcFindCoveringFiles(windowStartLocal, windowEndLocal);
    if (covering && covering.mode === 'expired') {
      const lateSec = Math.round((Date.now() - windowEndLocal) / 1000);
      console.log(`WGC save: footage for this window was already deleted (${lateSec}s after the moment) — skipping`);
      recordSaveFailure(ctx, coordinatedTs, 'footage no longer buffered');
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Highlight skipped — its footage had already left the window-capture buffer');
      }
      return;
    }
    if (!covering) {
      console.log(`WGC save: no covering buffer files, retry=${retryCount}`);
      if (retryCount < 4) {
        if (retryCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('post-capture-started', { postDelay: 3000 });
        }
        setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource, ctx), 3000);
        return;
      }
      recordSaveFailure(ctx, coordinatedTs, 'window capture buffer not ready');
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Window capture buffer not ready yet');
      }
      return;
    }
    wgcActiveSave = { windowStart: windowStartLocal, fileIds: covering.files.map(f => f.fileId) };

    // End of the clip not delivered by the recorder yet? Wait for it (while
    // that file is still being recorded) instead of cutting the clip short.
    // wgcActiveSave above keeps these files through the wait.
    const wgcLast = covering.files[covering.files.length - 1];
    if (!wgcLast.finalized && wgcFileStreams[wgcLast.fileId] && (ctx.tailWaits || 0) < 3) {
      const writtenTo = (wgcLast.writtenUntilLocal || wgcLast.startUTC || 0) - 250;
      if (writtenTo < windowEndLocal) {
        ctx.tailWaits = (ctx.tailWaits || 0) + 1;
        const waitMs = Math.max(500, Math.min(6000, windowEndLocal - writtenTo + WGC_FLUSH_MS));
        console.log(`WGC save: clip end not recorded yet (${((windowEndLocal - writtenTo) / 1000).toFixed(2)}s short) — waiting ${Math.round(waitMs)}ms (${ctx.tailWaits}/3)`);
        setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource, ctx), waitMs);
        return;
      }
    }

    const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
    const clipDir = clipDirFor(ctx.sessionCode, false);
    const outputPath = path.join(clipDir, `highlight-${timestamp}.mp4`);
    const metadataPath = path.join(clipDir, `highlight-${timestamp}.json`);

    const wgcClipPeaks = peakLogBuffer
      .filter(p => p.t >= windowStartLocal && p.t <= windowEndLocal)
      .map(p => {
        const out = { tMs: Math.max(0, Math.round(p.t - windowStartLocal)), source: p.source };
        if (p.intensity !== null) out.intensity = p.intensity;
        if (p.event) out.event = p.event;
        return out;
      });

    const metadata = {
      clipId: crypto.randomUUID(),
      version: 2,
      saveTimeUTC,
      startTimeUTC: Math.round(windowStartLocal + clockOffset),
      endTimeUTC: Math.round(windowEndLocal + clockOffset),
      durationMs: durationMs,
      clipDurationMs: durationMs,
      frameRate: recordFps,
      clockOffsetMs: clockOffset,
      syncUncertaintyMs: clockUncertaintyMs,
      captureEngine: 'wgc-window',
      userId: null,
      sessionId: ctx.sessionCode,
      coordinated_timestamp: coordinatedTs || null,
      audioPeaks: wgcClipPeaks
    };

    const encoderArgs = useCpuEncoder
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
      : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v',
         recordResolution ? (recordResolution.height <= 480 ? '3M' : '5M') : '8M'];

    function wgcExtractFail(msg) {
      recordSaveFailure(ctx, coordinatedTs, msg);
      releaseSavePipeline();
      console.log('WGC save failed:', msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', msg);
      }
    }

    if (covering.mode === 'single') {
      const file = covering.files[0];
      const ssOffset = Math.max(0, (windowStartLocal - file.startUTC) / 1000);

      console.log(`WGC save: single file extract — ss=${ssOffset.toFixed(3)}s, t=${durationSec}s from ${file.fileId}`);

      // -ss BEFORE -i (input seek). As an output option it pushed every
      // frame from the top of the buffer file through scale/pad before
      // discarding it, so each save got slower the longer the file was
      // (measured: 11.7s vs 2.8s for a clip 160s into a buffer). Output is
      // frame-identical. With the recorder's 2s keyframes (index.html) the
      // seek also skips decoding most of the file.
      const extract = spawnFFmpegLow([
        '-fflags', '+genpts+igndts',
        '-ss', ssOffset.toFixed(3),
        '-i', file.path,
        '-t', durationSec.toFixed(3),
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
        ...encoderArgs,
        '-fps_mode', 'cfr', '-r', String(recordFps),
        '-movflags', '+faststart',
        '-y', outputPath
      ]);

      extract.stderr.on('data', d => console.log('WGC extract:', d.toString()));
      extract.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          wgcFinishSave(outputPath, metadataPath, metadata, durationMs, windowStartLocal);
        } else {
          wgcExtractFail('Failed to extract window capture clip');
        }
      });
    } else {
      const older = covering.files[0];
      const newer = covering.files[1];
      const olderSs = Math.max(0, (windowStartLocal - older.startUTC) / 1000);
      const splitPoint = Math.max(0.1, (newer.startUTC - windowStartLocal) / 1000);
      const newerDur = Math.max(0.1, durationSec - splitPoint);

      const tempId = Date.now();
      const tempA = path.join(BUFFER_DIR, `wgc_temp_a_${tempId}.mp4`);
      const tempB = path.join(BUFFER_DIR, `wgc_temp_b_${tempId}.mp4`);
      const concatList = path.join(BUFFER_DIR, `wgc_concat_${tempId}.txt`);
      const cleanupParts = () => [tempA, tempB, concatList].forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

      console.log(`WGC save: straddle — older ss=${olderSs.toFixed(3)}s dur=${splitPoint.toFixed(3)}s, newer dur=${newerDur.toFixed(3)}s`);

      const extractA = spawnFFmpegLow([
        '-fflags', '+genpts+igndts',
        '-ss', olderSs.toFixed(3),   // input seek — see the single-file extract above
        '-i', older.path,
        '-t', splitPoint.toFixed(3),
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
        ...encoderArgs,
        '-fps_mode', 'cfr', '-r', String(recordFps),
        '-movflags', '+faststart',
        '-y', tempA
      ]);

      extractA.stderr.on('data', d => console.log('WGC extractA:', d.toString()));
      extractA.on('close', (codeA) => {
        if (codeA !== 0) {
          cleanupParts();
          wgcExtractFail('Failed to extract window capture clip (part A)');
          return;
        }

        const extractB = spawnFFmpegLow([
          '-fflags', '+genpts+igndts',
          '-t', newerDur.toFixed(3),
          '-i', newer.path,
          '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
          ...encoderArgs,
          '-fps_mode', 'cfr', '-r', String(recordFps),
          '-movflags', '+faststart',
          '-y', tempB
        ]);

        extractB.stderr.on('data', d => console.log('WGC extractB:', d.toString()));
        extractB.on('close', (codeB) => {
          if (codeB !== 0) {
            cleanupParts();
            wgcExtractFail('Failed to extract window capture clip (part B)');
            return;
          }

          fs.writeFileSync(concatList, `file '${tempA.replace(/\\/g, '/')}'\nfile '${tempB.replace(/\\/g, '/')}'`);
          const concat = spawn(getFFmpegPath(), [
            '-f', 'concat', '-safe', '0', '-i', concatList,
            '-c', 'copy', '-movflags', '+faststart',
            '-y', outputPath
          ], { windowsHide: true });

          concat.stderr.on('data', d => console.log('WGC concat:', d.toString()));
          concat.on('close', (codeC) => {
            cleanupParts();
            if (codeC === 0 && fs.existsSync(outputPath)) {
              wgcFinishSave(outputPath, metadataPath, metadata, durationMs, windowStartLocal);
            } else {
              wgcExtractFail('Failed to join window capture clip parts');
            }
          });
        });
      });
    }
    return;
  }

  // ================================
  // MONITOR MODE — TIME-BASED EXTRACTION
  //
  // Previously this glued together WHOLE 10s chunk files and filtered them
  // by "haven't been used by a previous save". Two failures came out of that:
  //   1. Output length could only ever be a multiple of CHUNK_SECONDS, so a
  //      17s auto-capture window became a 10s or 20s clip, never 17s.
  //   2. The dedup-by-chunk rule starved back-to-back auto saves — by the
  //      time a window closed, most chunks covering it were already "used",
  //      leaving one chunk and a 10s clip regardless of the real window.
  //
  // Now: pick every chunk that OVERLAPS the requested time window, concat
  // them, then trim precisely to the window with -ss/-t (same approach the
  // WGC path already uses). A 17.4s window yields a 17.4s clip; a 4-minute
  // fight yields a 4-minute clip. Dedup is now by time window, not by file,
  // so consecutive saves never cannibalize each other's footage.
  // ================================
  const windowStartLocal = triggerSource === 'auto'
    ? (saveTimeUTC - clockOffset) - durationMs
    : (saveTimeUTC - clockOffset) - (0.9 * durationMs);
  const windowEndLocal = triggerSource === 'auto'
    ? (saveTimeUTC - clockOffset)
    : (saveTimeUTC - clockOffset) + (0.1 * durationMs);

  // Real capture time of each chunk = segment-list start + capture anchor
  // (see CAPTURE CLOCK ANCHOR). File birthtime is only the fallback.
  const chunkTimeline = readChunkTimeline(recordingSessionTag);
  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    // Match the CURRENT session tag only. The birth-time filter below can't
    // separate two captures that started ~2s apart, which is how a chunk
    // still being written by an orphaned process ended up in a concat
    // filelist ("moov atom not found" -> Failed to save highlight).
    .filter(f => f.startsWith('chunk_' + recordingSessionTag + '_') && f.endsWith('.mp4'))
    .map(f => {
      const st = fs.statSync(path.join(BUFFER_DIR, f));
      const seg = chunkTimeline ? chunkTimeline.get(f) : null;
      const anchor = seg ? captureAnchorAt(seg.startSec) : null;
      return {
        name: f, path: path.join(BUFFER_DIR, f),
        time: st.mtimeMs,
        birth: st.birthtimeMs,
        size: st.size,
        exact: anchor !== null ? { start: anchor + seg.startSec * 1000, end: anchor + seg.endSec * 1000 } : null
      };
    })
    .filter(f => f.size > 100000)
    .sort((a, b) => a.birth - b.birth);

  // Skip the chunk FFmpeg is still writing into (mtime within the last
  // ~1.2s). Everything older is closed and safe to read.
  const settledCutoff = Date.now() - 1200;
  const settled = allVideoFiles.filter(f => f.time <= settledCutoff && f.birth >= recordingStartTime - 2000);

  // One clock per save, never mixed. Exact timing when every settled chunk
  // is in the segment list — the newest may be missing only because it is
  // unfinished (a stalled capture), and is then left out rather than used.
  const newestSettled = settled[settled.length - 1];
  const exactTiming = settled.length > 0 &&
    settled.every(f => f.exact || f === newestSettled) &&
    settled.some(f => f.exact);
  const readable = exactTiming ? settled.filter(f => f.exact) : settled;

  // A chunk covers [start, end]. Keep any that overlaps the requested
  // window at all.
  const chunkSpanMs = CHUNK_SECONDS * 1000;
  const chunkStartOf = f => exactTiming ? f.exact.start : f.birth;
  const chunkEndOf = f => exactTiming ? f.exact.end : Math.max(f.time, f.birth + chunkSpanMs);
  const videoFiles = readable.filter(f => chunkEndOf(f) >= windowStartLocal && chunkStartOf(f) <= windowEndLocal);

  if (videoFiles.length === 0) {
    const newest = allVideoFiles.length ? allVideoFiles[allVideoFiles.length - 1] : null;
    console.log('No chunks covering window: ' +
      `total=${allVideoFiles.length}, readable=${readable.length}, ` +
      `windowStart=${Math.round(windowStartLocal)}, windowEnd=${Math.round(windowEndLocal)}, ` +
      `newestBirth=${newest ? Math.round(newest.birth) : 'n/a'}, ` +
      `captureAlive=${!!(ffmpegProcess && ffmpegProcess.exitCode === null)}, retry=${retryCount}`);

    if (retryCount < 4) {
      if (retryCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('post-capture-started', { postDelay: 3000 });
      }
      setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource, ctx), 3000);
      return;
    }

    console.log('No covering chunks after retries');
    recordSaveFailure(ctx, coordinatedTs, 'no buffered footage for this moment');
    releaseSavePipeline();
    if (mainWindow && !mainWindow.isDestroyed()) {
      const dead = !(ffmpegProcess && ffmpegProcess.exitCode === null);
      mainWindow.webContents.send('highlight-error', dead
        ? 'Capture is not running — press Start to restart recording'
        : 'Buffer not ready yet, wait a few more seconds');
    }
    return;
  }

  // Trim geometry, derived from real file birth times rather than chunk
  // index arithmetic — this is what makes arbitrary window lengths work.
  const firstChunk = videoFiles[0];
  const lastChunk = videoFiles[videoFiles.length - 1];
  const availableStart = chunkStartOf(firstChunk);
  const availableEnd = chunkEndOf(lastChunk);

  // The window end isn't on disk yet: the chunk holding it is still being
  // written. Wait for it instead of cutting the clip short (what used to
  // happen), as long as capture is running. Bounded so a stalled capture
  // can't hold the save pipeline for long.
  const tailShortMs = windowEndLocal - availableEnd;
  if (tailShortMs > 1500 / recordFps && ffmpegProcess && ffmpegProcess.exitCode === null && (ctx.tailWaits || 0) < 3) {
    ctx.tailWaits = (ctx.tailWaits || 0) + 1;
    const until = msUntilChunkCovers(windowEndLocal);
    const waitMs = Math.max(500, Math.min(CHUNK_SECONDS * 1000 + 3000, until === null ? 3000 : until));
    console.log(`Clip end not on disk yet (${(tailShortMs / 1000).toFixed(2)}s short) — waiting ${Math.round(waitMs)}ms (${ctx.tailWaits}/3)`);
    setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource, ctx), waitMs);
    return;
  }

  const effStart = Math.max(windowStartLocal, availableStart);
  const effEnd = Math.min(windowEndLocal, availableEnd);

  // The buffer may not hold the whole requested window — short buffer setting,
  // or a mid-session capture restart reset recordingStartTime and orphaned the
  // older chunks. Clamping is silent by default, and produces a shorter clip
  // with a LATER startTimeUTC than the rest of the squad: exactly the shape of
  // a desynced POV. Never let this happen quietly again.
  const clampedMs = Math.max(0, (windowEndLocal - windowStartLocal) - (effEnd - effStart));
  if (clampedMs > 1500) {
    console.log(`CLIP CLAMPED: requested ${((windowEndLocal - windowStartLocal) / 1000).toFixed(1)}s, ` +
      `buffer held ${((effEnd - effStart) / 1000).toFixed(1)}s — lost ` +
      `${(Math.max(0, effStart - windowStartLocal) / 1000).toFixed(1)}s off the start, ` +
      `${(Math.max(0, windowEndLocal - effEnd) / 1000).toFixed(1)}s off the end`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('clip-clamped', {
          requestedSec: +((windowEndLocal - windowStartLocal) / 1000).toFixed(1),
          actualSec: +((effEnd - effStart) / 1000).toFixed(1),
          lostSec: +(clampedMs / 1000).toFixed(1),
          lostAtStart: +Math.max(0, (effStart - windowStartLocal) / 1000).toFixed(1),
          lostAtEnd: +Math.max(0, (windowEndLocal - effEnd) / 1000).toFixed(1)
        });
    }
  }
  const trimOffsetSec = Math.max(0, (effStart - availableStart) / 1000);
  const trimDurationSec = Math.max(0.5, (effEnd - effStart) / 1000);

  // STEP 2 is a stream copy (no second encoder session fighting live
  // capture), so the clip must start on a keyframe: up to ~1s of extra
  // footage on the head. The web player aligns POVs purely on
  // metadata.startTimeUTC, so sync stays exact as long as we report the REAL
  // first frame (realStart), not the requested one (effStart).
  //
  // Geometry starts from the whole-second assumption (keyframe every 1.000s)
  // and is refined after concat from the file's real keyframes (STEP 1b).
  // Everything that depends on realStart — metadata, audio offsets — is set
  // here so both passes stay consistent.
  const clipId = crypto.randomUUID();
  let alignedOffsetSec, headExtraSec, realStart, copyDurationSec, realDurationMs;
  let clipSpanSec, audioSkipSec, audioDelaySec, micSkipSec, micDelaySec, metadata;
  const captureLagMs = exactTiming ? Math.round(firstChunk.birth - firstChunk.exact.start) : null;
  function setTrimGeometry(cutSec, mediaStartSec) {
    alignedOffsetSec = cutSec;
    headExtraSec = (trimOffsetSec + mediaStartSec) - cutSec;
    realStart = effStart - (headExtraSec * 1000);
    copyDurationSec = trimDurationSec + headExtraSec;
    realDurationMs = Math.round(copyDurationSec * 1000);

    // Audio offsets key off the TRIMMED video start (realStart).
    clipSpanSec = copyDurationSec + 1.0;
    const audioDeltaSec = audioFirstChunkTime ? (realStart - audioFirstChunkTime) / 1000 : 0;
    audioSkipSec = Math.max(0, audioDeltaSec);
    audioDelaySec = Math.max(0, -audioDeltaSec);
    const micDeltaSec = micFirstChunkTime ? (realStart - micFirstChunkTime) / 1000 : 0;
    micSkipSec = Math.max(0, micDeltaSec);
    micDelaySec = Math.max(0, -micDeltaSec);

    // Peaks logged by the renderer's analyzer, filtered to the actual saved
    // span and re-expressed as clip-relative ms (0 = first frame of the
    // clip) — the same convention comments already use for timestampMs, so
    // the web player can treat both the same way later.
    const clipPeaks = peakLogBuffer
      .filter(p => p.t >= realStart && p.t <= effEnd)
      .map(p => {
        const out = { tMs: Math.max(0, Math.round(p.t - realStart)), source: p.source };
        if (p.intensity !== null) out.intensity = p.intensity;
        if (p.event) out.event = p.event;
        return out;
      });

    metadata = {
      clipId,
      version: 2,
      saveTimeUTC,
      startTimeUTC: Math.round(realStart + clockOffset),
      endTimeUTC: Math.round(effEnd + clockOffset),
      durationMs: realDurationMs,
      clipDurationMs: durationMs,
      frameRate: recordFps,
      clockOffsetMs: clockOffset,
      syncUncertaintyMs: clockUncertaintyMs,
      clampedMs: Math.round(clampedMs),
      timingSource: exactTiming ? 'capture-clock' : 'file-birth',
      captureLagMs,
      userId: null,
      sessionId: ctx.sessionCode,
      coordinated_timestamp: coordinatedTs || null,
      audioPeaks: clipPeaks
    };
  }
  setTrimGeometry(Math.floor(trimOffsetSec), 0);

  // Time-window dedup: remember where this clip ended so a later save can
  // tell if it's genuinely re-covering old ground. Chunks are NOT consumed.
  lastHighlightBoundary = effEnd;

  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && !micMuted && fs.existsSync(hlMicPath));
  const saveDiag = `Saving highlight: ${videoFiles.length} chunk(s) covering window, ` +
    `trim ss=${trimOffsetSec.toFixed(3)}s t=${trimDurationSec.toFixed(3)}s ` +
    `(requested ${(durationMs / 1000).toFixed(1)}s), audio=${hasAudio} (${hlAudioChunkCount}), mic=${hasMic} (${hlMicChunkCount})`;
  console.log(saveDiag);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('save-diagnostic', saveDiag);
  }

  const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
  const clipDir = clipDirFor(ctx.sessionCode, false);
  const outputPath = path.join(clipDir, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(clipDir, `highlight-${timestamp}.json`);

  const tempId = Date.now();
  const videoListPath = path.join(BUFFER_DIR, `filelist_${tempId}.txt`);
  const tempConcatPath = path.join(BUFFER_DIR, `temp_concat_${tempId}.mp4`);
  const tempVideoPath = path.join(BUFFER_DIR, `temp_video_${tempId}.mp4`);
  const tempAudioPath = path.join(BUFFER_DIR, `temp_audio_${tempId}.m4a`);
  const tempMicPath = hasMic ? path.join(BUFFER_DIR, `temp_mic_${tempId}.m4a`) : null;

  fs.writeFileSync(videoListPath, videoFiles.map(f => `file '${f.path.replace(/\\/g, '/')}'`).join('\n'));

  // p1 instead of p4/hq: this re-encodes already-encoded footage,
  // and every ms the trim holds an NVENC session is a ms the live
  // capture has to time-slice against it.
  const trimEncoderArgs = useCpuEncoder
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
    : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v',
       recordResolution ? (recordResolution.height <= 480 ? '3M' : '5M') : '8M'];

  function cleanupTemps() {
    [videoListPath, tempConcatPath, tempVideoPath, tempAudioPath, tempMicPath].forEach(p => {
      if (p) try { fs.unlinkSync(p); } catch (e) {}
    });
  }

  function finishSuccess() {
    const placed = placeClip(outputPath, metadataPath, metadata.sessionId);   // see CLIP FOLDERS
    writeClipSidecar(placed.metadataPath, metadata);
    console.log('Highlight saved to', placed.videoPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-saved', placed.videoPath);
    }
    releaseSavePipeline();
    uploadHighlight(placed.videoPath, placed.metadataPath, metadata.sessionId);
  }

  function finishVideoOnly() {
    console.log('Audio unavailable/merge failed — saving video only');
    try {
      fs.copyFileSync(tempVideoPath, outputPath);
      cleanupTemps();
      finishSuccess();
    } catch (e) {
      cleanupTemps();
      recordSaveFailure(ctx, coordinatedTs, 'failed to save highlight');
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Failed to save highlight');
      }
    }
  }

  // STEP 1: concat covering chunks (stream copy — fast, no quality loss)
  const concatVideo = spawnFFmpegLow([
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', videoListPath,
    '-c', 'copy', '-y', tempConcatPath
  ]);
  concatVideo.stderr.on('data', d => queueFFmpegLog('ConcatVideo: ' + d.toString()));

  concatVideo.on('close', (concatCode) => {
    if (concatCode !== 0 || !fs.existsSync(tempConcatPath)) {
      cleanupTemps();
      recordSaveFailure(ctx, coordinatedTs, 'failed to concat video');
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Failed to concat video');
      }
      return;
    }

    // STEP 1b: cut on the file's real keyframe (see probeCutKeyframe). If the
    // probe can't run, the whole-second geometry from above stands.
    probeCutKeyframe(tempConcatPath, trimOffsetSec, (cut) => {
      if (cut) setTrimGeometry(cut.keySec, cut.mediaStartSec);
      console.log(`Trim cut: ${cut ? `keyframe ${cut.keySec.toFixed(3)}s` : 'probe failed, whole-second'} ` +
        `for offset ${trimOffsetSec.toFixed(3)}s (head +${headExtraSec.toFixed(3)}s, timing ${metadata.timingSource}` +
        `${captureLagMs !== null ? `, file lag ${captureLagMs}ms` : ''})`);
      runTrim();
    });
  });

  function runTrim() {
    // STEP 2: trim to the exact window. This is the step that lets clip
    // length match the real ACTIVE window instead of snapping to 10s.
    // Seek rounds UP to the ms so FFmpeg lands on this keyframe, not the
    // one before it.
    const trim = spawnFFmpegLow([
      '-threads', '2',
      '-ss', (Math.ceil(alignedOffsetSec * 1000) / 1000).toFixed(3),
      '-i', tempConcatPath,
      '-t', copyDurationSec.toFixed(3),
      '-c', 'copy', '-an',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', tempVideoPath
    ]);

    trim.stderr.on('data', d => console.log('TrimVideo:', d.toString()));
    trim.on('close', (trimCode) => {
      try { fs.unlinkSync(tempConcatPath); } catch (e) {}
      try { fs.unlinkSync(videoListPath); } catch (e) {}

      if (trimCode !== 0 || !fs.existsSync(tempVideoPath)) {
        cleanupTemps();
        recordSaveFailure(ctx, coordinatedTs, 'failed to trim highlight');
        releaseSavePipeline();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('highlight-error', 'Failed to trim highlight to window');
        }
        return;
      }

      if (!hasAudio) {
        finishVideoOnly();
        return;
      }

      // STEP 3: audio repair + merge (unchanged behavior, new offsets)
      console.log(`Audio sync: skip=${audioSkipSec.toFixed(3)}s delay=${audioDelaySec.toFixed(3)}s span=${clipSpanSec.toFixed(1)}s`);
      const repairAudio = spawnFFmpegLow([
        '-hide_banner', '-nostats', '-loglevel', 'error',
        '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
        '-i', hlAudioPath,
        '-af', 'aresample=async=1000:first_pts=0',
        '-ss', audioSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
        '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioPath
      ]);
      repairAudio.stderr.on('data', d => queueFFmpegLog('RepairAudio: ' + d.toString()));

      repairAudio.on('close', (repairCode) => {
        if (repairCode !== 0 || !fs.existsSync(tempAudioPath)) {
          finishVideoOnly();
          return;
        }

        if (hasMic && tempMicPath) {
          const repairMic = spawnFFmpegLow([
            '-hide_banner', '-nostats', '-loglevel', 'error',
            '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
            '-i', hlMicPath,
            '-af', 'aresample=async=1000:first_pts=0',
            '-ss', micSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
            '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
          ]);
          repairMic.stderr.on('data', d => queueFFmpegLog('RepairMic: ' + d.toString()));
          repairMic.on('close', (micCode) => {
            runMerge(micCode === 0 && fs.existsSync(tempMicPath));
          });
        } else {
          runMerge(false);
        }
      });

      function runMerge(includeMic) {
        const mergeArgs = ['-hide_banner', '-nostats', '-loglevel', 'error', '-i', tempVideoPath];
        mergeArgs.push('-itsoffset', audioDelaySec.toFixed(3), '-i', tempAudioPath);

        if (includeMic && tempMicPath) {
          mergeArgs.push('-itsoffset', micDelaySec.toFixed(3), '-i', tempMicPath);
          const vol = (micVolume / 100).toFixed(2);
          mergeArgs.push(
            '-map', '0:v:0',
            '-filter_complex',
            `[1:a]aresample=async=1000,volume=1.0[desk];[2:a]aresample=async=1000,volume=${vol}[mic];[desk][mic]amix=inputs=2:normalize=0[aout]`,
            '-map', '[aout]'
          );
        } else {
          mergeArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000');
        }

        // -shortest let a short audio track truncate the VIDEO — the audio
        // buffer lags the flush interval, so the last seconds of every clip
        // were being cut to match. Bound the output by the video length
        // instead: audio ending early now just means a quiet tail.
        mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart', '-t', copyDurationSec.toFixed(3), '-y', outputPath);

        const merge = spawnFFmpegLow(mergeArgs);
        merge.stderr.on('data', d => queueFFmpegLog('Merge: ' + d.toString()));
        merge.on('close', (mergeCode) => {
          if (mergeCode === 0 && fs.existsSync(outputPath)) {
            cleanupTemps();
            finishSuccess();
          } else {
            finishVideoOnly();
          }
        });
      }
    });
  }
}

function wgcFinishSave(videoOnlyPath, metadataPath, metadata, durationMs, clipVideoStartMs) {
  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && !micMuted && fs.existsSync(hlMicPath));

  function finish(finalPath) {
    const placed = placeClip(finalPath, metadataPath, metadata.sessionId);   // see CLIP FOLDERS
    writeClipSidecar(placed.metadataPath, metadata);
    console.log('WGC highlight saved to', placed.videoPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-saved', placed.videoPath);
    }
    releaseSavePipeline();
    uploadHighlight(placed.videoPath, placed.metadataPath, metadata.sessionId);
  }

  if (!hasAudio) { finish(videoOnlyPath); return; }

  const durationSec = durationMs / 1000;
  const clipSpanSec = durationSec + 2;
  const audioDeltaSec = audioFirstChunkTime ? (clipVideoStartMs - audioFirstChunkTime) / 1000 : 0;
  const audioSkipSec = Math.max(0, audioDeltaSec);
  const audioDelaySec = Math.max(0, -audioDeltaSec);
  const micDeltaSec = micFirstChunkTime ? (clipVideoStartMs - micFirstChunkTime) / 1000 : 0;
  const micSkipSec = Math.max(0, micDeltaSec);
  const micDelaySec = Math.max(0, -micDeltaSec);

  const tempId = Date.now();
  const tempAudioPath = path.join(BUFFER_DIR, `wgc_temp_audio_${tempId}.m4a`);
  const tempMicPath = hasMic ? path.join(BUFFER_DIR, `wgc_temp_mic_${tempId}.m4a`) : null;
  const tempMerged = path.join(BUFFER_DIR, `wgc_temp_merged_${tempId}.mp4`);

  console.log(`WGC audio sync: skip=${audioSkipSec.toFixed(3)}s delay=${audioDelaySec.toFixed(3)}s span=${clipSpanSec.toFixed(1)}s`);

  const repairAudio = spawn(getFFmpegPath(), [
    '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
    '-i', hlAudioPath,
    '-af', 'aresample=async=1000:first_pts=0',
    '-ss', audioSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
    '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioPath
  ], { windowsHide: true });

  repairAudio.stderr.on('data', d => console.log('WGC RepairAudio:', d.toString()));
  repairAudio.on('close', (repairCode) => {
    if (repairCode !== 0 || !fs.existsSync(tempAudioPath)) {
      try { fs.unlinkSync(tempAudioPath); } catch(e) {}
      finish(videoOnlyPath);
      return;
    }

    function doMerge(includeMic) {
      const mergeArgs = ['-i', videoOnlyPath];
      mergeArgs.push('-itsoffset', audioDelaySec.toFixed(3), '-i', tempAudioPath);

      if (includeMic && tempMicPath) {
        mergeArgs.push('-itsoffset', micDelaySec.toFixed(3), '-i', tempMicPath);
        const vol = (micVolume / 100).toFixed(2);
        mergeArgs.push(
          '-map', '0:v:0',
          '-filter_complex',
          `[1:a]aresample=async=1000,volume=1.0[desk];[2:a]aresample=async=1000,volume=${vol}[mic];[desk][mic]amix=inputs=2:normalize=0[aout]`,
          '-map', '[aout]'
        );
      } else {
        mergeArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000');
      }

      mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', durationSec.toFixed(3), '-y', tempMerged);

      const merge = spawn(getFFmpegPath(), mergeArgs, { windowsHide: true });
      merge.stderr.on('data', d => console.log('WGC Merge:', d.toString()));
      merge.on('close', (mergeCode) => {
        [tempAudioPath, tempMicPath].forEach(p => { if (p) try { fs.unlinkSync(p); } catch(e) {} });
        if (mergeCode === 0 && fs.existsSync(tempMerged)) {
          try { fs.unlinkSync(videoOnlyPath); } catch(e) {}
          try { fs.renameSync(tempMerged, videoOnlyPath); } catch(e) {}
        } else {
          try { fs.unlinkSync(tempMerged); } catch(e) {}
        }
        finish(videoOnlyPath);
      });
    }

    if (hasMic && tempMicPath) {
      const repairMic = spawn(getFFmpegPath(), [
        '-fflags', '+genpts+igndts', '-err_detect', 'ignore_err',
        '-i', hlMicPath,
        '-af', 'aresample=async=1000:first_pts=0',
        '-ss', micSkipSec.toFixed(3), '-t', clipSpanSec.toFixed(3),
        '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
      ], { windowsHide: true });
      repairMic.stderr.on('data', d => console.log('WGC RepairMic:', d.toString()));
      repairMic.on('close', (micCode) => doMerge(micCode === 0 && fs.existsSync(tempMicPath)));
    } else {
      doMerge(false);
    }
  });
}

// ================================
// PENDING UPLOAD TRACKING + PERSISTENT RETRY QUEUE
// doUploadHighlight's form.submit() is a plain HTTPS POST, unrelated to the
// socket connection — leaveSession() never touches it. What COULD kill an
// upload mid-flight is the app itself quitting (before-quit had no idea an
// upload was running) or a hard crash/power loss. pendingUploads is the
// in-memory set before-quit blocks on; PENDING_UPLOADS_PATH is the on-disk
// safety net a crash can't erase — an entry is written before the HTTP call
// starts and only cleared once the server confirms 201.
// ================================
const PENDING_UPLOADS_PATH = path.join(app.getPath('userData'), 'pending-uploads.json');
const pendingUploads = new Map(); // uploadKey -> { videoPath, metadataPath, sessionCode, startedAt }
let quitRequested = false;
let quitWaitTimer = null;
let quitWaitResults = null;     // { ok, failed, messages } while waiting to quit — shown when the wait ends
let quitFinishScheduled = false;
let allowWindowClose = false; // bypass flag so we don't re-prompt on our own confirmed close
const QUIT_UPLOAD_WAIT_MS = 45000; // hard cap so a dead connection can't trap quit forever — bumped from 20s now that uploads are throttled and take longer on slow connections
let retriedPendingUploads = false;

// --- In-session self-healing retry ---------------------------------------
// A clip whose upload failed mid-session used to sit in the manifest until
// the user next LAUNCHED the app — the retry ran once per launch. In a live
// squad session that meant clips that were recorded fine never reached
// anyone. Now the manifest is swept on a timer while the app runs.
const UPLOAD_RETRY_SWEEP_MS = 60 * 1000;
// Per-clip backoff after each failed attempt; the last step repeats.
const UPLOAD_RETRY_BACKOFF_MS = [30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3];
// A throttled upload streams bytes continuously, so this only fires on a
// genuinely stalled socket — which previously left a clip "uploading"
// forever and therefore never retried.
const UPLOAD_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const inFlightUploads = new Set();   // uploadKey -> currently being sent
const uploadAttempts = new Map();    // uploadKey -> { count, nextAt }
let uploadRetryTimer = null;
let uploadSweepRunning = false;

// The account these uploads go up as, read from the token's own payload so
// it always matches what the server sees (the server verifies the token —
// this only reads the name). Needed to tell this account's upload records
// apart from squadmates' — every squadmate's clip of a highlight has the
// same file name (see isOwnRecord in upload-queue.js).
function accountName() {
  try {
    const part = String(authToken || '').split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return (payload && typeof payload.username === 'string' && payload.username) ? payload.username : null;
  } catch (e) {
    return null;
  }
}

// ================================
// LOW BANDWIDTH MODE — STATE
//
// Settings live in their own file (not user prefs) so this never touches
// the prefs read-modify-write path. mode: 'auto' | 'on' | 'off'. Auto turns
// Low Bandwidth on when the measured upload is under 10 Mbps.
//
// "Fight" = an auto-capture window is open, a save is extracting, or either
// ended less than FIGHT_QUIET_MS ago. In Low Bandwidth Mode no video starts
// during a fight, and one already sending drops to a keep-alive trickle.
// Metadata posts are never held — they're a few KB and they're what locks
// the POV into the squad's timeline.
// ================================
const UPLOAD_SETTINGS_PATH = path.join(app.getPath('userData'), 'upload-settings.json');
let uploadSettings = loadUploadSettings();
let speedTestRunning = false;
let speedTestError = null;      // plain-English reason the last test failed (shown in the 📤 tab)
let fightQuietUntil = 0;
let fightWakeTimer = null;
let queueBroadcastTimer = null;
let squadPending = { count: 0, names: [] };   // host only — reported by the renderer
const uploadProgress = new Map();             // uploadKey -> { sent, total }

function loadUploadSettings() {
  try {
    if (fs.existsSync(UPLOAD_SETTINGS_PATH)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(UPLOAD_SETTINGS_PATH, 'utf8')));
    }
  } catch (e) {
    console.log('Could not read upload settings:', e.message);
  }
  return normalizeSettings(null);
}

function saveUploadSettings() {
  try {
    const tmp = UPLOAD_SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(uploadSettings, null, 2));
    fs.renameSync(tmp, UPLOAD_SETTINGS_PATH);
  } catch (e) {
    console.log('Could not write upload settings:', e.message);
  }
}

function lowBandwidthActive() { return isLowBandwidth(uploadSettings); }
function isFightActive() { return autoCaptureLocked || pipelineBusy || Date.now() < fightQuietUntil; }
function uploadRateNow() { return currentThrottleBps(uploadSettings, isFightActive()); }

// Every fight-ish signal (auto-capture window open/close, save start/end)
// pushes the quiet deadline out and schedules one sweep for the moment
// downtime actually begins — so a queued video starts ~20s after the fight
// instead of waiting on the 60s retry timer.
function markFightSignal() {
  fightQuietUntil = Date.now() + FIGHT_QUIET_MS;
  if (fightWakeTimer) clearTimeout(fightWakeTimer);
  fightWakeTimer = setTimeout(function onQuiet() {
    fightWakeTimer = null;
    if (isFightActive()) { fightWakeTimer = setTimeout(onQuiet, 5000); return; } // window still open / save still running
    broadcastQueueState();
    sweepPendingUploads();
  }, FIGHT_QUIET_MS + 250);
  broadcastQueueState();
}

function hasDeferredQueued() {
  for (const e of pendingUploads.values()) if (e && e.deferred) return true;
  return false;
}

const queueSizeCache = new Map(); // videoPath -> bytes
function queueFileSize(p) {
  if (!p) return null;
  if (queueSizeCache.has(p)) return queueSizeCache.get(p);
  let size = null;
  try { size = fs.statSync(p).size; } catch (e) {}
  if (size !== null) queueSizeCache.set(p, size);
  return size;
}

function queueItemStatus(key, entry) {
  if (inFlightUploads.has(key)) return uploadProgress.has(key) ? 'uploading' : 'syncing';
  if (entry.deferred && !entry.uploadId) return 'syncing';
  const att = uploadAttempts.get(key);
  if (att && att.nextAt > Date.now()) return 'retrying';
  if (lowBandwidthActive() && isFightActive()) return 'paused-fight';
  return 'waiting';
}

// Snapshot for the renderer's 📤 tab.
function getQueueState() {
  const items = [];
  const savesQueued = pendingSaveQueue.length;
  const saving = pipelineBusy;
  for (const [key, e] of pendingUploads) {
    if (!e) continue;
    const p = uploadProgress.get(key);
    items.push({
      key,
      fileName: path.basename(e.videoPath || key),
      sessionCode: e.sessionCode || null,
      deferred: !!e.deferred,
      synced: !!e.uploadId,
      sizeBytes: queueFileSize(e.videoPath),
      status: queueItemStatus(key, e),
      pct: (p && p.total) ? Math.min(100, Math.round(p.sent / p.total * 100)) : null,
      startedAt: e.startedAt || 0
    });
  }
  items.sort((a, b) => a.startedAt - b.startedAt);
  return {
    mode: uploadSettings.mode,
    lowBandwidth: lowBandwidthActive(),
    measuredMbps: uploadSettings.measuredMbps,
    testedAt: uploadSettings.testedAt,
    testing: speedTestRunning,
    speedTestError: speedTestError,
    // null = unthrottled (Low Bandwidth Mode off) — the 📤 tab shows "full speed".
    throttleMbps: lowBandwidthActive() ? +(baseThrottleBps(uploadSettings) * 8 / 1e6).toFixed(1) : null,
    fightActive: lowBandwidthActive() && isFightActive(),
    // Highlight SAVES (cutting the clip) — separate from uploads. A growing
    // number here is the window-capture backlog showing itself.
    savesQueued,
    saving,
    items
  };
}

// Coalesced: progress ticks can arrive many times a second.
function broadcastQueueState() {
  if (queueBroadcastTimer) return;
  queueBroadcastTimer = setTimeout(() => {
    queueBroadcastTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-queue-state', getQueueState());
    }
  }, 250);
}

function noteUploadBytes(uploadKey, sent) {
  const p = uploadProgress.get(uploadKey);
  if (p) p.sent = sent;
  broadcastQueueState();
}

// Runs at login when the cached result is stale (>24h), or on demand from
// the 📤 tab. Skipped while a clip is sending — it would measure half a line.
// A failed or skipped test used to fail silently, so Retest looked like it
// did nothing. Every exit now leaves a reason the 📤 tab can show.
function speedTestFailureText(r) {
  if (r.status === 404) return 'Speed test isn\'t available on the server yet';
  if (r.status === 429) return 'Too many tests — try again in a minute';
  if (r.status === 401) return 'Login expired — log in again';
  if (r.status === 0) return 'Couldn\'t reach the server';
  return `Server error (${r.status})`;
}

async function runUploadSpeedTest(force) {
  if (speedTestRunning) return;
  if (!authToken) {
    if (force) { speedTestError = 'Log in to test upload speed'; broadcastQueueState(); }
    return;
  }
  if (!force && !speedTestIsStale(uploadSettings, Date.now())) return;
  if (inFlightUploads.size > 0) {
    console.log('Upload speed test skipped — an upload is in flight');
    if (force) { speedTestError = 'Wait for the current upload to finish, then retest'; broadcastQueueState(); }
    return;
  }
  speedTestRunning = true;
  broadcastQueueState();
  try {
    const r = await runSpeedTest({ token: authToken });
    if (r.ok && r.mbps > 0) {
      uploadSettings.measuredMbps = r.mbps;
      uploadSettings.testedAt = Date.now();
      saveUploadSettings();
      speedTestError = null;
      console.log(`Upload speed test: ${r.mbps} Mbps${r.timedOut ? ' (timed out — upper bound)' : ''} → ` +
        `${lowBandwidthActive() ? `throttle ${(baseThrottleBps(uploadSettings) * 8 / 1e6).toFixed(1)} Mbps` : 'unthrottled'}, Low Bandwidth ${lowBandwidthActive() ? 'ON' : 'off'} (mode ${uploadSettings.mode})`);
    } else {
      speedTestError = speedTestFailureText(r);
      console.log(`Upload speed test failed (status ${r.status}${r.error ? ', ' + r.error : ''}) — keeping previous result`);
    }
  } catch (e) {
    speedTestError = 'Speed test error — ' + e.message;
    console.log('Upload speed test error:', e.message);
  } finally {
    speedTestRunning = false;
    broadcastQueueState();
  }
}

function readPendingManifest() {
  try {
    if (fs.existsSync(PENDING_UPLOADS_PATH)) {
      return JSON.parse(fs.readFileSync(PENDING_UPLOADS_PATH, 'utf8'));
    }
  } catch (e) {
    console.log('Could not read pending-uploads manifest:', e.message);
  }
  return {};
}

function writePendingManifest(manifest) {
  try {
    const tmp = PENDING_UPLOADS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, PENDING_UPLOADS_PATH);
  } catch (e) {
    console.log('Could not write pending-uploads manifest:', e.message);
  }
}

function markUploadPending(uploadKey, entry) {
  pendingUploads.set(uploadKey, entry);
  const manifest = readPendingManifest();
  manifest[uploadKey] = entry;
  writePendingManifest(manifest);
  broadcastQueueState();
}

function markUploadDone(uploadKey) {
  const manifest = readPendingManifest();
  const done = pendingUploads.get(uploadKey) || manifest[uploadKey];
  pendingUploads.delete(uploadKey);
  delete manifest[uploadKey];
  writePendingManifest(manifest);
  uploadProgress.delete(uploadKey);
  broadcastQueueState();
  maybeFinishQuit();
  // Its folder was renamed while it uploaded (see renameClipFolder).
  if (done && done.videoPath && deferredClipMoves.has(done.videoPath)) runDeferredClipMove(done.videoPath);
}

// Shared by the window 'close' handler (X button / Alt+F4) and before-quit
// (direct app.quit() calls from the update/kick flows) so both paths ask
// the same question. Returns 'quit' | 'wait' | 'minimize'.
//
// Two shapes. Clips queued by Low Bandwidth Mode can take a long time to
// drain (they wait for downtime), so "wait" makes no sense there — offer
// minimize instead; the queue survives a quit either way. Otherwise it's
// the original short wait for an in-flight upload.
function squadUploadsText() {
  if (!squadPending.count) return '';
  const names = squadPending.names.length ? squadPending.names.join(', ') : 'Your squad';
  const verb = squadPending.names.length === 1 ? 'is' : 'are';
  return `${names} ${verb} still uploading ${squadPending.count} clip${squadPending.count === 1 ? '' : 's'} to this session.`;
}

function askQuitWithPendingUploads() {
  if (!mainWindow || mainWindow.isDestroyed()) return 'quit'; // nothing to prompt against — fail open
  const n = pendingUploads.size;
  const squad = squadUploadsText();
  const squadDetail = squad ? `\n\n${squad} Their uploads keep going after you close.` : '';

  if (hasDeferredQueued()) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Minimize & keep uploading', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Clips still queued to upload',
      message: n === 1
        ? '1 highlight clip is still queued to upload.'
        : `${n} highlight clips are still queued to upload.`,
      detail: 'Low Bandwidth Mode sends videos during downtime. Your squad already has the sync data — ' +
        'the clip shows as uploading in the web player until the video arrives.\n\n' +
        'Quitting pauses the queue; it picks back up next time you open Peak-Abu.' + squadDetail
    });
    return choice === 1 ? 'quit' : 'minimize';
  }

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: ['Wait for upload to finish', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Upload still in progress',
    message: n === 1
      ? 'A highlight clip is still uploading to your squad.'
      : `${n} highlight clips are still uploading to your squad.`,
    detail: 'Closing now pauses the upload — it resumes automatically next time you open Peak-Abu, but your squad won\'t see the clip until then.' + squadDetail
  });
  return choice === 1 ? 'quit' : 'wait';
}

// Host closing with nothing of their own pending, but squadmates still
// uploading. Informational — closing can't hurt their uploads (the attach
// route doesn't need the session open) — but the host should know the
// web player will fill in after they're gone. Returns true to close.
function askCloseWithSquadUploads() {
  if (!mainWindow || mainWindow.isDestroyed() || !squadPending.count) return true;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    buttons: ['Close', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Squad still uploading',
    message: squadUploadsText(),
    detail: 'Their uploads keep going after you close. Some POVs will show as uploading in the web player until they land.'
  });
  return choice === 0;
}

// ================================
// WAITING TO QUIT
// The user chose "Wait for upload to finish". This used to close the app
// the instant the queue emptied (or silently after 45s), with no word on
// whether the clip made it. Now:
//   • the renderer shows a "closing after upload" bar with Cancel
//   • when the queue empties, a dialog says how it went, then closes
//     (or stays open, if they'd rather)
//   • if it's still going at 45s, they choose: keep waiting / minimize /
//     quit — never a silent close
// ================================
function startQuitWait() {
  quitRequested = true;
  quitWaitResults = { ok: 0, failed: 0, messages: [] };
  if (quitWaitTimer) clearTimeout(quitWaitTimer);
  quitWaitTimer = setTimeout(onQuitWaitTimeout, QUIT_UPLOAD_WAIT_MS);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('quit-waiting-on-uploads', { count: pendingUploads.size });
  }
}

function cancelQuitWait(reason) {
  if (!quitRequested) return;
  quitRequested = false;
  quitWaitResults = null;
  if (quitWaitTimer) { clearTimeout(quitWaitTimer); quitWaitTimer = null; }
  console.log(`Quit wait cancelled (${reason || 'user'}) — staying open`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('quit-wait-ended');
}

function closeNowAfterWait() {
  quitRequested = false;
  allowWindowClose = true;   // before-quit won't ask again
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else app.quit();
}

function maybeFinishQuit() {
  if (!quitRequested || pendingUploads.size > 0 || quitFinishScheduled) return;
  // markUploadDone runs just BEFORE the upload's onDone records its outcome
  // — give that a moment so the dialog reports the clip that just landed.
  quitFinishScheduled = true;
  setTimeout(() => { quitFinishScheduled = false; finishQuitWait(); }, 50);
}

function finishQuitWait() {
  if (!quitRequested || pendingUploads.size > 0) return;
  if (quitWaitTimer) { clearTimeout(quitWaitTimer); quitWaitTimer = null; }
  const r = quitWaitResults || { ok: 0, failed: 0, messages: [] };
  quitWaitResults = null;
  console.log(`Pending uploads cleared (${r.ok} ok, ${r.failed} failed) — confirming close`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('quit-wait-ended');
  if (!mainWindow || mainWindow.isDestroyed()) { closeNowAfterWait(); return; }

  let opts;
  if (r.failed > 0) {
    opts = {
      type: 'warning',
      title: 'Upload didn\'t finish',
      message: r.failed === 1 ? '1 clip couldn\'t be uploaded.' : `${r.failed} clips couldn't be uploaded.`,
      detail: (r.messages[0] ? 'Server said: ' + r.messages[0] + '\n\n' : '') +
        (r.ok > 0 ? `${r.ok} other clip${r.ok === 1 ? '' : 's'} uploaded fine.\n\n` : '') +
        'The clip is still saved on your PC — open the session in the web player and use Sync to try again.'
    };
  } else {
    opts = {
      type: 'info',
      title: 'Upload finished',
      message: r.ok === 1 ? '✓ Your clip finished uploading.'
        : r.ok > 1 ? `✓ All ${r.ok} clips finished uploading.`
        : '✓ Nothing left to upload.',
      detail: 'Your squad can see it in the web player now.'
    };
  }
  const choice = dialog.showMessageBoxSync(mainWindow, Object.assign(opts, {
    buttons: ['Close Peak-Abu', 'Stay open'], defaultId: 0, cancelId: 1
  }));
  if (choice === 1) { quitRequested = false; console.log('User stayed open after upload wait'); return; }
  closeNowAfterWait();
}

function onQuitWaitTimeout() {
  quitWaitTimer = null;
  if (!quitRequested) return;
  if (!mainWindow || mainWindow.isDestroyed()) { closeNowAfterWait(); return; }
  let pctText = '';
  for (const [key] of pendingUploads) {
    const p = uploadProgress.get(key);
    if (p && p.total) { pctText = ` (${Math.min(100, Math.round(p.sent / p.total * 100))}%)`; break; }
  }
  const n = pendingUploads.size;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    title: 'Upload still running',
    message: `Still uploading${pctText}${n > 1 ? ` — ${n} clips left` : ''}.`,
    detail: 'Your connection is slow right now. Keep waiting, let it finish in the background, or quit — anything left picks back up next time you open Peak-Abu.',
    buttons: ['Keep waiting', 'Minimize & keep uploading', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0
  });
  if (choice === 0) { quitWaitTimer = setTimeout(onQuitWaitTimeout, QUIT_UPLOAD_WAIT_MS); return; }
  if (choice === 1) { cancelQuitWait('minimized'); mainWindow.minimize(); return; }
  console.log('Quit wait: user chose to quit — remaining uploads stay in the retry manifest');
  closeNowAfterWait();
}

// Picks back up any upload still in the manifest from a previous run
// (crash, force-kill, power loss — a clean quit already drains
// pendingUploads before exiting). Runs once per launch, gated on the auth
// token being available since performUpload needs it.
function retryPendingUploadsFromDisk() {
  // Kept for its name; the launch-time retry is now simply the first sweep,
  // so it gets the same duplicate check and one-at-a-time pacing.
  startUploadRetryLoop();
}

// Record how an attempt ended, for backoff. Success and definitive
// rejections clear the history; anything transient schedules the next try.
function noteUploadAttempt(uploadKey, result) {
  // While the user waits to quit, tally how each clip ended so the closing
  // dialog can say whether it actually made it. A clip still in the queue
  // (e.g. a deferred one falling back to a normal upload) isn't an outcome.
  if (quitWaitResults && result && !pendingUploads.has(uploadKey) && (result.ok || result.permanent)) {
    if (result.ok) quitWaitResults.ok++;
    else {
      quitWaitResults.failed++;
      if (result.message) quitWaitResults.messages.push(result.message);
    }
  }
  if (!result || result.ok || result.permanent) { uploadAttempts.delete(uploadKey); return; }
  const prev = uploadAttempts.get(uploadKey) || { count: 0, nextAt: 0 };
  const count = prev.count + 1;
  const wait = UPLOAD_RETRY_BACKOFF_MS[Math.min(count - 1, UPLOAD_RETRY_BACKOFF_MS.length - 1)];
  uploadAttempts.set(uploadKey, { count, nextAt: Date.now() + wait });
}

function startUploadRetryLoop() {
  if (!uploadRetryTimer) {
    uploadRetryTimer = setInterval(() => { sweepPendingUploads(); }, UPLOAD_RETRY_SWEEP_MS);
  }
  sweepPendingUploads();
}

// One pass over the manifest. Clips are retried ONE AT A TIME — uploads are
// throttled to protect the user's connection while they play, and a burst of
// parallel retries would undo that.
//
// Before sending anything, ask the server what it already has. The dangerous
// case with frequent retries is an upload that SUCCEEDED but whose response
// was lost: without this check it would be sent twice and show up as a
// duplicate. decideSweepAction (upload-queue.js) makes the call per clip —
// including the deferred cases: post metadata, attach video, adopt a
// pending record whose response was lost, or hold for a fight.
//
// Fight state is read per clip, not once per sweep, so a fight that starts
// mid-sweep stops the next video from starting.
async function sweepPendingUploads() {
  if (!authToken || uploadSweepRunning || speedTestRunning) return;
  uploadSweepRunning = true;
  try {
    const manifest = readPendingManifest();
    const now = Date.now();
    const bySession = new Map();

    for (const [uploadKey, entry] of Object.entries(manifest)) {
      if (!entry || !entry.videoPath || !fs.existsSync(entry.videoPath)) {
        console.log(`Pending upload ${uploadKey} — local file missing, dropping from retry queue`);
        markUploadDone(uploadKey);
        continue;
      }
      // Keep the in-memory map in step with disk, so the quit prompt and
      // Sync both know about clips left over from a previous run.
      if (!pendingUploads.has(uploadKey)) pendingUploads.set(uploadKey, entry);
      if (inFlightUploads.has(uploadKey)) continue;
      const att = uploadAttempts.get(uploadKey);
      if (att && att.nextAt > now) continue;
      const code = entry.sessionCode;
      if (!bySession.has(code)) bySession.set(code, []);
      bySession.get(code).push([uploadKey, entry]);
    }

    for (const [code, items] of bySession) {
      const remote = await fetchSessionUploads(code);
      if (remote.status !== 200 && remote.status !== 404) continue; // server unreachable — next sweep

      for (const [uploadKey, entryIn] of items) {
        if (!authToken) return;              // logged out mid-sweep
        let entry = entryIn;
        const ctx = () => ({ lowBandwidth: lowBandwidthActive(), fightActive: isFightActive(), username: accountName() });
        let decision = decideSweepAction(entry, remote, ctx());

        if (decision.action === 'adopt') {
          entry = Object.assign({}, entry, { deferred: true, uploadId: decision.uploadId });
          markUploadPending(uploadKey, entry);
          console.log(`Pending upload ${uploadKey} — server already has its sync record (${decision.uploadId}), sending video only`);
          decision = decideSweepAction(entry, remote, ctx());
        }

        switch (decision.action) {
          case 'drop':
            // Nowhere to send it (session gone, or the host deleted the
            // clip). The clip itself stays on disk untouched.
            console.log(`Pending upload ${uploadKey} — ${decision.reason}, removing from queue (local copy kept)`);
            markUploadDone(uploadKey);
            break;
          case 'done':
            console.log(`Pending upload ${uploadKey} — already on the server, clearing (response had been lost)`);
            markUploadDone(uploadKey);
            break;
          case 'skip':
            break;
          case 'post-meta':
            await new Promise((resolve) => performPostMeta(uploadKey, entry, () => resolve()));
            break;
          case 'attach':
            console.log(`Attaching video ${uploadKey} → ${entry.uploadId} (attempt ${((uploadAttempts.get(uploadKey) || {}).count || 0) + 1})`);
            await new Promise((resolve) => performAttachVideo(uploadKey, entry, () => resolve()));
            break;
          case 'upload':
            console.log(`Retrying upload ${uploadKey} (attempt ${((uploadAttempts.get(uploadKey) || {}).count || 0) + 1})`);
            await new Promise((resolve) =>
              performUpload(entry.sessionCode, entry.videoPath, entry.metadataPath, uploadKey, () => resolve()));
            break;
        }
      }
    }
  } catch (e) {
    console.log('Upload retry sweep failed:', e.message);
  } finally {
    uploadSweepRunning = false;
    broadcastQueueState();
  }
}

// sessionCode is the session the highlight was TRIGGERED in (passed from the
// save). Leaving the session while the save queue caught up used to skip
// the upload outright. The server still accepts it from a former member
// for a moment the session already has.
function uploadHighlight(videoPath, metadataPath, sessionCode) {
  const code = sessionCode !== undefined ? sessionCode : (currentSession && currentSession.code);
  if (!code) { console.log('No session for this clip (solo save), skipping upload'); return; }
  // Its folder may have been renamed since it was saved (see moveClipPair).
  videoPath = movedClipPaths.get(videoPath) || videoPath;
  metadataPath = movedClipPaths.get(metadataPath) || metadataPath;

  console.log('=== UPLOAD START ===', videoPath);
  if (!fs.existsSync(videoPath)) {
    mainWindow.webContents.send('upload-error', 'Video file missing on disk');
    return;
  }
  const videoStats = fs.statSync(videoPath);

  // Empty/near-empty guard. A save that produced a valid MP4 container
  // (ftyp/moov written) but no real frames — dying capture, DXGI_ERROR_
  // ACCESS_LOST, or a save fired before the first segment filled — lands as
  // a few-KB file, sails past the old `size === 0` check, uploads, and shows
  // as a black clip days later. Two gates: a hard size floor (mirrors the
  // server's 100KB floor, catches true empties with no spawn), then an
  // ffprobe packet count for the subtler "valid header, ~0 frames" case.
  // ffprobe problems FAIL OPEN — if the probe can't run (e.g. ffprobe not
  // bundled in a packaged build) or errors, we log and upload anyway so this
  // can never block a legitimate clip.
  const MIN_LOCAL_VIDEO_BYTES = 100 * 1024; // 100KB — matches server floor
  if (videoStats.size < MIN_LOCAL_VIDEO_BYTES) {
    console.log(`Upload aborted — clip too small (${videoStats.size} bytes). Empty capture.`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-error',
        'Recording appears empty — no video was captured. Try recording again.');
    }
    return;
  }

  const ffprobePath = getFFmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const probe = spawn(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=nb_read_packets',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
  ], { windowsHide: true });

  let probeOut = '';
  let probeErr = '';
  probe.stdout.on('data', d => probeOut += d.toString());
  probe.stderr.on('data', d => probeErr += d.toString());

  probe.on('error', (e) => {
    // ffprobe couldn't spawn at all — fail open, upload as before.
    console.log('ffprobe spawn failed, uploading without frame check:', e.message);
    doUploadHighlight(videoPath, metadataPath, code);
  });

  probe.on('close', (probeCode) => {
    const frames = parseInt((probeOut || '').trim(), 10);
    if (probeCode === 0 && Number.isFinite(frames) && frames <= 0) {
      // Probe ran cleanly and found zero video packets — genuinely empty.
      console.log(`Upload aborted — ffprobe found 0 video packets in ${videoPath}. Keeping local file.`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('upload-error',
          'Recording appears empty — no video frames were captured. Try recording again.');
      }
      return;
    }
    if (probeCode !== 0) {
      // Probe errored (distinct from "ran and found zero") — fail open.
      console.log(`ffprobe exited ${probeCode}, uploading without frame check. stderr: ${probeErr.slice(-200)}`);
    } else {
      console.log(`ffprobe: ${frames} video packet(s) — clip OK`);
    }
    doUploadHighlight(videoPath, metadataPath, code);
  });
}

// The actual upload. Split out of uploadHighlight so the ffprobe empty-clip
// gate above can invoke it from a callback once the clip is confirmed real
// (or the probe failed open). Body is the original upload logic verbatim.
// Split into performUpload (does the actual HTTP call, session code passed
// explicitly) and doUploadHighlight (the normal live-save entry point).
// The split is what lets retryPendingUploadsFromDisk reuse the same upload
// logic for a leftover clip from a previous run, without needing
// currentSession to be populated yet.
//
// onDone is optional — Sync's sequential runner (below) passes it to know
// when one clip's attempt is finished, success or not, before starting the
// next. Every other call site fires-and-forgets, same as before.
//
// Status codes split PERMANENT vs RETRYABLE (Edge-Case Review finding
// UP3): only a definitive "no" from the server — 400/403/404/413 — clears
// the manifest. A 5xx, a connection error, or an unparseable body all leave
// the entry in place so it retries on next launch. Before this split, ANY
// non-201 cleared the manifest — so a clip could be silently dropped just
// because the server was briefly down, which Sync would have made worse by
// eating the exact clip the user asked it to recover.
const PERMANENT_UPLOAD_STATUSES = new Set([400, 403, 404, 413]);

function performUpload(sessionCode, videoPath, metadataPath, uploadKey, onDoneCaller) {
  // Every exit path below calls onDone. Wrapping it here marks the clip as
  // no longer in flight, records the outcome for backoff, and guarantees
  // it runs exactly once even if a timeout and a late response both land.
  inFlightUploads.add(uploadKey);
  let finished = false;
  const onDone = (result) => {
    if (finished) return;
    finished = true;
    inFlightUploads.delete(uploadKey);
    uploadProgress.delete(uploadKey);
    noteUploadAttempt(uploadKey, result);
    broadcastQueueState();
    if (onDoneCaller) onDoneCaller(result);
  };

  console.log(`Uploading highlight to session ${sessionCode}...`);
  uploadProgress.set(uploadKey, { sent: 0, total: queueFileSize(videoPath) });
  broadcastQueueState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('upload-progress', 0);

  const form = new FormData();
  form.append('video', fs.createReadStream(videoPath).pipe(new RateThrottleStream(uploadRateNow, (sent) => noteUploadBytes(uploadKey, sent))), {
    filename: path.basename(videoPath), contentType: 'video/mp4'
  });
  if (metadataPath && fs.existsSync(metadataPath)) {
    form.append('metadata', fs.createReadStream(metadataPath), {
      filename: path.basename(metadataPath), contentType: 'application/json'
    });
  }

  const req = form.submit({
    protocol: 'https:', host: 'peakabu.app', port: 443,
    path: `/sessions/${sessionCode}/upload`, method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken }
  }, (err, res) => {
    if (err) {
      console.log('Upload connection error:', err.message);
      // Leave the manifest entry in place — network hiccup, not a rejected
      // clip. Retries on next launch.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('upload-progress', -1);
        mainWindow.webContents.send('upload-error', 'Could not reach server');
      }
      if (onDone) onDone({ ok: false, permanent: false, message: 'Could not reach server' });
      return;
    }
    console.log('=== UPLOAD RESPONSE ===', res.statusCode);

    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        if (res.statusCode === 201) {
          console.log('Upload successful:', result.uploadId);
          markUploadDone(uploadKey);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload-progress', 100);
            mainWindow.webContents.send('upload-complete', result.uploadId);
          }
          if (onDone) onDone({ ok: true, permanent: true, message: null });
        } else if (PERMANENT_UPLOAD_STATUSES.has(res.statusCode)) {
          // A definitive rejection — retrying won't help.
          markUploadDone(uploadKey);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload-progress', -1);
            mainWindow.webContents.send('upload-error', result.error);
          }
          if (onDone) onDone({ ok: false, permanent: true, message: result.error });
        } else {
          // 5xx or an unrecognized status — treat as transient. Leave the
          // manifest entry in place so it retries on next launch instead of
          // silently dropping the clip.
          console.log(`Upload got ${res.statusCode} — treating as retryable, keeping manifest entry`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload-progress', -1);
            mainWindow.webContents.send('upload-error', result.error || 'Server error — will retry');
          }
          if (onDone) onDone({ ok: false, permanent: false, message: result.error || 'Server error — will retry' });
        }
      } catch (parseErr) {
        // Ambiguous response — leave it pending rather than guess.
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload-progress', -1);
          mainWindow.webContents.send('upload-error', 'Server returned invalid response');
        }
        if (onDone) onDone({ ok: false, permanent: false, message: 'Server returned invalid response' });
      }
      res.resume();
    });
  });

  // A stalled socket used to hold the clip "in progress" forever, so no
  // retry would ever pick it up. Destroying the request raises 'error',
  // which lands in the err branch above: transient, clip kept, retried.
  if (req && typeof req.setTimeout === 'function') {
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
      console.log(`Upload ${uploadKey} stalled for ${UPLOAD_IDLE_TIMEOUT_MS / 1000}s — aborting, will retry`);
      req.destroy(new Error('upload stalled'));
    });
  }
}

// ================================
// DEFERRED UPLOAD — Low Bandwidth Mode's two halves.
// performPostMeta: the metadata JSON alone → POST /sessions/:code/upload-pending,
//   which creates the server record (videoFile null = pending) and charges
//   the clip's weight. Returns the uploadId, stored on the manifest entry.
// performAttachVideo: the video → POST /sessions/:code/uploads/:id/video,
//   during downtime, through the same live-rate throttle.
// Both follow performUpload's contract: onDone runs exactly once, 4xx that
// can't succeed clears the entry, everything else stays for the sweep.
// ================================
function performPostMeta(uploadKey, entry, onDoneCaller) {
  inFlightUploads.add(uploadKey);
  broadcastQueueState();
  let finished = false;
  const onDone = (result) => {
    if (finished) return;
    finished = true;
    inFlightUploads.delete(uploadKey);
    noteUploadAttempt(uploadKey, result);
    broadcastQueueState();
    if (onDoneCaller) onDoneCaller(result);
  };

  // No sidecar → nothing to defer with. Send it the normal way.
  if (!entry.metadataPath || !fs.existsSync(entry.metadataPath)) {
    markUploadPending(uploadKey, Object.assign({}, entry, { deferred: false, uploadId: null }));
    return onDone({ ok: false, permanent: true, message: 'No metadata — sending as a normal upload' });
  }

  const form = new FormData();
  form.append('metadata', fs.createReadStream(entry.metadataPath), {
    filename: path.basename(entry.metadataPath), contentType: 'application/json'
  });

  const req = form.submit({
    protocol: 'https:', host: 'peakabu.app', port: 443,
    path: `/sessions/${entry.sessionCode}/upload-pending`, method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken }
  }, (err, res) => {
    if (err) {
      console.log('Sync-data post connection error:', err.message);
      return onDone({ ok: false, permanent: false, message: 'Could not reach server' });
    }
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      let result = {};
      try { result = JSON.parse(body); } catch (e) {}

      if (res.statusCode === 201 && result.uploadId) {
        markUploadPending(uploadKey, Object.assign({}, entry, { deferred: true, uploadId: result.uploadId }));
        console.log(`Sync data posted for ${uploadKey} → pending ${result.uploadId}, video queued for downtime`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload-deferred', { uploadId: result.uploadId, fileName: path.basename(entry.videoPath) });
        }
        return onDone({ ok: true, permanent: true, message: null });
      }

      // The server only refuses to DEFER a clip when its metadata has no
      // duration — the clip itself is fine, so send it the normal way.
      if (res.statusCode === 400 && /durationMs/.test(result.error || '')) {
        console.log(`Sync-data post refused for ${uploadKey} (${result.error}) — falling back to normal upload`);
        markUploadPending(uploadKey, Object.assign({}, entry, { deferred: false, uploadId: null }));
        return onDone({ ok: false, permanent: true, message: result.error });
      }

      // 404 with no JSON error = the route itself isn't there (server
      // rolled back / not deployed), not "session gone". Don't drop the
      // clip — send it through the normal combined upload instead.
      if (res.statusCode === 404 && !result.error) {
        console.log(`Sync-data route unavailable for ${uploadKey} — falling back to normal upload`);
        markUploadPending(uploadKey, Object.assign({}, entry, { deferred: false, uploadId: null }));
        return onDone({ ok: false, permanent: true, message: 'Deferred upload unavailable' });
      }

      if (PERMANENT_UPLOAD_STATUSES.has(res.statusCode)) {
        // Clip cap reached, banned, session gone — the video would be refused too.
        markUploadDone(uploadKey);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('upload-error', result.error || `Upload refused (${res.statusCode})`);
        }
        return onDone({ ok: false, permanent: true, message: result.error });
      }

      console.log(`Sync-data post got ${res.statusCode} — will retry`);
      onDone({ ok: false, permanent: false, message: result.error || 'Server error — will retry' });
    });
  });

  if (req && typeof req.setTimeout === 'function') {
    req.setTimeout(60 * 1000, () => req.destroy(new Error('sync-data post stalled')));
  }
}

function performAttachVideo(uploadKey, entry, onDoneCaller) {
  inFlightUploads.add(uploadKey);
  let finished = false;
  const onDone = (result) => {
    if (finished) return;
    finished = true;
    inFlightUploads.delete(uploadKey);
    uploadProgress.delete(uploadKey);
    noteUploadAttempt(uploadKey, result);
    broadcastQueueState();
    if (onDoneCaller) onDoneCaller(result);
  };

  uploadProgress.set(uploadKey, { sent: 0, total: queueFileSize(entry.videoPath) });
  broadcastQueueState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('upload-progress', 0);

  const form = new FormData();
  form.append('video', fs.createReadStream(entry.videoPath).pipe(new RateThrottleStream(uploadRateNow, (sent) => noteUploadBytes(uploadKey, sent))), {
    filename: path.basename(entry.videoPath), contentType: 'video/mp4'
  });

  const req = form.submit({
    protocol: 'https:', host: 'peakabu.app', port: 443,
    path: `/sessions/${entry.sessionCode}/uploads/${encodeURIComponent(entry.uploadId)}/video`, method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken }
  }, (err, res) => {
    if (err) {
      console.log('Video attach connection error:', err.message);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('upload-progress', -1);
      return onDone({ ok: false, permanent: false, message: 'Could not reach server' });
    }
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      let result = {};
      try { result = JSON.parse(body); } catch (e) {}
      const send = (ch, v) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, v); };

      if (res.statusCode === 201 || res.statusCode === 409) {
        // 409 = already attached (a lost response on an earlier try) — same outcome.
        console.log(`Video attached: ${uploadKey} → ${entry.uploadId}${res.statusCode === 409 ? ' (was already attached)' : ''}`);
        markUploadDone(uploadKey);
        send('upload-progress', 100);
        send('upload-complete', entry.uploadId);
        return onDone({ ok: true, permanent: true, message: null });
      }
      if (res.statusCode === 404 && !result.error) {
        // No JSON error = route missing (server rolled back), not a deleted
        // clip. Keep it queued and retry rather than dropping it.
        console.log(`Video attach route unavailable for ${uploadKey} — will retry`);
        send('upload-progress', -1);
        return onDone({ ok: false, permanent: false, message: 'Server route unavailable — will retry' });
      }
      if (res.statusCode === 404) {
        // Host deleted the clip while it was queued, or the session expired.
        console.log(`Video attach ${uploadKey} — clip no longer on server (${result.error || 404}), local copy kept`);
        markUploadDone(uploadKey);
        send('upload-progress', -1);
        return onDone({ ok: false, permanent: true, message: result.error || 'Clip no longer on server' });
      }
      if (PERMANENT_UPLOAD_STATUSES.has(res.statusCode)) {
        markUploadDone(uploadKey);
        send('upload-progress', -1);
        send('upload-error', result.error || `Upload refused (${res.statusCode})`);
        return onDone({ ok: false, permanent: true, message: result.error });
      }
      console.log(`Video attach got ${res.statusCode} — will retry`);
      send('upload-progress', -1);
      onDone({ ok: false, permanent: false, message: result.error || 'Server error — will retry' });
    });
  });

  // Same stall guard as performUpload. The mid-fight trickle still sends a
  // slice every second, so it never trips this.
  if (req && typeof req.setTimeout === 'function') {
    req.setTimeout(UPLOAD_IDLE_TIMEOUT_MS, () => {
      console.log(`Video attach ${uploadKey} stalled for ${UPLOAD_IDLE_TIMEOUT_MS / 1000}s — aborting, will retry`);
      req.destroy(new Error('upload stalled'));
    });
  }
}

function doUploadHighlight(videoPath, metadataPath, sessionCode) {
  const code = sessionCode || (currentSession && currentSession.code);
  if (!code) { console.log('No session for this clip — kept locally'); return; }
  // Moved while the empty-clip probe ran (see moveClipPair).
  videoPath = movedClipPaths.get(videoPath) || videoPath;
  metadataPath = movedClipPaths.get(metadataPath) || metadataPath;
  const uploadKey = path.basename(videoPath);
  const deferred = lowBandwidthActive() && !!metadataPath && fs.existsSync(metadataPath);
  const entry = { videoPath, metadataPath, sessionCode: code, startedAt: Date.now(), deferred, uploadId: null };
  markUploadPending(uploadKey, entry);

  if (deferred) {
    // Low Bandwidth Mode: sync data now, video once the fight is over.
    performPostMeta(uploadKey, entry, (r) => {
      if (r && r.ok && !isFightActive()) sweepPendingUploads();
    });
    return;
  }
  performUpload(code, videoPath, metadataPath, uploadKey);
}

// ================================
// SYNC — RECOVER LOCAL CLIPS THAT NEVER MADE IT TO THE SERVER
//
// pendingUploads only knows about a clip once doUploadHighlight has been
// called on it. A crash before that point (mid-save, power loss right
// after the .mp4/.json pair lands) leaves a clip on disk with nothing
// pointing at it — invisible to every existing recovery path. Sync closes
// that gap: scan CLIPS_DIR for sidecars belonging to a session, diff
// against what the server actually has, and offer to upload what's
// missing. Detection is automatic (runs whenever that session's web player
// is opened, see the 'open-player' handler below); the upload itself is
// always a manual button press from the renderer via 'sync-start'.
//
// Scoped to one session code at a time — not a sweep of every session ever
// recorded locally. See the "Sync — Feature Spec" project doc for the full
// design and the matching server-side authorization rewrite in
// routes/uploads.js.
// ================================

// GET /sessions/:code/uploads — same lookup the web player itself uses, run
// from main so the scan doesn't need the renderer to round-trip through
// fetch(). Resolves rather than rejects on every outcome, including a
// network failure, so callers can branch on `status` alone.
//
// It must ALWAYS settle. The retry sweep awaits this while holding
// uploadSweepRunning, so a lookup that never answered blocked every later
// sweep — Cabbam's retries sat 20–40 min on 9/22 (RAE8X9) — and the 📤 tab's
// ⟲ Sync check would hang on "Checking…". A hard cap covers a server that
// accepts the connection but never replies; 'aborted'/'error' on the
// response cover a body cut off mid-stream, where 'end' never fires. A
// timeout resolves as status 0, which every caller already treats as
// "unreachable, try again later".
const FETCH_UPLOADS_TIMEOUT_MS = 15 * 1000;
function fetchSessionUploads(code) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const req = https.request({
      protocol: 'https:', host: 'peakabu.app', port: 443,
      path: `/sessions/${code}/uploads`, method: 'GET'
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('aborted', () => finish({ status: 0, error: 'response aborted' }));
      res.on('error', (e) => finish({ status: 0, error: e.message }));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          finish({
            status: res.statusCode,
            uploads: parsed.uploads || [],
            closed: !!parsed.closed,
            createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : null,
            expiresAt: parsed.expiresAt || null,
            stars: Array.isArray(parsed.stars) ? parsed.stars : []   // v0.1.87 server; [] before
          });
        } catch (e) {
          finish({ status: res.statusCode, error: 'unparseable_response' });
        }
      });
    });
    timer = setTimeout(() => {
      console.log(`Session lookup ${code} got no answer in ${FETCH_UPLOADS_TIMEOUT_MS / 1000}s — treating as unreachable`);
      finish({ status: 0, error: 'timeout' });
      req.destroy(new Error('session lookup timed out'));
    }, FETCH_UPLOADS_TIMEOUT_MS);
    req.on('error', (e) => finish({ status: 0, error: e.message }));
    req.end();
  });
}

// Sidecar scan, scoped to one session code. Mirrors aireel-list-local-clips
// below (same CLIPS_DIR walk, same "sidecar with no surviving .mp4 is
// skipped" rule) but also keeps coordinated_timestamp, which that scan
// doesn't need but the server's sync-restricted gap-fill check does.
function scanLocalClipsForSession(code) {
  const wantSession = String(code || '').toUpperCase();
  const entries = listClipSidecars();   // the root and every clip folder (v0.1.87)

  const out = [];
  for (const jsonPath of entries) {
    const videoPath = jsonPath.replace(/\.json$/i, '.mp4');
    if (!fs.existsSync(videoPath)) continue; // clip deleted, sidecar orphaned
    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { continue; }
    if (!meta || !meta.clipId) continue;     // full-session archive sidecars have no clipId
    if (String(meta.sessionId || '').toUpperCase() !== wantSession) continue;

    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(videoPath).size; } catch (e) {}

    out.push({
      videoPath,
      metadataPath: jsonPath,
      // Local basename with no extension — this is the prefix a matching
      // server record's videoFile must start with (see multer's filename()
      // in routes/uploads.js: `${baseName}_${Date.now()}${ext}`).
      baseName: path.basename(videoPath, path.extname(videoPath)),
      fileName: path.basename(videoPath),
      startTimeUTC: typeof meta.startTimeUTC === 'number' ? meta.startTimeUTC : null,
      durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
      coordinatedTimestamp: typeof meta.coordinated_timestamp === 'number' ? meta.coordinated_timestamp : null,
      // Star identity: the coordinated timestamp, or saveTimeUTC for a clip
      // saved without the server (same fallback the web player groups by).
      momentTs: typeof meta.coordinated_timestamp === 'number' ? meta.coordinated_timestamp
        : (typeof meta.saveTimeUTC === 'number' ? meta.saveTimeUTC : null),
      starred: meta.starred === true,
      starPending: meta.starPending === true,
      sizeBytes
    });
  }

  out.sort((a, b) => (a.startTimeUTC || 0) - (b.startTimeUTC || 0));
  return out;
}

// Clips saved during a session but stamped sessionId null — a queued save
// that ran after the session ended (fixed in saveHighlight, but clips from
// before that fix are on disk this way). They still carry the server-issued
// coordinated_timestamp of their highlight, which ties them to exactly one
// session: the one whose uploads contain that same timestamp.
function scanOrphanClips() {
  const entries = listClipSidecars();   // the root and every clip folder (v0.1.87)
  const cutoff = Date.now() - SYNC_CHECK_MAX_AGE_MS;
  const out = [];
  for (const jsonPath of entries) {
    if (!fs.existsSync(jsonPath.replace(/\.json$/i, '.mp4'))) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { continue; }
    if (!meta || !meta.clipId || meta.sessionId) continue;
    if (typeof meta.coordinated_timestamp !== 'number') continue; // a solo save, not a session highlight
    if (typeof meta.startTimeUTC === 'number' && meta.startTimeUTC < cutoff) continue;
    out.push({ jsonPath, meta });
  }
  return out;
}

// Stamps orphans whose highlight belongs to `code` (per the server's upload
// list) with that session, so the normal scan below picks them up.
function adoptOrphanClips(code, remoteUploads, orphans) {
  const known = new Set((remoteUploads || [])
    .map(u => u.coordinatedTimestamp)
    .filter(t => typeof t === 'number'));
  let adopted = 0;
  for (const o of orphans) {
    if (!known.has(o.meta.coordinated_timestamp)) continue;
    try {
      const meta = Object.assign({}, o.meta, { sessionId: code, sessionIdRecoveredBy: 'sync' });
      const tmp = o.jsonPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
      fs.renameSync(tmp, o.jsonPath);
      adopted++;
    } catch (e) { console.log(`Sync: couldn't re-stamp ${path.basename(o.jsonPath)}:`, e.message); }
  }
  if (adopted) console.log(`Sync: ${adopted} clip(s) saved after session ${code} ended were matched back to it`);
  return adopted;
}

// Scan + diff for one session. Returns a plain object the renderer can
// switch on directly — `state` is one of 'expired' | 'error' | 'ok'.
async function runSyncScan(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length < 4) return { state: 'error', code: clean, syncable: [] };

  let local = scanLocalClipsForSession(clean);
  const orphans = scanOrphanClips();
  // Highlights that never produced a clip on this PC (see recordSaveFailure).
  const failedSaves = saveFailuresForSession(clean).length;
  if (local.length === 0 && orphans.length === 0) return { state: 'ok', code: clean, syncable: [], failedSaves };

  // `code` rides along on every result so the renderer can tell which
  // session a result belongs to (the 📤 tab checks several at once), and
  // `status` on errors so a rate limit (429) can be told apart from an outage.
  const remote = await fetchSessionUploads(clean);
  if (remote.status === 404) return { state: 'expired', code: clean, syncable: [], failedSaves };
  if (remote.status !== 200) return { state: 'error', code: clean, status: remote.status, syncable: [], failedSaves };

  if (orphans.length && adoptOrphanClips(clean, remote.uploads, orphans) > 0) {
    local = scanLocalClipsForSession(clean);
  }

  // Star flags in this session's sidecars follow the server (see STARS).
  reconcileSidecarStars(clean, local, remote);

  // Syncable = none of THIS account's server records has this clip's
  // basename as a prefix (squadmates' clips of the same highlight share the
  // name — see isOwnRecord in upload-queue.js), AND it isn't already
  // mid-upload via the normal live path.
  //
  // A clip whose METADATA is on the server but whose video isn't (Low
  // Bandwidth Mode, queue entry lost) is not "missing" — re-uploading it in
  // full would create a second record and charge its weight twice. Instead
  // it goes back into the queue to have just its video attached.
  //
  // A closed session only takes new clips from its host, or clips of a
  // highlight it already has (the gap-filling gate in routes/uploads.js).
  // Anything else is mirrored here as closedOut rather than offered: Sync
  // used to send the whole video, get refused at the very end, and list it
  // as missing again (a 166 MB clip from 9/13, re-sent on every press —
  // 9F7PLX, 9/27). Attaching video to an existing record isn't gated, so
  // that check runs first. An older server without createdBy keeps the old
  // behavior.
  const me = accountName();
  const gated = !!(remote.closed && remote.createdBy && me &&
    remote.createdBy.toLowerCase() !== me.toLowerCase());
  const knownMoments = new Set((remote.uploads || [])
    .map(u => u.coordinatedTimestamp)
    .filter(t => typeof t === 'number'));
  let adopted = 0;
  let closedOut = 0;
  const syncable = local.filter(clip => {
    const key = path.basename(clip.videoPath);
    if (pendingUploads.has(key)) return false;
    if (findLandedRecord(remote.uploads, clip.videoPath, me)) return false;
    const pend = findPendingRecord(remote.uploads, clip.metadataPath, me);
    if (pend) {
      markUploadPending(key, {
        videoPath: clip.videoPath, metadataPath: clip.metadataPath, sessionCode: clean,
        startedAt: Date.now(), deferred: true, uploadId: pend.id
      });
      adopted++;
      return false;
    }
    if (gated && !(clip.coordinatedTimestamp !== null && knownMoments.has(clip.coordinatedTimestamp))) {
      closedOut++;
      return false;
    }
    return true;
  });
  if (adopted > 0) {
    console.log(`Sync: ${adopted} clip(s) already have sync data on the server — queued to attach video only`);
    sweepPendingUploads();
  }
  if (closedOut > 0) {
    console.log(`Sync: ${closedOut} clip(s) for ${clean} can't be added — session closed and they aren't from a highlight it recorded (kept on this PC)`);
  }

  return { state: 'ok', code: clean, syncable, closedOut, closed: remote.closed, failedSaves };
}

// ================================
// MANUAL SYNC CHECK — the 📤 tab's "⟲ Sync" button
//
// The automatic scan above only runs when the web player is opened for a
// session. A squadmate can't rejoin a closed session (the server holds it
// for the host), and rejoining never triggered the scan anyway — so clips
// from a session they didn't reopen in the player were never offered for
// recovery (RAE8X9, 9/23). This checks every recent session that has clips
// on this PC. Uploading stays a separate, explicit button press per session.
// ================================
const SYNC_CHECK_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // longest tier retention (t4/t5: 60 days)
const SYNC_CHECK_MAX_SESSIONS = 8; // GET /sessions/:code/uploads shares a 20/min limit with the player
let syncCheckRunning = false;

// Every session code with at least one surviving local clip, newest first.
function listLocalSessionCodes() {
  const entries = listClipSidecars();   // the root and every clip folder (v0.1.87)
  const cutoff = Date.now() - SYNC_CHECK_MAX_AGE_MS;
  const byCode = new Map();
  for (const jsonPath of entries) {
    if (!fs.existsSync(jsonPath.replace(/\.json$/i, '.mp4'))) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { continue; }
    if (!meta || !meta.clipId || !meta.sessionId) continue; // solo clips have no session to sync to
    const t = typeof meta.startTimeUTC === 'number' ? meta.startTimeUTC : 0;
    if (t && t < cutoff) continue;                          // past every tier's retention
    const code = String(meta.sessionId).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) continue;
    const cur = byCode.get(code) || { code, localClips: 0, lastAt: 0 };
    cur.localClips++;
    if (t > cur.lastAt) cur.lastAt = t;
    byCode.set(code, cur);
  }
  return [...byCode.values()].sort((a, b) => b.lastAt - a.lastAt);
}

// One scan per session, sequentially (runSyncScan does the diff). Stops on
// a 429 rather than burning the rest of the minute's lookups.
async function runSyncCheckAll() {
  const codes = listLocalSessionCodes();
  const sessions = [];
  let rateLimited = false;
  let unreachable = false;
  for (const c of codes.slice(0, SYNC_CHECK_MAX_SESSIONS)) {
    let r;
    try { r = await runSyncScan(c.code); }
    catch (e) { r = { state: 'error', code: c.code, syncable: [] }; }
    if (r.state === 'error' && r.status === 429) { rateLimited = true; break; }
    // Unreachable (offline, or no answer within FETCH_UPLOADS_TIMEOUT_MS):
    // the rest would fail the same way, one timeout each — stop here.
    if (r.state === 'error' && !r.status) { unreachable = true; break; }
    sessions.push({
      code: c.code, lastAt: c.lastAt, localClips: c.localClips,
      state: r.state, status: r.status || null, closed: !!r.closed,
      syncable: r.syncable || [], failedSaves: r.failedSaves || 0,
      closedOut: r.closedOut || 0
    });
  }
  console.log(`Sync check: ${sessions.length}/${codes.length} session(s) checked` +
    (rateLimited ? ' (stopped — rate limited)' : '') +
    (unreachable ? ' (stopped — server unreachable)' : '') + ', ' +
    sessions.reduce((n, s) => n + s.syncable.length, 0) + ' clip(s) missing');
  return { total: codes.length, checked: sessions.length, rateLimited, unreachable, sessions };
}

// Sequential upload of a syncable list — one at a time, through the same
// throttle-respecting path as a live save (markUploadPending +
// performUpload). Firing these concurrently would defeat
// RateThrottleStream (upload-queue.js), which exists specifically
// to protect in-game ping. Per-clip progress goes to the renderer over
// 'sync-progress'; runSyncScan() runs again at the end so the client's list
// reflects what the server actually has rather than an optimistic guess.
// syncUploadRunning keeps Organize from moving clips while Sync sends them.
async function runSyncUpload(code, clips) {
  syncUploadRunning = true;
  try { return await runSyncUploadClips(code, clips); }
  finally { syncUploadRunning = false; }
}

async function runSyncUploadClips(code, clips) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const total = clips.length;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-progress', { index: i, total, fileName: clip.fileName, state: 'uploading' });
    }
    const uploadKey = path.basename(clip.videoPath);
    markUploadPending(uploadKey, {
      videoPath: clip.videoPath, metadataPath: clip.metadataPath,
      sessionCode: clean, startedAt: Date.now()
    });
    const result = await new Promise((resolve) => {
      performUpload(clean, clip.videoPath, clip.metadataPath, uploadKey, resolve);
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-progress', {
        index: i, total, fileName: clip.fileName,
        state: result.ok ? 'done' : (result.permanent ? 'failed' : 'retry-later'),
        message: result.message
      });
    }
  }
  const rescanned = await runSyncScan(clean);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-progress', { index: total, total, state: 'complete' });
    mainWindow.webContents.send('sync-scan-result', rescanned);
  }
}

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 840,
    minWidth: 560, minHeight: 640,
    show: false,                 // avoid the un-maximized flash on launch
    backgroundColor: '#0a1611',
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, experimentalFeatures: true,
      // Recording/highlight timing must keep running at full rate even when
      // this window loses focus or is minimized (user is usually tabbed into
      // the game itself) — Chromium's default background throttling would
      // otherwise slow timers and could desync coordinated highlight capture.
      backgroundThrottling: false
    }
  });

  // Open maximized (not kiosk fullscreen — the title bar has to stay usable
  // for the docked player split and for dragging the window between monitors)
  mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keep the docked player pinned to the right 2/3 through any resize
  mainWindow.on('resize', () => layoutPlayerView());
  mainWindow.on('maximize', () => layoutPlayerView());
  mainWindow.on('unmaximize', () => layoutPlayerView());
  // Coming back from minimize/hide: layoutPlayerView was skipped while the
  // window was down, so re-assert geometry now that the real content size
  // is readable again. Without this the view keeps whatever bounds it had
  // before minimizing and the renderer's padding stays stale.
  mainWindow.on('restore', () => setTimeout(() => layoutPlayerView(), 50));
  mainWindow.on('show', () => setTimeout(() => layoutPlayerView(), 50));
  mainWindow.on('close', (event) => {
    if (allowWindowClose) return;
    if (pendingUploads.size === 0) {
      // Nothing of our own pending. A host with squadmates still uploading
      // gets a heads-up (closing can't hurt their uploads).
      if (squadPending.count > 0) {
        event.preventDefault();
        if (askCloseWithSquadUploads()) {
          allowWindowClose = true;
          mainWindow.close();
        }
      }
      return;
    }
    event.preventDefault();

    const choice = askQuitWithPendingUploads();
    if (choice === 'quit') {
      console.log('User chose to quit anyway — remaining uploads stay in the retry manifest');
      allowWindowClose = true;
      mainWindow.close();
      return;
    }
    if (choice === 'minimize') {
      console.log(`Close → minimized — ${pendingUploads.size} queued upload(s) keep going`);
      mainWindow.minimize();
      return;
    }

    console.log(`Close deferred — ${pendingUploads.size} upload(s) still in flight`);
    startQuitWait();
  });
  mainWindow.on('closed', () => { closeAnyPlayer(); });

  mainWindow.loadFile('index.html');
  if (!app.isPackaged) mainWindow.webContents.openDevTools();

  // 'media' — desktop/mic capture for recording. clipboard-read/write —
  // the docked web player's copy-link and paste-code buttons run
  // navigator.clipboard inside this same session and were hitting this
  // same gate, denied by default since only 'media' was allowed.
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
  });

    // authToken is a JWT and shouldn't sit in plaintext in %APPDATA%.
  // safeStorage encrypts it via the OS credential store (DPAPI on Windows,
  // Keychain on macOS, libsecret on Linux) before it touches disk. Falls
  // back to plaintext only if the OS store is genuinely unavailable.
  ipcMain.handle('get-auth-state', () => {
    const prefs = loadUserPreferences();

    if (prefs.authTokenEncrypted) {
      try {
        const token = safeStorage.decryptString(Buffer.from(prefs.authTokenEncrypted, 'base64'));
        return { token, username: prefs.authUsername || null };
      } catch (err) {
        // Undecryptable usually means it was encrypted under a different
        // OS user/DPAPI key — treat as logged out rather than crash.
        console.log('Could not decrypt stored auth token — clearing it:', err.message);
        const clean = readPrefsRaw();
        delete clean.authTokenEncrypted;
        delete clean.authUsername;
        saveUserPreferences(clean);
        return { token: null, username: null };
      }
    }

    // Legacy plaintext token from a pre-encryption install — migrate it
    // to encrypted storage on this read so it's only ever touched once.
    if (prefs.authToken) {
      const migrated = readPrefsRaw();
      delete migrated.authToken;
      if (safeStorage.isEncryptionAvailable()) {
        migrated.authTokenEncrypted = safeStorage.encryptString(prefs.authToken).toString('base64');
      } else {
        migrated.authToken = prefs.authToken; // no OS store available — keep plaintext
      }
      saveUserPreferences(migrated);
      return { token: prefs.authToken, username: prefs.authUsername || null };
    }

    return { token: null, username: null };
  });

  ipcMain.handle('set-auth-state', (event, { token, username }) => {
    const prefs = readPrefsRaw();
    delete prefs.authToken; // clear any legacy plaintext field on every write
    if (token) {
      if (safeStorage.isEncryptionAvailable()) {
        prefs.authTokenEncrypted = safeStorage.encryptString(token).toString('base64');
      } else {
        console.log('safeStorage unavailable — storing auth token in plaintext');
        prefs.authToken = token;
      }
      prefs.authUsername = username;
    } else {
      delete prefs.authTokenEncrypted;
      delete prefs.authUsername;
    }
    saveUserPreferences(prefs);
  });

  ipcMain.handle('get-desktop-sources', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  ipcMain.handle('pick-storage-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Video Storage Directory',
      defaultPath: app.getPath('videos'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const dirPath = result.filePaths[0];
      CLIPS_DIR = path.join(dirPath, 'PeakAbu');
      BUFFER_DIR = path.join(dirPath, '.apex-highlights-buffer');
      const prefs = readPrefsRaw();
      prefs.storageDirectory = dirPath;
      saveUserPreferences(prefs);
      ensureFolders();
      return { success: true, path: CLIPS_DIR };
    }
    return { success: false };
  });

  ipcMain.handle('wgc-list-windows', async (event, opts) => {
    const includeAll = !!(opts && opts.includeAll);
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });

    // desktopCapturer only gives us the window TITLE. Cross-reference against
    // the process list so we can filter on executable name, which is far more
    // reliable — "Spotify Premium" as a title is easy to miss, spotify.exe isn't.
    const procByTitle = new Map();
    try {
      const wins = await enumerateWindowsPS();
      wins.forEach(w => procByTitle.set(w.title, w.processName));
    } catch (e) {
      console.log('Window/process cross-reference failed:', e.message);
    }

    const mapped = sources
      .filter(s => s.name && s.name.trim() !== '' && s.name !== 'Peak-Abu')
      .map(s => {
        const proc = procByTitle.get(s.name) || '';
        const known = lookupGame(proc);
        return {
          id: s.id,
          name: s.name,
          processName: proc,
          knownGame: known ? known.name : null,
          genre: known ? known.genre : null,
          isGame: !!known || isLikelyGameProcess(proc, s.name),
          thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : null,
          appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null
        };
      });

    const filtered = includeAll ? mapped.slice() : mapped.filter(m => m.isGame);
    // Recognised titles float to the top
    filtered.sort((a, b) => (b.knownGame ? 1 : 0) - (a.knownGame ? 1 : 0));

    return {
      windows: filtered,
      totalCount: mapped.length,
      hiddenCount: mapped.length - filtered.length,
      filtered: !includeAll
    };
  });

  // The docked WebContentsView always paints above the renderer's own DOM,
  // regardless of CSS z-index (see layoutPlayerView). The window picker
  // modal has no reliable way to win that paint order on its own — most
  // visibly on a restored 'window'-mode session, where the picker is
  // forced open automatically (no wgcSourceId survives a restart) at the
  // exact moment the docked player is also mounting. Rather than race
  // that timing, just collapse the player view to nothing while the
  // picker is open, and restore real layout when it closes.
  ipcMain.on('picker-opened', () => {
    if (playerView) playerView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  });
  ipcMain.on('picker-closed', () => {
    layoutPlayerView();
  });

  ipcMain.handle('wgc-get-capture-mode', () => ({
    mode: wgcCaptureMode ? 'window' : 'monitor',
    lastWindowTitle: wgcLastWindowTitle
  }));

  ipcMain.handle('wgc-set-capture-mode', (event, { mode, windowTitle }) => {
    wgcCaptureMode = (mode === 'window');
    if (windowTitle !== undefined) wgcLastWindowTitle = windowTitle || null;
    const prefs = readPrefsRaw();
    prefs.wgcCaptureMode = wgcCaptureMode;
    prefs.wgcLastWindowTitle = wgcLastWindowTitle;
    saveUserPreferences(prefs);
    console.log(`Capture mode set to: ${wgcCaptureMode ? 'Window' : 'Monitor'}, title: ${wgcLastWindowTitle}`);
    return { success: true };
  });

  ipcMain.handle('wgc-init-buffer', () => {
    const fileId = `${wgcFileTag()}_${Date.now() % 100000}`;
    wgcStartNewFile(fileId);
    wgcStartRolloverSchedule();
    return { fileId };
  });

  ipcMain.on('wgc-recorder-started', (event, { fileId, fileStartUTC }) => {
    wgcSetFileStartUTC(fileId, fileStartUTC);
    console.log(`WGC recorder started: ${fileId} at UTC ${fileStartUTC}`);
  });

  ipcMain.on('wgc-chunk', (event, { fileId, buf }) => {
    wgcAppendChunk(fileId, buf);
  });

  ipcMain.on('wgc-recorder-stopped', (event, { fileId }) => {
    wgcFinalizeFile(fileId);
  });

  ipcMain.on('wgc-capture-failed', (event, { reason }) => {
    console.log(`WGC capture failed: ${reason}`);
    if (wgcMidSessionRestarts < WGC_MAX_RESTARTS) {
      wgcMidSessionRestarts++;
      console.log(`WGC auto-restart ${wgcMidSessionRestarts}/${WGC_MAX_RESTARTS}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-restart-capture', {
          attempt: wgcMidSessionRestarts,
          maxAttempts: WGC_MAX_RESTARTS
        });
      }
    } else {
      console.log('WGC max restarts reached — falling back to Monitor mode');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-fallback-to-monitor', {
          reason: 'Window capture failed repeatedly — recording your monitor instead.'
        });
      }
      wgcRetire('fell back to monitor capture');   // queued saves still cut from the old files
      wgcCaptureMode = false;
      stoppingIntentionally = false;
      midSessionRestarts = 0;
      transientCaptureRetries = 0;
      recordingSessionTag = Date.now();
      engineLadder = buildEngineLadder();
      engineIndex = 0;
      startRecording(currentMonitor);
    }
  });

  ipcMain.handle('get-windows', async () => enumerateWindowsPS());

  ipcMain.handle('get-storage-directory', () => CLIPS_DIR);
  ipcMain.handle('is-first-launch', () => !loadUserPreferences().hasLaunched);
  ipcMain.handle('mark-first-launch-done', () => {
    const prefs = loadUserPreferences();
    prefs.hasLaunched = true;
    saveUserPreferences(prefs);
  });
  ipcMain.handle('get-install-path', () =>
    app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname));

  ipcMain.handle('get-current-hdr', () => captureHdr);
  ipcMain.handle('get-current-adapter', () => captureAdapter);

  // Consolidated settings snapshot for UI restore on launch.
  ipcMain.handle('get-saved-settings', () => ({
    fps: recordFps,
    resolution: recordResolutionKey,
    monitorIndex: savedMonitorIndex,
    hotkey: customHotkey,
    hdr: captureHdr
  }));

  ipcMain.on('save-highlight', () => saveHighlight());
  ipcMain.on('broadcast-save-highlight', (event, { coordinated_timestamp, clipDuration, triggerSource }) => {
    console.log(`Received broadcast save-highlight: ts=${coordinated_timestamp}, clipDuration=${clipDuration}ms, source=${triggerSource || 'manual'}`);
    saveHighlight(coordinated_timestamp, clipDuration, triggerSource);
  });
  ipcMain.on('set-socket-io', () => console.log('Socket.IO connection noted in main process'));

  ipcMain.on('auth-token-updated', (event, token) => {
    authToken = token;
    if (!token) return;
    // A fresh token may be exactly what a 401-failed clip was waiting on,
    // so don't make those sit out the rest of their backoff.
    for (const a of uploadAttempts.values()) a.nextAt = 0;
    if (!retriedPendingUploads) {
      retriedPendingUploads = true;
      // Speed test first (only if the cached result is >24h old), so the
      // first sweep already uses the measured rate and doesn't skew the test.
      runUploadSpeedTest(false).finally(() => retryPendingUploadsFromDisk());   // starts the in-session retry loop
    } else {
      sweepPendingUploads();
    }
  });
  ipcMain.on('session-connected', (event, { code, username }) => {
    currentSession = { code, username };
    console.log(`Session tracked in main: ${code} as ${username}`);
  });
  ipcMain.on('session-disconnected', () => { currentSession = null; });

  ipcMain.on('start-recording', async (event, { monitorIndex, windowTitle }) => {
    captureEpoch++;
    if (liveRestartTimer) { clearTimeout(liveRestartTimer); liveRestartTimer = null; }
    // Saves still queued from the previous recording would cut against this
    // recording's fresh buffer and audio — the wrong footage. Drop them
    // (recorded, and the user is told how many); a save already running
    // finishes on its own.
    dropQueuedSaves('a new recording started before they ran');
    // A queued mid-session restart would spawn a SECOND capture ~1.5s after
    // this one. ffmpegProcess is already null during that window, so the
    // kill below sees nothing to kill.
    if (midRestartTimer) { clearTimeout(midRestartTimer); midRestartTimer = null; }
    if (transientRecoveryTimer) { clearTimeout(transientRecoveryTimer); transientRecoveryTimer = null; }
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      const dying = ffmpegProcess;
      ffmpegProcess = null;
      await killFFmpegTree(dying);
    }

    captureWindowTitle = windowTitle || null;

    if (wgcCaptureMode) {
      wgcSourceId = windowTitle || null;
    }

    fullSessionAudioChunks = [];
    fullSessionMicChunks = [];
    fullSessionAudioIndex = 0;
    ['fs_audio_full.webm', 'fs_mic_full.webm'].forEach(f => {
      try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch(e) {}
    });

    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_') || f.startsWith('chunklist_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleaned: removed ${stale.length} stale files`);
    } catch (e) { console.log('Buffer clean skipped:', e.message); }

    stoppingIntentionally = false;
    midSessionRestarts = 0;
    transientCaptureRetries = 0;
    recordingSessionTag = Date.now();

    hlAudioPath = path.join(BUFFER_DIR, `hl_audio_${recordingSessionTag}.webm`);
    hlMicPath = path.join(BUFFER_DIR, `hl_mic_${recordingSessionTag}.webm`);
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;
    audioFirstChunkTime = null;
    micFirstChunkTime = null;
    peakLogBuffer = [];

    engineLadder = buildEngineLadder();
    engineIndex = 0;
    startRecording(monitorIndex);
  });

  ipcMain.on('stop-recording', async () => {
    captureEpoch++;
    if (liveRestartTimer) { clearTimeout(liveRestartTimer); liveRestartTimer = null; }
    if (midRestartTimer) { clearTimeout(midRestartTimer); midRestartTimer = null; }
    if (transientRecoveryTimer) { clearTimeout(transientRecoveryTimer); transientRecoveryTimer = null; }
    stopBufferReadyWatcher();
    stopPruneScheduler();        
    if (ffmpegProcess) {
      stoppingIntentionally = true;
      const dying = ffmpegProcess;
      ffmpegProcess = null;
      await killFFmpegTree(dying);
      console.log('Recording stopped');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-stopped');
      }
    }

    stopDiskWatcher();

    if (wgcCaptureMode) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wgc-stop-capture');
        mainWindow.webContents.send('recording-stopped');
      }
      setTimeout(() => wgcRetire('recording stopped'), 1500);
    }

    if (fullSessionMode) {
      setTimeout(() => archiveFullSession(), 1200);
      return;
    }

    // Highlight audio (and temp files) are torn down only once every queued
    // save has run — tearing down at once left queued clips without game
    // audio and deleted a running save's temp files. The tag check skips the
    // teardown if a new recording started meanwhile (it has its own audio).
    const stoppedTag = recordingSessionTag;
    const waiting = pendingSaveQueue.length + (pipelineBusy ? 1 : 0);
    if (waiting) console.log(`Recording stopped with ${waiting} save(s) still queued — finishing them first`);
    onSaveQueueIdle(() => {
      if (recordingSessionTag !== stoppedTag) return;
      hlAudioPath = null;
      hlMicPath = null;
      hlAudioChunkCount = 0;
      hlMicChunkCount = 0;
      try {
        const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
          f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_') || f.startsWith('chunklist_')
        );
        for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
        console.log(`Buffer cleared on stop: removed ${stale.length} files`);
      } catch (e) { console.log('Buffer clear on stop skipped:', e.message); }
    });
  });
   

  ipcMain.on('update-settings', (event, settings) => {
    let captureChanged = false;   // needs a capture restart to take effect (LIVE CAPTURE SETTINGS)
    let monitorChanged = false;
    const bufferMap = { '30': 3, '60': 6, '180': 18, '300': 30, '600': 60 };
    if (settings.bufferSeconds && bufferMap[settings.bufferSeconds]) {
      maxChunks = bufferMap[settings.bufferSeconds];
    }

    if (settings.fps && [30, 60].includes(settings.fps) && settings.fps !== recordFps) {
      recordFps = settings.fps;
      const prefs = readPrefsRaw();
      prefs.fps = recordFps;
      saveUserPreferences(prefs);
      console.log(`FPS set to: ${recordFps}`);
      captureChanged = true;
    }

    if (settings.resolution && settings.resolution in RESOLUTION_MAP && settings.resolution !== recordResolutionKey) {
      recordResolutionKey = settings.resolution;
      recordResolution = RESOLUTION_MAP[settings.resolution];
      const prefs = readPrefsRaw();
      prefs.resolution = recordResolutionKey;
      saveUserPreferences(prefs);
      console.log(`Resolution set to: ${recordResolutionKey}`);
      captureChanged = true;
    }

    if (typeof settings.monitor === 'number' && !Number.isNaN(settings.monitor) && settings.monitor !== savedMonitorIndex) {
      savedMonitorIndex = settings.monitor;
      const prefs = readPrefsRaw();
      prefs.monitorIndex = savedMonitorIndex;
      saveUserPreferences(prefs);
      console.log(`Monitor preference set to index ${savedMonitorIndex}`);
      monitorChanged = true;
    }

    if (typeof settings.hdr === 'boolean' && settings.hdr !== captureHdr) {
      captureHdr = settings.hdr;
      const prefs = readPrefsRaw();
      prefs.captureHdr = captureHdr;
      saveUserPreferences(prefs);
      console.log(`HDR capture fix ${captureHdr ? 'ENABLED' : 'disabled'}`);
      captureChanged = true;
    }

    if ('adapter' in settings) {
      const a = settings.adapter;
      captureAdapter = (a === null || a === '' || a === 'auto') ? null : parseInt(a, 10);
      if (Number.isNaN(captureAdapter)) captureAdapter = null;
      const prefs = readPrefsRaw();
      prefs.captureAdapter = captureAdapter;
      saveUserPreferences(prefs);
      console.log(`Capture adapter set to: ${captureAdapter === null ? 'auto' : captureAdapter}`);
      captureChanged = true;
    }

    if (settings.hotkey && starHotkey && settings.hotkey === starHotkey) {
      mainWindow.webContents.send('hotkey-error', `${settings.hotkey} is your star key.`);
    } else if (settings.hotkey && isValidHotkey(settings.hotkey) && settings.hotkey !== customHotkey) {
      const previousHotkey = customHotkey;
      const registered = bindHotkey('save', settings.hotkey, previousHotkey);   // see HOTKEYS THAT DON'T STEAL THE KEY
      if (registered) {
        customHotkey = settings.hotkey;
        const prefs = readPrefsRaw();
        prefs.hotkey = customHotkey;
        saveUserPreferences(prefs);
        console.log(`Hotkey set to: ${customHotkey}`);
        mainWindow.webContents.send('hotkey-updated', customHotkey);
      } else {
        mainWindow.webContents.send('hotkey-error', `Failed to register ${settings.hotkey}. Another app may be using it.`);
      }
    }

    // Star key (v0.1.87). null clears it; it can't be the highlight key.
    // Same register-or-roll-back as the highlight key above.
    if ('starHotkey' in settings) {
      const want = settings.starHotkey || null;
      if (want === null) {
        bindHotkey('star', null, starHotkey);
        starHotkey = null;
        starHotkeyRegistered = true;
        const prefs = readPrefsRaw();
        delete prefs.starHotkey;
        saveUserPreferences(prefs);
        console.log('Star key cleared');
        mainWindow.webContents.send('star-hotkey-updated', null);
      } else if (!isValidHotkey(want)) {
        mainWindow.webContents.send('star-hotkey-error', `${want} can't be used as a key.`);
      } else if (want === customHotkey) {
        mainWindow.webContents.send('star-hotkey-error', `${want} is your highlight key — pick a different star key.`);
      } else if (want !== starHotkey) {
        const previous = starHotkey;
        if (bindHotkey('star', want, previous)) {
          starHotkey = want;
          starHotkeyRegistered = true;
          const prefs = readPrefsRaw();
          prefs.starHotkey = starHotkey;
          saveUserPreferences(prefs);
          console.log(`Star key set to: ${starHotkey}`);
          mainWindow.webContents.send('star-hotkey-updated', starHotkey);
        } else {
          mainWindow.webContents.send('star-hotkey-error', `Failed to register ${want}. Another app may be using it.`);
        }
      }
    }

    // Apply capture changes while recording (LIVE CAPTURE SETTINGS).
    if (wgcCaptureMode) {
      if (captureChanged) applyWgcSettingsLive();
    } else if (ffmpegProcess && (captureChanged || (monitorChanged && savedMonitorIndex !== currentMonitor))) {
      scheduleLiveCaptureRestart(monitorChanged ? savedMonitorIndex : currentMonitor);
    }
  });

  // The session's clip length, from the renderer on join and whenever the
  // host changes it — sizes the buffer (effectiveMaxChunks).
  ipcMain.on('session-clip-duration', (event, ms) => {
    const v = Number(ms);
    sessionClipDurationMs = Number.isFinite(v) && v > 0 && v <= 30 * 60 * 1000 ? v : 0;
    console.log(`Session clip length: ${sessionClipDurationMs ? sessionClipDurationMs / 1000 + 's' : 'none'} — buffer ${effectiveMaxChunks() * CHUNK_SECONDS}s`);
  });

  ipcMain.on('audio-recording-started', (event, wallTime) => {
    audioFirstChunkTime = wallTime;
  });

  ipcMain.on('save-audio-chunk', (event, buffer) => {
    const buf = Buffer.from(buffer);

    if (hlAudioPath) {
      try {
        fs.appendFileSync(hlAudioPath, buf);
        hlAudioChunkCount++;
      } catch (e) { console.log('Highlight audio append failed:', e.message); }
    }

    if (fullSessionMode) {
      const audioPath = path.join(BUFFER_DIR, 'fs_audio_full.webm');
      try {
        fs.appendFileSync(audioPath, buf);
        if (fullSessionAudioChunks.length === 0) fullSessionAudioChunks.push(audioPath);
      } catch(e) { console.log('Full session audio append failed:', e.message); }
    }
  });


  ipcMain.on('mic-recording-started', (event, wallTime) => {
    micFirstChunkTime = wallTime;
  });

  ipcMain.on('save-mic-chunk', (event, buffer) => {
    const buf = Buffer.from(buffer);

    if (hlMicPath) {
      try {
        fs.appendFileSync(hlMicPath, buf);
        hlMicChunkCount++;
      } catch (e) { console.log('Highlight mic append failed:', e.message); }
    }

    if (fullSessionMode) {
      const micPath = path.join(BUFFER_DIR, 'fs_mic_full.webm');
      try {
        fs.appendFileSync(micPath, buf);
        if (fullSessionMicChunks.length === 0) fullSessionMicChunks.push(micPath);
      } catch(e) { console.log('Full session mic append failed:', e.message); }
    }
  });

  ipcMain.on('update-mic-settings', (event, settings) => {
    if (settings.volume !== undefined) micVolume = settings.volume;
    if (settings.muted !== undefined) micMuted = settings.muted;
  });

  // Auto-capture lock: renderer tells main when a server-authoritative
  // ACTIVE window opens/closes so a highlight extending up to 6 minutes
  // isn't pruned out from under itself.
  ipcMain.on('auto-capture-active', (event, active) => {
    autoCaptureLocked = !!active;
    console.log(`Auto-capture buffer lock: ${autoCaptureLocked ? 'ON (pruning suspended)' : 'OFF'}`);
    markFightSignal();   // Low Bandwidth Mode: hold/trickle videos until ~20s after the window
  });

  // --- Upload queue (📤 tab) ---
  ipcMain.handle('upload-queue-get', () => getQueueState());
  ipcMain.on('cancel-quit-wait', () => cancelQuitWait('user'));
  ipcMain.handle('upload-set-mode', (event, mode) => {
    if (!UPLOAD_MODES.includes(mode)) return getQueueState();
    uploadSettings.mode = mode;
    saveUploadSettings();
    console.log(`Upload mode set to ${mode} — Low Bandwidth ${lowBandwidthActive() ? 'ON' : 'off'}`);
    broadcastQueueState();
    sweepPendingUploads();   // turning it off releases anything held for a fight
    return getQueueState();
  });
  ipcMain.handle('upload-retest', async () => {
    await runUploadSpeedTest(true);
    return getQueueState();
  });
  // Host only: squadmates' clips that are synced but still uploading video.
  // Feeds the close-app notice. Renderer-supplied, display-only.
  ipcMain.on('squad-pending-uploads', (event, payload) => {
    const count = payload && Number.isFinite(payload.count) ? Math.max(0, Math.min(999, Math.floor(payload.count))) : 0;
    const names = (payload && Array.isArray(payload.names) ? payload.names : [])
      .filter(n => typeof n === 'string').map(n => n.slice(0, 32)).slice(0, 8);
    squadPending = { count, names: count > 0 ? names : [] };
  });

  let audioOutputDeviceId = 'default';
  ipcMain.on('update-audio-output', (event, { deviceId }) => {
    audioOutputDeviceId = deviceId || 'default';
    console.log(`Audio output capture device set to: ${audioOutputDeviceId}`);
  });

  ipcMain.on('get-monitors', (event) => {
    const screen = require('electron').screen;
    const displays = screen.getAllDisplays();
    const monitorList = displays.map((d, i) => ({
      index: i,
      width: Math.round(d.bounds.width * (d.scaleFactor || 1)),
      height: Math.round(d.bounds.height * (d.scaleFactor || 1)),
      x: d.bounds.x, y: d.bounds.y,
      primary: d.bounds.x === 0 && d.bounds.y === 0
    }));
    event.reply('monitors-list', monitorList);
  });

 ipcMain.on('set-full-session-mode', (event, enabled) => {
    fullSessionMode = !!enabled;
    const prefs = readPrefsRaw();
    prefs.fullSessionMode = enabled;
    saveUserPreferences(prefs);
    fullSessionMode = !!enabled;
    console.log(`Full Session Mode ${fullSessionMode ? 'ENABLED' : 'disabled'}`);
    event.reply('full-session-mode-set', fullSessionMode);
  });

  ipcMain.handle('get-full-session-mode', () => fullSessionMode);

  ipcMain.handle('set-user-pref', (event, key, value) => {
    const prefs = loadUserPreferences();
    prefs[key] = value;
    saveUserPreferences(prefs);
    if (key === 'gamepadButton') {
      gamepadPrefs.buttonIndex = (value === null || value === undefined) ? null : parseInt(value);
      gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
    }
    if (key === 'gamepadTriggerMode') {
      gamepadPrefs.triggerMode = value || 'double';
      gpState = { lastPressTime: 0, isHeld: false, holdStart: 0, fired: false };
    }
  });

  ipcMain.handle('get-user-pref', (event, key) => {
    const prefs = loadUserPreferences();
    return prefs[key] !== undefined ? prefs[key] : null;
  });

  ipcMain.handle('get-free-space-gb', () => {
    const free = getFreeBytes(getActiveStorageRoot());
    return free === null ? null : +(free / 1e9).toFixed(1);
  });

  ipcMain.handle('pick-fullsession-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Full Session Archive Location',
      defaultPath: fullSessionDir || CLIPS_DIR,
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      fullSessionDir = result.filePaths[0];
      const prefs = readPrefsRaw();
      prefs.fullSessionDir = fullSessionDir;
      saveUserPreferences(prefs);
      return { success: true, path: fullSessionDir };
    }
    return { success: false };
  });

  ipcMain.handle('get-fullsession-directory', () => fullSessionDir || getArchiveBaseDir());

  ipcMain.handle('clear-fullsession-directory', () => {
    fullSessionDir = null;
    const prefs = readPrefsRaw();
    delete prefs.fullSessionDir;
    saveUserPreferences(prefs);
    return { path: getArchiveBaseDir() };
  });

  // Renderer pulls the link once it's booted and knows its auth state.
  ipcMain.handle('consume-deep-link', () => {
    const link = pendingDeepLink;
    pendingDeepLink = null;
    return link;
  });

  ipcMain.handle('get-join-link', (event, code) => {
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    return clean.length >= 4 ? `https://peakabu.app/join/${clean}` : null;
  });

  // Nominal buffer size (maxChunks * CHUNK_SECONDS) is a LIE for the first
  // few minutes of a session and after any mid-session capture restart —
  // recordingStartTime resets and every older chunk stops matching the
  // birth-time filter in doSaveHighlight. Reporting the theoretical max
  // there is what lets the server hand out a window this client cannot
  // possibly fill, producing a short clip with a late startTimeUTC that
  // the web player faithfully renders as a desynced POV.
  ipcMain.handle('get-buffer-seconds', () => {
    const nominal = effectiveMaxChunks() * CHUNK_SECONDS;
    if (wgcCaptureMode) {
      const usable = wgcFiles.filter(f => f.startUTC && fs.existsSync(f.path));
      if (!usable.length) return 10;
      const oldest = Math.min(...usable.map(f => f.startUTC));
      return Math.max(10, Math.floor((Date.now() - oldest) / 1000));
    }
    if (!recordingStartTime) return 10;
    const sinceStart = Math.floor((Date.now() - recordingStartTime) / 1000);
    return Math.max(10, Math.min(nominal, sinceStart));
  });
  ipcMain.handle('get-current-hotkey', () => customHotkey);
  // A key another app has claimed still works through the key watcher.
  ipcMain.handle('get-hotkey-registered', () => startupHotkeyRegistered || !!keyWatcher);
  ipcMain.handle('get-star-hotkey', () => ({ key: starHotkey, registered: starHotkeyRegistered || !!keyWatcher }));

  // Star key, not connected to a session's server (see STARS).
  ipcMain.on('star-mark-local', (event, p) => {
    localStarMark(p && p.pressTs, !!(p && p.canCapture));
  });
  // Clip folders + Organize clips (see CLIP FOLDERS / ORGANIZE CLIPS).
  ipcMain.handle('get-clip-folder', (event, code) => {
    const key = folderLockKey(code);
    const lock = code ? liveFolderLock(key) : null;
    return lock ? clipFolderInfo(key, lock) : null;
  });
  ipcMain.handle('rename-clip-folder', (event, p) => renameClipFolder(p && p.code, p && p.name));
  ipcMain.handle('organize-plan', (event, p) => buildOrganizePlan(p && p.sessionGames));
  ipcMain.handle('organize-run', (event, p) => runOrganize(p && p.planId, p && p.games));
  ipcMain.handle('organize-undo', () => undoOrganize());
  ipcMain.handle('organize-status', () => organizeStatus());

  // A session's stars changed on the server (relayed by the renderer).
  ipcMain.on('stars-changed', (event, p) => {
    if (!p || !p.code || !Array.isArray(p.momentTs)) return;
    for (const ts of p.momentTs) {
      if (typeof ts === 'number' && isFinite(ts)) setMomentStarred(p.code, ts, !!p.starred, false);
    }
  });

  // ================================
  // CLEAN UNINSTALL
  // Wipes the buffer directory we know about (NSIS can't see a custom
  // storage path), then hands off to the real NSIS uninstaller. Saved
  // highlight videos and their .json sidecars are never touched.
  // ================================
  ipcMain.handle('run-uninstall', async () => {
    // Stop capture first so nothing holds a file handle open
    try { stopRecordingInternal(); } catch (e) {}

    const wiped = [];
    const tryWipe = (p, isDir) => {
      try {
        if (!p || !fs.existsSync(p)) return;
        if (isDir) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
        wiped.push(p);
      } catch (e) {
        console.log(`Uninstall cleanup skipped ${p}: ${e.message}`);
      }
    };

    tryWipe(BUFFER_DIR, true);            // active buffer (may be custom path)
    tryWipe(DEFAULT_BUFFER_DIR, true);    // default temp buffer
    tryWipe(path.join(os.tmpdir(), 'peakabu-ffmpeg.log'), false);
    try {
      fs.readdirSync(os.tmpdir())
        .filter(f => /^PeakAbu-Update-\d+\.exe$/i.test(f))
        .forEach(f => tryWipe(path.join(os.tmpdir(), f), false));
    } catch (e) {}

    console.log(`Uninstall pre-clean removed ${wiped.length} item(s)`);

    if (!app.isPackaged) {
      return { success: false, error: 'Uninstall is only available in the installed build (not dev mode).', wiped: wiped.length };
    }

    const installDir = path.dirname(process.execPath);
    const candidates = [
      'Uninstall Peak-Abu.exe',
      'Uninstall peak-abu.exe',
      'Uninstall.exe'
    ].map(c => path.join(installDir, c));
    const uninstaller = candidates.find(p => fs.existsSync(p));

    if (!uninstaller) {
      return { success: false, error: 'Uninstaller not found. Use Windows Settings > Apps to remove Peak-Abu.', wiped: wiped.length };
    }

    try {
      const { shell } = require('electron');
      await shell.openPath(uninstaller);
      setTimeout(() => app.quit(), 1500);
      return { success: true, wiped: wiped.length };
    } catch (err) {
      return { success: false, error: err.message, wiped: wiped.length };
    }
  });

  // ================================
  // WEB PLAYER — docked view or its own window
  // ================================
  ipcMain.handle('open-player', (event, payload) => {
    const code = payload && payload.code;
    const token = payload && payload.token;
    const username = payload && payload.username;

    // Sync: detect local clips for this session the server never got.
    // Fire-and-forget — opening the player doesn't wait on this; the
    // renderer gets the result over 'sync-scan-result' whenever it lands.
    runSyncScan(code).then((result) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-scan-result', result);
      }
    }).catch((e) => console.log('Sync scan failed:', e.message));

    if (playerWindowedMode) {
      closeDockedPlayer();
      openWindowedPlayer(code, token, username);
      return { mode: 'windowed' };
    }
    if (playerWindow && !playerWindow.isDestroyed()) {
      try { playerWindow.destroy(); } catch (e) {}
      playerWindow = null;
    }
    openDockedPlayer(code, token, username);
    return { mode: 'docked' };
  });

  ipcMain.handle('close-player', () => {
    closeAnyPlayer();
    return { success: true };
  });

  // Renderer-triggered upload of whatever's currently syncable for this
  // session. Re-scans right before uploading rather than trusting a list
  // the renderer may be holding stale (a clip could have uploaded through
  // the normal live path, or been deleted, since the last scan result).
  // Doesn't await runSyncUpload — progress streams over 'sync-progress'.
  // 📤 tab "⟲ Sync" — check every recent local session for missing clips.
  ipcMain.handle('sync-check-all', async () => {
    if (!authToken) return { error: 'login' };
    if (syncCheckRunning) return { error: 'busy' };
    syncCheckRunning = true;
    try { return await runSyncCheckAll(); }
    finally { syncCheckRunning = false; }
  });

  ipcMain.handle('sync-start', async (event, payload) => {
    const code = payload && payload.code;
    const scan = await runSyncScan(code);
    if (scan.state !== 'ok' || scan.syncable.length === 0) {
      return { started: false, reason: scan.state };
    }
    runSyncUpload(code, scan.syncable);
    return { started: true, count: scan.syncable.length };
  });

  // Live drag — fires on every pointermove while resizing. Cheap enough
  // over same-process IPC to just round-trip and let layoutPlayerView's
  // clamp be the single source of truth (renderer never has to guess it).
  ipcMain.on('resize-player-width', (event, desiredWidth) => {
    if (!playerView || !mainWindow || mainWindow.isDestroyed()) return;
    // The renderer's post-resize nudge can send 0/undefined if its cached
    // width was never populated. Treating that as a real request reset the
    // width to the 45% default via the `!playerDockedWidth` fallback — just
    // re-assert current geometry instead.
    if (typeof desiredWidth !== 'number' || !isFinite(desiredWidth) || desiredWidth <= 0) {
      layoutPlayerView();
      return;
    }
    // Always clamp against a FRESH read of content size, not a cached one —
    // this is what guarantees the value echoed back to the renderer matches
    // where the view is actually placed, even if the window changed size
    // (e.g. mid-maximize) between the last layout and this drag event.
    playerDockedWidth = desiredWidth;
    layoutPlayerView();
  });

  // Fires once on release — persists the chosen width so it survives restart.
  ipcMain.on('resize-player-width-commit', (event, desiredWidth) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (typeof desiredWidth !== 'number' || !isFinite(desiredWidth) || desiredWidth <= 0) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    playerDockedWidth = desiredWidth;
    layoutPlayerView();
    const prefs = readPrefsRaw();
    prefs.playerDockedWidth = playerDockedWidth;
    saveUserPreferences(prefs);
  });

  ipcMain.on('theme-push', (event, tokens) => {
    console.log('[theme-push] received', Object.keys(tokens));
    latestThemeTokens = tokens;
    pushThemeToPlayer();
  });

  ipcMain.handle('is-player-open', () =>
    !!playerView || !!(playerWindow && !playerWindow.isDestroyed()));


  ipcMain.handle('get-player-windowed-mode', () => playerWindowedMode);

  ipcMain.handle('set-player-windowed-mode', (event, enabled) => {
    // Docked mode needs room for client + player side by side; windowed
    // mode doesn't — let the client shrink like a normal app there.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setMinimumSize(playerWindowedMode ? 560 : 1020, 640);
    }
    const wasOpen = !!playerView || !!(playerWindow && !playerWindow.isDestroyed());
    let code = null, carryToken = null, carryUsername = null;
    if (playerView) {
      try {
        const u = new URL(playerView.webContents.getURL());
        code = u.searchParams.get('code');
        carryToken = u.searchParams.get('t');
        carryUsername = u.searchParams.get('u');
      } catch (e) {}
    } else if (playerWindow && !playerWindow.isDestroyed()) {
      try {
        const u = new URL(playerWindow.webContents.getURL());
        code = u.searchParams.get('code');
        carryToken = u.searchParams.get('t');
        carryUsername = u.searchParams.get('u');
      } catch (e) {}
    }

    playerWindowedMode = !!enabled;
    const prefs = readPrefsRaw();
    prefs.playerWindowedMode = playerWindowedMode;
    saveUserPreferences(prefs);
    console.log(`Web player mode: ${playerWindowedMode ? 'separate window' : 'docked'}`);

    // Move an already-open player into the newly chosen mode
    if (wasOpen) {
      closeAnyPlayer();
      if (playerWindowedMode) openWindowedPlayer(code, carryToken, carryUsername);
      else openDockedPlayer(code, carryToken, carryUsername);
    } else if (playerWindowedMode && mainWindow && !mainWindow.isDestroyed()) {
      // Nothing was open yet, but switching to windowed still needs to
      // clear any stale docked-UI state from an earlier session.
      mainWindow.webContents.send('player-docked', { docked: false, reservedRight: 0 });
    }
    return { windowed: playerWindowedMode };
  });

  // ================================
  // GAME DETECTION — best-effort label for session history
  // ================================
  ipcMain.handle('detect-game', () => detectGameNow());   // see CLIP FOLDERS

    // ================================
  // AI REEL — LOCAL CLIP DISCOVERY
  // Scans the storage folder for highlight sidecar JSONs and returns the
  // ones whose .mp4 is still on disk. This is what lets a reel be built
  // with zero downloads: clipId is the stable identity, sessionId matches
  // the session code, startTimeUTC is what the editor aligns on.
  // ================================
  ipcMain.handle('open-aireel-window', (event, params) => {
    openAiReelWindow(params || {});
    return { success: true };
  });

  ipcMain.handle('aireel-list-local-clips', (event, opts) => {
    const wantSession = opts && opts.sessionId ? String(opts.sessionId).toUpperCase() : null;
    const entries = listClipSidecars();   // the root and every clip folder (v0.1.87)

    const out = [];
    for (const jsonPath of entries) {
      const mp4Path = jsonPath.replace(/\.json$/i, '.mp4');
      if (!fs.existsSync(mp4Path)) continue;      // clip deleted, sidecar orphaned
      let meta;
      try { meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { continue; }
      if (!meta || !meta.clipId) continue;        // full-session archive sidecars have no clipId
      if (wantSession && String(meta.sessionId || '').toUpperCase() !== wantSession) continue;

      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(mp4Path).size; } catch (e) {}

      out.push({
        id: meta.clipId,
        path: mp4Path,
        fileName: path.basename(mp4Path),
        startTimeUTC: typeof meta.startTimeUTC === 'number' ? meta.startTimeUTC : null,
        durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
        sessionId: meta.sessionId || null,
        savedAt: typeof meta.saveTimeUTC === 'number' ? meta.saveTimeUTC : null,
        sizeBytes
      });
    }

    out.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    return out;
  });

  ipcMain.handle('aireel-reveal', (event, filePath) => {
    try {
      const { shell } = require('electron');
      if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // ================================
  // AI REEL — CLIP THUMBNAILS
  // Pulls a single frame via bundled FFmpeg so the picker shows something
  // more useful than a filename + date. Cached to disk by clipId so
  // re-opening the window or re-scanning doesn't re-decode video that
  // hasn't changed.
  // ================================
  const AIREEL_THUMB_DIR = path.join(os.tmpdir(), 'peakabu-aireel-thumbs');

  ipcMain.handle('aireel-get-thumbnail', async (event, { clipId, clipPath, durationMs }) => {
    if (!clipId || !clipPath || !fs.existsSync(clipPath)) return { ok: false };

    try { if (!fs.existsSync(AIREEL_THUMB_DIR)) fs.mkdirSync(AIREEL_THUMB_DIR, { recursive: true }); }
    catch (e) { return { ok: false, error: e.message }; }

    const cachePath = path.join(AIREEL_THUMB_DIR, `${clipId}.jpg`);
    if (fs.existsSync(cachePath)) {
      try {
        const data = fs.readFileSync(cachePath).toString('base64');
        return { ok: true, dataUrl: 'data:image/jpeg;base64,' + data };
      } catch (e) { /* fall through and regenerate */ }
    }

    // A couple seconds in rather than frame 0 — the very first frame of a
    // highlight is often still black or mid-transition.
    const seekSec = Math.min(2, Math.max(0, ((durationMs || 4000) / 1000) * 0.15));

    return new Promise((resolve) => {
      const args = [
        '-ss', String(seekSec.toFixed(2)), '-i', clipPath,
        '-frames:v', '1', '-vf', 'scale=160:-1',
        '-q:v', '4', '-y', cachePath
      ];
      const p = spawn(getFFmpegPath(), args, { windowsHide: true });
      if (p.pid) setBelowNormalPriority(p.pid);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch (e) {} }, 8000);

      p.on('close', () => {
        clearTimeout(timer);
        if (timedOut || !fs.existsSync(cachePath)) { resolve({ ok: false }); return; }
        try {
          const data = fs.readFileSync(cachePath).toString('base64');
          resolve({ ok: true, dataUrl: 'data:image/jpeg;base64,' + data });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
      p.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    });
  });

  // ================================
  // AI REEL — MONTHLY AI-CREDIT USAGE (read-only, informational)
  // Hits /account/aireel-usage on the server so the reel window can show
  // "X of Y left this month". Not tied to the local render pipeline below —
  // this is purely a display value pulled from the server's usage tracker.
  // Fails silently (returns {applicable:false}) on any network/auth issue,
  // matching the badge's own fail-silent behavior in the renderer.
  // ================================
  ipcMain.handle('aireel-get-usage', () => {
    return new Promise((resolve) => {
      if (!authToken) { resolve({ applicable: false }); return; }

      const req = https.request({
        protocol: 'https:', host: 'peakabu.app', port: 443,
        path: '/account/aireel-usage', method: 'GET',
        headers: { 'Authorization': 'Bearer ' + authToken }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) { resolve({ applicable: false }); return; }
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ applicable: false });
          }
        });
      });

      req.on('error', () => resolve({ applicable: false }));
      req.end();
    });
  });

  // ================================
  // AI REEL — LOCAL RENDER (Phase 2)
  // Analyzes + renders entirely on this PC using the heuristic editor
  // (no Anthropic API call yet — that's wired in once the org key is set
  // up). clips: [{id, username, path, startTimeUTC}]
  // ================================
  ipcMain.handle('aireel-generate', async (event, payload) => {
    const { clips, targetSec, game, styleNotes } = payload || {};
    if (!Array.isArray(clips) || clips.length === 0) {
      return { ok: false, error: 'No clips selected' };
    }
    const jobId = crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), 'peakabu-aireel-client', jobId);
    const outputPath = path.join(CLIPS_DIR, `ai-reel-${Date.now()}.mp4`);

    const result = await buildReelLocally({
      ffmpegPath: getFFmpegPath(),
      workDir, outputPath, clips, targetSec, game, styleNotes,
      threadCap: 4,
      onProgress: (p) => {
        if (aiReelWindow && !aiReelWindow.isDestroyed()) {
          aiReelWindow.webContents.send('aireel-progress', p);
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('aireel-progress', p);
        }
      }
    });

    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    return result;
  });
}


app.whenReady().then(async () => {
  const startupPrefs = loadUserPreferences();
  gamepadPrefs.buttonIndex = (startupPrefs.gamepadButton !== null && startupPrefs.gamepadButton !== undefined) ? parseInt(startupPrefs.gamepadButton) : null;
  gamepadPrefs.triggerMode = startupPrefs.gamepadTriggerMode || 'double';
  // Register the scheme at runtime so dev builds work too. Packaged builds
  // also get it from NSIS via the electron-builder "protocols" block.
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '.')]);
  }
  pendingDeepLink = extractDeepLink(process.argv);
  startXInputPoll();
  ensureFolders();
  sweepOrphanedFFmpeg();
  createWindow();
  startupHotkeyRegistered = globalShortcut.register(customHotkey, onHotkeyPressed);
  if (startupHotkeyRegistered) console.log(`${customHotkey} hotkey registered successfully`);
  else console.log(`WARNING: ${customHotkey} hotkey registration FAILED - another app may be using it`);
  if (starHotkey) {
    starHotkeyRegistered = starHotkey !== customHotkey && globalShortcut.register(starHotkey, onStarHotkeyPressed);
    console.log(starHotkeyRegistered ? `${starHotkey} star key registered` : `WARNING: star key ${starHotkey} registration FAILED`);
  }
  // Takes the keys over from globalShortcut once it's running, so they stop
  // being blocked in other apps (see HOTKEYS THAT DON'T STEAL THE KEY).
  startKeyWatcher();
  setTimeout(() => checkForUpdates(mainWindow), 3000);
});

let isCleaningUp = false;

app.on('before-quit', async (event) => {
  if (isCleaningUp) return;

  // Block quit while an upload is mid-flight. Previously this only ever
  // guarded the ffmpeg recording process — a highlight's form.submit()
  // (unrelated to that process) got cut off mid-stream by app.quit() below,
  // losing the clip. window-all-closed's app.quit() routes through this
  // same handler, so this covers "close the window" too, not just quit.
  // allowWindowClose: the close handler already asked (and the user chose
  // quit, or the wait finished) — don't ask a second time on the way out.
  if (pendingUploads.size > 0 && !quitRequested && !allowWindowClose) {
    event.preventDefault();

    const choice = askQuitWithPendingUploads();
    if (choice === 'quit') {
      console.log('User chose to quit anyway — remaining uploads stay in the retry manifest');
      app.exit(0);
      return;
    }
    if (choice === 'minimize') {
      console.log(`Quit cancelled → minimized — ${pendingUploads.size} queued upload(s) keep going`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
      return;
    }

    console.log(`Quit deferred — ${pendingUploads.size} upload(s) still in flight`);
    startQuitWait();
    return;
  }

  closeAnyPlayer();
  if (ffmpegProcess) {
    event.preventDefault();
    isCleaningUp = true;
    stoppingIntentionally = true;
    stopBufferReadyWatcher();
    stopXInputPoll();
    stopKeyWatcher();
    const dying = ffmpegProcess;
    ffmpegProcess = null;
    await killFFmpegTree(dying);
    globalShortcut.unregisterAll();
    app.quit();
  } else {
    if (wgcCaptureMode) wgcCleanupAll();
    stopBufferReadyWatcher();
    stopXInputPoll();
    stopKeyWatcher();
    globalShortcut.unregisterAll();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


function archiveFullSession() {
  if (!fullSessionMode) return;
  if (sessionArchiveActive) return;
  sessionArchiveActive = true;

  let chunks;
  try {
    chunks = fs.readdirSync(BUFFER_DIR)
      .filter(f => /^chunk_[\d_]+\.mp4$/.test(f))
      .map(f => ({ name: f, path: path.join(BUFFER_DIR, f), time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs }))
      .sort((a, b) => a.time - b.time);
  } catch (e) {
    console.log('Archive: could not read buffer dir:', e.message);
    sessionArchiveActive = false;
    return;
  }

  if (chunks.length === 0) {
    console.log('Archive: no chunks to archive');
    sessionArchiveActive = false;
    return;
  }

  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const lastSize = (() => { try { return fs.statSync(last.path).size; } catch(e) { return 0; } })();
    const minViableBytes = recordFps * CHUNK_SECONDS * 5000;
    if (lastSize < minViableBytes) {
      const dropped = chunks.pop();
      console.log(`Archive: dropping corrupt final chunk ${dropped.name} (${lastSize} bytes)`);
      try { fs.unlinkSync(dropped.path); } catch(e) {}
    } else {
      console.log(`Archive: keeping final chunk ${last.name} (${lastSize} bytes — looks complete)`);
    }
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const codePart = currentSession ? currentSession.code : 'solo';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const archiveDir = path.join(getArchiveBaseDir(), `${dateStr}_${codePart}`);

  try { fs.mkdirSync(archiveDir, { recursive: true }); }
  catch (e) { console.log('Archive: mkdir failed:', e.message); sessionArchiveActive = false; return; }

  const tempVideoPath = path.join(BUFFER_DIR, `fs_temp_video_${Date.now()}.mp4`);
  const outputPath = path.join(archiveDir, `full_session_${stamp}.mp4`);
  const videoListPath = path.join(BUFFER_DIR, `archive_list_${Date.now()}.txt`);
  const listContent = chunks.map(c => `file '${c.path.replace(/\\/g, '/')}'`).join('\n');

  try { fs.writeFileSync(videoListPath, listContent); }
  catch (e) { console.log('Archive: list write failed:', e.message); sessionArchiveActive = false; return; }

  console.log(`Archiving ${chunks.length} video chunks + ${fullSessionAudioChunks.length} audio chunks`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archive-started', { chunks: chunks.length });
  }

  const hasAudio = fullSessionAudioChunks.length > 0;
  const hasMic = fullSessionMicChunks.length > 0;

  const concatVideo = spawn(getFFmpegPath(), [
    '-f', 'concat', '-safe', '0', '-i', videoListPath,
    '-c', 'copy', '-y', hasAudio ? tempVideoPath : outputPath,
    ...(hasAudio ? [] : ['-movflags', '+faststart'])
  ], { windowsHide: true });

  concatVideo.stderr.on('data', d => {
    const line = d.toString();
    if (line.includes('error') || line.includes('Error')) console.log('Archive video concat:', line);
  });

  concatVideo.on('close', (videoCode) => {
    try { fs.unlinkSync(videoListPath); } catch(e) {}

    if (videoCode !== 0) {
      console.log('Archive: video concat failed');
      cleanup(chunks, false);
      return;
    }

    if (!hasAudio) {
      finalize(outputPath, chunks, null, null);
      return;
    }

    const { spawnSync } = require('child_process');
    let videoDurationSec = 0;

    try {
      const probe = spawnSync(getFFmpegPath().replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', tempVideoPath
      ], { windowsHide: true, encoding: 'utf8' });
      videoDurationSec = parseFloat((probe.stdout || '').trim()) || 0;
    } catch (e) { videoDurationSec = 0; }

    if (videoDurationSec <= 0) {
      try {
        const info = spawnSync(getFFmpegPath(), ['-i', tempVideoPath], {
          windowsHide: true, encoding: 'utf8'
        });
        const errOut = (info.stderr || '') + (info.stdout || '');
        const m = errOut.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          videoDurationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        }
      } catch (e) { videoDurationSec = 0; }
      if (videoDurationSec > 0) console.log('Archive: duration via ffmpeg stderr fallback');
    }

    console.log(`Archive: concatenated video duration = ${videoDurationSec.toFixed(3)}s`);

    const audioSrc = fullSessionAudioChunks[0];
    const tempAudioReenc = path.join(BUFFER_DIR, `fs_temp_audio_${Date.now()}.m4a`);
    const concatAudio = spawn(getFFmpegPath(), [
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', audioSrc,
      '-af', 'aresample=async=1000:first_pts=0',
      ...(videoDurationSec > 0 ? ['-t', videoDurationSec.toFixed(3)] : []),
      '-c:a', 'aac', '-b:a', '192k', '-y', tempAudioReenc
    ], { windowsHide: true });

    let audioErr = '';
    concatAudio.stderr.on('data', d => { audioErr += d.toString(); });

    concatAudio.on('close', (audioCode) => {
      console.log(`=== AUDIO RE-ENCODE exit code: ${audioCode} ===`);
      console.log(audioErr.slice(-2000));
      if (audioCode !== 0 || !fs.existsSync(tempAudioReenc)) {
        console.log('Archive: audio concat failed — saving video only');
        try { fs.renameSync(tempVideoPath, outputPath); } catch(e) {}
        finalize(outputPath, chunks, null, null);
        return;
      }

      const mergeArgs = ['-i', tempVideoPath, '-i', tempAudioReenc];
      let tempMicPath = null;

      if (hasMic) {
        tempMicPath = path.join(BUFFER_DIR, `fs_temp_mic_${Date.now()}.m4a`);
        const micResult = spawnSync(getFFmpegPath(), [
          '-fflags', '+genpts+igndts',
          '-err_detect', 'ignore_err',
          '-i', fullSessionMicChunks[0],
          '-af', 'aresample=async=1000:first_pts=0',
          ...(videoDurationSec > 0 ? ['-t', videoDurationSec.toFixed(3)] : []),
          '-c:a', 'aac', '-b:a', '192k', '-y', tempMicPath
        ], { windowsHide: true });
        if (micResult.status !== 0 || !fs.existsSync(tempMicPath)) {
          tempMicPath = null;
        }
      }

      if (tempMicPath) {
        const vol = (micVolume / 100).toFixed(2);
        mergeArgs.push('-i', tempMicPath);
        mergeArgs.push(
          '-map', '0:v:0',
          '-filter_complex',
          `[1:a]aresample=async=1000,volume=1.0[desk];[2:a]aresample=async=1000,volume=${vol}[mic];[desk][mic]amix=inputs=2:normalize=0[aout]`,
          '-map', '[aout]'
        );
      } else {
        mergeArgs.push('-map', '0:v:0', '-map', '1:a:0', '-af', 'aresample=async=1000');
      }

      mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart', '-y', outputPath);

      const merge = spawn(getFFmpegPath(), mergeArgs, { windowsHide: true });

      let mergeErr = '';
      merge.stderr.on('data', d => { mergeErr += d.toString(); });

      merge.on('close', (mergeCode) => {
        console.log(`=== ARCHIVE MERGE exit code: ${mergeCode} ===`);
        console.log('MERGE ARGS:', mergeArgs.join(' '));
        console.log(mergeErr.slice(-2500));

        [tempVideoPath, tempAudioReenc, tempMicPath].forEach(p => {
          if (p) try { fs.unlinkSync(p); } catch(e) {}
        });
        if (mergeCode === 0 && fs.existsSync(outputPath)) {
          finalize(outputPath, chunks, fullSessionAudioChunks, fullSessionMicChunks);
        } else {
          console.log('Archive: merge failed — leaving temp files for recovery');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('archive-failed', { path: BUFFER_DIR });
          }
          sessionArchiveActive = false;
        }
      });
    });
  });

  function finalize(outPath, videoChunks, audioFiles, micFiles) {
    const sizeMB = fs.existsSync(outPath)
      ? (fs.statSync(outPath).size / 1048576).toFixed(0) : '?';
    console.log(`Full session archived (${sizeMB}MB): ${outPath}`);

    const sidecar = {
      version: 1,
      archivedAt: now.toISOString(),
      sessionCode: currentSession ? currentSession.code : null,
      sessionStartUTC: recordingStartTime ? (recordingStartTime + clockOffset) : null,
      chunkSeconds: CHUNK_SECONDS,
      chunkCount: videoChunks.length,
      frameRate: recordFps,
      hasAudio: !!audioFiles && audioFiles.length > 0,
      hasMic: !!micFiles && micFiles.length > 0
    };
    try {
      fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify(sidecar, null, 2));
    } catch(e) {}

    for (const c of videoChunks) { try { fs.unlinkSync(c.path); } catch(e) {} }
    if (audioFiles) audioFiles.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
    if (micFiles) micFiles.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });

    fullSessionAudioChunks = [];
    fullSessionMicChunks = [];

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-complete', { path: outPath, sizeMB });
    }
    sessionArchiveActive = false;
  }

  function cleanup(videoChunks, deleteChunks) {
    if (deleteChunks) for (const c of videoChunks) { try { fs.unlinkSync(c.path); } catch(e) {} }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-failed', { path: BUFFER_DIR });
    }
    sessionArchiveActive = false;
  }
}

  

function stopRecordingInternal() {
  captureEpoch++;
  if (liveRestartTimer) { clearTimeout(liveRestartTimer); liveRestartTimer = null; }
  stopBufferReadyWatcher();
  stopPruneScheduler();
  stopDiskWatcher();

  const wasRecording = !!ffmpegProcess;

  if (ffmpegProcess) {
    stoppingIntentionally = true;
    ffmpegProcess.kill();
    ffmpegProcess = null;
    console.log('Recording stopped');
  }

  if (wgcCaptureMode) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wgc-stop-capture');
    }
    setTimeout(() => wgcCleanupAll(), 1500);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-stopped');
  }

  if (wasRecording && fullSessionMode) {
    setTimeout(() => archiveFullSession(), 1200);
  }
}