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
  playerView.webContents.loadURL(playerUrlFor(code, token, username));
  layoutPlayerView();
  // The player view is a separate WebContents from mainWindow — the
  // devtools-on-launch line up top never covers it. Open its own devtools
  // in dev builds so player-side JS errors (comments, playback) are
  // actually visible instead of silently swallowed.
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
  // Guarantee any leftover docked-mode UI (drag handle, close button) is
  // cleared the moment we go windowed, even if nothing was docked this
  // session — this is what was leaving a stale close button on screen.
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

function releaseSavePipeline() {
  if (!pipelineBusy) return; // already released, avoid double-drain
  pipelineBusy = false;
  wgcSaveInFlight = false;
  if (pendingSaveQueue.length > 0) {
    const next = pendingSaveQueue.shift();
    console.log(`Save pipeline free — starting queued ${next.triggerSource || 'manual'} save`);
    doSaveHighlight(next.saveTimeUTC, next.clipChunks, next.durationMs, next.coordinatedTs, 0, next.triggerSource);
  }
}
let wgcMidSessionRestarts = 0;
const WGC_MAX_RESTARTS = 3;

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

let engineLadder = [];
let engineIndex = 0;
let stoppingIntentionally = false;
let midSessionRestarts = 0;
let midRestartTimer = null;
const MAX_MID_SESSION_RESTARTS = 3;

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

