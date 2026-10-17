// /s/:token — a scanned Swing card ("spot" in code) whose party hasn't started yet.
// Polls quietly; once the host starts the party, reloading /s/:token
// lets the server send the guest straight in.
(function () {
  'use strict';
  var token = (location.pathname.split('/')[2] || '').replace(/[^A-Za-z0-9_-]/g, '');
  var $ = function (id) { return document.getElementById(id); };
  var tries = 0, MAX_TRIES = 120; // ~1 hour at 30s

  function show(d) {
    $('spotBy').hidden = false;
    $('spotSet').textContent = d.setName;
    $('spotName').textContent = d.spotName;
    $('spotDot').style.background = d.color;
  }
  function check() {
    fetch('/api/spots/card/' + encodeURIComponent(token), { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (r) {
        if (!r.ok) {
          $('spotName').textContent = r.status === 429 ? 'Too many checks' : 'This card isn’t active';
          $('spotLine').textContent = r.status === 429 ? 'Wait a minute, then refresh this page.' : (r.d.error || 'Ask the host for a new card.');
          $('spotWait').hidden = true; $('spotHint').textContent = ''; $('spotMore').hidden = false;
          return;
        }
        show(r.d);
        if (r.d.live) { $('spotLine').textContent = 'The party is on. Taking you in…'; location.replace('/s/' + token); return; }
        $('spotLine').textContent = 'The party hasn’t started yet. Keep this page open and you’ll join this area as soon as the host starts.';
        $('spotWait').hidden = false;
        $('spotHint').textContent = 'Nothing to install. You film from this browser.';
        $('spotMore').hidden = false;
        if (++tries < MAX_TRIES) setTimeout(tick, 30000);
        else { $('spotWait').hidden = true; $('spotHint').textContent = 'Still waiting. Refresh this page when the party starts.'; }
      })
      .catch(function () { $('spotLine').textContent = 'Can’t reach Peakabu. Check your signal, then refresh.'; });
  }
  function tick() { if (document.hidden) document.addEventListener('visibilitychange', function v() { if (!document.hidden) { document.removeEventListener('visibilitychange', v); check(); } }); else check(); }
  document.addEventListener('DOMContentLoaded', function () {
    if (!token) { $('spotName').textContent = 'This card isn’t active'; $('spotLine').textContent = 'Ask the host for a new card.'; return; }
    check();
  });
})();
