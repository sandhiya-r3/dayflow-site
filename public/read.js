(function () {
  'use strict';
  var MOODS = {
    1: { face: '😞', name: 'Rough', c: 'var(--m1)' },
    2: { face: '😕', name: 'Low',   c: 'var(--m2)' },
    3: { face: '😐', name: 'Okay',  c: 'var(--m3)' },
    4: { face: '🙂', name: 'Good',  c: 'var(--m4)' },
    5: { face: '😄', name: 'Great', c: 'var(--m5)' }
  };
  var page = document.getElementById('page');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseKey(k) { var p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  fetch('/api/public', { credentials: 'same-origin' })
    .then(function (res) { if (!res.ok) throw new Error('bad'); return res.json(); })
    .then(function (data) {
      var h = '<div class="topbar"><span class="brand">DayFlow</span><a class="text-btn" href="/">Log in</a></div>';
      h += '<h1>' + (data.author ? esc(data.author) + '’s journal' : 'Journal') + '</h1>';
      h += '<p class="lede">Entries shared publicly. Anyone with this link can read them.</p>';
      if (!data.items.length) {
        h += '<div class="empty"><strong>Nothing here yet</strong>Entries appear after they are shared.</div>';
      }
      data.items.forEach(function (it) {
        var m = MOODS[it.mood] || MOODS[3];
        var label = parseKey(it.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        h += '<article class="entry" style="--mc:' + m.c + '"><div class="entry-head"><span class="entry-date">' + esc(label) +
          '</span><span class="entry-mood">' + m.face + ' ' + m.name + '</span></div>';
        if (it.tags && it.tags.length) h += '<p class="entry-tags">' + esc(it.tags.join(' · ')) + '</p>';
        if (it.note) h += '<p class="entry-note">' + esc(it.note) + '</p>';
        h += '</article>';
      });
      page.innerHTML = h;
    })
    .catch(function () {
      page.innerHTML = '<div class="empty"><strong>Could not load the journal</strong>Refresh the page to try again.</div>';
    });
})();
