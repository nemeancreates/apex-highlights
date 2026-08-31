/*
 * appearance.js — themes and animated wallpaper for the Peak-Abu window.
 *
 *     const ap = new PeakAbuAppearance({ basePath: 'modules/appearance' });
 *     await ap.mount();                       // installs the wallpaper layer
 *     ap.renderPanel(document.getElementById('settings'));   // optional UI
 *
 * WALLPAPER WITHOUT PRE-CONVERSION
 * --------------------------------
 * Whatever the user picks is displayed as-is. Chromium already decodes every
 * format that matters, so there is nothing to transcode:
 *
 *   still images (png/jpg/webp/avif)  ->  <img>
 *   animated GIF / APNG / animated WebP -> <img>, browser animates it
 *   video (mp4/webm/mkv/mov)          ->  <video muted loop playsinline>
 *
 * The only classification needed is "does this go in an <img> or a <video>",
 * decided from the MIME type with a file-extension fallback.
 *
 * PERFORMANCE, WHICH IS THE WHOLE PROBLEM
 * ---------------------------------------
 * This is a game capture app. A looping 4K video behind the UI competes for
 * GPU with the thing the user actually came here to record, and Peak-Abu's
 * window is usually not even visible while a match is running. So the
 * wallpaper suspends itself aggressively:
 *
 *   - while a capture/recording is active      (setRecording(true))
 *   - while the window is hidden or minimised  (visibilitychange)
 *   - while the window is not focused          (blur, optional)
 *   - when the OS asks for reduced motion      (prefers-reduced-motion)
 *
 * Video pauses outright. GIFs cannot be paused through the DOM, so the first
 * frame is copied to a canvas and swapped in — the animation genuinely stops
 * rather than merely being hidden.
 *
 * STORAGE
 * -------
 * Settings read and write through an injectable adapter. The demo passes
 * localStorage; in the app, pass one backed by user-preferences.json so the
 * choice persists the same way every other Peak-Abu setting does.
 *
 * The wallpaper FILE is handled separately. Electron gives a real path via
 * File.path, so it persists by reference. A browser gives only a blob: URL
 * that dies with the page, so the bytes go to IndexedDB and a fresh object
 * URL is minted on load.
 */