function onHotkeyPressed() {
  console.log(`${customHotkey} pressed — routing to renderer save path`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('hotkey-save-pressed');
  } else {
    saveHighlight();
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

function getPreciseUTC() { return Date.now() + clockOffset; }

function pruneOldChunks() {
  if (fullSessionMode) return;
  if (autoCaptureLocked) return; // an auto-capture window may be open — don't evict chunks it still needs
  if (extractionInFlight) return;    // don't stat/unlink chunks an extract is reading
  const files = fs.readdirSync(BUFFER_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BUFFER_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  while (files.length > maxChunks) {
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

  const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', bitrate];
  const x264Args  = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];

  const segmentArgs = [
    '-g', fpsStr, '-keyint_min', fpsStr,
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-an',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
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
  const gdiScale = recordResolution ? ['-vf', `scale=-2:${recordResolution.height}`] : [];

  switch (engine) {
    case 'dda-nvenc':
      return [...ddaInput(false), ...nvencArgs, ...segmentArgs];
    case 'dda-nvenc-vf':
      return [...ddaInput(false), '-vf', ddaCpuVf, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-nvenc':
      return [...ddaInput(true), '-vf', hdrVf, ...nvencArgs, ...segmentArgs];
    case 'dda-hdr-x264':
      return [...ddaInput(true), '-vf', hdrVf, ...x264Args, ...segmentArgs];
    case 'dda-x264':
      return [...ddaInput(false), '-vf', ddaCpuVf, ...x264Args, ...segmentArgs];
    case 'gdi-nvenc':
      return [...gdiInput, ...gdiScale, ...nvencArgs, ...segmentArgs];
    case 'gdi-x264':
    default:
      return [...gdiInput, ...gdiScale, ...x264Args, '-pix_fmt', 'yuv420p', ...segmentArgs];
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
  const clipDurationSec = maxChunks * CHUNK_SECONDS;
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

function wgcCleanupOldFiles() {
  if (autoCaptureLocked) return; // same reasoning as pruneOldChunks
  while (wgcFiles.length > 2) {
    const old = wgcFiles.shift();
    if (wgcFileStreams[old.fileId]) {
      wgcFileStreams[old.fileId].end();
      delete wgcFileStreams[old.fileId];
    }
    try { fs.unlinkSync(old.path); } catch (e) {}
    console.log(`WGC buffer file deleted: ${old.fileId}`);
  }
}

function wgcStartRolloverSchedule() {
  wgcStopRolloverSchedule();
  const spanMs = getWgcSpanSeconds() * 1000;
  wgcRolloverTimer = setInterval(() => {
    if (wgcSaveInFlight) {
      console.log('WGC rollover deferred — save in flight');
      return;
    }
    const newFileId = `${wgcFileTag()}_${Date.now() % 100000}`;
    wgcStartNewFile(newFileId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('wgc-rollover-request', { newFileId });
    }
    setTimeout(() => wgcCleanupOldFiles(), 2000);
  }, spanMs - 1000);
  console.log(`WGC rollover schedule started: every ${getWgcSpanSeconds()}s`);
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
  wgcMidSessionRestarts = 0;
  console.log('WGC buffer cleaned up');
}

function wgcFindCoveringFiles(startUTC, endUTC) {
  const candidates = wgcFiles.filter(f => f.startUTC && fs.existsSync(f.path));
  if (candidates.length === 0) return null;

  // Oldest first
  candidates.sort((a, b) => a.startUTC - b.startUTC);
  const newest = candidates[candidates.length - 1];

  // Window fully inside the newest file → single extract from it.
  // (Previously this walked oldest-first and always matched the OLD file,
  // extracting at an offset past its content — frozen-frame/black clips
  // on every save after the first rollover.)
  if (newest.startUTC <= startUTC) {
    return { mode: 'single', files: [newest] };
  }

  // Window starts before the newest file began → straddle: tail of the
  // previous file + head of the newest.
  if (candidates.length >= 2) {
    const older = candidates[candidates.length - 2];
    if (older.startUTC <= startUTC) {
      return { mode: 'straddle', files: [older, newest] };
    }
  }

  // Best effort
  return { mode: 'single', files: [newest] };
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
let lowSpeedStreak = 0;

function parseCaptureHealth(text, engine) {
  const speedMatch = text.match(/speed=\s*([\d.]+)x/);
  const dropMatch  = text.match(/drop=\s*(\d+)/);
  const fpsMatch   = text.match(/fps=\s*([\d.]+)/);
  if (!speedMatch && !dropMatch) return;

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

  if (ffmpegProcess.pid) setBelowNormalPriority(ffmpegProcess.pid);

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
  lastHighlightBoundary = 0;
  lastDropCount = 0;
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
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`FFmpeg [${engine}] stopped with code`, code);
    if (stoppingIntentionally) return;

    const ranForMs = Date.now() - spawnStartTime;
    const earlyFailure = code !== 0 && ranForMs < 6000;

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

// A manual save's window ends at saveTime + 10% of duration, which usually
// lands inside the chunk FFmpeg is still writing — and the extractor can
// only read CLOSED chunks. Waiting a flat 10% therefore drops that tail,
// up to a full segment. Compute when the covering chunk actually closes,
// off real birth times on disk rather than assumed boundaries.
function computeManualPostDelay(saveTimeUTC, durationMs) {
  const minPost = Math.ceil(durationMs * 0.1);
  const maxPost = (CHUNK_SECONDS * 1000) + 1500;
  try {
    const births = fs.readdirSync(BUFFER_DIR)
      .filter(f => f.startsWith('chunk_' + recordingSessionTag + '_') && f.endsWith('.mp4'))
      .map(f => fs.statSync(path.join(BUFFER_DIR, f)).birthtimeMs)
      .sort((a, b) => a - b);
    if (!births.length) return minPost;

    const newestBirth = births[births.length - 1];
    const windowEndLocal = (saveTimeUTC - clockOffset) + minPost;

    let closeAt = newestBirth + (CHUNK_SECONDS * 1000);
    while (closeAt < windowEndLocal) closeAt += CHUNK_SECONDS * 1000;

    return Math.max(minPost, Math.min(maxPost, (closeAt - Date.now()) + 1500));
  } catch (e) {
    return minPost;
  }
}

// Computes how long a manual save must wait for the chunk covering its
// window end to finish writing. Derived from real chunk birth times on
// disk rather than recordingStartTime — FFmpeg's first segment doesn't
// begin exactly at spawn, so assumed boundaries drift from actual ones.
function computeManualPostDelay(saveTimeUTC, durationMs) {
  const minPost = Math.ceil(durationMs * 0.1);
  const maxPost = (CHUNK_SECONDS * 1000) + 1500;
  try {
    const births = fs.readdirSync(BUFFER_DIR)
      .filter(f => f.startsWith('chunk_' + recordingSessionTag + '_') && f.endsWith('.mp4'))
      .map(f => fs.statSync(path.join(BUFFER_DIR, f)).birthtimeMs)
      .sort((a, b) => a - b);
    if (!births.length) return minPost;

    const newestBirth = births[births.length - 1];
    const windowEndLocal = (saveTimeUTC - clockOffset) + minPost;

    let closeAt = newestBirth + (CHUNK_SECONDS * 1000);
    while (closeAt < windowEndLocal) closeAt += CHUNK_SECONDS * 1000;

    return Math.max(minPost, Math.min(maxPost, (closeAt - Date.now()) + 1500));
  } catch (e) {
    return minPost;
  }
}


function saveHighlight(coordinatedTimestamp = null, clipDurationMs = null, triggerSource = null) {
  const duration = clipDurationMs || 30000;
  const clipChunks = Math.ceil(duration / (CHUNK_SECONDS * 1000));
  const saveTimeUTC = coordinatedTimestamp || getPreciseUTC();
  // Both paths wait for the chunk covering the window end to close — the
  // extractor can only read CLOSED chunks, and a flat 10% post-roll almost
  // always ends mid-segment, silently dropping that tail. Auto always waits
  // a full segment; manual waits only as long as it actually needs to.
  const postDelay = (triggerSource === 'auto')
    ? (CHUNK_SECONDS * 1000) + 1500
    : computeManualPostDelay(saveTimeUTC, duration);

  if (postDelay > 500) {
    console.log(`Post-capture: waiting ${postDelay}ms for remaining footage (${(duration / 1000)}s clip, ${clipChunks} chunks)...`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('post-capture-started', { postDelay });
    }
    setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp, 0, triggerSource), postDelay);
  } else {
    doSaveHighlight(saveTimeUTC, clipChunks, duration, coordinatedTimestamp, 0, triggerSource);
  }
}

function doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs = null, retryCount = 0, triggerSource = null) {
  if (retryCount === 0) {
    if (pipelineBusy) {
      console.log(`Save pipeline busy — queuing ${triggerSource || 'manual'} save`);
      pendingSaveQueue.push({ saveTimeUTC, clipChunks, durationMs, coordinatedTs, triggerSource });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('save-queued', { triggerSource: triggerSource || 'manual' });
      }
      return;
    }
    pipelineBusy = true;
  }
  if (wgcCaptureMode && wgcFiles.length > 0) {
    wgcSaveInFlight = true;

    const durationSec = durationMs / 1000;
    // Manual anchors a point-in-time button press: 90% before, 10% after.
    // Auto's "moment" is already the END of a known start-to-end window —
    // running the same split computes a start 10% INTO the real action.
    // Auto gets its own math: anchor the exact detected span, no split.
    const windowStartLocal = triggerSource === 'auto'
      ? (saveTimeUTC - clockOffset) - durationMs
      : (saveTimeUTC - clockOffset) - (0.9 * durationMs);
    const windowEndLocal = triggerSource === 'auto'
      ? (saveTimeUTC - clockOffset)
      : (saveTimeUTC - clockOffset) + (0.1 * durationMs);

    const covering = wgcFindCoveringFiles(windowStartLocal, windowEndLocal);
    if (!covering) {
      console.log(`WGC save: no covering buffer files, retry=${retryCount}`);
      if (retryCount < 4) {
        if (retryCount === 0 && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('post-capture-started', { postDelay: 3000 });
        }
        setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource), 3000);
        return;
      }
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Window capture buffer not ready yet');
      }
      return;
    }

    const timestamp = new Date(saveTimeUTC).toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
    const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

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
      sessionId: currentSession ? currentSession.code : null,
      coordinated_timestamp: coordinatedTs || null
    };

    const encoderArgs = useCpuEncoder
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
      : ['-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v',
         recordResolution ? (recordResolution.height <= 480 ? '3M' : '5M') : '8M'];

    function wgcExtractFail(msg) {
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

      const extract = spawnFFmpegLow([
        '-fflags', '+genpts+igndts',
        '-i', file.path,
        '-ss', ssOffset.toFixed(3),
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
        '-i', older.path,
        '-ss', olderSs.toFixed(3),
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

  const allVideoFiles = fs.readdirSync(BUFFER_DIR)
    // Match the CURRENT session tag only. The birth-time filter below can't
    // separate two captures that started ~2s apart, which is how a chunk
    // still being written by an orphaned process ended up in a concat
    // filelist ("moov atom not found" -> Failed to save highlight).
    .filter(f => f.startsWith('chunk_' + recordingSessionTag + '_') && f.endsWith('.mp4'))
    .map(f => {
      const st = fs.statSync(path.join(BUFFER_DIR, f));
      return {
        name: f, path: path.join(BUFFER_DIR, f),
        time: st.mtimeMs,
        birth: st.birthtimeMs,
        size: st.size
      };
    })
    .filter(f => f.size > 100000)
    .sort((a, b) => a.birth - b.birth);

  // Skip the chunk FFmpeg is still writing into (mtime within the last
  // ~1.2s). Everything older is closed and safe to read.
  const settledCutoff = Date.now() - 1200;
  const readable = allVideoFiles.filter(f => f.time <= settledCutoff && f.birth >= recordingStartTime - 2000);

  // A chunk covers [birth, birth + CHUNK_SECONDS]. Keep any that overlaps
  // the requested window at all.
  const chunkSpanMs = CHUNK_SECONDS * 1000;
  const videoFiles = readable.filter(f => {
    const chunkStart = f.birth;
    const chunkEnd = Math.max(f.time, f.birth + chunkSpanMs);
    return chunkEnd >= windowStartLocal && chunkStart <= windowEndLocal;
  });

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
      setTimeout(() => doSaveHighlight(saveTimeUTC, clipChunks, durationMs, coordinatedTs, retryCount + 1, triggerSource), 3000);
      return;
    }

    console.log('No covering chunks after retries');
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
  const availableStart = firstChunk.birth;
  const availableEnd = Math.max(lastChunk.time, lastChunk.birth + chunkSpanMs);

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
      `buffer held ${((effEnd - effStart) / 1000).toFixed(1)}s — lost ${(clampedMs / 1000).toFixed(1)}s off the start`);
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

  // Capture writes a keyframe every 1.000s (-g fps -keyint_min fps) and every
  // chunk is exactly 10.000s, so flooring the offset lands dead on a keyframe
  // in the concatenated file. That lets STEP 2 be a stream copy instead of a
  // full NVENC re-encode — no second encoder session fighting live capture.
  // Cost: up to 1s of extra footage on the head. The web player aligns POVs
  // purely on metadata.startTimeUTC, so sync stays exact as long as we report
  // the REAL first frame (realStart), not the requested one (effStart).
  const alignedOffsetSec = Math.floor(trimOffsetSec);
  const headExtraSec = trimOffsetSec - alignedOffsetSec;
  const realStart = effStart - (headExtraSec * 1000);
  const copyDurationSec = trimDurationSec + headExtraSec;

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
  const outputPath = path.join(CLIPS_DIR, `highlight-${timestamp}.mp4`);
  const metadataPath = path.join(CLIPS_DIR, `highlight-${timestamp}.json`);

  const realDurationMs = Math.round(copyDurationSec * 1000);
  const metadata = {
    clipId: crypto.randomUUID(),
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
    userId: null,
    sessionId: currentSession ? currentSession.code : null,
    coordinated_timestamp: coordinatedTs || null
  };

  const tempId = Date.now();
  const videoListPath = path.join(BUFFER_DIR, `filelist_${tempId}.txt`);
  const tempConcatPath = path.join(BUFFER_DIR, `temp_concat_${tempId}.mp4`);
  const tempVideoPath = path.join(BUFFER_DIR, `temp_video_${tempId}.mp4`);
  const tempAudioPath = path.join(BUFFER_DIR, `temp_audio_${tempId}.m4a`);
  const tempMicPath = hasMic ? path.join(BUFFER_DIR, `temp_mic_${tempId}.m4a`) : null;

  fs.writeFileSync(videoListPath, videoFiles.map(f => `file '${f.path.replace(/\\/g, '/')}'`).join('\n'));

  // Audio offsets now key off the TRIMMED video start (effStart), not chunk
  // index math — the old `firstChunkNum * CHUNK_SECONDS` calculation assumed
  // the clip began exactly on a chunk boundary, which trimming breaks.
  const clipSpanSec = copyDurationSec + 1.0;
  const audioDeltaSec = audioFirstChunkTime ? (realStart - audioFirstChunkTime) / 1000 : 0;
  const audioSkipSec = Math.max(0, audioDeltaSec);
  const audioDelaySec = Math.max(0, -audioDeltaSec);
  const micDeltaSec = micFirstChunkTime ? (realStart - micFirstChunkTime) / 1000 : 0;
  const micSkipSec = Math.max(0, micDeltaSec);
  const micDelaySec = Math.max(0, -micDeltaSec);

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
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    console.log('Highlight saved to', outputPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-saved', outputPath);
    }
    releaseSavePipeline();
    uploadHighlight(outputPath, metadataPath);
  }

  function finishVideoOnly() {
    console.log('Audio unavailable/merge failed — saving video only');
    try {
      fs.copyFileSync(tempVideoPath, outputPath);
      cleanupTemps();
      finishSuccess();
    } catch (e) {
      cleanupTemps();
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
      releaseSavePipeline();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('highlight-error', 'Failed to concat video');
      }
      return;
    }

    // STEP 2: trim to the exact window. This is the step that lets clip
    // length match the real ACTIVE window instead of snapping to 10s.
    const trim = spawnFFmpegLow([
      '-threads', '2',
      '-ss', alignedOffsetSec.toFixed(3),
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

        mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
          '-movflags', '+faststart', '-shortest', '-y', outputPath);

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
  });
}

