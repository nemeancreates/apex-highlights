/*
 * tutorial.js — Jungle tour for first-time users.
 *
 * Giant jungle leaves cover the parts of the app that aren't being talked
 * about, and slide aside around the one that is. Look and timing were tuned
 * in the workshop prototype (10/10/26) and are fixed in LOOK below.
 *
 * Public API (window.paTutorial):
 *   onLogin()               call after login; shows the button, auto-opens
 *                           the tour the first time on this PC
 *   start()                 open the tour now
 *   stop()                  close it
 *   setButtonEnabled(bool)  Settings → General switch
 *
 * Prefs (local, via the existing set-user-pref / get-user-pref IPC):
 *   tutorialButtonEnabled   null/true = show the button, false = hide it
 *   tutorialSeen            true once the tour was finished or skipped
 */
(function () {
  'use strict';

  var ipc = null;
  function getIpc() {
    if (!ipc) { try { ipc = require('electron').ipcRenderer; } catch (e) { ipc = null; } }
    return ipc;
  }
  function getPref(key) { var i = getIpc(); return i ? i.invoke('get-user-pref', key) : Promise.resolve(null); }
  function setPref(key, val) { var i = getIpc(); if (i) i.invoke('set-user-pref', key, val); }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ===================================================== look (workshop picks) */
  var LOOK = {
    leafAlpha: 0.85,   // leaf fade
    shade: 0.73,       // darkness under the leaves
    density: 1.1,      // leaf density
    speed: 0.51,       // animation speed multiplier
    sway: true         // idle sway
  };
  var PAL = { edge: '#082418', mid: '#165a35', light: '#2f8a52', vein: '#6cc487' }; // "Deep"

  /* ===================================================== steps */
  function $(sel) { return document.querySelector(sel); }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return el.getClientRects().length > 0 && r.width > 0 && r.height > 0;
  }
  function inSession() { return visible($('#sessionPanel-connected')); }

  // Each step returns the elements to clear around, or [] to be skipped.
  var STEPS = [
    { els: function () { return [$('#monkeyToggle')]; },
      title: 'Welcome to Peak-Abu',
      body: 'A quick walk through the jungle. Tap the 🙈 any time to fold every section away.' },
    { els: function () { return [$('#captureModeSelect'), $('#startBtn')]; },
      title: 'Start your buffer',
      body: 'Pick Monitor or Game Window, then Start Highlight Session. Peak-Abu keeps the last few minutes on your PC. Nothing uploads until you save.' },
    { els: function () { return [$('#micMenuBtn')]; },
      title: 'Mic and game audio',
      body: 'Choose your mic, your desktop audio source and noise suppression here.' },
    { els: function () { return inSession() ? [$('#sessionCodeDisplay'), $('#inviteLinkHeaderBtn')] : [$('#sessionPanel-disconnected')]; },
      title: function () { return inSession() ? 'Bring your squad' : 'Squad up'; },
      body: function () {
        return inSession()
          ? 'Share this 6-letter code, or the 🔗 invite link in Discord. Friends paste it into Join Session.'
          : 'Create a session and share its code, or type a friend’s 6-letter code and join theirs.';
      } },
    { els: function () { return [$('#hotkeyCurrent'), $('#saveBtn')]; },
      title: 'Save the play',
      body: 'Press F9, a controller button, or Save Highlight. The host picks how long a clip is.' },
    { els: function () { return [$('.ac-monkeys')]; },
      title: 'The listening monkeys',
      body: 'With Auto-Highlight on, these two listen to game audio and your mic and save fights for you.' },
    { els: function () { var p = $('#hudPane-activity'); return [p && p.closest('.card')]; },
      title: 'What just happened',
      body: 'Saves, uploads and squad joins land in the Session HUD.' },
    { els: function () { return [$('#playerLink')]; }, // hidden until you're in a session, so it skips itself
      title: 'Every angle, in sync',
      body: 'Open the web player to watch the whole squad’s POVs lined up side by side.' },
    { els: function () { return [$('#settingsBtn')]; },
      title: 'Settings',
      body: 'Turn on Auto-Highlight, test your audio and video, and hide this Tutorial button if you don’t need it.' },
    { els: function () { return [$('#tutorialBtn')]; },
      title: 'Come back anytime',
      body: 'The tour lives right next to your name.' }
  ];
  function val(v) { return typeof v === 'function' ? v() : v; }
  function stepEls(step) { return (step.els() || []).filter(visible); }

  /* ===================================================== helpers */
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpAng(a, b, t) { var d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; return a + d * t; }
  var ease = {
    inOut: function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    out: function (t) { return 1 - Math.pow(1 - t, 3); },
    in: function (t) { return t * t * t; },
    back: function (t) { var c1 = 1.35, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  };
  function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function mix(a, b, t) { var A = hex(a), B = hex(b); return 'rgb(' + Math.round(lerp(A[0], B[0], t)) + ',' + Math.round(lerp(A[1], B[1], t)) + ',' + Math.round(lerp(A[2], B[2], t)) + ')'; }
  function copy(p) { return { x: p.x, y: p.y, a: p.a }; }

  /* ===================================================== leaf art */
  var SIZES = { monstera: { L: 220, H: 96 }, banana: { L: 310, H: 54 }, palm: { L: 280, H: 96 }, alocasia: { L: 215, H: 100 } };
  var SS = 1.6; // sprite supersampling

  function bladeGrad(g, H, p, tone) {
    var gr = g.createLinearGradient(0, -H, 0, H);
    var e = mix(p.edge, p.mid, tone * .3), m = mix(p.mid, p.light, tone);
    gr.addColorStop(0, e); gr.addColorStop(.5, m); gr.addColorStop(1, e);
    return gr;
  }
  function drawMonstera(g, L, H, p, r, tone) {
    g.beginPath(); g.moveTo(L * .04, 0);
    g.bezierCurveTo(-L * .06, -H * .75, L * .55, -H * 1.18, L, 0);
    g.bezierCurveTo(L * .55, H * 1.18, -L * .06, H * .75, L * .04, 0);
    g.fillStyle = bladeGrad(g, H, p, tone); g.fill();
    var hl = g.createRadialGradient(L * .42, -H * .15, 4, L * .42, -H * .15, L * .5);
    hl.addColorStop(0, 'rgba(255,255,255,.10)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; g.fill();
    var wAt = function (t) { return H * 1.02 * Math.sin(Math.PI * Math.pow(t, .85)); };
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    var n = 5 + Math.floor(r() * 2);
    for (var i = 0; i < n; i++) {
      var t = .16 + i * (.7 / n) + r() * .03, x = L * t, w = wAt(t);
      [-1, 1].forEach(function (s) {
        g.beginPath(); g.moveTo(x - L * .018, s * (w + 6)); g.lineTo(x + L * .03, s * (w + 6)); g.lineTo(x + L * .07, s * w * (.22 + r() * .12)); g.closePath(); g.fill();
        if (r() < .55) { g.beginPath(); g.ellipse(x + L * .05, s * w * .5, 3 + r() * 3, 2 + r() * 2, .4 * s, 0, Math.PI * 2); g.fill(); }
      });
    }
    // Veins only paint where the leaf still exists
    g.globalCompositeOperation = 'source-atop';
    g.strokeStyle = p.vein; g.globalAlpha = .8; g.lineWidth = 3;
    g.beginPath(); g.moveTo(-L * .12, 0); g.quadraticCurveTo(L * .5, -H * .04, L * .92, 0); g.stroke();
    g.globalAlpha = .32; g.lineWidth = 1.3;
    for (var k = 0; k < n; k++) {
      var tt = .12 + k * (.7 / n), xx = L * tt;
      [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(xx, 0); g.quadraticCurveTo(xx + L * .015, s * wAt(tt) * .35, xx + L * .035, s * wAt(tt) * .62); g.stroke(); });
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }
  function drawBanana(g, L, H, p, r, tone) {
    g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(L * .02, -H, L * .25, -H, L * .55, -H * .98); g.bezierCurveTo(L * .84, -H * .95, L * .98, -H * .6, L, 0);
    g.bezierCurveTo(L * .98, H * .6, L * .84, H * .95, L * .55, H * .98); g.bezierCurveTo(L * .25, H, L * .02, H, 0, 0);
    g.fillStyle = bladeGrad(g, H, p, tone); g.fill();
    g.save(); g.clip();
    g.strokeStyle = p.light; g.globalAlpha = .22; g.lineWidth = 1;
    for (var x = L * .03; x < L; x += 5) { [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + H * .45, s * H * 1.05); g.stroke(); }); }
    g.restore(); g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    var tears = 2 + Math.floor(r() * 4);
    for (var i = 0; i < tears; i++) {
      var tx = L * (.18 + r() * .7), s = r() < .5 ? -1 : 1, depth = .25 + r() * .6;
      g.beginPath(); g.moveTo(tx + H * .45, s * (H + 4)); g.lineTo(tx + H * .45 + 2.6, s * (H + 4)); g.lineTo(tx + H * .45 * (1 - depth) + .6, s * H * (1 - depth)); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = p.vein; g.globalAlpha = .85; g.lineWidth = 4; g.beginPath(); g.moveTo(-L * .1, 0); g.lineTo(L * .97, 0); g.stroke(); g.globalAlpha = 1;
  }
  function drawPalm(g, L, H, p, r, tone) {
    var N = 24;
    g.strokeStyle = mix(p.mid, p.vein, .4); g.lineWidth = 3;
    g.beginPath(); g.moveTo(-L * .12, 0); g.quadraticCurveTo(L * .5, -H * .12, L, -H * .05); g.stroke();
    for (var i = 0; i < N; i++) {
      var t = i / N, x = L * (.06 + .9 * t), y = -H * .12 * Math.sin(Math.PI * t) * .9, len = H * (1.05 - t * .72) * (.85 + r() * .25);
      [-1, 1].forEach(function (s) {
        g.save(); g.translate(x, y); g.rotate(s * (1.05 - .55 * t) + (r() - .5) * .12);
        var gr = g.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, mix(p.mid, p.light, tone)); gr.addColorStop(1, p.edge);
        g.fillStyle = gr; g.beginPath(); g.ellipse(len / 2, 0, len / 2, len * .085 + 2, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = p.vein; g.globalAlpha = .35; g.lineWidth = .8; g.beginPath(); g.moveTo(0, 0); g.lineTo(len * .95, 0); g.stroke(); g.globalAlpha = 1;
        g.restore();
      });
    }
  }
  function drawAlocasia(g, L, H, p, r, tone) {
    g.beginPath(); g.moveTo(0, 0);
    g.bezierCurveTo(-L * .05, -H * .3, -L * .22, -H * .85, -L * .04, -H * 1.0);
    g.bezierCurveTo(L * .28, -H * 1.12, L * .78, -H * .55, L, 0);
    g.bezierCurveTo(L * .78, H * .55, L * .28, H * 1.12, -L * .04, H * 1.0);
    g.bezierCurveTo(-L * .22, H * .85, -L * .05, H * .3, 0, 0);
    g.fillStyle = bladeGrad(g, H, p, tone); g.fill();
    g.strokeStyle = p.vein; g.globalAlpha = .85; g.lineWidth = 3.2; g.beginPath(); g.moveTo(-L * .14, 0); g.lineTo(L * .96, 0); g.stroke();
    g.lineWidth = 1.8; g.globalAlpha = .6;
    for (var i = 0; i < 6; i++) { var x = L * (.06 + i * .14); [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(x, 0); g.quadraticCurveTo(x + L * .08, s * H * .35, x + L * .2, s * H * (.78 - i * .09)); g.stroke(); }); }
    [-1, 1].forEach(function (s) { g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-L * .06, s * H * .4, -L * .1, s * H * .78); g.stroke(); });
    g.globalAlpha = 1;
  }
  var DRAW = { monstera: drawMonstera, banana: drawBanana, palm: drawPalm, alocasia: drawAlocasia };

  function makeSprite(type, seed, tone) {
    var sz = SIZES[type], L = sz.L, H = sz.H, pad = 34;
    var minX = -.26 * L, maxX = 1.06 * L, minY = -1.25 * H, maxY = 1.25 * H;
    var cw = (maxX - minX) + pad * 2, ch = (maxY - minY) + pad * 2, ox = pad - minX, oy = pad - minY;
    var leaf = document.createElement('canvas'); leaf.width = Math.ceil(cw * SS); leaf.height = Math.ceil(ch * SS);
    var g = leaf.getContext('2d'); g.scale(SS, SS); g.translate(ox, oy);
    g.strokeStyle = mix(PAL.mid, PAL.vein, .3); g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-L * .26 + 6, 0); g.lineTo(0, 0); g.stroke(); // stem
    DRAW[type](g, L, H, PAL, rng(seed), tone);
    var out = document.createElement('canvas'); out.width = leaf.width; out.height = leaf.height;
    var o = out.getContext('2d');
    o.shadowColor = 'rgba(0,0,0,.55)'; o.shadowBlur = 18 * SS; o.shadowOffsetX = 5 * SS; o.shadowOffsetY = 10 * SS;
    o.drawImage(leaf, 0, 0);
    return { c: out, ox: ox, oy: oy, cw: cw, ch: ch, L: L, H: H };
  }
  var sprites = null;
  function buildSprites() {
    if (sprites) return;
    sprites = {};
    Object.keys(SIZES).forEach(function (type, ti) {
      sprites[type] = [];
      for (var v = 0; v < 3; v++) sprites[type].push(makeSprite(type, 1000 + ti * 37 + v * 11, .25 + v * .3));
    });
  }

  /* ===================================================== DOM */
  var overlay, canvas, ctx, shadeCv, sctx, card;
  var W = 0, Hh = 0, DPR = 1, leaves = [];
  var LEAF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5C11 3.6 4.4 8.2 3.6 16.2c-.1 1 .3 1.9 1 2.6l-1.9 1.9 1.1 1.1 2-2c.6.4 1.4.6 2.2.5 8-.9 12.4-7.5 12.5-16.8Z"/></svg>';

  function buildDom() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'pa-tut-overlay'; overlay.hidden = true;
    overlay.innerHTML =
      '<canvas aria-hidden="true"></canvas>' +
      '<div class="pa-tut-card" role="dialog" aria-live="polite" aria-label="Tutorial step">' +
        '<div class="pa-tut-meta"><div class="pa-tut-dots"></div><div class="pa-tut-count"></div></div>' +
        '<h4></h4><p></p>' +
        '<div class="pa-tut-actions">' +
          '<button type="button" class="pa-tut-skip">Skip tour</button>' +
          '<button type="button" class="pa-tut-back">Back</button>' +
          '<button type="button" class="pa-tut-next">Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    canvas = overlay.querySelector('canvas'); ctx = canvas.getContext('2d');
    shadeCv = document.createElement('canvas'); sctx = shadeCv.getContext('2d');
    card = overlay.querySelector('.pa-tut-card');
    card.querySelector('.pa-tut-next').addEventListener('click', next);
    card.querySelector('.pa-tut-back').addEventListener('click', back);
    card.querySelector('.pa-tut-skip').addEventListener('click', stop);
  }

  /* ===================================================== layout */
  function typeFor(r) { var x = r(); return x < .32 ? 'monstera' : x < .56 ? 'banana' : x < .78 ? 'alocasia' : 'palm'; }
  function layoutLeaves() {
    var r = rng(42), sp = 104 / Math.sqrt(LOOK.density);
    leaves = [];
    for (var y = -sp * .3; y < Hh + sp * .6; y += sp * .82) {
      for (var x = -sp * .3; x < W + sp * .6; x += sp) {
        var type = typeFor(r), v = Math.floor(r() * 3), s = .72 + r() * .5, spr = sprites[type][v], a = r() * Math.PI * 2;
        var cx = x + (r() - .5) * sp * .8, cy = y + (r() - .5) * sp * .7;
        var sx = cx - Math.cos(a) * spr.L * s * .45, sy = cy - Math.sin(a) * spr.L * s * .45;
        leaves.push({ type: type, v: v, s: s, rest: { x: sx, y: sy, a: a }, cur: { x: sx, y: sy, a: a }, ph: r() * Math.PI * 2, depth: r() });
      }
    }
    leaves.sort(function (a, b) { return (b.s + b.depth * .3) - (a.s + a.depth * .3); }); // big ones at the back
  }
  function sizeCanvas() {
    var r = overlay.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    var changed = Math.abs(r.width - W) > 1 || Math.abs(r.height - Hh) > 1;
    W = r.width; Hh = r.height;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(Hh * DPR);
    shadeCv.width = canvas.width; shadeCv.height = canvas.height;
    return changed;
  }

  /* ===================================================== clearance maths */
  function sdf(px, py, R) {
    var dx = Math.max(R.x - px, 0, px - (R.x + R.w)), dy = Math.max(R.y - py, 0, py - (R.y + R.h));
    if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
    return -Math.min(px - R.x, R.x + R.w - px, py - R.y, R.y + R.h - py);
  }
  function nearestOnRect(px, py, R) { return [clamp(px, R.x, R.x + R.w), clamp(py, R.y, R.y + R.h)]; }
  function overlaps(pose, L, H, R, gap) {
    for (var i = -3; i <= 8; i++) {   // i < 0 walks back down the stem behind the blade
      var t = i / 8, px = pose.x + Math.cos(pose.a) * L * t, py = pose.y + Math.sin(pose.a) * L * t;
      var hw = t < 0 ? 6 : H * Math.sin(Math.PI * Math.min(1, t * 1.05 + .05)) * .95 + 4;
      if (sdf(px, py, R) < hw + gap) return true;
    }
    return false;
  }
  // Where every leaf should sit so nothing covers R: stems slide out toward
  // the nearest side and the blades swing away from the clearing.
  function computeTargets(R) {
    var cx = R.x + R.w / 2, cy = R.y + R.h / 2, gap = 30, jr = rng(7);
    return leaves.map(function (l) {
      var sp = sprites[l.type][l.v], L = sp.L * l.s, H = sp.H * l.s, pose = copy(l.rest);
      var jit = (jr() - .5) * .7;
      if (!overlaps(pose, L, H, R, gap)) return pose;
      var d0 = sdf(pose.x, pose.y, R);
      if (d0 < H * .7 + gap) {
        var dx, dy;
        if (d0 < 0) {
          var dl = pose.x - R.x, dr = R.x + R.w - pose.x, dt = pose.y - R.y, db = R.y + R.h - pose.y, m = Math.min(dl, dr, dt, db);
          dx = m === dl ? -1 : m === dr ? 1 : 0; dy = m === dt ? -1 : m === db ? 1 : 0;
          dx += (pose.x - cx) / (R.w + 1) * .6; dy += (pose.y - cy) / (R.h + 1) * .6;
        } else { var n = nearestOnRect(pose.x, pose.y, R); dx = pose.x - n[0]; dy = pose.y - n[1]; }
        var len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
        for (var k = 0; k < 80 && sdf(pose.x, pose.y, R) < H * .7 + gap; k++) { pose.x += dx * 6; pose.y += dy * 6; }
      }
      var nn = nearestOnRect(pose.x, pose.y, R);
      pose.a = Math.atan2(pose.y - nn[1], pose.x - nn[0]) + jit;
      var ux = Math.cos(pose.a), uy = Math.sin(pose.a);
      for (var j = 0; j < 60 && overlaps(pose, L, H, R, gap); j++) { pose.x += ux * 5; pose.y += uy * 5; }
      return pose;
    });
  }

  /* ===================================================== tour state */
  var tour = { active: false, busy: false, i: 0, steps: [], rect: null, hole: null, phases: [], pi: 0, done: null, leafAlpha: 1 };
  var raf = 0;

  function rectFor(step) {
    var els = stepEls(step); if (!els.length) return null;
    var o = overlay.getBoundingClientRect(), u = null;
    els.forEach(function (el) {
      var r = el.getBoundingClientRect(), x = r.left - o.left, y = r.top - o.top;
      if (!u) u = { x: x, y: y, x2: x + r.width, y2: y + r.height };
      else { u.x = Math.min(u.x, x); u.y = Math.min(u.y, y); u.x2 = Math.max(u.x2, x + r.width); u.y2 = Math.max(u.y2, y + r.height); }
    });
    var pad = 10;
    return { x: u.x - pad, y: u.y - pad, w: (u.x2 - u.x) + pad * 2, h: (u.y2 - u.y) + pad * 2 };
  }
  function centerHole(R) { return { x: R.x + R.w / 2, y: R.y + R.h / 2, w: 0, h: 0, o: 0 }; }
  function fullHole() { return { x: -40, y: -40, w: W + 80, h: Hh + 80, o: 1 }; }
  function rectHole(R) { return { x: R.x, y: R.y, w: R.w, h: R.h, o: 1 }; }
  function copyHole(h) { return { x: h.x, y: h.y, w: h.w, h: h.h, o: h.o }; }
  function lerpHole(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t), o: lerp(a.o, b.o, t) }; }
  function spd() { return reduceMotion ? 40 : LOOK.speed; }
  function scale(ps) { ps.forEach(function (p) { p.dur /= spd(); p.delay = p.delay.map(function (d) { return d / spd(); }); }); return ps; }
  function run(ps, done) { tour.phases = ps; tour.pi = 0; tour.done = done; tour.busy = true; loop(); }

  function scrollTo(step) {
    var els = stepEls(step);
    if (els[0] && els[0].scrollIntoView) els[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function goTo(i) {
    if (tour.busy || !tour.steps.length) return;
    i = clamp(i, 0, tour.steps.length - 1);
    var step = tour.steps[i];
    scrollTo(step);
    var R = rectFor(step); if (!R) return;
    tour.i = i; tour.rect = R;
    var nt = computeTargets(R);
    hideCard();
    // Glide: the clearing slides to the next spot and the leaves step aside
    run(scale([{ dur: 760, toLazy: function () { return nt; }, delay: leaves.map(function (l, k) { return (k % 9) * 9; }), ease: ease.inOut, hf: copyHole(tour.hole), ht: rectHole(R), he: ease.inOut }]), showCard);
  }

  function start() {
    buildDom();
    if (tour.active) return;
    if (typeof window.closeSettings === 'function') { try { window.closeSettings(); } catch (e) {} }
    tour.steps = STEPS.filter(function (s) { return stepEls(s).length > 0; });
    if (!tour.steps.length) return;
    buildSprites();
    overlay.hidden = false;
    sizeCanvas(); layoutLeaves();
    tour.active = true; tour.i = 0; tour.leafAlpha = 0;
    scrollTo(tour.steps[0]);
    var R = rectFor(tour.steps[0]); tour.rect = R;
    var cx = W / 2, cy = Hh / 2;
    leaves.forEach(function (l) {   // leaves start outside the window and rush in
      var dx = l.rest.x - cx, dy = l.rest.y - cy, d = Math.hypot(dx, dy) || 1;
      l.cur = { x: l.rest.x + dx / d * (W * .6), y: l.rest.y + dy / d * (Hh * .6), a: l.rest.a - .8 };
    });
    tour.hole = centerHole(R);
    var nt = computeTargets(R), rr = rng(99), maxD = Math.hypot(W, Hh);
    run(scale([
      { dur: 700, toLazy: function () { return leaves.map(function (l) { return copy(l.rest); }); }, delay: leaves.map(function () { return rr() * 260; }), ease: ease.out, hf: centerHole(R), ht: centerHole(R), he: ease.out, fadeIn: true },
      { dur: 640, toLazy: function () { return nt; }, delay: leaves.map(function (l) { return Math.hypot(l.rest.x - (R.x + R.w / 2), l.rest.y - (R.y + R.h / 2)) / maxD * 380; }), ease: ease.back, hf: centerHole(R), ht: rectHole(R), he: ease.out }
    ]), showCard);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
  }

  function stop() {
    if (!tour.active) return;
    markSeen();
    hideCard();
    tour.busy = false;
    var cx = W / 2, cy = Hh / 2;
    run(scale([{ dur: 620,
      toLazy: function () { return leaves.map(function (l) { var dx = l.cur.x - cx, dy = l.cur.y - cy, d = Math.hypot(dx, dy) || 1; return { x: l.cur.x + dx / d * W * .7, y: l.cur.y + dy / d * Hh * .7, a: l.cur.a + .9 }; }); },
      delay: leaves.map(function (l) { return (1 - Math.hypot(l.cur.x - cx, l.cur.y - cy) / Math.hypot(W, Hh)) * 200; }),
      ease: ease.in, hf: copyHole(tour.hole), ht: fullHole(), he: ease.inOut, fadeOut: true }]),
      function () {
        tour.active = false; overlay.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', onScroll, true);
        var b = $('#tutorialBtn'); if (b) b.focus({ preventScroll: true });
      });
  }

  function next() { if (tour.busy) return; if (tour.i >= tour.steps.length - 1) stop(); else goTo(tour.i + 1); }
  function back() { if (tour.busy) return; goTo(tour.i - 1); }
  function onKey(e) {
    if (!tour.active) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
  }
  // Window resized or page scrolled while resting on a step: re-fit without animating.
  function refit() {
    if (!tour.active || tour.busy) return;
    var changed = sizeCanvas();
    if (changed) layoutLeaves();
    var R = rectFor(tour.steps[tour.i]); if (!R) return;
    tour.rect = R; tour.hole = rectHole(R);
    var t = computeTargets(R);
    leaves.forEach(function (l, i) { l.cur = copy(t[i]); });
    placeCard();
  }
  var refitTimer = 0;
  function onResize() { clearTimeout(refitTimer); refitTimer = setTimeout(refit, 120); }
  function onScroll() { clearTimeout(refitTimer); refitTimer = setTimeout(refit, 60); }

  /* ===================================================== step card */
  function showCard() {
    var s = tour.steps[tour.i], n = tour.steps.length;
    card.querySelector('h4').textContent = val(s.title);
    card.querySelector('p').textContent = val(s.body);
    card.querySelector('.pa-tut-count').textContent = (tour.i + 1) + ' / ' + n;
    var dots = '';
    for (var k = 0; k < n; k++) dots += LEAF_SVG.replace('<svg', '<svg class="' + (k < tour.i ? 'done' : k === tour.i ? 'now' : '') + '"');
    card.querySelector('.pa-tut-dots').innerHTML = dots;
    card.querySelector('.pa-tut-back').hidden = tour.i === 0;
    card.querySelector('.pa-tut-next').textContent = tour.i === n - 1 ? 'Finish' : 'Next';
    placeCard();
    card.classList.add('show');
    try { card.querySelector('.pa-tut-next').focus({ preventScroll: true }); } catch (e) {}
  }
  function hideCard() { if (card) card.classList.remove('show'); }
  function placeCard() {
    var R = tour.rect; if (!R) return;
    var tw = card.offsetWidth || 300, th = card.offsetHeight || 170, m = 14, x, y;
    if (R.y + R.h + m + th < Hh - 8) { y = R.y + R.h + m; x = R.x; }
    else if (R.y - m - th > 8) { y = R.y - m - th; x = R.x; }
    else if (R.x + R.w + m + tw < W - 8) { x = R.x + R.w + m; y = R.y; }
    else if (R.x - m - tw > 8) { x = R.x - m - tw; y = R.y; }
    else { x = (W - tw) / 2; y = Hh - th - 12; }
    card.style.left = clamp(x, 12, W - tw - 12) + 'px';
    card.style.top = clamp(y, 12, Hh - th - 12) + 'px';
  }

  /* ===================================================== render loop */
  function loop() { if (!raf) raf = requestAnimationFrame(tick); }
  function tick(now) {
    raf = 0;
    if (!tour.active) return;
    var p = tour.phases[tour.pi];
    if (p) {
      if (!p.started) {
        p.started = true; p.t0 = now;
        p.from = leaves.map(function (l) { return copy(l.cur); });
        p.to = p.toLazy();
      }
      var el = now - p.t0, total = p.dur + Math.max.apply(null, p.delay), gp = clamp(el / total, 0, 1);
      for (var i = 0; i < leaves.length; i++) {
        var t = clamp((el - p.delay[i]) / p.dur, 0, 1), e = p.ease(t), f = p.from[i], to = p.to[i];
        leaves[i].cur = { x: lerp(f.x, to.x, e), y: lerp(f.y, to.y, e), a: lerpAng(f.a, to.a, clamp(e, 0, 1.2)) };
      }
      tour.hole = lerpHole(p.hf, p.ht, p.he(gp));
      if (p.fadeIn) tour.leafAlpha = ease.out(gp);
      if (p.fadeOut) tour.leafAlpha = 1 - ease.in(gp);
      if (el >= total) {
        tour.pi++;
        if (tour.pi >= tour.phases.length) {
          tour.busy = false; tour.phases = [];
          var d = tour.done; tour.done = null; if (d) d();
        }
      }
    }
    if (!tour.active) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    draw(now);
    loop();
  }
  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function draw(now) {
    var g = ctx, h = tour.hole;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
    // Shade with a feathered clearing
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, shadeCv.width, shadeCv.height);
    sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.fillStyle = 'rgba(2,9,5,' + (LOOK.shade * tour.leafAlpha) + ')'; sctx.fillRect(0, 0, W, Hh);
    if (h.w > 1 && h.h > 1) {
      sctx.globalCompositeOperation = 'destination-out';
      sctx.shadowColor = '#000'; sctx.shadowBlur = 26 * DPR;
      roundRect(sctx, h.x, h.y, h.w, h.h, 14); sctx.fillStyle = '#000'; sctx.fill();
      sctx.shadowBlur = 0; sctx.globalCompositeOperation = 'source-over';
    }
    g.drawImage(shadeCv, 0, 0);
    // Leaves
    var sway = LOOK.sway && !reduceMotion, tt = now / 1000;
    g.globalAlpha = LOOK.leafAlpha * tour.leafAlpha;
    for (var i = 0; i < leaves.length; i++) {
      var l = leaves[i], sp = sprites[l.type][l.v], a = l.cur.a;
      if (sway) a += Math.sin(tt * (.7 + l.depth * .6) + l.ph) * .035 * (1.2 - l.s * .4);
      var c = Math.cos(a) * l.s, s = Math.sin(a) * l.s;
      g.setTransform(c * DPR, s * DPR, -s * DPR, c * DPR, l.cur.x * DPR, l.cur.y * DPR);
      g.drawImage(sp.c, -sp.ox, -sp.oy, sp.cw, sp.ch);
    }
    g.globalAlpha = 1; g.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Soft lime rim on the clearing
    if (h.o > .05 && h.w > 4) {
      var pulse = reduceMotion ? .6 : .5 + .25 * Math.sin(tt * 2.4);
      g.save(); g.shadowColor = 'rgba(198,243,107,' + (.6 * h.o) + ')'; g.shadowBlur = 16;
      g.strokeStyle = 'rgba(198,243,107,' + (pulse * h.o) + ')'; g.lineWidth = 2;
      roundRect(g, h.x - 2, h.y - 2, h.w + 4, h.h + 4, 15); g.stroke(); g.restore();
    }
  }

  /* ===================================================== button, prefs, first run */
  var buttonEnabled = true;
  function applyButton(seen) {
    var b = $('#tutorialBtn');
    if (b) { b.style.display = buttonEnabled ? '' : 'none'; if (seen) b.classList.add('seen'); }
    var sw = $('#tutorialBtnToggle'); if (sw) sw.checked = buttonEnabled;
  }
  function markSeen() { setPref('tutorialSeen', true); var b = $('#tutorialBtn'); if (b) b.classList.add('seen'); }
  function setButtonEnabled(on) {
    buttonEnabled = !!on;
    setPref('tutorialButtonEnabled', buttonEnabled);
    applyButton(false);
  }

  // Another dialog (privacy re-consent, Begin Recording, Settings) may be up
  // right after login. Wait for it to close rather than stacking on top.
  function modalOpen() {
    var list = document.querySelectorAll('.modal');
    for (var i = 0; i < list.length; i++) if (getComputedStyle(list[i]).display !== 'none' && visible(list[i])) return true;
    return false;
  }
  function startWhenClear(triesLeft) {
    if (tour.active) return;
    if (modalOpen() && triesLeft > 0) { setTimeout(function () { startWhenClear(triesLeft - 1); }, 1500); return; }
    if (!modalOpen()) start();
  }

  function onLogin() {
    Promise.all([getPref('tutorialButtonEnabled'), getPref('tutorialSeen')]).then(function (v) {
      buttonEnabled = v[0] !== false;
      var seen = v[1] === true;
      applyButton(seen);
      if (buttonEnabled && !seen) setTimeout(function () { startWhenClear(20); }, 900);
    }).catch(function () { applyButton(false); });
  }

  window.paTutorial = { onLogin: onLogin, start: start, stop: stop, setButtonEnabled: setButtonEnabled };
})();