(function (global) {
  'use strict';

  var VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|ogv)$/i;
  var IMAGE_EXT = /\.(gif|png|jpe?g|webp|avif|apng|bmp)$/i;

  // Above this, warn. Animated wallpapers are decoded to raw frames in
  // memory, so a 200MB GIF is not a 200MB problem, it is much worse.
  var SIZE_WARN_BYTES = 40 * 1024 * 1024;

  var PRESET_COLORS = [
    { id: 'teal',   name: 'Teal',   accent: '#39d3a0', accentBright: '#4fe0b0' },
    { id: 'blue',   name: 'Blue',   accent: '#6c8cff', accentBright: '#8aa4ff' },
    { id: 'orange', name: 'Orange', accent: '#ff8a4c', accentBright: '#ffa672' },
    { id: 'violet', name: 'Violet', accent: '#b07cff', accentBright: '#c49aff' },
    { id: 'rose',   name: 'Rose',   accent: '#ff5f7e', accentBright: '#ff7f98' },
    { id: 'gold',   name: 'Gold',   accent: '#d8a838', accentBright: '#e8c058' }
  ];

  var PRESET_THEMES = [
    {
      id: 'peak-dark', name: 'Peak Dark', theme: 'dark',
      tokens: {}                       // the shipping palette
    },
    {
      id: 'peak-light', name: 'Peak Light', theme: 'light', tokens: {}
    },
    {
      id: 'midnight', name: 'Midnight', theme: 'dark',
      tokens: {
        '--pa-bg': '#0b1020', '--pa-panel': '#141a2e', '--pa-panel-sunk': '#0e1424',
        '--pa-border': '#25304d', '--pa-border-strong': '#2f3d61',
        '--pa-accent': '#6c8cff', '--pa-accent-bright': '#8aa4ff',
        '--pa-text': '#ccd4e8', '--pa-text-dim': '#93a3c9', '--pa-text-faint': '#5f6d90'
      }
    },
    {
      id: 'ember', name: 'Ember', theme: 'dark',
      tokens: {
        '--pa-bg': '#1a0e0a', '--pa-panel': '#2a1712', '--pa-panel-sunk': '#20110d',
        '--pa-border': '#3d251c', '--pa-border-strong': '#4d2f23',
        '--pa-accent': '#ff8a4c', '--pa-accent-bright': '#ffa672',
        '--pa-text': '#e8d5cb', '--pa-text-dim': '#c29d89', '--pa-text-faint': '#8a6b5c'
      }
    },
    {
      id: 'mono', name: 'Mono', theme: 'dark',
      tokens: {
        '--pa-bg': '#0e0e0e', '--pa-panel': '#191919', '--pa-panel-sunk': '#131313',
        '--pa-border': '#2a2a2a', '--pa-border-strong': '#383838',
        '--pa-accent': '#e0e0e0', '--pa-accent-bright': '#ffffff',
        '--pa-text': '#d4d4d4', '--pa-text-dim': '#9a9a9a', '--pa-text-faint': '#6a6a6a'
      }
    }
  ];

  var DEFAULT_STATE = {
    theme: 'dark',
    themeId: 'peak-dark',
    tokens: {},
    bgColor: null,
    recentThemeIds: [],   // NEW — most-recent-first, capped at 6
    recentColorIds: [],   
    wallpaper: null,          // { src, name, kind, size, fit }
    fit: 'cover',
    dim: 0.35,
    blur: 0,
    panelOpacity: 0.82,
    animate: true,
    pauseWhileRecording: true,
    pauseWhenUnfocused: false,
    respectReducedMotion: true
  };

  /**
   * Tiny IndexedDB blob store, used only in the browser.
   *
   * Electron hands us a real filesystem path via File.path, which persists on
   * its own. A browser gives only a blob: URL, which dies with the page — so
   * without somewhere to keep the actual bytes, a wallpaper picked in the demo
   * disappears on every refresh. localStorage cannot hold binary of this size;
   * IndexedDB stores the Blob itself and we mint a fresh object URL on load.
   */
  var BLOB_DB = 'peakabu-appearance';
  var BLOB_STORE = 'wallpapers';
  var BLOB_MAX_BYTES = 96 * 1024 * 1024;

  function pushRecent(list, id, cap) {
    var next = [id].concat((list || []).filter(function (x) { return x !== id; }));
    return next.slice(0, cap || 6);
  }

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('no indexedDB'));
      var req = indexedDB.open(BLOB_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbPut(key, blob) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).put(blob, key);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(BLOB_STORE, 'readonly');
        var r = tx.objectStore(BLOB_STORE).get(key);
        r.onsuccess = function () { db.close(); resolve(r.result || null); };
        r.onerror = function () { db.close(); reject(r.error); };
      });
    });
  }

  function idbDelete(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).delete(key);
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); resolve(false); };
      });
    });
  }

  function memoryStore() {
    var mem = {};
    return {
      get: function (k) { return Promise.resolve(mem[k]); },
      set: function (k, v) { mem[k] = v; return Promise.resolve(); }
    };
  }

  function localStore(key) {
    return {
      get: function () {
        try { return Promise.resolve(JSON.parse(localStorage.getItem(key) || 'null')); }
        catch (e) { return Promise.resolve(null); }
      },
      set: function (k, v) {
        try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
        return Promise.resolve();
      }
    };
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function fmtBytes(b) {
    if (!b) return '';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** <img> or <video>? MIME first, extension as the fallback. */
  function classify(nameOrType, mime) {
    var t = (mime || '').toLowerCase();
    if (t.indexOf('video/') === 0) return 'video';
    if (t.indexOf('image/') === 0) return 'image';
    var n = nameOrType || '';
    if (VIDEO_EXT.test(n)) return 'video';
    if (IMAGE_EXT.test(n)) return 'image';
    return 'image';
  }

  function PeakAbuAppearance(options) {
    options = options || {};
    this.basePath = options.basePath || 'modules/appearance';
    this.storageKey = options.storageKey || 'peakabu.appearance';
    this.store = options.store ||
      (typeof localStorage !== 'undefined' ? localStore(this.storageKey) : memoryStore());
    this.contentSelector = options.contentSelector || null;
    this.onChange = options.onChange || null;

    this.state = Object.assign({}, DEFAULT_STATE);
    this.layer = null;
    this.mediaEl = null;
    this.tileEl = null;
    this.scrimEl = null;
    this.pauseCanvas = null;

    this._recording = false;
    this._hidden = false;
    this._unfocused = false;
    this._mounted = false;
    this._panelEls = {};
    this._objectUrl = null;
  }

  PeakAbuAppearance.presetColors = PRESET_COLORS;
  PeakAbuAppearance.presetThemes = PRESET_THEMES;

  PeakAbuAppearance.prototype = {

    // =============================================================
    // Lifecycle
    // =============================================================

    mount: function () {
      var self = this;
      if (this._mounted) return Promise.resolve(this);

      this.layer = el('div', 'pa-wallpaper-layer');
      this.scrimEl = el('div', 'pa-wallpaper-scrim');
      this.layer.appendChild(this.scrimEl);
      document.body.insertBefore(this.layer, document.body.firstChild);

      // Lift existing content above the wallpaper. Without a selector, lift
      // every top-level element that is not our own layer — this is what
      // makes the module droppable into an app whose markup we do not own.
      var targets = this.contentSelector
        ? document.querySelectorAll(this.contentSelector)
        : document.body.children;
      Array.prototype.forEach.call(targets, function (node) {
        if (node !== self.layer && node.nodeType === 1) {
          node.classList.add('pa-content-above');
        }
      });

      // Seed from the CURRENT state, not from false. visibilitychange only
      // fires on a change, so an app launched minimised (or straight to tray)
      // would otherwise animate its wallpaper the whole time it was hidden —
      // exactly the case these guards exist to prevent.
      this._hidden = document.visibilityState === 'hidden';
      this._unfocused = typeof document.hasFocus === 'function' ? !document.hasFocus() : false;

      document.addEventListener('visibilitychange', function () {
        self._hidden = document.visibilityState === 'hidden';
        self._applyPlayback();
      });
      global.addEventListener('blur', function () {
        self._unfocused = true; self._applyPlayback();
      });
      global.addEventListener('focus', function () {
        self._unfocused = false; self._applyPlayback();
      });

      if (global.matchMedia) {
        this._motionQuery = global.matchMedia('(prefers-reduced-motion: reduce)');
        var onMotion = function () { self._applyPlayback(); };
        if (this._motionQuery.addEventListener) {
          this._motionQuery.addEventListener('change', onMotion);
        }
      }

      this._mounted = true;
      return this.load().then(function () { return self; });
    },

    load: function () {
      var self = this;
      return Promise.resolve(this.store.get(this.storageKey)).then(function (saved) {
        if (saved && typeof saved === 'object') {
          self.state = Object.assign({}, DEFAULT_STATE, saved);
        }
        var w = self.state.wallpaper;
        if (!w || !w.blobKey || w.src) { self.apply(); return self.state; }

        // Rehydrate a browser-picked wallpaper from IndexedDB.
        return idbGet(w.blobKey).then(function (blob) {
          if (blob) {
            self._objectUrl = URL.createObjectURL(blob);
            w.src = self._objectUrl;
          } else {
            self.state.wallpaper = null;   // bytes are gone; do not show a broken tile
          }
          self.apply();
          return self.state;
        }).catch(function () {
          self.state.wallpaper = null;
          self.apply();
          return self.state;
        });
      });
    },

    save: function () {
      // A blob: URL is only valid for this page's lifetime, so persisting one
      // verbatim guarantees a broken wallpaper next launch. Blob-backed
      // wallpapers are saved WITHOUT their src and flagged `blobKey`; load()
      // pulls the bytes back out of IndexedDB and mints a fresh URL. Electron
      // picks return a real file path and skip all of this.
      var toSave = Object.assign({}, this.state);
      if (toSave.wallpaper && /^blob:/.test(toSave.wallpaper.src || '')) {
        toSave.wallpaper = Object.assign({}, toSave.wallpaper, {
          src: null,
          blobKey: this.storageKey
        });
      }
      return Promise.resolve(this.store.set(this.storageKey, toSave));
    },

    // =============================================================
    // Applying state
    // =============================================================

    apply: function () {
      var s = this.state;
      var root = document.documentElement;

      root.setAttribute('data-pa-theme', s.theme);

      // Clear tokens from a previous theme before applying the new set,
      // otherwise switching themes leaves orphaned overrides behind.
      if (this._appliedTokens) {
        this._appliedTokens.forEach(function (k) { root.style.removeProperty(k); });
      }
      this._appliedTokens = [];
      Object.keys(s.tokens || {}).forEach(function (k) {
        root.style.setProperty(k, s.tokens[k]);
        this._appliedTokens.push(k);
      }, this);

      if (s.bgColor) {
        root.style.setProperty('--pa-bg', s.bgColor);
        this._appliedTokens.push('--pa-bg');
      }

      root.style.setProperty('--pa-wall-dim', String(s.dim));
      root.style.setProperty('--pa-wall-blur', s.blur + 'px');
      root.style.setProperty('--pa-panel-opacity', String(s.panelOpacity));


      this._renderWallpaper();
      this._applyPlayback();
      if (this.onChange) this.onChange(this.state);
    },

    _renderWallpaper: function () {
      var self = this;
      var s = this.state;

      if (this.mediaEl) { this.mediaEl.remove(); this.mediaEl = null; }
      if (this.tileEl) { this.tileEl.remove(); this.tileEl = null; }
      if (this.pauseCanvas) { this.pauseCanvas.remove(); this.pauseCanvas = null; }

      if (!s.wallpaper || !s.wallpaper.src) return;

      var w = s.wallpaper;

      if (s.fit === 'tile' && w.kind === 'image') {
        this.tileEl = el('div', 'pa-wallpaper-tile');
        this.tileEl.style.backgroundImage = 'url("' + w.src.replace(/"/g, '\\"') + '")';
        this.layer.insertBefore(this.tileEl, this.scrimEl);
        return;
      }

      var node;
      if (w.kind === 'video') {
        node = document.createElement('video');
        node.muted = true;            // a background must never make noise
        node.loop = true;
        node.playsInline = true;
        node.preload = 'auto';
        // Deliberately NOT autoplay. Autoplay starts the video asynchronously,
        // AFTER _applyPlayback() has already inspected it — so a wallpaper
        // loaded while the window was hidden or while recording would sail
        // straight past the pause guards and play anyway. Playback is started
        // only by _applyPlayback(), which is the single place that decides.
        node.addEventListener('loadeddata', function () {
          node.classList.add('loaded');
          self._applyPlayback();
        });
        node.addEventListener('error', function () {
          self._reportError('That video could not be decoded.');
        });
      } else {
        node = document.createElement('img');
        node.decoding = 'async';
        node.addEventListener('load', function () {
          node.classList.add('loaded');
          self._captureFirstFrame(node);
        });
        node.addEventListener('error', function () {
          self._reportError('That image could not be loaded.');
        });
      }

      node.className = 'pa-wallpaper-media fit-' + s.fit;
      node.src = w.src;
      this.mediaEl = node;
      this.layer.insertBefore(node, this.scrimEl);
    },

    /**
     * Copies a still of an animated image so playback can actually be
     * stopped. There is no DOM API to pause a GIF; swapping in a canvas of
     * frame one is the only way to stop it burning CPU.
     */
    _captureFirstFrame: function (img) {
      try {
        var c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        c.className = 'pa-wallpaper-media fit-' + this.state.fit + ' loaded';
        c.style.display = 'none';
        this.pauseCanvas = c;
        this.layer.insertBefore(c, this.scrimEl);
      } catch (e) {
        // Tainted canvas (a remote image without CORS). Pausing then falls
        // back to hiding the animation, which still stops the compositing
        // work even if the decode loop continues.
        this.pauseCanvas = null;
      }
    },

    /** Single place that decides whether the wallpaper should be moving. */
    shouldAnimate: function () {
      var s = this.state;
      if (!s.animate) return false;
      if (s.respectReducedMotion && this._motionQuery && this._motionQuery.matches) return false;
      if (this._hidden) return false;
      if (s.pauseWhileRecording && this._recording) return false;
      if (s.pauseWhenUnfocused && this._unfocused) return false;
      return true;
    },

    pauseReason: function () {
      var s = this.state;
      if (!s.animate) return 'Animation is off';
      if (s.respectReducedMotion && this._motionQuery && this._motionQuery.matches) {
        return 'Windows is set to reduce motion';
      }
      if (this._hidden) return 'Window is hidden';
      if (s.pauseWhileRecording && this._recording) return 'Paused while recording';
      if (s.pauseWhenUnfocused && this._unfocused) return 'Window is not focused';
      return null;
    },

    _applyPlayback: function () {
      var play = this.shouldAnimate();
      var w = this.state.wallpaper;

      if (this.mediaEl && w) {
        if (w.kind === 'video') {
          if (play) {
            var p = this.mediaEl.play();
            if (p && p.catch) p.catch(function () {});
          } else {
            // Unconditional: a freshly created element reports paused===true
            // while its autoplay/play() is still pending, so guarding on
            // .paused here lets that pending play slip through.
            this.mediaEl.pause();
          }
        } else if (this.pauseCanvas) {
          // Swap the live GIF for its first frame.
          this.mediaEl.style.display = play ? '' : 'none';
          this.pauseCanvas.style.display = play ? 'none' : '';
        }
      }
      this._updateStatus();
    },

    // =============================================================
    // Public setters
    // =============================================================

    /** Call from the host app when capture starts and stops. */
    setRecording: function (on) {
      this._recording = !!on;
      this._applyPlayback();
    },

    set: function (patch) {
      Object.assign(this.state, patch);
      this.apply();
      return this.save();
    },

    /**
     * Points the wallpaper at a source without copying or converting it.
     * @param {object} w { src, name, kind, size }
     */
    setWallpaper: function (w) {
      // Only revoke a STALE object URL. Revoking unconditionally destroyed the
      // URL that setWallpaperFile() had just created and was passing in on the
      // very same call, so every hand-picked image, GIF and video loaded as a
      // dead blob and failed. The sample buttons kept working because they
      // pass plain paths, which made it look like a decoding problem.
      var incoming = w && w.src;
      if (this._objectUrl && this._objectUrl !== incoming) {
        URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = null;
      }
      return this.set({ wallpaper: w });
    },

    /** Accepts a File (drag-drop or <input type=file>). */
    setWallpaperFile: function (file) {
      if (!file) return Promise.resolve();
      // Electron exposes a real path, which survives a restart. In a plain
      // browser only a blob URL is available, valid for this page only.
      var src = file.path ? encodeURI('file:///' + file.path.replace(/\\/g, '/')) : null;
      if (!src) {
        // Release the previous one here — setWallpaper() deliberately will not,
        // now that it leaves the incoming URL alone.
        if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = URL.createObjectURL(file);
        src = this._objectUrl;
      }
      var record = {
        src: src,
        name: file.name,
        kind: classify(file.name, file.type),
        size: file.size
      };

      // Browser only: keep the actual bytes so the pick survives a reload.
      // Applying the wallpaper does not wait on this — a storage failure
      // (quota, private browsing) should cost persistence, not the wallpaper.
      if (!file.path && global.indexedDB && file.size <= BLOB_MAX_BYTES) {
        var self = this;
        idbPut(this.storageKey, file).catch(function (err) {
          if (global.console) {
            console.warn('[PeakAbuAppearance] wallpaper will not survive a reload: ' +
                         (err && err.message ? err.message : err));
          }
          void self;
        });
      }

      return this.setWallpaper(record);
    },

    clearWallpaper: function () {
      if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
      // Drop the stored bytes too, so Remove actually frees the space rather
      // than leaving an orphaned blob in IndexedDB forever.
      if (global.indexedDB) idbDelete(this.storageKey).catch(function () {});
      return this.set({ wallpaper: null });
    },

    applyTheme: function (themeId) {
      var t = PRESET_THEMES.filter(function (x) { return x.id === themeId; })[0];
      if (!t) return Promise.resolve();
      return this.set({
        themeId: t.id,
        theme: t.theme,
        tokens: Object.assign({}, t.tokens),
        bgColor: null,
        recentThemeIds: pushRecent(this.state.recentThemeIds, t.id, 6)
      });
    },

    applyColor: function (colorId) {
      var c = PRESET_COLORS.filter(function (x) { return x.id === colorId; })[0];
      if (!c) return Promise.resolve();
      var tokens = Object.assign({}, this.state.tokens);
      tokens['--pa-accent'] = c.accent;
      tokens['--pa-accent-bright'] = c.accentBright;
      return this.set({ bgColor: null, tokens: tokens });
    },

    _reportError: function (msg) {
      if (this._panelEls.error) {
        this._panelEls.error.textContent = msg;
        this._panelEls.error.classList.remove('pa-ap-hidden');
      }
      if (global.console) console.warn('[PeakAbuAppearance] ' + msg);
    },

    _updateStatus: function () {
      var s = this._panelEls.status;
      if (!s) return;
      var reason = this.pauseReason();
      var animated = this.state.wallpaper &&
        (this.state.wallpaper.kind === 'video' || /\.(gif|webp|apng)$/i.test(this.state.wallpaper.name || ''));
      if (!animated) {
        s.classList.add('pa-ap-hidden');
        return;
      }
      s.classList.remove('pa-ap-hidden');
      s.classList.toggle('paused', !!reason);
      s.querySelector('.txt').textContent = reason || 'Animating';
    },

    // =============================================================
    // Settings panel
    // =============================================================

    renderPanel: function (container) {
      var self = this;
      if (!container) return;
      container.classList.add('pa-appearance');
      container.innerHTML = '';
      var e = this._panelEls = {};
      var s = this.state;

      // ---- Theme + Background colour (combined) ----
      // ---- Theme + Accent colour (combined) ----
      var themeSec = el('div', 'pa-ap-section');
      themeSec.appendChild(el('h4', null, 'Theme'));

      function themeColors(t) {
        var tok = t.tokens;
        return [
          tok['--pa-bg']    || (t.theme === 'light' ? '#eef3ef' : '#0a1611'),
          tok['--pa-panel'] || (t.theme === 'light' ? '#ffffff' : '#0f2318'),
          tok['--pa-accent']|| (t.theme === 'light' ? '#12855f' : '#39d3a0')
        ];
      }

      function makeMiniSwatch(colors) {
        var sw = el('div', 'pa-ap-dd-swatch');
        colors.forEach(function (c) {
          var sp = el('span'); sp.style.background = c; sw.appendChild(sp);
        });
        return sw;
      }

      // Every token a theme or accent could possibly set. A theme preview
      // must clear ALL of these before applying its own, not just the keys
      // the last preview happened to touch — Peak Dark/Light ship empty
      // tokens on purpose, relying on the absence of an inline override to
      // fall back to the CSS cascade. Clearing only the previous preview's
      // keys left whatever theme was actually selected stuck underneath,
      // since an empty preview has nothing of its own to override it with.
      var THEMABLE_KEYS = [
        '--pa-bg', '--pa-panel', '--pa-panel-sunk', '--pa-border', '--pa-border-strong',
        '--pa-accent', '--pa-accent-bright', '--pa-text', '--pa-text-dim', '--pa-text-faint'
      ];

      /** Leaves preview mode — restores the ACTUAL persisted theme/accent. */
      function clearPreview() {
        var root = document.documentElement;
        THEMABLE_KEYS.forEach(function (k) { root.style.removeProperty(k); });
        root.setAttribute('data-pa-theme', s.theme);
        Object.keys(s.tokens || {}).forEach(function (k) { root.style.setProperty(k, s.tokens[k]); });
        if (s.bgColor) root.style.setProperty('--pa-bg', s.bgColor);
      }

      function buildDropdown(items, getColors, activeId, onPick, previewFn) {
        var wrap = el('div', 'pa-ap-dd-wrap');
        var active = items.filter(function (x) { return x.id === activeId; })[0] || items[0];

        var trigger = el('button', 'pa-ap-dd-trigger');
        function refreshTrigger(item) {
          trigger.innerHTML = '';
          trigger.appendChild(makeMiniSwatch(getColors(item)));
          var lbl = el('span', 'pa-ap-dd-label');
          lbl.textContent = item.name;
          trigger.appendChild(lbl);
          trigger.appendChild(el('span', 'pa-ap-dd-chevron', '▾'));
        }
        refreshTrigger(active);
        wrap.appendChild(trigger);

        var list = el('div', 'pa-ap-dd-list pa-ap-hidden');
        items.forEach(function (item, idx) {
          var opt = el('button', 'pa-ap-dd-opt' + (item.id === activeId ? ' active' : ''));
          opt.dataset.idx = idx;
          opt.appendChild(makeMiniSwatch(getColors(item)));
          var lbl = el('span', 'pa-ap-dd-label');
          lbl.textContent = item.name;
          opt.appendChild(lbl);
          opt.addEventListener('click', function () {
            list.classList.add('pa-ap-hidden');
            trigger.classList.remove('open');
            onPick(item.id).then(function () { self.renderPanel(container); });
          });
          list.appendChild(opt);
        });

        // Delegated hover preview: one listener over the whole list, no
        // per-option gaps to fall through. Single mouseleave on the list
        // (not per option) reverts exactly once when the pointer actually
        // leaves the dropdown, instead of flickering between every item.
        var lastPreviewIdx = -1;
        list.addEventListener('mousemove', function (ev) {
          var optEl = ev.target.closest ? ev.target.closest('.pa-ap-dd-opt') : null;
          if (!optEl) return;
          var idx = parseInt(optEl.dataset.idx, 10);
          if (idx === lastPreviewIdx) return;
          lastPreviewIdx = idx;
          previewFn(items[idx]);
        });
        list.addEventListener('mouseleave', function () {
          lastPreviewIdx = -1;
          clearPreview();
        });
        wrap.appendChild(list);

        trigger.addEventListener('click', function (ev) {
          ev.stopPropagation();
          clearPreview();
          var opening = list.classList.contains('pa-ap-hidden');
          container.querySelectorAll('.pa-ap-dd-list').forEach(function (l) { l.classList.add('pa-ap-hidden'); });
          container.querySelectorAll('.pa-ap-dd-trigger').forEach(function (t2) { t2.classList.remove('open'); });
          if (opening) { list.classList.remove('pa-ap-hidden'); trigger.classList.add('open'); }
        });
        return wrap;
      }

      // Close all dropdowns on outside click — attach once per renderPanel call
      var _ddClose = function () {
        clearPreview();
        container.querySelectorAll('.pa-ap-dd-list').forEach(function (l) { l.classList.add('pa-ap-hidden'); });
        container.querySelectorAll('.pa-ap-dd-trigger').forEach(function (t2) { t2.classList.remove('open'); });
      };
      document.removeEventListener('click', container._ddClose);
      container._ddClose = _ddClose;
      document.addEventListener('click', _ddClose);

      // Find active accent color
      var currentAccent = s.tokens && s.tokens['--pa-accent'];
      var activeColorId = (PRESET_COLORS.filter(function (c) { return c.accent === currentAccent; })[0] || { id: 'teal' }).id;

      // Color items: include a "(from theme)" no-op at top
      var colorItems = [{ id: '__theme__', name: '(from theme)', accent: s.tokens['--pa-accent'] || '#39d3a0', accentBright: s.tokens['--pa-accent-bright'] || '#4fe0b0' }]
        .concat(PRESET_COLORS);
      var activeColorDdId = currentAccent ? activeColorId : '__theme__';

      var themeRow = el('div', 'pa-ap-dd-row');

      var themeCol = el('div', 'pa-ap-dd-col');
      themeCol.appendChild(el('label', null, 'Preset'));
      themeCol.appendChild(buildDropdown(PRESET_THEMES, themeColors, s.themeId,
        function (id) { return self.applyTheme(id); },
        function (t) {
          // Wipe everything first, unconditionally — the previewed theme
          // must show its OWN look, not the real selection with gaps
          // filled in, otherwise an empty-tokens theme can never win.
          var root = document.documentElement;
          THEMABLE_KEYS.forEach(function (k) { root.style.removeProperty(k); });
          root.setAttribute('data-pa-theme', t.theme);
          Object.keys(t.tokens).forEach(function (k) { root.style.setProperty(k, t.tokens[k]); });
        }
      ));
      themeRow.appendChild(themeCol);

      var colorCol = el('div', 'pa-ap-dd-col');
      colorCol.appendChild(el('label', null, 'Accent'));
      colorCol.appendChild(buildDropdown(colorItems,
        function (c) { return [c.accent, c.accentBright]; },
        activeColorDdId,
        function (id) {
          if (id === '__theme__') return Promise.resolve();
          return self.applyColor(id);
        },
        function (c) {
          // Accent preview is meant to show the hovered accent against
          // whatever theme is really active, so restore real state first,
          // then override just the two accent keys on top of it.
          clearPreview();
          var root = document.documentElement;
          root.style.setProperty('--pa-accent', c.accent);
          root.style.setProperty('--pa-accent-bright', c.accentBright);
        }
      ));
      themeRow.appendChild(colorCol);

      themeSec.appendChild(themeRow);
      container.appendChild(themeSec);

      // ---- Wallpaper ----
      var wpSec = el('div', 'pa-ap-section');
      wpSec.appendChild(el('h4', null, 'Wallpaper'));

      var drop = el('div', 'pa-ap-drop',
        '<strong>Drop an image, GIF or video clip</strong>' +
        'or click to browse · png, jpg, webp, gif, mp4, webm');
      var fileInput = el('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*,video/*';
      fileInput.style.display = 'none';
      drop.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        if (fileInput.files[0]) {
          self._acceptFile(fileInput.files[0], container);
        }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e2) {
          e2.preventDefault(); drop.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e2) {
          e2.preventDefault(); drop.classList.remove('dragover');
        });
      });
      drop.addEventListener('drop', function (e2) {
        var f = e2.dataTransfer && e2.dataTransfer.files[0];
        if (f) self._acceptFile(f, container);
      });
      wpSec.appendChild(drop);
      wpSec.appendChild(fileInput);

      e.error = el('p', 'pa-ap-note pa-ap-warn pa-ap-hidden');
      wpSec.appendChild(e.error);

      if (s.wallpaper) {
        var cur = el('div', 'pa-ap-current');
        var thumb;
        if (s.wallpaper.kind === 'video') {
          thumb = document.createElement('video');
          thumb.muted = true; thumb.playsInline = true;
        } else {
          thumb = document.createElement('img');
        }
        thumb.className = 'pa-ap-thumb';
        thumb.src = s.wallpaper.src;
        cur.appendChild(thumb);
        var meta = el('div', 'pa-ap-meta');
        meta.appendChild(el('div', 'n', s.wallpaper.name || 'wallpaper'));
        meta.appendChild(el('div', 'd',
          (s.wallpaper.kind === 'video' ? 'Video' : 'Image') +
          (s.wallpaper.size ? ' · ' + fmtBytes(s.wallpaper.size) : '')));
        cur.appendChild(meta);
        var rm = el('button', null, 'Remove');
        rm.addEventListener('click', function () {
          self.clearWallpaper().then(function () { self.renderPanel(container); });
        });
        cur.appendChild(rm);
        wpSec.appendChild(cur);

        if (s.wallpaper.size > SIZE_WARN_BYTES) {
          wpSec.appendChild(el('p', 'pa-ap-note pa-ap-warn',
            'This file is ' + fmtBytes(s.wallpaper.size) + '. Animated wallpapers are ' +
            'held as decoded frames, so large ones cost far more memory than their ' +
            'file size suggests. A short, small clip looks the same and costs much less.'));
        }

        var fitRow = el('div', 'pa-ap-row');
        fitRow.appendChild(el('label', null, 'Fit'));
        var fit = el('select');
        [['cover', 'Fill screen (crop)'], ['contain', 'Fit inside'],
         ['fill', 'Stretch'], ['center', 'Centre, no scaling'],
         ['tile', 'Tile (images only)']].forEach(function (o) {
          var opt = el('option'); opt.value = o[0]; opt.textContent = o[1];
          if (o[0] === 'tile' && s.wallpaper.kind === 'video') opt.disabled = true;
          fit.appendChild(opt);
        });
        fit.value = s.fit;
        fit.addEventListener('change', function () { self.set({ fit: fit.value }); });
        fitRow.appendChild(fit);
        wpSec.appendChild(fitRow);
      }
      container.appendChild(wpSec);

      // ---- Legibility ----
      var legSec = el('div', 'pa-ap-section');
      legSec.appendChild(el('h4', null, 'Readability'));
      this._slider(legSec, 'Dim', s.dim, 0, 1, 0.01, function (v) {
        self.set({ dim: v });
      }, function (v) { return Math.round(v * 100) + '%'; },
      'Black scrim over the wallpaper — higher dims it further behind the UI.');
      this._slider(legSec, 'Blur', s.blur, 0, 30, 1, function (v) {
        self.set({ blur: v });
      }, function (v) { return v + 'px'; },
      'Softens the wallpaper only — panels stay sharp.');
      this._slider(legSec, 'Panels', s.panelOpacity, 0.3, 1, 0.01, function (v) {
        self.set({ panelOpacity: v });
      }, function (v) { return Math.round(v * 100) + '%'; },
      'How solid panels are. Lower lets the wallpaper show through behind text.');
      container.appendChild(legSec);

      // ---- Performance ----
      var perfSec = el('div', 'pa-ap-section');
      perfSec.appendChild(el('h4', null, 'Motion &amp; performance'));
      this._toggle(perfSec, 'Animate wallpaper', s.animate, function (v) {
        self.set({ animate: v });
      });
      this._toggle(perfSec, 'Pause while recording', s.pauseWhileRecording, function (v) {
        self.set({ pauseWhileRecording: v });
      });
      this._toggle(perfSec, 'Pause when window is not focused', s.pauseWhenUnfocused, function (v) {
        self.set({ pauseWhenUnfocused: v });
      });
      this._toggle(perfSec, 'Respect Windows "reduce motion"', s.respectReducedMotion, function (v) {
        self.set({ respectReducedMotion: v });
      });

      e.status = el('div', 'pa-ap-status');
      e.status.appendChild(el('span', 'dot'));
      e.status.appendChild(el('span', 'txt', 'Animating'));
      perfSec.appendChild(e.status);

      perfSec.appendChild(el('p', 'pa-ap-note',
        'Peak-Abu records games. A looping video behind the UI competes with capture ' +
        'for the same GPU, and the window is usually not even visible mid-match — so ' +
        'the wallpaper stops on its own whenever it cannot be seen or would get in ' +
        'the way. GIFs are frozen to their first frame, not just hidden.'));
      container.appendChild(perfSec);

      var resetRow = el('div', 'pa-ap-row');
      var resetBtn = el('button', null, 'Reset to defaults');
      resetBtn.style.flex = '1';
      resetBtn.addEventListener('click', function () {
        self.reset().then(function () { self.renderPanel(container); });
      });
      resetRow.appendChild(resetBtn);
      container.appendChild(resetRow);

      this._updateStatus();
    },

    _acceptFile: function (file, container) {
      var self = this;
      var kind = classify(file.name, file.type);
      if (kind === 'video' && !VIDEO_EXT.test(file.name) && file.type.indexOf('video/') !== 0) {
        this._reportError('That file type is not supported.');
        return;
      }
      this.setWallpaperFile(file).then(function () {
        if (self._panelEls.error) self._panelEls.error.classList.add('pa-ap-hidden');
        self.renderPanel(container);
      });
    },

    _slider: function (parent, label, value, min, max, step, onInput, fmt, titleText) {
      var row = el('div', 'pa-ap-row');
      var lbl = el('label', null, label);
      if (titleText) lbl.title = titleText;
      row.appendChild(lbl);
      var input = el('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step; input.value = value;
      if (titleText) input.title = titleText;
      var val = el('span', 'pa-ap-val', fmt(value));
      input.addEventListener('input', function () {
        var v = parseFloat(input.value);
        val.textContent = fmt(v);
        onInput(v);
      });
      row.appendChild(input);
      row.appendChild(val);
      parent.appendChild(row);
      return input;
    },

    _toggle: function (parent, label, checked, onChange) {
      var row = el('div', 'pa-ap-toggle-row');
      row.appendChild(el('span', null, label));
      var sw = el('label', 'pa-ap-switch');
      var input = el('input');
      input.type = 'checkbox';
      input.checked = !!checked;
      input.addEventListener('change', function () { onChange(input.checked); });
      sw.appendChild(input);
      sw.appendChild(el('span', 'pa-ap-slider'));
      row.appendChild(sw);
      parent.appendChild(row);
      return input;
    },

    destroy: function () {
      if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
      if (this.layer) { this.layer.remove(); this.layer = null; }
      this._mounted = false;
    }
  };

  global.PeakAbuAppearance = PeakAbuAppearance;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PeakAbuAppearance;
  }

})(typeof window !== 'undefined' ? window : this);
