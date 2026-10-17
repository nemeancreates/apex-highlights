// Redeem form (pricing + account). Any <form data-redeem> with a "code"
// input and a .msg line. Posts to /auth/redeem with the saved sign-in.
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('form[data-redeem]').forEach(function (form) {
      var msg = form.querySelector('.msg');
      var input = form.querySelector('[name="code"]');
      var btn = form.querySelector('[type="submit"]');
      var signin = form.querySelector('[data-redeem-signin]');
      function say(text, ok) { msg.textContent = text; msg.className = 'msg ' + (ok ? 'ok' : 'err'); }
      if (!window.paAuth.get() && signin) signin.hidden = false;

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var code = input.value.trim();
        if (!code) return;
        if (!window.paAuth.get()) {
          say('Sign in first, then redeem your code.', false);
          if (signin) signin.hidden = false;
          return;
        }
        btn.disabled = true;
        window.paAuth.api('/auth/redeem', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function (r) {
          btn.disabled = false;
          if (r.status === 401) { say('Your sign-in ran out. Sign in again, then redeem.', false); if (signin) signin.hidden = false; return; }
          if (!r.ok) { say(r.data.error || 'That code did not work.', false); return; }
          input.value = '';
          say(r.data.message || 'Code redeemed. Your plan is updated.', true);
          form.dispatchEvent(new CustomEvent('redeemed', { detail: r.data }));
        }).catch(function () { btn.disabled = false; say('Could not reach Peakabu. Try again in a moment.', false); });
      });
    });
  });
})();