function wgcFinishSave(videoOnlyPath, metadataPath, metadata, durationMs, clipVideoStartMs) {
  const hasAudio = !!(hlAudioPath && hlAudioChunkCount > 0 && fs.existsSync(hlAudioPath));
  const hasMic = !!(hlMicPath && hlMicChunkCount > 0 && !micMuted && fs.existsSync(hlMicPath));

  function finish(finalPath) {
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    console.log('WGC highlight saved to', finalPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('highlight-saved', finalPath);
    }
    releaseSavePipeline();
    uploadHighlight(finalPath, metadataPath);
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

      mergeArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', '-y', tempMerged);

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

function uploadHighlight(videoPath, metadataPath) {
  if (!currentSession) { console.log('No active session, skipping upload'); return; }

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
    doUploadHighlight(videoPath, metadataPath);
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
    doUploadHighlight(videoPath, metadataPath);
  });
}

// The actual upload. Split out of uploadHighlight so the ffprobe empty-clip
// gate above can invoke it from a callback once the clip is confirmed real
// (or the probe failed open). Body is the original upload logic verbatim.
function doUploadHighlight(videoPath, metadataPath) {
  console.log(`Uploading highlight to session ${currentSession.code}...`);
  mainWindow.webContents.send('upload-progress', 0);

  const form = new FormData();
  form.append('video', fs.createReadStream(videoPath), {
    filename: path.basename(videoPath), contentType: 'video/mp4'
  });
  if (metadataPath && fs.existsSync(metadataPath)) {
    form.append('metadata', fs.createReadStream(metadataPath), {
      filename: path.basename(metadataPath), contentType: 'application/json'
    });
  }

  form.submit({
    protocol: 'https:', host: 'peakabu.app', port: 443,
    path: `/sessions/${currentSession.code}/upload`, method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken }
  }, (err, res) => {
    if (err) {
      console.log('Upload connection error:', err.message);
      mainWindow.webContents.send('upload-progress', -1);
      mainWindow.webContents.send('upload-error', 'Could not reach server');
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
          mainWindow.webContents.send('upload-progress', 100);
          mainWindow.webContents.send('upload-complete', result.uploadId);
        } else {
          mainWindow.webContents.send('upload-progress', -1);
          mainWindow.webContents.send('upload-error', result.error);
        }
      } catch (parseErr) {
        mainWindow.webContents.send('upload-progress', -1);
        mainWindow.webContents.send('upload-error', 'Server returned invalid response');
      }
      res.resume();
    });
  });
}

