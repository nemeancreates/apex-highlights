// ==========================================================
// peakabu.app — shared site behaviour (every page loads this)
//   - sparse falling leaves in the background
//   - Download buttons point at the latest installer (/api/version)
//   - nav shows your name once you're signed in on this browser
//   - YouTube embeds load only when someone presses play
// ==========================================================
(function () {
  'use strict';
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- auth helpers (same storage key as the web player) ----------
  var AUTH_KEY = 'pa_browser_auth';
  // Tell the page (e.g. the Redeem form) when you sign in or out.
  function authChanged() { try { window.dispatchEvent(new Event('pa-auth')); } catch (e) {} }
  window.paAuth = {
    get: function () {
      try { var a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); return a && a.token ? a : null; } catch (e) { return null; }
    },
    set: function (token, username) {
      try { localStorage.setItem(AUTH_KEY, JSON.stringify({ token: token, username: username })); } catch (e) {}
      authChanged();
    },
    clear: function () { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} authChanged(); },
    // fetch with the bearer token; a 401 clears the saved sign-in
    api: function (url, opts) {
      opts = opts || {};
      var a = window.paAuth.get();
      var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (a) headers.Authorization = 'Bearer ' + a.token;
      return fetch(url, Object.assign({}, opts, { headers: headers })).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (r.status === 401) window.paAuth.clear();
          return { ok: r.ok, status: r.status, data: data };
        });
      });
    }
  };

  // ---------- nav: signed-in name ----------
  function markSignedIn() {
    var a = window.paAuth.get();
    document.querySelectorAll('[data-signin]').forEach(function (el) {
      if (a) { el.textContent = a.username; el.setAttribute('href', '/account'); }
    });
  }

  // ---------- Download buttons ----------
  function wireDownloads() {
    var links = document.querySelectorAll('[data-download]');
    if (!links.length) return;
    fetch('/api/version').then(function (r) { return r.json(); }).then(function (v) {
      if (!v || !v.downloadUrl) return;
      links.forEach(function (el) {
        el.setAttribute('href', v.downloadUrl);
        var ver = el.querySelector('[data-version]');
        if (ver && v.version) ver.textContent = 'v' + v.version;
      });
    }).catch(function () {});
  }

  // ---------- YouTube: click to load ----------
  function wireVideos() {
    document.querySelectorAll('.video[data-yt]').forEach(function (box) {
      var btn = box.querySelector('.play');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var f = document.createElement('iframe');
        f.src = 'https://www.youtube.com/embed/' + encodeURIComponent(box.getAttribute('data-yt')) + '?autoplay=1&rel=0';
        f.title = box.getAttribute('data-title') || 'Peakabu video';
        f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        f.allowFullscreen = true;
        box.replaceChildren(f);
      });
    });
  }

  // ---------- falling leaves ----------
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SYMBOLS =
    '<symbol id="fl-banana" viewBox="0 0 320 120"><path d="M8 62 C 80 4, 220 0, 314 50 C 226 108, 84 118, 8 62 Z" fill="currentColor"/><path d="M8 62 C 120 52, 220 50, 314 50" fill="none" stroke="#04100a" stroke-opacity="0.45" stroke-width="3"/></symbol>' +
    '<symbol id="fl-monstera" viewBox="0 0 220 220"><mask id="fl-mcut"><rect width="220" height="220" fill="#fff"/><path d="M-4 104 L-4 122 L74 150 Z M10 54 L2 70 L80 120 Z M54 4 L40 14 L96 96 Z M224 104 L224 122 L146 150 Z M210 54 L218 70 L140 120 Z M166 4 L180 14 L124 96 Z" fill="#000"/><ellipse cx="74" cy="100" rx="8" ry="13" fill="#000"/><ellipse cx="146" cy="100" rx="8" ry="13" fill="#000"/></mask><path mask="url(#fl-mcut)" d="M110 214 C 30 192, 0 122, 10 78 C 22 26, 76 6, 110 30 C 144 6, 198 26, 210 78 C 220 122, 190 192, 110 214 Z" fill="currentColor"/></symbol>' +
    '<symbol id="fl-small" viewBox="0 0 100 100"><path d="M10 90 C 10 40, 40 10, 92 8 C 90 60, 60 90, 10 90 Z" fill="currentColor"/><path d="M10 90 L 80 20" stroke="#04100a" stroke-opacity="0.35" stroke-width="3"/></symbol>' +
    '<symbol id="fl-palm" viewBox="0 0 320 320"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M20 300 C 100 220, 200 120, 300 30" stroke-width="5"/><g stroke-width="12"><path d="M60 262 Q38 230 34 196"/><path d="M60 262 Q92 270 124 262"/><path d="M95 228 Q72 192 70 152"/><path d="M95 228 Q132 236 166 226"/><path d="M130 192 Q108 156 108 116"/><path d="M130 192 Q168 198 202 188"/><path d="M165 156 Q146 122 148 84"/><path d="M165 156 Q200 160 232 150"/><path d="M200 120 Q184 90 188 58"/><path d="M200 120 Q230 122 258 112"/></g></g></symbol>';

  function addSymbols() {
    if (document.getElementById('fl-small')) return; // built pages inline them
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    svg.innerHTML = '<defs>' + SYMBOLS + '</defs>';
    document.body.insertBefore(svg, document.body.firstChild);
  }

  function startLeaves() {
    var page = document.querySelector('.page');
    if (!page || page.hasAttribute('data-no-leaves') || reduceMotion) return;
    var layer = document.createElement('div');
    layer.className = 'leaf-layer';
    layer.setAttribute('aria-hidden', 'true');
    page.insertBefore(layer, page.firstChild);
    var kinds = ['#fl-small', '#fl-small', '#fl-banana', '#fl-monstera'];
    var colors = ['#1f5a33', '#2b7343', '#17442a', '#3a7a3a', '#245f36'];

    function spawn(mid) {
      if (layer.childElementCount >= 6) return;
      var dur = 24 + Math.random() * 14;
      var off = mid ? Math.random() * dur * 0.6 : 0;
      var href = kinds[Math.floor(Math.random() * kinds.length)];
      var size = href === '#fl-small' ? 34 + Math.random() * 30 : 70 + Math.random() * 60;
      var el = document.createElement('div');
      el.className = 'fall d' + (1 + Math.floor(Math.random() * 4));
      el.style.left = (4 + Math.random() * 88).toFixed(1) + '%';
      el.style.width = el.style.height = Math.round(size) + 'px';
      el.style.animationDuration = dur.toFixed(1) + 's';
      el.style.animationDelay = (-off).toFixed(1) + 's';
      el.style.opacity = (0.55 + Math.random() * 0.35).toFixed(2);
      var svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'flutter');
      svg.style.color = colors[Math.floor(Math.random() * colors.length)];
      svg.style.animationDuration = (2.6 + Math.random() * 2.4).toFixed(1) + 's';
      var use = document.createElementNS(SVGNS, 'use');
      use.setAttribute('href', href);
      svg.appendChild(use); el.appendChild(svg); layer.appendChild(el);
      setTimeout(function () { el.remove(); }, (dur - off) * 1000 + 400);
    }
    // A leaf every 4–11s, with random quiet spells of 14–24s.
    function loop() {
      var gap = Math.random() < 0.3 ? 14000 + Math.random() * 10000 : 4000 + Math.random() * 7000;
      setTimeout(function () { if (!document.hidden) spawn(false); loop(); }, gap);
    }
    spawn(true); setTimeout(function () { spawn(true); }, 60); loop();
  }

  document.addEventListener('DOMContentLoaded', function () {
    addSymbols();
    markSignedIn();
    wireDownloads();
    wireVideos();
    startLeaves();
  });
})();
