
      const { ipcRenderer, clipboard, shell } = require('electron');
      const io = require('socket.io-client');

      window.openPatreon = function() {
        shell.openExternal('https://www.patreon.com/16368967/join');
      };

      // State
      window.mediaRecorder = null;
      window.socket = null;
      window.currentSessionCode = null;
      window.capturingHotkey = false;
      window.currentHotkey = 'F9';
      window.highlightCooldownActive = false;
      window.highlightCooldownTimer = null;
      window.isRecordingActive = false;
      window.bufferReady = false;
      window.isSessionHost = false;
      window.sessionClipDuration = 30000;
      window.authToken = null;
      window.authUsername = null;

      // Auto-capture state
      window.autoCaptureEnabled = false;
      window.autoCaptureSensitivity = 'medium';
      window.autoCaptureDesktopOn = true;
      window.autoCaptureMicOn = true;
      window.autoCaptureWindowActive = false;
      // Tuned against real Apex capture data (idle mic rms≈0.006, idle
      // desktop rms≈0.008; real peaks: mic 0.06–0.37, desktop 0.03–0.055).
      // multiplier is comfortably above idle without missing genuine peaks.
      // minActiveMs is the MINIMUM real moment worth saving — kept short so
      // a brief-but-real highlight (a quick knock) isn't discarded, which
      // was causing start→cancel→start loops when peaks were sporadic.
      // Percentile-based thresholds. `pct` is the quantile of the recent
      // window a sample must clear; `medianMult` is a second, independent
      // gate that stops constant-combat games (CoD/Battlefront-style) from
      // triggering on ordinary gunfire — when the median IS gunfire, only
      // something well above it counts.
      var AUTO_CAPTURE_PROFILES = {
        low:    { pct: 0.990, medianMult: 2.00, settleMs: 12000, minActiveMs: 7000 },
        medium: { pct: 0.970, medianMult: 1.60, settleMs: 10000, minActiveMs: 5000 },
        high:   { pct: 0.940, medianMult: 1.35, settleMs: 9000,  minActiveMs: 4000 }
      };

      // =====================
      // CLOCK SYNC — measures this PC's offset from the Peak-Abu server
      // clock via min-RTT ping sampling, then pushes it to main so every
      // clip timestamp lands in the shared server clock domain. Without
      // this, clips are stamped in raw local Windows time and POVs drift.
      // =====================
      window.clockSyncInterval = null;

      function runClockSyncBurst() {
        if (!window.socket || !window.socket.connected) {
          hudLog('system', '⚠ Clock sync skipped — not connected to server', 'error');
          return;
        }
        var samples = [];
        var sent = 0;
        var finished = false;
        var TOTAL = 10;

        function finishBurst() {
          if (finished) return;
          finished = true;
          if (samples.length < 3) {
            hudLog('system', '⚠ Clock sync failed — only ' + samples.length + '/10 pings answered. POV sync may drift this session.', 'error');
            return;
          }
          samples.sort(function(a, b) { return a.rtt - b.rtt; });
          var best = samples.slice(0, Math.min(5, samples.length));
          var offsets = best.map(function(s) { return s.offset; }).sort(function(a, b) { return a - b; });
          var median = offsets[Math.floor(offsets.length / 2)];
          var uncertaintyMs = best[0].rtt / 2;
          ipcRenderer.send('server-clock-offset', { offset: median, uncertaintyMs: uncertaintyMs });
          console.log('Clock sync: offset ' + median.toFixed(1) + 'ms, +/-' + uncertaintyMs.toFixed(1) + 'ms (' + samples.length + ' samples)');
          hudLog('activity', 'Clock synced to server (+/-' + Math.ceil(uncertaintyMs) + 'ms)', 'info');
        }

        function fireOne() {
          if (!window.socket || !window.socket.connected) return;
          var t0 = Date.now();
          window.socket.emit('time-sync', t0, function(res) {
            var t1 = Date.now();
            if (res && typeof res.serverTime === 'number') {
              samples.push({ rtt: t1 - t0, offset: res.serverTime - (t0 + t1) / 2 });
            }
          });
          sent++;
          if (sent < TOTAL) setTimeout(fireOne, 150);
          else setTimeout(finishBurst, 1500); // give the last acks time to land
        }

        fireOne();
      }

      function startClockSync() {
        stopClockSync();
        runClockSyncBurst();
        window.clockSyncInterval = setInterval(runClockSyncBurst, 5 * 60 * 1000);
      }

      function stopClockSync() {
        if (window.clockSyncInterval) { clearInterval(window.clockSyncInterval); window.clockSyncInterval = null; }
      }

      // Mic state
      window.micDeviceId = null;
      window.micEnabled = false;
      window.micVolume = 80;
      window.micMuted = false;
      window.micRecorder = null;

      // =====================
      // HUD
      // =====================
      const HUD_MAX_ITEMS = 50;
      window.activeHudTab = 'activity';

      var HUD_TITLES = { activity:'Activity', squad:'Squad', system:'System', history:'Session History' };

      window.switchHudTab = function(tab) {
       window.activeHudTab = tab;
       ['activity','squad','system','history'].forEach(t => {
         document.getElementById('hudTab-'+t).classList.toggle('active', t===tab);
         document.getElementById('hudPane-'+t).classList.toggle('active', t===tab);
       });
       var title = document.getElementById('hudTitle');
       if (title) title.textContent = HUD_TITLES[tab] || tab;
       var badge = document.getElementById('hudBadge-'+tab);
       badge.style.display = 'none';
       badge.textContent = '0';
     };

      // =====================
     // SESSION HISTORY
    // =====================
    const SESSION_HISTORY_MAX = 20;

    function loadSessionHistory() {
      try {
        var raw = localStorage.getItem('peak_abu_session_history');
        if (!raw) return [];
        var history = JSON.parse(raw);
        var legacyCutoff = Date.now() - (20 * 24 * 60 * 60 * 1000);
        history = history.filter(function(h) {
          // New entries carry a real expiresAt from the server (tier-based
          // retention). Older entries saved before this shipped fall back
          // to the old flat 20-day window so they don't just vanish.
          if (typeof h.expiresAt === 'number') return Date.now() < h.expiresAt;
          return new Date(h.timestamp).getTime() > legacyCutoff;
        });
        return history;
      } catch(e) { return []; }
    }

    function saveSessionHistory(history) {
      localStorage.setItem('peak_abu_session_history', JSON.stringify(history));
    }

    function addSessionToHistory(code, role, expiresAt) {
      var history = loadSessionHistory();
      var prior = history.find(function(h) { return h.code === code; });
      history = history.filter(function(h) { return h.code !== code; });
      history.unshift({
        code: code,
        role: role,
        username: window.authUsername,
        timestamp: new Date().toISOString(),
        expiresAt: (typeof expiresAt === 'number') ? expiresAt : null,
        // Preserve anything already learned for this code on a rejoin.
        // `title` is the SERVER-synced squad title; `localNote` is
        // per-user-only and never overwritten by server data.
        game: prior ? (prior.game || null) : null,
        title: prior ? (prior.title || null) : null,
        localNote: prior ? (prior.localNote || null) : null
      });
      while (history.length > SESSION_HISTORY_MAX) history.pop();
      saveSessionHistory(history);
      renderSessionHistory();
    }

    // Syncs server-canonical game/title into the local history entry.
    // Pass whichever of game/title changed; undefined/omitted args are left
    // untouched (null IS a valid value — it means "explicitly cleared").
    // Always re-renders, even if the entry was missing and had to be
    // created from scratch — this is what a title edit right after joining
    // (before the join's own addSessionToHistory call has settled) needs.
    function setSessionHistoryGame(code, game, title) {
      console.log('[setSessionHistoryGame] called with code:', code, 'game:', game, 'title:', title);
      if (!code) { console.log('[setSessionHistoryGame] bailed — no code'); return; }
      var history = loadSessionHistory();
      var entry = history.find(function(h) { return h.code === code; });
      console.log('[setSessionHistoryGame] found entry:', JSON.stringify(entry));

      if (!entry) {
        // Shouldn't normally happen (session-joined already adds an entry
        // before this can fire), but don't silently drop the update if it does.
        entry = {
          code: code,
          role: (window.isSessionHost ? 'host' : 'member'),
          username: window.authUsername,
          timestamp: new Date().toISOString(),
          expiresAt: null,
          game: null,
          title: null,
          localNote: null
        };
        history.unshift(entry);
      }

      if (typeof game !== 'undefined' && game !== null) entry.game = game;
      if (typeof title !== 'undefined' && title !== null) entry.title = title;

      while (history.length > SESSION_HISTORY_MAX) history.pop();
      saveSessionHistory(history);
      renderSessionHistory();
    }

    

    window.renameSessionHistory = function(code) {
      var history = loadSessionHistory();
      var entry = history.find(function(h) { return h.code === code; });
      if (!entry) return;
      var current = entry.title || entry.game || '';
      openTextInputModal('Name this session', current, function(value) {
        var h2 = loadSessionHistory();
        var e2 = h2.find(function(h) { return h.code === code; });
        if (!e2) return;
        e2.title = value.slice(0, 60) || null;
        saveSessionHistory(h2);
        renderSessionHistory();
        // If this is the currently-open session, also push the rename to
        // the server so the squad's canonical title matches what History
        // now shows locally — otherwise the two could disagree.
        if (window.socket && window.currentSessionCode === code) {
          window.socket.emit('set-session-title', { title: e2.title || '' });
        }
      });
    };

    function formatExpiry(expiresAt) {
      if (typeof expiresAt !== 'number' || !expiresAt) return { text: '', cls: 'exp-ok' };
      var ms = expiresAt - Date.now();
      if (ms <= 0) return { text: 'clips expired', cls: 'exp-dead' };
      var h = Math.floor(ms / 3600000);
      if (h < 1) return { text: 'expires in ' + Math.max(1, Math.floor(ms / 60000)) + 'm', cls: 'exp-dead' };
      if (h < 24) return { text: 'expires in ' + h + 'h', cls: 'exp-soon' };
      var d = Math.floor(h / 24);
      return { text: 'expires in ' + d + 'd ' + (h % 24) + 'h', cls: 'exp-ok' };
    }

    function renderSessionHistory() {
      var pane = document.getElementById('hudPane-history');
      var history = loadSessionHistory();
      if (history.length === 0) {
        pane.innerHTML = '<div class="hud-empty">Session history appears here</div>';
        return;
      }
      pane.innerHTML = '';
      history.forEach(function(h) {
        var item = document.createElement('div');
        item.className = 'hist-item';

        var top = document.createElement('div');
        top.className = 'hist-top';

        var role = document.createElement('span');
        role.textContent = h.role === 'host' ? '👑' : '👤';

        var code = document.createElement('span');
        code.className = 'hist-code';
        code.textContent = h.code;

        var name = document.createElement('span');
        name.className = 'hist-name';
        name.textContent = h.title || h.game || '';

        var edit = document.createElement('button');
        edit.className = 'hist-edit';
        edit.textContent = '✏';
        edit.title = 'Rename this session';
        edit.addEventListener('click', function(e) {
          e.stopPropagation();
          window.renameSessionHistory(h.code);
        });

        top.appendChild(role);
        top.appendChild(code);
        top.appendChild(name);
        top.appendChild(edit);

        var meta = document.createElement('div');
        meta.className = 'hist-meta';

        var exp = formatExpiry(h.expiresAt);
        var expSpan = document.createElement('span');
        expSpan.className = exp.cls;
        expSpan.textContent = exp.text;

        var when = document.createElement('span');
        var d = new Date(h.timestamp);
        when.textContent = d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' ' +
                           d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

        meta.appendChild(expSpan);
        meta.appendChild(when);

        item.appendChild(top);
        item.appendChild(meta);

        item.addEventListener('click', function() {
          document.getElementById('joinCodeInput').value = h.code;
          clipboard.writeText(h.code);
          hudLog('system', '📋 Code ' + h.code + ' copied & filled', 'success');
        });

        pane.appendChild(item);
      });
    }

      function hudLog(tab, text, type) {
        type = type || 'info';
        var pane = document.getElementById('hudPane-'+tab);
        var empty = pane.querySelector('.hud-empty');
        if (empty) empty.remove();
        var item = document.createElement('div');
        item.className = 'clip-item ' + type;
        var msg = document.createElement('span');
        msg.textContent = text;
        var time = document.createElement('span');
        time.className = 'clip-time';
        time.textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        item.appendChild(msg);
        item.appendChild(time);
        pane.prepend(item);
        while (pane.children.length > HUD_MAX_ITEMS) pane.removeChild(pane.lastChild);
        if (window.activeHudTab !== tab) {
          var badge = document.getElementById('hudBadge-'+tab);
          var count = parseInt(badge.textContent||'0') + 1;
          badge.textContent = count > 99 ? '99+' : count;
          badge.style.display = 'inline-block';
        }
      }

      // =====================
      // COPY SESSION CODE
      // =====================
      window.copySessionCode = function() {
        var code = document.getElementById('sessionCodeDisplay').textContent.trim();
        if (!code || code === '------') return;
        clipboard.writeText(code); (function() {
          var el = document.getElementById('sessionCodeDisplay');
          var hint = document.getElementById('sessionCodeHint');
          el.classList.add('copied');
          hint.textContent = '✅ Copied!';
          setTimeout(function() { el.classList.remove('copied'); hint.textContent = 'Click the code to copy to clipboard'; }, 2000);
        })();
      };

      // =====================
      // SESSION TITLE (server-synced) + LOCAL NOTE (client-only)
      // =====================
      function renderSessionTitle(title) {
        var el = document.getElementById('sessionTitleText');
        if (!el) return;
        if (title) {
          el.textContent = title;
          el.classList.remove('untitled');
        } else {
          el.textContent = 'Untitled session';
          el.classList.add('untitled');
        }
      }

      function renderSessionGame(game) {
        var el = document.getElementById('sessionTitleGame');
        if (!el) return;
        if (game) {
          el.textContent = '🎮 ' + game;
          el.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      }

      // =====================
      // TEXT INPUT MODAL — Electron does not implement window.prompt();
      // it's a documented no-op. This is the replacement for every place
      // that used to call prompt() (session title, local note, history rename).
      // =====================
      window._textInputModalCallback = null;

      function openTextInputModal(title, currentValue, onSave) {
        document.getElementById('textInputModalTitle').textContent = title;
        var field = document.getElementById('textInputModalField');
        field.value = currentValue || '';
        window._textInputModalCallback = onSave;
        document.getElementById('textInputModal').classList.add('show');
        setTimeout(function() { field.focus(); field.select(); }, 30);
      }

      window.closeTextInputModal = function() {
        document.getElementById('textInputModal').classList.remove('show');
        window._textInputModalCallback = null;
      };

      window.submitTextInputModal = function() {
        var value = document.getElementById('textInputModalField').value;
        var cb = window._textInputModalCallback;
        window.closeTextInputModal();
        if (cb) cb(value.trim());
      };

      document.getElementById('textInputModal').addEventListener('click', function(e) {
        if (e.target.id === 'textInputModal') closeTextInputModal();
      });

      window.editSessionTitle = function() {
        if (!window.socket || !window.currentSessionCode) return;
        var current = document.getElementById('sessionTitleText').textContent;
        if (current === 'Untitled session') current = '';
        openTextInputModal('Session Title (visible to your whole squad)', current, function(value) {
          var clean = value.slice(0, 60);
          console.log('[editSessionTitle] value typed:', JSON.stringify(value), 'clean:', JSON.stringify(clean), 'code:', window.currentSessionCode);
          renderSessionTitle(clean || null);
          setSessionHistoryGame(window.currentSessionCode, undefined, clean || null);
          console.log('[editSessionTitle] history after update:', JSON.stringify(loadSessionHistory().find(function(h) { return h.code === window.currentSessionCode; })));
          window.socket.emit('set-session-title', { title: clean });
        });
      };

      // Local note: purely client-side, stored on the localStorage history
      // entry for this code. Never touches the server or other members.
      function renderSessionLocalNote(code) {
        var el = document.getElementById('sessionNoteText');
        if (!el || !code) return;
        var history = loadSessionHistory();
        var entry = history.find(function(h) { return h.code === code; });
        var note = entry ? (entry.localNote || '') : '';
        el.textContent = note;
        el.classList.toggle('empty', !note);
      }

      window.editSessionLocalNote = function() {
        if (!window.currentSessionCode) return;
        var code = window.currentSessionCode;
        var history = loadSessionHistory();
        var entry = history.find(function(h) { return h.code === code; });
        var current = entry ? (entry.localNote || '') : '';
        openTextInputModal('Private Note (only visible to you)', current, function(value) {
          var h2 = loadSessionHistory();
          var e2 = h2.find(function(h) { return h.code === code; });
          if (!e2) return; // shouldn't happen — addSessionToHistory runs on join
          e2.localNote = value.slice(0, 80) || null;
          saveSessionHistory(h2);
          renderSessionLocalNote(code);
          renderSessionHistory();
        });
      };

      // Single place that puts the status line back to its resting state.
      // Called from both the cooldown countdown and the server unlock event.
      function restoreReadyStatus() {
        var st = document.getElementById('statusText');
        var help = document.getElementById('statusHelp');
        if (!st || !help) return;
        if (window.isRecordingActive && window.bufferReady) {
          st.textContent = '● Ready — save a highlight anytime';
          st.className = 'status-bar ready';
          help.textContent = 'Click Save or press ' + window.currentHotkey +
            ' to capture the last ' + formatDuration(window.sessionClipDuration) + ' of gameplay';
        } else if (window.isRecordingActive) {
          st.textContent = '● Buffering gameplay...';
          st.className = 'status-bar buffering';
        } else {
          st.textContent = '● Idle';
          st.className = 'status-bar idle';
          help.textContent = 'Start recording to begin buffering gameplay';
        }
      }


      // =====================
      // CLIP DURATION
      // =====================
      function formatDuration(ms) {
        if (ms < 60000) return (ms/1000) + 's';
        return (ms/60000) + ' min';
      }

      window.onClipDurationChange = function() {
        var duration = parseInt(document.getElementById('clipDurationSelect').value);
        if (!window.socket || !window.currentSessionCode) return;
        window.socket.emit('set-clip-duration', { duration: duration });
      };

      function updateClipDurationUI(duration, isHost) {
        window.sessionClipDuration = duration;
        if (isHost) {
          document.getElementById('clipDurationHost').style.display = 'flex';
          document.getElementById('clipDurationMember').style.display = 'none';
          document.getElementById('clipDurationSelect').value = String(duration);
        } else {
          document.getElementById('clipDurationHost').style.display = 'none';
          document.getElementById('clipDurationMember').style.display = 'block';
          document.getElementById('clipDurationValue').textContent = formatDuration(duration);
        }
      }

      // =====================
      // SETTINGS
      // =====================
      window.openSettings = function() { document.getElementById('settingsModal').classList.add('show'); loadStoragePath(); };
      window.closeSettings = function() { document.getElementById('settingsModal').classList.remove('show'); };
      function loadStoragePath() { ipcRenderer.invoke('get-storage-directory').then(function(p) { document.getElementById('storagePathDisplay').textContent = p; }); }
      window.pickStorageDirectory = function() {
        ipcRenderer.invoke('pick-storage-directory').then(function(r) {
          if (r.success) { loadStoragePath(); hudLog('system','✅ Storage directory updated','success'); }
        });
      };
      window.runUninstall = async function() {
        var ok = confirm(
          'Uninstall Peak-Abu?\n\n' +
          'This removes the app, its settings, and all temporary buffer files.\n\n' +
          'Your saved highlight videos and their .json files will NOT be deleted — ' +
          'they stay in your storage directory.'
        );
        if (!ok) return;

        hudLog('system', 'Cleaning up and launching uninstaller...', 'info');
        try {
          var r = await ipcRenderer.invoke('run-uninstall');
          if (!r.success) {
            hudLog('system', '⚠ ' + r.error, 'error');
            alert(r.error);
          }
        } catch (e) {
          hudLog('system', '⚠ Uninstall failed: ' + e.message, 'error');
        }
      };

      // ===== Web player: docked vs separate window =====
     window.onPlayerWindowedToggle = function() {
        var enabled = document.getElementById('playerWindowedToggle').checked;
        window.playerWindowedModeClient = enabled;

        if (enabled) {
          // Hide immediately, client-side — don't wait on the IPC round
          // trip for something the user needs to see react right away.
          var divider = document.getElementById('dockDivider');
          var closeBtn = document.getElementById('dockCloseBtn');
          if (divider) divider.classList.remove('show');
          if (closeBtn) closeBtn.classList.remove('show');
          document.body.classList.remove('player-docked');
          document.body.style.paddingRight = '';
        }

        ipcRenderer.invoke('set-player-windowed-mode', enabled).then(function() {
          hudLog('system', enabled
            ? 'Web player will open in its own window'
            : 'Web player will dock inside Peak-Abu', 'info');
        });
      };

      ipcRenderer.invoke('get-player-windowed-mode').then(function(enabled) {
        var el = document.getElementById('playerWindowedToggle');
        if (el) el.checked = !!enabled;
        window.playerWindowedModeClient = !!enabled;
      }).catch(function() {});

      // Main process reserves the right side for the docked player — shift
      // the client content into the remaining strip so nothing sits underneath,
      // and keep the divider/close button pinned to the view's actual edge.
      window.dockedGutter = 6;

      // Mirrors main.js's clamp constants. This is a hard visual backstop —
      // even if a stale/out-of-range value ever reaches the renderer over
      // IPC, the on-screen divider/padding/close-button can never squish
      // the client column past this, independent of whatever main decides.
      var CLIENT_MIN_PLAYER_VIEW = 360;
      var CLIENT_MIN_CLIENT_WIDTH = 460;

      function clampReservedWidthClient(desired) {
        var w = window.innerWidth;
        var minAllowed = CLIENT_MIN_PLAYER_VIEW + window.dockedGutter;
        var maxAllowed = Math.max(minAllowed, w - CLIENT_MIN_CLIENT_WIDTH);
        return Math.min(maxAllowed, Math.max(minAllowed, desired));
      }

      function positionDockControls(totalWidth) {
        var divider = document.getElementById('dockDivider');
        var closeBtn = document.getElementById('dockCloseBtn');
        if (!divider || !closeBtn) return;

        var clamped = clampReservedWidthClient(totalWidth);
        window.dockedTotalWidth = clamped;

        divider.style.right = (clamped - window.dockedGutter) + 'px';
        divider.style.width = window.dockedGutter + 'px';

        // Anchor the close button off the divider's OWN rendered position
        // (not a second independent calculation) so the two can never
        // disagree with each other on screen.
        var rect = divider.getBoundingClientRect();
        closeBtn.style.right = (window.innerWidth - rect.left + 6) + 'px';
      }

      window.playerWindowedModeClient = false;

      // Places the divider/close button at an EXACT pixel value with no
      // re-derivation — used for values that already came from main
      // (the authority on where the native view actually sits).
      // Positions everything from the view's ACTUAL left edge, using `left`
      // rather than `right`. Anchoring from the left means we're working in
      // the same direction main measured from, so a mismatch between
      // getContentSize() and window.innerWidth can't open a gap.
      function placeDockControlsFromViewLeft(viewLeft) {
        var divider = document.getElementById('dockDivider');
        var closeBtn = document.getElementById('dockCloseBtn');
        if (!divider || !closeBtn) return;

        var gutter = window.dockedGutter;
        var dividerLeft = Math.max(0, viewLeft - gutter);

        divider.style.left = dividerLeft + 'px';
        divider.style.right = 'auto';
        divider.style.width = gutter + 'px';

        closeBtn.style.left = (dividerLeft - 26) + 'px';
        closeBtn.style.right = 'auto';

        // Client content stops exactly where the divider begins.
        // paddingRight is computed from the divider's ACTUAL on-screen position,
        // not from main's DIP measurements — this is what closes the gap.
        window.dockedContentWidth = dividerLeft;
        // Reserved width in CSS px. The post-resize nudge below reads this;
        // it used to only ever be set by positionDockControls(), which is no
        // longer on the live path — so the nudge sent 0 and main reset the
        // width to its default.
        window.dockedTotalWidth = window.innerWidth - dividerLeft;
        var rect = divider.getBoundingClientRect();
        document.body.style.paddingRight = (window.innerWidth - rect.left + 4) + 'px';
        document.body.style.setProperty('--dock-client-width', rect.left + 'px');

        // Don't rely on flexbox to infer .app's width from paddingRight — force
        // it directly so the client column visibly tracks every geometry update,
        // not just ones that happen to trigger a native reflow.
        // .app already has width:100%; body's paddingRight reserves the
        // player's space. The only thing stopping it from filling the
        // remaining strip is the static max-width:720px in CSS. Lift that
        // cap to 'none' and let normal flow size it — pinning it to a
        // computed pixel value froze the grid columns instead.
        var appEl = document.querySelector('.app');
        if (appEl) {
          appEl.style.maxWidth = 'none';
          // Below ~620px the two columns get too cramped to be usable —
          // stack them. Measured off the real strip width, since a CSS
          // media query only ever sees the full window.
          appEl.classList.toggle('dock-narrow', rect.left < 620);
        }
        console.log('[dock-app-width] set maxWidth=' + (appEl ? appEl.style.maxWidth : 'NO .app FOUND') +
         ' computedWidth=' + (appEl ? getComputedStyle(appEl).width : '?') +
         ' rect.left=' + rect.left.toFixed(0));
        document.body.style.setProperty('--dock-client-width', rect.left + 'px');

        console.log(
          `[dock-renderer-place] dividerLeft=${dividerLeft} rect.left=${rect.left.toFixed(0)} ` +
          `innerWidth=${window.innerWidth} paddingRight=${(window.innerWidth - rect.left + 4)}`
        );
      }

      // Fallback for mid-drag, before main echoes real geometry back
      function placeDockControlsExact(totalWidth) {
        placeDockControlsFromViewLeft(window.innerWidth - totalWidth + window.dockedGutter);
      }

      window.dockDragActive = false;

      ipcRenderer.on('player-docked', function(ev, d) {
        var divider = document.getElementById('dockDivider');
        var closeBtn = document.getElementById('dockCloseBtn');
        // Defensive guard: if we know we're in windowed mode client-side,
        // never let a stray docked:true event turn these controls back on.
        if (window.playerWindowedModeClient && d && d.docked) return;
        // While the user is actively dragging, the renderer owns the
        // divider position. Accepting echoes mid-drag makes the bar fight
        // the cursor. The pointerup handler re-syncs from main afterward.
        if (window.dockDragActive && d && d.docked) return;
        if (d && d.docked) {
          if (typeof d.gutter === 'number') window.dockedGutter = d.gutter;

          if (typeof d.viewLeft === 'number') {
            var dipToCss = (d.contentWidth > 0) ? (window.innerWidth / d.contentWidth) : 1;
            window.dockDipToCss = dipToCss;
            var viewLeftCss = d.viewLeft * dipToCss;
            console.log(
              `[dock-renderer] contentWidth=${d.contentWidth} innerWidth=${window.innerWidth} ` +
              `dipToCss=${dipToCss.toFixed(3)} viewLeft=${d.viewLeft} viewLeftCss=${viewLeftCss.toFixed(0)} ` +
              `gutter=${window.dockedGutter} dividerWillBeAt=${(viewLeftCss - window.dockedGutter).toFixed(0)}`
            );
            // Show the controls FIRST. getBoundingClientRect() on a
            // display:none element returns zeros, so measuring before the
            // .show class lands gave rect.left=0 on the first dock —
            // crushing the client column until the divider was nudged.
            document.body.classList.add('player-docked');
            if (divider) divider.classList.add('show');
            if (closeBtn) closeBtn.classList.add('show');

            placeDockControlsFromViewLeft(viewLeftCss);
          } else {
            document.body.classList.add('player-docked');
            if (divider) divider.classList.add('show');
            if (closeBtn) closeBtn.classList.add('show');
            placeDockControlsExact(d.reservedRight);
          }
        } else {
          document.body.classList.remove('player-docked');
          document.body.style.paddingRight = '';
          document.body.style.removeProperty('--dock-client-width');
          var appEl2 = document.querySelector('.app');
          if (appEl2) { appEl2.style.maxWidth = ''; appEl2.classList.remove('dock-narrow'); }
          if (divider) divider.classList.remove('show');
          if (closeBtn) closeBtn.classList.remove('show');
        }
      });

      // Window resized: main re-lays the native view via its own resize
      // handler and re-emits player-docked — but if that echo races the
      // resize, our padding/divider can go stale. Nudge main to re-send
      // authoritative geometry after resizes settle.
      var _dockResizeTimer = null;
      window.addEventListener('resize', function() {
        if (!document.body.classList.contains('player-docked')) return;
        clearTimeout(_dockResizeTimer);
        _dockResizeTimer = setTimeout(function() {
          ipcRenderer.send('resize-player-width', window.dockedTotalWidth ? Math.round(window.dockedTotalWidth / (window.dockDipToCss || 1)) : 0);
        }, 150);
      });

      window.closeDockedPlayer = function() {
        ipcRenderer.invoke('close-player').then(function() {
          hudLog('system', '🌐 Web player closed', 'info');
        });
      };

      // Drag handle. Main process is the single source of truth for the
      // clamped width — the renderer just reports a desired value and
      // repositions itself off whatever player-docked echoes back, so it
      // can never drift out of sync with the actual native view edge.
      (function() {
        var divider = document.getElementById('dockDivider');
        if (!divider) return;
        var dragging = false;

        // CSS px — correct for local positioning
        function reservedWidthFromMouseX(clientX) {
          return clampReservedWidthClient(window.innerWidth - clientX);
        }

        // main.js works in DIP, so convert before sending. window.dockDipToCss
        // is captured from the last echo; defaults to 1 on an unscaled display.
        function toDip(cssPx) {
          var ratio = window.dockDipToCss || 1;
          return Math.round(cssPx / ratio);
        }

        divider.addEventListener('pointerdown', function(e) {
          dragging = true;
          window.dockDragActive = true;
          divider.classList.add('dragging');
          divider.setPointerCapture(e.pointerId);
          e.preventDefault();
        });

        divider.addEventListener('pointermove', function(e) {
          if (!dragging) return;
          var desired = reservedWidthFromMouseX(e.clientX);
          // During an ACTIVE drag only: move the bar off our own local
          // clamp so it tracks the cursor with zero perceived lag. This is
          // the one moment the renderer is allowed to guess — main's next
          // 'player-docked' echo (fired from resize-player-width below)
          // will immediately overwrite this with the authoritative value.
          placeDockControlsExact(desired);
          ipcRenderer.send('resize-player-width', toDip(desired));
        });

        divider.addEventListener('pointerup', function(e) {
          if (!dragging) return;
          dragging = false;
          divider.classList.remove('dragging');
          try { divider.releasePointerCapture(e.pointerId); } catch (err) {}
          ipcRenderer.send('resize-player-width-commit', toDip(reservedWidthFromMouseX(e.clientX)));
          // Release ownership a beat after the commit so main's final,
          // authoritative echo is the last word on where things sit.
          setTimeout(function() { window.dockDragActive = false; }, 120);
        });

        // Pointer capture can be lost (alt-tab, window drag) without a
        // pointerup ever firing — without this the flag sticks true and
        // the divider stops responding to main entirely.
        divider.addEventListener('lostpointercapture', function() {
          if (!dragging) return;
          dragging = false;
          divider.classList.remove('dragging');
          window.dockDragActive = false;
        });
      })();

      window.openWebPlayer = function(e) {
        if (e) e.preventDefault();
        if (!window.currentSessionCode) return;
        ipcRenderer.invoke('open-player', { code: window.currentSessionCode, token: window.authToken, username: window.authUsername })
          .then(function(r) {
            hudLog('system', r.mode === 'docked'
              ? '🌐 Web player opened alongside the client'
              : '🌐 Web player opened in its own window', 'info');
          });
      };
      document.getElementById('settingsModal').addEventListener('click', function(e) { if (e.target.id==='settingsModal') closeSettings(); });

      // =====================
      // FIRST LAUNCH
      // =====================
      async function checkFirstLaunch() {
        var isFirst = await ipcRenderer.invoke('is-first-launch');
        if (isFirst) {
          document.getElementById('installPathDisplay').textContent = await ipcRenderer.invoke('get-install-path') || 'Unknown';
          document.getElementById('firstLaunchStorageDisplay').textContent = await ipcRenderer.invoke('get-storage-directory');
          document.getElementById('firstLaunchModal').classList.add('show');
        }
      }
      window.pickStorageFirstLaunch = async function() {
        var r = await ipcRenderer.invoke('pick-storage-directory');
        if (r.success) document.getElementById('firstLaunchStorageDisplay').textContent = r.path;
      };
      window.completeFirstLaunch = async function() {
        await ipcRenderer.invoke('mark-first-launch-done');
        document.getElementById('firstLaunchModal').classList.remove('show');
        hudLog('system','Setup complete — ready to record!','success');
      };
      checkFirstLaunch();
      renderSessionHistory();

      // =====================
      // HOTKEY
      // =====================
      ipcRenderer.invoke('get-current-hotkey').then(function(hk) { if (hk) { window.currentHotkey = hk; updateHotkeyDisplay(hk); } });
      ipcRenderer.invoke('get-hotkey-registered').then(function(ok) {
        if (!ok) hudLog('system', '⚠ Hotkey \'' + window.currentHotkey + '\' couldn\'t be registered at startup — another app may have claimed it. Go to Settings to pick a different key.', 'error');
      });

      window.toggleHotkeyCapture = function() {
        if (window.capturingHotkey) {
          window.capturingHotkey = false;
          document.getElementById('hotkeyCapture').blur();
          document.getElementById('hotkeyDisplay').classList.remove('listening');
          document.getElementById('hotkeyBtn').textContent = 'Change';
          document.getElementById('hotkeyDisplay').textContent = window.currentHotkey;
          document.getElementById('hotkeyHint').textContent = 'Press any F-key, or Ctrl/Alt/Shift + key';
        } else {
          window.capturingHotkey = true;
          document.getElementById('hotkeyCapture').focus();
          document.getElementById('hotkeyDisplay').classList.add('listening');
          document.getElementById('hotkeyDisplay').textContent = '...';
          document.getElementById('hotkeyBtn').textContent = 'Cancel';
          document.getElementById('hotkeyHint').textContent = 'Listening — press your key combo now';
        }
      };

      // Main process XInput connection status (works even when game is focused)
      ipcRenderer.on('xinput-connection', function(ev, connected) {
        if (connected) {
          document.getElementById('gamepadStatus').textContent = '✓ Connected';
          document.getElementById('gamepadStatus').className = 'gamepad-status connected';
        } else {
          document.getElementById('gamepadStatus').textContent = 'No controller';
          document.getElementById('gamepadStatus').className = 'gamepad-status disconnected';
        }
      });


      function updateHotkeyDisplay(hk) {
        document.getElementById('hotkeyDisplay').textContent = hk;
        var span = document.getElementById('saveBtnHotkey');
        if (span) span.textContent = hk;
      }

      document.addEventListener('keydown', function(e) {
        if (!window.capturingHotkey) return;
        e.preventDefault(); e.stopPropagation();
        if (['Control','Alt','Shift','Meta'].includes(e.key)) return;
        var parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        var keyMap = {' ':'Space','ArrowUp':'Up','ArrowDown':'Down','ArrowLeft':'Left','ArrowRight':'Right','Backspace':'Backspace','Delete':'Delete','Enter':'Enter','Tab':'Tab'};
        var keyName;
        if (e.key==='Escape') { toggleHotkeyCapture(); return; }
        else if (keyMap[e.key]) keyName = keyMap[e.key];
        else if (/^F([1-9]|1[0-2])$/.test(e.key)) keyName = e.key;
        else if (e.key.length===1) {
          if (parts.length===0) { document.getElementById('hotkeyHint').textContent = 'Add Ctrl, Alt, or Shift with that key'; return; }
          keyName = e.key.toUpperCase();
        } else { document.getElementById('hotkeyHint').textContent = 'Key not supported — try F-key or modifier + letter'; return; }
        parts.push(keyName);
        var hotkey = parts.join('+');
        window.capturingHotkey = false;
        window.currentHotkey = hotkey;
        document.getElementById('hotkeyCapture').blur();
        updateHotkeyDisplay(hotkey);
        document.getElementById('hotkeyDisplay').classList.remove('listening');
        document.getElementById('hotkeyBtn').textContent = 'Change';
        document.getElementById('hotkeyHint').textContent = 'Hotkey saved';
        ipcRenderer.send('update-settings', { hotkey: hotkey });
      });

      ipcRenderer.on('hotkey-error', function(ev, msg) {
        document.getElementById('hotkeyHint').textContent = '⚠ ' + msg;
        updateHotkeyDisplay(window.currentHotkey);
      });

      // =====================
      // MIC
      // =====================
      async function loadMicDevices() {
       try {
         var devices = await navigator.mediaDevices.enumerateDevices();
         var mics = devices.filter(function(d){return d.kind==='audioinput';});
         var sel = document.getElementById('micSelect');
         sel.innerHTML = '<option value="">None</option>';
         mics.forEach(function(m) {
           var opt = document.createElement('option');
           opt.value = m.deviceId;
           opt.textContent = m.label || ('Mic ' + sel.children.length);
           sel.appendChild(opt);
         });

        // Auto-select default mic on first load if user hasn't explicitly chosen None
         if (!window.micHasBeenTouched && mics.length > 0) {
           var defaultMic = mics.find(function(m) { return m.deviceId === 'default'; }) || mics[0];
           sel.value = defaultMic.deviceId;
           window.micDeviceId = defaultMic.deviceId;
           window.micEnabled = true;
           sel.classList.remove('mic-pulse');
         } else if (!window.micDeviceId) {
           // No mic selected and user hasn't touched it — pulse
           sel.classList.add('mic-pulse');
         }
       } catch(e) {}
     }

     async function loadAudioOutputDevices() {
      try {
        var devices = await navigator.mediaDevices.enumerateDevices();
        var outputs = devices.filter(function(d) { return d.kind === 'audiooutput'; });
        var sel = document.getElementById('audioOutputSelect');
        sel.innerHTML = '<option value="default">Default</option>';
        outputs.forEach(function(d) {
          var opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || ('Output ' + sel.children.length);
          sel.appendChild(opt);
        });
      } catch(e) { console.log('Audio output enum failed:', e); }
    }

    window.onAudioOutputChange = function() {
      var deviceId = document.getElementById('audioOutputSelect').value;
      ipcRenderer.send('update-audio-output', { deviceId: deviceId });
      hudLog('system', '🔊 Audio capture source changed', 'info');
     };

      window.onMicDeviceChange = function() {
       window.micHasBeenTouched = true;
       var sel = document.getElementById('micSelect');
       sel.classList.remove('mic-pulse');
       window.micDeviceId = sel.value || null;
       window.micEnabled = !!window.micDeviceId;
     };
      window.onMicVolumeChange = function() {
        window.micVolume = parseInt(document.getElementById('micVolume').value);
        ipcRenderer.send('update-mic-settings', { volume: window.micVolume });
      };
      window.toggleMicMute = function() {
        window.micMuted = !window.micMuted;
        var btn = document.getElementById('micMuteBtn');
        btn.textContent = window.micMuted ? 'Unmute' : 'Mute';
        btn.classList.toggle('muted', window.micMuted);
        ipcRenderer.send('update-mic-settings', { muted: window.micMuted });
      };
      async function startMicCapture() {
        if (!window.micDeviceId || !window.micEnabled) return;
        try {
          var stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: window.micDeviceId } } });
          window._liveMicStream = stream;
          window.micRecorder = new MediaRecorder(stream, { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond:128000 });
          window.micRecorder.ondataavailable = async function(ev) {
            if (ev.data && ev.data.size > 0) { ipcRenderer.send('save-mic-chunk', await ev.data.arrayBuffer()); }
          };
          window.micRecorder.onerror = function(e) { console.log('Mic error:', e); };
          window.micRecorder.start(10000);
          ipcRenderer.send('mic-recording-started', Date.now()+20);
          if (window.autoCaptureEnabled) window.acAttachMic(stream);
          
          hudLog('system','🎤 Mic capture started','success');
        } catch(err) {
        
          hudLog('system','🎤 Mic failed: '+err.message,'error');
        }
      }
      function stopMicCapture() {
        if (window.micRecorder && window.micRecorder.state !== 'inactive') { window.micRecorder.stop(); window.micRecorder = null; }
      }

     loadMicDevices();
     loadAudioOutputDevices();
     navigator.mediaDevices.addEventListener('devicechange', function() {
       loadMicDevices();
       loadAudioOutputDevices();
     });
        
      // =====================
      // AUTO-CAPTURE — client-side audio analysis
      // Taps the SAME MediaStreams already used for desktop/mic recording
      // (no second capture request). Runs a lightweight RMS-vs-rolling-
      // average peak detector on each and reports peaks to the server via
      // 'auto-peak'. The server owns all ACTIVE/settle timing — this code
      // only ever reports "louder than usual right now", never decides
      // when to save.
      // =====================
      window._acAudioCtx = null;
      window._acDesktop = null;
      window._acMic = null;

      function acGetAudioCtx() {
        if (!window._acAudioCtx) window._acAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return window._acAudioCtx;
      }

      function acCreateAnalyzer(stream) {
        var ctx = acGetAudioCtx();
        var source = ctx.createMediaStreamSource(stream);
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        return { source: source, analyser: analyser, data: new Uint8Array(analyser.fftSize), rolling: [], lastEmit: 0, timer: null };
      }

      function acReadRms(state) {
        state.analyser.getByteTimeDomainData(state.data);
        var sum = 0;
        for (var i = 0; i < state.data.length; i++) {
          var v = (state.data[i] - 128) / 128;
          sum += v * v;
        }
        return Math.sqrt(sum / state.data.length);
      }

      window._acDebug = false; // flip to false once tuned

      var AC_POLL_MS = 50;                   // analyser poll interval, referenced by the ring sizing below
      var AC_FLOOR = 0.010;                  // absolute floor — near-silence can never trigger
      var AC_FLOOR_MIC = 0.020;              // mic sits closer to its own noise, needs more headroom
      var AC_EMIT_THROTTLE_MS = 500;         // don't spam the socket while a loud sound sustains
      var AC_SUSTAIN_POLLS = 7;              // loud polls required within the window to OPEN a capture
      var AC_SUSTAIN_POLLS_KEEPALIVE = 3;    // much lighter bar to KEEP one open through combat lulls
      var AC_SUSTAIN_WINDOW = 12;            // ~600ms at 50ms — tolerates gaps between shots

      // ===== ROLLING PERCENTILE BASELINE =====
      // Replaces the EMA. An EMA converges on whatever is playing most, so in
      // a game where gunfire never stops the baseline BECOMES gunfire and
      // nothing clears the threshold. A percentile over a fixed recent window
      // asks a different question — "is this in the top few percent of the
      // last 45 seconds" — which stays meaningful no matter how loud the
      // floor is, and needs no freeze/calibration machinery to avoid drift.
      var AC_PCT_WINDOW_MS   = 45000;   // how much recent history defines "normal"
      var AC_PCT_RECALC_EVERY = 10;     // recompute thresholds every N polls (~500ms)
      var AC_PCT_MIN_FILL    = 200;     // samples needed before anything can fire (~10s)
      var AC_MIC_EXTRA_MULTIPLIER = 2.3; // mic median gate on top of the profile's


      // ===== COLD-START NOISE FLOOR CALIBRATION =====
      // The EMA seeds itself from whatever RMS happened to be playing the
      // instant a source attaches — if that's mid-fight or mid-rotation the
      // baseline starts inflated and every threshold after it is wrong until
      // the EMA slowly drifts down. This samples actual quiet stretches over
      // the opening minutes and REPLACES the seed with the true floor.
      // Every 2 min, a 10s window, 5 checks => covers the first 10 min.
      // Each window is only accepted if it stayed genuinely quiet (below a
      // loose ceiling), so a check landing on a fight is discarded, not forced.
      // The MINIMUM of valid samples becomes the anchor.
      var AC_CAL_INTERVAL_MS   = 120000; // 2 min between checks
      var AC_CAL_WINDOW_MS     = 10000;  // 10s sampling window
      var AC_CAL_TOTAL_CHECKS  = 5;      // 5 checks => first 10 min
      var AC_CAL_QUIET_CEILING = 3;      // window valid only if avg RMS < 3 * AC_FLOOR

      // Fixed-capacity ring of recent RMS values. Overwrites oldest in place
      // so there's no array churn at 20 polls/sec.
      function acPushSample(state, rms) {
        if (!state.ring) {
          state.ringCap = Math.max(50, Math.round(AC_PCT_WINDOW_MS / AC_POLL_MS));
          state.ring = new Float32Array(state.ringCap);
          state.ringLen = 0;
          state.ringIdx = 0;
        }
        state.ring[state.ringIdx] = rms;
        state.ringIdx = (state.ringIdx + 1) % state.ringCap;
        if (state.ringLen < state.ringCap) state.ringLen++;
      }

      // Sorts a copy of the ring and pulls the percentile + median. Called
      // once every AC_PCT_RECALC_EVERY polls, not every poll — a 900-element
      // TypedArray sort twice a second is nothing, 20x a second is waste.
      function acRecomputeThreshold(state, profile, isMic) {
        var n = state.ringLen;
        if (n < 10) { state.threshold = Infinity; return; }

        if (!state.sortBuf || state.sortBuf.length !== n) state.sortBuf = new Float32Array(n);
        state.sortBuf.set(state.ring.subarray(0, n));
        state.sortBuf.sort(); // TypedArray sort is numeric ascending by default

        var pct = isMic ? Math.min(0.995, profile.pct + 0.02) : profile.pct;
        var pctVal = state.sortBuf[Math.min(n - 1, Math.floor(pct * n))];
        var median = state.sortBuf[Math.floor(0.5 * n)];

        var medMult = profile.medianMult * (isMic ? AC_MIC_EXTRA_MULTIPLIER : 1);
        var floor = isMic ? AC_FLOOR_MIC : AC_FLOOR;

        // All three gates must be cleared. pctVal handles quiet stretches,
        // median*mult handles uniformly-loud stretches, floor handles silence.
        state.threshold = Math.max(pctVal, median * medMult, floor);
        state.debugPct = pctVal;
        state.debugMedian = median;
      }

      function acPollSource(sourceName, state) {
        if (!state) return;
        var isMic = (sourceName === 'mic');
        var rms = acReadRms(state);
        var profile = AUTO_CAPTURE_PROFILES[window.autoCaptureSensitivity] || AUTO_CAPTURE_PROFILES.medium;

        state.sampleCount = (state.sampleCount || 0) + 1;

        // Freeze the baseline while a capture window is open. Without this the
        // ring fills with combat audio during a long fight, the percentile
        // climbs, real peaks stop clearing it, and the window closes mid-fight
        // — the exact failure the old EMA freeze existed to prevent.
        if (!window.autoCaptureWindowActive) acPushSample(state, rms);

        if (state.threshold === undefined ||
            state.sampleCount % AC_PCT_RECALC_EVERY === 0) {
          acRecomputeThreshold(state, profile, isMic);
        }

        var isPeak = rms > state.threshold;
        var warmedUp = state.ringLen >= AC_PCT_MIN_FILL;

        // Rolling sustain window — unchanged, this part worked. Counting peaks
        // across a recent span tolerates the sub-100ms gaps between shots that
        // a strict-consecutive counter kept tripping over.
        if (!state.peakHistory) state.peakHistory = [];
        state.peakHistory.push(isPeak ? 1 : 0);
        if (state.peakHistory.length > AC_SUSTAIN_WINDOW) state.peakHistory.shift();
        var peaksInWindow = 0;
        for (var pi = 0; pi < state.peakHistory.length; pi++) peaksInWindow += state.peakHistory[pi];
        state.consecutivePeaks = peaksInWindow;

        var requiredPolls = window.autoCaptureWindowActive ? AC_SUSTAIN_POLLS_KEEPALIVE : AC_SUSTAIN_POLLS;
        var sustainedPeak = warmedUp && peaksInWindow >= requiredPolls;

        if (window._acDebug && (isPeak || (state._debugCounter = (state._debugCounter || 0) + 1) % 20 === 0)) {
          console.log('[ac-' + sourceName + '] sens=' + window.autoCaptureSensitivity +
                      ' rms=' + rms.toFixed(4) +
                      ' thr=' + (isFinite(state.threshold) ? state.threshold.toFixed(4) : 'inf') +
                      ' p=' + (state.debugPct || 0).toFixed(4) +
                      ' med=' + (state.debugMedian || 0).toFixed(4) +
                      ' fill=' + state.ringLen + '/' + (state.ringCap || 0) +
                      ' isPeak=' + isPeak + ' inWin=' + peaksInWindow +
                      ' sustained=' + sustainedPeak);
        }

        if (isPeak) acFlashMonkey(sourceName);

        if (sustainedPeak) {
          var now = Date.now();
          if (now - state.lastEmit >= AC_EMIT_THROTTLE_MS) {
            state.lastEmit = now;
            acReportPeak(profile);
          }
        }
      }

      // ---- Cold-start calibration lifecycle (per source state) ----
      function acStartCalibration(sourceName, state) {
        state.calChecksDone = 0;
        state.calValidSamples = [];
        state.calDone = false;
        state.calWindowActive = false;
        if (state.calTimer) clearTimeout(state.calTimer);
        acScheduleNextCalCheck(sourceName, state);
      }

      function acScheduleNextCalCheck(sourceName, state) {
        if (state.calChecksDone >= AC_CAL_TOTAL_CHECKS) { acFinalizeCalibration(sourceName, state); return; }
        state.calTimer = setTimeout(function() {
          // Open a 10s window; acPollSource folds RMS in while it's active.
          state.calWindowActive = true;
          state.calWindowRmsSum = 0;
          state.calWindowRmsCount = 0;
          state.calTimer = setTimeout(function() { acCloseCalWindow(sourceName, state); }, AC_CAL_WINDOW_MS);
        }, AC_CAL_INTERVAL_MS);
      }

      function acCloseCalWindow(sourceName, state) {
        state.calWindowActive = false;
        state.calChecksDone++;
        if (state.calWindowRmsCount > 0) {
          var avg = state.calWindowRmsSum / state.calWindowRmsCount;
          var ceiling = AC_FLOOR * AC_CAL_QUIET_CEILING;
          if (avg < ceiling) {
            state.calValidSamples.push(avg);
            if (window._acDebug) console.log('[ac-cal] ' + sourceName + ' check ' + state.calChecksDone + '/' + AC_CAL_TOTAL_CHECKS + ' ACCEPTED avg=' + avg.toFixed(4) + ' (ceiling=' + ceiling.toFixed(4) + ')');
          } else if (window._acDebug) {
            console.log('[ac-cal] ' + sourceName + ' check ' + state.calChecksDone + '/' + AC_CAL_TOTAL_CHECKS + ' REJECTED avg=' + avg.toFixed(4) + ' (too loud, ceiling=' + ceiling.toFixed(4) + ')');
          }
        }
        acScheduleNextCalCheck(sourceName, state);
      }

      function acFinalizeCalibration(sourceName, state) {
        state.calDone = true;
        if (!state.calValidSamples.length) {
          if (window._acDebug) console.log('[ac-cal] ' + sourceName + ' NO valid quiet samples — keeping adaptive EMA as-is');
          return;
        }
        var floor = Math.min.apply(null, state.calValidSamples);
        // REPLACE the cold-start seed. The EMA can still drift from here if
        // the game's genuine ambient level changes after minute 10.
        state.ema = floor;
        if (window._acDebug) console.log('[ac-cal] ' + sourceName + ' CALIBRATED — EMA reset to floor=' + floor.toFixed(4) + ' from ' + state.calValidSamples.length + ' valid sample(s)');
      }

      function acStopCalibration(state) {
        if (state && state.calTimer) { clearTimeout(state.calTimer); state.calTimer = null; }
        if (state) state.calWindowActive = false;
      }


      function acReportPeak(profile) {
        if (!window.autoCaptureEnabled) return;
        if (!window.socket || !window.currentSessionCode) return;
        if (!window.isRecordingActive || !window.bufferReady) return;
        console.log('[ac-emit] sens=' + window.autoCaptureSensitivity +
                    ' settleMs=' + profile.settleMs +
                    ' minActiveMs=' + profile.minActiveMs);
        window.socket.emit('auto-peak', { settleMs: profile.settleMs, minActiveMs: profile.minActiveMs });
      }

      function acFlashMonkey(sourceName) {
        var el = document.getElementById(sourceName === 'mic' ? 'acMonkeyMic' : 'acMonkeyDesktop');
        if (!el) return;
        el.classList.add('peak');
        setTimeout(function() { el.classList.remove('peak'); }, 180);
      }
      function acSetMonkeyListening(sourceName, listening) {
        var el = document.getElementById(sourceName === 'mic' ? 'acMonkeyMic' : 'acMonkeyDesktop');
        if (el) el.classList.toggle('listening', !!listening);
      }
      function acSetActiveWindowVisual(active) {
        ['acMonkeyDesktop', 'acMonkeyMic'].forEach(function(id) {
          var el = document.getElementById(id);
          if (el) el.classList.toggle('active-window', !!active);
        });
      }

      window.acAttachDesktop = function(stream) {
        acDetachDesktop();
        if (!window.autoCaptureEnabled || !window.autoCaptureDesktopOn || !stream) return;
        var state = acCreateAnalyzer(stream);
        state.timer = setInterval(function() { acPollSource('desktop', state); }, AC_POLL_MS); // TEMP: was 200ms — testing sampling-gap theory
        window._acDesktop = state;
        acStartCalibration('desktop', state);
        acSetMonkeyListening('desktop', true);
      };
      window.acAttachMic = function(stream) {
        acDetachMic();
        if (!window.autoCaptureEnabled || !window.autoCaptureMicOn || !stream) return;
        var state = acCreateAnalyzer(stream);
        state.timer = setInterval(function() { acPollSource('mic', state); }, AC_POLL_MS); // TEMP: was 200ms — testing sampling-gap theory
        window._acMic = state;
        acStartCalibration('mic', state);
        acSetMonkeyListening('mic', true);
      };
      function acDetachDesktop() {
        if (window._acDesktop) {
          clearInterval(window._acDesktop.timer);
          acStopCalibration(window._acDesktop);
          try { window._acDesktop.source.disconnect(); } catch (e) {}
          window._acDesktop = null;
        }
        acSetMonkeyListening('desktop', false);
      }
      function acDetachMic() {
        if (window._acMic) {
          clearInterval(window._acMic.timer);
          acStopCalibration(window._acMic);
          try { window._acMic.source.disconnect(); } catch (e) {}
          window._acMic = null;
        }
        acSetMonkeyListening('mic', false);
      }
      window.acDetachAll = function() {
        acDetachDesktop();
        acDetachMic();
        acSetActiveWindowVisual(false);
      };

      // ===== Settings UI =====
      window.onAutoCaptureToggle = function() {
        var checked = document.getElementById('autoCaptureToggle').checked;
        if (checked && window.currentTier === 't1') {
          document.getElementById('autoCaptureToggle').checked = false;
          return;
        }
        if (checked && !window._acDisclosureSeen) {
          document.getElementById('autoCaptureToggle').checked = false;
          document.getElementById('acDisclosureModal').classList.add('show');
          return;
        }
        acCommitEnabled(checked);
      };

      window.acConfirmDisclosure = function() {
        window._acDisclosureSeen = true;
        ipcRenderer.invoke('set-user-pref', 'autoCaptureDisclosureSeen', true);
        document.getElementById('acDisclosureModal').classList.remove('show');
        document.getElementById('autoCaptureToggle').checked = true;
        acCommitEnabled(true);
      };
      window.acCancelDisclosure = function() {
        document.getElementById('acDisclosureModal').classList.remove('show');
        document.getElementById('autoCaptureToggle').checked = false;
      };

      function acCommitEnabled(enabled) {
        window.autoCaptureEnabled = enabled;
        ipcRenderer.invoke('set-user-pref', 'autoCaptureEnabled', enabled);
        document.getElementById('acSubSettings').style.display = enabled ? 'block' : 'none';
        hudLog('system', enabled ? '👂 Auto-Highlight Detection enabled' : 'Auto-Highlight Detection disabled', 'info');
        if (enabled && window.isRecordingActive) {
          if (window._liveDesktopStream) window.acAttachDesktop(window._liveDesktopStream);
          if (window._liveMicStream) window.acAttachMic(window._liveMicStream);
        } else if (!enabled) {
          window.acDetachAll();
        }
      }

      window.onAutoCaptureSensitivityChange = function() {
        window.autoCaptureSensitivity = document.getElementById('autoCaptureSensitivitySelect').value;
        ipcRenderer.invoke('set-user-pref', 'autoCaptureSensitivity', window.autoCaptureSensitivity);
      };

      window.onAutoCaptureSourceToggle = function(source) {
        var btn = document.getElementById(source === 'mic' ? 'acMicSourceBtn' : 'acDesktopSourceBtn');
        var enabled = source === 'mic' ? !window.autoCaptureMicOn : !window.autoCaptureDesktopOn;
        if (source === 'mic') window.autoCaptureMicOn = enabled; else window.autoCaptureDesktopOn = enabled;
        btn.classList.toggle('muted', !enabled);
        btn.textContent = (source === 'mic' ? '🎙 Mic: ' : '🔊 Desktop: ') + (enabled ? 'On' : 'Off');
        ipcRenderer.invoke('set-user-pref', source === 'mic' ? 'autoCaptureMicOn' : 'autoCaptureDesktopOn', enabled);
        if (window.isRecordingActive && window.autoCaptureEnabled) {
          if (source === 'mic') { if (enabled && window._liveMicStream) window.acAttachMic(window._liveMicStream); else acDetachMic(); }
          else { if (enabled && window._liveDesktopStream) window.acAttachDesktop(window._liveDesktopStream); else acDetachDesktop(); }
        }
      };

      Promise.all([
        ipcRenderer.invoke('get-user-pref', 'autoCaptureEnabled'),
        ipcRenderer.invoke('get-user-pref', 'autoCaptureSensitivity'),
        ipcRenderer.invoke('get-user-pref', 'autoCaptureDesktopOn'),
        ipcRenderer.invoke('get-user-pref', 'autoCaptureMicOn'),
        ipcRenderer.invoke('get-user-pref', 'autoCaptureDisclosureSeen')
      ]).then(function(vals) {
        window.autoCaptureEnabled = vals[0] === true;
        window.autoCaptureSensitivity = vals[1] || 'medium';
        window.autoCaptureDesktopOn = vals[2] !== false;
        window.autoCaptureMicOn = vals[3] !== false;
        window._acDisclosureSeen = vals[4] === true;
        var toggle = document.getElementById('autoCaptureToggle');
        var sub = document.getElementById('acSubSettings');
        if (toggle) toggle.checked = window.autoCaptureEnabled;
        if (sub) sub.style.display = window.autoCaptureEnabled ? 'block' : 'none';
        var sensSel = document.getElementById('autoCaptureSensitivitySelect');
        if (sensSel) sensSel.value = window.autoCaptureSensitivity;
      }).catch(function() {});

      // =====================
      // SESSION
      // =====================
      window.createSession = function() {
        fetch('https://peakabu.app/sessions', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+window.authToken },
          body: JSON.stringify({})
        })
        .then(function(res){return res.json();})
        .then(function(data) {
          if (data.error) { alert('Error: '+data.error); return; }
          window.isSessionHost = true;
          connectToSession(data.sessionCode, window.authUsername);
        })
        .catch(function() { alert('Could not reach server'); });
      };

      window.joinSession = function() {
        var code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
        if (!code || code.length < 4) { alert('Enter a valid session code'); return; }
        window.isSessionHost = false;
        connectToSession(code, window.authUsername);
      };

      function connectToSession(code, username) {
        window.socket = io('https://peakabu.app', { auth: { token: window.authToken } });

        window.socket.on('connect_error', function(err) {
          if (err.message==='auth_required'||err.message==='auth_invalid') { alert('Session expired. Please log in again.'); logoutUser(); }
        });

        window.socket.on('connect', function() {
          window.socket.emit('join-session', { code: code, username: username });
          startClockSync();
        });

        window.socket.on('session-joined', function(data) {
          window.currentSessionCode = data.code;
          window.isSessionHost = (data.createdBy === window.authUsername);
          document.getElementById('sessionPanel-disconnected').style.display = 'none';
          document.getElementById('sessionPanel-connected').style.display = 'block';
          document.getElementById('sessionCodeDisplay').textContent = data.code;
          document.getElementById('playerLink').href = 'https://peakabu.app/player?code=' + data.code;
          updateClipDurationUI(data.clipDuration || 30000, window.isSessionHost);
          updateMemberList(data.members);
          hudLog('squad','Joined session ' + data.code,'success');
          ipcRenderer.send('session-connected', { code: data.code, username: username });
          addSessionToHistory(data.code, window.isSessionHost ? 'host' : 'member', data.expiresAt);
          updateClipCounter(data.clipsUsed, data.maxClips);

          renderSessionTitle(data.title || null);
          renderSessionGame(data.detectedGame || null);
          // Server title/game are the canonical values for THIS code —
          // sync into local history so the History tab agrees with what
          // the session card shows, without overwriting a local note.
          if (data.title) setSessionHistoryGame(data.code, data.detectedGame || null, data.title);
          else if (data.detectedGame) setSessionHistoryGame(data.code, data.detectedGame);
          renderSessionLocalNote(data.code);

          if (window.autoStartAfterJoin) {
            window.autoStartAfterJoin = false;
            autoStartRecordingSafe();
          }
        });

        window.socket.on('session-title-changed', function(d) {
          console.log('[session-title-changed] received:', d, 'currentSessionCode:', window.currentSessionCode);
          renderSessionTitle(d.title);
          // d.title can be null (title cleared) — pass it through explicitly
          // rather than skipping, so History reflects a cleared title too.
          if (window.currentSessionCode) setSessionHistoryGame(window.currentSessionCode, undefined, d.title);
          if (d.setBy !== window.authUsername) {
            hudLog('squad', d.setBy + ' renamed the session' + (d.title ? ' to "' + d.title + '"' : ''), 'info');
          }
        });

        window.socket.on('session-game-detected', function(d) {
          renderSessionGame(d.game);
          if (window.currentSessionCode) setSessionHistoryGame(window.currentSessionCode, d.game);
        });

        window.socket.on('member-joined', function(d) { addMember(d.username, false); hudLog('squad',d.username+' joined','success'); });
        window.socket.on('member-left', function(d) { removeMember(d.username); hudLog('squad',d.username+' left','info'); });
        window.socket.on('clip-count-update', function(d) { updateClipCounter(d.used, d.max); });
        window.socket.on('session-migrated', function(d) {
          hudLog('squad', 'Host started a new session — moving to ' + d.newCode, 'broadcast');
          var wasHost = window.isSessionHost;
          window.leaveSession();
          document.getElementById('joinCodeInput').value = d.newCode;
          window.isSessionHost = wasHost;
          connectToSession(d.newCode, window.authUsername);
        });
        window.socket.on('member-recording-update', function(d) { updateMemberRecording(d.username, d.isRecording); });

        window.socket.on('clip-duration-changed', function(d) {
          window.sessionClipDuration = d.duration;
          updateClipDurationUI(d.duration, window.isSessionHost);
          hudLog('squad', d.setBy + ' set clip to ' + formatDuration(d.duration), 'info');
        });

        window.socket.on('coordinated-save-highlight', function(d) {
         hudLog('activity','⚡ '+d.username+' triggered highlight — syncing all POVs...','broadcast');
         ipcRenderer.send('broadcast-save-highlight', { coordinated_timestamp: d.coordinated_timestamp, clipDuration: d.clipDuration, triggerSource: d.triggerSource });

         // Disable immediately as a fallback — don't wait on a separate cooldown event
         if (!window.highlightCooldownActive) {
           const estimatedLock = Math.ceil(d.clipDuration * 0.1) + 15000;
           startSaveCooldown(Math.ceil(estimatedLock / 1000));
         }
       });

        window.socket.on('highlight-unlocked', function() {
          if (window.highlightCooldownTimer) { clearInterval(window.highlightCooldownTimer); window.highlightCooldownTimer = null; }
          window.highlightCooldownActive = false;
          var btn = document.getElementById('saveBtn');
          btn.innerHTML = '💾 Save Highlight (or press <span id="saveBtnHotkey">'+window.currentHotkey+'</span>)';
          btn.disabled = !(window.isRecordingActive && window.bufferReady);
          // The countdown interval was the only thing that restored the status
          // line. Killing it early left "Buffering..." on screen forever.
          restoreReadyStatus();
        });

        window.socket.on('upload-received', function(d) { hudLog('activity','☁️ '+d.username+' uploaded their clip','success'); });

        window.socket.on('auto-capture-start', function(d) {
          // Only announce if we weren't already in a window — avoids the
          // spammy repeat when peaks cycle windows rapidly.
          var wasActive = window.autoCaptureWindowActive;
          window.autoCaptureWindowActive = true;
          acSetActiveWindowVisual(true);
          ipcRenderer.send('auto-capture-active', true);
          if (!wasActive) {
            hudLog('activity', '👂 Auto-capture detecting action — recording until it settles...', 'broadcast');
          }
        });
        window.socket.on('auto-capture-end', function(d) {
          window.autoCaptureWindowActive = false;
          acSetActiveWindowVisual(false);
          ipcRenderer.send('auto-capture-active', false);
          hudLog('activity', '🎬 Auto-capture window closed (' + (d.elapsedMs/1000).toFixed(0) + 's) — saving...', 'broadcast');
        });
        window.socket.on('auto-capture-cancel', function(d) {
          window.autoCaptureWindowActive = false;
          acSetActiveWindowVisual(false);
          ipcRenderer.send('auto-capture-active', false);
          hudLog('system', '👂 Auto-capture: false alarm, too short to save', 'info');
        });

        window.socket.on('error-message', function(d) {
          if (d.message && d.message.includes('cooldown')) { hudLog('activity','⏳ '+d.message,'info'); return; }
          alert('Session error: '+d.message);
          if (window.socket) { window.socket.disconnect(); window.socket = null; }
        });

        window.socket.on('disconnect', function() { console.log('WebSocket disconnected'); stopClockSync(); });
      }

      window.leaveSession = function() {
        if (window.socket) { window.socket.disconnect(); window.socket = null; }
        window.currentSessionCode = null;
        window.isSessionHost = false;
        document.getElementById('sessionPanel-disconnected').style.display = 'block';
        document.getElementById('sessionPanel-connected').style.display = 'none';
        document.getElementById('memberList').innerHTML = '';
        document.getElementById('clipDurationHost').style.display = 'none';
        document.getElementById('clipDurationMember').style.display = 'none';
        document.getElementById('clipCounter').style.display = 'none';
        document.getElementById('migrateBtn').style.display = 'none';
        renderSessionTitle(null);
        renderSessionGame(null);
        var noteEl = document.getElementById('sessionNoteText');
        if (noteEl) { noteEl.textContent = ''; noteEl.classList.add('empty'); }
        ipcRenderer.send('session-disconnected');
      };

      // Backend still tracks everything in raw seconds (clipWeight) — this
      // only changes how it's DISPLAYED. "682/144000 clips" reads as an
      // arbitrary wall of digits; "1h 54m of 40h used" is something a
      // person can actually reason about at a glance.
      function formatUsageDuration(totalSeconds) {
        var h = Math.floor(totalSeconds / 3600);
        var m = Math.floor((totalSeconds % 3600) / 60);
        if (h > 0 && m > 0) return h + 'h ' + m + 'm';
        if (h > 0) return h + 'h';
        return m + 'm';
      }

      function updateClipCounter(used, max) {
        var el = document.getElementById('clipCounter');
        if (!max) { el.style.display = 'none'; return; }
        el.style.display = 'block';

        var pct = Math.max(0, Math.min(100, (used / max) * 100));
        var remainingSec = Math.max(0, max - used);
        var tier = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : '';

        el.innerHTML =
          '<div class="usage-label">' + formatUsageDuration(used) + ' / ' + formatUsageDuration(max) + ' of highlight time used</div>' +
          '<div class="usage-track"><div class="usage-fill' + (tier ? ' ' + tier : '') + '" style="width:' + pct.toFixed(1) + '%;"></div></div>';

        // Last 15 minutes of headroom — flat time threshold rather than a
        // clip count, since "remaining" is now a duration, not an integer.
        document.getElementById('migrateBtn').style.display = (window.isSessionHost && remainingSec <= 900) ? 'block' : 'none';
      }

      window.migrateSession = function() {
        if (!window.socket) return;
        window.socket.emit('migrate-session');
        hudLog('system', 'Starting a new session for the squad...', 'info');
      };

      function updateMemberList(members) {
        document.getElementById('memberList').innerHTML = '';
        members.forEach(function(m) { addMember(m.username, m.isRecording); });
      }
      function addMember(username, isRec) {
        var list = document.getElementById('memberList');
        var safeId = 'member-' + CSS.escape(username);
        if (document.getElementById(safeId)) return;
        var item = document.createElement('div'); item.className = 'member-item'; item.id = safeId;
        var name = document.createElement('span'); name.className = 'member-name'; name.textContent = username;
        var status = document.createElement('span'); status.className = 'member-status '+(isRec?'rec':'idle'); status.textContent = isRec?'REC':'Idle';
        item.appendChild(name); item.appendChild(status); list.appendChild(item);
      }
      function removeMember(username) { var el = document.getElementById('member-'+CSS.escape(username)); if (el) el.remove(); }
      function updateMemberRecording(username, isRec) {
        var el = document.getElementById('member-'+CSS.escape(username)); if (!el) return;
        var b = el.querySelector('.member-status'); b.className = 'member-status '+(isRec?'rec':'idle'); b.textContent = isRec?'REC':'Idle';
      }

      // =====================
      // RECORDING
      // =====================
      window.savedMonitorIndex = null;
      window.monitorsPopulated = false;
      function applySavedMonitorSelection() {
        var sel = document.getElementById('monitorSelect');
        if (!sel || !window.monitorsPopulated || window.savedMonitorIndex === null) return;
        var opt = sel.querySelector('option[value="'+window.savedMonitorIndex+'"]');
        if (opt) sel.value = String(window.savedMonitorIndex);
      }
      window.onMonitorChange = function() {
        var idx = parseInt(document.getElementById('monitorSelect').value);
        if (!isNaN(idx)) ipcRenderer.send('update-settings', { monitor: idx });
      };

      ipcRenderer.send('get-monitors');
      ipcRenderer.on('monitors-list', function(ev, monitors) {
        var sel = document.getElementById('monitorSelect');
        sel.innerHTML = '';
        monitors.forEach(function(m, i) {
          var opt = document.createElement('option');
          opt.value = m.index;
          opt.textContent = 'Monitor '+(i+1)+' — '+m.width+'x'+m.height+(m.primary?' (Primary)':'');
          sel.appendChild(opt);
        });
        window.monitorsPopulated = true;
        applySavedMonitorSelection();
      });

      async function startAudioCapture() {
        try {
          var sources = await ipcRenderer.invoke('get-desktop-sources');
          var screen = sources[0];
          var stream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource:'desktop', chromeMediaSourceId:screen.id, minSampleRate:44100, echoCancellation:false, noiseSuppression:false, autoGainControl:false } },
            video: { mandatory: { chromeMediaSource:'desktop', chromeMediaSourceId:screen.id, maxWidth:1, maxHeight:1 } }
          });
          stream.getVideoTracks().forEach(function(t){t.stop();});
          var audioTrack = stream.getAudioTracks()[0];
          if (!audioTrack) return;
          var settings = audioTrack.getSettings();
          if (settings.sampleRate && settings.sampleRate < 44100) { stream.getTracks().forEach(function(t){t.stop();}); return; }
          var audioOnlyStream = new MediaStream([audioTrack]);
          window._liveDesktopStream = audioOnlyStream;
          window.mediaRecorder = new MediaRecorder(audioOnlyStream, { mimeType:'audio/webm;codecs=opus', audioBitsPerSecond:192000 });
          window.mediaRecorder.ondataavailable = async function(ev) {
            if (ev.data && ev.data.size > 0) ipcRenderer.send('save-audio-chunk', await ev.data.arrayBuffer());
          };
          window.mediaRecorder.onerror = function(e) { console.log('MediaRecorder error:', e); };
          window.mediaRecorder.start(10000);
          ipcRenderer.send('audio-recording-started', Date.now()+20);
          if (window.autoCaptureEnabled) window.acAttachDesktop(audioOnlyStream);
        } catch(err) { console.log('Audio capture failed:', err.name, err.message); }
      }

      window.startRecording = async function() {
        var monitorIndex = parseInt(document.getElementById('monitorSelect').value);
        var sourceLabel = document.getElementById('monitorSelect').options[document.getElementById('monitorSelect').selectedIndex].textContent;

        if (window.wgcMode === 'window') {
          if (!window.wgcSourceId) {
            hudLog('system', '⚠ Pick a game window first', 'error');
            openWindowPicker();
            return;
          }
          sourceLabel = window.wgcWindowName || 'Game Window';
          ipcRenderer.send('start-recording', { monitorIndex: monitorIndex, windowTitle: window.wgcSourceId });
        } else {
          ipcRenderer.send('start-recording', { monitorIndex: monitorIndex });
        }
        window.isRecordingActive = true;
        window.bufferReady = false;

        document.getElementById('startBtn').textContent = '↺ Switch Monitor';
        document.getElementById('stopBtn').disabled = false;
        document.getElementById('monitorActive').style.display = 'block';
        document.getElementById('monitorActiveName').textContent = sourceLabel;
        document.getElementById('statusText').textContent = '● Buffering gameplay...';
        document.getElementById('statusText').className = 'status-bar buffering';
        document.getElementById('statusHelp').textContent = 'Building up a clip buffer — highlights will be available in ~15 seconds';
        document.getElementById('saveBtn').disabled = true;


        // Stop any prior recorders (Switch Monitor path) — a second live
        // MediaRecorder would interleave headerless blobs into the new audio file
        if (window.mediaRecorder && window.mediaRecorder.state !== 'inactive') { window.mediaRecorder.stop(); }
        window.mediaRecorder = null;
        stopMicCapture();


        await startAudioCapture();
        await startMicCapture();

        if (window.socket) window.socket.emit('recording-status', { isRecording: true });

        // Best-effort game label for the session history row + squad view.
        // First detection wins server-side (see session-game-detected
        // handler in sockets/index.js), so an unreliable guess from one
        // member won't keep clobbering a confident match from another.
        try {
          var detected = await ipcRenderer.invoke('detect-game');
          if (detected && detected.name) {
            window.detectedGame = detected;
            if (window.currentSessionCode) {
              setSessionHistoryGame(window.currentSessionCode, detected.name);
              if (window.socket) window.socket.emit('session-game-detected', { game: detected.name });
            }
            hudLog('system', '🎮 Detected: ' + detected.name +
              (detected.known ? '' : ' (guess — rename in History if wrong)'), 'info');
          }
        } catch (e) {}
      };

      ipcRenderer.on('buffer-ready', function() {
        if (!window.isRecordingActive) return;
        window.bufferReady = true;
        document.getElementById('statusText').textContent = '● Ready — save a highlight anytime';
        document.getElementById('statusText').className = 'status-bar ready';
        document.getElementById('statusHelp').textContent = 'Click Save or press ' + window.currentHotkey + ' to capture the last ' + formatDuration(window.sessionClipDuration) + ' of gameplay';
        if (!window.highlightCooldownActive) document.getElementById('saveBtn').disabled = false;
        hudLog('system','🎬 Buffer ready — highlights can be saved','success');
      });

      window.stopRecording = function() {
      ipcRenderer.send('stop-recording');
      window.isRecordingActive = false;
      window.bufferReady = false;
      if (window.mediaRecorder && window.mediaRecorder.state !== 'inactive') { window.mediaRecorder.stop(); window.mediaRecorder = null; }
      wgcStopAll();
      stopMicCapture();
      window.acDetachAll();
      window._liveDesktopStream = null;
      window._liveMicStream = null;
      window.autoCaptureWindowActive = false;
      ipcRenderer.send('auto-capture-active', false);
      document.getElementById('startBtn').textContent = '▶ Start Highlight Session';
      document.getElementById('stopBtn').disabled = true;
      document.getElementById('saveBtn').disabled = true;
      document.getElementById('monitorActive').style.display = 'none';
      document.getElementById('statusText').textContent = '● Idle';
      document.getElementById('statusText').className = 'status-bar idle';
      document.getElementById('statusHelp').textContent = 'Start recording to begin buffering gameplay';
      if (window.socket) window.socket.emit('recording-status', { isRecording: false });
    };

    // =====================
      // WGC — GAME WINDOW CAPTURE (Beta)
      // =====================
      window.wgcMode = 'monitor';
      window.wgcSourceId = null;
      window.wgcWindowName = null;
      window.wgcStream = null;
      window.wgcRecorders = {};
      window.wgcLastChunkTime = 0;
      window.wgcHealthTimer = null;
      window.wgcCfg = null;

      window.onCaptureModeChange = function() {
        var mode = document.getElementById('captureModeSelect').value;
        window.wgcMode = mode;
        document.getElementById('wgcPickRow').style.display = (mode === 'window') ? 'block' : 'none';
        var fsToggle = document.getElementById('fullSessionToggle');
        if (mode === 'window') {
          if (fsToggle.checked) { fsToggle.checked = false; window.toggleFullSession(); }
          fsToggle.disabled = true;
          hudLog('system', 'Full Session recording requires Monitor mode', 'info');
        } else {
          fsToggle.disabled = false;
        }
        ipcRenderer.invoke('wgc-set-capture-mode', { mode: mode, windowTitle: window.wgcWindowName });
      };

      window.openWindowPicker = function() {
        document.getElementById('wgcPickerModal').style.display = 'block';
        window.refreshWindowPicker();
      };
      window.closeWindowPicker = function() {
        document.getElementById('wgcPickerModal').style.display = 'none';
      };
      // Click the dark backdrop to dismiss — a second way out if the ✕ ever
      // ends up somewhere unreachable again.
      document.getElementById('wgcPickerModal').addEventListener('click', function(e) {
        if (e.target.id === 'wgcPickerModal') window.closeWindowPicker();
      });
      window.wgcShowAllWindows = false;

      window.toggleWgcShowAll = function() {
        window.wgcShowAllWindows = document.getElementById('wgcShowAll').checked;
        window.refreshWindowPicker();
      };

      window.refreshWindowPicker = async function() {
        var grid = document.getElementById('wgcPickerGrid');
        grid.innerHTML = '<div style="color:#5f7a6a;">Loading windows...</div>';
        try {
          var result = await ipcRenderer.invoke('wgc-list-windows', { includeAll: window.wgcShowAllWindows });
          var sources = (result && result.windows) ? result.windows : [];
          var note = document.getElementById('wgcFilterNote');
          if (note) {
            note.textContent = (result && result.filtered && result.hiddenCount > 0)
              ? result.hiddenCount + ' non-game window(s) hidden'
              : '';
          }
          grid.innerHTML = '';
          sources.forEach(function(s) {
            var card = document.createElement('div');
            card.style.cssText = 'background:#12251a;border:1px solid #24402e;border-radius:7px;padding:8px;cursor:pointer;';
            card.onmouseenter = function(){ card.style.borderColor = '#39d3a0'; };
            card.onmouseleave = function(){ card.style.borderColor = '#24402e'; };
            var thumb = document.createElement('img');
            thumb.src = s.thumbnailDataUrl || '';
            thumb.style.cssText = 'width:100%;border-radius:4px;background:#04140d;min-height:90px;object-fit:contain;';
            var name = document.createElement('div');
            name.textContent = (s.knownGame ? '🎮 ' : '') + s.name;
            name.title = s.processName ? s.processName + '.exe' : s.name;
            name.style.cssText = 'font-size:12px;color:' + (s.knownGame ? '#39d3a0' : '#c8d6cd') + ';margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            card.appendChild(thumb); card.appendChild(name);
            card.onclick = function() {
              window.wgcSourceId = s.id;
              window.wgcWindowName = s.name;
              document.getElementById('wgcPickedName').textContent = '✓ ' + s.name;
              ipcRenderer.invoke('wgc-set-capture-mode', { mode: 'window', windowTitle: s.name });
              window.closeWindowPicker();
              hudLog('system', '🪟 Window selected: ' + s.name, 'success');
              if (window.pendingAutoStartAfterWindowPick) {
                window.pendingAutoStartAfterWindowPick = false;
                autoStartRecordingSafe();
              }
            };
            grid.appendChild(card);
          });
          if (!sources.length) {
            grid.innerHTML = '<div style="color:#5f7a6a;">' +
              (window.wgcShowAllWindows
                ? 'No capturable windows found'
                : 'No games detected — tick "Show all windows" if your game isn\'t listed') +
              '</div>';
          }
        } catch (e) {
          grid.innerHTML = '<div style="color:#f0857a;">Failed to list windows: ' + e.message + '</div>';
        }
      };

      function wgcPickCodec() {
        var prefs = ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
        for (var i = 0; i < prefs.length; i++) {
          if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
        }
        return 'video/webm';
      }

      function wgcCreateRecorder(fileId, cfg) {
        var rec = new MediaRecorder(window.wgcStream, {
          mimeType: wgcPickCodec(),
          videoBitsPerSecond: cfg.bitrate || 8000000
        });
        rec.ondataavailable = async function(ev) {
          if (ev.data && ev.data.size > 0) {
            window.wgcLastChunkTime = Date.now();
            ipcRenderer.send('wgc-chunk', { fileId: fileId, buf: await ev.data.arrayBuffer() });
          }
        };
        rec.onstart = function() {
          ipcRenderer.send('wgc-recorder-started', { fileId: fileId, fileStartUTC: Date.now() });
        };
        rec.onerror = function(e) {
          console.log('WGC recorder error:', e);
          ipcRenderer.send('wgc-capture-failed', { reason: 'MediaRecorder error' });
        };
        rec.start(1000);
        window.wgcRecorders[fileId] = rec;
        return rec;
      }

      async function wgcStartCapture(cfg) {
        window.wgcCfg = cfg;
        try {
          var videoConstraints = {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: cfg.sourceId,
              maxFrameRate: cfg.fps || 30
            }
          };
          if (cfg.resolution && cfg.resolution.height) {
            videoConstraints.mandatory.maxHeight = cfg.resolution.height;
          }
          window.wgcStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });

          var track = window.wgcStream.getVideoTracks()[0];
          if (track) track.onended = function() {
            ipcRenderer.send('wgc-capture-failed', { reason: 'Window closed' });
          };

          var init = await ipcRenderer.invoke('wgc-init-buffer');
          wgcCreateRecorder(init.fileId, cfg);
          window.wgcLastChunkTime = Date.now();

          if (window.wgcHealthTimer) clearInterval(window.wgcHealthTimer);
          window.wgcHealthTimer = setInterval(function() {
            if (!window.wgcStream) return;
            if (Date.now() - window.wgcLastChunkTime > 5000) {
              window.wgcLastChunkTime = Date.now();
              ipcRenderer.send('wgc-capture-failed', { reason: 'Chunk starvation' });
            }
          }, 2500);

          hudLog('system', '🎥 Capture: Window capture (Game Window Beta)', 'info');
        } catch (err) {
          console.log('WGC start failed:', err.name, err.message);
          ipcRenderer.send('wgc-capture-failed', { reason: err.message });
        }
      }

      function wgcStopAll() {
        if (window.wgcHealthTimer) { clearInterval(window.wgcHealthTimer); window.wgcHealthTimer = null; }
        Object.keys(window.wgcRecorders).forEach(function(fileId) {
          var rec = window.wgcRecorders[fileId];
          try { if (rec.state !== 'inactive') rec.stop(); } catch(e) {}
          setTimeout(function() { ipcRenderer.send('wgc-recorder-stopped', { fileId: fileId }); }, 500);
        });
        window.wgcRecorders = {};
        if (window.wgcStream) {
          window.wgcStream.getTracks().forEach(function(t){ t.stop(); });
          window.wgcStream = null;
        }
      }

      ipcRenderer.on('wgc-start-capture', function(ev, cfg) { wgcStartCapture(cfg); });
      ipcRenderer.on('wgc-stop-capture', function() { wgcStopAll(); });

      ipcRenderer.on('wgc-rollover-request', function(ev, d) {
        if (!window.wgcStream || !window.wgcCfg) return;
        var oldIds = Object.keys(window.wgcRecorders);
        wgcCreateRecorder(d.newFileId, window.wgcCfg);
        setTimeout(function() {
          oldIds.forEach(function(fileId) {
            var rec = window.wgcRecorders[fileId];
            if (rec) {
              try { if (rec.state !== 'inactive') rec.stop(); } catch(e) {}
              delete window.wgcRecorders[fileId];
              setTimeout(function() { ipcRenderer.send('wgc-recorder-stopped', { fileId: fileId }); }, 500);
            }
          });
        }, 1000);
      });

      ipcRenderer.on('wgc-restart-capture', function(ev, d) {
        hudLog('system', '⚠ Window capture died — auto-restarting (' + d.attempt + '/' + d.maxAttempts + ')', 'error');
        wgcStopAll();
        setTimeout(function() {
          if (window.isRecordingActive && window.wgcCfg) wgcStartCapture(window.wgcCfg);
        }, 1500);
      });

      ipcRenderer.on('wgc-fallback-to-monitor', function(ev, d) {
        hudLog('system', '⚠ ' + d.reason, 'error');
        wgcStopAll();
        window.wgcMode = 'monitor';
        document.getElementById('captureModeSelect').value = 'monitor';
        document.getElementById('wgcPickRow').style.display = 'none';
        document.getElementById('fullSessionToggle').disabled = false;
      });

      // Restore capture mode on launch
      ipcRenderer.invoke('wgc-get-capture-mode').then(function(state) {
        if (state && state.mode === 'window') {
          document.getElementById('captureModeSelect').value = 'window';
          window.wgcMode = 'window';
          document.getElementById('wgcPickRow').style.display = 'block';
          document.getElementById('fullSessionToggle').disabled = true;
          if (state.lastWindowTitle) {
            window.wgcWindowName = state.lastWindowTitle;
            document.getElementById('wgcPickedName').textContent = 'Last used: ' + state.lastWindowTitle + ' — pick again to confirm';
          }
        }
      }).catch(function() {});

      // =====================
      // FULL SESSION MODE
      // =====================
      window.toggleFullSession = function() {
        var enabled = document.getElementById('fullSessionToggle').checked;
        document.getElementById('fsOptions').style.display = enabled ? 'block' : 'none';
        ipcRenderer.send('set-full-session-mode', enabled);
        hudLog('system', enabled
          ? '🎥 Full Session Mode ON — entire recording will be saved locally on End Session'
          : 'Full Session Mode off — only highlights are saved', enabled ? 'success' : 'info');
      };

      window.pickFullSessionDir = async function() {
        try {
          var result = await ipcRenderer.invoke('pick-fullsession-directory');
          if (result && result.success) {
            document.getElementById('fsLocPath').textContent = result.path;
            hudLog('system', '📁 Full session archive location set', 'info');
          }
        } catch (e) {
          hudLog('system', '⚠ Could not set archive location', 'error');
        }
      };

      window.resetFullSessionDir = async function() {
        try {
          await ipcRenderer.invoke('clear-fullsession-directory');
          document.getElementById('fsLocPath').textContent = 'default (next to highlights)';
          hudLog('system', 'Archive location reset to default', 'info');
        } catch (e) {}
      };

      // Restore saved state on launch
      ipcRenderer.invoke('get-full-session-mode').then(function(enabled) {
        if (enabled) {
          document.getElementById('fullSessionToggle').checked = true;
          document.getElementById('fsOptions').style.display = 'block';
        }
      });
      ipcRenderer.invoke('get-fullsession-directory').then(function(p) {
        if (p) document.getElementById('fsLocPath').textContent = p;
      }).catch(function() {});

      // Archive / disk feedback from main process
      ipcRenderer.on('archive-complete', function(ev, d) {
        hudLog('activity', '✅ Full session saved (' + d.sizeMB + ' MB): ' + d.path, 'success');
      });
      ipcRenderer.on('archive-failed', function(ev, d) {
        hudLog('system', '⚠ Full session save failed — temp files kept in ' + d.path, 'error');
      });
      ipcRenderer.on('archive-started', function(ev, d) {
        hudLog('activity', '💾 Saving full session (' + d.chunks + ' segments)...', 'info');
      });
      ipcRenderer.on('disk-warning', function(ev, d) {
        var banner = document.getElementById('diskBanner');
        if (banner) { banner.textContent = '⚠ Low disk: ' + d.freeGB + 'GB free'; banner.style.display = 'block'; }
        hudLog('system', '⚠ Low disk space: ' + d.freeGB + 'GB free', 'error');
      });
      ipcRenderer.on('disk-critical', function(ev, d) {
        hudLog('system', '🛑 Disk critical (' + d.freeGB + 'GB) — recording auto-stopped', 'error');
      });

      // =====================
      // SAVE HIGHLIGHT
      // =====================
      window.saveHighlight = function() {
        if (window.highlightCooldownActive) return;
        if (!window.isRecordingActive) return;
        if (!window.bufferReady) { hudLog('system','⏳ Buffer not ready yet','error'); return; }
        if (window.socket && window.currentSessionCode) {
          window.socket.emit('broadcast-save-highlight');
        } else {
          ipcRenderer.send('save-highlight');
          startSaveCooldown(15);
        }
      };

      function startSaveCooldown(seconds) {
       // Auto-capture can re-trigger before the last cooldown finished —
       // without this, orphaned intervals stack up and fight over the label.
       if (window.highlightCooldownTimer) {
         clearInterval(window.highlightCooldownTimer);
         window.highlightCooldownTimer = null;
       }
       window.highlightCooldownActive = true;
       var remaining = seconds || 15;
       var btn = document.getElementById('saveBtn');
       btn.innerHTML = '⏳ '+remaining+'s before next save';
       btn.disabled = true;
        
       // Update status bar to reflect cooldown
       document.getElementById('statusText').textContent = '● Cooldown — buffer refilling...';
       document.getElementById('statusText').className = 'status-bar buffering';
       document.getElementById('statusHelp').textContent = 'Next highlight available in ' + remaining + ' seconds';

       window.highlightCooldownTimer = setInterval(function() {
         remaining--;
         if (remaining <= 0) {
           clearInterval(window.highlightCooldownTimer);
           window.highlightCooldownTimer = null;
           window.highlightCooldownActive = false;
           btn.innerHTML = '💾 Save Highlight (or press <span id="saveBtnHotkey">'+window.currentHotkey+'</span>)';
           btn.disabled = !(window.isRecordingActive && window.bufferReady);

           restoreReadyStatus();
         } else {
           btn.innerHTML = '⏳ '+remaining+'s before next save';
           document.getElementById('statusHelp').textContent = 'Next highlight available in ' + remaining + ' seconds';
         }
       }, 1000);
      }

      // =====================
      // DEEP LINK JOIN — peakabu://join/<CODE> from a shared invite.
      // Arrives either at cold start (consume-deep-link) or while running
      // (deep-link-join push). If the user isn't logged in yet the link is
      // parked and replayed the moment auth succeeds.
      // =====================
      window.pendingDeepLink = null;
      window.autoStartAfterJoin = false;

      window.copyInviteLink = async function() {
        if (!window.currentSessionCode) return;
        var url = await ipcRenderer.invoke('get-join-link', window.currentSessionCode);
        if (!url) return;
        clipboard.writeText(url);
        var hint = document.getElementById('sessionCodeHint');
        hint.textContent = '\u2705 Invite link copied — paste it in Discord';
        setTimeout(function() { hint.textContent = 'Click the code to copy to clipboard'; }, 3000);
        hudLog('squad', 'Invite link copied: ' + url, 'success');
      };

      async function handleDeepLink(link) {
        if (!link || !link.code) return;

        if (!window.authToken) {
          window.pendingDeepLink = link;
          hudLog('system', '\uD83D\uDD17 Invite to ' + link.code + ' — log in to join', 'info');
          return;
        }

        if (window.currentSessionCode === link.code) {
          hudLog('squad', 'Already in session ' + link.code, 'info');
          if (link.autostart) await autoStartRecordingSafe();
          return;
        }

        if (window.currentSessionCode) {
          hudLog('squad', 'Leaving ' + window.currentSessionCode + ' for invite ' + link.code, 'info');
          window.leaveSession();
        }

        window.autoStartAfterJoin = !!link.autostart;
        document.getElementById('joinCodeInput').value = link.code;
        hudLog('squad', '\uD83D\uDD17 Joining ' + link.code + ' from invite...', 'broadcast');
        window.isSessionHost = false;
        connectToSession(link.code, window.authUsername);
      }

      async function autoStartRecordingSafe() {
        if (window.isRecordingActive) {
          hudLog('system', 'Already recording — invite joined without restarting capture', 'info');
          return;
        }

        // Monitor list populates asynchronously; don't start against a
        // placeholder option or FFmpeg gets a NaN monitor index.
        var sel = document.getElementById('monitorSelect');
        for (var i = 0; i < 25; i++) {
          if (sel.options.length && sel.options[0].value !== '') break;
          await new Promise(function(r) { setTimeout(r, 150); });
        }
        if (!sel.options.length || sel.options[0].value === '') {
          hudLog('system', '\u26A0 Joined, but monitors not detected — press Start manually', 'error');
          return;
        }

        // WGC source IDs don't survive a restart, so an invite arriving in
        // Window mode has no handle to record. Open the picker and resume
        // auto-start the moment they choose one.
        if (window.wgcMode === 'window' && !window.wgcSourceId) {
          window.pendingAutoStartAfterWindowPick = true;
          hudLog('system', '\uD83E\uDE9F Joined — pick your game window to start recording', 'info');
          window.openWindowPicker();
          return;
        }

        hudLog('activity', '\u25B6 Auto-starting capture from invite', 'success');
        await window.startRecording();
      }

      window.consumePendingDeepLink = function() {
        var link = window.pendingDeepLink;
        window.pendingDeepLink = null;
        if (link) handleDeepLink(link);
      };

      ipcRenderer.on('deep-link-join', function(ev, link) { handleDeepLink(link); });

      ipcRenderer.on('hotkey-save-pressed', function() { window.saveHighlight(); });
      // =====================
      // GAMEPAD CONTROLLER SUPPORT
      // =====================
      window.gamepadState = {
        enabled: false,
        buttonIndex: null,
        triggerMode: 'double', // 'double' or 'long'
        // internal tracking
        lastPressTime: 0,
        isHeld: false,
        holdStart: 0,
        fired: false,
        pollInterval: null
      };

      // Standard gamepad button names (Xbox layout — covers most controllers)
      var GAMEPAD_BUTTON_NAMES = [
        'A', 'B', 'X', 'Y',
        'LB', 'RB', 'LT', 'RT',
        'Back/Select', 'Start/Menu',
        'L-Stick Press', 'R-Stick Press',
        'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right',
        'Xbox/Home'
      ];

      function getButtonName(index) {
        return GAMEPAD_BUTTON_NAMES[index] || ('Button ' + index);
      }

      // Detect gamepad connect / disconnect
      window.gamepadDetected = false;

      window.addEventListener('gamepadconnected', function(e) {
        if (window.gamepadDetected) return;
        window.gamepadDetected = true;
        hudLog('system', '🎮 Controller connected: ' + e.gamepad.id, 'success');
        document.getElementById('gamepadStatus').textContent = '✓ Connected';
        document.getElementById('gamepadStatus').className = 'gamepad-status connected';
        populateGamepadButtons(e.gamepad);
        startGamepadPoll();
      });

      window.addEventListener('gamepaddisconnected', function(e) {
        // Check if ANY gamepad is still connected
        var gamepads = navigator.getGamepads();
        var anyLeft = false;
        for (var i = 0; i < gamepads.length; i++) { if (gamepads[i]) { anyLeft = true; break; } }
        if (!anyLeft) {
          window.gamepadDetected = false;
          hudLog('system', '🎮 Controller disconnected', 'info');
          document.getElementById('gamepadStatus').textContent = 'No controller';
          document.getElementById('gamepadStatus').className = 'gamepad-status disconnected';
          stopGamepadPoll();
        }
      });

      // Fallback: Electron often won't fire gamepadconnected if the
      // controller was plugged in before launch or if no button has been
      // pressed yet. Poll every 2s until we find one.
      window.gamepadScanInterval = setInterval(function() {
        if (window.gamepadDetected) return;
        var gamepads = navigator.getGamepads();
        for (var i = 0; i < gamepads.length; i++) {
          if (gamepads[i] && gamepads[i].connected) {
            window.gamepadDetected = true;
            hudLog('system', '🎮 Controller found: ' + gamepads[i].id, 'success');
            document.getElementById('gamepadStatus').textContent = '✓ Connected';
            document.getElementById('gamepadStatus').className = 'gamepad-status connected';
            populateGamepadButtons(gamepads[i]);
            startGamepadPoll();
            break;
          }
        }
      }, 2000);

      function populateGamepadButtons(gamepad) {
        var sel = document.getElementById('gamepadButtonSelect');
        var prevVal = sel.value;
        sel.innerHTML = '<option value="">Disabled</option>';
        for (var i = 0; i < gamepad.buttons.length; i++) {
          var opt = document.createElement('option');
          opt.value = i;
          opt.textContent = getButtonName(i);
          sel.appendChild(opt);
        }
        // Restore previous selection if still valid
        if (prevVal && parseInt(prevVal) < gamepad.buttons.length) {
          sel.value = prevVal;
        }
        // Restore from saved prefs
        if (window.gamepadState.buttonIndex !== null) {
          sel.value = window.gamepadState.buttonIndex;
        }
      }

      document.getElementById('gamepadButtonSelect').addEventListener('change', function() {
        onGamepadSettingsChange();
      });

      window.onGamepadSettingsChange = function() {
        var btnVal = document.getElementById('gamepadButtonSelect').value;
        var mode = document.getElementById('gamepadTriggerMode').value;
        window.gamepadState.buttonIndex = btnVal === '' ? null : parseInt(btnVal);
        window.gamepadState.enabled = window.gamepadState.buttonIndex !== null;
        window.gamepadState.triggerMode = mode;
        // Reset tracking state
        window.gamepadState.lastPressTime = 0;
        window.gamepadState.isHeld = false;
        window.gamepadState.holdStart = 0;
        window.gamepadState.fired = false;

        if (window.gamepadState.enabled) {
          var btnName = getButtonName(window.gamepadState.buttonIndex);
          var modeLabel = mode === 'double' ? 'double-press' : 'long-press (~1s)';
          document.getElementById('gamepadBindHint').textContent = btnName + ' — ' + modeLabel + ' to save';
          startGamepadPoll();
        } else {
          document.getElementById('gamepadBindHint').textContent = 'Select a button, then choose trigger mode';
        }

        // Persist
        ipcRenderer.invoke('set-user-pref', 'gamepadButton', btnVal === '' ? null : parseInt(btnVal));
        ipcRenderer.invoke('set-user-pref', 'gamepadTriggerMode', mode);
      };

      function startGamepadPoll() {
        if (window.gamepadState.pollInterval) return;
        window.gamepadState.pollInterval = setInterval(pollGamepad, 16); // ~60Hz
      }

      function stopGamepadPoll() {
        if (window.gamepadState.pollInterval) {
          clearInterval(window.gamepadState.pollInterval);
          window.gamepadState.pollInterval = null;
        }
      }

      function pollGamepad() {
        if (!window.gamepadState.enabled) return;

        var gamepads = navigator.getGamepads();
        var gp = null;
        for (var i = 0; i < gamepads.length; i++) {
          if (gamepads[i]) { gp = gamepads[i]; break; }
        }
        if (!gp) return;

        var btnIdx = window.gamepadState.buttonIndex;
        if (btnIdx === null || btnIdx >= gp.buttons.length) return;

        var pressed = gp.buttons[btnIdx].pressed;
        var now = Date.now();
        var st = window.gamepadState;

        if (st.triggerMode === 'long') {
          // LONG PRESS: held for 800ms
          if (pressed) {
            if (!st.isHeld) {
              st.isHeld = true;
              st.holdStart = now;
              st.fired = false;
            } else if (!st.fired && (now - st.holdStart) >= 800) {
              st.fired = true;
              window.saveHighlight();
              hudLog('system', '🎮 Long-press save triggered', 'success');
            }
          } else {
            st.isHeld = false;
            st.fired = false;
          }
        } else {
          // DOUBLE PRESS: two presses within 400ms
          if (pressed) {
            if (!st.isHeld) {
              st.isHeld = true;
              if (now - st.lastPressTime < 400) {
                // Second press within window — fire!
                st.lastPressTime = 0;
                st.fired = true;
                window.saveHighlight();
                hudLog('system', '🎮 Double-press save triggered', 'success');
              } else {
                st.lastPressTime = now;
              }
            }
          } else {
            st.isHeld = false;
          }
        }
      }

      // Load saved gamepad prefs
      ipcRenderer.invoke('get-user-pref', 'gamepadButton').then(function(val) {
        if (val !== null && val !== undefined) {
          window.gamepadState.buttonIndex = parseInt(val);
          window.gamepadState.enabled = true;
          document.getElementById('gamepadButtonSelect').value = val;
        }
      });
      ipcRenderer.invoke('get-user-pref', 'gamepadTriggerMode').then(function(val) {
        if (val) {
          window.gamepadState.triggerMode = val;
          document.getElementById('gamepadTriggerMode').value = val;
        }
      });
      ipcRenderer.on('post-capture-started', function(ev, d) { hudLog('activity','📹 Capturing post-highlight footage ('+((d.postDelay)/1000).toFixed(1)+'s)...','info'); });
      ipcRenderer.on('encoder-fallback', function(ev, enc) { hudLog('system','⚙ GPU unavailable — switched to '+enc+' encoding','info'); });
      ipcRenderer.on('capture-engine', function(ev, label) {
       hudLog('system', '🎥 Capture: ' + label, 'info');
      });
      ipcRenderer.on('highlight-saved', function(ev, fp) { hudLog('activity','✅ Saved: '+fp,'success'); });
      ipcRenderer.on('highlight-error', function(ev, msg) { hudLog('activity','❌ '+msg,'error'); });

      ipcRenderer.on('upload-progress', function(ev, pct) {
        var wrap = document.getElementById('uploadProgressWrap');
        var fill = document.getElementById('uploadProgressFill');
        var label = document.getElementById('uploadPct');
        if (pct===0) { wrap.style.display='block'; fill.className='upload-progress-fill'; fill.style.width='0%'; label.textContent='0%'; }
        else if (pct===100) { fill.style.width='100%'; fill.classList.add('success'); label.textContent='100%'; setTimeout(function(){wrap.style.display='none';},2000); }
        else if (pct===-1) { fill.classList.add('error'); label.textContent='Failed'; setTimeout(function(){wrap.style.display='none';},3000); }
        else { fill.style.width=pct+'%'; label.textContent=pct+'%'; }
      });

      ipcRenderer.on('upload-complete', function(ev, id) { hudLog('activity','☁️ Upload complete: '+id,'success'); });

      // =====================
      // AUTO-UPDATER BANNER
      // main.js updater sends: update-available, update-progress,
      // update-ready, update-failed. Banner HTML already exists — this
      // wiring was missing, so updates silently never surfaced.
      // =====================
      ipcRenderer.on('update-available', function(ev, d) {
        document.getElementById('updateTitle').textContent = 'Update v' + d.version + ' available';
        document.getElementById('updateSubtitle').textContent = ' — downloading in background…';
        document.getElementById('updateBarWrap').style.display = 'block';
        document.getElementById('updateBarFill').style.width = '0%';
        document.getElementById('updateActions').style.display = 'none';
        document.getElementById('updateBanner').classList.add('show');
        hudLog('system', '⬇ Update v' + d.version + ' found — downloading…', 'info');
      });

      ipcRenderer.on('update-progress', function(ev, d) {
        document.getElementById('updateBarFill').style.width = (d.pct || 0) + '%';
      });

      ipcRenderer.on('update-ready', function(ev, d) {
        document.getElementById('updateSubtitle').textContent = ' — ready to install';
        document.getElementById('updateBarWrap').style.display = 'none';
        document.getElementById('updateActions').style.display = 'flex';
        document.getElementById('updateBanner').classList.add('show');
        hudLog('system', '✅ Update downloaded — restart when ready', 'success');
      });

      ipcRenderer.on('update-failed', function() {
        document.getElementById('updateBanner').classList.remove('show');
        hudLog('system', '⚠ Update download failed — will retry next launch', 'error');
      });

      window.installUpdate = function() {
        ipcRenderer.send('install-update');
        document.getElementById('updateSubtitle').textContent = ' — installing…';
        document.getElementById('updateActions').style.display = 'none';
      };

      window.dismissUpdate = function() {
        document.getElementById('updateBanner').classList.remove('show');
        hudLog('system', 'Update postponed — it will install next launch', 'info');
      };
      ipcRenderer.on('upload-error', function(ev, msg) {
        hudLog('activity','⚠ Upload failed: '+msg,'error');
        if (typeof msg === 'string' && /invalid or expired token|authentication required/i.test(msg)) {
          hudLog('system','🔒 Login expired — please log in again','error');
          logoutUser();
        }
      });

      window.updateSettings = function() {
       ipcRenderer.send('update-settings', {
         bufferSeconds: '180',
         fps: parseInt(document.getElementById('fpsSelect').value),
         resolution: document.getElementById('resolutionSelect').value,
         hdr: document.getElementById('hdrSelect').value === 'hdr'
       });
      };
      window.addEventListener('DOMContentLoaded', function() {
       ipcRenderer.invoke('get-saved-settings').then(function(saved) {
         if (saved.fps) document.getElementById('fpsSelect').value = String(saved.fps);
         if (saved.resolution) document.getElementById('resolutionSelect').value = saved.resolution;
         document.getElementById('hdrSelect').value = saved.hdr ? 'hdr' : 'sdr';
         window.savedMonitorIndex = (typeof saved.monitorIndex === 'number') ? saved.monitorIndex : null;
         applySavedMonitorSelection();
       });
      });

    ipcRenderer.on('capture-engine', function(ev, label) {
      hudLog('system', '🎥 Capture: ' + label, 'info');
    });
      ipcRenderer.invoke('get-current-hdr').then(function(isHdr) {
       document.getElementById('hdrSelect').value = isHdr ? 'hdr' : 'sdr';
      });

      // =====================
      // AUTH
      // =====================

      // Show confirm field when user focuses password (register intent)
      

      async function checkAuthOnLoad() {
       var stored = await ipcRenderer.invoke('get-auth-state');
       window.authToken = stored.token;
       window.authUsername = stored.username;
       if (!window.authToken) { showAuthLoggedOut(); return; }
        
       // Push restored token to main process so uploads are authenticated
       ipcRenderer.send('auth-token-updated', window.authToken);
        
       try {
         var res = await fetch('https://peakabu.app/auth/me', { headers: { 'Authorization':'Bearer '+window.authToken } });
         if (res.ok) { var d = await res.json(); updateTierBadge(d.tier); showAuthLoggedIn(d.username); }
         else if (res.status === 401) { clearAuthState(); showAuthLoggedOut(); }
         else { if (window.authUsername) showAuthLoggedIn(window.authUsername); else showAuthLoggedOut(); }
       } catch(e) {
         if (window.authUsername) showAuthLoggedIn(window.authUsername);
         else showAuthLoggedOut();
       }
      }

      window.registerUser = async function() {
      var confirmWrap = document.getElementById('authConfirmWrap');
      if (confirmWrap.style.display === 'none' || confirmWrap.style.display === '') {
        confirmWrap.style.display = 'block';
        document.getElementById('authConfirmInput').focus();
        showAuthError('Re-enter your password to confirm, then click Register again');
        return;
      }
      var username = document.getElementById('authUsernameInput').value.trim();
      var password = document.getElementById('authPasswordInput').value;
      var confirm = document.getElementById('authConfirmInput').value;
      if (!username || !password) { showAuthError('Fill in all fields'); return; }
      if (password !== confirm) { showAuthError('Passwords do not match'); return; }
        try {
          var res = await fetch('https://peakabu.app/auth/register', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ username:username, password:password })
          });
          var data = await res.json();
          if (!res.ok) { showAuthError(data.error||'Registration failed'); return; }
          storeAuthState(data.token, data.username);
          updateTierBadge(data.tier || 't1');
          showAuthLoggedIn(data.username);
        } catch(e) { showAuthError('Could not reach server'); }
      };

      window.loginUser = async function() {
        var username = document.getElementById('authUsernameInput').value.trim();
        var password = document.getElementById('authPasswordInput').value;
        if (!username || !password) { showAuthError('Fill in both fields'); return; }
        try {
          var res = await fetch('https://peakabu.app/auth/login', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ username:username, password:password })
          });
          var data = await res.json();
          if (!res.ok) { showAuthError(data.error||'Login failed'); return; }
          storeAuthState(data.token, data.username);
          updateTierBadge(data.tier);
          showAuthLoggedIn(data.username);
        } catch(e) { showAuthError('Could not reach server'); }
      };

      window.logoutUser = function() {
        clearAuthState();
        showAuthLoggedOut();
        updateTierBadge('t1');
        document.getElementById('redeemPanel').classList.remove('show');
        if (window.socket) { window.socket.disconnect(); window.socket = null; }
        window.currentSessionCode = null;
        document.getElementById('sessionPanel-disconnected').style.display = 'block';
        document.getElementById('sessionPanel-connected').style.display = 'none';
        document.getElementById('memberList').innerHTML = '';
        ipcRenderer.send('auth-token-updated', null);
        ipcRenderer.send('session-disconnected');
        document.getElementById('authConfirmWrap').style.display = 'none';
      };

      function storeAuthState(token, username) {
        window.authToken = token;
        window.authUsername = username;
        ipcRenderer.send('auth-token-updated', token);
        ipcRenderer.invoke('set-auth-state', { token: token, username: username });
      }
      function clearAuthState() {
        window.authToken = null;
        window.authUsername = null;
        ipcRenderer.send('auth-token-updated', null);
        ipcRenderer.invoke('set-auth-state', { token: null, username: null });
      }
      function showAuthLoggedIn(username) {
        window.authUsername = username;
        document.getElementById('authPanel').style.display = 'none';
        document.getElementById('authBar').style.display = 'flex';
        document.getElementById('authBarName').textContent = username;
        document.getElementById('sessionPanel').style.display = 'flex';
        if (window.consumePendingDeepLink) window.consumePendingDeepLink();
      }
      function showAuthLoggedOut() {
        document.getElementById('authPanel').style.display = 'block';
        document.getElementById('authBar').style.display = 'none';
        document.getElementById('sessionPanel').style.display = 'none';
      }
      function showAuthError(msg) {
        var el = document.getElementById('authError');
        el.textContent = msg; el.style.display = 'block';
        setTimeout(function(){ el.style.display = 'none'; }, 4000);
      }

      // =====================
      // TIER + REDEMPTION
      // Codes are generated server-side (admin only) and can be gifted —
      // whoever redeems one gets the tier, so a backer can hand theirs off.
      // =====================
      window.currentTier = 't1';
      var TIER_LABELS = { t1: 'Free', t2: 'Creator', t3: 'Squad', t4: 'Pro', t5: 'Peak-Abu Founder' };

      function updateTierBadge(tier) {
        window.currentTier = tier || 't1';
        var badge = document.getElementById('tierBadge');
        if (badge) {
          badge.className = 'tier-badge ' + window.currentTier;
          badge.textContent = TIER_LABELS[window.currentTier] || 'Free';
        }
        acUpdateTierGate();
      }

      function acUpdateTierGate() {
        var toggle = document.getElementById('autoCaptureToggle');
        var note = document.getElementById('acLockedNote');
        if (!toggle) return;
        var locked = (window.currentTier === 't1');
        toggle.disabled = locked;
        if (note) note.style.display = locked ? 'block' : 'none';
        if (locked && window.autoCaptureEnabled) {
          toggle.checked = false;
          acCommitEnabled(false);
        }
      }


      window.toggleRedeemPanel = function() {
        var p = document.getElementById('redeemPanel');
        p.classList.toggle('show');
        if (p.classList.contains('show')) {
          document.getElementById('redeemMsg').textContent = '';
          document.getElementById('redeemInput').focus();
        }
      };

      window.submitRedeem = async function() {
        var input = document.getElementById('redeemInput');
        var msg = document.getElementById('redeemMsg');
        var code = input.value.trim().toUpperCase();
        if (!code) { msg.className = 'redeem-msg err'; msg.textContent = 'Enter a code first'; return; }

        msg.className = 'redeem-msg';
        msg.textContent = 'Checking...';
        try {
          var res = await fetch('https://peakabu.app/auth/redeem', {
            method: 'POST',
            headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+window.authToken },
            body: JSON.stringify({ code: code })
          });
          var data = await res.json();
          if (!res.ok) {
            msg.className = 'redeem-msg err';
            msg.textContent = data.error || 'Could not redeem that code';
            return;
          }
          updateTierBadge(data.tier);
          input.value = '';
          msg.className = 'redeem-msg ok';
          msg.textContent = '✅ ' + (TIER_LABELS[data.tier] || data.tier) + ' unlocked!';
          hudLog('system', '🎟 Code redeemed — ' + (TIER_LABELS[data.tier] || data.tier) + ' tier active', 'success');
          setTimeout(function() { document.getElementById('redeemPanel').classList.remove('show'); }, 2500);
        } catch (e) {
          msg.className = 'redeem-msg err';
          msg.textContent = 'Could not reach server';
        }
      };

      // Close the redeem panel on outside click
      document.addEventListener('click', function(e) {
        var panel = document.getElementById('redeemPanel');
        if (!panel || !panel.classList.contains('show')) return;
        if (panel.closest('.redeem-wrap').contains(e.target)) return;
        panel.classList.remove('show');
      });

      ipcRenderer.invoke('consume-deep-link')
        .then(function(link) { if (link) window.pendingDeepLink = link; })
        .catch(function() {})
        .then(function() { checkAuthOnLoad(); });

    