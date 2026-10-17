// Homepage: the "Take the party home" demo (videos + pictures picker).
(function () {
  'use strict';
  var groups = [
    { id: 'g1', time: '9:42 PM', dur: '0:24', names: ['Host', 'Guest 1', 'Guest 2', 'Guest 3'] },
    { id: 'g2', time: '10:15 PM', dur: '0:30', names: ['Host', 'Guest 4', 'Guest 1'] },
    { id: 'g3', time: '11:02 PM', dur: '0:12', names: ['Guest 2', 'Guest 5'] }
  ];
  var solos = [
    { id: 's1', label: 'Guest 3 · video', dur: '0:30' },
    { id: 's2', label: 'Guest 1 · video', dur: '0:18' },
    { id: 's3', label: 'Host · video', dur: '0:09' }
  ];
  var vids = { 'g1-0': true, 'g1-1': true, 'g1-2': true, 'g1-3': true, s2: true };
  var pics = { p2: true, p5: true, p6: true };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function row(id, label, dur, child) {
    var b = el('button', 'pick' + (child ? ' child' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', vids[id] ? 'true' : 'false');
    b.append(el('span', 'tick', vids[id] ? '✓' : ''), el('span', 'thumb pov'), el('span', null, label));
    var d = el('span', 'mono small', dur); d.style.marginLeft = 'auto'; b.append(d);
    b.addEventListener('click', function () { vids[id] = !vids[id]; render(); });
    return b;
  }
  function count(o) { return Object.keys(o).filter(function (k) { return o[k]; }).length; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function render() {
    var list = document.getElementById('vidList');
    var grid = document.getElementById('picGrid');
    if (!list || !grid) return;
    list.replaceChildren();
    groups.forEach(function (g) {
      var ids = g.names.map(function (_, i) { return g.id + '-' + i; });
      var all = ids.every(function (i) { return vids[i]; });
      var some = ids.some(function (i) { return vids[i]; });
      var card = el('div', 'sync-card'), inner = el('div', 'sync-inner');
      var head = el('button', 'pick head');
      head.type = 'button';
      head.setAttribute('aria-pressed', all ? 'true' : some ? 'mixed' : 'false');
      head.append(el('span', 'tick', all ? '✓' : some ? '–' : ''), el('span', 'sync-chip', 'SYNCED · ' + g.names.length + ' POVS'));
      var t = el('span', null, g.time + ' · plays on one screen'); t.style.fontSize = '13px';
      var d = el('span', 'mono small', g.dur); d.style.marginLeft = 'auto';
      head.append(t, d);
      head.addEventListener('click', function () { ids.forEach(function (i) { vids[i] = !all; }); render(); });
      inner.append(head);
      g.names.forEach(function (n, i) { inner.append(row(ids[i], n + ' · POV ' + (i + 1), g.dur, true)); });
      card.append(inner); list.append(card);
    });
    var lab = el('span', 'mono small', 'SINGLE VIDEOS'); lab.style.letterSpacing = '.12em';
    list.append(lab);
    solos.forEach(function (s) { list.append(row(s.id, s.label, s.dur, false)); });

    grid.replaceChildren();
    for (var i = 1; i <= 15; i++) (function (id, n) {
      var b = el('button', 'pic pov');
      b.type = 'button';
      b.setAttribute('aria-pressed', pics[id] ? 'true' : 'false');
      b.setAttribute('aria-label', 'Picture ' + n);
      b.append(el('span', 'tick', pics[id] ? '✓' : ''));
      b.addEventListener('click', function () { pics[id] = !pics[id]; render(); });
      grid.append(b);
    })('p' + i, i);

    var vc = count(vids), pc = count(pics);
    document.getElementById('vidSel').textContent = vc + ' selected';
    document.getElementById('picSel').textContent = pc + ' selected';
    document.getElementById('vidBtn').textContent = vc ? 'Download ' + plural(vc, 'video') : 'Select videos';
    document.getElementById('picBtn').textContent = pc ? 'Download ' + plural(pc, 'picture') : 'Select pictures';
  }
  document.addEventListener('DOMContentLoaded', render);
})();
