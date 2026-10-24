// Redeem form (pricing + account). Any <form data-redeem> with a "code"
// input and a .msg line.
//   - The Redeem button stays disabled until you're signed in.
//   - Redeeming takes two steps so nobody uses a code by accident:
//     /auth/redeem/check looks the code up WITHOUT using it, we ask
//     "Are you sure you want to use <plan> for <username>?", and only
//     "Yes, redeem it" posts to /auth/redeem.
(function () {
  'use strict';

  // "Squad (30 days)", "Founder (lifetime)", "a Peakabu Mobile event pass (6 hours)"
  function planText(d) {
    if (d.kind === 'event') return 'a ' + d.label + (d.hours ? ' (' + d.hours + ' hours)' : '');
    if (d.kind === 'subscription') return 'the ' + d.label;
    return d.label + ' (' + (d.durationDays ? d.durationDays + ' days' : 'lifetime') + ')';
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form[data-redeem]').forEach(function (form) {
      var msg = form.querySelector('.msg');
      var input = form.querySelector('[name="code"]');
      var btn = form.querySelector('[type="submit"]');
      var signin = form.querySelector('[data-redeem-signin]');
      var busy = false;
      var pending = null; // the code waiting for "Yes, redeem it"

      // confirm box, built once and kept hidden until a code checks out
      var box = document.createElement('div');
      box.className = 'card hi';
      box.hidden = true;
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Confirm code');
      var q = document.createElement('p');
      q.style.color = 'var(--white)';
      var row = document.createElement('div');
      row.className = 'row';
      var yes = document.createElement('button');
      yes.type = 'button'; yes.className = 'btn btn-lime btn-sm'; yes.textContent = 'Yes, redeem it';
      var no = document.createElement('button');
      no.type = 'button'; no.className = 'btn btn-ghost btn-sm'; no.textContent = 'Cancel';
      row.append(yes, no); box.append(q, row);
      form.insertBefore(box, msg);

      function say(text, ok) { msg.textContent = text; msg.className = 'msg ' + (ok ? 'ok' : 'err'); }
      function signedIn() { return !!window.paAuth.get(); }
      function closeConfirm() { pending = null; box.hidden = true; }
      function refresh() {
        var ok = signedIn();
        if (!ok) closeConfirm();
        btn.disabled = !ok || busy || pending !== null;
        btn.title = ok ? '' : 'Sign in to redeem a code';
        yes.disabled = no.disabled = busy;
        if (signin) signin.hidden = ok;
      }
      refresh();
      window.addEventListener('pa-auth', refresh);
      window.addEventListener('storage', refresh); // signed in/out in another tab
      input.addEventListener('input', function () { if (pending !== null) { closeConfirm(); say('', true); refresh(); } });

      // Step 1: look the code up (doesn't use it)
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = input.value.trim();
        if (!code || busy || pending !== null) return;
        if (!signedIn()) { refresh(); say('Sign in first, then redeem your code.', false); return; }
        busy = true; refresh(); say('', true);
        window.paAuth.api('/auth/redeem/check', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function (r) {
          busy = false;
          if (r.status === 401) { refresh(); say('Your sign-in ran out. Sign in again, then redeem.', false); return; }
          if (!r.ok) { refresh(); say(r.data.error || 'That code did not work.', false); return; }
          pending = code;
          var who = document.createElement('strong');
          who.textContent = r.data.username || (window.paAuth.get() || {}).username || 'this account';
          var plan = document.createElement('strong');
          plan.textContent = planText(r.data);
          q.replaceChildren('Are you sure you want to use ', plan, ' for ', who, '?');
          // What it will do, e.g. "Added 30 days" or "Saved for later..."
          if (r.data.outcome) { var o = document.createElement('span'); o.className = 'small'; o.style.display = 'block'; o.style.marginTop = '6px'; o.textContent = r.data.outcome; q.append(o); }
          box.hidden = false;
          refresh();
          yes.focus();
        }).catch(function () { busy = false; refresh(); say('Could not reach Peakabu. Try again in a moment.', false); });
      });

      // Step 2: actually redeem
      yes.addEventListener('click', function () {
        if (pending === null || busy) return;
        var code = pending;
        busy = true; refresh();
        window.paAuth.api('/auth/redeem', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function (r) {
          busy = false; closeConfirm();
          if (r.status === 401) { refresh(); say('Your sign-in ran out. Sign in again, then redeem.', false); return; }
          refresh();
          if (!r.ok) { say(r.data.error || 'That code did not work.', false); return; }
          input.value = '';
          say(r.data.message || 'Code redeemed. Your plan is updated.', true);
          form.dispatchEvent(new CustomEvent('redeemed', { detail: r.data }));
        }).catch(function () { busy = false; refresh(); say('Could not reach Peakabu. Try again in a moment.', false); });
      });

      no.addEventListener('click', function () {
        closeConfirm(); say('', true); refresh(); input.focus();
      });
    });
  });
})();
