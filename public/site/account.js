// /account — sign in, plan + usage, sessions, Swing cards, devices.
// NAMING: in code these are "spots"; on the site, cards and emails they're
// called "Swing cards" (one per area, printed "Swing by the <area>").
// Everything the server sends is put on the page with textContent; the
// only HTML inserted is the QR SVG our own server generates.
(function () {
  'use strict';
  var A = window.paAuth;
  var $ = function (id) { return document.getElementById(id); };
  var COLORS = ['#39d3a0', '#7fc8ff', '#ffd23f', '#ff8a5c', '#c6f36b', '#a98fe8', '#f0a5bd', '#e8c88f'];
  var MAX_SPOTS = 12;
  var sets = [];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(text, cls, onClick) {
    var b = el('button', 'btn btn-sm ' + (cls || 'btn-ghost'), text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function say(id, text, ok) { var m = $(id); if (!m) return; m.textContent = text || ''; m.className = 'msg' + (text ? (ok ? ' ok' : ' err') : ''); }
  function day(ms) { return ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  function when(ms) {
    if (!ms) return '';
    var d = Date.now() - ms;
    if (d < 120000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < 86400000) return Math.round(d / 3600000) + ' h ago';
    return day(ms);
  }
  function left(ms) {
    var d = ms - Date.now();
    if (d <= 0) return 'expired';
    if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + ' min';
    if (d < 86400000 * 2) return Math.round(d / 3600000) + ' h';
    return Math.round(d / 86400000) + ' days';
  }
  // Two-click confirm without browser dialogs.
  function confirmBtn(text, sure, onConfirm) {
    var b = btn(text, 'btn-danger'), armed = null;
    b.addEventListener('click', function () {
      if (armed) { clearTimeout(armed); armed = null; b.textContent = text; onConfirm(b); return; }
      b.textContent = sure;
      armed = setTimeout(function () { armed = null; b.textContent = text; }, 4000);
    });
    return b;
  }

  // ---------------- signed out ----------------
  function showSignedOut() {
    $('signedIn').hidden = true;
    $('signedOut').hidden = false;
    var tL = $('tabLogin'), tR = $('tabRegister');
    function pick(reg) {
      tL.setAttribute('aria-selected', reg ? 'false' : 'true'); tL.tabIndex = reg ? -1 : 0;
      tR.setAttribute('aria-selected', reg ? 'true' : 'false'); tR.tabIndex = reg ? 0 : -1;
      $('loginForm').hidden = reg; $('registerForm').hidden = !reg;
      $('authTitle').textContent = reg ? 'Make camp.' : 'Welcome back.';
    }
    tL.onclick = function () { pick(false); };
    tR.onclick = function () { pick(true); };
    [tL, tR].forEach(function (t) {
      t.onkeydown = function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault(); var reg = t === tL; pick(reg); (reg ? tR : tL).focus();
      };
    });
    if (location.hash === '#register') pick(true);
  }

  function authSubmit(form, url, extra) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = form.querySelector('.msg'), b = form.querySelector('[type="submit"]');
      // Sign-up asks for the password twice so a typo doesn't lock someone out.
      if (form.password2 && form.password2.value !== form.password.value) {
        msg.className = 'msg err'; msg.textContent = 'The two passwords don’t match. Type them again.';
        form.password2.value = ''; form.password2.focus();
        return;
      }
      var body = Object.assign({ username: form.username.value.trim(), password: form.password.value, platform: 'web' }, extra ? extra(form) : {});
      b.disabled = true; msg.textContent = '';
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          b.disabled = false;
          if (!r.ok || !r.d.token) { msg.className = 'msg err'; msg.textContent = r.d.error || 'That did not work. Try again.'; return; }
          A.set(r.d.token, r.d.username);
          form.reset();
          if (r.d.deletionCancelled) alert('Welcome back. Your account deletion was cancelled.');
          document.querySelectorAll('[data-signin]').forEach(function (x) { x.textContent = r.d.username; });
          start();
        })
        .catch(function () { b.disabled = false; msg.className = 'msg err'; msg.textContent = 'Could not reach Peakabu. Try again in a moment.'; });
    });
  }

  // ---------------- signed in ----------------
  function signedOutNow() {
    A.clear();
    document.querySelectorAll('[data-signin]').forEach(function (x) { x.textContent = 'Sign in'; });
    showSignedOut();
  }
  function api(url, opts) {
    return A.api(url, opts).then(function (r) {
      if (r.status === 401) { signedOutNow(); throw new Error('signed-out'); }
      return r;
    });
  }

  function loadOverview() {
    return api('/api/account').then(function (r) {
      if (!r.ok) { say('loadErr', r.data.error || 'Could not load your account.'); return; }
      var a = r.data, l = a.limits || {};
      $('who').textContent = a.username;
      $('planName').textContent = a.tierLabel;
      $('planLine').textContent = a.tier === 't1' ? 'Free plan. Clips are kept for 24 hours.'
        : (a.tierExpiresAt ? 'Active until ' + day(a.tierExpiresAt) + '.' : 'Lifetime plan.') + ' Clips kept ' + l.retentionDays + ' days.';
      var used = (a.usage && a.usage.sessionsThisMonth) || 0, cap = l.sessionsPerMonth || 0;
      $('sessUse').textContent = '';
      $('sessUse').append(String(used), el('small', null, ' / ' + cap + ' sessions'));
      $('sessBar').style.width = (cap ? Math.min(100, used / cap * 100) : 0).toFixed(1) + '%';
      $('limitsLine').textContent = 'Up to ' + l.memberCap + ' players per session. Resets on the 1st.';
      var m = a.mobile || {};
      if (m.source === 'plan') { $('mobName').textContent = 'Included'; $('mobLine').textContent = 'Comes with your ' + a.tierLabel + ' plan.'; }
      else if (m.source === 'pass') { $('mobName').textContent = 'Host pass'; $('mobLine').textContent = 'Active until ' + day(m.passExpiresAt) + '.'; }
      else { $('mobName').textContent = 'Free'; $('mobLine').textContent = 'Host up to ' + Math.round((m.freeDailySec || 600) / 60) + ' minutes a day.'; }
      if (m.events && m.events.length) $('mobLine').textContent += ' ' + m.events.length + ' event pass' + (m.events.length === 1 ? '' : 'es') + ' ready.';
      showSubscriptions(a);
      $('discName').textContent = a.discordLinked ? (a.discordUsername || 'Linked') : 'Not linked';
      $('linkDiscord').hidden = !!a.discordLinked;
    });
  }

  // Monthly subscriptions: what renews when, a Manage button (Stripe's
  // portal: cancel, change card, receipts), and any time saved for later.
  function showSubscriptions(a) {
    var subs = a.subscriptions || [], banked = a.banked || [];
    [['pc', 'planLine'], ['mobile', 'mobLine']].forEach(function (pair) {
      var kind = pair[0], line = $(pair[1]);
      var row = line.parentNode.querySelector('.row');
      var old = row.querySelector('[data-manage]'); if (old) old.remove();
      var sub = subs.filter(function (x) { return x.kind === kind; })[0];
      if (sub) {
        if (kind === 'mobile') $('mobName').textContent = 'Monthly';
        line.textContent = (sub.endsAt ? 'Subscription cancelled. Ends ' + day(sub.endsAt) + '.'
          : 'Monthly subscription' + (sub.cents ? ' ($' + (sub.cents / 100).toFixed(2) + ')' : '') + ', renews ' + day(sub.renewsAt) + '.') +
          (sub.status === 'past_due' ? ' Your last payment didn\u2019t go through; update your card to keep it.' : '') +
          (kind === 'pc' && a.limits ? ' Clips kept ' + a.limits.retentionDays + ' days.' : '');
        var b = btn('Manage subscription', 'btn-lime', function () {
          b.disabled = true;
          api('/api/billing/portal', { method: 'POST', body: JSON.stringify({ subscriptionId: sub.id }) }).then(function (x) {
            if (x.ok && x.data.url) { location.href = x.data.url; return; }
            b.disabled = false; say('loadErr', x.data.error || 'Could not open subscription settings.');
          }).catch(function () { b.disabled = false; });
        });
        b.setAttribute('data-manage', '');
        row.prepend(b);
      }
      var saved = banked.filter(function (x) { return x.kind === kind; });
      if (saved.length) {
        line.textContent += ' Saved for later: ' + saved.map(function (x) { return x.days + ' days of ' + x.label; }).join(', ') +
          ', starting when your subscription ends.';
      }
    });
  }

  // My sessions: desktop and Peakabu Mobile together, newest first until a
  // Clips or Expires header is clicked (click again to flip the order).
  var sessList = [], sessSort = { key: null, dir: 1 };
  function ms(v) { return typeof v === 'number' ? v : (Date.parse(v) || 0); }
  function sortSessions() {
    var k = sessSort.key, dir = sessSort.dir;
    return sessList.slice().sort(function (a, b) {
      if (k === 'clips') return dir * ((a.clipCount || 0) - (b.clipCount || 0)) || ms(b.createdAt) - ms(a.createdAt);
      if (k === 'expires') return dir * (ms(a.expiresAt) - ms(b.expiresAt)) || ms(b.createdAt) - ms(a.createdAt);
      return ms(b.createdAt) - ms(a.createdAt);
    });
  }
  function paintSortHeads() {
    document.querySelectorAll('#sessions [data-sort]').forEach(function (b) {
      var on = b.getAttribute('data-sort') === sessSort.key;
      b.closest('th').setAttribute('aria-sort', on ? (sessSort.dir > 0 ? 'ascending' : 'descending') : 'none');
      b.setAttribute('data-dir', on ? (sessSort.dir > 0 ? 'up' : 'down') : '');
    });
  }
  document.querySelectorAll('#sessions [data-sort]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-sort');
      // First click: most clips first / soonest to expire first.
      if (sessSort.key === k) sessSort.dir = -sessSort.dir;
      else { sessSort.key = k; sessSort.dir = k === 'clips' ? -1 : 1; }
      paintSortHeads();
      renderSessions();
    });
  });

  function loadSessions() {
    return api('/api/account/sessions').then(function (r) {
      sessList = (r.ok && r.data.sessions) || [];
      renderSessions();
    });
  }

  function mobileRow(s) {
    var tr = el('tr', 'sessrow');
    var th = el('th'); th.scope = 'row';
    var name = el('div', null, s.title || 'Mobile party');
    name.append(' ', el('span', 'tag-mob', 'Mobile'));
    var bits = [day(s.createdAt), s.peaks + ' peak' + (s.peaks === 1 ? '' : 's')];
    if (s.photos) bits.push(s.photos + ' photo' + (s.photos === 1 ? '' : 's'));
    if (!s.endedAt) bits.push('Live now');
    th.append(name, el('div', 'small mono', bits.join(' · ')));
    var tdClips = el('td', null, String(s.clipCount || 0)), tdExp = el('td', null, left(s.expiresAt));
    var tdPub = el('td', 'small', s.listed ? 'Listed (set on the Mobile host page)' : 'Private');
    var watch = el('a', 'btn btn-ghost btn-sm', 'Watch'); watch.href = s.watchUrl; watch.target = '_blank'; watch.rel = 'noopener';
    var copy = btn('Copy link', 'btn-ghost', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(s.watchUrl) : Promise.reject()).then(
        function () { say('sessMsg', 'Link copied.', true); },
        function () { say('sessMsg', s.watchUrl, true); });
    });
    var tdAct = el('td'); tdAct.append(watch, ' ', copy);
    tdClips.setAttribute('data-label', 'Clips'); tdExp.setAttribute('data-label', 'Expires'); tdPub.setAttribute('data-label', 'Public');
    tr.append(th, tdClips, tdExp, tdPub, tdAct);
    return tr;
  }

  function renderSessions() {
      var body = $('sessBody');
      body.replaceChildren();
      var list = sortSessions();
      if (!list.length) {
        var tr = el('tr'), td = el('td', 'small', 'No sessions yet. Host one from the desktop app or Peakabu Mobile and it shows up here.');
        td.colSpan = 5; tr.append(td); body.append(tr); return;
      }
      list.forEach(function (s) {
        if (s.kind === 'mobile') { body.append(mobileRow(s)); return; }
        var tr = el('tr', 'sessrow');
        var th = el('th'); th.scope = 'row';
        th.append(el('div', null, s.title || s.detectedGame || 'Session ' + s.code), el('div', 'small mono', day(s.createdAt) + ' · ' + s.code));
        var pub = s.public || {};
        var sw = el('button', 'switch'); sw.type = 'button'; sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', pub.isPublic ? 'true' : 'false');
        sw.setAttribute('aria-label', 'List ' + s.code + ' on Browse');
        sw.append(el('span'));
        var note = el('div', 'small');
        function paint(p) {
          sw.setAttribute('aria-checked', p.isPublic ? 'true' : 'false');
          sw.disabled = !!p.underReview || (!p.canList && !p.isPublic);
          note.textContent = p.underReview ? 'Under review' : p.state === 'checking' ? 'Checking clips…' : (!p.canList && p.reason) ? p.reason : '';
        }
        paint(pub);
        sw.addEventListener('click', function () {
          var want = sw.getAttribute('aria-checked') !== 'true';
          sw.disabled = true;
          api('/sessions/' + encodeURIComponent(s.code) + '/public', { method: 'PATCH', body: JSON.stringify({ isPublic: want }) }).then(function (x) {
            if (x.ok) { paint(x.data); say('sessMsg', want ? 'Listed. It shows on Browse once its clips clear the check.' : 'Taken off Browse.', true); }
            else { paint(pub); say('sessMsg', x.data.error || 'Could not change that.'); }
          }).catch(function () {});
        });
        var tdPub = el('td'); tdPub.append(sw, note);
        // watchUrl carries the key for members-only sessions.
        var link = s.watchUrl || (location.origin + '/player?code=' + encodeURIComponent(s.code));
        var watch = el('a', 'btn btn-ghost btn-sm', 'Watch'); watch.href = link;
        var copy = btn('Copy link', 'btn-ghost', function () {
          var url = link;
          (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
            function () { say('sessMsg', 'Link copied.', true); },
            function () { say('sessMsg', url, true); });
        });
        var tdAct = el('td'); tdAct.append(watch, ' ', copy);
        var tdClips = el('td', null, String(s.clipCount || 0)), tdExp = el('td', null, left(s.expiresAt));
        tdClips.setAttribute('data-label', 'Clips'); tdExp.setAttribute('data-label', 'Expires'); tdPub.setAttribute('data-label', 'Public');
        tr.append(th, tdClips, tdExp, tdPub, tdAct);
        body.append(tr);
      });
  }

  var PLATFORM = { pc: ['PC', 'Desktop app'], mobile: ['MOB', 'Phone · Peakabu Mobile'], web: ['WEB', 'Web browser'] };
  function loadDevices() {
    return api('/api/account/devices').then(function (r) {
      var box = $('devList');
      box.replaceChildren();
      var list = (r.ok && r.data.devices) || [];
      if (!list.length) { box.append(el('p', 'small', 'No other sign-ins.')); return; }
      list.forEach(function (d) {
        var p = PLATFORM[d.platform] || ['?', 'Older sign-in'];
        var row = el('div', 'dev'), info = el('div');
        info.style.flex = '1 1 220px';
        info.append(el('strong', null, p[1]), el('div', 'small', d.current ? 'This browser · active now' : 'Last seen ' + when(d.lastSeenAt || d.signedInAt)));
        row.append(el('span', 'ic', p[0]), info);
        if (!d.current) {
          row.append(btn('Sign out', 'btn-ghost', function (e) {
            e.target.disabled = true;
            api('/api/account/devices/' + encodeURIComponent(d.id) + '/signout', { method: 'POST' }).then(function (x) {
              if (x.ok) { say('devMsg', p[1] + ' signed out.', true); loadDevices(); }
              else { e.target.disabled = false; say('devMsg', x.data.error || 'Could not sign that out.'); }
            }).catch(function () {});
          }));
        }
        box.append(row);
      });
    });
  }

  // ---------------- Swing card sets ("spots" in code) ----------------
  function loadSets() {
    return api('/api/spots/sets').then(function (r) {
      if (!r.ok) { say('spotMsg', r.data.error || 'Could not load your card sets.'); return; }
      sets = r.data.sets || [];
      if (r.data.colors && r.data.colors.length) COLORS = r.data.colors;
      if (r.data.limits) MAX_SPOTS = r.data.limits.maxSpots || MAX_SPOTS;
      renderSets();
    });
  }

  function renderSets() {
    var box = $('sets');
    box.replaceChildren();
    if (!sets.length) { box.append(el('div', 'empty', 'No card sets yet. Make one for your next big event — a wedding, a tournament, a birthday.')); return; }
    sets.forEach(function (s) {
      var card = el('div', 'set');
      var top = el('div', 'row');
      top.style.justifyContent = 'space-between';
      var name = el('div');
      name.append(el('strong', null, s.name), el('span', 'small', ' · ' + s.spots.length + ' card' + (s.spots.length === 1 ? '' : 's')));
      if (s.live) { var lv = el('span', 'pill solid', 'LIVE'); lv.style.marginLeft = '10px'; name.append(lv); }
      top.append(name);
      var chips = el('div', 'chips');
      s.spots.forEach(function (sp) {
        var c = el('span', 'chip'), dot = el('i'); dot.style.background = sp.color;
        c.append(dot, document.createTextNode(sp.name)); chips.append(c);
      });
      var acts = el('div', 'row');
      acts.style.gap = '8px';
      acts.append(
        btn('Print cards', 'btn-lime', function (e) { printSet(s, e.target); }),
        btn('Edit', 'btn-ghost', function () { openEditor(s); }),
        confirmBtn('New codes', 'Old cards stop working. Sure?', function (b) {
          b.disabled = true;
          api('/api/spots/sets/' + encodeURIComponent(s.id) + '/reissue', { method: 'POST' }).then(function (x) {
            b.disabled = false;
            if (x.ok) { say('spotMsg', 'New codes made. Print the cards again; the old ones no longer work.', true); loadSets(); }
            else say('spotMsg', x.data.error || 'Could not do that.');
          }).catch(function () {});
        }),
        confirmBtn('Delete', 'Delete this set?', function (b) {
          b.disabled = true;
          api('/api/spots/sets/' + encodeURIComponent(s.id), { method: 'DELETE' }).then(function (x) {
            if (x.ok) { say('spotMsg', 'Card set deleted.', true); loadSets(); }
            else { b.disabled = false; say('spotMsg', x.data.error || 'Could not delete it.'); }
          }).catch(function () {});
        })
      );
      card.append(top, chips, acts);
      box.append(card);
    });
  }

  function openEditor(existing) {
    var slot = $('editorSlot');
    slot.replaceChildren();
    say('spotMsg', '');
    var rows = existing
      ? existing.spots.map(function (s) { return { id: s.id, name: s.name, color: s.color }; })
      : [{ name: 'Head table', color: COLORS[0] }, { name: 'Dance floor', color: COLORS[2] }];
    var ed = el('form', 'editor');
    ed.noValidate = true;
    var nf = el('div', 'field'), nl = el('label', null, 'Set name'), ni = el('input', 'input');
    nl.htmlFor = ni.id = 'setName'; ni.maxLength = 60; ni.value = existing ? existing.name : '';
    ni.placeholder = 'Sam & Riley’s wedding';
    nf.append(nl, ni);
    var list = el('div', 'stack');
    list.style.gap = '10px';
    var add = btn('Add an area', 'btn-ghost');
    var err = el('p', 'msg err'); err.setAttribute('role', 'alert');

    function draw() {
      list.replaceChildren();
      rows.forEach(function (r, i) {
        var row = el('div', 'spotrow');
        var inp = el('input', 'input'); inp.maxLength = 40; inp.value = r.name;
        inp.setAttribute('aria-label', 'Area ' + (i + 1) + ' name'); inp.placeholder = 'Area, e.g. Dance floor';
        inp.addEventListener('input', function () { r.name = inp.value; });
        var sw = el('div', 'swatches'); sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Area ' + (i + 1) + ' colour');
        COLORS.forEach(function (c) {
          var b = el('button'); b.type = 'button'; b.style.background = c;
          b.setAttribute('aria-label', c); b.setAttribute('aria-pressed', r.color === c ? 'true' : 'false');
          b.addEventListener('click', function () { r.color = c; draw(); });
          sw.append(b);
        });
        var rm = btn('Remove', 'btn-ghost', function () { rows.splice(i, 1); draw(); });
        rm.disabled = rows.length <= 1;
        row.append(inp, sw, rm);
        list.append(row);
      });
      add.disabled = rows.length >= MAX_SPOTS;
      add.textContent = rows.length >= MAX_SPOTS ? MAX_SPOTS + ' areas max' : 'Add an area';
    }
    add.addEventListener('click', function () {
      if (rows.length >= MAX_SPOTS) return;
      rows.push({ name: '', color: COLORS[rows.length % COLORS.length] });
      draw();
      var inputs = list.querySelectorAll('input'); inputs[inputs.length - 1].focus();
    });
    var save = el('button', 'btn btn-lime btn-sm', existing ? 'Save changes' : 'Make cards'); save.type = 'submit';
    var cancel = btn('Cancel', 'btn-ghost', function () { slot.replaceChildren(); });
    var bar = el('div', 'row'); bar.append(add, save, cancel);
    if (existing) bar.append(el('span', 'small', 'Areas you keep keep their QR codes.'));

    ed.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = ni.value.trim();
      var spots = rows.map(function (r) { return { id: r.id, name: r.name.trim(), color: r.color }; });
      if (!name) { err.textContent = 'Give the set a name.'; ni.focus(); return; }
      if (spots.some(function (s) { return !s.name; })) { err.textContent = 'Every spot needs a name.'; return; }
      save.disabled = true; err.textContent = '';
      var url = existing ? '/api/spots/sets/' + encodeURIComponent(existing.id) : '/api/spots/sets';
      api(url, { method: existing ? 'PATCH' : 'POST', body: JSON.stringify({ name: name, spots: spots }) }).then(function (x) {
        save.disabled = false;
        if (!x.ok) { err.textContent = x.data.error || 'Could not save that.'; return; }
        slot.replaceChildren();
        say('spotMsg', existing ? 'Saved.' : 'Cards made. Hit Print cards when you’re ready.', true);
        loadSets();
      }).catch(function () { save.disabled = false; });
    });
    ed.append(el('strong', null, existing ? 'Edit card set' : 'New card set'), nf, list, bar, err);
    slot.append(ed);
    draw();
    ni.focus();
  }

  // Ready-to-print sheet: two cards across, cut along the dashed lines.
  function printSet(set, b) {
    b.disabled = true;
    say('spotMsg', 'Getting your cards ready…', true);
    api('/api/spots/sets/' + encodeURIComponent(set.id) + '/cards').then(function (x) {
      b.disabled = false;
      if (!x.ok) { say('spotMsg', x.data.error || 'Could not make the QR codes.'); return; }
      var sheet = $('printSheet');
      sheet.replaceChildren();
      sheet.className = 'size-' + printSize;
      // Stickers and cards: a full sheet (12 / 4) for each area, so every area gets its own page.
      var copies = { sticker: 12, card: 4 }[printSize] || 1;
      x.data.cards.forEach(function (c) {
        for (var n = 0; n < copies; n++) addCard(c);
      });
      function addCard(c) {
        var card = el('div', 'pcard');
        var strip = el('div', 'strip'); strip.style.background = c.color;
        var qr = el('div', 'qr');
        qr.innerHTML = c.svg; // generated by our server's QR library
        var foot = el('div', 'foot'), img = el('img'); img.src = '/site/img/badge-see-no-evil.png'; img.alt = '';
        foot.append(img, document.createTextNode('Peakabu'));
        card.append(el('span', 'set-name', x.data.set.name), el('span', 'swing', 'Swing by'), el('h2', null, c.name), qr,
          el('p', null, 'Scan with your phone camera to film from here.'), strip, el('span', 'url', c.url), foot);
        sheet.append(card);
      }
      say('spotMsg', '');
      var imgs = sheet.querySelectorAll('img'), pending = imgs.length;
      function go() {
        document.body.classList.add('printing');
        window.print();
      }
      if (!pending) go();
      else imgs.forEach(function (i) { if (i.complete) { if (--pending === 0) go(); } else i.onload = i.onerror = function () { if (--pending === 0) go(); }; });
    }).catch(function () { b.disabled = false; });
  }
  window.addEventListener('afterprint', function () { document.body.classList.remove('printing'); });

  // Print size, remembered on this browser: stickers to dot around a venue,
  // table cards, half-page signs or a full-page poster for a bulletin board.
  var SIZES = ['sticker', 'card', 'half', 'full'];
  var printSize = 'card';
  try { var ps = localStorage.getItem('pa_print_size'); if (SIZES.indexOf(ps) >= 0) printSize = ps; } catch (e) {}
  function paintSizes() {
    document.querySelectorAll('#printSizes button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-size') === printSize ? 'true' : 'false'); });
  }

  // ---------------- start ----------------
  function start() {
    if (!A.get()) { showSignedOut(); return; }
    $('signedOut').hidden = true;
    $('signedIn').hidden = false;
    $('who').textContent = A.get().username;
    Promise.all([loadOverview(), loadSessions(), loadSets(), loadDevices()]).then(function () {
      if (location.hash) { var t = document.querySelector(location.hash.replace(/[^#\w-]/g, '')); if (t) t.scrollIntoView(); }
    }).catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    authSubmit($('loginForm'), '/auth/login');
    authSubmit($('registerForm'), '/auth/register', function (f) { return { acceptedTerms: f.terms.checked }; });
    // Show a mismatch as soon as the second box is left, not only on submit.
    function checkMatch() {
      var f = $('registerForm');
      f.password2.setCustomValidity(f.password2.value && f.password2.value !== f.password.value ? 'Passwords don’t match' : '');
    }
    $('rePass').addEventListener('input', checkMatch);
    $('rePass2').addEventListener('input', checkMatch);
    // Show password boxes (off by default): each one names the fields it reveals.
    document.querySelectorAll('[data-show-pass]').forEach(function (cb) {
      cb.checked = false;
      cb.addEventListener('change', function () {
        cb.getAttribute('data-show-pass').split(' ').forEach(function (id) { $(id).type = cb.checked ? 'text' : 'password'; });
      });
    });
    $('newSet').addEventListener('click', function () { openEditor(null); });
    paintSizes();
    document.querySelectorAll('#printSizes button').forEach(function (b) {
      b.addEventListener('click', function () {
        printSize = b.getAttribute('data-size');
        try { localStorage.setItem('pa_print_size', printSize); } catch (e) {}
        paintSizes();
      });
    });
    // Delete account: 7 days to change your mind (signing back in cancels it).
    $('deleteForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = $('deleteForm');
      var m = f.querySelector('.msg');
      if (!confirm('Delete your Peakabu account? You’ll be signed out everywhere, and it’s deleted for good in 7 days unless you sign back in.')) return;
      var b = f.querySelector('[type="submit"]');
      b.disabled = true; m.textContent = '';
      api('/auth/delete-account', { method: 'POST', body: JSON.stringify({ password: f.password.value }) }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { m.className = 'msg err'; m.textContent = r.data.error || 'That did not work. Try again.'; return; }
        f.reset();
        var when = new Date(r.data.deleteAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
        signedOutNow();
        var lm = $('loginForm').querySelector('.msg');
        lm.className = 'msg';
        lm.textContent = 'Your account will be deleted on ' + when + '. Sign in before then to keep it.';
      }).catch(function () { b.disabled = false; });
    });

    $('signOut').addEventListener('click', function () {
      api('/auth/logout', { method: 'POST' }).catch(function () {}).then(signedOutNow);
    });
    $('linkDiscord').addEventListener('click', function () {
      api('/auth/discord/link-url').then(function (r) {
        if (r.ok && r.data.url) location.href = r.data.url;
        else say('discMsg', r.data.error || 'Discord linking is not available right now.');
      }).catch(function () {});
    });
    var redeem = document.querySelector('#redeem form');
    if (redeem) redeem.addEventListener('redeemed', function () { loadOverview().catch(function () {}); });
    start();
  });
})();