app.commandLine.appendSwitch('enable-features', 'WebRtcAllowInputVolumeAdjustment');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 840,
    minWidth: 560, minHeight: 640,
    show: false,                 // avoid the un-maximized flash on launch
    backgroundColor: '#0a1611',
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, experimentalFeatures: true
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
      wgcCleanupAll();
      wgcCaptureMode = false;
      stoppingIntentionally = false;
      midSessionRestarts = 0;
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

  ipcMain.on('auth-token-updated', (event, token) => { authToken = token; });
  ipcMain.on('session-connected', (event, { code, username }) => {
    currentSession = { code, username };
    console.log(`Session tracked in main: ${code} as ${username}`);
  });
  ipcMain.on('session-disconnected', () => { currentSession = null; });

  ipcMain.on('start-recording', async (event, { monitorIndex, windowTitle }) => {
    // A queued mid-session restart would spawn a SECOND capture ~1.5s after
    // this one. ffmpegProcess is already null during that window, so the
    // kill below sees nothing to kill.
    if (midRestartTimer) { clearTimeout(midRestartTimer); midRestartTimer = null; }
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
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleaned: removed ${stale.length} stale files`);
    } catch (e) { console.log('Buffer clean skipped:', e.message); }

    stoppingIntentionally = false;
    midSessionRestarts = 0;
    recordingSessionTag = Date.now();

    hlAudioPath = path.join(BUFFER_DIR, `hl_audio_${recordingSessionTag}.webm`);
    hlMicPath = path.join(BUFFER_DIR, `hl_mic_${recordingSessionTag}.webm`);
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;
    audioFirstChunkTime = null;
    micFirstChunkTime = null;

    engineLadder = buildEngineLadder();
    engineIndex = 0;
    startRecording(monitorIndex);
  });

  ipcMain.on('stop-recording', async () => {
    if (midRestartTimer) { clearTimeout(midRestartTimer); midRestartTimer = null; }
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
      setTimeout(() => wgcCleanupAll(), 1500);
    }

    if (fullSessionMode) {
      setTimeout(() => archiveFullSession(), 1200);
      return;
    }

    hlAudioPath = null;
    hlMicPath = null;
    hlAudioChunkCount = 0;
    hlMicChunkCount = 0;
    try {
      const stale = fs.readdirSync(BUFFER_DIR).filter(f =>
        f.endsWith('.mp4') || f.startsWith('hl_audio_') || f.startsWith('hl_mic_')
      );
      for (const f of stale) { try { fs.unlinkSync(path.join(BUFFER_DIR, f)); } catch (e) {} }
      console.log(`Buffer cleared on stop: removed ${stale.length} files`);
    } catch (e) { console.log('Buffer clear on stop skipped:', e.message); }
  });
   

  ipcMain.on('update-settings', (event, settings) => {
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
    }

    if (settings.resolution && settings.resolution in RESOLUTION_MAP && settings.resolution !== recordResolutionKey) {
      recordResolutionKey = settings.resolution;
      recordResolution = RESOLUTION_MAP[settings.resolution];
      const prefs = readPrefsRaw();
      prefs.resolution = recordResolutionKey;
      saveUserPreferences(prefs);
      console.log(`Resolution set to: ${recordResolutionKey}`);
    }

    if (typeof settings.monitor === 'number' && !Number.isNaN(settings.monitor) && settings.monitor !== savedMonitorIndex) {
      savedMonitorIndex = settings.monitor;
      const prefs = readPrefsRaw();
      prefs.monitorIndex = savedMonitorIndex;
      saveUserPreferences(prefs);
      console.log(`Monitor preference set to index ${savedMonitorIndex}`);
    }

    if (typeof settings.hdr === 'boolean' && settings.hdr !== captureHdr) {
      captureHdr = settings.hdr;
      const prefs = readPrefsRaw();
      prefs.captureHdr = captureHdr;
      saveUserPreferences(prefs);
      console.log(`HDR capture fix ${captureHdr ? 'ENABLED' : 'disabled'}`);
    }

    if ('adapter' in settings) {
      const a = settings.adapter;
      captureAdapter = (a === null || a === '' || a === 'auto') ? null : parseInt(a, 10);
      if (Number.isNaN(captureAdapter)) captureAdapter = null;
      const prefs = readPrefsRaw();
      prefs.captureAdapter = captureAdapter;
      saveUserPreferences(prefs);
      console.log(`Capture adapter set to: ${captureAdapter === null ? 'auto' : captureAdapter}`);
    }

    if (settings.hotkey && isValidHotkey(settings.hotkey) && settings.hotkey !== customHotkey) {
      const previousHotkey = customHotkey;
      if (previousHotkey) globalShortcut.unregister(previousHotkey);
      const registered = globalShortcut.register(settings.hotkey, onHotkeyPressed);
      if (registered) {
        customHotkey = settings.hotkey;
        const prefs = readPrefsRaw();
        prefs.hotkey = customHotkey;
        saveUserPreferences(prefs);
        console.log(`Hotkey set to: ${customHotkey}`);
        mainWindow.webContents.send('hotkey-updated', customHotkey);
      } else {
        if (previousHotkey) globalShortcut.register(previousHotkey, onHotkeyPressed);
        mainWindow.webContents.send('hotkey-error', `Failed to register ${settings.hotkey}. Another app may be using it.`);
      }
    }
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
    const nominal = maxChunks * CHUNK_SECONDS;
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
  ipcMain.handle('get-hotkey-registered', () => startupHotkeyRegistered);

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
  ipcMain.handle('detect-game', async () => {
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
  });

  // ================================
  // AI REEL — LOCAL RENDER (Phase 2)
  // Analyzes + renders entirely on this PC using the heuristic editor
  // (no Anthropic API call yet — that's wired in once the org key is set
  // up). clips: [{id, username, path, startTimeUTC}]
  // ================================
  ipcMain.handle('aireel-generate', async (event, payload) => {
    const { clips, targetSec, game, styleNotes } = payload || {};
    const jobId = crypto.randomUUID();
    const workDir = path.join(os.tmpdir(), 'peakabu-aireel-client', jobId);
    const outputPath = path.join(CLIPS_DIR, `ai-reel-${Date.now()}.mp4`);

    const result = await buildReelLocally({
      ffmpegPath: getFFmpegPath(),
      workDir, outputPath, clips, targetSec, game, styleNotes,
      threadCap: 4,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
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
  setTimeout(() => checkForUpdates(mainWindow), 3000);
});

let isCleaningUp = false;

app.on('before-quit', async (event) => {
  if (isCleaningUp) return;
  closeAnyPlayer();
  if (ffmpegProcess) {
    event.preventDefault();
    isCleaningUp = true;
    stoppingIntentionally = true;
    stopBufferReadyWatcher();
    stopXInputPoll();
    const dying = ffmpegProcess;
    ffmpegProcess = null;
    await killFFmpegTree(dying);
    globalShortcut.unregisterAll();
    app.quit();
  } else {
    if (wgcCaptureMode) wgcCleanupAll();
    stopBufferReadyWatcher();
    stopXInputPoll();
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